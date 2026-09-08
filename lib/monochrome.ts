import "server-only"
import { syncInstanceUrls, type InstanceSyncResult } from "@/lib/instance-sync"
import { normalizeUrl } from "@/lib/sources"

/** Shape returned by https://monochrome.tf/instances.json */
interface MonochromeInstances {
  api?: string[]
  streaming?: string[]
}

const MONOCHROME_URL = "https://monochrome.tf/instances.json"
const FETCH_TIMEOUT_MS = 15_000

export type MonochromeSyncResult = InstanceSyncResult

/**
 * Fetches the monochrome.tf instance list and pools the passing Tidal instances via
 * {@link syncInstanceUrls}. The feed is the only monochrome-specific part; dedupe, health-checking,
 * the premium gate and upserts are the shared instance-sync core.
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
