// SPDX-License-Identifier: GPL-3.0-or-later
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// KeyPrefix is the plaintext marker of a read key: `atp_<48 hex>`.
const KeyPrefix = "atp_"

// MaxKeysPerUser caps simultaneously active (non-revoked) keys per account.
const MaxKeysPerUser = 10

// HashKey is the SHA-256 hex of a key string. Only the hash is ever persisted.
func HashKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// GenerateKey mints a random read key: randomBytes(24).toString("hex").
func GenerateKey() (key, keyHash, prefix string, err error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", "", "", err
	}
	key = KeyPrefix + hex.EncodeToString(buf)
	return key, HashKey(key), key[:len(KeyPrefix)+6], nil
}

// ExtractKey takes a candidate key from a header. Query-string keys are deliberately not supported:
// they leak into URLs, logs and history.
func ExtractKey(r *http.Request) (string, bool) {
	if auth := r.Header.Get("authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimSpace(auth[len("Bearer "):]), true
	}
	if header := r.Header.Get("x-api-key"); header != "" {
		return strings.TrimSpace(header), true
	}
	return "", false
}

// ReadKeyFromRequest is the raw presented key — never persisted, only hashed or used as key material.
func ReadKeyFromRequest(r *http.Request) (string, bool) { return ExtractKey(r) }

// ReadKeyIdentity is the outcome of read-key authentication.
type ReadKeyIdentity struct {
	OK bool
	// KeyID is nil when gating is off and no valid key was presented. Callers that key durable
	// state on the requester (per-key leases) must treat nil as "anonymous" and skip that state.
	KeyID *int
	// Scope is the single service this key may read, or "" for every service — the pre-scope
	// behaviour, so a key minted before scoping keeps working unchanged.
	Scope pool.Service
}

// IdentifyReadKey validates the key and resolves its row id in one lookup, so per-key leasing needs
// no second query. alwaysEnforce is for credential-bearing feeds; discovery feeds carry only URLs
// and can stay public unless READ_KEYS_ENFORCED is set.
func IdentifyReadKey(ctx context.Context, database *db.DB, r *http.Request, alwaysEnforce bool) (ReadKeyIdentity, error) {
	enforced := alwaysEnforce || env("READ_KEYS_ENFORCED") == "true"
	candidate, presented := ExtractKey(r)

	// Gating off: allow, and skip the query entirely when nothing was presented.
	if !enforced && !presented {
		return ReadKeyIdentity{OK: true}, nil
	}
	if !presented {
		return ReadKeyIdentity{}, nil
	}

	keyHash := HashKey(candidate)
	row, err := database.QueryRow(ctx, `
		select id, key_hash, revoked, service from api_keys
		where key_hash = $1 and deleted = false limit 1`, keyHash)
	if err != nil {
		return ReadKeyIdentity{}, err
	}

	scope := pool.Service("")
	if row.Valid() && row.StrPtr("service") != nil && pool.IsService(*row.StrPtr("service")) {
		scope = pool.Service(*row.StrPtr("service"))
	}

	if !enforced {
		// Resolve the id for leasing only; skip the use_count bump, which would silently change what
		// that dashboard number counts on an unenforced deployment.
		if !row.Valid() || row.Bool("revoked") {
			return ReadKeyIdentity{OK: true}, nil
		}
		if !constantTimeEqual([]byte(row.Str("key_hash")), []byte(keyHash)) {
			return ReadKeyIdentity{OK: true}, nil
		}
		id := row.Int("id")
		return ReadKeyIdentity{OK: true, KeyID: &id, Scope: scope}, nil
	}

	if !row.Valid() || row.Bool("revoked") {
		return ReadKeyIdentity{}, nil
	}
	if !constantTimeEqual([]byte(row.Str("key_hash")), []byte(keyHash)) {
		return ReadKeyIdentity{}, nil
	}

	id := row.Int("id")
	// Best-effort; never block the request on it (lib/api-keys.ts fires and forgets the same bump).
	safeGo(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = database.Exec(ctx,
			`update api_keys set use_count = use_count + 1, last_used_at = $1 where id = $2`,
			time.Now(), id)
	})

	return ReadKeyIdentity{OK: true, KeyID: &id, Scope: scope}, nil
}

// VerifyReadKey is the boolean-only wrapper over IdentifyReadKey.
func VerifyReadKey(ctx context.Context, database *db.DB, r *http.Request, alwaysEnforce bool) (bool, error) {
	identity, err := IdentifyReadKey(ctx, database, r, alwaysEnforce)
	if err != nil {
		return false, err
	}
	return identity.OK, nil
}

// CreatedKey is a freshly minted key; the plaintext is shown exactly once.
type CreatedKey struct {
	ID     int    `json:"id"`
	Key    string `json:"key"`
	Prefix string `json:"prefix"`
}

