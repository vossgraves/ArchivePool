// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, desc, eq, isNull, or } from "drizzle-orm"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, githubClaims, users } from "@/lib/db/schema"
import { hashKey } from "@/lib/api-keys"
import { budgetedFetch } from "@/lib/cf-env"
import {
  OAUTH_COOKIE_MAX_AGE_SEC,
  packOauthCookie,
  packPendingCookie,
  readOauthCookie,
  readPendingCookie,
  type PendingIdentity,
} from "@/lib/github-cookies"
import { signWithSessionSecret } from "@/lib/hmac-cookie"

/**
 * GitHub OAuth sign-in — the web-auth path that fits a Workers free request
 * (a handful of crypto.subtle HMAC/SHA-256 ops + two outbound fetches).
 *
 * Flow:
 *   /api/auth/github/start     state + PKCE verifier in a signed HttpOnly cookie,
 *                              redirect to github.com/login/oauth/authorize
 *   /api/auth/github/callback  verify state, exchange code (PKCE), fetch /user,
 *                              sign in known github_ids, else hand out a short-lived
 *                              "pending" cookie that carries the verified identity
 *   /api/auth/github/complete  choose a NEW username -> create account
 *   /api/auth/github/claim     take an EXISTING username -> prove with one of its
 *                              active API keys (sha256 lookup) or a revoked key /
 *                              no key -> pending github_claims row for admin review
 *
 * Both cookies are purpose-tagged inside their signed body ("gh-oauth-v1" vs
 * "gh-pending-v1") and every numeric field passes a canonical regex — a cookie
 * minted for one step can never be re-presented as the other.
 */

export const GITHUB_OAUTH_COOKIE = "atp_gh_oauth"
export const GITHUB_PENDING_COOKIE = "atp_gh_pending"
export { OAUTH_COOKIE_MAX_AGE_SEC }
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
export const GITHUB_USER_URL = "https://api.github.com/user"

export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim())
}

function requireSecret(name: "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET"): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function randomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let bin = ""
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ---------- OAuth transaction cookie ----------

export async function issueOauthCookie(): Promise<{ cookieValue: string; state: string; verifier: string }> {
  const state = randomUrlSafe(16)
  const verifier = randomUrlSafe(32)
  return { cookieValue: await packOauthCookie(state, verifier), state, verifier }
}

export { readOauthCookie }

export function authorizeUrl(origin: string, state: string, challenge: string): string {
  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set("client_id", requireSecret("GITHUB_CLIENT_ID"))
  url.searchParams.set("redirect_uri", `${origin}/api/auth/github/callback`)
  url.searchParams.set("scope", "read:user")
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  let bin = ""
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function exchangeCode(origin: string, code: string, verifier: string): Promise<string> {
  const res = await budgetedFetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "archivepool" },
    body: JSON.stringify({
      client_id: requireSecret("GITHUB_CLIENT_ID"),
      client_secret: requireSecret("GITHUB_CLIENT_SECRET"),
      code,
      redirect_uri: `${origin}/api/auth/github/callback`,
      code_verifier: verifier,
    }),
  })
  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!res.ok || !data.access_token) throw new Error(`github token exchange failed: ${data.error ?? res.status}`)
  return data.access_token
}

export interface GithubIdentity {
  id: number
  login: string
}

export async function fetchGithubUser(token: string): Promise<GithubIdentity> {
  const res = await budgetedFetch(GITHUB_USER_URL, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "archivepool" },
  })
  if (!res.ok) throw new Error(`github /user failed: HTTP ${res.status}`)
  const data = (await res.json()) as { id?: number; login?: string }
  if (typeof data.id !== "number" || typeof data.login !== "string" || data.login.length === 0) {
    throw new Error("github /user returned no usable identity")
  }
  return { id: data.id, login: data.login }
}

// ---------- Pending-identity cookie ----------

export async function issuePendingCookie(identity: GithubIdentity): Promise<string> {
  return packPendingCookie(identity.id, identity.login)
}

