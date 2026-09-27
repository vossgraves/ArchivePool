package httpapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/health"
)

// The small shapes below are structs, not maps, so their serialized key order matches the TS
// object literals exactly.
type okID struct {
	OK bool `json:"ok"`
	ID int  `json:"id"`
}

type okIDRevoked struct {
	OK      bool `json:"ok"`
	ID      int  `json:"id"`
	Revoked bool `json:"revoked"`
}

type okIDRemoved struct {
	OK      bool `json:"ok"`
	ID      int  `json:"id"`
	Removed bool `json:"removed"`
}

type okRemoved struct {
	OK      bool `json:"ok"`
	Removed int  `json:"removed"`
}

// adminActor resolves the caller for every /api/admin/* route: the shared token or an admin session,
// or nil.
func (s *Server) adminActor(r *http.Request) *auth.AdminActor {
	return auth.ResolveAdmin(r.Context(), s.DB, r, nowTime())
}

func unauthorized(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
}

// handleAdminKeysList is GET /api/admin/keys: every key, soft-deleted ones included.
func (s *Server) handleAdminKeysList(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	keys, err := auth.ListApiKeys(r.Context(), s.DB)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Keys []auth.AdminApiKey `json:"keys"`
	}{keys}, nil)
}

// handleAdminKeyCreate is POST /api/admin/keys. The plaintext is returned exactly once here.
func (s *Server) handleAdminKeyCreate(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid body"}, nil)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "name required"}, nil)
		return
	}

	created, err := auth.CreateApiKey(r.Context(), s.DB, name)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	auth.RecordAudit(r.Context(), s.DB, r, actor, auth.AuditKeyCreate,
		"key:"+strconv.Itoa(created.ID), map[string]any{"name": name, "prefix": created.Prefix})
	writeJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
		*auth.CreatedKey
	}{true, created}, nil)
}

