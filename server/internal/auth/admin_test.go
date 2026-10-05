// SPDX-License-Identifier: GPL-3.0-or-later
package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testAdminToken = "s3cret-admin-token"

func adminRequest(authorization string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/admin/keys", nil)
	if authorization != "" {
		req.Header.Set("authorization", authorization)
	}
	return req
}

func TestIsAdminAuthorizedPrefersTokenHash(t *testing.T) {
	sum := sha256.Sum256([]byte(testAdminToken))
	t.Setenv("ADMIN_TOKEN_HASH", hex.EncodeToString(sum[:]))
	t.Setenv("ADMIN_TOKEN", "plaintext-fallback")

	if !IsAdminAuthorized(adminRequest("Bearer " + testAdminToken)) {
		t.Fatal("the hash of the presented token must authorize")
	}
	if IsAdminAuthorized(adminRequest("Bearer plaintext-fallback")) {
		t.Fatal("when ADMIN_TOKEN_HASH is configured the plaintext must NOT authorize")
	}
	if IsAdminAuthorized(adminRequest("Bearer wrong")) || IsAdminAuthorized(adminRequest("")) {
		t.Fatal("an unknown or absent token must never authorize")
	}
	if IsAdminAuthorized(adminRequest(testAdminToken)) {
		t.Fatal("the Bearer scheme is required")
	}
}

func TestAdminTokenHashIsUpperCasedAndTrimmed(t *testing.T) {
	sum := sha256.Sum256([]byte(testAdminToken))
	t.Setenv("ADMIN_TOKEN_HASH", "  "+strings.ToUpper(hex.EncodeToString(sum[:]))+"  ")
	t.Setenv("ADMIN_TOKEN", "")
	if !IsAdminAuthorized(adminRequest("Bearer " + testAdminToken)) {
		t.Fatal("an upper-case, padded hash must still authorize")
	}
}

func TestMalformedAdminTokenHashFailsClosed(t *testing.T) {
	for _, value := range []string{"zz", "abcd", "not-hex-at-all"} {
		t.Setenv("ADMIN_TOKEN_HASH", value)
		t.Setenv("ADMIN_TOKEN", "plaintext-fallback")
		if IsAdminAuthorized(adminRequest("Bearer plaintext-fallback")) {
			t.Fatalf("malformed hash %q must fail closed, not fall back to the plaintext token", value)
		}
	}
}

func TestIsAdminAuthorizedFallsBackToPlaintext(t *testing.T) {
	t.Setenv("ADMIN_TOKEN_HASH", "")
	t.Setenv("ADMIN_TOKEN", testAdminToken)
	if !IsAdminAuthorized(adminRequest("Bearer " + testAdminToken)) {
		t.Fatal("with no hash configured the plaintext token must authorize")
	}
	if IsAdminAuthorized(adminRequest("Bearer other")) {
		t.Fatal("a wrong plaintext token must not authorize")
	}
}

func TestIsAdminAuthorizedFailsClosedWhenUnset(t *testing.T) {
	t.Setenv("ADMIN_TOKEN_HASH", "")
	t.Setenv("ADMIN_TOKEN", "")
	if IsAdminAuthorized(adminRequest("Bearer anything")) {
		t.Fatal("an unset secret must never mean \"allow\"")
	}
}

func TestIsCronAuthorizedAcceptsCronSecretAndAdminToken(t *testing.T) {
	t.Setenv("CRON_SECRET", "cron-secret-value")
	t.Setenv("ADMIN_TOKEN_HASH", "")
	t.Setenv("ADMIN_TOKEN", testAdminToken)

	if !IsCronAuthorized(adminRequest("Bearer cron-secret-value")) {
		t.Fatal("CRON_SECRET must authorize the cron routes")
	}
	if !IsCronAuthorized(adminRequest("Bearer " + testAdminToken)) {
		t.Fatal("the admin token must also authorize the cron routes")
	}
	if IsCronAuthorized(adminRequest("Bearer nope")) || IsCronAuthorized(adminRequest("")) {
		t.Fatal("an unknown or absent secret must not authorize")
	}
}

func TestIsCronAuthorizedWithoutCronSecret(t *testing.T) {
	t.Setenv("CRON_SECRET", "")
	t.Setenv("ADMIN_TOKEN_HASH", "")
	t.Setenv("ADMIN_TOKEN", testAdminToken)
	if !IsCronAuthorized(adminRequest("Bearer " + testAdminToken)) {
		t.Fatal("with no CRON_SECRET the admin token is the only accepted credential")
	}
}
