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

export const OAUTH_COOKIE_MAX_AGE_SEC = 10 * 60

// Canonical field shapes — regexes, never parseInt prefixes ("4242abc" is not an id).
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
const EXPIRY = /^[0-9]{10,15}$/

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

// ---------- Username derivation for first-time GitHub sign-ins ----------
// Site usernames are /^[a-z0-9_]{3,24}$/; GitHub logins are alnum + hyphen, ≤39
// chars. These candidates are tried in order — the first FREE one wins, so a
// GitHub login can never silently take over an existing (legacy) username.

const USERNAME_RE = /^[a-z0-9_]{3,24}$/
const MAX_LEN = 24

/** The sanitized base: lowercase, hyphen→underscore, anything else dropped,
 *  runs of underscores collapsed, edge underscores trimmed. */
export function githubUsernameBase(login: string): string {
  const base = login
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
  return base.slice(0, MAX_LEN)
}

function clamp(candidate: string): string {
  return candidate.slice(0, MAX_LEN)
}

/**
 * Ordered username candidates for a GitHub login. Index 0 is the preferred
 * spelling when it already satisfies the site pattern; the later fallbacks keep
 * the name recognisable while guaranteeing at least one well-formed candidate
 * exists for ANY login (digits-only, one-char, non-ASCII).
 */
export function deriveGithubUsernameCandidates(login: string): string[] {
  const base = githubUsernameBase(login)
  const stem = base.length > 0 ? base : "user"
  const out: string[] = []
  if (USERNAME_RE.test(stem)) out.push(stem)
  // gh_-prefixed variant — covers too-short stems and gives a clearly GitHub-flavoured fallback.
  out.push(clamp(`gh_${stem}`))
  // Numeric suffixes — "octo", "octo_2", "octo_3" … (underscore, never hyphen: not in the pattern).
  for (let i = 2; i <= 9; i++) out.push(clamp(`${stem}_${i}`))
  return out.filter((c) => USERNAME_RE.test(c))
}

// ---------- Claim proof decision (shared by the route and the sim) ----------

export type OwnedKey = { revoked: boolean } | null
export type ClaimDecision = "link" | "pending" | "reject"

/** What a pasted API key proves for a legacy-username claim:
 *  - key does not belong to the account     -> reject
 *  - key belongs but is REVOKED             -> a pending admin claim may be filed (a
 *    revoked key still identifies its owner, but must not self-authorize a claim)
 *  - key belongs and is active              -> the claim may proceed
 */
export function claimDecision(key: OwnedKey): ClaimDecision {
  if (key == null) return "reject"
  if (key.revoked) return "pending"
  return "link"
}

/** Whether [target] is a claimable LEGACY account for [claimerId]:
 *  a real account that is not the claimer's own, not disabled, not already
 *  claimed, and not already linked to a GitHub identity (a linked row is a
 *  current account, not a legacy one). */
export function canClaimLegacyUser(
  target: { id: number; disabled: boolean; claimedBy: number | null; githubId: number | null },
  claimerId: number,
): boolean {
  return (
    target.id !== claimerId &&
    !target.disabled &&
    target.claimedBy == null &&
    target.githubId == null
  )
}
