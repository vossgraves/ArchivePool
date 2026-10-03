package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"archivepool/server/internal/blob"
	"archivepool/server/internal/cache"
	"archivepool/server/internal/config"
	"archivepool/server/internal/db"
	"archivepool/server/internal/ratelimit"
)

// safeGo runs fire-and-forget work in a goroutine, logging a panic instead of crashing the
// process. Only for work nobody waits on: a recovered panic sends nothing, so a caller blocked on
// a result would hang. Use recoverAsError there.
func safeGo(fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("goroutine panic: %v\n%s", r, debug.Stack())
			}
		}()
		fn()
	}()
}

// recoverAsError, deferred in a goroutine whose result a handler waits on, turns a panic into
// *err (logged with its stack) so the result is still delivered and the request is answered.
func recoverAsError(err *error, what string) {
	if r := recover(); r != nil {
		log.Printf("%s panic: %v\n%s", what, r, debug.Stack())
		*err = fmt.Errorf("%s panicked: %v", what, r)
	}
}

// Server holds the shared dependencies every handler needs.
type Server struct {
	Cfg     *config.Config
	DB      *db.DB
	Blob    blob.Store
	Limiter *ratelimit.Limiter
	Cache   *cache.Cache
}

// New builds a Server. Blob may be nil, in which case the no-op store is used.
func New(cfg *config.Config, database *db.DB, store blob.Store) *Server {
	if store == nil {
		store = blob.NoopStore{}
	}
	return &Server{
		Cfg:     cfg,
		DB:      database,
		Blob:    store,
		Limiter: ratelimit.Default,
		Cache:   cache.Default,
	}
}

// Handler builds the router with every route registered.
func (s *Server) Handler() http.Handler {
	r := &Router{}

	// Feeds.
	r.Handle(http.MethodGet, "/api/sources", s.handleSources)
	r.Handle(http.MethodGet, "/api/accounts", s.handleAccounts)
	r.Handle(http.MethodGet, "/api/instances/{service}", s.handleInstances)
	r.Handle(http.MethodGet, "/api/discovery/tidal", s.handleDiscoveryTidal)
	r.Handle(http.MethodGet, "/api/discovery/qobuz", s.handleDiscoveryQobuz)
	r.Handle(http.MethodGet, "/api/status", s.handleStatus)

	// App -> pool reporting.
	r.Handle(http.MethodPost, "/api/report", s.handleReport)

	// Cron.
	r.Handle(http.MethodGet, "/api/cron/health", s.handleCronHealth)
	r.Handle(http.MethodGet, "/api/cron/monochrome", s.handleCronMonochrome)

	// Sessions.
	r.Handle(http.MethodPost, "/api/auth/signup", s.handleSignup)
	r.Handle(http.MethodPost, "/api/auth/login", s.handleLogin)
	r.Handle(http.MethodPost, "/api/auth/logout", s.handleLogout)
	r.Handle(http.MethodGet, "/api/auth/me", s.handleMe)

	// Dashboard key management.
	r.Handle(http.MethodGet, "/api/keys", s.handleKeysList)
	r.Handle(http.MethodPost, "/api/keys", s.handleKeysCreate)
	r.Handle(http.MethodDelete, "/api/keys/{id}", s.handleKeyUpdate)
	r.Handle(http.MethodPost, "/api/requests/{id}/claim", s.handleClaim)

	// Admin.
	r.Handle(http.MethodGet, "/api/admin/keys", s.handleAdminKeysList)
	r.Handle(http.MethodPost, "/api/admin/keys", s.handleAdminKeyCreate)
	r.Handle(http.MethodPatch, "/api/admin/keys", s.handleAdminKeyPatch)
	r.Handle(http.MethodDelete, "/api/admin/keys/{id}", s.handleAdminKeyDelete)
	r.Handle(http.MethodPost, "/api/admin/keys/custom", s.handleAdminKeyCustom)
	r.Handle(http.MethodGet, "/api/admin/requests", s.handleAdminRequests)
	r.Handle(http.MethodPost, "/api/admin/requests/{id}", s.handleAdminRequestReview)
	r.Handle(http.MethodGet, "/api/admin/users", s.handleAdminUsers)
	r.Handle(http.MethodPost, "/api/admin/users", s.handleAdminUserCreate)
	r.Handle(http.MethodPatch, "/api/admin/users", s.handleAdminUserPatch)
	r.Handle(http.MethodGet, "/api/admin/audit", s.handleAdminAudit)
	r.Handle(http.MethodGet, "/api/admin/remove", s.handleAdminRemoveList)
	r.Handle(http.MethodPost, "/api/admin/remove", s.handleAdminRemove)
	r.Handle(http.MethodPost, "/api/admin/purge-dead", s.handleAdminPurgeDead)
	r.Handle(http.MethodPost, "/api/admin/check-entry", s.handleAdminCheckEntry)
	r.Handle(http.MethodPost, "/api/admin/force-check", s.handleAdminForceCheck)

	// Contributor credential flows.
	r.Handle(http.MethodPost, "/api/tidal/device/start", s.handleTidalDeviceStart)
	r.Handle(http.MethodPost, "/api/tidal/device/poll", s.handleTidalDevicePoll)
	r.Handle(http.MethodPost, "/api/qobuz/login", s.handleQobuzLogin)

	// The server action's equivalent. The React /submit page keeps posting to the Next server action
	// while Next serves the frontend; this endpoint exposes the identical admission path for a
	// cutover where the Go server also serves the form (documented in the README).
	r.Handle(http.MethodPost, "/api/submit", s.handleSubmit)

	return r
}

