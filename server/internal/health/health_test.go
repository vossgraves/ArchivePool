package health

import (
	"errors"
	"strings"
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
