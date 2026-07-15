import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiKeys } from "@/lib/db/schema"

const KEY_PREFIX = "atp_"

/** SHA-256 hex of a key string. Only the hash is ever persisted. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/**
 * Generate a new random read key. Returns the plaintext (shown once) and the
 * values to persist. Format: `atp_<48 hex chars>`.
 */
export function generateKey(): { key: string; keyHash: string; prefix: string } {
  const key = KEY_PREFIX + randomBytes(24).toString("hex")
  return { key, keyHash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) }
}

/** Extract a candidate key from the request (Authorization: Bearer, or x-api-key). */
function extractKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim()
  const header = req.headers.get("x-api-key")
  if (header) return header.trim()
  const query = new URL(req.url).searchParams.get("key")
  return query?.trim() || null
}

/**
 * Validate the request's read key against the api_keys table. Returns true when a
 * non-revoked key matches. Also bumps use_count / last_used_at (best-effort).
 *
 * When READ_KEYS_ENFORCED is not "true", access is allowed without a key so the
 * operator can roll out gating gradually. Set READ_KEYS_ENFORCED=true to require keys.
 */
export async function verifyReadKey(req: NextRequest): Promise<boolean> {
  const enforced = process.env.READ_KEYS_ENFORCED === "true"

  // When gating is off, always allow (lets the operator roll keys out gradually).
  if (!enforced) return true

  const candidate = extractKey(req)
  if (!candidate) return false

  const keyHash = hashKey(candidate)
  const [row] = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash, revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)

  if (!row || row.revoked) return false

  // Constant-time compare of the hashes as defense-in-depth against timing attacks.
  const a = Buffer.from(row.keyHash)
  const b = Buffer.from(keyHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  // Best-effort usage bump; never block the request on this.
  void db
    .update(apiKeys)
    .set({ useCount: sql`${apiKeys.useCount} + 1`, lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .then(() => {})
    .catch(() => {})

  return true
}

/** Admin: create a key. Returns the one-time plaintext key. */
export async function createApiKey(name: string): Promise<{ id: number; key: string; prefix: string }> {
  const { key, keyHash, prefix } = generateKey()
  const [row] = await db.insert(apiKeys).values({ name, keyHash, prefix }).returning({ id: apiKeys.id })
  return { id: row.id, key, prefix }
}

/** Admin: list keys (never returns hashes or plaintext). */
export async function listApiKeys() {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      revoked: apiKeys.revoked,
      useCount: apiKeys.useCount,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt))
}

/** Admin: revoke (or restore) a key by id. */
export async function setKeyRevoked(id: number, revoked: boolean) {
  await db.update(apiKeys).set({ revoked }).where(and(eq(apiKeys.id, id)))
}
