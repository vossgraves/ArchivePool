package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"archivepool/server/internal/auth"
)

// nowTime is the clock the session and audit code reads.
func nowTime() time.Time { return time.Now() }

type credentialsBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// handleSignup is POST /api/auth/signup.
func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	// Opt-out kill-switch: signup is open unless a deployment explicitly sets "false".
	if s.Cfg.PublicSignupDisabled {
		writeJSON(w, http.StatusForbidden, errJSON("signup_disabled", "Public registration is disabled. Contact the administrator."), nil)
		return
	}
	ctx := r.Context()
	var body credentialsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_body"}, nil)
		return
	}

	username := strings.ToLower(strings.TrimSpace(body.Username))
	password := body.Password

	if problem := auth.ValidateCredentials(username, password); problem != "" {
		writeJSON(w, http.StatusBadRequest, errJSON("invalid_input", problem), nil)
		return
	}

	existing, err := auth.FindUserByUsername(ctx, s.DB, username)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if existing.Valid() {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "username_taken", "detail": "That username is already registered.",
		}, nil)
		return
	}

	ip := truncatedProxyIP(r, 64)
	ua := truncate(header(r, "user-agent"), 256)
	// Prevent mass account creation: at most 5 accounts per IP+UA per 24h.
	if ip != "" && ua != "" {
		recent, err := auth.CountRecentUsersByIpUa(ctx, s.DB, ip, ua, 24)
		if err != nil {
			writeEmpty(w, http.StatusInternalServerError)
			return
		}
		if recent >= 5 {
			writeJSON(w, http.StatusTooManyRequests, errJSON("rate_limited", "Too many accounts from this device/network. Try again later."), nil)
			return
		}
	}

	userID, name, err := auth.CreateUser(ctx, s.DB, username, password, ip, ua)
	if err != nil {
		logf("[auth] signup failed: %v", err)
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if err := auth.SetSessionCookie(w, userID, s.Cfg.Production(), nowTime()); err != nil {
		logf("[auth] session cookie failed: %v", err)
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Username string `json:"username"`
	}{name}, nil)
}

// handleLogin is POST /api/auth/login. The error is uniform for unknown user / wrong password /
// disabled account so the response cannot be used to enumerate usernames.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const (
		attemptLimit   = 10
		ipAttemptLimit = 30
		attemptWindow  = 10 * 60_000
	)

	var body credentialsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_body"}, nil)
		return
	}

	username := strings.ToLower(strings.TrimSpace(body.Username))
	password := body.Password
	if username == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_input"}, nil)
		return
	}

	ipAddr := clientIP(r)
	if verdict := s.rateLimit("login-acct:"+ipAddr+":"+username, attemptLimit, attemptWindow); !verdict.OK {
		tooManyRequests(w, verdict.RetryAfterSec, "login")
		return
	}
	if verdict := s.rateLimit("login-ip:"+ipAddr, ipAttemptLimit, attemptWindow); !verdict.OK {
		tooManyRequests(w, verdict.RetryAfterSec, "login")
		return
	}

	user, err := auth.FindUserByUsername(ctx, s.DB, username)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if !user.Valid() || user.Bool("disabled") || !auth.VerifyPassword(password, user.Str("password_hash")) {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "invalid_credentials"}, nil)
		return
	}

	ip := truncatedProxyIP(r, 64)
	ua := truncate(header(r, "user-agent"), 256)
	// Best-effort and off the request path, exactly as the TS `void updateLastLogin(...).catch()`.
	safeGo(func() {
		bg, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := auth.UpdateLastLogin(bg, s.DB, user.Int("id"), ip, ua); err != nil {
			logf("[auth] updateLastLogin failed: %v", err)
		}
	})

	if err := auth.SetSessionCookie(w, user.Int("id"), s.Cfg.Production(), nowTime()); err != nil {
		logf("[auth] session cookie failed: %v", err)
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Username string `json:"username"`
	}{user.Str("username")}, nil)
}

// handleLogout is POST /api/auth/logout.
func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request) {
	auth.ClearSessionCookie(w)
	writeJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{true}, nil)
}

// handleMe is GET /api/auth/me.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.SessionUserID(r, nowTime())
	if userID == nil {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}
	row, err := s.DB.QueryRow(ctx, `select username from users where id = $1 limit 1`, *userID)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if !row.Valid() {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Username string `json:"username"`
	}{row.Str("username")}, nil)
}
