// SPDX-License-Identifier: GPL-3.0-or-later
// Package health is the live-check and ingestion stack: lib/health.ts (per-service probes),
// lib/health-sweep.ts (full sweep, single re-check, auto-disable), lib/ingest.ts (admission-gated
// upsert), lib/instance-sync.ts plus the monochrome/SpotiFLAC adapters.
//
// Pool policy, identical across every path: only a source that is BOTH reachable AND premium is
// admitted. Anything else is rejected at the door, and an existing entry that stops being premium is
// disabled until a later sweep sees the entitlement return.
package health

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/httpx"
	"archivepool/server/internal/oauth"
	"archivepool/server/internal/pool"
)

// CheckResult is what a probe reports. Status is the pool status the sweep persists.
type CheckResult struct {
	OK        bool
	Premium   bool
	Status    pool.Status
	LatencyMs int
	Detail    string
	// Skipped marks a probe that reached no verdict (the host's rate limiter answered, a refresh
	// did not run): persistence must treat it as a no-op — no counter, no verdict, no health_log row.
	Skipped bool
}

const (
	timeoutMs = 12 * time.Second

	tidalTokenURL = "https://auth.tidal.com/v1/oauth2/token"
	// Tidal's own TV/device client UA, used for every Tidal API call so sessions are not flagged as
	// coming from an unrecognised agent.
	tidalUA = "TIDAL/1000 (Linux; Android 10)"

	ampBase         = "https://amp-api.music.apple.com"
	appleMusicHome  = "https://music.apple.com/"
	appleUA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
	ampTokenTTL     = 24 * time.Hour
	ampBundleRegexp = `assets/index-[^"']+\.js`
	ampJWTRegexp    = `eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`

	// format_id 5 (MP3 320) is not subscription-gated, so a rejection here means a bad signature
	// rather than the account's plan.
	qobuzProbeTrackID  = "5966783"
	qobuzProbeFormatID = "5"
	// Query params alone cause intermittent 401s and false "dead" results; the official clients
	// send these headers. The UA must stay in sync with the Qobuz login scraper.
	qobuzUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

	deezerGateway = "https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token="
	deezerUA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

var (
	ampBundleRe = regexp.MustCompile(ampBundleRegexp)
	ampJWTRe    = regexp.MustCompile(ampJWTRegexp)
)

// ampToken caches the scraped Apple dev JWT (24h cap, 60s early expiry).
var (
	ampTokenMu    sync.Mutex
	ampTokenValue string
	ampTokenExp   int64
	ampTokenAt    time.Time
)

// RunCheck dispatches to the per-service probe. entryFingerprint is passed so a Tidal check can
// persist a rotated refresh token back onto the row it came from.
func RunCheck(ctx context.Context, database *db.DB, service pool.Service, kind pool.Kind, payload map[string]any, entryFingerprint string) CheckResult {
	if kind == pool.KindAPI {
		// Amazon and Deezer instances publish their own liveness documents, so they are checked
		// against those rather than through the generic reachability rule. Tidal instances are
		// checked by resolving a real track (checkTidalInstance) — their root URL cannot judge them.
		if service == pool.ServiceDeezer {
			return checkDeezerInstance(ctx, payload)
		}
		if service == pool.ServiceAmazonMusic {
			return checkAmazonMusicInstance(ctx, payload)
		}
		if service == pool.ServiceTidal {
			return checkTidalInstance(ctx, payload)
		}
		return checkAPI(ctx, payload)
	}
	switch service {
	case pool.ServiceTidal:
		return checkTidalAccount(ctx, database, payload, entryFingerprint)
	case pool.ServiceDeezer:
		return checkDeezerAccount(ctx, payload)
	case pool.ServiceAppleMusic:
		return checkAppleMusicAccount(ctx, payload)
	case pool.ServiceAmazonMusic:
		return checkAmazonMusicAccount(payload)
	default:
		return checkQobuzAccount(ctx, database, payload, entryFingerprint)
	}
}

func classify(ok, premium bool) pool.Status {
	if !ok {
		return pool.StatusDead
	}
	if premium {
		return pool.StatusAlive
	}
	return pool.StatusPreview
}

// checkAPI: alive when the base URL answers without a server error; premium inferred from a probe.
func checkAPI(ctx context.Context, payload map[string]any) CheckResult {
	baseURL := strings.TrimRight(strings.TrimSpace(str(payload["baseUrl"])), "/")
	if baseURL == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing baseUrl"}
	}

	healthPath := strings.TrimSpace(str(payload["healthPath"]))
	target := baseURL
	if healthPath != "" {
		sep := "/"
		if strings.HasPrefix(healthPath, "/") {
			sep = ""
		}
		target = baseURL + sep + healthPath
	}

	started := time.Now()
	res, err := httpx.Get(ctx, target, nil, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	status := res.StatusCode
	_ = res.Body.Close()

	reachable := status < 500
	if !reachable {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(status)}
	}

	// Best-effort premium probe: read a small body and look for hi-res markers.
	premium := false
	probeURL := strings.TrimSpace(str(payload["probeUrl"]))
	probeTarget := target
	if probeURL != "" {
		if strings.HasPrefix(probeURL, "http") {
			probeTarget = probeURL
		} else {
			sep := "/"
			if strings.HasPrefix(probeURL, "/") {
				sep = ""
			}
			probeTarget = baseURL + sep + probeURL
		}
	}
	if probeRes, err := httpx.Get(ctx, probeTarget, nil, timeoutMs); err == nil {
		if text, err := httpx.ReadLimitedText(probeRes, 20000); err == nil {
			premium = hiResRe.MatchString(strings.ToLower(text))
		}
	}

	return CheckResult{
		OK:        true,
		Premium:   premium,
		Status:    classify(true, premium),
		LatencyMs: ms,
		Detail:    "HTTP " + strconv.Itoa(status),
	}
}

var hiResRe = regexp.MustCompile(`hi_res|hires|lossless|flac|24bit|"quality"\s*:\s*"(lossless|hi_res|hi-res)`)

// amazonHealthPath is where every Amazon instance serves its liveness document unless the
// contributor overrides it.
const amazonHealthPath = "/health"

// deezerHealthPath is where a Deezer instance serves its liveness document unless the contributor
// overrides it (Ultra MAX helper and the Monochrome fallback host both answer here).
const deezerHealthPath = "/health"

