import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, apiKeyRequests } from "@/lib/db/schema"

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

/** Extract a candidate key from a header. Query-string keys leak into URLs, logs and history. */
function extractKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim()
  const header = req.headers.get("x-api-key")
  if (header) return header.trim()
  return null
}

/**
 * Validate the request's read key against the api_keys table. Returns true when a
 * non-revoked key matches. Also bumps use_count / last_used_at (best-effort).
 *
 * [alwaysEnforce] is used by the credential-bearing source feed. Discovery feeds can remain public
 * unless READ_KEYS_ENFORCED is set because they contain instance URLs rather than account secrets.
 */
export async function verifyReadKey(req: NextRequest, alwaysEnforce = false): Promise<boolean> {
  const enforced = alwaysEnforce || process.env.READ_KEYS_ENFORCED === "true"

  // When gating is off, always allow (lets the operator roll keys out gradually).
  if (!enforced) return true

  const candidate = extractKey(req)
  if (!candidate) return false

  const keyHash = hashKey(candidate)
  const [row] = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash, revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.deleted, false)))
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

/**
 * User: create a key owned by [userId]. Returns the one-time plaintext key —
 * only its hash is persisted, so the dashboard must show it exactly once.
 */
export async function createUserApiKey(
  userId: number,
  name: string,
  reason = "",
): Promise<{ id: number; key: string; prefix: string }> {
  const { key, keyHash, prefix } = generateKey()
  const [row] = await db
    .insert(apiKeys)
    .values({ name, keyHash, prefix, userId, reason })
    .returning({ id: apiKeys.id })
  return { id: row.id, key, prefix }
}

/** All keys owned by one user, newest first. Soft-deleted keys are hidden, never returned. */
export async function listUserApiKeys(userId: number) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      reason: apiKeys.reason,
      prefix: apiKeys.prefix,
      revoked: apiKeys.revoked,
      useCount: apiKeys.useCount,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.deleted, false)))
    .orderBy(desc(apiKeys.createdAt))
}

/** Soft delete: hide the key and stop it authenticating, but retain the row in the database. */
export async function setUserKeyDeleted(userId: number, id: number) {
  const updated = await db
    .update(apiKeys)
    .set({ deleted: true, revoked: true })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id })
  return updated.length > 0
}

/** Revoke (or restore) a key by id, scoped to its owner. Returns rows updated. */
export async function setUserKeyRevoked(userId: number, id: number, revoked: boolean) {
  const updated = await db
    .update(apiKeys)
    .set({ revoked })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id })
  return updated.length > 0
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

// ─── API key request workflow (user subject+reason → admin approve) ───

export async function createKeyRequest(
  userId: number,
  subject: string,
  reason: string,
  ip: string,
  ua: string,
) {
  await ensureSchema()
  const [row] = await db
    .insert(apiKeyRequests)
    .values({ userId, subject, reason, ipAddress: ip, userAgent: ua, status: "pending" })
    .returning({ id: apiKeyRequests.id })
  return row
}

export async function listUserRequests(userId: number) {
  await ensureSchema()
  return db
    .select({
      id: apiKeyRequests.id,
      subject: apiKeyRequests.subject,
      reason: apiKeyRequests.reason,
      status: apiKeyRequests.status,
      ipAddress: apiKeyRequests.ipAddress,
      userAgent: apiKeyRequests.userAgent,
      resultingKeyId: apiKeyRequests.resultingKeyId,
      createdAt: apiKeyRequests.createdAt,
      reviewedAt: apiKeyRequests.reviewedAt,
    })
    .from(apiKeyRequests)
    .where(eq(apiKeyRequests.userId, userId))
    .orderBy(desc(apiKeyRequests.createdAt))
}

export async function countRequestsByIpUa(ip: string, ua: string, hours = 720): Promise<number> {
  if (!ip || !ua) return 0
  await ensureSchema()
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const rows = await db
    .select({ id: apiKeyRequests.id })
    .from(apiKeyRequests)
    .where(and(eq(apiKeyRequests.ipAddress, ip), eq(apiKeyRequests.userAgent, ua)))
  // Filter by time and non-rejected in JS to avoid date handling complexity
  const filtered = await db
    .select({ id: apiKeyRequests.id, createdAt: apiKeyRequests.createdAt, status: apiKeyRequests.status })
    .from(apiKeyRequests)
    .where(and(eq(apiKeyRequests.ipAddress, ip), eq(apiKeyRequests.userAgent, ua)))
  return filtered.filter((r) => r.createdAt && r.createdAt > cutoff && r.status !== "rejected").length
}

export async function approveKeyRequest(requestId: number, adminId: number) {
  await ensureSchema()
  const [req] = await db.select().from(apiKeyRequests).where(eq(apiKeyRequests.id, requestId)).limit(1)
  if (!req || req.status !== "pending") return null
  const { key, keyHash, prefix } = generateKey()
  const [keyRow] = await db
    .insert(apiKeys)
    .values({ name: req.subject, keyHash, prefix, userId: req.userId, reason: req.reason })
    .returning({ id: apiKeys.id })
  await db
    .update(apiKeyRequests)
    .set({ status: "approved", resultingKeyId: keyRow.id, reviewedAt: new Date(), reviewedBy: adminId })
    .where(eq(apiKeyRequests.id, requestId))
  return { id: keyRow.id, key, prefix, requestId }
}

export async function rejectKeyRequest(requestId: number, adminId: number) {
  await ensureSchema()
  const [req] = await db.select().from(apiKeyRequests).where(eq(apiKeyRequests.id, requestId)).limit(1)
  if (!req || req.status !== "pending") return false
  await db
    .update(apiKeyRequests)
    .set({ status: "rejected", reviewedAt: new Date(), reviewedBy: adminId })
    .where(eq(apiKeyRequests.id, requestId))
  return true
}
