// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, desc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, githubClaims, users } from "@/lib/db/schema"
import { hashKey } from "@/lib/api-keys"
import { budgetedFetch } from "@/lib/cf-env"
import { signWithSessionSecret, verifyWithSessionSecret } from "@/lib/sessions"

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
 *                              API keys (sha256 lookup), or file a pending claim
 *                              for admin review (/api/admin/claims)
 */

export const GITHUB_OAUTH_COOKIE = "atp_gh_oauth"
export const GITHUB_PENDING_COOKIE = "atp_gh_pending"
const OAUTH_COOKIE_MAX_AGE_SEC = 10 * 60
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

function encodeField(value: string): string {
  return encodeURIComponent(value)
}
function decodeField(value: string): string {
  return decodeURIComponent(value)
}

// ---------- OAuth transaction cookie: <state>.<verifier>.<expMs>.<hmac> ----------

export async function issueOauthCookie(): Promise<{ cookieValue: string; state: string; verifier: string }> {
  const state = randomUrlSafe(16)
  const verifier = randomUrlSafe(32)
  const exp = Date.now() + OAUTH_COOKIE_MAX_AGE_SEC * 1000
  const sig = await signWithSessionSecret(`${state}.${verifier}.${exp}`)
  return { cookieValue: `${state}.${verifier}.${exp}.${sig}`, state, verifier }
}

export async function readOauthCookie(value: string | undefined): Promise<{ state: string; verifier: string } | null> {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const [state, verifier, expRaw, sig] = parts
  const exp = Number.parseInt(expRaw, 10)
  if (!Number.isFinite(exp) || exp <= Date.now()) return null
  if (!(await verifyWithSessionSecret(`${state}.${verifier}.${expRaw}`, sig))) return null
  return { state, verifier }
}

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

// ---------- Pending-identity cookie: <githubId>.<login>.<expMs>.<hmac> ----------
// login is URI-encoded so it can never collide with the field separators.

export async function issuePendingCookie(identity: GithubIdentity): Promise<string> {
  const exp = Date.now() + OAUTH_COOKIE_MAX_AGE_SEC * 1000
  const body = `${identity.id}.${encodeField(identity.login)}.${exp}`
  return `${body}.${await signWithSessionSecret(body)}`
}

export async function readPendingCookie(value: string | undefined): Promise<GithubIdentity | null> {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const [idRaw, loginRaw, expRaw, sig] = parts
  const githubId = Number.parseInt(idRaw, 10)
  const exp = Number.parseInt(expRaw, 10)
  if (!Number.isFinite(githubId) || githubId <= 0 || !Number.isFinite(exp) || exp <= Date.now()) return null
  if (!(await verifyWithSessionSecret(`${idRaw}.${loginRaw}.${expRaw}`, sig))) return null
  return { id: githubId, login: decodeField(loginRaw) }
}

// ---------- users / claims ----------

export async function findUserByGithubId(githubId: number) {
  const [row] = await db.select().from(users).where(eq(users.githubId, githubId)).limit(1)
  return row ?? null
}

/** Attach a GitHub subject to an existing account. Returns the updated user. */
export async function linkGithubToUser(userId: number, githubId: number) {
  const [row] = await db
    .update(users)
    .set({ githubId })
    .where(eq(users.id, userId))
    .returning({ id: users.id, username: users.username })
  return row ?? null
}

/**
 * Claim proof: the requester pastes one of the claimed account's existing API keys.
 * api_keys stores only the SHA-256 hex of each key, so the check is a single cheap
 * hash + row lookup — no scrypt, no key plaintext ever touches this endpoint.
 * Deleted keys prove nothing; revoked keys still identify their owner, so they count.
 */
export async function apiKeyProvesOwnership(claimedUserId: number, candidateKey: string): Promise<boolean> {
  const keyHash = hashKey(candidateKey.trim())
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.userId, claimedUserId), eq(apiKeys.deleted, false)))
    .limit(1)
  return Boolean(row)
}

export async function createGithubClaim(githubId: number, githubLogin: string, username: string) {
  const [row] = await db
    .insert(githubClaims)
    .values({ githubId, githubLogin, username })
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

/** Approve a pending claim: links the GitHub id to the named account. */
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
    if (target.githubId != null && target.githubId !== claim.githubId) return { error: "already_linked" as const }
    await tx.update(users).set({ githubId: claim.githubId }).where(eq(users.id, target.id))
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
