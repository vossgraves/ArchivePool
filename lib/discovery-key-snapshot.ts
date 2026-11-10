// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { apiKeys } from "@/lib/db/schema"
import { kvGetText, kvPutText } from "@/lib/pool-cache"
import { cached } from "@/lib/ttl-cache"
import { isService } from "@/lib/sources"
import type { ReadKeyIdentity } from "@/lib/api-keys"

const KEY = "pool/discovery-keys.json"
type Snapshot = { savedAt: number; keys: Record<string, { id: number; scope: string | null }> }

export async function snapshotDiscoveryIdentity(hash: string): Promise<ReadKeyIdentity | null> {
  const snapshot = await cached<Snapshot | null>("discovery-key-snapshot", 300_000, async () => {
    const raw = await kvGetText(KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Snapshot
      return typeof parsed.savedAt === "number" && parsed.keys ? parsed : null
    } catch { return null }
  })
  const row = snapshot?.keys[hash]
  if (!row || !Number.isSafeInteger(row.id)) return null
  return { ok: true, keyId: row.id, scope: isService(row.scope) ? row.scope : null }
}

export async function writeDiscoveryKeySnapshot(): Promise<void> {
  try {
    const rows = await db.select({ id: apiKeys.id, hash: apiKeys.keyHash, scope: apiKeys.service, revoked: apiKeys.revoked })
      .from(apiKeys).where(eq(apiKeys.deleted, false))
    const keys = Object.fromEntries(rows.filter((r) => !r.revoked).map((r) => [r.hash, { id: r.id, scope: r.scope }]))
    await kvPutText(KEY, JSON.stringify({ savedAt: Date.now(), keys }))
  } catch (err) { console.error("[auth] discovery snapshot unavailable:", err) }
}
