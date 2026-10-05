// SPDX-License-Identifier: GPL-3.0-or-later
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/config"
	"archivepool/server/internal/db"
)

// newTestServer builds a Server with no database: every handler that needs one fails closed, which is
// enough to pin the routing and the responses that are decided before any query runs.
func newTestServer() *Server {
	return New(&config.Config{Port: "0", NodeEnv: "test"}, db.Unconfigured(), nil)
}

// TestRoutingFallbacks pins the Next-compatible fallbacks: an unknown /api path and a known path with
// the wrong method both answer with an EMPTY body, and a trailing slash redirects.
func TestRoutingFallbacks(t *testing.T) {
	handler := newTestServer().Handler()

	t.Run("unknown path is 404 with no body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if body := rec.Body.String(); body != "" {
			t.Fatalf("body = %q, want empty", body)
		}
	})

	t.Run("method mismatch is 405 with no body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/status", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
		if body := rec.Body.String(); body != "" {
			t.Fatalf("body = %q, want empty", body)
		}
	})

	t.Run("trailing slash redirects", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/keys/", nil))
		if rec.Code != http.StatusPermanentRedirect {
			t.Fatalf("status = %d, want 308", rec.Code)
		}
		if got := rec.Header().Get("location"); got != "/api/keys" {
			t.Fatalf("location = %q, want /api/keys", got)
		}
	})

	t.Run("redirect keeps the query string", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/keys/?delete=1", nil))
		if got := rec.Header().Get("location"); got != "/api/keys?delete=1" {
			t.Fatalf("location = %q", got)
		}
	})
}

