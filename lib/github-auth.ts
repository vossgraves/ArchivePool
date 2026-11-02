// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, apiKeyRequests, githubClaims, users } from "@/lib/db/schema"
import { hashKey } from "@/lib/api-keys"
import { budgetedFetch } from "@/lib/cf-env"
import {
  deriveGithubUsernameCandidates,
  OAUTH_COOKIE_MAX_AGE_SEC,
  packOauthCookie,
  readOauthCookie,
} from "@/lib/github-cookies"


/**
 * GitHub OAuth sign-in — the web-auth path that fits a Workers free request
 * (a handful of crypto.subtle HMAC/SHA-256 ops + two outbound fetches).
 *
 * Flow:
 *   /api/auth/github/start     state + PKCE verifier in a signed HttpOnly cookie,
 *                              redirect to github.com/login/oauth/authorize
 *   /api/auth/github/callback  verify state, exchange code (PKCE), fetch /user,
 *                              sign a known github_id straight in, or auto-create
 *                              an account whose username is DERIVED from the
 *                              GitHub login (no username prompt anywhere)
 *   /api/auth/claim-legacy     signed-in user proves a legacy username is theirs
 *                              with one of its ACTIVE API keys -> every per-user
 *                              row moves to their account and the legacy row is
 *                              marked claimed+disabled; a REVOKED key or no key
 *                              files a pending github_claims row for admin review
 *
 * The state cookie is purpose-tagged inside its signed body ("gh-oauth-v1") and
 * every field passes a canonical regex, so it cannot be re-presented as any
 * other token.
 */

export const GITHUB_OAUTH_COOKIE = "atp_gh_oauth"
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

// ---------- users / legacy claims ----------

export async function findUserByGithubId(githubId: number) {
  const [row] = await db.select().from(users).where(eq(users.githubId, githubId)).limit(1)
  return row ?? null
}

/** The account fields the legacy-claim flow needs. */
export async function findClaimableUser(username: string) {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      disabled: users.disabled,
      githubId: users.githubId,
      claimedBy: users.claimedBy,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
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

export type ClaimTransfer =
  | { ok: true; keys: number; requests: number }
  | {
      ok: false
      error:
        | "not_claimable"
        | "same_account"
        | "claimer_gone"
        | "claimer_not_live"
        | "proof_failed"
        | "proof_revoked"
    }

/**
 * Absorb a legacy account into [claimerId]'s account — the only way a legacy
 * username transfers. ONE transaction; nothing outside it is authoritative:
 *
 *   1. LOCK the claimer and target rows SELECT ... FOR UPDATE in ascending-id
 *      order — a deterministic order, so two accounts claiming each other cannot
 *      interleave into a deadlock (and after the first transfer, the second sees
 *      a dead claimer, not a mutual wipeout).
 *   2. Re-check the CLAIMER: must exist and be live — a disabled or already
 *      claimed account cannot receive rows (its session dies anyway; a transfer
 *      to it would strand the keys).
 *   3. Re-check the PROOF under lock: the presented API key's row is locked
 *      FOR UPDATE and must still belong to the target, be unrevoked and
 *      undeleted. A key revoked or deleted between the caller's pre-check and
 *      this point can no longer authorize a takeover.
 *   4. ATOMIC marker: UPDATE users SET claimed_by, disabled WHERE id=? AND the row is
 *      still claimable (not claimed, not disabled, no github_id, not the claimer).
 *      The predicate is the concurrency guard — a row claimed between the earlier
 *      read and this write yields no row and the whole transaction rolls back.
 *   5. Re-point every per-user row: api_keys and api_key_requests get the new owner.
 *      Keys keep working unchanged for apps — only user_id moves; key_hash and
 *      prefix are untouched, and api_key_leases references key ids, not users.
 *
 * contributor credit and audit_log history are deliberately NOT rewritten —
 * they are historical records, not ownership.
 */
export async function transferLegacyAccount(
  claimerId: number,
  legacyUserId: number,
  apiKey: string,
): Promise<ClaimTransfer> {
  await ensureSchema()
  if (claimerId === legacyUserId) return { ok: false, error: "same_account" }
  return db.transaction(async (tx) => {
    await lockUsersInOrder(tx, claimerId, legacyUserId)

    // The claimer must be a live row: it becomes claimed_by and the new owner of
    // every transferred key, both foreign keys.
    const [claimer] = await tx
      .select({ id: users.id, disabled: users.disabled, claimedBy: users.claimedBy })
      .from(users)
      .where(eq(users.id, claimerId))
      .limit(1)
    if (!claimer) return { ok: false, error: "claimer_gone" as const }
    if (claimer.disabled || claimer.claimedBy != null) return { ok: false, error: "claimer_not_live" as const }

    // The ownership proof, re-verified under the same lock the transfer runs
    // under — a key revoked or deleted after the route's pre-check loses.
    const keyHash = hashKey(apiKey)
    const [keyRow] = await tx
      .select({ userId: apiKeys.userId, revoked: apiKeys.revoked, deleted: apiKeys.deleted })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)
      .for("update")
    if (!keyRow || keyRow.userId !== legacyUserId || keyRow.deleted) {
      return { ok: false, error: "proof_failed" as const }
    }
    if (keyRow.revoked) return { ok: false, error: "proof_revoked" as const }

    const [marker] = await tx
      .update(users)
      .set({ claimedBy: claimerId, disabled: true })
      .where(
        and(
          eq(users.id, legacyUserId),
          sql`${users.claimedBy} IS NULL`,
          sql`${users.githubId} IS NULL`,
          eq(users.disabled, false),
          sql`${users.id} <> ${claimerId}`,
        ),
      )
      .returning({ id: users.id })
    if (!marker) return { ok: false, error: "not_claimable" as const }
    const movedKeys = await tx
      .update(apiKeys)
      .set({ userId: claimerId })
      .where(eq(apiKeys.userId, legacyUserId))
      .returning({ id: apiKeys.id })
    const movedRequests = await tx
      .update(apiKeyRequests)
      .set({ userId: claimerId })
      .where(eq(apiKeyRequests.userId, legacyUserId))
      .returning({ id: apiKeyRequests.id })
    return { ok: true as const, keys: movedKeys.length, requests: movedRequests.length }
  })
}

