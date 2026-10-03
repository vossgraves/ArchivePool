package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"archivepool/server/internal/config"
	"archivepool/server/internal/db"
)

// TestSignupKillSwitch pins the opt-out ALLOW_PUBLIC_SIGNUP switch: with it set to "false" signup is
// refused before the body is read or the database is touched, exactly like the TS route.
func TestSignupKillSwitch(t *testing.T) {
	handler := New(&config.Config{Port: "0", NodeEnv: "test", PublicSignupDisabled: true}, db.Unconfigured(), nil).Handler()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/signup", strings.NewReader(`{"username":"someone","password":"long-enough-password"}`))
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	want := `{"error":"signup_disabled","detail":"Public registration is disabled. Contact the administrator."}`
	if body := strings.TrimSpace(rec.Body.String()); body != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

// TestSignupOpenByDefault: a deployment that never set the variable keeps public signup, so the
// request gets past the switch and fails later on its own merits (here: a malformed body).
func TestSignupOpenByDefault(t *testing.T) {
	handler := newTestServer().Handler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/auth/signup", strings.NewReader("not json")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 invalid_body (the switch must not fire by default)", rec.Code)
	}
}

// TestAdminUserCreateRequiresAdmin: manual account creation is admin-only.
func TestAdminUserCreateRequiresAdmin(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "")
	t.Setenv("ADMIN_TOKEN_HASH", "")
	handler := newTestServer().Handler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/admin/users", strings.NewReader(`{"username":"someone","password":"long-enough-password"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
