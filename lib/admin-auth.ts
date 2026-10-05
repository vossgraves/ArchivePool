// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { createHash, timingSafeEqual } from "node:crypto"
import type { NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/sessions"

/** Authentication for the admin and cron routes. See docs/ADMIN.md. */

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/** Both sides are hashed first: `timingSafeEqual` throws on a length mismatch, and returning
 *  early on that would leak the real secret's length. */
function secretMatches(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected))
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token.length > 0 ? token : null
}

/**
 * Prefers `ADMIN_TOKEN_HASH` (SHA-256 hex), falling back to plaintext `ADMIN_TOKEN` so a
 * deployment keeps working mid-rollout. Fails closed: an unset secret never means "allow".
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
    // A malformed hash is a misconfiguration, not a reason to fall back to the weaker check.
    if (expected.length !== 32) return false
    return timingSafeEqual(sha256(candidate), expected)
  }

  const plaintext = process.env.ADMIN_TOKEN
  if (!plaintext) return false
  return secretMatches(candidate, plaintext)
}

/** Vercel Cron sends `Bearer $CRON_SECRET`; the admin token also works so jobs stay triggerable. */
export function isCronAuthorized(req: NextRequest): boolean {
  const candidate = bearerToken(req)
  if (!candidate) return false

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && secretMatches(candidate, cronSecret)) return true

  return isAdminAuthorized(req)
}

/** Who acted. `userId` is null for the shared ADMIN_TOKEN, which cannot identify a person. */
export interface AdminActor {
  userId: number | null
  label: string
}

/** Authorize by either credential — shared token or an admin's session. Null when neither holds. */
export async function resolveAdmin(req: NextRequest): Promise<AdminActor | null> {
  if (isAdminAuthorized(req)) return { userId: null, label: "admin-token" }

  const userId = verifySessionToken(req.cookies.get(SESSION_COOKIE_NAME)?.value)
  if (userId === null) return null

  try {
    await ensureSchema()
    const [row] = await db
      .select({ username: users.username, role: users.role, disabled: users.disabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!row || row.disabled || row.role !== "admin") return null
    return { userId, label: row.username }
  } catch (err) {
    // A database failure must not be read as "allow".
    console.error("[admin-auth] role lookup failed:", err)
    return null
  }
}