// handleAdminKeyPatch is PATCH /api/admin/keys: revoke or restore.
func (s *Server) handleAdminKeyPatch(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	var body struct {
		ID      int   `json:"id"`
		Revoked *bool `json:"revoked"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid body"}, nil)
		return
	}
	if body.ID == 0 {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "id required"}, nil)
		return
	}
	revoked := true
	if body.Revoked != nil {
		revoked = *body.Revoked
	}
	if err := auth.SetKeyRevoked(r.Context(), s.DB, body.ID, revoked); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	action := auth.AuditKeyRevoke
	if !revoked {
		action = auth.AuditKeyRestore
	}
	auth.RecordAudit(r.Context(), s.DB, r, actor, action, "key:"+strconv.Itoa(body.ID), nil)
	writeJSON(w, http.StatusOK, okIDRevoked{true, body.ID, revoked}, nil)
}

// handleAdminKeyDelete is DELETE /api/admin/keys/{id}: the panel's only true removal.
func (s *Server) handleAdminKeyDelete(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	keyID, ok := jsInt(pathParam(r, "id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_id"}, nil)
		return
	}

	deleted, err := auth.DeleteApiKey(r.Context(), s.DB, keyID)
	if err != nil {
		logf("[admin] delete key %d failed: %v", keyID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not delete that key.",
		}, nil)
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, errBody{Error: "not_found"}, nil)
		return
	}
	auth.RecordAudit(r.Context(), s.DB, r, actor, auth.AuditKeyDelete, "key:"+strconv.Itoa(keyID), nil)
	writeJSON(w, http.StatusOK, okID{true, keyID}, nil)
}

// handleAdminKeyCustom is POST /api/admin/keys/custom: create a key with a KNOWN value, so a baked
// SOURCE_PROVIDER_KEY can be re-seeded after a database loss.
func (s *Server) handleAdminKeyCustom(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	var body struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		body = struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}{}
	}
	name := truncate(strings.TrimSpace(body.Name), 64)
	if name == "" {
		name = "restored"
	}
	value := strings.TrimSpace(body.Value)

	if !validCustomKey(value) {
		writeJSON(w, http.StatusBadRequest, errJSON("invalid_value", "Key must start with 'atp_' followed by at least 24 alphanumeric characters."), nil)
		return
	}

	created, err := auth.CreateApiKeyWithValue(r.Context(), s.DB, name, value)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if created == nil {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "exists", "detail": "A key with this value already exists.",
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ID     int    `json:"id"`
		Prefix string `json:"prefix"`
	}{created.ID, created.Prefix}, nil)
}

// validCustomKey is /^atp_[A-Za-z0-9]{24,}$/.
func validCustomKey(value string) bool {
	if !strings.HasPrefix(value, "atp_") {
		return false
	}
	rest := value[len("atp_"):]
	if len(rest) < 24 {
		return false
	}
	for _, ch := range rest {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
			continue
		}
		return false
	}
	return true
}

type adminRequestRow struct {
	ID               int     `json:"id"`
	Subject          string  `json:"subject"`
	Reason           string  `json:"reason"`
	Status           string  `json:"status"`
	IPAddress        string  `json:"ipAddress"`
	UserAgent        string  `json:"userAgent"`
	RequestedService *string `json:"requestedService"`
	DiscordID        *string `json:"discordId"`
	TelegramID       *string `json:"telegramId"`
	ContactNote      *string `json:"contactNote"`
	CreatedAt        string  `json:"createdAt"`
	ReviewedAt       *string `json:"reviewedAt"`
	ReviewNote       string  `json:"reviewNote"`
	Username         *string `json:"username"`
}

// handleAdminRequests is GET /api/admin/requests: the review queue, returned as a bare array.
func (s *Server) handleAdminRequests(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	ctx := r.Context()
	s.DB.EnsureSchema(ctx)
	rows, err := s.DB.Query(ctx, `
		select q.id, q.subject, q.reason, q.status, q.ip_address, q.user_agent,
		       q.requested_service, q.discord_id, q.telegram_id, q.contact_note,
		       q.created_at, q.reviewed_at, q.review_note, u.username as username
		from api_key_requests q
		left join users u on q.user_id = u.id
		order by q.created_at desc`)
	if err != nil {
		logf("[admin] list requests failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "internal_error", "detail": "Could not load requests.",
		}, map[string]string{"cache-control": "private, no-store"})
		return
	}

	out := make([]adminRequestRow, 0, rows.Len())
	for _, row := range rows.All() {
		entry := adminRequestRow{
			ID:               row.Int("id"),
			Subject:          row.Str("subject"),
			Reason:           row.Str("reason"),
			Status:           row.Str("status"),
			IPAddress:        row.Str("ip_address"),
			UserAgent:        row.Str("user_agent"),
			RequestedService: row.StrPtr("requested_service"),
			DiscordID:        row.StrPtr("discord_id"),
			TelegramID:       row.StrPtr("telegram_id"),
			ContactNote:      row.StrPtr("contact_note"),
			ReviewNote:       row.Str("review_note"),
			ReviewedAt:       isoPtr(row.Any("reviewed_at")),
			Username:         row.StrPtr("username"),
		}
		if created := isoPtr(row.Any("created_at")); created != nil {
			entry.CreatedAt = *created
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, out, map[string]string{"cache-control": "private, no-store"})
}

const minRejectionNote = 10

// handleAdminRequestReview is POST /api/admin/requests/{id}: approve or reject.
//
// Approving does not mint a key — the requester claims it from their own dashboard, so the one-time
// plaintext never passes through the panel.
func (s *Server) handleAdminRequestReview(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	requestID, ok := jsInt(pathParam(r, "id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_id"}, nil)
		return
	}

	var body struct {
		Action string `json:"action"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		body = struct {
			Action string `json:"action"`
			Note   string `json:"note"`
		}{}
	}
	note := truncate(strings.TrimSpace(body.Note), 500)
	ctx := r.Context()
	s.DB.EnsureSchema(ctx)

	switch body.Action {
	case "approve":
		result, err := auth.ApproveKeyRequest(ctx, s.DB, requestID, actor.UserID, nowTime())
		if err != nil {
			logf("[admin] review request %d failed: %v", requestID, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "internal_error", "detail": "Could not record that decision. Check the database.",
			}, nil)
			return
		}
		if result == nil {
			writeJSON(w, http.StatusNotFound, errBody{Error: "not_found_or_not_pending"}, nil)
			return
		}
		auth.RecordAudit(ctx, s.DB, r, actor, auth.AuditRequestApprove,
			"request:"+strconv.Itoa(requestID), map[string]any{"subject": result.Subject})
		writeJSON(w, http.StatusOK, struct {
			OK      bool   `json:"ok"`
			Status  string `json:"status"`
			Subject string `json:"subject"`
		}{true, "approved", result.Subject}, nil)
	case "reject":
		// A rejection with no reason is indistinguishable from silence for the requester, so the panel
		// is required to say something.
		if len(note) < minRejectionNote {
			writeJSON(w, http.StatusBadRequest, errJSON("note_required", "Rejection reason must be at least "+strconv.Itoa(minRejectionNote)+" characters."), nil)
			return
		}
		ok, err := auth.RejectKeyRequest(ctx, s.DB, requestID, actor.UserID, note, nowTime())
		if err != nil {
			logf("[admin] review request %d failed: %v", requestID, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "internal_error", "detail": "Could not record that decision. Check the database.",
			}, nil)
			return
		}
		if !ok {
			writeJSON(w, http.StatusNotFound, errBody{Error: "not_found_or_not_pending"}, nil)
			return
		}
		auth.RecordAudit(ctx, s.DB, r, actor, auth.AuditRequestReject,
			"request:"+strconv.Itoa(requestID), map[string]any{"note": note})
		writeJSON(w, http.StatusOK, struct {
			OK     bool   `json:"ok"`
			Status string `json:"status"`
		}{true, "rejected"}, nil)
	default:
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_action"}, nil)
	}
}

