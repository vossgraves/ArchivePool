import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { and, desc, eq, gt, ne, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, apiKeyRequests, users } from "@/lib/db/schema"

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
 * The raw read key this request presented (Authorization: Bearer … or X-Api-Key), or null.
 * Used by feed routes to derive the per-requester client-encryption key after verifyReadKey
 * has authenticated it — the value is never persisted, only hashed (verifyReadKey) or used
 * as key material (deriveClientKey) within the request's lifetime.
 */
export function readKeyFromRequest(req: NextRequest): string | null {
  return extractKey(req)
}

/** Outcome of read-key authentication. `keyId` is the api_keys row id when one was resolved. */
export interface ReadKeyIdentity {
  ok: boolean
  /**
   * null when gating is off and no valid key was presented. Callers that key durable state on
   * the requester (per-key leases) must treat null as "anonymous" and skip that state rather
   * than inventing an identity — an unauthenticated caller must never be able to hold a lease.
   */
  keyId: number | null
}

/**
 * Validate the request's read key against the api_keys table and resolve its row id in the same
 * lookup, so callers that need both (per-key leasing) don't pay for a second query.
 *
 * [alwaysEnforce] is used by the credential-bearing source feed. Discovery feeds can remain public
 * unless READ_KEYS_ENFORCED is set because they contain instance URLs rather than account secrets.
 */
export async function identifyReadKey(req: NextRequest, alwaysEnforce = false): Promise<ReadKeyIdentity> {
  const enforced = alwaysEnforce || process.env.READ_KEYS_ENFORCED === "true"
  const candidate = extractKey(req)

  // When gating is off, always allow (lets the operator roll keys out gradually). With no
  // candidate presented there is nothing to resolve, so skip the query entirely — this is the
  // hot path for a deployment that never turned enforcement on.
  if (!enforced && !candidate) return { ok: true, keyId: null }

  if (!candidate) return { ok: false, keyId: null }

  const keyHash = hashKey(candidate)
  const [row] = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash, revoked: apiKeys.revoked })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.deleted, false)))
    .limit(1)

  if (!enforced) {
    // Gating is off but a key was presented anyway: resolve its id for leasing purposes only.
    // Deliberately skip the use_count/last_used_at bump below — bumping here would start
    // counting hits from routes like /api/report on unenforced deployments, a silent change to
    // what that dashboard number means. A missing/revoked/mismatched key is simply anonymous.
    if (!row || row.revoked) return { ok: true, keyId: null }
    const a = Buffer.from(row.keyHash)
    const b = Buffer.from(keyHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: true, keyId: null }
    return { ok: true, keyId: row.id }
  }

  if (!row || row.revoked) return { ok: false, keyId: null }

  // Constant-time compare of the hashes as defense-in-depth against timing attacks.
  const a = Buffer.from(row.keyHash)
  const b = Buffer.from(keyHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, keyId: null }

  // Best-effort usage bump; never block the request on this.
  void db
    .update(apiKeys)
    .set({ useCount: sql`${apiKeys.useCount} + 1`, lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .then(() => {})
    .catch(() => {})

  return { ok: true, keyId: row.id }
}

/**
 * Validate the request's read key against the api_keys table. Returns true when a non-revoked
 * key matches (or gating is off). Thin wrapper over [identifyReadKey] for the many call sites
 * that only need the boolean.
 */
export async function verifyReadKey(req: NextRequest, alwaysEnforce = false): Promise<boolean> {
  return (await identifyReadKey(req, alwaysEnforce)).ok
}

/** Admin: create a key. Returns the one-time plaintext key. */
export async function createApiKey(name: string): Promise<{ id: number; key: string; prefix: string }> {
  const { key, keyHash, prefix } = generateKey()
  const [row] = await db.insert(apiKeys).values({ name, keyHash, prefix }).returning({ id: apiKeys.id })
  return { id: row.id, key, prefix }
}

/**
 * Admin: create a key with a caller-chosen value (used to re-seed the baked
 * SOURCE_PROVIDER_KEY after a database loss so clients keep working without rebuilds).
 * Returns null when a key with this value already exists (unique hash).
 */
export async function createApiKeyWithValue(
  name: string,
  value: string,
): Promise<{ id: number; prefix: string } | null> {
  await ensureSchema()
  const keyHash = hashKey(value)
  const existing = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
  if (existing.length > 0) return null
  const [row] = await db
    .insert(apiKeys)
    .values({ name, keyHash, prefix: value.slice(0, KEY_PREFIX.length + 6) })
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix })
  return { id: row.id, prefix: row.prefix }
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

/**
 * User: permanently delete one of their own keys.
 *
 * This replaced a soft delete that only set `deleted` + `revoked`: the row and its hash stayed in
 * the table, so "delete" left users with a key they could neither use nor see, and no way to tell
 * a deleted key from a hidden one. Removing your own credential deletes it.
 *
 * Scoped by userId, so one account can never delete another's key by guessing ids.
 */
export async function deleteUserApiKey(userId: number, id: number) {
  const deleted = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id })
  return deleted.length > 0
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

/**
 * Admin: list every key, including soft-deleted ones.
 *
 * The user-facing list hides `deleted` rows; the admin must not, or a "deleted" key looks like it
 * vanished while its hash is still in the table. Owner username and the request reason are carried
 * so the panel can say whose key a given row is.
 */
export async function listApiKeys() {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      reason: apiKeys.reason,
      prefix: apiKeys.prefix,
      revoked: apiKeys.revoked,
      deleted: apiKeys.deleted,
      useCount: apiKeys.useCount,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      owner: users.username,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .orderBy(desc(apiKeys.createdAt))
}