// amazonHealthErrorStatuses are the `status` values an Amazon instance uses to say it is NOT
// serving. Deliberately a denylist: an instance that answers its health endpoint at all is up
// unless it names one of these, so a new liveness word cannot silently turn every healthy
// instance dead. Transcribed from lib/health.ts.
var amazonHealthErrorStatuses = map[string]bool{
	"error":       true,
	"err":         true,
	"fail":        true,
	"failed":      true,
	"failure":     true,
	"down":        true,
	"dead":        true,
	"unhealthy":   true,
	"unavailable": true,
	"offline":     true,
	"disabled":    true,
}

// checkAmazonMusicInstance ports lib/health.ts checkAmazonMusicInstance.
//
// A self-hosted Amazon instance publishes its own liveness document, so unlike the Tidal/Qobuz
// restream check this one can ask the instance directly: `GET {baseUrl}{healthPath || "/health"}`
// must answer HTTP 2xx *and* a JSON object whose `status` is not an error. checkAPI cannot express
// that — it treats anything below 500 as reachable, so an instance answering
// `{"status":"error"}` with a 200 would be handed to every app as working.
//
// Premium comes from the same hi-res markers every other instance uses, read from `probeUrl` when
// one is given and from the health body otherwise, so the pool's admission rule is unchanged.
func checkAmazonMusicInstance(ctx context.Context, payload map[string]any) CheckResult {
	baseURL := strings.TrimRight(strings.TrimSpace(str(payload["baseUrl"])), "/")
	if baseURL == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing baseUrl"}
	}

	healthPath := strings.TrimSpace(str(payload["healthPath"]))
	if healthPath == "" {
		healthPath = amazonHealthPath
	}
	sep := "/"
	if strings.HasPrefix(healthPath, "/") {
		sep = ""
	}
	target := baseURL + sep + healthPath

	started := time.Now()
	res, err := httpx.Get(ctx, target, nil, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	status := res.StatusCode
	if status < 200 || status >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(status)}
	}

	body, err := httpx.ReadLimitedText(res, 20000)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: httpx.Reason(err)}
	}
	var parsed any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response is not JSON"}
	}
	// A JSON scalar (`123`, `"ok"`, `null`) parses but is no health document; the TS falls into the
	// same branch through its `typeof parsed === "object"` guard.
	parsedMap, isObject := parsed.(map[string]any)
	if !isObject {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response has no status"}
	}
	raw, ok := parsedMap["status"]
	if !ok || raw == nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response has no status"}
	}
	named := strings.TrimSpace(str(raw))
	if named == "" {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response has an empty status"}
	}
	if amazonHealthErrorStatuses[strings.ToLower(named)] {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "status: " + named}
	}

	premium := hiResRe.MatchString(strings.ToLower(body))
	if probeURL := strings.TrimSpace(str(payload["probeUrl"])); probeURL != "" {
		// Same rule as every other instance: an explicit probe replaces the health body as the
		// capability signal, so the contributor decides what "lossless" is measured against.
		premium = false
		probeTarget := probeURL
		if !strings.HasPrefix(probeURL, "http") {
			psep := "/"
			if strings.HasPrefix(probeURL, "/") {
				psep = ""
			}
			probeTarget = baseURL + psep + probeURL
		}
		if probeRes, err := httpx.Get(ctx, probeTarget, nil, timeoutMs); err == nil {
			if text, err := httpx.ReadLimitedText(probeRes, 20000); err == nil {
				premium = hiResRe.MatchString(strings.ToLower(text))
			}
		}
	}

	return CheckResult{
		OK:        true,
		Premium:   premium,
		Status:    classify(true, premium),
		LatencyMs: ms,
		Detail:    "HTTP " + strconv.Itoa(status),
	}
}

// checkDeezerInstance ports lib/health.ts checkDeezerInstance.
//
// A self-hosted Deezer instance publishes its own liveness document, so like the Amazon tier this
// one asks the instance directly: `GET {baseUrl}{healthPath || "/health"}` must answer HTTP 2xx
// with a JSON object that says it is serving. checkAPI cannot express that — it treats anything
// below 500 as reachable, so an instance answering `{"ok":false,…}` with a 200 would be handed to
// every app as working.
//
// Two community shapes are in the wild: Ultra MAX (github.com/PaRaN01a-hash/ultramax-music,
// helper/app.py `GET /health`) answers `{"ok":true,"user":{…}}` or `{"ok":false,"error":…}`, and
// the Monochrome Deezer fallback host serves an account-pool document
// `{"ok":bool,"accounts":{"total","available","dead","cooling",…},"defaultFormat":"FLAC",…}`.
// The verdict: an explicit `ok:false` is dead; otherwise an `accounts` block with nothing
// available or cooling is dead; otherwise the document is alive. Premium comes from the same
// hi-res markers every other instance uses, read from `probeUrl` when one is given.
func checkDeezerInstance(ctx context.Context, payload map[string]any) CheckResult {
	baseURL := strings.TrimRight(strings.TrimSpace(str(payload["baseUrl"])), "/")
	if baseURL == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing baseUrl"}
	}

	healthPath := strings.TrimSpace(str(payload["healthPath"]))
	if healthPath == "" {
		healthPath = deezerHealthPath
	}
	sep := "/"
	if strings.HasPrefix(healthPath, "/") {
		sep = ""
	}
	target := baseURL + sep + healthPath

	started := time.Now()
	res, err := httpx.Get(ctx, target, nil, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	status := res.StatusCode
	if status < 200 || status >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(status)}
	}

	body, err := httpx.ReadLimitedText(res, 20000)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: httpx.Reason(err)}
	}
	var parsed any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response is not JSON"}
	}
	record, isObject := parsed.(map[string]any)
	if !isObject {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response is not an object"}
	}

	if ok, present := record["ok"].(bool); present && !ok {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "status: not ok"}
	}
	accounts, hasAccounts := record["accounts"].(map[string]any)
	_, hasUser := record["user"].(map[string]any)
	if hasAccounts {
		// An instance whose whole pool is exhausted still answers its document, so the counts —
		// not the HTTP status — are what say it can serve right now.
		if total := numAttr(accounts, "total"); total > 0 &&
			numAttr(accounts, "available") == 0 && numAttr(accounts, "cooling") == 0 {
			return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "no accounts available"}
		}
	} else if !hasUser {
		if ok, present := record["ok"].(bool); !present || !ok {
			return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "health response has no status"}
		}
	}

	premium := hiResRe.MatchString(strings.ToLower(body))
	if probeURL := strings.TrimSpace(str(payload["probeUrl"])); probeURL != "" {
		premium = false
		probeTarget := probeURL
		if !strings.HasPrefix(probeURL, "http") {
			psep := "/"
			if strings.HasPrefix(probeURL, "/") {
				psep = ""
			}
			probeTarget = baseURL + psep + probeURL
		}
		if probeRes, err := httpx.Get(ctx, probeTarget, nil, timeoutMs); err == nil {
			if text, err := httpx.ReadLimitedText(probeRes, 20000); err == nil {
				premium = hiResRe.MatchString(strings.ToLower(text))
			}
		}
	}

	return CheckResult{
		OK:        true,
		Premium:   premium,
		Status:    classify(true, premium),
		LatencyMs: ms,
		Detail:    "HTTP " + strconv.Itoa(status),
	}
}

