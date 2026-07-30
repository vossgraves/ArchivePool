import "server-only"
import { createHash, timingSafeEqual } from "node:crypto"
import type { NextRequest } from "next/server"

/**
 * Shared authentication for the admin and cron routes.
 *
 * These checks used to be copy-pasted into six route handlers as a plain `===` string comparison,
 * which has two problems this module fixes:
 *
 *  1. `===` on secrets short-circuits at the first differing byte, so response time leaks how much
 *     of a guess was correct. Comparing digests with `timingSafeEqual` removes that signal.
 *  2. `ADMIN_TOKEN` held the usable secret in plaintext, so anything that could read the
 *     environment (a leaked dashboard, a log dump, a compromised build) got full admin access.
 *     `ADMIN_TOKEN_HASH` stores only a SHA-256 digest instead: the server can still verify a
 *     presented token, but the stored value is not itself a credential.
 *
 * Deliberately mirrors the hash-and-compare approach already used for read keys in
 * `lib/api-keys.ts`, so the admin path is no longer the weakest link.
 */

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed first so the buffers are always 32 bytes. That matters because
 * `timingSafeEqual` throws on length mismatch, and returning early on that would leak the length of
 * the real secret.
 */
function secretMatches(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected))
}

/** Pull a non-empty bearer token out of the Authorization header. */
function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token.length > 0 ? token : null
}

/**
 * True when the request carries the admin credential.
 *
 * Prefers `ADMIN_TOKEN_HASH` (SHA-256 hex of the token). Falls back to a plaintext `ADMIN_TOKEN` so
 * an existing deployment keeps working while the hash is rolled out. Fails closed when neither is
 * configured — an unset secret must never mean "allow".
 */
export function isAdminAuthorized(req: NextRequest): boolean {
  const candidate = bearerToken(req)
  if (!candidate) return false

  const configuredHash = process.env.ADMIN_TOKEN_HASH?.trim().toLowerCase()
  if (configuredHash) {
    let expected: Buffer
    try {
      expected = Buffer.from(configuredHash, "hex")
    } catch {
      return false
    }
    // A malformed hash is a misconfiguration, not a reason to fall back to a weaker check.
    if (expected.length !== 32) return false
    return timingSafeEqual(sha256(candidate), expected)
  }

  const plaintext = process.env.ADMIN_TOKEN
  if (!plaintext) return false
  return secretMatches(candidate, plaintext)
}

/**
 * True when the request may run a scheduled job.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically, so that is the primary
 * path; the admin token is also accepted so the jobs stay manually triggerable.
 */
export function isCronAuthorized(req: NextRequest): boolean {
  const candidate = bearerToken(req)
  if (!candidate) return false

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && secretMatches(candidate, cronSecret)) return true

  return isAdminAuthorized(req)
}
