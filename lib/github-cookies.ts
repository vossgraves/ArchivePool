// SPDX-License-Identifier: GPL-3.0-or-later
// Self-contained GitHub auth helpers — no "server-only", no db imports — so the
// node regression sim (scripts/sim-github-auth.mjs) compiles and exercises the
// exact pack/parse/decision code the routes run.
import { signWithSessionSecret, verifyWithSessionSecret } from "./hmac-cookie"

/**
 * Cookie wire format: `<tag>.<field…>.<expMs>.<hmac>` where the HMAC covers
 * everything before the last dot. The tag is INSIDE the signed body, so a cookie
 * minted for one purpose can never be re-presented as the other — the earlier
 * shared format let an OAuth-state cookie parse as a pending identity.
 */
export const OAUTH_COOKIE_TAG = "gh-oauth-v1"
export const PENDING_COOKIE_TAG = "gh-pending-v1"

export const OAUTH_COOKIE_MAX_AGE_SEC = 10 * 60

// Canonical field shapes — regexes, never parseInt prefixes ("4242abc" is not an id).
const NUMERIC_ID = /^[1-9][0-9]{0,18}$/
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
const EXPIRY = /^[0-9]{10,15}$/
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

function encodeField(value: string): string {
  return encodeURIComponent(value)
}
function decodeField(value: string): string {
  return decodeURIComponent(value)
}

function notExpired(exp: number): boolean {
  return Number.isFinite(exp) && exp > Date.now()
}

// ---------- OAuth transaction cookie: <tag>.<state>.<verifier>.<exp>.<hmac> ----------

export async function packOauthCookie(state: string, verifier: string): Promise<string> {
  const exp = Date.now() + OAUTH_COOKIE_MAX_AGE_SEC * 1000
  const body = `${OAUTH_COOKIE_TAG}.${state}.${verifier}.${exp}`
  return `${body}.${await signWithSessionSecret(body)}`
}

/** Parse + signature-check an OAuth cookie — the only entry point; callers can
 *  never act on an unverified or mistagged value. */
export async function readOauthCookie(value: string | undefined): Promise<{ state: string; verifier: string } | null> {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 5) return null
  const [tag, state, verifier, expRaw, sig] = parts
  if (tag !== OAUTH_COOKIE_TAG || !NONCE.test(state) || !NONCE.test(verifier) || !EXPIRY.test(expRaw)) {
    return null
  }
  const exp = Number(expRaw)
  if (!notExpired(exp)) return null
  if (!(await verifyWithSessionSecret(`${tag}.${state}.${verifier}.${expRaw}`, sig))) return null
  return { state, verifier }
}

// ---------- Pending-identity cookie: <tag>.<githubId>.<login>.<exp>.<hmac> ----------
// login is URI-encoded; GitHub logins are alnum+hyphen so no dot can appear anyway,
// but the regex pins it down so the field layout can never be confused.

export async function packPendingCookie(githubId: number, login: string): Promise<string> {
  const exp = Date.now() + OAUTH_COOKIE_MAX_AGE_SEC * 1000
  const body = `${PENDING_COOKIE_TAG}.${githubId}.${encodeField(login)}.${exp}`
  return `${body}.${await signWithSessionSecret(body)}`
}

export interface PendingIdentity {
  id: number
  login: string
}

export async function readPendingCookie(value: string | undefined): Promise<PendingIdentity | null> {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 5) return null
  const [tag, idRaw, loginRaw, expRaw, sig] = parts
  // Tag is part of the signed body: a gh-oauth cookie presented here fails fast,
  // and a numeric prefix cannot smuggle an id past the canonical regex.
  if (tag !== PENDING_COOKIE_TAG || !NUMERIC_ID.test(idRaw) || !EXPIRY.test(expRaw)) return null
  const exp = Number(expRaw)
  if (!notExpired(exp)) return null
  if (!(await verifyWithSessionSecret(`${tag}.${idRaw}.${loginRaw}.${expRaw}`, sig))) return null
  const login = decodeField(loginRaw)
  if (!GITHUB_LOGIN.test(login)) return null
  return { id: Number(idRaw), login }
}

// ---------- Link / claim predicates (shared by the routes and the sim) ----------

/** Whether [incoming] may be stored on an account whose github_id is [current].
 *  The SQL link uses exactly this predicate: github_id IS NULL OR github_id = incoming. */
export function canLinkGithubId(current: number | null | undefined, incoming: number): boolean {
  return current == null || current === incoming
}

export type OwnedKey = { revoked: boolean } | null
export type ClaimDecision = "link" | "pending" | "reject"

/** What a pasted API key proves for a legacy-username claim:
 *  - key does not belong to the account     -> reject
 *  - key belongs but is REVOKED             -> a pending admin claim may be filed (a
 *    revoked key still identifies its owner, but must not self-authorize a link)
 *  - key belongs and is active              -> link
 */
export function claimDecision(key: OwnedKey): ClaimDecision {
  if (key == null) return "reject"
  if (key.revoked) return "pending"
  return "link"
}
