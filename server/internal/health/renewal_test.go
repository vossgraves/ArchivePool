// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/httpx"
	"archivepool/server/internal/pool"
)

// roundTripFunc adapts a function to an http.RoundTripper.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// stubOutbound replaces the shared HTTP client with a transport that answers from `routes`, keyed by
// host+path, and fails the test on anything else. Nothing here dials a provider or a community host:
// the response is fabricated locally.
func stubOutbound(t *testing.T, routes map[string]func(*http.Request) (int, string)) {
	t.Helper()
	prev := httpx.Client
	httpx.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		route, ok := routes[r.URL.Host+r.URL.Path]
		if !ok {
			t.Errorf("unexpected outbound request to %s", r.URL)
			return nil, errors.New("test: outbound request blocked")
		}
		status, body := route(r)
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"content-type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})}
	t.Cleanup(func() { httpx.Client = prev })
}

// recordingStore is a tokenStore stand-in: it records every UPDATE and answers the fingerprint
// lookup from the payload the test configured as the row's current contents.
type recordingStore struct {
	stored map[string]any
	execs  []recordedExec
}

type recordedExec struct {
	sql  string
	args []any
}

func (s *recordingStore) Exec(_ context.Context, sql string, args ...any) (string, error) {
	s.execs = append(s.execs, recordedExec{sql: sql, args: args})
	return "UPDATE 1", nil
}

func (s *recordingStore) QueryRow(_ context.Context, _ string, _ ...any) (db.Row, error) {
	if s.stored == nil {
		return db.Row{}, nil
	}
	return db.NewRowsForTest([]string{"payload"}, [][]any{{encodeJSON(s.stored)}}).Row(0), nil
}

const tidalTokenRoute = "auth.tidal.com/v1/oauth2/token"

// TestStoredRefreshTokenRotated pins the concurrent-rotation test that decides whether a rejected
// Tidal refresh is a race or a dead account. Only the effective stored refresh token may be
// compared: a normal row's access token always differs from the refresh token the attempt spent, so
// the old "either field differs" rule classified every revoked credential as a race.
func TestStoredRefreshTokenRotated(t *testing.T) {
	const spent = "spent-refresh"
	cases := []struct {
		name    string
		payload map[string]any
		want    bool
	}{
		{"row still on the spent refresh token", map[string]any{"token": "access-token", "refreshToken": spent}, false},
		{"access token differing is not a rotation", map[string]any{"token": "other-access", "refreshToken": spent}, false},
		{"a replaced refresh token is a rotation", map[string]any{"token": "access-token", "refreshToken": "new-refresh"}, true},
		{"token-only row still on the spent credential", map[string]any{"token": spent}, false},
		{"token-only row rotated onto a new credential", map[string]any{"token": "new-refresh"}, true},
		{"an emptied row cannot prove a rotation", map[string]any{"token": "", "refreshToken": "  "}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := storedRefreshTokenRotated(tc.payload, spent); got != tc.want {
				t.Errorf("storedRefreshTokenRotated(%v, %q) = %v, want %v", tc.payload, spent, got, tc.want)
			}
		})
	}
}

// TestTryRefreshTidalTokenPersistsRotation proves the second half of the fingerprint contract: the
// rotated credential is written back onto the row the attempt started from. Without the fingerprint
// the hook receives from the lease query the write is skipped, and the lease serves a fresh token
// while the row keeps the spent single-use refresh token.
func TestTryRefreshTidalTokenPersistsRotation(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))

	stubOutbound(t, map[string]func(*http.Request) (int, string){
		tidalTokenRoute: func(*http.Request) (int, string) {
			return 200, `{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}`
		},
	})

	store := &recordingStore{}
	payload := map[string]any{"token": "stale-access", "refreshToken": "spent-refresh", "appId": "tidal-app"}
	got := tryRefreshTidalToken(context.Background(), store, payload, "fp-1")
	if got.token != "fresh-access" || got.skip {
		t.Fatalf("refresh = %+v, want the fresh access token", got)
	}
	if len(store.execs) != 1 {
		t.Fatalf("persist writes = %d, want exactly 1", len(store.execs))
	}
	rec := store.execs[0]
	if !strings.Contains(rec.sql, "update account_entries set payload") {
		t.Fatalf("unexpected persist SQL: %s", rec.sql)
	}
	if len(rec.args) != 2 || rec.args[1] != "fp-1" {
		t.Fatalf("persist args = %v, want the payload and the row fingerprint", rec.args)
	}
	raw, ok := rec.args[0].(string)
	if !ok {
		t.Fatalf("persisted payload has type %T, want the JSON-encoded column value", rec.args[0])
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatalf("persisted payload is not JSON: %v", err)
	}
	plain := crypto.DecryptAtRest(stored)
	if plain["token"] != "fresh-access" || plain["refreshToken"] != "fresh-refresh" {
		t.Fatalf("persisted payload = %v, want the rotated access and refresh tokens", plain)
	}
}

