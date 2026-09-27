package health

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/httpx"
	"archivepool/server/internal/pool"
)

// External token fetchers for the pool (lib/external-sources.ts). Two community sources are
// evaluated: the firehawk52 rentry (Qobuz tokens and Deezer ARLs, parsed out of markdown because
// there is no JSON API) and the citegptapi n8n webhook behind the QobuzDownloaderX UI. Every
// candidate is health-checked at ingest time, so a feed format change degrades to "rejected"
// rather than admitting broken credentials.

// FirehawkQobuzToken is one row of the rentry table.
type FirehawkQobuzToken struct {
	ID     string `json:"id"`
	Token  string `json:"token"`
	Expiry string `json:"expiry,omitempty"`
}

// FirehawkDeezerArl is one ARL scraped from the same page.
type FirehawkDeezerArl struct {
	ARL     string `json:"arl"`
	Country string `json:"country,omitempty"`
}

// QobuzSharedAccount is one account from the community webhook.
type QobuzSharedAccount struct {
	Token     string `json:"token"`
	AppID     string `json:"appId"`
	AppSecret string `json:"appSecret"`
	Country   string `json:"country,omitempty"`
	Note      string `json:"note,omitempty"`
}

const (
	qobuzProbeAppID     = "100000005"
	qobuzProbeAppSecret = "d2a459d68bb42a2d6462a1230517d3d4adadc4adadc4adadc4adadc4adadc"
	citegptSharedURL    = "https://citegptapi.f5.si/webhook/qbdlx/shared"
	jinaReader          = "https://r.jina.ai/"
	jinaUA              = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36"
)

var rentryRawURLs = []string{
	"https://rentry.co/firehawk52/raw",
	"https://rentry.org/firehawk52/raw",
	"https://rentry.co/api/paste/firehawk52",
}

var (
	firehawkRowRe = regexp.MustCompile(`\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|)\s*\|\s*` + "`?" + `(\d{5,8})` + "`?" + `\s*\|\s*` + "`" + `([A-Za-z0-9_\-+/=]{30,})` + "`")
	firehawkARLRe = regexp.MustCompile("(?i)`([a-f0-9]{180,})`")
)

func fetchText(ctx context.Context, url string, timeout time.Duration) (string, bool) {
	res, err := httpx.Get(ctx, url, nil, timeout)
	if err != nil {
		return "", false
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return "", false
	}
	text, err := httpx.ReadText(res)
	if err != nil {
		return "", false
	}
	return text, true
}

// FetchFirehawkRaw reads the first rentry mirror that still looks like the token page.
func FetchFirehawkRaw(ctx context.Context) (string, bool) {
	for _, url := range rentryRawURLs {
		text, ok := fetchText(ctx, url, 12*time.Second)
		if ok && strings.Contains(text, "Qobuz") && strings.Contains(text, "Deezer") {
			return text, true
		}
	}
	return "", false
}

// ParseFirehawkQobuzTokens pulls the markdown table rows: `| 2023-08-18 | `2522796` | `TOKEN` |`.
func ParseFirehawkQobuzTokens(raw string) []FirehawkQobuzToken {
	out := []FirehawkQobuzToken{}
	for _, m := range firehawkRowRe.FindAllStringSubmatch(raw, -1) {
		expiry, id, token := m[1], m[2], m[3]
		if id != "" && token != "" && len(token) > 40 {
			out = append(out, FirehawkQobuzToken{ID: id, Token: token, Expiry: expiry})
		}
	}
	return out
}

// ParseFirehawkDeezerArls pulls the long hex ARLs out of backticks.
func ParseFirehawkDeezerArls(raw string) []FirehawkDeezerArl {
	out := []FirehawkDeezerArl{}
	for _, m := range firehawkARLRe.FindAllStringSubmatch(raw, -1) {
		arl := m[1]
		if len(arl) >= 180 {
			out = append(out, FirehawkDeezerArl{ARL: arl})
		}
	}
	return out
}

// FetchFirehawkTokens reads and parses the rentry in one step.
func FetchFirehawkTokens(ctx context.Context) (map[string][]string, bool) {
	raw, ok := FetchFirehawkRaw(ctx)
	if !ok {
		return nil, false
	}
	qobuz := ParseFirehawkQobuzTokens(raw)
	deezer := ParseFirehawkDeezerArls(raw)
	tokens := make([]string, 0, len(qobuz))
	for _, t := range qobuz {
		tokens = append(tokens, t.Token)
	}
	arls := make([]string, 0, len(deezer))
	for _, a := range deezer {
		arls = append(arls, a.ARL)
	}
	return map[string][]string{"qobuz": tokens, "deezer": arls}, true
}

