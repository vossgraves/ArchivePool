// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/httpx"
	"archivepool/server/internal/pool"
)

// MonochromeInstances is the shape https://monochrome.st/instances.json returns.
//
// Entries are URL strings OR `{url, version}` objects: monochrome's own reader accepts both
// (`typeof item === 'string' ? item : item.url` in js/storage.js), and the document it falls back to
// internally is `api: [{ url, version }]` — reading only strings made a version-shaped document
// throw, and a malformed entry now just yields no URL.
type MonochromeInstances struct {
	API       []MonochromeInstanceEntry `json:"api"`
	Streaming []MonochromeInstanceEntry `json:"streaming"`
}

// MonochromeInstanceEntry is one feed entry in either shape.
type MonochromeInstanceEntry struct {
	URL     string `json:"url"`
	Version string `json:"version"`
}

// UnmarshalJSON accepts a bare URL string as well as the object form.
func (e *MonochromeInstanceEntry) UnmarshalJSON(data []byte) error {
	var asString string
	if err := json.Unmarshal(data, &asString); err == nil {
		e.URL = asString
		return nil
	}
	var asObject struct {
		URL     string `json:"url"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &asObject); err != nil {
		// A malformed entry must not fail the whole feed: it contributes no URL.
		return nil
	}
	e.URL = asObject.URL
	e.Version = asObject.Version
	return nil
}

const (
	// monochrome.tf now 503s with a `<meta http-equiv='refresh' content='0; url=https://monochrome.st'>`
	// stub, so the feed moved to monochrome.st — the same domain its bundle calls (auth./data./tracks.).
	monochromeURL      = "https://monochrome.st/instances.json"
	monochromeTimeout  = 15 * time.Second
	monochromeFeedNote = "monochrome"
)

// monochromeOfficialHosts are the official monochrome API hosts, taken from the project's own source
// rather than from the feed document, and always probed alongside it.
//
// Upstream ships `INSTANCES_URLS: []` (2026-11-07) — it no longer reads any instance document at all
// — and falls back to `tracks.monochrome.st` (version 2.10) whenever its list is empty or
// unreachable; INSTANCES.md names `api.monochrome.tf` as the official API. The document polled below
// is therefore legacy, and its hosts (the squid/qqdl/spotisaver set) are exactly the community
// restreams whose backing accounts rotate. Seeding the official hosts keeps the pool from going empty
// when that legacy list has gone stale — each candidate still has to pass the same live track probe
// (checkTidalInstance), so one that moves again is simply never pooled.
var monochromeOfficialHosts = []string{"https://tracks.monochrome.st", "https://api.monochrome.tf"}

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

	urls := monochromeFeedURLs(raw)

	return SyncInstanceURLs(ctx, database, pool.ServiceTidal, urls, monochromeFeedNote, 0, 0, syncDetailLimit)
}

// monochromeFeedURLs flattens a feed document into the candidate list: every non-empty entry URL
// from both tiers, followed by the official hosts. Kept pure so the entry shapes can be tested
// without a database.
func monochromeFeedURLs(raw MonochromeInstances) []string {
	entries := make([]MonochromeInstanceEntry, 0, len(raw.API)+len(raw.Streaming))
	entries = append(entries, raw.API...)
	entries = append(entries, raw.Streaming...)
	urls := make([]string, 0, len(entries)+len(monochromeOfficialHosts))
	for _, entry := range entries {
		if url := strings.TrimSpace(entry.URL); url != "" {
			urls = append(urls, url)
		}
	}
	return append(urls, monochromeOfficialHosts...)
}

// feedError reports a non-2xx feed response as `HTTP <status>`, which is the message the cron
// route's per-feed try/catch surfaces.
type feedError struct{ status int }

func (e *feedError) Error() string { return "HTTP " + strconv.Itoa(e.status) }
