// SPDX-License-Identifier: GPL-3.0-or-later
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/health"
	"archivepool/server/internal/pool"
)

// This file ports app/actions/submit.ts, the manual contribution form's ingest path. The React
// /submit page keeps calling the Next server action while Next serves the frontend; POST /api/submit
// exposes the identical behaviour (same fields, same validation, same admission policy) for a
// cutover where the Go server also serves the form.

var (
	dateOnlyRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	arlRe      = regexp.MustCompile(`^[a-f0-9]{100,}$`)
)

// optString distinguishes "key present with a null value" from "key omitted", which matters because
// the TS response always carries creditedTo (null when the contributor stayed anonymous).
type optString struct {
	Value *string
}

func (o optString) MarshalJSON() ([]byte, error) {
	if o.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.Value)
}

// SubmitState is the server action's return shape.
type SubmitState struct {
	OK         bool       `json:"ok"`
	Message    string     `json:"message"`
	Status     *string    `json:"status,omitempty"`
	Premium    *bool      `json:"premium,omitempty"`
	CreditedTo *optString `json:"creditedTo,omitempty"`
}

// handleSubmit is POST /api/submit, the Go equivalent of invoking the server action with a FormData
// body.
func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		// ParseForm's error for a urlencoded body is recoverable; an unparseable body yields an empty
		// form, which the validation below rejects exactly as the TS does.
		_ = r.ParseForm()
	}
	state := s.submitSource(r.Context(), r, r.Form)
	writeJSON(w, http.StatusOK, state, nil)
}

// submitSource implements submitSource(prev, form) from app/actions/submit.ts.
func (s *Server) submitSource(ctx context.Context, r *http.Request, form url.Values) SubmitState {
	service := pool.Service(form.Get("service"))
	kind := pool.Kind(form.Get("kind"))
	if !pool.IsService(string(service)) || !pool.IsKind(string(kind)) {
		return SubmitState{OK: false, Message: "Pick a valid service and type."}
	}

	payload := buildSubmitPayload(service, kind, form)
	if invalid := validateSubmit(service, kind, payload); invalid != "" {
		return SubmitState{OK: false, Message: invalid}
	}

	expiresAt, expiryErr := parseExpiry(form.Get("expiresAt"))
	if expiryErr != "" {
		return SubmitState{OK: false, Message: expiryErr}
	}

	// Attribution is opt-in, and the form carries only a boolean — never a name. The credited
	// username is resolved from the verified session server-side, so a client cannot claim to be
	// somebody else. Logged-out or unchecked submissions stay anonymous.
	var contributor *string
	if form.Get("credit") == "on" {
		if userID := auth.SessionUserID(r, nowTime()); userID != nil {
			contributor = auth.FindUsernameByID(ctx, s.DB, *userID)
		}
	}

	result, err := health.IngestSource(ctx, s.DB, service, kind, payload, health.IngestOptions{
		Contributor: contributor,
		ExpiresAt:   expiresAt,
	})
	if err != nil {
		logf("[submit] ingest failed: %v", err)
		return SubmitState{OK: false, Message: health.DescribeSaveError(s.Cfg.DatabaseURL, err)}
	}

	status := result.Status
	premium := result.Premium
	if !result.Saved {
		message := "Not added: this source works but has no premium/lossless entitlement. The pool only accepts premium sources."
		if !result.OK {
			message = "Not added: the live check failed (" + result.Detail + "). Only working, premium sources are accepted."
		}
		return SubmitState{OK: false, Status: &status, Premium: &premium, Message: message}
	}

	message := "Verified as working and premium — added to the pool. Thank you!"
	credited := &optString{Value: contributor}
	if contributor != nil {
		message = "Verified as working and premium — added to the pool, credited to @" + *contributor + ". Thank you!"
	}
	return SubmitState{OK: true, Status: &status, Premium: &premium, CreditedTo: credited, Message: message}
}

// optionalAmazonAuth carries the optional Amazon instance auth material onto an instance OR account
// payload: the operator's long-lived `bypassToken` and/or a pre-minted Cloudflare Turnstile
// `turnstileJwt` with the moment it expires. Blank fields are omitted, never sent as "", so an
// Amazon payload written before this existed keeps its exact shape. The two tokens are credentials
// and are encrypted like every other one; the expiry is a plain timestamp and stays readable.
func optionalAmazonAuth(payload map[string]any, form url.Values) map[string]any {
	for _, field := range []string{"bypassToken", "turnstileJwt", "turnstileJwtExpiresAt"} {
		if value := trimString(form.Get(field)); value != "" {
			payload[field] = value
		}
	}
	return payload
}