// dominantAppPair finds the most common (app_id, app_secret) pair in the feed, for entries missing
// credentials of their own.
func dominantAppPair(entries []map[string]any) (string, string) {
	counts := map[string]int{}
	for _, e := range entries {
		appID := strings.TrimSpace(str(e["app_id"]))
		appSecret := strings.TrimSpace(str(e["app_secret"]))
		if appID != "" && appSecret != "" {
			counts[appID+"|"+appSecret]++
		}
	}
	best := ""
	bestCount := -1
	for pair, count := range counts {
		if count > bestCount {
			best, bestCount = pair, count
		}
	}
	if best == "" {
		return "", ""
	}
	appID, appSecret, _ := strings.Cut(best, "|")
	return appID, appSecret
}

// FetchQbdlxShared reads the community shared-account webhook. The path list is exhaustive: the
// deployed QobuzDownloaderX UI bundle greps to exactly two webhook URLs — this one and an
// unrelated song.link resolver on another n8n host — so there is no Deezer/Tidal sibling to fetch.
// The UI unwraps a bare array *or* an `{ items: [...] }` envelope, and n8n's response mode can
// flip between the two without notice, so both are accepted here.
func FetchQbdlxShared(ctx context.Context) ([]QobuzSharedAccount, bool) {
	res, err := httpx.Get(ctx, citegptSharedURL, map[string]string{"user-agent": jinaUA}, 20*time.Second)
	if err != nil {
		return nil, false
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return nil, false
	}
	var envelope json.RawMessage
	if err := httpx.ReadJSON(res, &envelope); err != nil {
		return nil, false
	}
	var raw []map[string]any
	if err := json.Unmarshal(envelope, &raw); err != nil {
		// n8n answered with an `{ "items": [...] }` envelope instead of a bare array.
		var wrapped struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(envelope, &wrapped); err != nil || wrapped.Items == nil {
			return nil, false
		}
		raw = wrapped.Items
	}

	fallbackID, fallbackSecret := dominantAppPair(raw)
	if fallbackID == "" {
		fallbackID, fallbackSecret = qobuzProbeAppID, qobuzProbeAppSecret
	}
	out := make([]QobuzSharedAccount, 0, len(raw))
	for _, e := range raw {
		token := strings.TrimSpace(str(e["token"]))
		if token == "" {
			continue
		}
		appID := strings.TrimSpace(str(e["app_id"]))
		if appID == "" {
			appID = fallbackID
		}
		appSecret := strings.TrimSpace(str(e["app_secret"]))
		if appSecret == "" {
			appSecret = fallbackSecret
		}
		out = append(out, QobuzSharedAccount{
			Token:     token,
			AppID:     appID,
			AppSecret: appSecret,
			Country:   strings.TrimSpace(str(e["country"])),
			Note:      "qbdlx-shared",
		})
	}
	return out, true
}

// FetchFirehawkRendered reads the *rendered* rentry through a rendering proxy, which is what still
// works now that the raw endpoint demands an access code. Kept as a cheap opportunistic fallback.
func FetchFirehawkRendered(ctx context.Context) (qobuz []FirehawkQobuzToken, deezer []FirehawkDeezerArl, ok bool) {
	res, err := httpx.Get(ctx, jinaReader+"https://rentry.co/firehawk52", map[string]string{"user-agent": jinaUA}, 45*time.Second)
	if err != nil {
		return nil, nil, false
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return nil, nil, false
	}
	text, err := httpx.ReadText(res)
	if err != nil {
		return nil, nil, false
	}
	if !strings.Contains(strings.ToLower(text), "qobuz") && !strings.Contains(strings.ToLower(text), "deezer") {
		return nil, nil, false
	}
	qobuz = ParseFirehawkQobuzTokens(text)
	deezer = ParseFirehawkDeezerArls(text)
	if len(qobuz) == 0 && len(deezer) == 0 {
		return nil, nil, false
	}
	return qobuz, deezer, true
}

// ExternalIngestSummary is the cron route's `external` payload.
type ExternalIngestSummary struct {
	Fetched      int      `json:"fetched"`
	Inserted     int      `json:"inserted"`
	SkippedKnown int      `json:"skippedKnown"`
	Rejected     int      `json:"rejected"`
	Errors       []string `json:"errors"`
}