// CreateApiKey is the admin path: a random key.
func CreateApiKey(ctx context.Context, database *db.DB, name string) (*CreatedKey, error) {
	key, keyHash, prefix, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	row, err := database.QueryRow(ctx,
		`insert into api_keys (name, key_hash, prefix) values ($1, $2, $3) returning id`,
		name, keyHash, prefix)
	if err != nil {
		return nil, err
	}
	return &CreatedKey{ID: row.Int("id"), Key: key, Prefix: prefix}, nil
}

// CreateApiKeyWithValue re-seeds a key whose value the operator already knows (a baked
// SOURCE_PROVIDER_KEY after a database loss). Nil when a key with that value already exists.
func CreateApiKeyWithValue(ctx context.Context, database *db.DB, name, value string) (*CreatedKey, error) {
	database.EnsureSchema(ctx)
	keyHash := HashKey(value)
	existing, err := database.Query(ctx, `select id from api_keys where key_hash = $1 limit 1`, keyHash)
	if err != nil {
		return nil, err
	}
	if existing.Len() > 0 {
		return nil, nil
	}
	row, err := database.QueryRow(ctx, `
		insert into api_keys (name, key_hash, prefix) values ($1, $2, $3)
		returning id, prefix`, name, keyHash, value[:len(KeyPrefix)+6])
	if err != nil {
		return nil, err
	}
	return &CreatedKey{ID: row.Int("id"), Prefix: row.Str("prefix")}, nil
}

// CreateUserApiKey creates a key owned by userID, returning the one-time plaintext.
func CreateUserApiKey(ctx context.Context, database *db.DB, userID int, name, reason string) (*CreatedKey, error) {
	key, keyHash, prefix, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	row, err := database.QueryRow(ctx, `
		insert into api_keys (name, key_hash, prefix, user_id, reason)
		values ($1, $2, $3, $4, $5) returning id`, name, keyHash, prefix, userID, reason)
	if err != nil {
		return nil, err
	}
	return &CreatedKey{ID: row.Int("id"), Key: key, Prefix: prefix}, nil
}

// UserApiKey is one key in the dashboard's list.
type UserApiKey struct {
	ID         int     `json:"id"`
	Name       string  `json:"name"`
	Reason     string  `json:"reason"`
	Prefix     string  `json:"prefix"`
	Revoked    bool    `json:"revoked"`
	UseCount   int     `json:"useCount"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
}

// ListUserApiKeys lists a user's keys newest first. Soft-deleted keys are hidden, never returned.
func ListUserApiKeys(ctx context.Context, database *db.DB, userID int) ([]UserApiKey, error) {
	rows, err := database.Query(ctx, `
		select id, name, reason, prefix, revoked, use_count, last_used_at, created_at
		from api_keys where user_id = $1 and deleted = false
		order by created_at desc`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]UserApiKey, 0, rows.Len())
	for _, r := range rows.All() {
		k := UserApiKey{
			ID:         r.Int("id"),
			Name:       r.Str("name"),
			Reason:     r.Str("reason"),
			Prefix:     r.Str("prefix"),
			Revoked:    r.Bool("revoked"),
			UseCount:   r.Int("use_count"),
			LastUsedAt: db.AnyISOPtr(r.Any("last_used_at")),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			k.CreatedAt = *created
		}
		out = append(out, k)
	}
	return out, nil
}

// DeleteUserApiKey removes a key, scoped by userID so one account cannot delete another's by
// guessing ids.
func DeleteUserApiKey(ctx context.Context, database *db.DB, userID, id int) (bool, error) {
	rows, err := database.Query(ctx,
		`delete from api_keys where id = $1 and user_id = $2 returning id`, id, userID)
	if err != nil {
		return false, err
	}
	return rows.Len() > 0, nil
}

// SetUserKeyRevoked revokes (or restores) a key by id, scoped to its owner.
func SetUserKeyRevoked(ctx context.Context, database *db.DB, userID, id int, revoked bool) (bool, error) {
	rows, err := database.Query(ctx,
		`update api_keys set revoked = $1 where id = $2 and user_id = $3 returning id`, revoked, id, userID)
	if err != nil {
		return false, err
	}
	return rows.Len() > 0, nil
}

// AdminApiKey is one key in the admin panel; every key is listed, soft-deleted ones included.
type AdminApiKey struct {
	ID         int     `json:"id"`
	Name       string  `json:"name"`
	Reason     string  `json:"reason"`
	Prefix     string  `json:"prefix"`
	Revoked    bool    `json:"revoked"`
	Deleted    bool    `json:"deleted"`
	UseCount   int     `json:"useCount"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
	Owner      *string `json:"owner"`
}

