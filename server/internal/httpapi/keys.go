package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/pool"
)

// handleKeysList is GET /api/keys: the signed-in user's keys and requests.
func (s *Server) handleKeysList(w http.ResponseWriter, r *http.Request) {
	userID := auth.SessionUserID(r, nowTime())
	if userID == nil {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}
	keys, err := auth.ListUserApiKeys(r.Context(), s.DB, *userID)
	if err != nil {
		logf("[keys] list failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not load your keys. Please try again shortly.",
		}, nil)
		return
	}
	requests, err := auth.ListUserRequests(r.Context(), s.DB, *userID)
	if err != nil {
		logf("[keys] list requests failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not load your keys. Please try again shortly.",
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Keys     []auth.UserApiKey  `json:"keys"`
		Requests []auth.UserRequest `json:"requests"`
	}{keys, requests},
		map[string]string{"cache-control": "private, no-store"})
}

type keyRequestBody struct {
	// Subject and Name are pointers because `body.subject ?? body.name` distinguishes "absent" from
	// "empty string": a present-but-empty subject wins, and the request is then rejected.
	Subject          *string `json:"subject"`
	Name             *string `json:"name"`
	Reason           string  `json:"reason"`
	RequestedService string  `json:"requestedService"`
	DiscordID        string  `json:"discordId"`
	TelegramID       string  `json:"telegramId"`
	ContactNote      string  `json:"contactNote"`
}

// handleKeysCreate is POST /api/keys: request a new read key (admin approval required).
func (s *Server) handleKeysCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.SessionUserID(r, nowTime())
	if userID == nil {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}

	var body keyRequestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		// An unparseable body is treated as an empty one, as the TS does.
		body = keyRequestBody{}
	}
	rawSubject := ""
	switch {
	case body.Subject != nil:
		rawSubject = *body.Subject
	case body.Name != nil:
		rawSubject = *body.Name
	}
	subject := truncate(strings.TrimSpace(rawSubject), 64)
	reason := truncate(strings.TrimSpace(body.Reason), 500)
	// Absent or unrecognised means "any service" — the same meaning as NULL in the column.
	requestedService := pool.Service("")
	if pool.IsService(body.RequestedService) {
		requestedService = pool.Service(body.RequestedService)
	}
	discordID := truncate(strings.TrimSpace(body.DiscordID), 64)
	telegramID := truncate(strings.TrimSpace(body.TelegramID), 64)
	contactNote := truncate(strings.TrimSpace(body.ContactNote), 500)

	if subject == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_input", "detail": "Subject is required.",
		}, nil)
		return
	}
	if len(reason) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_input", "detail": "Reason must be at least 10 characters.",
		}, nil)
		return
	}

	ip := truncatedProxyIP(r, 64)
	ua := truncate(header(r, "user-agent"), 256)

	// Enforce 1 active/pending request per IP+UA (30 days) to prevent spam.
	if ip != "" && ua != "" {
		recent, err := auth.CountRequestsByIpUa(ctx, s.DB, ip, ua, 720)
		if err != nil {
			logf("[keys] countRequestsByIpUa failed: %v", err)
		}
		if recent >= 1 {
			writeJSON(w, http.StatusTooManyRequests, errJSON("rate_limited", "One request per device/network. You already have a pending or recent request."), nil)
			return
		}
	}

	existing, err := auth.ListUserApiKeys(ctx, s.DB, *userID)
	if err != nil {
		// The TS leaves this call outside its try/catch, so a database error there is an unhandled
		// rejection: a 500 with no body — and, since the cap check never runs, a request that would
		// otherwise be refused. Fail closed with the same wording the list route uses.
		logf("[keys] cap check failed to read keys: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not load your keys. Please try again shortly.",
		}, nil)
		return
	}
	active := 0
	for _, k := range existing {
		if !k.Revoked {
			active++
		}
	}
	if active >= auth.MaxKeysPerUser {
		writeJSON(w, http.StatusConflict, errJSON("key_limit", "At most "+strconv.Itoa(auth.MaxKeysPerUser)+" active keys per account."), nil)
		return
	}

	details := auth.KeyRequestDetails{RequestedService: requestedService}
	if discordID != "" {
		details.DiscordID = &discordID
	}
	if telegramID != "" {
		details.TelegramID = &telegramID
	}
	if contactNote != "" {
		details.ContactNote = &contactNote
	}

	id, err := auth.CreateKeyRequest(ctx, s.DB, *userID, subject, reason, ip, ua, details)
	if err != nil {
		// Surface DB problems as structured JSON — an unhandled throw here rendered a generic error
		// page for users whose deployments predated a schema migration.
		logf("[keys] createKeyRequest failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not save the request. Please try again shortly.",
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ID     int    `json:"id"`
		Status string `json:"status"`
	}{id, "pending"},
		map[string]string{"cache-control": "private, no-store"})
}