// IngestExternalSources fetches every external source and ingests the entries that are NOT already
// in the pool (dedupe by fingerprint). New entries run a live health check at ingest time; known
// ones cost one indexed SELECT, so the cron never re-checks the whole feed. maxNew bounds the
// per-run work.
func IngestExternalSources(ctx context.Context, database *db.DB, maxNew int) (ExternalIngestSummary, error) {
	if maxNew <= 0 {
		maxNew = 10
	}
	database.EnsureSchema(ctx) // account_entries must exist before the dedupe query below runs

	summary := ExternalIngestSummary{Errors: []string{}}

	type candidate struct {
		service pool.Service
		kind    pool.Kind
		payload map[string]any
	}
	candidates := []candidate{}

	// 1) Community shared Qobuz accounts (n8n webhook behind qbdlxui). This feed also carries the
	// (app_id, app_secret) pair the community is actually using, which the Firehawk rows below need
	// too: the health check requires all three, so a credential-less row can only ever be rejected.
	dominantID, dominantSecret := "", ""
	if shared, ok := FetchQbdlxShared(ctx); ok && len(shared) > 0 {
		entries := make([]map[string]any, 0, len(shared))
		for _, a := range shared {
			payload := map[string]any{"token": a.Token, "appId": a.AppID, "appSecret": a.AppSecret, "note": a.Note}
			if a.Country != "" {
				payload["country"] = a.Country
			}
			candidates = append(candidates, candidate{pool.ServiceQobuz, pool.KindAccount, payload})
			entries = append(entries, map[string]any{"app_id": a.AppID, "app_secret": a.AppSecret})
		}
		dominantID, dominantSecret = dominantAppPair(entries)
	} else {
		summary.Errors = append(summary.Errors, "citegptapi webhook unreachable or empty")
	}

	// 2) firehawk52 rendered rentry (opportunistic — see the fetcher's comment). Its table lists
	// tokens only, so the same dominant pair backfills them the way that feed backfills its own
	// credential-less rows. With no pair known the rows are skipped rather than ingested as
	// guaranteed rejects.
	if qobuz, deezer, ok := FetchFirehawkRendered(ctx); ok {
		if dominantID != "" {
			for _, t := range qobuz {
				candidates = append(candidates, candidate{pool.ServiceQobuz, pool.KindAccount,
					map[string]any{"token": t.Token, "appId": dominantID, "appSecret": dominantSecret}})
			}
		} else if len(qobuz) > 0 {
			summary.Errors = append(summary.Errors, "firehawk qobuz tokens skipped: no app pair known")
		}
		for _, a := range deezer {
			candidates = append(candidates, candidate{pool.ServiceDeezer, pool.KindAccount, map[string]any{"arl": a.ARL}})
		}
	}

	summary.Fetched = len(candidates)
	if summary.Fetched == 0 {
		return summary, nil
	}

	// Dedupe against the DB: fingerprints are unique per (service, kind, credential).
	fpSeen := map[string]bool{}
	fps := []string{}
	fpOf := make([]string, len(candidates))
	for i, c := range candidates {
		fp := pool.Fingerprint(c.service, c.kind, c.payload)
		fpOf[i] = fp
		if !fpSeen[fp] {
			fpSeen[fp] = true
			fps = append(fps, fp)
		}
	}

	existing := map[string]bool{}
	for start := 0; start < len(fps); start += 100 {
		end := start + 100
		if end > len(fps) {
			end = len(fps)
		}
		batch := fps[start:end]
		placeholders := make([]string, 0, len(batch))
		args := make([]any, 0, len(batch))
		for _, fp := range batch {
			args = append(args, fp)
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		rows, err := database.Query(ctx,
			`select fingerprint from account_entries where fingerprint in (`+strings.Join(placeholders, ", ")+`)`, args...)
		if err != nil {
			summary.Errors = append(summary.Errors, "dedupe query failed: "+errMessage(err))
			break
		}
		for _, r := range rows.All() {
			existing[r.Str("fingerprint")] = true
		}
	}

	unknown := 0
	for _, fp := range fps {
		if !existing[fp] {
			unknown++
		}
	}
	summary.SkippedKnown = len(candidates) - unknown

	fresh := make([]candidate, 0, len(candidates))
	for i, c := range candidates {
		if !existing[fpOf[i]] {
			fresh = append(fresh, c)
		}
	}
	if len(fresh) > maxNew {
		fresh = fresh[:maxNew]
	}

	// Ingest CONCURRENTLY (cap 5). Each ingest runs a live health check with up to a 12s timeout; a
	// serial loop over the full batch could blow the calling cron route's maxDuration.
	var mu sync.Mutex
	var next int
	var wg sync.WaitGroup
	workers := 5
	if len(fresh) < workers {
		workers = len(fresh)
	}
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				idx := next
				next++
				mu.Unlock()
				if idx >= len(fresh) {
					return
				}
				c := fresh[idx]
				result, err := IngestSource(ctx, database, c.service, c.kind, c.payload, IngestOptions{})
				mu.Lock()
				if err != nil {
					summary.Errors = append(summary.Errors, "ingest failed: "+errMessage(err))
				} else if result.Saved {
					summary.Inserted++
				} else {
					summary.Rejected++ // working-but-not-premium or failed live check — not stored
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	return summary, nil
}