// handleAdminUsers is GET /api/admin/users.
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	users, err := auth.ListUsersForAdmin(r.Context(), s.DB)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Users []auth.AdminUser `json:"users"`
	}{users}, nil)
}

// handleAdminUserPatch is PATCH /api/admin/users: promote or demote an account.
//
// A named admin may not demote themselves — the only way back would be the shared ADMIN_TOKEN, and
// if that has been rotated away the site is left with no administrator at all.
func (s *Server) handleAdminUserPatch(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	var body struct {
		UserID json.RawMessage `json:"userId"`
		Role   string          `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_body"}, nil)
		return
	}
	// `Number(body.userId)` then `Number.isFinite`: absent or non-numeric is 400 userId_required.
	userIDFloat, ok := jsNumberValue(body.UserID)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "userId_required"}, nil)
		return
	}
	userID := int(userIDFloat)
	if body.Role != "admin" && body.Role != "user" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid_role"}, nil)
		return
	}
	if body.Role == "user" && actor.UserID != nil && *actor.UserID == userID {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "cannot_demote_self"}, nil)
		return
	}

	updated, err := auth.SetUserRole(r.Context(), s.DB, userID, body.Role)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if updated == nil {
		writeJSON(w, http.StatusNotFound, errBody{Error: "not_found"}, nil)
		return
	}
	auth.RecordAudit(r.Context(), s.DB, r, actor, auth.AuditUserRoleChange,
		"user:"+strconv.Itoa(userID), map[string]any{"username": updated.Username, "role": body.Role})
	writeJSON(w, http.StatusOK, struct {
		OK       bool   `json:"ok"`
		UserID   int    `json:"userId"`
		Role     string `json:"role"`
		Username string `json:"username"`
	}{true, userID, body.Role, updated.Username}, nil)
}

// handleAdminAudit is GET /api/admin/audit.
func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		// `Number(value ?? 200)` then `Number.isFinite(limit) ? limit : 200`: an empty string is 0
		// (clamped to 1 by ListAudit), non-numeric is NaN (200).
		if n, err := strconv.ParseFloat(raw, 64); err == nil {
			limit = int(n)
		}
	}
	entries, err := auth.ListAudit(r.Context(), s.DB, limit)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []auth.AuditEntry `json:"entries"`
	}{entries}, nil)
}

// handleAdminRemove is POST /api/admin/remove: hard removal / re-institute of a contributed entry.
// Ids are globally unique across the two tables, so both are updated by id and exactly one row moves.
func (s *Server) handleAdminRemove(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	var body struct {
		ID     int    `json:"id"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid body"}, nil)
		return
	}
	if body.ID == 0 {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "id required"}, nil)
		return
	}
	removed := body.Action != "restore"

	ctx := r.Context()
	s.DB.EnsureSchema(ctx)
	if _, err := s.DB.Exec(ctx, `update account_entries set removed = $1 where id = $2`, removed, body.ID); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if _, err := s.DB.Exec(ctx, `update instance_entries set removed = $1 where id = $2`, removed, body.ID); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	auth.RecordAudit(ctx, s.DB, r, actor, auth.AuditEntryRemove,
		"entry:"+strconv.Itoa(body.ID), map[string]any{"removed": removed})
	writeJSON(w, http.StatusOK, okIDRemoved{true, body.ID, removed}, nil)
}