// Tidal instance probe constants.
//
// A HiFi-RestAPI/Monochrome instance publishes nothing useful at its root: `GET /` answers
// `{"version": …, "Repo": …}` (binimum/hifi-api `main.py` `@app.get("/")`), so a root fetch can
// neither prove the instance can stream nor detect its entitlement. The app's own health manager
// (`ArchiveTune` `TidalAudioProvider.verifyInstance`) resolves a real track on the two dialects these
// instances speak instead:
//
//   - `/trackManifests/` (HiFi-RestAPI 3.x, Monochrome): FULL/PREVIEW lives in
//     `data.data.attributes.trackPresentation` (older builds: `assetPresentation`); a backing
//     account without a subscription answers PREVIEW.
//   - `/track/` (HiFi-RestAPI 2.x): `data.assetPresentation` plus a base64 manifest in
//     `data.manifest` — the thing the instance actually has to return to serve audio.
//
// This replaced a `GET {baseUrl}` probe that could never admit these hosts: their root answers 200
// with `{"version","Repo"}`, which carries no hi-res marker, so every healthy instance came back
// `preview` and the premium gate rejected it — which is why the pool's Tidal API tier stayed empty.
const (
	tidalProbeTrackID = "155142501534011392"
	// The UA the app sends on instance traffic (`TidalAudioProvider.DOWNLOAD_USER_AGENT`); community
	// instances tune their WAF/bot rules per client, so it is kept identical on purpose.
	tidalInstanceUA = "ArchiveTune-Android"
)

// checkTidalInstance probes a Tidal restream instance the way the app does — see the constants above.
//
// Verdicts, mirroring the app's InstanceHealth:
//   - alive   2xx on either dialect with a FULL (non-preview) manifest document
//   - preview reachable, but its backing account only serves 30 s previews (not dead — and, since
//     the pool is premium-only, not pooled either)
//   - dead    DNS/TLS/timeout, a 5xx/403/400, a body with no manifest, or a v2 body with no manifest
//     string
//   - pending + Skipped: the instance answered 429. Its rate limiter is not a verdict, so nothing is
//     persisted and the next sweep re-probes it.
func checkTidalInstance(ctx context.Context, payload map[string]any) CheckResult {
	baseURL := strings.TrimRight(strings.TrimSpace(str(payload["baseUrl"])), "/")
	if baseURL == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing baseUrl"}
	}
	trackID := strings.TrimSpace(str(payload["probeTrackId"]))
	if trackID == "" {
		trackID = tidalProbeTrackID
	}
	headers := map[string]string{"accept": "application/json", "user-agent": tidalInstanceUA}

	// Trailing slash is load-bearing: these are FastAPI apps with redirect_slashes, and the slashless
	// form answers 307 that some instances (and the official api.monochrome.tf) turn into a 404.
	query := url.Values{}
	query.Set("id", trackID)
	query.Add("formats", "FLAC")
	query.Set("adaptive", "false")
	query.Set("manifestType", "MPEG_DASH")
	query.Set("uriScheme", "HTTPS")
	query.Set("usage", "PLAYBACK")

	started := time.Now()
	res, err := httpx.Get(ctx, baseURL+"/trackManifests/?"+query.Encode(), headers, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	status := res.StatusCode

	if status == 429 {
		_ = res.Body.Close()
		return CheckResult{
			Status:    pool.StatusPending,
			LatencyMs: ms,
			Detail:    "trackManifests HTTP 429 (rate limited, " + trackID + ")",
			Skipped:   true,
		}
	}
	if status >= 200 && status < 300 {
		body, readErr := httpx.ReadLimitedText(res, 20000)
		if readErr != nil {
			return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: httpx.Reason(readErr)}
		}
		presentation, found := manifestPresentation(body)
		if !found {
			return CheckResult{
				Status:    pool.StatusDead,
				LatencyMs: ms,
				Detail:    "trackManifests answered without a manifest document (" + trackID + ")",
			}
		}
		if strings.EqualFold(presentation, "PREVIEW") {
			return CheckResult{OK: true, Status: pool.StatusPreview, LatencyMs: ms, Detail: "trackManifests PREVIEW (" + trackID + ")"}
		}
		return CheckResult{OK: true, Premium: true, Status: pool.StatusAlive, LatencyMs: ms, Detail: "trackManifests " + presentation + " (" + trackID + ")"}
	}
	// Only a missing route earns the second dialect: any other non-2xx is the instance itself not
	// serving, which the older endpoint would report the same way.
	if status != 404 && status != 405 && status != 501 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "trackManifests HTTP " + strconv.Itoa(status)}
	}
	_ = res.Body.Close()

	// HiFi-RestAPI 2.x dialect.
	started = time.Now()
	res, err = httpx.Get(ctx, baseURL+"/track/?id="+url.QueryEscape(trackID)+"&quality=LOSSLESS", headers, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: httpx.Reason(err)}
	}
	ms += int(time.Since(started).Milliseconds())
	status = res.StatusCode
	if status == 429 {
		_ = res.Body.Close()
		return CheckResult{
			Status:    pool.StatusPending,
			LatencyMs: ms,
			Detail:    "track HTTP 429 (rate limited, " + trackID + ")",
			Skipped:   true,
		}
	}
	if status < 200 || status >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "track HTTP " + strconv.Itoa(status)}
	}
	body, readErr := httpx.ReadLimitedText(res, 20000)
	if readErr != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: httpx.Reason(readErr)}
	}
	var v2 struct {
		Data struct {
			AssetPresentation string `json:"assetPresentation"`
			Manifest          string `json:"manifest"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(body), &v2) != nil || v2.Data.AssetPresentation == "" && v2.Data.Manifest == "" {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "track answered without a data object (" + trackID + ")"}
	}
	if strings.EqualFold(v2.Data.AssetPresentation, "PREVIEW") {
		return CheckResult{OK: true, Status: pool.StatusPreview, LatencyMs: ms, Detail: "track PREVIEW (" + trackID + ")"}
	}
	if strings.TrimSpace(v2.Data.Manifest) == "" {
		// Reachable, but it has no manifest to hand out — a dead backing account answers like this.
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "track answered but served no manifest (" + trackID + ")"}
	}
	return CheckResult{OK: true, Premium: true, Status: pool.StatusAlive, LatencyMs: ms, Detail: "track LOSSLESS (" + trackID + ")"}
}

// manifestPresentation reads the FULL/PREVIEW presentation out of a `trackManifests` document,
// accepting both the hifi-api 3.x nesting (`data.data.attributes`) and the flatter shape some builds
// answer (`data.attributes`). The second return says whether a manifest document was there at all.
func manifestPresentation(body string) (string, bool) {
	var doc struct {
		Data struct {
			Attributes *struct {
				TrackPresentation string `json:"trackPresentation"`
				AssetPresentation string `json:"assetPresentation"`
			} `json:"attributes"`
			Data *struct {
				Attributes *struct {
					TrackPresentation string `json:"trackPresentation"`
					AssetPresentation string `json:"assetPresentation"`
				} `json:"attributes"`
			} `json:"data"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(body), &doc) != nil {
		return "", false
	}
	attributes := doc.Data.Attributes
	if doc.Data.Data != nil && doc.Data.Data.Attributes != nil {
		attributes = doc.Data.Data.Attributes
	}
	if attributes == nil {
		return "", false
	}
	presentation := strings.TrimSpace(attributes.TrackPresentation)
	if presentation == "" {
		presentation = strings.TrimSpace(attributes.AssetPresentation)
	}
	if presentation == "" {
		return "", false
	}
	return presentation, true
}

