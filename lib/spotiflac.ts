import "server-only"
import { syncInstanceUrls, type InstanceSyncResult } from "@/lib/instance-sync"

/**
 * Public HiFi (Tidal) API instances that SpotiFLAC ships and races against.
 *
 * SpotiFLAC ("Get Spotify tracks in true lossless from Tidal, Qobuz & Amazon — no account
 * required") reaches Tidal through a rotating pool of public restream instances rather than a
 * personal account. This is that pool, transcribed from SpotiFLAC's published instance list
 * (github.com/spotbye/SpotiFLAC-Next wiki, "Available HiFi API Instances") and the endpoint
 * inventory at deepwiki.com/afkarxyz/SpotiFLAC. They are the same `service=tidal, kind=api`
 * restream shape ArchiveTune's Tidal instance-racing already consumes, so pooling them just widens
 * the racing set the app discovers at /api/discovery/tidal.
 *
 * Honest caveat, straight from ArchiveTune's own INSTANCE_RACING.md: a public instance only serves
 * full lossless while its backing Tidal account is subscribed; an unsubscribed one drops to 30s
 * previews. The pool's premium gate (see syncInstanceUrls) therefore rejects the preview-only ones,
 * so on any given sweep expect only the currently-subscribed hosts to be added — the list is
 * deliberately broad so at least some survive as the backing accounts rotate.
 *
 * Kept as a static list, not a fetch, because SpotiFLAC itself hardcodes these (base64-encoded in
 * its source) — there is no upstream JSON feed to poll. Add or remove hosts here as the project's
 * list changes.
 */
const SPOTIFLAC_TIDAL_INSTANCES: string[] = [
  "https://triton.squid.wtf",
  "https://wolf.qqdl.site",
  "https://maus.qqdl.site",
  "https://vogel.qqdl.site",
  "https://katze.qqdl.site",
  "https://hund.qqdl.site",
  "https://tidal.kinoplus.online",
  "https://tidal-api.binimum.org",
]

export type SpotiFlacSyncResult = InstanceSyncResult

/**
 * Pools SpotiFLAC's public Tidal HiFi instances through the shared instance-sync core. The health
 * sweep and premium gate decide which survive; this only supplies the seed list.
 */
export async function syncSpotiFlacInstances(): Promise<SpotiFlacSyncResult> {
  return syncInstanceUrls("tidal", SPOTIFLAC_TIDAL_INSTANCES, { note: "spotiflac" })
}
