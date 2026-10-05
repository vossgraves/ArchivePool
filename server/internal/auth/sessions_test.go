// SPDX-License-Identifier: GPL-3.0-or-later
package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// nodeSessionToken was produced by lib/sessions.ts (createSessionToken(42, 1893456000000) with the
// secret below), so verification here proves the cookie format is identical in both directions.
const (
	nodeSessionSecret = "test-session-secret-do-not-use"
	nodeSessionToken  = "42.1893456000000.IeMj_17z7YPk5BykQBLh8lRBuqCI_desjcUpXvDfuug"
)

func fixedNow() time.Time { return time.UnixMilli(1_800_000_000_000) } // 2027-01-15, after "now"

func TestVerifyTypeScriptSessionToken(t *testing.T) {
	t.Setenv("SESSION_SECRET", nodeSessionSecret)
	userID := VerifySessionToken(nodeSessionToken, fixedNow())
	if userID == nil || *userID != 42 {
		t.Fatalf("expected user 42 from the TS-produced token, got %v", userID)
	}
}

func TestSessionTokenRoundTrip(t *testing.T) {
	t.Setenv("SESSION_SECRET", "another-secret")
	now := fixedNow()
	token, maxAge, err := CreateSessionToken(7, now)
	if err != nil {
		t.Fatalf("CreateSessionToken: %v", err)
	}
	if maxAge != 30*24*time.Hour {
		t.Fatalf("session TTL must be 30 days, got %s", maxAge)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "7" {
		t.Fatalf("unexpected token shape: %q", token)
	}
	if want := "1802592000000"; parts[1] != want { // now + 30d in ms
		t.Fatalf("expiry = %s, want %s", parts[1], want)
	}
	if got := VerifySessionToken(token, now); got == nil || *got != 7 {
		t.Fatalf("round trip failed: %v", got)
	}
}

func TestVerifySessionTokenRejections(t *testing.T) {
	t.Setenv("SESSION_SECRET", nodeSessionSecret)
	now := fixedNow()
	cases := map[string]string{
		"empty":            "",
		"two parts":        "42.1893456000000",
		"four parts":       "42.1893456000000.sig.extra",
		"tampered payload": "43.1893456000000.IeMj_17z7YPk5BykQBLh8lRBuqCI_desjcUpXvDfuug",
		"tampered sig":     "42.1893456000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"non-numeric id":   "abc.1893456000000." + strings.Split(nodeSessionToken, ".")[2],
	}
	for name, token := range cases {
		if got := VerifySessionToken(token, now); got != nil {
			t.Errorf("%s: expected rejection, got user %d", name, *got)
		}
	}
}

func TestVerifySessionTokenExpiry(t *testing.T) {
	t.Setenv("SESSION_SECRET", nodeSessionSecret)
	// 1893456000000 is 2030-01-01; verifying a second later is expired.
	later := time.UnixMilli(1893456000001)
	if got := VerifySessionToken(nodeSessionToken, later); got != nil {
		t.Fatalf("expected an expired token to be rejected, got user %d", *got)
	}
}

func TestSigningFailsClosedWithoutSecret(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")
	if _, _, err := CreateSessionToken(1, fixedNow()); err == nil {
		t.Fatal("expected an error when SESSION_SECRET is not configured")
	}
	if got := VerifySessionToken(nodeSessionToken, fixedNow()); got != nil {
		t.Fatal("verification must fail closed without a secret")
	}
}

func TestSetSessionCookieAttributes(t *testing.T) {
	t.Setenv("SESSION_SECRET", nodeSessionSecret)
	for _, tc := range []struct {
		name           string
		secure         bool
		wantSecureAttr bool
	}{
		{"development", false, false},
		{"production", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			if err := SetSessionCookie(rec, 5, tc.secure, fixedNow()); err != nil {
				t.Fatalf("SetSessionCookie: %v", err)
			}
			header := rec.Header().Get("set-cookie")
			for _, want := range []string{SessionCookieName + "=", "Path=/", "Max-Age=2592000", "HttpOnly", "SameSite=Lax"} {
				if !strings.Contains(header, want) {
					t.Errorf("cookie missing %q: %s", want, header)
				}
			}
			if gotSecure := strings.Contains(header, "Secure"); gotSecure != tc.wantSecureAttr {
				t.Errorf("Secure attribute = %v, want %v (%s)", gotSecure, tc.wantSecureAttr, header)
			}
		})
	}
}

func TestClearSessionCookieExpiresIt(t *testing.T) {
	rec := httptest.NewRecorder()
	ClearSessionCookie(rec)
	header := rec.Header().Get("set-cookie")
	if !strings.Contains(header, SessionCookieName+"=") || !strings.Contains(header, "Max-Age=0") {
		t.Fatalf("clearing cookie must carry Max-Age=0: %s", header)
	}
}

func TestSessionUserIDFromRequest(t *testing.T) {
	t.Setenv("SESSION_SECRET", nodeSessionSecret)
	req := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: nodeSessionToken})
	if got := SessionUserID(req, fixedNow()); got == nil || *got != 42 {
		t.Fatalf("expected user 42 from the cookie, got %v", got)
	}
	anon := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	if got := SessionUserID(anon, fixedNow()); got != nil {
		t.Fatalf("expected no user without a cookie, got %d", *got)
	}
}

func TestJSParseIntSemantics(t *testing.T) {
	cases := []struct {
		in    string
		want  int64
		valid bool
	}{
		{"42", 42, true},
		{" 42abc", 42, true},
		{"-7", -7, true},
		{"abc", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		got, ok := jsParseInt(tc.in)
		if ok != tc.valid || (ok && got != tc.want) {
			t.Errorf("jsParseInt(%q) = %d,%v; want %d,%v", tc.in, got, ok, tc.want, tc.valid)
		}
	}
}
