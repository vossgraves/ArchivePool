package health

import (
	"context"

	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// Public HiFi (Tidal) API instances that SpotiFLAC ships and races against.
//
// SpotiFLAC reaches Tidal through a rotating pool of public restream instances rather than a
// personal account. This is that pool, transcribed from SpotiFLAC's published instance list. The
// same `service=tidal, kind=api` restream shape ArchiveTune's instance racing already consumes, so
// pooling them widens the racing set /api/discovery/tidal serves.
//
// Kept as a static list, not a fetch, because SpotiFLAC itself hardcodes these — there is no
// upstream JSON feed to poll.
var spotiflacTidalInstances = []string{
	"https://triton.squid.wtf",
	"https://wolf.qqdl.site",
	"https://maus.qqdl.site",
	"https://vogel.qqdl.site",
	"https://katze.qqdl.site",
	"https://hund.qqdl.site",
	"https://tidal.kinoplus.online",
	"https://tidal-api.binimum.org",
}

// Qobuz restream instances SpotiFLAC reaches, with the same caveat: the premium gate rejects any
// host that answers but cannot serve hi-res, and a host listed under the wrong service simply fails
// its check and is never pooled.
var spotiflacQobuzInstances = []string{
	"https://dab.yeet.su",
	"https://dabmusic.xyz",
	"https://jumo-dl.pages.dev",
	"https://spotisaver.net",
	"https://squid.wtf",
}

// SpotiFlacSyncResult is the two-feed summary the monochrome cron reports.
type SpotiFlacSyncResult struct {
	Tidal InstanceSyncResult `json:"tidal"`
	Qobuz InstanceSyncResult `json:"qobuz"`
}

// SyncSpotiFlacInstances pools SpotiFLAC's public instances through the shared instance-sync core.
// SpotiFLAC publishes no account credentials — "no account required" is its design — so there is
// nothing here to ingest as an account_entries row, only instance URLs.
func SyncSpotiFlacInstances(ctx context.Context, database *db.DB) (SpotiFlacSyncResult, error) {
	tidal, tidalErr := SyncInstanceURLs(ctx, database, pool.ServiceTidal, spotiflacTidalInstances, "spotiflac", 0, 0)
	qobuz, qobuzErr := SyncInstanceURLs(ctx, database, pool.ServiceQobuz, spotiflacQobuzInstances, "spotiflac", 0, 0)
	if tidalErr != nil {
		return SpotiFlacSyncResult{}, tidalErr
	}
	if qobuzErr != nil {
		return SpotiFlacSyncResult{}, qobuzErr
	}
	return SpotiFlacSyncResult{Tidal: tidal, Qobuz: qobuz}, nil
}