export type { PendingIdentity }
export { readPendingCookie }

// ---------- users / claims ----------

export async function findUserByGithubId(githubId: number) {
  const [row] = await db.select().from(users).where(eq(users.githubId, githubId)).limit(1)
  return row ?? null
}

/**
 * Attach a GitHub subject to an existing account — ATOMICALLY: the UPDATE only
 * lands while the row's github_id is still NULL (or already this same id), so two
 * concurrent claimants cannot both win. Null = the row was claimed in between.
 */
export async function linkGithubToUser(userId: number, githubId: number) {
  const [row] = await db
    .update(users)
    .set({ githubId })
    .where(
      and(eq(users.id, userId), or(isNull(users.githubId), eq(users.githubId, githubId))),
    )
    .returning({ id: users.id, username: users.username })
  return row ?? null
}

/**
 * Claim proof lookup: the requester pastes one of the claimed account's API keys.
 * api_keys stores only the SHA-256 hex of each key, so the check is a single cheap
 * hash + row lookup — no scrypt, no key plaintext ever touches this endpoint.
 * Returns the key row's revocation state, or null when no such key belongs to that
 * account (deleted rows prove nothing and are excluded here).
 */
export async function findOwnedApiKey(
  claimedUserId: number,
  candidateKey: string,
): Promise<{ revoked: boolean } | null> {
  const keyHash = hashKey(candidateKey.trim())
  const [row] = await db
    .select({ revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.userId, claimedUserId), eq(apiKeys.deleted, false)))
    .limit(1)
  return row ?? null
}

export async function createGithubClaim(githubId: number, githubLogin: string, username: string, provenance = "") {
  const [row] = await db
    .insert(githubClaims)
    .values({ githubId, githubLogin, username, reviewNote: provenance })
    .returning({ id: githubClaims.id })
  return row
}

export async function listPendingClaims() {
  await ensureSchema()
  return db
    .select()
    .from(githubClaims)
    .where(eq(githubClaims.status, "pending"))
    .orderBy(desc(githubClaims.createdAt))
    .limit(200)
}

/**
 * Approve a pending claim — inside one transaction, with the same atomic link
 * predicate as the self-service path: the UPDATE only lands while the account is
 * still unlinked (or already holds this github_id). Also refuses when that
 * github_id is already attached to a DIFFERENT account; the partial-unique index
 * remains the final backstop and its violation maps to "already_linked".
 */
export async function approveGithubClaim(claimId: number, reviewerId: number | null) {
  await ensureSchema()
  const result = await db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(githubClaims)
      .where(and(eq(githubClaims.id, claimId), eq(githubClaims.status, "pending")))
      .limit(1)
    if (!claim) return null
    const [target] = await tx.select().from(users).where(eq(users.username, claim.username)).limit(1)
    if (!target) return { error: "user_gone" as const }
    const [holder] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubId, claim.githubId))
      .limit(1)
    if (holder && holder.id !== target.id) return { error: "already_linked" as const }
    const [linked] = await tx
      .update(users)
      .set({ githubId: claim.githubId })
      .where(
        and(eq(users.id, target.id), or(isNull(users.githubId), eq(users.githubId, claim.githubId))),
      )
      .returning({ id: users.id })
    if (!linked) return { error: "already_linked" as const }
    const [done] = await tx
      .update(githubClaims)
      .set({ status: "approved", reviewedAt: new Date(), reviewedBy: reviewerId })
      .where(eq(githubClaims.id, claimId))
      .returning({ id: githubClaims.id, username: githubClaims.username })
    return done ?? null
  })
  return result
}

export async function rejectGithubClaim(claimId: number, reviewerId: number | null, note: string) {
  await ensureSchema()
  const [done] = await db
    .update(githubClaims)
    .set({ status: "rejected", reviewNote: note, reviewedAt: new Date(), reviewedBy: reviewerId })
    .where(and(eq(githubClaims.id, claimId), eq(githubClaims.status, "pending")))
    .returning({ id: githubClaims.id })
  return Boolean(done)
}