// numAttr mirrors the TS `Number(value ?? 0)` read of a health document's numeric field: a JSON
// number passes through, a numeric string is coerced, an absent/null field is 0, and anything else
// is NaN — which compares false exactly like the TS, so a garbage count never trips the
// "no accounts available" branch on one side only.
func numAttr(m map[string]any, key string) float64 {
	switch v := m[key].(type) {
	case nil:
		return 0
	case float64:
		return v
	case string:
		if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return n
		}
		return math.NaN()
	}
	return math.NaN()
}

// isTidalRefreshToken reports whether a Tidal JWT is a refresh token rather than an access token.
// The payload is read without verifying the signature, which is safe because the answer only decides
// which grant to attempt — Tidal still accepts or rejects it.
func isTidalRefreshToken(token string) bool {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return false
	}
	return str(payload["type"]) == "o2_refresh"
}

func decodeJWTPayload(jwt string) (map[string]any, bool) {
	parts := strings.Split(jwt, ".")
	if len(parts) < 2 {
		return nil, false
	}
	raw := parts[1]
	if decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "=")); err == nil {
		var out map[string]any
		if json.Unmarshal(decoded, &out) == nil {
			return out, true
		}
	}
	return nil, false
}

// tidalAccessMarginSecs is how long before its real expiry an access token counts as expired, so a
// token that would die in transit is refreshed rather than served. Mirrors lib/health.ts.
const tidalAccessMarginSecs = 300

// isTidalAccessExpired reports whether a JWT access token is expired (or about to expire). A token
// whose payload cannot be read is NOT treated as expired: the verdict would be a guess, and the
// /sessions probe still catches a dead token.
func isTidalAccessExpired(token string) bool {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return false
	}
	exp, ok := payload["exp"].(float64)
	if !ok || exp <= 0 {
		return false
	}
	return exp <= float64(time.Now().Unix()+tidalAccessMarginSecs)
}

// tidalRefresh is the outcome of a refresh attempt: the token it produced, or why it could not run.
//
// `skip` marks an outcome that says NOTHING about the account — the provider's rate limiter (429 or
// an `abuse_detected` body), a 5xx, a transport error. Callers report those as `pending` and never
// as `dead`, exactly like the Workers implementation: otherwise one burst of rate limiting over the
// Tidal token endpoint walks every account up the auto-disable ladder and empties the pool.
type tidalRefresh struct {
	token  string
	detail string
	skip   bool
	// payload is the credential as it stands after a successful refresh. A caller that refreshes
	// again in the same check must spend this one: the payload it started with may hold a refresh
	// token this refresh just rotated away.
	payload map[string]any
}

// tryRefreshTidalToken exchanges a refresh token for a fresh access token and writes it back, so
// later checks use the new one.
func tryRefreshTidalToken(ctx context.Context, database tokenStore, payload map[string]any, entryFingerprint string) tidalRefresh {
	// Contributors are handed a single value labelled "Token" which is in fact the refresh token, so
	// fall back to it when no separate refreshToken was supplied.
	refreshToken := effectiveRefreshToken(payload)
	if refreshToken == "" {
		return tidalRefresh{detail: "no refresh token"}
	}

	// Requesting a superset of a token's granted scopes makes Tidal answer 400 invalid_scope on
	// tokens minted elsewhere; fall back to the narrower scope rather than calling it dead.
	scopes := []string{"r_usr+w_usr+w_sub", "r_usr+w_usr"}

	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	ok := false
	for _, scope := range scopes {
		form := url.Values{
			"client_id":     {oauth.TidalClientID},
			"client_secret": {oauth.TidalClientSecret},
			"refresh_token": {refreshToken},
			"grant_type":    {"refresh_token"},
			"scope":         {scope},
		}
		res, err := httpx.PostForm(ctx, tidalTokenURL, map[string]string{"user-agent": tidalUA}, form, timeoutMs)
		if err != nil {
			// The endpoint was unreachable — a property of the network, not of the credential.
			return tidalRefresh{detail: "refresh transport error: " + httpx.Reason(err), skip: true}
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			if err := httpx.ReadJSON(res, &body); err != nil {
				return tidalRefresh{detail: "refresh answered unreadable JSON", skip: true}
			}
			ok = true
			break
		}
		var oauthErr struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		_ = httpx.ReadJSON(res, &oauthErr)
		abuse := res.StatusCode == 429 || strings.Contains(strings.ToLower(oauthErr.Error+" "+oauthErr.Description), "abuse")
		if abuse {
			return tidalRefresh{
				detail: "refresh rate-limited (HTTP " + strconv.Itoa(res.StatusCode) + ")",
				skip:   true,
			}
		}
		// A provider-side failure is transient: cool off and re-verify next sweep instead of writing
		// a dead verdict over what may be a perfectly good account.
		if res.StatusCode >= 500 {
			return tidalRefresh{
				detail: "refresh transient (HTTP " + strconv.Itoa(res.StatusCode) + ")",
				skip:   true,
			}
		}
		// Only a scope rejection is worth retrying; anything else (bad token, revoked) fails both.
		if oauthErr.Error != "invalid_scope" {
			// A refresh token is single-use: if the row now holds a different credential than the one
			// this attempt spent, another check refreshed the account while this one was in flight,
			// and the rejection is that race — not a dead account. (The Workers implementation
			// prevents the race up front with its claim column; the Go port detects the outcome, which
			// needs no schema of its own.)
			if oauthErr.Error == "invalid_grant" &&
				entryFingerprint != "" &&
				storedCredentialChanged(ctx, database, entryFingerprint, refreshToken) {
				return tidalRefresh{detail: "another check refreshed this account concurrently", skip: true}
			}
			return tidalRefresh{detail: "refresh rejected: " + firstNonEmpty(oauthErr.Error, strconv.Itoa(res.StatusCode))}
		}
	}
	if !ok || body.AccessToken == "" {
		return tidalRefresh{detail: "refresh failed"}
	}

	next := map[string]any{}
	for k, v := range payload {
		next[k] = v
	}
	next["token"] = body.AccessToken
	// Tidal does not always return a new refresh token. Keep the one just spent in that case: for a
	// contribution whose only field was the refresh token, overwriting `token` with the access token
	// would otherwise leave the row with nothing to renew from.
	next["refreshToken"] = firstNonEmpty(body.RefreshToken, refreshToken)

	// Persist the refreshed token so it does not expire again on the next cycle. Best-effort: a
	// database error must not fail the health check.
	if entryFingerprint != "" {
		if stored, err := crypto.EncryptAtRest(next); err == nil {
			_, _ = database.Exec(ctx, `update account_entries set payload = $1 where fingerprint = $2`,
				encodeJSON(stored), entryFingerprint)
		}
	}
	return tidalRefresh{token: body.AccessToken, detail: "refreshed", payload: next}
}

