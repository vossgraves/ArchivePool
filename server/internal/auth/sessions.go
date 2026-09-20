// Package auth implements every authentication model the TS app has, mirroring lib/sessions.ts,
// lib/admin-auth.ts, lib/api-keys.ts, lib/users.ts and lib/audit.ts.
//
// Four models coexist by design: read keys (pool feeds), HMAC session cookies (user routes),
// admin token / admin-role sessions (/api/admin/*) and CRON_SECRET (/api/cron/*).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SessionCookieName is the cookie the app presents; the Android client and the React dashboard
// both read it by this exact name.
const SessionCookieName = "atp_session"

const sessionTTL = 30 * 24 * time.Hour // 30 days

// ErrNoSessionSecret is returned when the deployment has no signing secret. SESSION_SECRET failing
// to be configured must fail CLOSED — signing must never fall back to a default.
var ErrNoSessionSecret = errNoSessionSecret{}

type errNoSessionSecret struct{}

func (errNoSessionSecret) Error() string {
	return "SESSION_SECRET is not configured; refusing to issue sessions"
}

func sessionSecret() (string, error) {
	secret := strings.TrimSpace(env("SESSION_SECRET"))
	if secret == "" {
		return "", ErrNoSessionSecret
	}
	return secret, nil
}

func signSession(payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// CreateSessionToken builds `<userId>.<expiresAtMs>.<hmac>` (lib/sessions.ts createSessionToken).
func CreateSessionToken(userID int, now time.Time) (string, time.Duration, error) {
	secret, err := sessionSecret()
	if err != nil {
		return "", 0, err
	}
	expiresAtMs := now.Add(sessionTTL).UnixMilli()
	payload := strconv.Itoa(userID) + "." + strconv.FormatInt(expiresAtMs, 10)
	return payload + "." + signSession(payload, secret), sessionTTL, nil
}

// VerifySessionToken returns the authenticated user id, or nil when the token is absent, forged or
// expired.
func VerifySessionToken(token string, now time.Time) *int {
	if token == "" {
		return nil
	}
	secret, err := sessionSecret()
	if err != nil {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	userIDRaw, expiresRaw, signature := parts[0], parts[1], parts[2]
	expected := signSession(userIDRaw+"."+expiresRaw, secret)
	if !constantTimeEqual([]byte(signature), []byte(expected)) {
		return nil
	}
	userID, ok := jsParseInt(userIDRaw)
	if !ok {
		return nil
	}
	expiresAtMs, ok := jsParseInt(expiresRaw)
	if !ok {
		return nil
	}
	if expiresAtMs <= now.UnixMilli() {
		return nil
	}
	id := int(userID)
	return &id
}

// SetSessionCookie writes the session cookie. `secure` mirrors NODE_ENV === "production", and the
// rest of the attributes (httpOnly, sameSite lax, path /, maxAge 30d) are the app's contract.
func SetSessionCookie(w http.ResponseWriter, userID int, secure bool, now time.Time) error {
	value, maxAge, err := CreateSessionToken(userID, now)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(maxAge / time.Second),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// ClearSessionCookie expires the cookie. MaxAge -1 is what emits `Max-Age=0`: net/http treats a zero
// MaxAge as "no attribute at all", which would leave the cookie alive in the browser.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
}

// SessionUserID reads and verifies the cookie on a request.
func SessionUserID(r *http.Request, now time.Time) *int {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || cookie == nil {
		return nil
	}
	return VerifySessionToken(cookie.Value, now)
}

// jsParseInt mirrors Number.parseInt: leading whitespace and digits are parsed, trailing garbage is
// ignored, and a string with no leading digits is not a number.
func jsParseInt(s string) (int64, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	if s == "" {
		return 0, false
	}
	i := 0
	neg := false
	if s[0] == '+' || s[0] == '-' {
		neg = s[0] == '-'
		i = 1
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		// Overflow: JS would produce an imprecise but finite number; the session id is a serial, so
		// refusing is equivalent in practice.
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	return hmac.Equal(a, b)
}

// jsonDetail is the audit `detail` column value.
func jsonDetail(detail map[string]any) string {
	if detail == nil {
		return "{}"
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}
