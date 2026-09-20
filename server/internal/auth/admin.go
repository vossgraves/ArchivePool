package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"time"

	"archivepool/server/internal/db"
)

// env is os.Getenv, indirected so tests can drive the auth decisions without a process-wide setup.
var env = os.Getenv

func sha256Sum(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

// secretMatches hashes both sides first: timingSafeEqual throws on a length mismatch, and returning
// early on that would leak the real secret's length.
func secretMatches(candidate, expected string) bool {
	a := sha256Sum(candidate)
	b := sha256Sum(expected)
	return subtle.ConstantTimeCompare(a, b) == 1
}

// bearerToken extracts `Authorization: Bearer <token>`; the scheme check is case-sensitive, as in
// the TS.
func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(header[len("Bearer "):])
	if token == "" {
		return "", false
	}
	return token, true
}

// IsAdminAuthorized prefers ADMIN_TOKEN_HASH (SHA-256 hex), falling back to plaintext ADMIN_TOKEN so
// a deployment keeps working mid-rollout. Fails closed: an unset secret never means "allow".
func IsAdminAuthorized(r *http.Request) bool {
	candidate, ok := bearerToken(r)
	if !ok {
		return false
	}

	configuredHash := strings.ToLower(strings.TrimSpace(env("ADMIN_TOKEN_HASH")))
	if configuredHash != "" {
		expected, err := hex.DecodeString(configuredHash)
		if err != nil {
			return false
		}
		// A malformed hash is a misconfiguration, not a reason to fall back to the weaker check.
		if len(expected) != 32 {
			return false
		}
		return subtle.ConstantTimeCompare(sha256Sum(candidate), expected) == 1
	}

	plaintext := env("ADMIN_TOKEN")
	if plaintext == "" {
		return false
	}
	return secretMatches(candidate, plaintext)
}

// IsCronAuthorized accepts `Bearer $CRON_SECRET` (what the GitHub Actions workflows send) and also
// an admin token, so the jobs stay manually triggerable.
func IsCronAuthorized(r *http.Request) bool {
	candidate, ok := bearerToken(r)
	if !ok {
		return false
	}
	if cronSecret := env("CRON_SECRET"); cronSecret != "" && secretMatches(candidate, cronSecret) {
		return true
	}
	return IsAdminAuthorized(r)
}

// AdminActor is who acted. UserID is nil for the shared ADMIN_TOKEN, which cannot identify a person.
type AdminActor struct {
	UserID *int
	Label  string
}

// ResolveAdmin authorizes by either credential: the shared token or an admin's session. Nil when
// neither holds — a database failure must not be read as "allow".
func ResolveAdmin(ctx context.Context, database *db.DB, r *http.Request, now time.Time) *AdminActor {
	if IsAdminAuthorized(r) {
		return &AdminActor{UserID: nil, Label: "admin-token"}
	}

	userID := SessionUserID(r, now)
	if userID == nil {
		return nil
	}

	database.EnsureSchema(ctx)
	row, err := database.QueryRow(ctx,
		`select username, role, disabled from users where id = $1 limit 1`, *userID)
	if err != nil {
		logf("[admin-auth] role lookup failed: %v", err)
		return nil
	}
	if !row.Valid() || row.Bool("disabled") || row.Str("role") != "admin" {
		return nil
	}
	return &AdminActor{UserID: userID, Label: row.Str("username")}
}