// firstNonEmpty returns the first non-blank candidate, for building a detail from either an OAuth
// error code or a status code.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// refreshFailureStatus maps a failed refresh onto the check's verdict: a skipped outcome (limiter,
// outage) is `pending` so the row keeps its previous status, a rejected credential is `dead`.
func refreshFailureStatus(refresh tidalRefresh) pool.Status {
	if refresh.skip {
		return pool.StatusPending
	}
	return pool.StatusDead
}

// storedCredentialChanged reports whether a row still holds the credential a failed refresh spent.
// Tidal refresh tokens are single-use, so a row that now holds something else was refreshed by a
// concurrent check — that rejection is a race, not a dead account.
func storedCredentialChanged(ctx context.Context, database tokenStore, entryFingerprint, spent string) bool {
	row, err := database.QueryRow(ctx,
		`select payload from account_entries where fingerprint = $1`, entryFingerprint)
	if err != nil || !row.Valid() {
		return false
	}
	return storedRefreshTokenRotated(crypto.DecryptAtRest(row.JSON("payload")), spent)
}

// tokenStore is the database surface the Tidal refresh path needs: the row a failed attempt compares
// its spent credential against and the UPDATE that persists a rotation. Narrowing it lets tests
// prove the persistence with a recording stand-in instead of a live database.
type tokenStore interface {
	QueryRow(ctx context.Context, sql string, args ...any) (db.Row, error)
	Exec(ctx context.Context, sql string, args ...any) (string, error)
}

// effectiveRefreshToken is the credential a refresh attempt on this payload spends: the dedicated
// refreshToken when present, else the legacy single `token` field contributors paste.
func effectiveRefreshToken(payload map[string]any) string {
	if token := strings.TrimSpace(str(payload["refreshToken"])); token != "" {
		return token
	}
	return strings.TrimSpace(str(payload["token"]))
}

// storedRefreshTokenRotated reports whether a row now holds a different refresh token than the one a
// failed attempt spent. Only the effective refresh token is compared: a normal row's access `token`
// always differs from the refresh token the attempt used, so counting either field as proof of a
// rotation classifies every revoked credential as a race and never dead-marks it.
func storedRefreshTokenRotated(payload map[string]any, spent string) bool {
	current := effectiveRefreshToken(payload)
	return current != "" && current != spent
}

// FreshTidalCredential is the pool's lease-time freshness hook (see pool.AccountLeaseMaintenance):
// it returns the payload to SERVE for a Tidal account — with a currently valid access token — and
// whether the entry must be left out of this lease because its stored token is already expired and
// could not be renewed.
//
// Tidal access tokens live about an hour while the sweep runs every six, so a leased token was
// routinely dead on arrival. Only the rows about to be served are refreshed: the lease handler
// calls this for a bounded candidate list, never for the whole pool.
func FreshTidalCredential(ctx context.Context, database tokenStore, entryFingerprint string, payload map[string]any) (map[string]any, bool) {
	stored := strings.TrimSpace(str(payload["token"]))
	if stored == "" {
		// Nothing to serve and nothing to renew — the row cannot authenticate at all.
		return nil, true
	}
	// A refresh token is what the app exchanges itself; it never expires on the lease path.
	if isTidalRefreshToken(stored) || !isTidalAccessExpired(stored) {
		return nil, false
	}
	renewed := tryRefreshTidalToken(ctx, database, payload, entryFingerprint)
	if renewed.token == "" {
		// It NEEDED a refresh and could not get one: the stored token is already dead, so serving it
		// would only make the app 401. Exclude the entry from this lease; the next candidate moves up.
		return nil, true
	}
	// The whole renewed credential, not just the access token: when Tidal rotates the refresh token
	// the one in `payload` is spent, and an app handed that one could never refresh on its own.
	return renewed.payload, false
}