type adminEntryRow struct {
	ID                  int     `json:"id"`
	Service             string  `json:"service"`
	Kind                string  `json:"kind"`
	Label               string  `json:"label"`
	Status              string  `json:"status"`
	Premium             bool    `json:"premium"`
	Disabled            bool    `json:"disabled"`
	Removed             bool    `json:"removed"`
	Contributor         *string `json:"contributor"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	LastCheckedAt       *string `json:"lastCheckedAt"`
	Detail              *string `json:"detail"`
	LatencyMs           *int    `json:"latencyMs"`
	CheckCount          int     `json:"checkCount"`
	OKCount             int     `json:"okCount"`
	CreatedAt           string  `json:"createdAt"`
}

// handleAdminRemoveList is GET /api/admin/remove: everything, removed entries included, for owner
// moderation tooling. `payload` is deliberately never selected: it holds the donor credential, and
// only the masked `label` may leave.
func (s *Server) handleAdminRemoveList(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	ctx := r.Context()
	s.DB.EnsureSchema(ctx)

	entries := []adminEntryRow{}
	for _, table := range []struct {
		name string
		kind string
	}{{"account_entries", "account"}, {"instance_entries", "api"}} {
		rows, err := s.DB.Query(ctx, `
			select id, service, label, status, premium, disabled, removed, contributor,
			       consecutive_failures, last_checked_at, detail, latency_ms, check_count,
			       ok_count, created_at
			from `+table.name+` order by id asc`)
		if err != nil {
			writeEmpty(w, http.StatusInternalServerError)
			return
		}
		for _, row := range rows.All() {
			item := adminEntryRow{
				ID:                  row.Int("id"),
				Service:             row.Str("service"),
				Kind:                table.kind,
				Label:               row.Str("label"),
				Status:              row.Str("status"),
				Premium:             row.Bool("premium"),
				Disabled:            row.Bool("disabled"),
				Removed:             row.Bool("removed"),
				Contributor:         row.StrPtr("contributor"),
				ConsecutiveFailures: row.Int("consecutive_failures"),
				LastCheckedAt:       isoPtr(row.Any("last_checked_at")),
				Detail:              row.StrPtr("detail"),
				LatencyMs:           row.IntPtr("latency_ms"),
				CheckCount:          row.Int("check_count"),
				OKCount:             row.Int("ok_count"),
			}
			if created := isoPtr(row.Any("created_at")); created != nil {
				item.CreatedAt = *created
			}
			entries = append(entries, item)
		}
	}

	// The TS concatenates accounts then instances and sorts the merged list by id ascending.
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	writeJSON(w, http.StatusOK, struct {
		Count   int             `json:"count"`
		Entries []adminEntryRow `json:"entries"`
	}{len(entries), entries}, nil)
}

// handleAdminPurgeDead is POST /api/admin/purge-dead: bulk-remove every dead entry across both
// tables.
func (s *Server) handleAdminPurgeDead(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	ctx := r.Context()
	s.DB.EnsureSchema(ctx)

	accounts, err := s.DB.Query(ctx,
		`select id from account_entries where status = 'dead' and removed = false`)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	instances, err := s.DB.Query(ctx,
		`select id from instance_entries where status = 'dead' and removed = false`)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}

	removed := accounts.Len() + instances.Len()
	if removed == 0 {
		writeJSON(w, http.StatusOK, okRemoved{true, 0}, nil)
		return
	}

	if _, err := s.DB.Exec(ctx,
		`update account_entries set removed = true where status = 'dead' and removed = false`); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if _, err := s.DB.Exec(ctx,
		`update instance_entries set removed = true where status = 'dead' and removed = false`); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}

	accountIDs := make([]int, 0, accounts.Len())
	for _, row := range accounts.All() {
		accountIDs = append(accountIDs, row.Int("id"))
	}
	instanceIDs := make([]int, 0, instances.Len())
	for _, row := range instances.All() {
		instanceIDs = append(instanceIDs, row.Int("id"))
	}
	auth.RecordAudit(ctx, s.DB, r, actor, auth.AuditEntryPurgeDead, "entries", map[string]any{
		"removed":     removed,
		"accountIds":  accountIDs,
		"instanceIds": instanceIDs,
	})
	writeJSON(w, http.StatusOK, okRemoved{true, removed}, nil)
}

// handleAdminCheckEntry is POST /api/admin/check-entry: re-verify one entry on demand.
func (s *Server) handleAdminCheckEntry(w http.ResponseWriter, r *http.Request) {
	if s.adminActor(r) == nil {
		unauthorized(w)
		return
	}
	var body struct {
		ID *int `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid body"}, nil)
		return
	}
	if body.ID == nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "id required"}, nil)
		return
	}

	result, err := health.CheckEntryByID(r.Context(), s.DB, *body.ID)
	if err != nil {
		// Surface the reason (e.g. missing POOL_ENCRYPTION_KEY) instead of a bare 500, so the admin
		// panel can show something actionable.
		writeJSON(w, http.StatusInternalServerError, errBody{Error: err.Error()}, nil)
		return
	}
	if result == nil {
		writeJSON(w, http.StatusNotFound, errBody{Error: "not found"}, nil)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK     bool                     `json:"ok"`
		Result *health.CheckEntryResult `json:"result"`
	}{true, result}, nil)
}