/** FOR UPDATE on two user rows in ascending-id order — the deterministic lock
 *  order that keeps concurrent mutual claims deadlock-free. */
async function lockUsersInOrder(tx: Tx, first: number, second: number): Promise<void> {
  for (const id of [Math.min(first, second), Math.max(first, second)]) {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1).for("update")
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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
 * Approve a pending claim — inside one transaction. The claimed legacy account's
 * rows are transferred to the claim's GitHub account, the legacy row is marked
 * claimed+disabled by the same atomic predicate the self-service path uses, and
 * the claim is closed.
 *
 * Claims filed BEFORE auto-account creation was deployed may reference a
 * github_id that has no account yet — the claim still stores the identity, so
 * approval CREATES the account from the claim's github_id/login (same candidate
 * derivation as first sign-in) and transfers into it. Refuses when the target
 * went away, was already claimed/linked, or the claimer row is dead — each maps
 * to a distinct error for the admin UI.
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

    let claimer = (await tx.select({ id: users.id }).from(users).where(eq(users.githubId, claim.githubId)).limit(1))[0] ?? null
    if (!claimer) {
      // Pre-upgrade claim: materialize the GitHub account it names. INSERT ...
      // ON CONFLICT DO NOTHING handles races — a zero-row insert followed by a
      // github_id hit means a concurrent sign-in created it first and wins.
      const candidates = deriveGithubUsernameCandidates(claim.githubLogin || "")
      candidates.push(`github_${(claim.githubId % 36 ** 10).toString(36)}`)
      for (const username of candidates) {
        const [created] = await tx
          .insert(users)
          .values({ username, passwordHash: "github", githubId: claim.githubId, githubLogin: claim.githubLogin })
          .onConflictDoNothing()
          .returning({ id: users.id })
        if (created) {
          claimer = created
          break
        }
        const [winner] = await tx.select({ id: users.id }).from(users).where(eq(users.githubId, claim.githubId)).limit(1)
        if (winner) {
          claimer = winner
          break
        }
      }
    }
    if (!claimer) return { error: "claimer_gone" as const }

    const [target] = await tx.select({ id: users.id }).from(users).where(eq(users.username, claim.username)).limit(1)
    if (!target) return { error: "user_gone" as const }
    if (target.id === claimer.id) return { error: "not_claimable" as const }

    await lockUsersInOrder(tx, claimer.id, target.id)

    // The claimer row may have gone dead while we held no locks — a disabled or
    // claimed account cannot receive a transfer.
    const [claimerLive] = await tx
      .select({ disabled: users.disabled, claimedBy: users.claimedBy })
      .from(users)
      .where(eq(users.id, claimer.id))
      .limit(1)
    if (!claimerLive || claimerLive.disabled || claimerLive.claimedBy != null) {
      return { error: "claimer_gone" as const }
    }

    const [marker] = await tx
      .update(users)
      .set({ claimedBy: claimer.id, disabled: true })
      .where(
        and(
          eq(users.id, target.id),
          sql`${users.claimedBy} IS NULL`,
          sql`${users.githubId} IS NULL`,
          eq(users.disabled, false),
          sql`${users.id} <> ${claimer.id}`,
        ),
      )
      .returning({ id: users.id })
    if (!marker) return { error: "not_claimable" as const }
    await tx.update(apiKeys).set({ userId: claimer.id }).where(eq(apiKeys.userId, target.id))
    await tx.update(apiKeyRequests).set({ userId: claimer.id }).where(eq(apiKeyRequests.userId, target.id))
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
