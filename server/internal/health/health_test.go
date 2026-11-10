// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"archivepool/server/internal/pool"
)

// TestCheckAmazonMusicAccount: Amazon's Music Web API is approval-gated, so the pool can only verify
// the artifact's shape. Pin the rules the app-side contract depends on.
func TestCheckAmazonMusicAccount(t *testing.T) {
	cases := []struct {
		name        string
		payload     map[string]any
		wantOK      bool
		wantPremium bool
		wantDetail  string
	}{
		{"missing artifact", map[string]any{}, false, false, "missing session artifact"},
		{"truncated artifact", map[string]any{"session": "tooshort"}, false, false, "session artifact looks truncated"},
		{"well-formed, free tier", map[string]any{"session": "0123456789abcdef0123"}, true, false, "unverified"},
		{"well-formed, premium", map[string]any{"session": "0123456789abcdef0123", "premium": true}, true, true, "unverified"},
		// `premium` must be a real boolean: the string "true" is not what the submit form stores.
		{"premium as a string", map[string]any{"session": "0123456789abcdef0123", "premium": "true"}, true, false, "unverified"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := checkAmazonMusicAccount(tc.payload)
			if result.OK != tc.wantOK || result.Premium != tc.wantPremium {
				t.Fatalf("ok=%v premium=%v, want ok=%v premium=%v", result.OK, result.Premium, tc.wantOK, tc.wantPremium)
			}
			if !strings.Contains(result.Detail, tc.wantDetail) {
				t.Fatalf("detail = %q, want it to contain %q", result.Detail, tc.wantDetail)
			}
			if result.OK && result.Status != pool.StatusAlive {
				t.Fatalf("a well-formed artifact is reported alive, got %s", result.Status)
			}
			if !result.OK && result.Status != pool.StatusDead {
				t.Fatalf("a malformed artifact is reported dead, got %s", result.Status)
			}
		})
	}
}

