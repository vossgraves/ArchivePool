import { sql } from "drizzle-orm"
import { db } from "./index"

/** Idempotent schema migration, run once per process. See docs/SCHEMA.md. */
const STATEMENTS: string[] = [
  // 2026-08-30: a database recreated from an older schema.sql 500'd the whole auth flow.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ua text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ua text NOT NULL DEFAULT ''`,
  // Same drift class for api_keys.
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT ''`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys (deleted)`,

  // 2026-08: the key request workflow.
  `CREATE TABLE IF NOT EXISTS api_key_requests (
    id               serial PRIMARY KEY,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject          text NOT NULL,
    reason           text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'pending',
    ip_address       text NOT NULL DEFAULT '',
    user_agent       text NOT NULL DEFAULT '',
    resulting_key_id integer REFERENCES api_keys(id) ON DELETE SET NULL,
    review_note      text NOT NULL DEFAULT '',
    reviewed_at      timestamptz,
    reviewed_by      integer REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_requests_user ON api_key_requests (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_ua ON api_key_requests (ip_address, user_agent, status)`,

  // 2026-08-30: the account/instance split.
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

  // One-time copy out of the pre-split table. Preserves ids, so health_log history survives.
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
  // Advance the shared sequence past the migrated ids so new inserts cannot collide.
  `SELECT setval('source_entry_id_seq',
      GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM account_entries),
        (SELECT COALESCE(MAX(id), 0) FROM instance_entries),
        (SELECT COALESCE(MAX(id), 0) FROM source_entries)
      ) + 1, false)`,

  // These sit AFTER the CREATEs above on purpose: the creates are no-ops on an existing
  // database, so an alter placed before one would run against the old shape.
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS contributor text`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS contributor text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT ''`,
  // 2026-09: per-key sticky leases, so one valid key can no longer walk the whole pool.
  `CREATE TABLE IF NOT EXISTS api_key_leases (
    key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
    service   text NOT NULL,
    leased_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_leases_entry ON api_key_leases (entry_id)`,

  // 2026-09-13: contributor-declared expiry, so a lapsed plan stops being leased on time.
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS idx_account_entries_expires ON account_entries (expires_at)`,

  // 2026-09-12: named admins and an audit trail.
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
]

const globalForMigrations = globalThis as unknown as { __poolSchemaEnsured?: Promise<void> }

export function ensureSchema(): Promise<void> {
  globalForMigrations.__poolSchemaEnsured ??= (async () => {
    for (const statement of STATEMENTS) {
      try {
        await db.execute(sql.raw(statement))
      } catch (err) {
        // A concurrent instance running the same statement, or a missing source_entries on a
        // fresh database, must not break the request that triggered the migration.
        console.error("[db] ensureSchema statement failed:", err instanceof Error ? err.message : err)
      }
    }
  })()
  return globalForMigrations.__poolSchemaEnsured
}
