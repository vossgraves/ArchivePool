// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

import { kvGetText, kvPutText } from "@/lib/pool-cache"
import {
  HISTORY_DAYS,
  getPoolHistory,
  getStatus,
  type CategoryStatus,
  type UptimePoint,
} from "@/lib/queries"
import type { Kind, Service } from "@/lib/sources"

/**
 * The status board's payload, memoized in Workers KV by the health sweep.
 *
 * `/api/status` is the one public endpoint that cannot degrade around its database read —
 * without it there are no figures at all. It used to run four SQL statements (two entry
 * scans, the uptime aggregate and the 14-day history) on every cache miss, and Hyperdrive
 * Free meters each one against 100,000/day. The sweep already touches every entry, so it now
 * writes the finished board here; the route serves this copy until the next sweep and only
 * falls back to SQL when the snapshot is absent or stale.
 *
 * Staleness is bounded by the 6-hourly sweep with a full day of slack: one missed sweep
 * must not send every poll back to the database.
 */
export interface StatusHistory {
  days: number
  overall: UptimePoint[]
  categories: { service: Service; kind: Kind; points: UptimePoint[] }[]
}

export interface StatusSnapshot {
  savedAt: number
  categories: CategoryStatus[]
  history: StatusHistory
  stale?: boolean
}

const SNAPSHOT_KEY = "pool/status.json"
const SNAPSHOT_TTL_MS = 26 * 60 * 60 * 1000

function isSnapshot(value: unknown): value is StatusSnapshot {
  const snapshot = value as StatusSnapshot | null
  return (
    !!snapshot &&
    typeof snapshot.savedAt === "number" &&
    Array.isArray(snapshot.categories) &&
    !!snapshot.history &&
    Array.isArray(snapshot.history.overall)
  )
}

/** The sweep's last board, or null when absent/stale/malformed. Never throws. */
export async function readStatusSnapshot(): Promise<StatusSnapshot | null> {
  const raw = await kvGetText(SNAPSHOT_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isSnapshot(parsed)) return null
    return Date.now() - parsed.savedAt > SNAPSHOT_TTL_MS ? { ...parsed, stale: true } : parsed
  } catch {
    return null
  }
}

/**
 * Persist a board computed elsewhere. Best-effort: a KV failure must not fail the response.
 * Used only by [writeStatusSnapshot] — the status route does not write it, because KV Free
 * allows 1,000 writes/day and one write per sweep is the whole point of the snapshot.
 */
async function putStatusSnapshot(
  categories: CategoryStatus[],
  history: { overall: UptimePoint[]; categories: StatusHistory["categories"] },
): Promise<void> {
  const snapshot: StatusSnapshot = {
    savedAt: Date.now(),
    categories,
    history: { days: HISTORY_DAYS, ...history },
  }
  await kvPutText(SNAPSHOT_KEY, JSON.stringify(snapshot))
}

/**
 * Read the board from the database and persist it. Called on the batch that finishes a health
 * sweep, so the cost is ~4 statements per sweep instead of per status poll.
 */
export async function writeStatusSnapshot(): Promise<void> {
  try {
    const [categories, history] = await Promise.all([getStatus(), getPoolHistory()])
    await putStatusSnapshot(categories, history)
  } catch (err) {
    console.error("[status] snapshot write failed:", err instanceof Error ? err.message : err)
  }
}