type paramsKeyType struct{}

var paramsKey = paramsKeyType{}

func withParams(ctx context.Context, params map[string]string) context.Context {
	return context.WithValue(ctx, paramsKey, params)
}

// pathParam returns a captured path segment.
func pathParam(r *http.Request, name string) string {
	if params, ok := r.Context().Value(paramsKey).(map[string]string); ok {
		return params[name]
	}
	return ""
}

// clientIP mirrors lib/rate-limit.ts clientIp over the proxy headers.
func clientIP(r *http.Request) string { return ratelimit.ClientIP(r.Header) }

// keyID is the non-reversible per-key rate-limit bucket id.
func keyID(readKey string) string { return ratelimit.KeyID(readKey) }

// rateLimit records one hit against a bucket on this server's limiter.
func (s *Server) rateLimit(id string, limit int, windowMs int) ratelimit.Verdict {
	return s.Limiter.RateLimit(id, limit, msDuration(windowMs))
}

// jsNumberValue mirrors JavaScript's Number(value) for a decoded JSON value: null is 0, booleans are
// 0/1, a numeric string parses (the empty string is 0), and anything else is NaN — reported as
// ok == false. An absent field and an explicit null differ, which is why callers pass the raw message.
func jsNumberValue(raw json.RawMessage) (float64, bool) {
	text := strings.TrimSpace(string(raw))
	switch {
	case text == "":
		return 0, false // absent -> Number(undefined) -> NaN
	case text == "null":
		return 0, true
	case text == "true":
		return 1, true
	case text == "false":
		return 0, true
	case strings.HasPrefix(text, `"`):
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return 0, false
		}
		str = strings.TrimSpace(str)
		if str == "" {
			return 0, true
		}
		value, err := strconv.ParseFloat(str, 64)
		if err != nil {
			return 0, false
		}
		return value, true
	default:
		var value float64
		if err := json.Unmarshal(raw, &value); err != nil {
			return 0, false
		}
		return value, true
	}
}

// errBody is the app's error envelope. It is a struct rather than a map so the serialized key order
// matches the TS object literals (error, then detail) byte for byte — Go marshals maps
// alphabetically.
type errBody struct {
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
}

// errJSON builds an error envelope.
func errJSON(code, detail string) errBody { return errBody{Error: code, Detail: detail} }

// tooManyRequests is lib/rate-limit.ts tooManyRequests: the same body, the retry-after hint and a
// private, no-store cache directive.
func tooManyRequests(w http.ResponseWriter, retryAfterSec int, scope string) {
	writeJSON(w, http.StatusTooManyRequests, errJSON("rate_limited", "Too many "+scope+" requests. Retry shortly."), map[string]string{
		"retry-after":   strconv.Itoa(retryAfterSec),
		"cache-control": "private, no-store",
	})
}

// msDuration converts the millisecond windows the routes are written in.
func msDuration(ms int) time.Duration { return time.Duration(ms) * time.Millisecond }

// header returns a request header value (net/http canonicalises the key, so casing is irrelevant).
func header(r *http.Request, name string) string { return r.Header.Get(name) }