// handleKeyUpdate is DELETE /api/keys/{id}: revoke (`?undo=1` restores) or permanently delete
// (`?delete=1`).
func (s *Server) handleKeyUpdate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.SessionUserID(r, nowTime())
	if userID == nil {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}

	id, ok := jsInt(pathParam(r, "id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_id"}, nil)
		return
	}

	query := r.URL.Query()
	if query.Get("delete") == "1" {
		gone, err := auth.DeleteUserApiKey(ctx, s.DB, *userID, id)
		if err != nil {
			logf("[keys] delete key %d failed: %v", id, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "internal_error", "detail": "Could not change that key. Try again shortly.",
			}, nil)
			return
		}
		if !gone {
			writeJSON(w, http.StatusNotFound, errBody{Error: "not_found"}, nil)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			OK      bool `json:"ok"`
			Deleted bool `json:"deleted"`
		}{true, true}, nil)
		return
	}

	undo := query.Get("undo") == "1"
	updated, err := auth.SetUserKeyRevoked(ctx, s.DB, *userID, id, !undo)
	if err != nil {
		logf("[keys] update key %d failed: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not change that key. Try again shortly.",
		}, nil)
		return
	}
	if !updated {
		writeJSON(w, http.StatusNotFound, errBody{Error: "not_found"}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK      bool `json:"ok"`
		Revoked bool `json:"revoked"`
	}{true, !undo}, nil)
}

var claimMessages = map[string]string{
	"not_found":       "That request does not exist.",
	"not_approved":    "That request has not been approved yet.",
	"already_claimed": "You already revealed the key for this request. Create a new request for another key.",
	"key_limit":       "You have reached the active-key limit for your account. Revoke a key first.",
}

// handleClaim is POST /api/requests/{id}/claim: the only place a request's plaintext key is minted
// and shown.
func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.SessionUserID(r, nowTime())
	if userID == nil {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}

	requestID, ok := jsInt(pathParam(r, "id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_id"}, nil)
		return
	}

	result, err := auth.ClaimApprovedKey(ctx, s.DB, *userID, requestID, nowTime())
	if err != nil {
		logf("[keys] claim request %d failed: %v", requestID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not issue your key. Please try again shortly.",
		}, nil)
		return
	}
	if !result.OK {
		detail := claimMessages[result.Error]
		if detail == "" {
			detail = "Could not issue the key."
		}
		status := http.StatusBadRequest
		if result.Error == "key_limit" {
			status = http.StatusConflict
		}
		writeJSON(w, status, errJSON(result.Error, detail), nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK     bool   `json:"ok"`
		ID     int    `json:"id"`
		Key    string `json:"key"`
		Prefix string `json:"prefix"`
	}{true, result.ID, result.Key, result.Prefix}, map[string]string{"cache-control": "private, no-store"})
}

// truncatedProxyIP mirrors the inline `x-forwarded-for || x-real-ip` extraction the keys route uses
// (which, unlike lib/rate-limit.ts clientIp, never falls back to "unknown").
func truncatedProxyIP(r *http.Request, max int) string {
	ip := ""
	if raw := header(r, "x-forwarded-for"); raw != "" {
		ip = strings.TrimSpace(strings.Split(raw, ",")[0])
	}
	if ip == "" {
		ip = header(r, "x-real-ip")
	}
	return truncate(strings.TrimSpace(ip), max)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// jsInt mirrors Number.parseInt(value, 10) plus the `Number.isFinite` guard: leading digits are
// accepted, garbage is not.
func jsInt(raw string) (int, bool) {
	raw = strings.TrimLeft(raw, " \t\n\r")
	if raw == "" {
		return 0, false
	}
	i := 0
	if raw[0] == '+' || raw[0] == '-' {
		i = 1
	}
	start := i
	for i < len(raw) && raw[i] >= '0' && raw[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(raw[:i])
	if err != nil {
		return 0, false
	}
	return n, true
}
