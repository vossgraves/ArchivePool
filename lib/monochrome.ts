import "server-only"
import { syncInstanceUrls, type InstanceSyncResult } from "@/lib/instance-sync"
import { normalizeUrl } from "@/lib/sources"

/** Shape returned by https://monochrome.st/instances.json (the project's current home). */
interface MonochromeInstances {
  api?: string[]
  streaming?: string[]
}

// monochrome.tf now 503s with a `<meta http-equiv='refresh' content='0; url=https://monochrome.st'>`
// stub, so the feed moved to monochrome.st — the same domain its bundle calls (auth./data./tracks.).
const MONOCHROME_URL = "https://monochrome.st/instances.json"
const FETCH_TIMEOUT_MS = 15_000

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
export async function syncMonochromeInstances(): Promise<MonochromeSyncResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let raw: MonochromeInstances
  try {
    const res = await fetch(MONOCHROME_URL, {
      signal: controller.signal,
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0" },
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    raw = (await res.json()) as MonochromeInstances
  } finally {
    clearTimeout(timer)
  }

  const urls = [...(raw.api ?? []), ...(raw.streaming ?? [])]
    .map((u) => normalizeUrl(u))
    .filter((u) => u.startsWith("http"))

  return syncInstanceUrls("tidal", urls, { note: "monochrome" })
}
