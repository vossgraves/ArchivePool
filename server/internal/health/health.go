// Package health is the live-check and ingestion stack: lib/health.ts (per-service probes),
// lib/health-sweep.ts (full sweep, single re-check, auto-disable), lib/ingest.ts (admission-gated
// upsert), lib/instance-sync.ts plus the monochrome/SpotiFLAC adapters and lib/external-sources.ts.
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
	"archivepool/server/internal/pool"
)

// CheckResult is what a probe reports. Status is the pool status the sweep persists.
type CheckResult struct {
	OK        bool
	Premium   bool
	Status    pool.Status
	LatencyMs int
	Detail    string
}

const (
	timeoutMs = 12 * time.Second

	// Tidal device-flow OAuth client. The previous registration (zU4XHVVkc2tDPo4t) was retired:
	// tokens it minted carry internal cid 3235 and now fail refresh with "Client id 3235 not
	// found" (natom/streamrip#897, #901; replaced by #932). This is streamrip v2.2.0's client.
	tidalClientID     = "fX2JxdmntZWK0ixT"
	tidalClientSecret = "1Nm5AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg="
	tidalTokenURL     = "https://auth.tidal.com/v1/oauth2/token"
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
		// against those rather than through the generic reachability rule.
		if service == pool.ServiceDeezer {
			return checkDeezerInstance(ctx, payload)
		}
		if service == pool.ServiceAmazonMusic {
			return checkAmazonMusicInstance(ctx, payload)
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
		return checkQobuzAccount(ctx, payload)
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

// tryRefreshTidalToken exchanges a refresh token for a fresh access token and writes it back, so
// later checks use the new one.
func tryRefreshTidalToken(ctx context.Context, database *db.DB, payload map[string]any, entryFingerprint string) string {
	// Contributors are handed a single value labelled "Token" which is in fact the refresh token, so
	// fall back to it when no separate refreshToken was supplied.
	refreshToken := strings.TrimSpace(str(payload["refreshToken"]))
	if refreshToken == "" {
		refreshToken = strings.TrimSpace(str(payload["token"]))
	}
	if refreshToken == "" {
		return ""
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
			"client_id":     {tidalClientID},
			"client_secret": {tidalClientSecret},
			"refresh_token": {refreshToken},
			"grant_type":    {"refresh_token"},
			"scope":         {scope},
		}
		res, err := httpx.PostForm(ctx, tidalTokenURL, map[string]string{"user-agent": tidalUA}, form, timeoutMs)
		if err != nil {
			return ""
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			if err := httpx.ReadJSON(res, &body); err != nil {
				return ""
			}
			ok = true
			break
		}
		var oauthErr struct {
			Error string `json:"error"`
		}
		_ = httpx.ReadJSON(res, &oauthErr)
		// Only a scope rejection is worth retrying; anything else (bad token, revoked) fails both.
		if oauthErr.Error != "invalid_scope" {
			return ""
		}
	}
	if !ok || body.AccessToken == "" {
		return ""
	}

	// Persist the refreshed token so it does not expire again on the next cycle. Best-effort: a
	// database error must not fail the health check.
	if entryFingerprint != "" {
		next := map[string]any{}
		for k, v := range payload {
			next[k] = v
		}
		next["token"] = body.AccessToken
		if body.RefreshToken != "" {
			next["refreshToken"] = body.RefreshToken
		}
		if stored, err := crypto.EncryptAtRest(next); err == nil {
			_, _ = database.Exec(ctx, `update account_entries set payload = $1 where fingerprint = $2`,
				encodeJSON(stored), entryFingerprint)
		}
	}
	return body.AccessToken
}

func encodeJSON(v map[string]any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func checkTidalAccount(ctx context.Context, database *db.DB, payload map[string]any, entryFingerprint string) CheckResult {
	token := strings.TrimSpace(str(payload["token"]))
	if token == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing token"}
	}
	headers := func(t string) map[string]string {
		return map[string]string{"authorization": "Bearer " + t, "user-agent": tidalUA}
	}

	// A refresh token would 401 as a Bearer, so exchange it first rather than spending a round-trip
	// proving that.
	if isTidalRefreshToken(token) {
		exchanged := tryRefreshTidalToken(ctx, database, payload, entryFingerprint)
		if exchanged == "" {
			return CheckResult{Status: pool.StatusDead, Detail: "refresh token rejected"}
		}
		token = exchanged
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
		if refreshed := tryRefreshTidalToken(ctx, database, payload, entryFingerprint); refreshed != "" {
			token = refreshed
			started = time.Now()
			retry, err := httpx.Get(ctx, "https://api.tidal.com/v1/sessions", headers(token), timeoutMs)
			if err != nil {
				return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
			}
			ms = int(time.Since(started).Milliseconds())
			status = retry.StatusCode
			body, _ = httpx.ReadText(retry)
		}
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
			if text, err := httpx.ReadText(sub); err == nil {
				premium = tidalPremiumRe.MatchString(strings.ToLower(text))
			}
		}
	}
	return CheckResult{OK: true, Premium: premium, Status: classify(true, premium), LatencyMs: ms, Detail: "session ok"}
}

var tidalPremiumRe = regexp.MustCompile(`hi_res|hires|lossless|premium|hifi`)

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

func checkQobuzAccount(ctx context.Context, payload map[string]any) CheckResult {
	token := strings.TrimSpace(str(payload["token"]))
	appID := strings.TrimSpace(str(payload["appId"]))
	appSecret := strings.TrimSpace(str(payload["appSecret"]))
	if token == "" || appID == "" || appSecret == "" {
		return CheckResult{Status: pool.StatusDead, Detail: "missing token/appId/appSecret"}
	}

	userURL := "https://www.qobuz.com/api.json/0.2/user/get?app_id=" + url.QueryEscape(appID) +
		"&user_auth_token=" + url.QueryEscape(token)
	started := time.Now()
	res, err := httpx.Get(ctx, userURL, qobuzHeaders(appID, token), timeoutMs)
	if err != nil {
		return CheckResult{Status: pool.StatusDead, Detail: httpx.Reason(err)}
	}
	ms := int(time.Since(started).Milliseconds())
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return CheckResult{Status: pool.StatusDead, LatencyMs: ms, Detail: "HTTP " + strconv.Itoa(res.StatusCode)}
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