/** Admin: revoke (or restore) a key by id. */
export async function setKeyRevoked(id: number, revoked: boolean) {
  await db.update(apiKeys).set({ revoked }).where(and(eq(apiKeys.id, id)))
}

/**
 * Admin: permanently delete a key row.
 *
 * This is the admin panel's only true removal. Revoking is reversible and leaves the hash in the
 * table; this removes the record outright, so the key can never be restored or matched again.
 * Users get the same thing for their own keys from the dashboard (see deleteUserApiKey).
 * `api_key_requests.resulting_key_id` is `ON DELETE SET NULL`, so the request that produced a key
 * survives with its history intact.
 */
export async function deleteApiKey(id: number) {
  const deleted = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id })
  return deleted.length > 0
}

// ─── API key request workflow (user subject+reason → admin approve → user claims key) ───

/** Cap on simultaneously active (non-revoked) keys a single account may hold. */
export const MAX_KEYS_PER_USER = 10

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
      reviewNote: apiKeyRequests.reviewNote,
      createdAt: apiKeyRequests.createdAt,
      reviewedAt: apiKeyRequests.reviewedAt,
    })
    .from(apiKeyRequests)
    .where(eq(apiKeyRequests.userId, userId))
    .orderBy(desc(apiKeyRequests.createdAt))
}

/**
 * How many requests from this device (IP + UA) still hold one of the limited slots — i.e. any
 * request in the last [hours] that was not rejected. Rejecting deliberately frees the slot again,
 * so a denial does not lock a device out forever.
 */
export async function countRequestsByIpUa(ip: string, ua: string, hours = 720): Promise<number> {
  if (!ip || !ua) return 0
  await ensureSchema()
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const rows = await db
    .select({ id: apiKeyRequests.id })
    .from(apiKeyRequests)
    .where(
      and(
        eq(apiKeyRequests.ipAddress, ip),
        eq(apiKeyRequests.userAgent, ua),
        gt(apiKeyRequests.createdAt, cutoff),
        ne(apiKeyRequests.status, "rejected"),
      ),
    )
  return rows.length
}

/**
 * Admin: approve a request. NO key is generated here.
 *
 * [adminId] is the reviewing site account, or null for the token-authenticated admin panel —
 * `api_key_requests.reviewed_by` is a foreign key to `users.id`, so passing a sentinel like 0
 * (which no account can have, ids start at 1) makes the UPDATE throw a constraint violation, the
 * route 500s, and the Approve button appears to do nothing at all. Null is the honest value for
 * "reviewed by whoever holds the admin token".
 *
 * The key itself is minted by the requester in claimApprovedKey(). Generating it here instead
 * would hand the one-time plaintext to the admin panel, where it is shown to nobody, logged
 * nowhere useful and lost — leaving the approved user with a key row they can never read.
 */
export async function approveKeyRequest(requestId: number, adminId: number | null) {
  await ensureSchema()
  const [req] = await db.select().from(apiKeyRequests).where(eq(apiKeyRequests.id, requestId)).limit(1)
  if (!req || req.status !== "pending") return null
  await db
    .update(apiKeyRequests)
    .set({ status: "approved", reviewedAt: new Date(), reviewedBy: adminId })
    .where(eq(apiKeyRequests.id, requestId))
  return { requestId, userId: req.userId, subject: req.subject }
}

/** Admin: reject a request, with the note ([note]) the requester gets to read. */
export async function rejectKeyRequest(requestId: number, adminId: number | null, note: string) {
  await ensureSchema()
  const [req] = await db.select().from(apiKeyRequests).where(eq(apiKeyRequests.id, requestId)).limit(1)
  if (!req || req.status !== "pending") return false
  await db
    .update(apiKeyRequests)
    .set({ status: "rejected", reviewNote: note, reviewedAt: new Date(), reviewedBy: adminId })
    .where(eq(apiKeyRequests.id, requestId))
  return true
}

export type ClaimResult =
  | { ok: true; id: number; key: string; prefix: string }
  | { ok: false; error: "not_found" | "not_approved" | "already_claimed" | "key_limit" }

/**
 * Requester: mint the key for a request an admin has approved.
 *
 * This is the only point where an approved request becomes an api_keys row, and the only place
 * the plaintext exists — it is returned to its owner once and never stored (only the SHA-256
 * hash is persisted). Runs in a transaction that locks the request row so two tabs cannot both
 * claim it and silently orphan a key.
 */
export async function claimApprovedKey(userId: number, requestId: number): Promise<ClaimResult> {
  await ensureSchema()
  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(apiKeyRequests)
      .where(and(eq(apiKeyRequests.id, requestId), eq(apiKeyRequests.userId, userId)))
      .limit(1)
      .for("update")

    if (!req) return { ok: false, error: "not_found" }
    if (req.status !== "approved") return { ok: false, error: "not_approved" }
    if (req.resultingKeyId) return { ok: false, error: "already_claimed" }

    const [existing] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.revoked, false), eq(apiKeys.deleted, false)))
    if (Number(existing?.count ?? 0) >= MAX_KEYS_PER_USER) return { ok: false, error: "key_limit" }

    const { key, keyHash, prefix } = generateKey()
    const [created] = await tx
      .insert(apiKeys)
      .values({ name: req.subject, keyHash, prefix, userId, reason: req.reason })
      .returning({ id: apiKeys.id })

    await tx
      .update(apiKeyRequests)
      .set({ resultingKeyId: created.id })
      .where(eq(apiKeyRequests.id, requestId))

    return { ok: true, id: created.id, key, prefix }
  })
}