// ListApiKeys lists every key with its owner's username.
func ListApiKeys(ctx context.Context, database *db.DB) ([]AdminApiKey, error) {
	rows, err := database.Query(ctx, `
		select k.id, k.name, k.reason, k.prefix, k.revoked, k.deleted, k.use_count,
		       k.last_used_at, k.created_at, u.username as owner
		from api_keys k
		left join users u on k.user_id = u.id
		order by k.created_at desc`)
	if err != nil {
		return nil, err
	}
	out := make([]AdminApiKey, 0, rows.Len())
	for _, r := range rows.All() {
		k := AdminApiKey{
			ID:         r.Int("id"),
			Name:       r.Str("name"),
			Reason:     r.Str("reason"),
			Prefix:     r.Str("prefix"),
			Revoked:    r.Bool("revoked"),
			Deleted:    r.Bool("deleted"),
			UseCount:   r.Int("use_count"),
			LastUsedAt: db.AnyISOPtr(r.Any("last_used_at")),
			Owner:      r.StrPtr("owner"),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			k.CreatedAt = *created
		}
		out = append(out, k)
	}
	return out, nil
}

// SetKeyRevoked is the admin revoke/restore.
func SetKeyRevoked(ctx context.Context, database *db.DB, id int, revoked bool) error {
	_, err := database.Exec(ctx, `update api_keys set revoked = $1 where id = $2`, revoked, id)
	return err
}

// DeleteApiKey is the only true removal — revoking is reversible and leaves the hash behind.
func DeleteApiKey(ctx context.Context, database *db.DB, id int) (bool, error) {
	rows, err := database.Query(ctx, `delete from api_keys where id = $1 returning id`, id)
	if err != nil {
		return false, err
	}
	return rows.Len() > 0, nil
}

// KeyRequestDetails is the requester's declared scope and reach details.
type KeyRequestDetails struct {
	RequestedService pool.Service
	DiscordID        *string
	TelegramID       *string
	ContactNote      *string
}

// CreateKeyRequest inserts a pending request.
func CreateKeyRequest(ctx context.Context, database *db.DB, userID int, subject, reason, ip, ua string, details KeyRequestDetails) (int, error) {
	database.EnsureSchema(ctx)
	var service any
	if details.RequestedService != "" {
		service = string(details.RequestedService)
	}
	row, err := database.QueryRow(ctx, `
		insert into api_key_requests
		  (user_id, subject, reason, ip_address, user_agent, requested_service,
		   discord_id, telegram_id, contact_note, status)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
		returning id`,
		userID, subject, reason, ip, ua, service,
		nullStr(details.DiscordID), nullStr(details.TelegramID), nullStr(details.ContactNote))
	if err != nil {
		return 0, err
	}
	return row.Int("id"), nil
}

func nullStr(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

// UserRequest is one request as its owner sees it.
type UserRequest struct {
	ID             int     `json:"id"`
	Subject        string  `json:"subject"`
	Reason         string  `json:"reason"`
	Status         string  `json:"status"`
	IPAddress      string  `json:"ipAddress"`
	UserAgent      string  `json:"userAgent"`
	ResultingKeyID *int    `json:"resultingKeyId"`
	ReviewNote     string  `json:"reviewNote"`
	CreatedAt      string  `json:"createdAt"`
	ReviewedAt     *string `json:"reviewedAt"`
}

// ListUserRequests lists a user's requests newest first.
func ListUserRequests(ctx context.Context, database *db.DB, userID int) ([]UserRequest, error) {
	database.EnsureSchema(ctx)
	rows, err := database.Query(ctx, `
		select id, subject, reason, status, ip_address, user_agent, resulting_key_id,
		       review_note, created_at, reviewed_at
		from api_key_requests where user_id = $1
		order by created_at desc`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]UserRequest, 0, rows.Len())
	for _, r := range rows.All() {
		req := UserRequest{
			ID:             r.Int("id"),
			Subject:        r.Str("subject"),
			Reason:         r.Str("reason"),
			Status:         r.Str("status"),
			IPAddress:      r.Str("ip_address"),
			UserAgent:      r.Str("user_agent"),
			ResultingKeyID: r.IntPtr("resulting_key_id"),
			ReviewNote:     r.Str("review_note"),
			ReviewedAt:     db.AnyISOPtr(r.Any("reviewed_at")),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			req.CreatedAt = *created
		}
		out = append(out, req)
	}
	return out, nil
}

// CountRequestsByIpUa counts recent non-rejected requests from one IP+UA. Rejection deliberately
// frees the slot, so a denial cannot lock a device out forever.
func CountRequestsByIpUa(ctx context.Context, database *db.DB, ip, ua string, hours int) (int, error) {
	if ip == "" || ua == "" {
		return 0, nil
	}
	database.EnsureSchema(ctx)
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)
	rows, err := database.Query(ctx, `
		select id from api_key_requests
		where ip_address = $1 and user_agent = $2 and created_at > $3 and status <> 'rejected'`,
		ip, ua, cutoff)
	if err != nil {
		return 0, err
	}
	return rows.Len(), nil
}