// TestInstancesUnknownServiceIsAJSON404 guards the one route whose 404 body is meaningful: the
// router's fallback must not swallow it.
func TestInstancesUnknownServiceIsAJSON404(t *testing.T) {
	handler := newTestServer().Handler()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/instances/bogus", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("content-type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	want := `{"streaming":[],"api":[],"error":"unknown service"}`
	if body := strings.TrimSpace(rec.Body.String()); body != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

// TestPathParameterCapture covers the two-segment routes that carry an id.
func TestPathParameterCapture(t *testing.T) {
	r := &Router{}
	var gotID string
	r.Handle(http.MethodPost, "/api/requests/{id}/claim", func(w http.ResponseWriter, req *http.Request) {
		gotID = pathParam(req, "id")
		w.WriteHeader(http.StatusNoContent)
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/requests/17/claim", nil))
	if gotID != "17" {
		t.Fatalf("captured id = %q, want 17", gotID)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/requests/17/claim/extra", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("a longer path must not match: %d", rec.Code)
	}
}

// TestJSONKeyOrderMatchesTypeScript: Go marshals maps alphabetically, so every response body is built
// from structs. These assertions pin the order the TS object literals produce.
func TestJSONKeyOrderMatchesTypeScript(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{
			"error envelope",
			errJSON("unauthorized", "A valid API key is required to read the source pool. Create an account and request one on the site."),
			`{"error":"unauthorized","detail":"A valid API key is required to read the source pool. Create an account and request one on the site."}`,
		},
		{"error without detail", errBody{Error: "unauthorized"}, `{"error":"unauthorized"}`},
		{"ok/deleted", struct {
			OK      bool `json:"ok"`
			Deleted bool `json:"deleted"`
		}{true, true}, `{"ok":true,"deleted":true}`},
		{"accounts feed envelope", accountsResponse{Version: "2"}, `{"version":"2","generatedAt":"","encrypted":false,"encryption":"","tidal":{"accounts":null},"qobuz":{"accounts":null},"deezer":{"accounts":null},"apple-music":{"accounts":null},"amazon-music":{"accounts":null}}`},
		{"submit state", SubmitState{OK: true, Message: "added"}, `{"ok":true,"message":"added"}`},
		{"submit state with the optional fields", func() SubmitState {
			status, premium := "alive", true
			credited := &optString{Value: nil}
			return SubmitState{OK: true, Message: "m", Status: &status, Premium: &premium, CreditedTo: credited}
		}(), `{"ok":true,"message":"m","status":"alive","premium":true,"creditedTo":null}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(jsonBody(tc.in)); got != tc.want {
				t.Fatalf("body mismatch\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// TestJSONDoesNotEscapeHTML mirrors NextResponse.json, which uses JSON.stringify: `<`, `>` and `&`
// stay literal in the response body.
func TestJSONDoesNotEscapeHTML(t *testing.T) {
	got := string(jsonBody(map[string]string{"detail": "keys & tokens <hidden>"}))
	if !strings.Contains(got, "keys & tokens <hidden>") {
		t.Fatalf("HTML escaping must be disabled, got %s", got)
	}
}

// TestTooManyRequestsShape pins the 429 body and its headers.
func TestTooManyRequestsShape(t *testing.T) {
	rec := httptest.NewRecorder()
	tooManyRequests(rec, 42, "feed")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("retry-after"); got != "42" {
		t.Fatalf("retry-after = %q", got)
	}
	if got := rec.Header().Get("cache-control"); got != "private, no-store" {
		t.Fatalf("cache-control = %q", got)
	}
	want := `{"error":"rate_limited","detail":"Too many feed requests. Retry shortly."}`
	if body := strings.TrimSpace(rec.Body.String()); body != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

// TestCronRoutesRequireAuthorization: without CRON_SECRET or an admin token every cron call is 401.
func TestCronRoutesRequireAuthorization(t *testing.T) {
	t.Setenv("CRON_SECRET", "")
	t.Setenv("ADMIN_TOKEN", "")
	t.Setenv("ADMIN_TOKEN_HASH", "")
	handler := newTestServer().Handler()

	for _, path := range []string{"/api/cron/health", "/api/cron/monochrome"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", path, rec.Code)
		}
		if body := strings.TrimSpace(rec.Body.String()); body != `{"error":"unauthorized"}` {
			t.Fatalf("%s: body = %s", path, body)
		}
	}
}

// TestEveryDocumentedRouteIsRegistered fails if a route disappears from the router, which is the
// cheapest guard against a silent cutover regression.
func TestEveryDocumentedRouteIsRegistered(t *testing.T) {
	want := []struct{ method, pattern string }{
		{"GET", "/api/sources"},
		{"GET", "/api/accounts"},
		{"GET", "/api/instances/{service}"},
		{"GET", "/api/discovery/tidal"},
		{"GET", "/api/discovery/qobuz"},
		{"GET", "/api/status"},
		{"POST", "/api/report"},
		{"GET", "/api/cron/health"},
		{"GET", "/api/cron/monochrome"},
		{"POST", "/api/auth/signup"},
		{"POST", "/api/auth/login"},
		{"POST", "/api/auth/logout"},
		{"GET", "/api/auth/me"},
		{"GET", "/api/keys"},
		{"POST", "/api/keys"},
		{"DELETE", "/api/keys/{id}"},
		{"POST", "/api/requests/{id}/claim"},
		{"GET", "/api/admin/keys"},
		{"POST", "/api/admin/keys"},
		{"PATCH", "/api/admin/keys"},
		{"DELETE", "/api/admin/keys/{id}"},
		{"POST", "/api/admin/keys/custom"},
		{"GET", "/api/admin/requests"},
		{"POST", "/api/admin/requests/{id}"},
		{"GET", "/api/admin/users"},
		{"PATCH", "/api/admin/users"},
		{"GET", "/api/admin/audit"},
		{"GET", "/api/admin/remove"},
		{"POST", "/api/admin/remove"},
		{"POST", "/api/admin/purge-dead"},
		{"POST", "/api/admin/check-entry"},
		{"POST", "/api/admin/force-check"},
		{"POST", "/api/tidal/device/start"},
		{"POST", "/api/tidal/device/poll"},
		{"POST", "/api/qobuz/login"},
		{"POST", "/api/submit"},
	}
	router := newTestServer().Handler().(*Router)
	registered := map[string]bool{}
	for _, rt := range router.routes {
		key := rt.method + " " + "/" + strings.Join(rt.segments, "/")
		registered[key] = true
	}
	for _, route := range want {
		if !registered[route.method+" "+route.pattern] {
			t.Errorf("route %s %s is not registered", route.method, route.pattern)
		}
	}
	if len(registered) != len(want) {
		t.Errorf("router has %d routes, checklist documents %d", len(registered), len(want))
	}
}

// TestHeadUsesTheGetHandler mirrors Next's behaviour for HEAD requests; net/http discards the body.
func TestHeadUsesTheGetHandler(t *testing.T) {
	r := &Router{}
	called := false
	r.Handle(http.MethodGet, "/api/status", func(w http.ResponseWriter, req *http.Request) {
		called = true
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/api/status", nil))
	if !called {
		t.Fatal("a HEAD request must reach the GET handler")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

// TestJSNumbersMatchJavaScript pins Number() coercion, which the routes inherit from expressions like
// `Number(body.userId)` and `Number(body.id ?? 0) || null`.
func TestJSNumbersMatchJavaScript(t *testing.T) {
	cases := []struct {
		raw    string
		value  float64
		finite bool
	}{
		{``, 0, false},        // absent -> Number(undefined) -> NaN
		{`null`, 0, true},     // Number(null) === 0
		{`true`, 1, true},     //
		{`false`, 0, true},    //
		{`12`, 12, true},      //
		{`-3.5`, -3.5, true},  //
		{`"12"`, 12, true},    // numeric strings parse
		{`""`, 0, true},       // Number("") === 0
		{`" 7 "`, 7, true},    //
		{`"abc"`, 0, false},   // NaN
		{`"12abc"`, 0, false}, // Number differs from parseInt here
		{`{}`, 0, false},      // NaN
	}
	for _, tc := range cases {
		value, finite := jsNumberValue(json.RawMessage(tc.raw))
		if finite != tc.finite || (finite && value != tc.value) {
			t.Errorf("jsNumberValue(%s) = %v,%v; want %v,%v", tc.raw, value, finite, tc.value, tc.finite)
		}
	}
}

// TestAuditLimitMatchesJavaScript pins `Number(searchParams.get("limit") ?? 200)` for /api/admin/audit.
// The default applies only when the parameter is ABSENT: `?limit=` is present and coerces to 0,
// which ListAudit then clamps up to 1 — treating it as absent would hand back 200 rows instead.
func TestAuditLimitMatchesJavaScript(t *testing.T) {
	cases := []struct {
		name string
		raw  []string
		want int
	}{
		{"absent", nil, 200},
		{"empty", []string{""}, 0},
		{"numeric", []string{"50"}, 50},
		{"zero", []string{"0"}, 0},
		{"negative", []string{"-5"}, -5},
		{"non-numeric", []string{"abc"}, 200},
		{"fraction", []string{"12.7"}, 12},
	}
	for _, tc := range cases {
		if got := auditLimit(tc.raw); got != tc.want {
			t.Errorf("auditLimit(%s) = %d; want %d", tc.name, got, tc.want)
		}
	}
}

// TestCredentialFeedWithoutDatabase: the credential feed fails closed with 503 when no client key is
// configured and the caller is not a v2 client — the same response the TS returns.
func TestCredentialFeedWithoutDatabase(t *testing.T) {
	// Pinned so the result cannot depend on the ambient .env.
	t.Setenv("POOL_CLIENT_KEY", "")
	t.Setenv("READ_KEYS_ENFORCED", "")
	handler := newTestServer().Handler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/accounts", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if body["error"] != "security_not_configured" {
		t.Fatalf("unexpected body: %v", body)
	}
}

// TestAdminKeyCreateShape pins the embedded-struct ordering of the one-time key response.
func TestAdminKeyCreateShape(t *testing.T) {
	body := struct {
		OK bool `json:"ok"`
		*auth.CreatedKey
	}{true, &auth.CreatedKey{ID: 3, Key: "atp_abc", Prefix: "atp_abc"}}
	want := `{"ok":true,"id":3,"key":"atp_abc","prefix":"atp_abc"}`
	if got := string(jsonBody(body)); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}