// TestCheckAmazonMusicInstance pins the instance-tier rules the app's contract depends on: the
// liveness verdict comes from the instance's own JSON health document (HTTP 2xx and a `status`
// that is not an error), and premium still comes from the shared hi-res markers.
func TestCheckAmazonMusicInstance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := map[string]struct {
			status int
			body   string
		}{
			"/health":           {200, `{"status":"ok","service":"amazon-music"}`},
			"/ok/health":        {200, `{"status":"ok"}`},
			"/lossless/health":  {200, `{"status":"ok","quality":"lossless"}`},
			"/degraded/health":  {200, `{"status":"error","detail":"backend down"}`},
			"/unhealthy/health": {200, `{"status":"UNHEALTHY"}`},
			"/plain/health":     {200, `not json at all`},
			"/nodoc/health":     {200, `{"service":"amazon-music"}`},
			"/scalar/health":    {200, `123`},
			"/served/health":    {404, `{"status":"ok"}`},
			"/down/health":      {500, `{"status":"ok"}`},
			"/custom/status":    {200, `{"status":"ok","codecs":["flac"]}`},
			"/probe":            {200, `Hi-res FLAC 24bit available`},
			"/ok/probe":         {200, `flac`},
			"/lossyprobe":       {200, `mp3 320 only`},
		}[r.URL.Path]
		if !ok {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(body.status)
		_, _ = w.Write([]byte(body.body))
	}))
	defer srv.Close()

	cases := []struct {
		name        string
		payload     map[string]any
		wantOK      bool
		wantPremium bool
		wantStatus  pool.Status
		wantDetail  string
	}{
		{"missing base URL", map[string]any{}, false, false, pool.StatusDead, "missing baseUrl"},
		{"health answers 200 with ok", map[string]any{"baseUrl": srv.URL}, true, false, pool.StatusPreview, "HTTP 200"},
		{"health advertises lossless", map[string]any{"baseUrl": srv.URL + "/lossless"}, true, true, pool.StatusAlive, "HTTP 200"},
		{"status names an error", map[string]any{"baseUrl": srv.URL + "/degraded"}, false, false, pool.StatusDead, "status: error"},
		{"status matching is case-insensitive", map[string]any{"baseUrl": srv.URL + "/unhealthy"}, false, false, pool.StatusDead, "status: UNHEALTHY"},
		{"body is not JSON", map[string]any{"baseUrl": srv.URL + "/plain"}, false, false, pool.StatusDead, "not JSON"},
		{"body has no status field", map[string]any{"baseUrl": srv.URL + "/nodoc"}, false, false, pool.StatusDead, "no status"},
		{"body is a JSON scalar", map[string]any{"baseUrl": srv.URL + "/scalar"}, false, false, pool.StatusDead, "no status"},
		// The generic rule would call a 404 "alive"; an Amazon instance has to say so itself.
		{"health answers 404", map[string]any{"baseUrl": srv.URL + "/served"}, false, false, pool.StatusDead, "HTTP 404"},
		{"health answers 500", map[string]any{"baseUrl": srv.URL + "/down"}, false, false, pool.StatusDead, "HTTP 500"},
		// A custom path is joined the same way as every other instance, with or without the slash.
		{"custom health path without a slash", map[string]any{"baseUrl": srv.URL + "/custom", "healthPath": "status"}, true, true, pool.StatusAlive, "HTTP 200"},
		{"custom health path with a slash", map[string]any{"baseUrl": srv.URL + "/custom", "healthPath": "/status"}, true, true, pool.StatusAlive, "HTTP 200"},
		// probeUrl replaces the health body as the capability signal, so a lossy probe wins.
		{"probe overrides a lossless health body", map[string]any{"baseUrl": srv.URL + "/lossless", "probeUrl": "/lossyprobe"}, true, false, pool.StatusPreview, "HTTP 200"},
		{"relative probe URL is joined onto the base URL", map[string]any{"baseUrl": srv.URL, "probeUrl": "/probe"}, true, true, pool.StatusAlive, "HTTP 200"},
		{"relative probe without a slash joins onto the base path", map[string]any{"baseUrl": srv.URL + "/ok", "probeUrl": "probe"}, true, true, pool.StatusAlive, "HTTP 200"},
		{"absolute probe URL is used as given", map[string]any{"baseUrl": srv.URL + "/ok", "probeUrl": srv.URL + "/probe?track=1"}, true, true, pool.StatusAlive, "HTTP 200"},
		{"instance with an ok health body and no probe stays preview", map[string]any{"baseUrl": srv.URL + "/ok"}, true, false, pool.StatusPreview, "HTTP 200"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := checkAmazonMusicInstance(context.Background(), tc.payload)
			if result.OK != tc.wantOK || result.Premium != tc.wantPremium {
				t.Fatalf("ok=%v premium=%v, want ok=%v premium=%v", result.OK, result.Premium, tc.wantOK, tc.wantPremium)
			}
			if result.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s", result.Status, tc.wantStatus)
			}
			if !strings.Contains(result.Detail, tc.wantDetail) {
				t.Fatalf("detail = %q, want it to contain %q", result.Detail, tc.wantDetail)
			}
		})
	}
}

