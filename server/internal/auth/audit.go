// SPDX-License-Identifier: GPL-3.0-or-later
package auth

import (
	"context"
	"net/http"
	"strings"

	"archivepool/server/internal/db"
)

// AuditAction is the closed set of recorded privileged actions.
type AuditAction string

const (
	AuditKeyCreate       AuditAction = "key.create"
	AuditKeyRevoke       AuditAction = "key.revoke"
	AuditKeyRestore      AuditAction = "key.restore"
	AuditKeyDelete       AuditAction = "key.delete"
	AuditRequestApprove  AuditAction = "request.approve"
	AuditRequestReject   AuditAction = "request.reject"
	AuditEntryRemove     AuditAction = "entry.remove"
	AuditEntryForceCheck AuditAction = "entry.force_check"
	AuditEntryPurgeDead  AuditAction = "entry.purge_dead"
	AuditEntryPurge      AuditAction = "entry.purge"
	AuditUserCreate      AuditAction = "user.create"
	AuditUserRoleChange  AuditAction = "user.role_change"
)

// auditClientIP is the trimmed, truncated proxy address the TS records (empty when absent).
func auditClientIP(r *http.Request) string {
	fwd := ""
	if raw := r.Header.Get("x-forwarded-for"); raw != "" {
		fwd = strings.Split(raw, ",")[0]
	}
	ip := fwd
	if ip == "" {
		ip = r.Header.Get("x-real-ip")
	}
	ip = strings.TrimSpace(ip)
	if len(ip) > 64 {
		ip = ip[:64]
	}
	return ip
}

// RecordAudit appends one audit row. It never fails the caller: an action that succeeded must not be
// reported as failed because the trail could not be written, and the caller has already mutated
// state by this point.
func RecordAudit(ctx context.Context, database *db.DB, r *http.Request, actor *AdminActor, action AuditAction, target string, detail map[string]any) {
	database.EnsureSchema(ctx)
	var actorUserID any
	label := ""
	if actor != nil {
		label = actor.Label
		if actor.UserID != nil {
			actorUserID = *actor.UserID
		}
	}
	if _, err := database.Exec(ctx, `
		insert into audit_log (action, target, actor_user_id, actor_label, detail, ip_address)
		values ($1, $2, $3, $4, $5::jsonb, $6)`,
		string(action), target, actorUserID, label, jsonDetail(detail), auditClientIP(r)); err != nil {
		logf("[audit] failed to record %s %s: %v", action, target, err)
	}
}

// AuditEntry is one row of the admin audit trail.
type AuditEntry struct {
	ID            int     `json:"id"`
	Action        string  `json:"action"`
	Target        string  `json:"target"`
	ActorLabel    string  `json:"actorLabel"`
	ActorUsername *string `json:"actorUsername"`
	Detail        any     `json:"detail"`
	IPAddress     string  `json:"ipAddress"`
	CreatedAt     string  `json:"createdAt"`
}

// ListAudit reads the trail, clamped to 1..500 rows as the TS does.
func ListAudit(ctx context.Context, database *db.DB, limit int) ([]AuditEntry, error) {
	database.EnsureSchema(ctx)
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := database.Query(ctx, `
		select a.id, a.action, a.target, a.actor_label, u.username as actor_username,
		       a.detail, a.ip_address, a.created_at
		from audit_log a
		left join users u on u.id = a.actor_user_id
		order by a.created_at desc
		limit $1`, limit)
	if err != nil {
		return nil, err
	}
	out := make([]AuditEntry, 0, rows.Len())
	for _, r := range rows.All() {
		var detail any = map[string]any{}
		if v := r.Any("detail"); v != nil {
			detail = v
		}
		entry := AuditEntry{
			ID:            r.Int("id"),
			Action:        r.Str("action"),
			Target:        r.Str("target"),
			ActorLabel:    r.Str("actor_label"),
			ActorUsername: r.StrPtr("actor_username"),
			Detail:        detail,
			IPAddress:     r.Str("ip_address"),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			entry.CreatedAt = *created
		}
		out = append(out, entry)
	}
	return out, nil
}
