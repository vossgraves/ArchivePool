// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { desc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { auditLog, users } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"
import type { AdminActor } from "@/lib/admin-auth"

export type AuditAction =
  | "key.create"
  | "key.revoke"
  | "key.restore"
  | "key.delete"
  | "request.approve"
  | "request.reject"
  | "entry.remove"
  | "entry.force_check"
  | "entry.purge_dead"
  | "entry.purge"
  | "user.create"
  | "user.role_change"

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")
  return (forwarded?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "").trim().slice(0, 64)
}

/**
 * Append one audit row. Never throws: an action that succeeded must not be reported as failed
 * because the trail could not be written, and the caller has already mutated state by this point.
 */
export async function recordAudit(
  req: NextRequest,
  actor: AdminActor,
  action: AuditAction,
  target: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ensureSchema()
    await db.insert(auditLog).values({
      action,
      target,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      detail,
      ipAddress: clientIp(req),
    })
  } catch (err) {
    console.error("[audit] failed to record", action, target, err)
  }
}

export async function listAudit(limit = 200) {
  await ensureSchema()
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      actorLabel: auditLog.actorLabel,
      actorUsername: users.username,
      detail: auditLog.detail,
      ipAddress: auditLog.ipAddress,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500))
}
