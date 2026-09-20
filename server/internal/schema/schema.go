// Package schema is the runtime, idempotent migration that mirrors lib/db/ensure.ts.
//
// ensure.ts is the authoritative runtime list: it self-heals databases created from older
// schema.sql revisions (the 2026-08-30 drift that 500'd the whole auth flow) and adds columns the
// DDL never had (users.role, expires_at, audit_log). migrations/001_schema.sql is applied too, so a
// database that has never seen the app gets the documented fresh-install shape.
package schema

import (
	"context"
	"log"
	"strings"

	"archivepool/server/migrations"
)

// Execer is the slice of *db.DB this package needs.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (string, error)
}

// ensureStatements is lib/db/ensure.ts STATEMENTS, in order. The ordering is load-bearing there:
// the ALTERs sit after the CREATEs because a CREATE IF NOT EXISTS is a no-op on an existing
// database, so an ALTER placed before one would run against the old shape.
var ensureStatements = []string{
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text NOT NULL DEFAULT ''`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ua text NOT NULL DEFAULT ''`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip text NOT NULL DEFAULT ''`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ua text NOT NULL DEFAULT ''`,
	`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`,
	`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT ''`,
	`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`,
	`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys (deleted)`,

	`CREATE TABLE IF NOT EXISTS api_key_requests (
    id               serial PRIMARY KEY,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject          text NOT NULL,
    reason           text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'pending',
    ip_address       text NOT NULL DEFAULT '',
    user_agent       text NOT NULL DEFAULT '',
    resulting_key_id integer REFERENCES api_keys(id) ON DELETE SET NULL,
    requested_service text,
    discord_id       text,
    telegram_id      text,
    contact_note     text,
    review_note      text NOT NULL DEFAULT '',
    reviewed_at      timestamptz,
    reviewed_by      integer REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
  )`,
	`CREATE INDEX IF NOT EXISTS idx_api_key_requests_user ON api_key_requests (user_id, status)`,
	`CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_ua ON api_key_requests (ip_address, user_agent, status)`,

	`CREATE SEQUENCE IF NOT EXISTS source_entry_id_seq`,
	`CREATE TABLE IF NOT EXISTS account_entries (
    id                   integer PRIMARY KEY DEFAULT nextval('source_entry_id_seq'),
    service              text NOT NULL,
    label                text NOT NULL,
    payload              jsonb NOT NULL,
    fingerprint          text NOT NULL UNIQUE,
    status               text NOT NULL DEFAULT 'pending',
    premium              boolean NOT NULL DEFAULT false,
    detail               text,
    latency_ms           integer,
    consecutive_failures integer NOT NULL DEFAULT 0,
    check_count          integer NOT NULL DEFAULT 0,
    ok_count             integer NOT NULL DEFAULT 0,
    disabled             boolean NOT NULL DEFAULT false,
    removed              boolean NOT NULL DEFAULT false,
    contributor          text,
    last_checked_at      timestamptz,
    last_leased_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
  )`,
	`CREATE TABLE IF NOT EXISTS instance_entries (
    id                   integer PRIMARY KEY DEFAULT nextval('source_entry_id_seq'),
    service              text NOT NULL,
    label                text NOT NULL,
    payload              jsonb NOT NULL,
    fingerprint          text NOT NULL UNIQUE,
    status               text NOT NULL DEFAULT 'pending',
    premium              boolean NOT NULL DEFAULT false,
    detail               text,
    latency_ms           integer,
    consecutive_failures integer NOT NULL DEFAULT 0,
    check_count          integer NOT NULL DEFAULT 0,
    ok_count             integer NOT NULL DEFAULT 0,
    disabled             boolean NOT NULL DEFAULT false,
    removed              boolean NOT NULL DEFAULT false,
    contributor          text,
    last_checked_at      timestamptz,
    last_leased_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
  )`,
	`CREATE INDEX IF NOT EXISTS idx_account_entries_service ON account_entries (service)`,
	`CREATE INDEX IF NOT EXISTS idx_account_entries_active ON account_entries (status, disabled, removed)`,
	`CREATE INDEX IF NOT EXISTS idx_account_entries_lease ON account_entries (service, premium DESC, last_leased_at NULLS FIRST)`,
	`CREATE INDEX IF NOT EXISTS idx_instance_entries_service ON instance_entries (service)`,
	`CREATE INDEX IF NOT EXISTS idx_instance_entries_active ON instance_entries (status, disabled, removed)`,
	`CREATE INDEX IF NOT EXISTS idx_instance_entries_lease ON instance_entries (service, premium DESC, last_leased_at NULLS FIRST)`,

	// One-time copy out of the pre-split table. Preserves ids so health_log history survives; on a
	// database that never had source_entries these fail and are logged, exactly as in ensure.ts.
	`INSERT INTO account_entries (id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at)
    SELECT id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at
    FROM source_entries WHERE kind = 'account'
    ON CONFLICT (fingerprint) DO NOTHING`,
	`INSERT INTO instance_entries (id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at)
    SELECT id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at
    FROM source_entries WHERE kind = 'api'
    ON CONFLICT (fingerprint) DO NOTHING`,
	`SELECT setval('source_entry_id_seq',
      GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM account_entries),
        (SELECT COALESCE(MAX(id), 0) FROM instance_entries),
        (SELECT COALESCE(MAX(id), 0) FROM source_entries)
      ) + 1, false)`,

	`ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS contributor text`,
	`ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS contributor text`,
	`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT ''`,
	`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS service text`,
	`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS requested_service text`,
	`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS discord_id text`,
	`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS telegram_id text`,
	`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS contact_note text`,
	`CREATE TABLE IF NOT EXISTS api_key_leases (
    key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
    service   text NOT NULL,
    leased_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, entry_id)
  )`,
	`CREATE INDEX IF NOT EXISTS idx_api_key_leases_entry ON api_key_leases (entry_id)`,

	`ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
	`ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
	`CREATE INDEX IF NOT EXISTS idx_account_entries_expires ON account_entries (expires_at)`,

	`ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'`,
	`CREATE TABLE IF NOT EXISTS audit_log (
    id             serial PRIMARY KEY,
    action         text NOT NULL,
    target         text NOT NULL DEFAULT '',
    actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
    actor_label    text NOT NULL DEFAULT '',
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address     text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
  )`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC)`,
}

// Statements returns every migration statement: the ensure.ts list first (so a drifted database is
// healed before the DDL runs) followed by the verbatim 001_schema.sql statements.
func Statements() []string {
	out := make([]string, 0, len(ensureStatements)+64)
	out = append(out, ensureStatements...)
	out = append(out, SplitStatements(migrations.SchemaSQL)...)
	return out
}

// Ensure applies every statement, logging and continuing on failure. Individual failures are
// expected and harmless (a concurrent instance running the same statement, or a fresh database
// with no legacy source_entries table); a failure must never break the request that triggered it.
func Ensure(ctx context.Context, exec Execer) error {
	for _, statement := range Statements() {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := exec.Exec(ctx, statement); err != nil {
			log.Printf("[db] ensureSchema statement failed: %v", err)
		}
	}
	return nil
}

// SplitStatements strips `--` line comments and splits on `;`. The DDL contains no semicolons
// inside string literals, so this is sufficient and keeps each statement individually retryable.
func SplitStatements(sql string) []string {
	var cleaned strings.Builder
	for _, line := range strings.Split(sql, "\n") {
		if idx := strings.Index(line, "--"); idx >= 0 {
			line = line[:idx]
		}
		cleaned.WriteString(line)
		cleaned.WriteString("\n")
	}
	parts := strings.Split(cleaned.String(), ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}