// ApprovedRequest is what approving returns to the admin panel and the audit trail.
type ApprovedRequest struct {
	RequestID int    `json:"requestId"`
	UserID    int    `json:"userId"`
	Subject   string `json:"subject"`
}

// ApproveKeyRequest marks a pending request approved. No key is minted here — ClaimApprovedKey does
// that, so the one-time plaintext reaches its owner instead of being lost in the admin panel.
//
// adminID must be nil, never a 0 sentinel, for the token-authenticated panel: reviewed_by is a
// foreign key to users.id and no account can have id 0.
func ApproveKeyRequest(ctx context.Context, database *db.DB, requestID int, adminID *int, now time.Time) (*ApprovedRequest, error) {
	database.EnsureSchema(ctx)
	row, err := database.QueryRow(ctx, `select * from api_key_requests where id = $1 limit 1`, requestID)
	if err != nil {
		return nil, err
	}
	if !row.Valid() || row.Str("status") != "pending" {
		return nil, nil
	}
	if _, err := database.Exec(ctx,
		`update api_key_requests set status = 'approved', reviewed_at = $1, reviewed_by = $2 where id = $3`,
		now, adminIDValue(adminID), requestID); err != nil {
		return nil, err
	}
	return &ApprovedRequest{RequestID: requestID, UserID: row.Int("user_id"), Subject: row.Str("subject")}, nil
}

// RejectKeyRequest rejects a request with the note the requester gets to read.
func RejectKeyRequest(ctx context.Context, database *db.DB, requestID int, adminID *int, note string, now time.Time) (bool, error) {
	database.EnsureSchema(ctx)
	row, err := database.QueryRow(ctx, `select * from api_key_requests where id = $1 limit 1`, requestID)
	if err != nil {
		return false, err
	}
	if !row.Valid() || row.Str("status") != "pending" {
		return false, nil
	}
	if _, err := database.Exec(ctx, `
		update api_key_requests set status = 'rejected', review_note = $1, reviewed_at = $2, reviewed_by = $3
		where id = $4`, note, now, adminIDValue(adminID), requestID); err != nil {
		return false, err
	}
	return true, nil
}

func adminIDValue(adminID *int) any {
	if adminID == nil {
		return nil
	}
	return *adminID
}

// ClaimResult is the outcome of claiming an approved request.
type ClaimResult struct {
	OK     bool
	ID     int
	Key    string
	Prefix string
	Error  string // not_found | not_approved | already_claimed | key_limit
}

// ClaimApprovedKey is the only place an approved request becomes a key row, and the only place the
// plaintext exists. It locks the request row so two tabs cannot both claim it and orphan a key.
func ClaimApprovedKey(ctx context.Context, database *db.DB, userID, requestID int, now time.Time) (ClaimResult, error) {
	database.EnsureSchema(ctx)
	result := ClaimResult{}
	err := database.Tx(ctx, func(tx *db.Tx) error {
		row, err := tx.QueryRow(ctx, `
			select * from api_key_requests
			where id = $1 and user_id = $2 limit 1 for update`, requestID, userID)
		if err != nil {
			return err
		}
		if !row.Valid() {
			result = ClaimResult{Error: "not_found"}
			return nil
		}
		if row.Str("status") != "approved" {
			result = ClaimResult{Error: "not_approved"}
			return nil
		}
		if row.IntPtr("resulting_key_id") != nil {
			result = ClaimResult{Error: "already_claimed"}
			return nil
		}

		count, err := tx.QueryRow(ctx, `
			select count(*)::int as count from api_keys
			where user_id = $1 and revoked = false and deleted = false`, userID)
		if err != nil {
			return err
		}
		if count.Int("count") >= MaxKeysPerUser {
			result = ClaimResult{Error: "key_limit"}
			return nil
		}

		key, keyHash, prefix, err := GenerateKey()
		if err != nil {
			return err
		}
		created, err := tx.QueryRow(ctx, `
			insert into api_keys (name, key_hash, prefix, user_id, reason, service)
			values ($1, $2, $3, $4, $5, $6) returning id`,
			row.Str("subject"), keyHash, prefix, userID, row.Str("reason"), row.StrPtr("requested_service"))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`update api_key_requests set resulting_key_id = $1 where id = $2`,
			created.Int("id"), requestID); err != nil {
			return err
		}
		result = ClaimResult{OK: true, ID: created.Int("id"), Key: key, Prefix: prefix}
		return nil
	})
	if err != nil {
		return ClaimResult{}, err
	}
	return result, nil
}