// TestRejectedRefreshIsDeadUnlessTheRowRotated drives the whole decision through
// tryRefreshTidalToken: an invalid_grant against a row that still holds the spent refresh token is a
// revoked credential (dead), while a row a concurrent check rotated is a race (skipped).
func TestRejectedRefreshIsDeadUnlessTheRowRotated(t *testing.T) {
	stubOutbound(t, map[string]func(*http.Request) (int, string){
		tidalTokenRoute: func(*http.Request) (int, string) {
			return 400, `{"error":"invalid_grant","error_description":"refresh token is invalid"}`
		},
	})

	payload := map[string]any{"token": "access-token", "refreshToken": "spent-refresh"}
	cases := []struct {
		name string
		row  map[string]any
		skip bool
	}{
		{
			// The row still holds the credential this attempt spent: nothing refreshed it, so the
			// rejection is about the account.
			name: "unchanged row is a revoked credential",
			row:  map[string]any{"token": "access-token", "refreshToken": "spent-refresh"},
		},
		{
			name: "row rotated by another check is a race",
			row:  map[string]any{"token": "new-access", "refreshToken": "new-refresh"},
			skip: true,
		},
		{
			// A token-only row that rotated carries no refreshToken; the new access token is the
			// effective credential and proves the rotation.
			name: "token-only row rotated by another check is a race",
			row:  map[string]any{"token": "new-access"},
			skip: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tryRefreshTidalToken(context.Background(), &recordingStore{stored: tc.row}, payload, "fp-1")
			if got.token != "" || got.skip != tc.skip {
				t.Fatalf("refresh = %+v, want no token and skip=%v", got, tc.skip)
			}
			want := pool.StatusDead
			if tc.skip {
				want = pool.StatusPending
			}
			if status := refreshFailureStatus(got); status != want {
				t.Fatalf("verdict = %s, want %s (skip=%v)", status, want, tc.skip)
			}
		})
	}
}

// TestTidalRefreshKeepsSpentTokenWhenNoneReturned covers a contribution whose only field was the
// refresh token: Tidal answers the exchange without a new refresh token, and overwriting `token`
// with the access token alone would leave the row with nothing to renew from an hour later.
func TestTidalRefreshKeepsSpentTokenWhenNoneReturned(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))
	stubOutbound(t, map[string]func(*http.Request) (int, string){
		tidalTokenRoute: func(*http.Request) (int, string) {
			return 200, `{"access_token":"fresh-access","expires_in":3600}`
		},
	})

	store := &recordingStore{}
	got := tryRefreshTidalToken(context.Background(), store, map[string]any{"token": "only-refresh"}, "fp-1")
	if got.token != "fresh-access" {
		t.Fatalf("refresh = %+v, want the fresh access token", got)
	}
	if got.payload["token"] != "fresh-access" || got.payload["refreshToken"] != "only-refresh" {
		t.Fatalf("returned payload = %v, want the access token plus the kept refresh token", got.payload)
	}
	if len(store.execs) != 1 {
		t.Fatalf("persist writes = %d, want exactly 1", len(store.execs))
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(store.execs[0].args[0].(string)), &stored); err != nil {
		t.Fatalf("persisted payload is not JSON: %v", err)
	}
	if plain := crypto.DecryptAtRest(stored); plain["refreshToken"] != "only-refresh" {
		t.Fatalf("persisted payload = %v, want the refresh token kept", plain)
	}
}

// TestFreshTidalCredentialServesRotatedRefreshToken covers the lease-time renewal of an expired
// access token when Tidal rotates the refresh token: the lease must carry the new refresh token,
// because the one it started with is spent and an app could not refresh with it.
func TestFreshTidalCredentialServesRotatedRefreshToken(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))
	stubOutbound(t, map[string]func(*http.Request) (int, string){
		tidalTokenRoute: func(*http.Request) (int, string) {
			return 200, `{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}`
		},
	})

	expired := jwtWith(t, map[string]any{"exp": float64(time.Now().Add(-time.Hour).Unix())})
	served, excluded := FreshTidalCredential(context.Background(), &recordingStore{}, "fp-1",
		map[string]any{"token": expired, "refreshToken": "spent-refresh", "countryCode": "US"})
	if excluded {
		t.Fatal("a renewed credential was excluded from the lease")
	}
	if served["token"] != "fresh-access" || served["refreshToken"] != "fresh-refresh" || served["countryCode"] != "US" {
		t.Fatalf("served = %v, want the renewed access and refresh tokens with the other fields kept", served)
	}
}