// TestRunCheckRoutesEachServiceToItsOwnProbe guards the dispatch: a service with its own dialect
// must not fall through to the generic reachability rule, which would accept the same 200 body.
//
// This is the dispatch that kept the pool's Tidal tier empty: a Tidal instance's root answers
// `{"version","Repo"}`, so the generic rule judged it reachable-but-not-premium and the premium gate
// rejected every healthy instance. Tidal rows must therefore reach the track probe, and a root body
// alone must never be a pass.
func TestRunCheckRoutesEachServiceToItsOwnProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"error"}`))
	}))
	defer srv.Close()

	result := RunCheck(context.Background(), nil, pool.ServiceAmazonMusic, pool.KindAPI, map[string]any{"baseUrl": srv.URL}, "")
	if result.OK || result.Status != pool.StatusDead {
		t.Fatalf("Amazon instance probe not used: ok=%v status=%s", result.OK, result.Status)
	}

	// The same body on a Tidal row is not a verdict either: its root is not what gets probed, and a
	// non-Tidal document proves nothing about streaming, so the row is dead until a manifest appears.
	tidal := RunCheck(context.Background(), nil, pool.ServiceTidal, pool.KindAPI, map[string]any{"baseUrl": srv.URL}, "")
	if tidal.OK || tidal.Status != pool.StatusDead {
		t.Fatalf("tidal instances must be probed by track, not by root reachability: %#v", tidal)
	}
}

// tidalRoute is one path an instance answers, as a status plus body.
type tidalRoute struct {
	status int
	body   string
}

// tidalProbeHarness serves one instance's routes and records every request, so a case can assert
// both the verdict and the exact probe the verdict was derived from.
func tidalProbeHarness(t *testing.T, routes map[string]tidalRoute) (*httptest.Server, func() []string, func() []string) {
	t.Helper()
	var mu sync.Mutex
	requests := []string{}
	userAgents := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.URL.Path+"?"+r.URL.RawQuery)
		userAgents = append(userAgents, r.Header.Get("User-Agent"))
		mu.Unlock()
		route, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(route.status)
		_, _ = w.Write([]byte(route.body))
	}))
	t.Cleanup(srv.Close)
	return srv,
		func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, requests...) },
		func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, userAgents...) }
}

// TestCheckTidalInstance pins the probe that decides Tidal instance admission: the two dialects the
// app itself verifies (TidalAudioProvider.verifyInstance/probeTrackManifestsDialect), the verdicts
// they map to, and the fact that a rate limiter is not a verdict.
func TestCheckTidalInstance(t *testing.T) {
	manifestRoute := "/trackManifests/"
	trackRoute := "/track/"

	cases := []struct {
		name        string
		routes      map[string]tidalRoute
		wantOK      bool
		wantPremium bool
		wantStatus  pool.Status
		wantSkipped bool
		wantDetail  string
		wantPaths   []string
	}{
		{
			name: "manifest dialect reports a full stream",
			routes: map[string]tidalRoute{
				manifestRoute: {200, `{"data":{"data":{"attributes":{"trackPresentation":"FULL","assetPresentation":"FULL"}}}}`},
			},
			wantOK: true, wantPremium: true, wantStatus: pool.StatusAlive,
			wantDetail: "trackManifests FULL", wantPaths: []string{manifestRoute},
		},
		{
			// monochrome's own build reads the flatter nesting; the probe accepts both.
			name: "manifest dialect accepts the flat nesting",
			routes: map[string]tidalRoute{
				manifestRoute: {200, `{"data":{"attributes":{"assetPresentation":"FULL"}}}`},
			},
			wantOK: true, wantPremium: true, wantStatus: pool.StatusAlive,
			wantDetail: "trackManifests FULL", wantPaths: []string{manifestRoute},
		},
		{
			name: "preview presentation means a backing account without a subscription",
			routes: map[string]tidalRoute{
				manifestRoute: {200, `{"data":{"data":{"attributes":{"trackPresentation":"PREVIEW"}}}}`},
			},
			wantOK: true, wantPremium: false, wantStatus: pool.StatusPreview,
			wantDetail: "trackManifests PREVIEW", wantPaths: []string{manifestRoute},
		},
		{
			// The old probe's exact failure: a 200 that says nothing about streaming must not pass.
			name: "a body without a manifest document is not a pass",
			routes: map[string]tidalRoute{
				manifestRoute: {200, `{"version":"3.5","Repo":"https://github.com/binimum/hifi-api"}`},
			},
			wantOK: false, wantPremium: false, wantStatus: pool.StatusDead,
			wantDetail: "without a manifest document", wantPaths: []string{manifestRoute},
		},
		{
			name: "429 is rate limiting, not a verdict",
			routes: map[string]tidalRoute{
				manifestRoute: {429, `{"detail":"Too Many Requests"}`},
			},
			wantOK: false, wantPremium: false, wantStatus: pool.StatusPending, wantSkipped: true,
			wantDetail: "429", wantPaths: []string{manifestRoute},
		},
		{
			name: "a missing manifest route falls back to the 2.x track route",
			routes: map[string]tidalRoute{
				trackRoute: {200, `{"data":{"assetPresentation":"LOSSLESS","manifest":"bWFuaWZlc3Q="}}`},
			},
			wantOK: true, wantPremium: true, wantStatus: pool.StatusAlive,
			wantDetail: "track LOSSLESS", wantPaths: []string{manifestRoute, trackRoute},
		},
		{
			name: "2.x preview is reachable but not premium",
			routes: map[string]tidalRoute{
				trackRoute: {200, `{"data":{"assetPresentation":"PREVIEW","manifest":"bWFuaWZlc3Q="}}`},
			},
			wantOK: true, wantPremium: false, wantStatus: pool.StatusPreview,
			wantDetail: "track PREVIEW", wantPaths: []string{manifestRoute, trackRoute},
		},
		{
			// Reachable, but it has no manifest to serve — what a dead backing account answers.
			name: "2.x answer without a manifest is not a pass",
			routes: map[string]tidalRoute{
				trackRoute: {200, `{"data":{"assetPresentation":"LOSSLESS","manifest":""}}`},
			},
			wantOK: false, wantPremium: false, wantStatus: pool.StatusDead,
			wantDetail: "served no manifest", wantPaths: []string{manifestRoute, trackRoute},
		},
		{
			name: "429 on the fallback route is rate limiting too",
			routes: map[string]tidalRoute{
				trackRoute: {429, `{"detail":"Too Many Requests"}`},
			},
			wantOK: false, wantPremium: false, wantStatus: pool.StatusPending, wantSkipped: true,
			wantDetail: "429", wantPaths: []string{manifestRoute, trackRoute},
		},
		{
			// A 500 is the instance itself not serving; the older endpoint would say the same, so the
			// probe must not spend a second fetch asking it.
			name: "a server error on the manifest route does not fall back",
			routes: map[string]tidalRoute{
				manifestRoute: {500, `{"detail":"backend down"}`},
				trackRoute:    {200, `{"data":{"assetPresentation":"LOSSLESS","manifest":"bWFuaWZlc3Q="}}`},
			},
			wantOK: false, wantPremium: false, wantStatus: pool.StatusDead,
			wantDetail: "trackManifests HTTP 500", wantPaths: []string{manifestRoute},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests, userAgents := tidalProbeHarness(t, tc.routes)
			result := checkTidalInstance(context.Background(), map[string]any{"baseUrl": srv.URL})

			if result.OK != tc.wantOK || result.Premium != tc.wantPremium || result.Status != tc.wantStatus {
				t.Fatalf("ok=%v premium=%v status=%s, want ok=%v premium=%v status=%s (%s)",
					result.OK, result.Premium, result.Status, tc.wantOK, tc.wantPremium, tc.wantStatus, result.Detail)
			}
			if result.Skipped != tc.wantSkipped {
				t.Fatalf("skipped=%v, want %v", result.Skipped, tc.wantSkipped)
			}
			if !strings.Contains(result.Detail, tc.wantDetail) {
				t.Fatalf("detail = %q, want it to contain %q", result.Detail, tc.wantDetail)
			}

			// The request itself is part of the contract: the trailing slash is load-bearing (the
			// slashless form 307s and some instances answer 404 on the redirect), the query has to
			// carry a real track and the FLAC format, and the UA must be the app's.
			got := requests()
			if len(got) != len(tc.wantPaths) {
				t.Fatalf("probed %v, want %v", got, tc.wantPaths)
			}
			for i, path := range tc.wantPaths {
				if !strings.HasPrefix(got[i], path+"?") {
					t.Fatalf("probe %d = %q, want it to start with %q", i, got[i], path+"?")
				}
				if !strings.Contains(got[i], "id="+tidalProbeTrackID) {
					t.Fatalf("probe %d = %q, want it to carry a real track id (%s)", i, got[i], tidalProbeTrackID)
				}
			}
			for i, ua := range userAgents() {
				if ua != tidalInstanceUA {
					t.Fatalf("probe %d sent User-Agent %q, want %q", i, ua, tidalInstanceUA)
				}
			}
		})
	}

	t.Run("manifest route carries the formats the app asks for", func(t *testing.T) {
		srv, requests, _ := tidalProbeHarness(t, map[string]tidalRoute{
			"/trackManifests/": {200, `{"data":{"data":{"attributes":{"trackPresentation":"FULL"}}}}`},
		})
		checkTidalInstance(context.Background(), map[string]any{"baseUrl": srv.URL})
		got := requests()
		if len(got) != 1 {
			t.Fatalf("probed %v, want exactly the manifest route", got)
		}
		for _, want := range []string{"formats=FLAC", "adaptive=false", "manifestType=MPEG_DASH", "uriScheme=HTTPS", "usage=PLAYBACK"} {
			if !strings.Contains(got[0], want) {
				t.Fatalf("probe %q is missing %q", got[0], want)
			}
		}
	})

	t.Run("missing base url", func(t *testing.T) {
		result := checkTidalInstance(context.Background(), map[string]any{})
		if result.OK || result.Status != pool.StatusDead || !strings.Contains(result.Detail, "missing baseUrl") {
			t.Fatalf("got %#v, want a dead result naming the missing base URL", result)
		}
	})

	t.Run("a configured probe track overrides the default", func(t *testing.T) {
		srv, requests, _ := tidalProbeHarness(t, map[string]tidalRoute{
			"/trackManifests/": {200, `{"data":{"data":{"attributes":{"trackPresentation":"FULL"}}}}`},
		})
		checkTidalInstance(context.Background(), map[string]any{"baseUrl": srv.URL, "probeTrackId": "999"})
		got := requests()
		if len(got) != 1 || !strings.Contains(got[0], "id=999") {
			t.Fatalf("probed %v, want the configured track", got)
		}
	})
}

// TestDescribeSaveError covers the configuration diagnosis every save path shows a contributor. These
// strings are user-facing, so they are pinned.
func TestDescribeSaveError(t *testing.T) {
	cases := []struct {
		name        string
		databaseURL string
		err         error
		want        string
	}{
		{
			"no DATABASE_URL is reported first",
			"",
			errors.New("whatever"),
			"The server has no DATABASE_URL set. Add your database connection string in the host's environment variables.",
		},
		{
			"missing relation",
			"postgres://x",
			errors.New(`error: relation "account_entries" does not exist`),
			"The database has no tables yet. Run scripts/schema.sql against it once, then try again.",
		},
		{
			"missing legacy relation",
			"postgres://x",
			errors.New(`relation "source_entries" does not exist`),
			"The database has no tables yet. Run scripts/schema.sql against it once, then try again.",
		},
		{
			"missing unique constraint",
			"postgres://x",
			errors.New("there is no unique or exclusion constraint matching the ON CONFLICT specification"),
			"The database schema is out of date (missing the fingerprint unique constraint). Re-run scripts/schema.sql.",
		},
		{
			"unreachable database",
			"postgres://x",
			errors.New(`dial tcp 10.0.0.1:5432: connect: connection refused`),
			"Could not reach the database. Check that DATABASE_URL is correct and the database is reachable from the host.",
		},
		{
			"anything else falls back to the generic message",
			"postgres://x",
			errors.New("some unexpected failure"),
			"Could not save to the database. Check the server logs for the underlying error.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DescribeSaveError(tc.databaseURL, tc.err); got != tc.want {
				t.Fatalf("DescribeSaveError = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestAppleSubscriptionVerdict pins the entitlement rule the admission policy depends on: a
// Media-User-Token that resolves a storefront is not on its own proof of a paid plan, so only
// meta.subscription.active may report premium. An answer the pool cannot read must stay pending —
// reporting dead there would wipe healthy entries on a shape change.
func TestAppleSubscriptionVerdict(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantKnown   bool
		wantPremium bool
		wantStatus  pool.Status
		wantDetail  string
	}{
		{
			"an active subscription is premium",
			`{"meta":{"subscription":{"active":true,"storefront":"us"}}}`,
			true, true, pool.StatusAlive, "storefront us",
		},
		{
			"a free account that still resolves a storefront is not premium",
			`{"meta":{"subscription":{"active":false,"storefront":"gb"}}}`,
			true, false, pool.StatusPreview, "storefront gb (no active subscription)",
		},
		{
			"an entitlement with no storefront still reports the plan",
			`{"meta":{"subscription":{"active":true}}}`,
			true, true, pool.StatusAlive, "storefront unknown",
		},
		{
			"a storefront-only response has no entitlement to read",
			`{"data":[{"id":"us","attributes":{"name":"United States"}}]}`,
			false, false, pool.StatusPending, "no subscription info in response",
		},
		{
			"an empty subscription object is not an inactive plan",
			`{"meta":{"subscription":{}}}`,
			false, false, pool.StatusPending, "no subscription info in response",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var meta appleAccountMeta
			if err := json.Unmarshal([]byte(tc.body), &meta); err != nil {
				t.Fatalf("decoding %s: %v", tc.body, err)
			}
			premium, detail, known := appleSubscriptionVerdict(meta)
			if known != tc.wantKnown {
				t.Fatalf("known = %v, want %v", known, tc.wantKnown)
			}
			if detail != tc.wantDetail {
				t.Fatalf("detail = %q, want %q", detail, tc.wantDetail)
			}
			if !known {
				return
			}
			if premium != tc.wantPremium {
				t.Fatalf("premium = %v, want %v", premium, tc.wantPremium)
			}
			if got := classify(true, premium); got != tc.wantStatus {
				t.Fatalf("status = %s, want %s", got, tc.wantStatus)
			}
		})
	}
}

// TestCheckAppleMusicAccountRejectsNonToken guards the short-circuit that runs before any outbound
// call: Media-User-Tokens always start with "0.", so anything else is a paste error.
func TestCheckAppleMusicAccountRejectsNonToken(t *testing.T) {
	result := checkAppleMusicAccount(context.Background(), map[string]any{"token": "not-a-media-user-token"})
	if result.OK || result.Premium || result.Status != pool.StatusDead {
		t.Fatalf("a malformed token must be dead without probing: %#v", result)
	}
}
