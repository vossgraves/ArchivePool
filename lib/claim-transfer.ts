// SPDX-License-Identifier: GPL-3.0-or-later
//
// The legacy-account claim TRANSFER, kept dependency-light on purpose: no
// "server-only" marker, no @/lib/db binding — the caller passes the drizzle
// handle. Relative imports only, so the regression sim
// (scripts/sim-github-auth.mjs) compiles this exact module for plain node and
// exercises the real transaction — locks, re-checks and repoints — instead of a
// mock.
import { and, eq, sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { apiKeys, apiKeyRequests, users } from "./db/schema"

type Db = NodePgDatabase<typeof import("./db/schema")>
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

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

/** FOR UPDATE on two user rows in ascending-id order — the deterministic lock
 *  order that keeps concurrent mutual claims deadlock-free. Every transaction
 *  that needs locks on both a user row and its request/key rows uses this same
 *  convention (users ascending first, then request/key rows). */
export async function lockUsersInOrder(tx: Tx, first: number, second: number): Promise<void> {
  for (const id of [Math.min(first, second), Math.max(first, second)]) {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1).for("update")
  }
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
 *   3. Re-check the PROOF under lock: [keyHash]'s api_keys row is locked
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
export async function runLegacyClaimTransfer(
  db: Db,
  claimerId: number,
  legacyUserId: number,
  keyHash: string,
): Promise<ClaimTransfer> {
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