func encodeJSON(v map[string]any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func checkTidalAccount(ctx context.Context, database tokenStore, payload map[string]any, entryFingerprint string) CheckResult {
	token := strings.TrimSpace(str(payload["token"]))
	if token == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing token"}
	}
	headers := func(t string) map[string]string {
		return map[string]string{"authorization": "Bearer " + t, "user-agent": tidalUA}
	}
	// Every refresh below spends the credential the previous one left behind, never the payload the
	// check started with: after a rotation that one holds a spent refresh token, and spending it
	// again reads as a concurrent refresh and leaves a rejected account without a verdict.
	current := payload

	// A refresh token would 401 as a Bearer, so exchange it first rather than spending a round-trip
	// proving that.
	if isTidalRefreshToken(token) {
		exchanged := tryRefreshTidalToken(ctx, database, current, entryFingerprint)
		if exchanged.token == "" {
			return CheckResult{
				Status:  refreshFailureStatus(exchanged),
				Detail:  exchanged.detail,
				Skipped: exchanged.skip,
			}
		}
		token = exchanged.token
		current = exchanged.payload
	}

	// Tidal access tokens live about an hour while the sweep runs every few hours, so a locally
	// expired token is the normal case rather than an error. Renew it up front so every sweep leaves
	// the row with a fresh access token instead of waiting for something to ask for it (mirrors
	// lib/health.ts, where the /sessions 401 path was the only renewal before).
	if isTidalAccessExpired(token) {
		renewed := tryRefreshTidalToken(ctx, database, current, entryFingerprint)
		if renewed.token == "" {
			// The account was never verified, so this is not a failure of the account: report the
			// outage/limiter as pending and let the row keep its previous verdict.
			return CheckResult{
				Status:  refreshFailureStatus(renewed),
				Detail:  renewed.detail,
				Skipped: renewed.skip,
			}
		}
		token = renewed.token
		current = renewed.payload
	}

	started := time.Now()
	res, err := httpx.Get(ctx, "https://api.tidal.com/v1/sessions", headers(token), timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	status := res.StatusCode
	var session struct {
		UserID      int64  `json:"userId"`
		CountryCode string `json:"countryCode"`
	}
	body := ""
	if status != 401 && status != 403 {
		body, _ = httpx.ReadText(res)
	} else {
		_ = res.Body.Close()
	}

	// On 401 — attempt a refresh before giving up.
	if status == 401 {
		refreshed := tryRefreshTidalToken(ctx, database, current, entryFingerprint)
		if refreshed.token == "" {
			return CheckResult{
				Status:    refreshFailureStatus(refreshed),
				LatencyMs: ms,
				Detail:    refreshed.detail,
				Skipped:   refreshed.skip,
			}
		}
		token = refreshed.token
		started = time.Now()
		retry, err := httpx.Get(ctx, "https://api.tidal.com/v1/sessions", headers(token), timeoutMs)
		if err != nil {
			return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
		}
		ms = int(time.Since(started).Milliseconds())
		status = retry.StatusCode
		body, _ = httpx.ReadText(retry)
	}

	if status == 401 || status == 403 {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "token rejected"}
	}
	if status < 200 || status >= 300 {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(status)}
	}

	_ = json.Unmarshal([]byte(body), &session)

	// A valid session implies an active account; hi-res capability is best-effort.
	premium := true
	if session.UserID != 0 && session.CountryCode != "" {
		subURL := "https://api.tidal.com/v1/users/" + strconv.FormatInt(session.UserID, 10) +
			"/subscription?countryCode=" + url.QueryEscape(session.CountryCode)
		if sub, err := httpx.Get(ctx, subURL, headers(token), timeoutMs); err == nil {
			// Only parse 2xx responses; treat error pages as missing entitlement info and stay optimistic
			if sub.StatusCode >= 200 && sub.StatusCode < 300 {
				if text, err := httpx.ReadText(sub); err == nil {
					premium = tidalSubscriptionIsPremium(text)
				}
			}
			sub.Body.Close()
		}
	}
	return CheckResult{OK: true, Premium: premium, Status: classify(true, premium), LatencyMs: ms, Detail: "session ok"}
}

// tidalSubscriptionIsPremium reads Tidal's /users/{id}/subscription body. A keyword scan cannot work
// here: every free account answers "premiumAccess":false, which contains "premium". Unreadable
// bodies stay optimistic so a format change cannot disable the whole pool. Mirrors lib/health.ts.
func tidalSubscriptionIsPremium(body string) bool {
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return true // JSON parse error: stay optimistic
	}

	// premiumAccess as boolean wins if present
	if v, ok := raw["premiumAccess"].(bool); ok {
		return v
	}

	// subscription.type must be exactly "FREE" (case-insensitive comparison)
	if sub, ok := raw["subscription"].(map[string]interface{}); ok {
		if v, ok := sub["type"].(string); ok && strings.EqualFold(v, "FREE") {
			return false
		}
	}

	// highestSoundQuality: only LOSSLESS or HI_RES* count as premium
	if v, ok := raw["highestSoundQuality"].(string); ok && v != "" {
		q := strings.ToUpper(v)
		return q == "LOSSLESS" || strings.HasPrefix(q, "HI_RES")
	}

	return true // Default to optimistic
}

func qobuzHeaders(appID, token string) map[string]string {
	return map[string]string{
		"X-App-Id":          appID,
		"X-User-Auth-Token": token,
		"user-agent":        qobuzUA,
	}
}

// checkQobuzAppSecret signs a track/getFileUrl request exactly as the app does, so a wrong
// app_secret is rejected at submit time instead of failing silently during playback.
func checkQobuzAppSecret(ctx context.Context, appID, appSecret, token string) (bool, string, int) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sum := md5.Sum([]byte("trackgetFileUrlformat_id" + qobuzProbeFormatID + "intentstreamtrack_id" +
		qobuzProbeTrackID + ts + appSecret))
	sig := hex.EncodeToString(sum[:])
	probeURL := "https://www.qobuz.com/api.json/0.2/track/getFileUrl?request_ts=" + ts + "&request_sig=" + sig +
		"&track_id=" + qobuzProbeTrackID + "&format_id=" + qobuzProbeFormatID + "&intent=stream" +
		"&app_id=" + url.QueryEscape(appID) + "&user_auth_token=" + url.QueryEscape(token)

	started := time.Now()
	res, err := httpx.Get(ctx, probeURL, qobuzHeaders(appID, token), timeoutMs)
	if err != nil {
		return false, httpx.Reason(err), 0
	}
	ms := int(time.Since(started).Milliseconds())
	text, _ := httpx.ReadText(res)
	lower := strings.ToLower(text)
	// A bad app_secret yields a signature error (HTTP 400). Everything else (a signed URL, or a
	// plan/geo restriction on this specific track) means the secret itself is valid.
	if strings.Contains(lower, "invalid request signature") || strings.Contains(lower, "invalidrequestsignature") {
		return false, "invalid app_secret", ms
	}
	return true, "secret ok", ms
}