// buildSubmitPayload mirrors buildPayload: absent optional fields are omitted, never sent as "".
func buildSubmitPayload(service pool.Service, kind pool.Kind, form url.Values) map[string]any {
	note := trimString(form.Get("note"))
	withNote := func(payload map[string]any) map[string]any {
		if note != "" {
			payload["note"] = note
		}
		return payload
	}
	optional := func(payload map[string]any, key, value string) map[string]any {
		if trimmed := trimString(value); trimmed != "" {
			payload[key] = trimmed
		}
		return payload
	}

	if kind == pool.KindAPI {
		payload := map[string]any{"baseUrl": trimString(form.Get("baseUrl"))}
		payload = optional(payload, "healthPath", form.Get("healthPath"))
		payload = optional(payload, "probeUrl", form.Get("probeUrl"))
		if service == pool.ServiceAmazonMusic {
			payload = optionalAmazonAuth(payload, form)
		}
		return withNote(payload)
	}
	switch service {
	case pool.ServiceTidal:
		payload := map[string]any{"token": trimString(form.Get("token"))}
		payload = optional(payload, "refreshToken", form.Get("refreshToken"))
		payload = optional(payload, "countryCode", form.Get("countryCode"))
		return withNote(payload)
	case pool.ServiceDeezer:
		payload := map[string]any{"arl": trimString(form.Get("arl"))}
		// Optional override for the Blowfish key-derivation secret; the app ships a working default.
		payload = optional(payload, "masterSecret", form.Get("masterSecret"))
		return withNote(payload)
	case pool.ServiceAppleMusic:
		return withNote(map[string]any{"token": trimString(form.Get("token"))})
	case pool.ServiceAmazonMusic:
		// The credential is the web-session artifact, and the app stores and reads it under `session`
		// — not `token`, so it travels in its own field. The optional instance auth material rides
		// along, so one submission can carry both the account and the instance token it is used with.
		raw := form.Get("premium")
		payload := map[string]any{
			"session": trimString(form.Get("session")),
			"premium": raw == "on" || raw == "true",
		}
		return withNote(optionalAmazonAuth(payload, form))
	default:
		payload := map[string]any{
			"token":     trimString(form.Get("token")),
			"appId":     trimString(form.Get("appId")),
			"appSecret": trimString(form.Get("appSecret")),
		}
		payload = optional(payload, "username", form.Get("username"))
		return withNote(payload)
	}
}

// validateSubmit mirrors validate(): the same rules and the same user-facing message per rule.
func validateSubmit(service pool.Service, kind pool.Kind, payload map[string]any) string {
	if kind == pool.KindAPI {
		raw := payloadString(payload, "baseUrl")
		parsed, err := url.Parse(raw)
		// url.Parse returns a nil URL alongside its error (e.g. for "%zz"), so the error has to be
		// handled before the scheme is read: dereferencing it panicked the handler on a hand-crafted
		// baseUrl.
		if err != nil || parsed == nil {
			return "Enter a valid base URL (including https://)."
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return "Base URL must be http(s)."
		}
		return ""
	}
	switch service {
	case pool.ServiceDeezer:
		// Deezer authenticates with an ARL cookie instead of a token, so it is checked before the
		// generic token requirement.
		arl := trimString(payloadString(payload, "arl"))
		if arl == "" {
			return "Deezer submissions need an ARL cookie value."
		}
		if !arlRe.MatchString(strings.ToLower(arl)) {
			return "That doesn't look like an ARL — expected a long hexadecimal string."
		}
		return ""
	case pool.ServiceAppleMusic:
		token := trimString(payloadString(payload, "token"))
		if token == "" {
			return "Apple Music submissions need a Media-User-Token."
		}
		if !strings.HasPrefix(token, "0.") {
			return `That doesn't look like a Media-User-Token — it should start with "0.".`
		}
		return ""
	case pool.ServiceAmazonMusic:
		session := trimString(payloadString(payload, "session"))
		if session == "" {
			return "Amazon Music submissions need the account session artifact."
		}
		// Same floor the app applies on sign-in: a shorter value is a paste error, and letting it in
		// would only burn a health check and a lease slot.
		if len(session) < 16 {
			return "That session value looks truncated — paste the whole thing."
		}
		return ""
	}
	if trimString(payloadString(payload, "token")) == "" {
		return "A token is required for account submissions."
	}
	if service == pool.ServiceQobuz {
		if trimString(payloadString(payload, "appId")) == "" {
			return "Qobuz submissions need an app_id."
		}
		if trimString(payloadString(payload, "appSecret")) == "" {
			return "Qobuz submissions need an app_secret (required to sign stream URLs)."
		}
	}
	return ""
}

func payloadString(payload map[string]any, key string) string {
	value, ok := payload[key].(string)
	if !ok {
		return ""
	}
	return value
}

// parseExpiry pins date-only input to the end of that day in UTC, so "expires today" stays servable
// for the rest of the day rather than dying at midnight in whatever zone the server runs in. A past
// or unparseable date is rejected rather than silently dropped.
func parseExpiry(raw string) (*time.Time, string) {
	trimmed := trimString(raw)
	if trimmed == "" {
		return nil, ""
	}
	var parsed time.Time
	if dateOnlyRe.MatchString(trimmed) {
		value, err := time.Parse("2006-01-02", trimmed)
		if err != nil {
			return nil, "Enter the expiry as YYYY-MM-DD, or leave it blank."
		}
		parsed = time.Date(value.Year(), value.Month(), value.Day(), 23, 59, 59, 0, time.UTC)
	} else {
		value, err := parseLooseTime(trimmed)
		if err != nil {
			return nil, "Enter the expiry as YYYY-MM-DD, or leave it blank."
		}
		parsed = value
	}
	if !parsed.After(time.Now()) {
		return nil, "That expiry date has already passed."
	}
	return &parsed, ""
}

func parseLooseTime(raw string) (time.Time, error) {
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"}
	var err error
	for _, layout := range layouts {
		var parsed time.Time
		if parsed, err = time.Parse(layout, raw); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, err
}

func trimString(s string) string { return strings.TrimSpace(s) }