// TestCheckTidalAccountRejectedAfterRenewalIsDead drives a check whose stored access token is
// expired, renews it (rotating the refresh token), and then has Tidal reject the fresh token. The
// follow-up refresh must spend the rotated refresh token: spending the one the check started with
// is rejected, reads as a concurrent refresh because the row has moved on, and leaves a rejected
// account without a verdict on every sweep.
func TestCheckTidalAccountRejectedAfterRenewalIsDead(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))

	fresh := func(n string) string {
		return jwtWith(t, map[string]any{"exp": float64(time.Now().Add(time.Hour).Unix()), "n": n})
	}
	var spent []string
	stubOutbound(t, map[string]func(*http.Request) (int, string){
		tidalTokenRoute: func(r *http.Request) (int, string) {
			_ = r.ParseForm()
			token := r.PostForm.Get("refresh_token")
			for _, used := range spent {
				if used == token {
					return 400, `{"error":"invalid_grant"}`
				}
			}
			spent = append(spent, token)
			next := "refresh-" + strconv.Itoa(len(spent)+1)
			return 200, `{"access_token":"` + fresh(next) + `","refresh_token":"` + next + `","expires_in":3600}`
		},
		"api.tidal.com/v1/sessions": func(*http.Request) (int, string) { return 401, `{}` },
	})

	expired := jwtWith(t, map[string]any{"exp": float64(time.Now().Add(-time.Hour).Unix())})
	// The row as the first renewal leaves it, which is what a rejected refresh compares against.
	store := &recordingStore{stored: map[string]any{"token": "renewed-access", "refreshToken": "refresh-2"}}
	got := checkTidalAccount(context.Background(), store,
		map[string]any{"token": expired, "refreshToken": "refresh-1"}, "fp-1")

	if want := []string{"refresh-1", "refresh-2"}; strings.Join(spent, ",") != strings.Join(want, ",") {
		t.Fatalf("refresh tokens spent = %v, want %v", spent, want)
	}
	if got.Skipped || got.OK || got.Status != pool.StatusDead {
		t.Fatalf("result = %+v, want a dead verdict that is persisted", got)
	}
}

// TestCheckQobuzAccountRenewalOutcomes pins the renewal rule: a transient Qobuz renewal failure must
// reach the sweep as a skipped pending result (no counter advance, no disable), while a credential
// the provider actually rejected stays dead. The transport is local; the nil database is never
// touched on either failure path.
func TestCheckQobuzAccountRenewalOutcomes(t *testing.T) {
	const (
		getRoute   = "www.qobuz.com/api.json/0.2/user/get"
		loginRoute = "www.qobuz.com/api.json/0.2/user/login"
	)
	payload := map[string]any{
		"token":     "spent-token",
		"appId":     "950096963",
		"appSecret": "test-app-secret",
		"username":  "listener@example.com",
		"password":  "hunter2",
	}

	t.Run("transient renewal failure is a skipped pending", func(t *testing.T) {
		stubOutbound(t, map[string]func(*http.Request) (int, string){
			getRoute:   func(*http.Request) (int, string) { return 401, `{"error":"unauthorized"}` },
			loginRoute: func(*http.Request) (int, string) { return 503, `{"status":"error"}` },
		})
		got := checkQobuzAccount(context.Background(), nil, payload, "fp-1")
		if got.Status != pool.StatusPending || !got.Skipped || got.OK {
			t.Fatalf("result = %+v, want pending + skipped", got)
		}
	})

	t.Run("retry after renewal sends only the renewed token", func(t *testing.T) {
		var retryQuery, retryHeader string
		gets := 0
		stubOutbound(t, map[string]func(*http.Request) (int, string){
			getRoute: func(r *http.Request) (int, string) {
				gets++
				if gets == 1 {
					return 401, `{"error":"unauthorized"}`
				}
				retryQuery = r.URL.Query().Get("user_auth_token")
				retryHeader = r.Header.Get("X-User-Auth-Token")
				return 500, `{}`
			},
			loginRoute: func(*http.Request) (int, string) {
				return 200, `{"user_auth_token":"renewed-token","user":{"id":1,"country_code":"US"}}`
			},
		})
		checkQobuzAccount(context.Background(), nil, payload, "")
		if gets != 2 {
			t.Fatalf("user/get calls = %d, want 2", gets)
		}
		if retryQuery != "renewed-token" || retryHeader != "renewed-token" {
			t.Fatalf("retry query=%q header=%q, want both renewed-token", retryQuery, retryHeader)
		}
	})

	t.Run("rejected credentials stay dead", func(t *testing.T) {
		stubOutbound(t, map[string]func(*http.Request) (int, string){
			getRoute:   func(*http.Request) (int, string) { return 401, `{"error":"unauthorized"}` },
			loginRoute: func(*http.Request) (int, string) { return 400, `{"message":"bad credentials"}` },
		})
		got := checkQobuzAccount(context.Background(), nil, payload, "fp-1")
		if got.Status != pool.StatusDead || got.Skipped || got.OK {
			t.Fatalf("result = %+v, want dead without skip", got)
		}
	})
}