// renewQobuzToken re-logs in with the entry's stored credentials and persists the new
// user_auth_token. Qobuz has no refresh endpoint, so `user/login` is the only renewal there is.
//
// Returns the fresh token, a human-readable detail, and whether the failure was transient
// (skip=true → no verdict, so the next sweep retries instead of the account being dead-marked).
func renewQobuzToken(ctx context.Context, database *db.DB, payload map[string]any, entryFingerprint string) (string, string, bool) {
	email := strings.TrimSpace(str(payload["username"]))
	password := strings.TrimSpace(str(payload["password"]))
	if email == "" || password == "" {
		// Token-only contributions (a legacy one-shot, or one accepted before the site stored the
		// password) can never be renewed. Say so explicitly: the reason is what tells an operator
		// the account has to be re-added.
		return "", "token dead, no stored email/password — auto-renewal impossible, re-add the account", false
	}

	var login oauth.QobuzLoginResult
	failure := ""
	rejectedOnAll := true
	seen := map[string]bool{}
	for _, appID := range []string{strings.TrimSpace(str(payload["appId"])), oauth.QobuzLoginAppID} {
		if appID == "" || seen[appID] {
			continue
		}
		seen[appID] = true
		result, err := oauth.QobuzLogin(ctx, email, password, appID)
		if err == nil {
			login = result
			break
		}
		failure = err.Error()
		low := strings.ToLower(failure)
		// A network throw or a flow change is not a verdict; only the provider naming the
		// credentials as wrong is.
		if !strings.Contains(low, "incorrect") && !strings.Contains(low, "rejected") {
			rejectedOnAll = false
		}
	}
	if login.UserAuthToken == "" {
		return "", "re-login failed: " + failure, !rejectedOnAll
	}

	next := map[string]any{}
	for k, v := range payload {
		next[k] = v
	}
	next["token"] = login.UserAuthToken
	if login.CountryCode != "" {
		next["countryCode"] = login.CountryCode
	}
	if entryFingerprint != "" {
		// The fingerprint derives from the token, so it is rewritten in the same UPDATE: upserting
		// on the new one would duplicate the row and leave the dead entry behind.
		if stored, err := crypto.EncryptAtRest(next); err == nil {
			nextFingerprint := pool.Fingerprint(pool.ServiceQobuz, pool.KindAccount, next)
			if _, err := database.Exec(ctx,
				`update account_entries set payload = $1, fingerprint = $2 where fingerprint = $3`,
				encodeJSON(stored), nextFingerprint, entryFingerprint); err != nil {
				logf("[health] qobuz renewal persist failed: %v", err)
			}
		}
	}
	return login.UserAuthToken, "re-logged in", false
}

func checkQobuzAccount(ctx context.Context, database *db.DB, payload map[string]any, entryFingerprint string) CheckResult {
	token := strings.TrimSpace(str(payload["token"]))
	appID := strings.TrimSpace(str(payload["appId"]))
	appSecret := strings.TrimSpace(str(payload["appSecret"]))
	if token == "" || appID == "" || appSecret == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing token/appId/appSecret"}
	}

	userURL := func(token string) string {
		return "https://www.qobuz.com/api.json/0.2/user/get?app_id=" + url.QueryEscape(appID) +
			"&user_auth_token=" + url.QueryEscape(token)
	}
	started := time.Now()
	res, err := httpx.Get(ctx, userURL(token), qobuzHeaders(appID, token), timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())

	// A rejected token is renewed before any verdict is written: this is the auto-renewal the pool
	// was missing entirely on the Go side.
	if res.StatusCode == 401 || res.StatusCode == 403 {
		_ = res.Body.Close()
		renewed, detail, skip := renewQobuzToken(ctx, database, payload, entryFingerprint)
		if renewed == "" {
			// A transient renewal failure (network, provider 5xx) says nothing about the account, so it
			// is a skip and not a verdict. Skipped must travel with the pending status: a failure the
			// sweep still counts can walk a healthy account up the auto-disable ladder.
			status := pool.StatusDead
			if skip {
				status = pool.StatusPending
			}
			return CheckResult{Status: status, LatencyMs: ms, Detail: detail, Skipped: skip}
		}
		token = renewed
		started = time.Now()
		retry, err := httpx.Get(ctx, userURL(token), qobuzHeaders(appID, token), timeoutMs)
		if err != nil {
			return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
		}
		ms += int(time.Since(started).Milliseconds())
		res = retry
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		status := res.StatusCode
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(status)}
	}
	body, _ := httpx.ReadText(res)
	lower := strings.ToLower(body)
	valid := strings.Contains(lower, `"id"`) || strings.Contains(lower, "credential")
	if !valid {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "invalid user"}
	}
	premium := qobuzPremiumRe.MatchString(lower)
	// The user token is valid; now confirm the app_secret actually signs stream requests, since a
	// token without a working secret cannot resolve any audio in the app.
	secretOK, detail, secretMs := checkQobuzAppSecret(ctx, appID, appSecret, token)
	if !secretOK {
		return CheckResult{Premium: premium, Status: pool.StatusDead, LatencyMs: ms + secretMs, Detail: detail}
	}
	return CheckResult{
		OK:        true,
		Premium:   premium,
		Status:    classify(true, premium),
		LatencyMs: ms + secretMs,
		Detail:    "user + secret ok",
	}
}

var qobuzPremiumRe = regexp.MustCompile(`lossless|hi-res|hires|studio|sublime|"format_id"\s*:\s*(6|7|27)`)

func checkDeezerAccount(ctx context.Context, payload map[string]any) CheckResult {
	arl := strings.TrimSpace(str(payload["arl"]))
	if arl == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing arl"}
	}
	started := time.Now()
	res, err := httpx.Get(ctx, deezerGateway, map[string]string{
		"cookie":     "arl=" + arl,
		"user-agent": deezerUA,
	}, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(res.StatusCode)}
	}

	var body struct {
		Results struct {
			USER struct {
				UserID  int64 `json:"USER_ID"`
				Options struct {
					LicenseToken string          `json:"license_token"`
					WebHQ        bool            `json:"web_hq"`
					WebSoundQual json.RawMessage `json:"web_sound_quality"`
				} `json:"OPTIONS"`
			} `json:"USER"`
			CheckForm string `json:"checkForm"`
		} `json:"results"`
	}
	if err := httpx.ReadJSON(res, &body); err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "invalid response"}
	}

	// An expired or invalid ARL still returns HTTP 200, but with USER_ID 0 and no session token.
	if body.Results.USER.UserID == 0 {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "arl rejected"}
	}
	if strings.TrimSpace(body.Results.USER.Options.LicenseToken) == "" {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "no license_token"}
	}

	// web_sound_quality advertises the formats the plan allows; lossless implies FLAC access.
	lossless := false
	if len(body.Results.USER.Options.WebSoundQual) > 0 {
		var quality struct {
			Lossless bool `json:"lossless"`
		}
		if json.Unmarshal(body.Results.USER.Options.WebSoundQual, &quality) == nil {
			lossless = quality.Lossless
		}
	}
	premium := lossless || body.Results.USER.Options.WebHQ

	detail := "session ok (lossy only)"
	if premium {
		detail = "session ok (lossless)"
	}
	return CheckResult{OK: true, Premium: premium, Status: classify(true, premium), LatencyMs: ms, Detail: detail}
}

