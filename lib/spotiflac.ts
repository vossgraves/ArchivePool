// SPDX-License-Identifier: GPL-3.0-or-later
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
 *
 * Provenance (re-checked 2026-09): the wiki page this list came from lives in the wiki's git
 * history — `spotbye/SpotiFLAC-Next.wiki` commit b97d862 deleted
 * `Available-HiFi-API-Instances.md`, whose table lists Spotisaver's `hifi-one`/`hifi-two` hosts.
 * That page cites github.com/SamidyFR/monochrome/blob/main/INSTANCES.md (now 404 — the project
 * moved to monochrome.st), and spotiflac.com/partners still credits "SpotiSaver — extra Tidal
 * delivery instances", so both hosts are transcribed below. The rest of the wiki now only teaches
 * users how to obtain their own Deezer ARL / Spotify sp_dc / Amazon auth, i.e. it still publishes
 * no credentials.
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
  "https://hifi-one.spotisaver.net",
  "https://hifi-two.spotisaver.net",
]

/**
 * Qobuz restream instances SpotiFLAC reaches. Same shape as the Tidal list and the same caveat:
 * the premium gate rejects any host that answers but cannot serve hi-res, so expect most of a
 * sweep to land in `rejected`.
 *
 * Transcribed from SpotiFLAC's published partner list (spotiflac.com/partners) and the endpoint
 * inventory at deepwiki.com/afkarxyz/SpotiFLAC. Base URLs only — the health check appends its own
 * paths, and a host listed under the wrong service simply fails the check and is never pooled.
 */
const SPOTIFLAC_QOBUZ_INSTANCES: string[] = [
  "https://dab.yeet.su",
  "https://dabmusic.xyz",
  "https://jumo-dl.pages.dev",
  "https://spotisaver.net",
  "https://squid.wtf",
]

export type SpotiFlacSyncResult = { tidal: InstanceSyncResult; qobuz: InstanceSyncResult }

/**
 * Pools SpotiFLAC's public instances through the shared instance-sync core. The health sweep and
 * premium gate decide which survive; this only supplies the seed lists.
 *
 * SpotiFLAC publishes no account credentials — "no account required" is its design, and the
 * accounts backing these hosts belong to their operators. There is nothing here to ingest as an
 * `account_entries` row, only instance URLs.
 *
 * Re-verified 2026-09 against the desktop source: the repo carries no token/ARL tables (its
 * community API is a signed-request service — see backend/community_session.go and the encrypted
 * community URLs in backend/community_endpoints.go — not a credential feed), and the wiki's only
 * credential pages are instructions for a user to copy their own cookie. Amazon support reaches
 * SpotiFLAC's own endpoint (backend/provider_endpoints.go: amazon.spotbye.qzz.io) rather than a
 * published instance list, so it is not pooled here; Deezer is download-side only.
 *
 * Re-verified 2026-09: SpotiFLAC (desktop) transcribes no Deezer instance list and its wiki only
 * teaches users to obtain their own ARL, so there is no Deezer seed to add here.
 */
export async function syncSpotiFlacInstances(): Promise<SpotiFlacSyncResult> {
  const [tidal, qobuz] = await Promise.all([
    syncInstanceUrls("tidal", SPOTIFLAC_TIDAL_INSTANCES, { note: "spotiflac" }),
    syncInstanceUrls("qobuz", SPOTIFLAC_QOBUZ_INSTANCES, { note: "spotiflac" }),
  ])
  return { tidal, qobuz }
}
