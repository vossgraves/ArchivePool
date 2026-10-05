// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { and, desc, eq, gt, ne, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { apiKeys, apiKeyRequests, users } from "@/lib/db/schema"
import { isService, type Service } from "@/lib/sources"

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

/** The raw presented key. Never persisted — only hashed, or used as key material, per request. */
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
  /**
   * The single service this key may read, or null for every service. null is the pre-scope
   * behaviour, so a key minted before scoping — or a legacy/admin key — keeps working unchanged.
   */
  scope: KeyScope
}

/**
 * The source a read key is restricted to. `null` means every service. Named so a caller can
 * carry the resolved scope (identity → lease queries) without re-deriving it from the key row.
 */
export type KeyScope = Service | null

/**
 * Validates the key and resolves its row id in one lookup, so per-key leasing needs no second
 * query. [alwaysEnforce] is for credential-bearing feeds; discovery feeds carry only URLs and
 * can stay public unless READ_KEYS_ENFORCED is set.
 */
export async function identifyReadKey(req: NextRequest, alwaysEnforce = false): Promise<ReadKeyIdentity> {
  const enforced = alwaysEnforce || process.env.READ_KEYS_ENFORCED === "true"
  const candidate = extractKey(req)

  // Gating off: allow, and skip the query entirely when nothing was presented.
  if (!enforced && !candidate) return { ok: true, keyId: null, scope: null }

  if (!candidate) return { ok: false, keyId: null, scope: null }

  const keyHash = hashKey(candidate)
  const [row] = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash, revoked: apiKeys.revoked, service: apiKeys.service })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.deleted, false)))
    .limit(1)

  const scope: KeyScope = row && isService(row.service) ? row.service : null

  if (!enforced) {
    // Resolve the id for leasing only; skip the use_count bump, which would silently change
    // what that dashboard number counts on an unenforced deployment.
    if (!row || row.revoked) return { ok: true, keyId: null, scope: null }
    const a = Buffer.from(row.keyHash)
    const b = Buffer.from(keyHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: true, keyId: null, scope: null }
    return { ok: true, keyId: row.id, scope }
  }

  if (!row || row.revoked) return { ok: false, keyId: null, scope: null }

  const a = Buffer.from(row.keyHash)
  const b = Buffer.from(keyHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, keyId: null, scope: null }

  // Best-effort; never block the request on it.
  void db
    .update(apiKeys)
    .set({ useCount: sql`${apiKeys.useCount} + 1`, lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .then(() => {})
    .catch(() => {})

  return { ok: true, keyId: row.id, scope }
}

/** Boolean-only wrapper over [identifyReadKey]. */
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
 * Create a key with a caller-chosen value, to re-seed the baked SOURCE_PROVIDER_KEY after a
 * database loss so installed clients keep working without a rebuild. Null when it already exists.
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

/** Scoped by userId, so one account cannot delete another's key by guessing ids. */
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
 * Every key, soft-deleted ones included — the user-facing list hides those, and an admin seeing
 * the same view would think a key vanished while its hash is still in the table.
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
 * The only true removal — revoking is reversible and leaves the hash behind. The originating
 * request survives: `resulting_key_id` is ON DELETE SET NULL.
 */
export async function deleteApiKey(id: number) {
  const deleted = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id })
  return deleted.length > 0
}


/** Cap on simultaneously active (non-revoked) keys a single account may hold. */
export const MAX_KEYS_PER_USER = 10

/** The requester's declared scope and reach details, carried onto the request row. */
export interface KeyRequestDetails {
  /** The single service the requester wants; null = any. */
  requestedService: KeyScope
  discordId: string | null
  telegramId: string | null
  contactNote: string | null
}

export async function createKeyRequest(
  userId: number,
  subject: string,
  reason: string,
  ip: string,
  ua: string,
  details: KeyRequestDetails,
) {
  await ensureSchema()
  const [row] = await db
    .insert(apiKeyRequests)
    .values({
      userId,
      subject,
      reason,
      ipAddress: ip,
      userAgent: ua,
      requestedService: details.requestedService,
      discordId: details.discordId,
      telegramId: details.telegramId,
      contactNote: details.contactNote,
      status: "pending",
    })
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

/** Rejection deliberately frees the slot, so a denial cannot lock a device out forever. */
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
 * Approve a request. No key is minted here — claimApprovedKey does that, so the one-time
 * plaintext reaches its owner instead of being lost in the admin panel.
 *
 * [adminId] must be null, never a 0 sentinel, for the token-authenticated panel: `reviewed_by`
 * is a foreign key to `users.id` and no account can have id 0, so 0 makes the UPDATE throw and
 * the Approve button silently do nothing.
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
 * The only place an approved request becomes a key row, and the only place the plaintext exists.
 * Locks the request row so two tabs cannot both claim it and orphan a key.
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
      .values({
        name: req.subject,
        keyHash,
        prefix,
        userId,
        reason: req.reason,
        // The approved scope becomes the key's scope: what was asked for is what is granted.
        service: req.requestedService,
      })
      .returning({ id: apiKeys.id })

    await tx
      .update(apiKeyRequests)
      .set({ resultingKeyId: created.id })
      .where(eq(apiKeyRequests.id, requestId))

    return { ok: true, id: created.id, key, prefix }
  })
}