// checkAppleMusicAccount reads the account's entitlement with a scraper-supplied dev JWT. A
// Media-User-Token cannot be probed through the public catalog API, so the account endpoint is
// asked directly: `meta.subscription.active` is the flag gamdl gates downloads on, and it is false
// for a signed-in free account even though a storefront still resolves. gamdl carries the
// Media-User-Token as a cookie on this endpoint, so the probe sends it as a header AND a cookie
// rather than betting the entitlement on one carrier.
func checkAppleMusicAccount(ctx context.Context, payload map[string]any) CheckResult {
	token := strings.TrimSpace(str(payload["token"]))
	// Media-User-Tokens always start with "0." — anything else is a paste error.
	if !strings.HasPrefix(token, "0.") {
		return CheckResult{Status: pool.StatusDead, Detail: "missing or invalid media-user-token"}
	}

	devToken := ampDevToken(ctx)
	if devToken == "" {
		// Cannot probe without a dev JWT; report pending rather than dead so a transient scraping
		// failure does not wipe healthy entries from rotation.
		return CheckResult{Status: pool.StatusPending, Detail: "no dev token available"}
	}

	started := time.Now()
	res, err := httpx.Get(ctx, ampBase+"/v1/me/account?meta=subscription", map[string]string{
		"authorization":    "Bearer " + devToken,
		"media-user-token": token,
		"cookie":           "media-user-token=" + token,
		"origin":           "https://music.apple.com",
		"referer":          "https://music.apple.com/",
		"user-agent":       appleUA,
	}, timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusPending, Detail: "probe error: " + httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(res.StatusCode)}
	}
	var meta appleAccountMeta
	if err := httpx.ReadJSON(res, &meta); err != nil {
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "invalid response"}
	}
	premium, detail, known := appleSubscriptionVerdict(meta)
	if !known {
		// Nothing to read an entitlement from: pending rather than dead, so an unrecognised
		// response shape does not wipe healthy entries.
		return CheckResult{Status: pool.StatusPending, LatencyMs: ms, Detail: detail}
	}
	return CheckResult{
		OK:        true,
		Premium:   premium,
		Status:    classify(true, premium),
		LatencyMs: ms,
		Detail:    detail,
	}
}

// appleAccountMeta is the part of `GET /v1/me/account?meta=subscription` the pool reads: the
// entitlement flag, and the storefront that subscription belongs to.
type appleAccountMeta struct {
	Meta struct {
		Subscription struct {
			Active     *bool  `json:"active"`
			Storefront string `json:"storefront"`
		} `json:"subscription"`
	} `json:"meta"`
}

// appleSubscriptionVerdict turns that meta into the pool's verdict, mirroring the meta.subscription
// read in lib/health.ts checkAppleMusicAccount. A signed-in free account still resolves a
// storefront, so `active` — not the storefront — is what decides premium. `known` is false when
// Apple answered with a shape the pool does not recognise.
func appleSubscriptionVerdict(meta appleAccountMeta) (premium bool, detail string, known bool) {
	active := meta.Meta.Subscription.Active
	if active == nil {
		return false, "no subscription info in response", false
	}
	detail = "storefront unknown"
	if storefront := meta.Meta.Subscription.Storefront; storefront != "" {
		detail = "storefront " + storefront
	}
	if !*active {
		detail += " (no active subscription)"
	}
	return *active, detail, true
}

// ampDevToken mirrors the app-side scraper: home page → JS bundle → ES256 JWTs → `iss: AMPWebPlay`.
func ampDevToken(ctx context.Context) string {
	ampTokenMu.Lock()
	defer ampTokenMu.Unlock()

	now := time.Now()
	if ampTokenValue != "" && ampTokenExp-60 > now.Unix() && now.Sub(ampTokenAt) < ampTokenTTL {
		return ampTokenValue
	}

	fallback := func() string { return ampTokenValue }

	res, err := httpx.Get(ctx, appleMusicHome, map[string]string{"user-agent": appleUA}, timeoutMs)
	if err != nil {
		return fallback()
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return fallback()
	}
	html, err := httpx.ReadText(res)
	if err != nil {
		return fallback()
	}
	bundle := ampBundleRe.FindString(html)
	if bundle == "" {
		logf("apple dev token: no web-player bundle script found on music.apple.com")
		return fallback()
	}
	jsRes, err := httpx.Get(ctx, "https://music.apple.com/"+bundle, map[string]string{"user-agent": appleUA}, timeoutMs)
	if err != nil {
		return fallback()
	}
	if jsRes.StatusCode < 200 || jsRes.StatusCode >= 300 {
		_ = jsRes.Body.Close()
		return fallback()
	}
	js, err := httpx.ReadText(jsRes)
	if err != nil {
		return fallback()
	}
	for _, candidate := range ampJWTRe.FindAllString(js, -1) {
		payload, ok := decodeJWTPayload(candidate)
		if !ok {
			continue
		}
		exp := int64(0)
		if v, ok := payload["exp"].(float64); ok {
			exp = int64(v)
		}
		iss, _ := payload["iss"].(string)
		if iss == "AMPWebPlay" && exp-60 > now.Unix() {
			ampTokenValue = candidate
			ampTokenExp = exp
			ampTokenAt = now
			return candidate
		}
	}
	logf("apple dev token: no usable AMPWebPlay JWT in the web-player bundle")
	return fallback()
}

// checkAmazonMusicAccount verifies the shape only: Amazon's Music Web API is approval-gated, so a
// pool deployment cannot ask Amazon whether a session is still good. The real verdict comes from the
// app, which reports a rejected session dead. Do not read `alive` as "Amazon confirmed this works".
func checkAmazonMusicAccount(payload map[string]any) CheckResult {
	session := strings.TrimSpace(str(payload["session"]))
	if session == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing session artifact"}
	}
	if len(session) < 16 {
		return CheckResult{Status: pool.StatusDead, Detail: "session artifact looks truncated"}
	}
	return CheckResult{
		OK:      true,
		Premium: payload["premium"] == true,
		Status:  pool.StatusAlive,
		Detail:  "unverified (shape only) — Amazon's API has no public probe; the app reports failures",
	}
}

// str is `String(value ?? "")` for the JSON scalars payloads carry.
func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case json.Number:
		return x.String()
	}
	return ""
}