// handleAdminForceCheck is POST /api/admin/force-check: re-check every non-removed entry (bypassing
// the 6h stale threshold) and trigger a fresh monochrome instance sync.
func (s *Server) handleAdminForceCheck(w http.ResponseWriter, r *http.Request) {
	actor := s.adminActor(r)
	if actor == nil {
		unauthorized(w)
		return
	}
	ctx := r.Context()

	type sweepOutcome struct {
		summary health.SweepSummary
		err     error
	}
	type monoOutcome struct {
		result health.InstanceSyncResult
		err    error
	}
	sweepCh := make(chan sweepOutcome, 1)
	monoCh := make(chan monoOutcome, 1)
	// A panicking worker still sends its outcome, as an error: this handler blocks on both
	// channels, and safeGo would swallow the panic and leave the request hanging.
	go func() {
		var out sweepOutcome
		defer func() { sweepCh <- out }()
		defer recoverAsError(&out.err, "health sweep")
		out.summary, out.err = health.RunHealthSweep(ctx, s.DB, true)
	}()
	go func() {
		var out monoOutcome
		defer func() { monoCh <- out }()
		defer recoverAsError(&out.err, "monochrome sync")
		out.result, out.err = health.SyncMonochromeInstances(ctx, s.DB)
	}()
	sweep := <-sweepCh
	mono := <-monoCh

	auth.RecordAudit(ctx, s.DB, r, actor, auth.AuditEntryForceCheck, "entries", nil)

	var monochrome any = mono.result
	if mono.err != nil {
		monochrome = errBody{Error: mono.err.Error()}
	}
	var sweepPayload any = sweep.summary
	if sweep.err != nil {
		sweepPayload = errBody{Error: sweep.err.Error()}
	}

	writeJSON(w, http.StatusOK, struct {
		OK         bool   `json:"ok"`
		Sweep      any    `json:"sweep"`
		Monochrome any    `json:"monochrome"`
		RanAt      string `json:"ranAt"`
	}{true, sweepPayload, monochrome, nowISO()}, nil)
}
