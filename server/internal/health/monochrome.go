package health

import (
	"context"
	"strconv"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/httpx"
	"archivepool/server/internal/pool"
)

// MonochromeInstances is the shape https://monochrome.st/instances.json returns.
type MonochromeInstances struct {
	API       []string `json:"api"`
	Streaming []string `json:"streaming"`
}

const (
	// monochrome.tf now 503s with a `<meta http-equiv='refresh' content='0; url=https://monochrome.st'>`
	// stub, so the feed moved to monochrome.st — the same domain its bundle calls (auth./data./tracks.).
	monochromeURL      = "https://monochrome.st/instances.json"
	monochromeTimeout  = 15 * time.Second
	monochromeFeedNote = "monochrome"
)

// SyncMonochromeInstances fetches the monochrome instance list and pools the passing Tidal
// instances. The feed is the only monochrome-specific part; dedupe, health-checking, the premium
// gate and upserts are the shared instance-sync core. The feed carries Tidal restream hosts only,
// so no other service is synced from it.
func SyncMonochromeInstances(ctx context.Context, database *db.DB) (InstanceSyncResult, error) {
	res, err := httpx.Get(ctx, monochromeURL, nil, monochromeTimeout)
	if err != nil {
		return InstanceSyncResult{}, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		status := res.StatusCode
		_ = res.Body.Close()
		return InstanceSyncResult{}, &feedError{status: status}
	}
	var raw MonochromeInstances
	if err := httpx.ReadJSON(res, &raw); err != nil {
		return InstanceSyncResult{}, err
	}

	urls := make([]string, 0, len(raw.API)+len(raw.Streaming))
	urls = append(urls, raw.API...)
	urls = append(urls, raw.Streaming...)

	return SyncInstanceURLs(ctx, database, pool.ServiceTidal, urls, monochromeFeedNote, 0, 0)
}

// feedError reports a non-2xx feed response as `HTTP <status>`, which is the message the cron
// route's per-feed try/catch surfaces.
type feedError struct{ status int }

func (e *feedError) Error() string { return "HTTP " + strconv.Itoa(e.status) }
