// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { syncInstanceUrls, type InstanceSyncResult } from "@/lib/instance-sync"
import { budgetedFetch } from "@/lib/cf-env"
import { normalizeUrl } from "@/lib/sources"

/**
 * Shape returned by https://monochrome.st/instances.json (the project's current home).
 *
 * Entries are strings OR objects: monochrome's own reader accepts both
 * (`typeof item === 'string' ? item : item.url` in `js/storage.js`), and the document it falls back
 * to internally is `api: [{ url, version }]`. Reading only strings made a version-shaped document
 * throw; a malformed entry now just yields no URL.
 */
interface MonochromeInstanceEntry {
  url?: string
  version?: string
}

interface MonochromeInstances {
  api?: (string | MonochromeInstanceEntry)[]
  streaming?: (string | MonochromeInstanceEntry)[]
}

// monochrome.tf now 503s with a `<meta http-equiv='refresh' content='0; url=https://monochrome.st'>`
// stub, so the feed moved to monochrome.st — the same domain its bundle calls (auth./data./tracks.).
const MONOCHROME_URL = "https://monochrome.st/instances.json"
const FETCH_TIMEOUT_MS = 15_000

/**
 * Official monochrome API hosts, taken from the project's own source rather than from the feed
 * document, and always probed alongside it.
 *
 * Upstream ships `INSTANCES_URLS: []` (2026-11-07) — it no longer reads any instance document at
 * all — and falls back to `tracks.monochrome.st` (version 2.10) whenever its list is empty or
 * unreachable; `INSTANCES.md` names `api.monochrome.tf` as the official API. The document this
 * module polls is therefore legacy, and its hosts (the squid/qqdl/spotisaver set) are exactly the
 * community restreams whose backing accounts rotate. Seeding the official hosts keeps the pool
 * from going empty when that legacy list has gone stale — and each candidate still has to pass the
 * same live track probe (`checkTidalInstance`), so one that moves again is simply never pooled.
 */
const MONOCHROME_OFFICIAL_HOSTS = ["https://tracks.monochrome.st", "https://api.monochrome.tf"]

export type MonochromeSyncResult = InstanceSyncResult

/**
 * Fetches the monochrome instance list (monochrome.st) and pools the passing Tidal instances via
 * {@link syncInstanceUrls}. The feed is the only monochrome-specific part; dedupe, health-checking,
 * the premium gate and upserts are the shared instance-sync core.
 *
 * Only the Tidal service is synced because that is all the feed carries: both arrays list Tidal
 * restream hosts (its own `*.monochrome.tf` frontends, the squid/qqdl/spotisaver/kinoplus
 * community hosts). Monochrome's Deezer support is a per-user fallback base URL in its web bundle,
 * not a published instance list, so it contributes nothing here — the Deezer tier in
 * lib/sources.ts is fed by contributor submissions instead.
 */
/**
 * The normalized candidate URLs from the monochrome feed, before any checking.
 * Exported so a batch-driving caller (the cron route on request-budgeted hosts)
 * can page through the same list it would otherwise have synced in one go.
 */
export async function fetchMonochromeUrls(): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let raw: MonochromeInstances
  try {
    const res = await budgetedFetch(MONOCHROME_URL, {
      signal: controller.signal,
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0" },
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    raw = (await res.json()) as MonochromeInstances
  } finally {
    clearTimeout(timer)
  }

  // Both arrays list Tidal restream hosts; the app prefers `streaming` (see monochrome's frontend
  // and ArchiveTune's discovery parser), but for a health check the order does not matter.
  return [...(raw.api ?? []), ...(raw.streaming ?? []), ...MONOCHROME_OFFICIAL_HOSTS]
    .map((entry) => (typeof entry === "string" ? entry : entry?.url ?? ""))
    .map((u) => normalizeUrl(u))
    .filter((u) => u.startsWith("http"))
}

/**
 * Syncs the feed's candidate hosts. `opts.detailLimit` echoes per-candidate verdicts back to the
 * caller (the cron log is the only place a failing host's reason is visible).
 */
export async function syncMonochromeInstances(
  opts: { detailLimit?: number } = {},
): Promise<MonochromeSyncResult> {
  return syncInstanceUrls("tidal", await fetchMonochromeUrls(), {
    note: "monochrome",
    detailLimit: opts.detailLimit,
  })
}
