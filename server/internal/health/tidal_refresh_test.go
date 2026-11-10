// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"archivepool/server/internal/pool"
)

// jwtWith builds an unsigned JWT whose payload carries the given claims — enough for the unverified
// payload read the proactive-renewal gate does.
func jwtWith(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// TestIsTidalAccessExpired pins the trigger of the proactive Tidal renewal. Tidal access tokens live
// about an hour while the sweep runs every few hours, so a row that is not refreshed up front stays
// on an expired token until something asks for it — the exact complaint this fix addresses.
func TestIsTidalAccessExpired(t *testing.T) {
	now := time.Now().Unix()
	// A REAL access token carries `type: "o2_access"`, which is what keeps it out of the
	// refresh-token branch; the expiry gate must read it the same way.
	claims := func(exp int64) map[string]any { return map[string]any{"exp": exp, "type": "o2_access"} }

	cases := []struct {
		name  string
		token string
		want  bool
	}{
		{"expired an hour ago", jwtWith(t, claims(now-3600)), true},
		{"expires inside the margin", jwtWith(t, claims(now+60)), true},
		{"expires just outside the margin", jwtWith(t, claims(now+tidalAccessMarginSecs+30)), false},
		{"fresh for hours", jwtWith(t, claims(now+3600)), false},
		// An unreadable payload must NOT be called expired: the answer would be a guess, and the
		// /sessions probe still catches a really dead token.
		{"a refresh token has no exp claim", jwtWith(t, map[string]any{"type": "o2_refresh"}), false},
		{"not a JWT at all", "opaque-token", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		if got := isTidalAccessExpired(tc.token); got != tc.want {
			t.Errorf("%s: isTidalAccessExpired = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestRefreshFailureStatus pins the rule that keeps a provider-side outage from walking the pool up
// the auto-disable ladder: only a rejected credential is dead, a skipped attempt is pending.
func TestRefreshFailureStatus(t *testing.T) {
	if got := refreshFailureStatus(tidalRefresh{detail: "refresh rate-limited", skip: true}); got != pool.StatusPending {
		t.Errorf("skipped refresh = %s, want pending", got)
	}
	if got := refreshFailureStatus(tidalRefresh{detail: "refresh rejected: invalid_grant"}); got != pool.StatusDead {
		t.Errorf("rejected refresh = %s, want dead", got)
	}
}
