import { sql } from "drizzle-orm"
import { db } from "./index"

/**
 * Idempotent schema migration, run lazily before the first query that needs a table.
 *
 * The pool ships `scripts/schema.sql` for fresh installs, but already-deployed databases
 * never see new tables added to it — which is exactly how live deployments end up 500ing
 * ("unknown error") on features added after the initial rollout. Instead of requiring a
 * manual migration step on the production database, every table introduced later gets a
 * `CREATE TABLE IF NOT EXISTS` here, executed once per process (memoized below).
 */
const STATEMENTS: string[] = [
  // Added 2026-08: API key request workflow (request → admin approval).
  `CREATE TABLE IF NOT EXISTS api_key_requests (
    id               serial PRIMARY KEY,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject          text NOT NULL,
    reason           text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'pending',
    ip_address       text NOT NULL DEFAULT '',
    user_agent       text NOT NULL DEFAULT '',
    resulting_key_id integer REFERENCES api_keys(id) ON DELETE SET NULL,
    reviewed_at      timestamptz,
    reviewed_by      integer REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_requests_user ON api_key_requests (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_ua ON api_key_requests (ip_address, user_agent, status)`,

  // Added 2026-08-30: split the pool into separate account (token) and instance (URL) tables.
  // Shared id sequence keeps ids globally unique across both, so health_log.entry_id and the
  // report/admin endpoints stay unambiguous.
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

  // One-time data migration from the pre-split table. Idempotent (fingerprint conflict ⇒ skip),
  // preserves ids (and therefore health_log history). Runs on every deploy but is a no-op once
  // the rows are copied; new writes only ever go to the split tables, so source_entries goes
  // stale afterwards and can be dropped manually once verified.
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
  // Migrated rows carry their old ids; advance the shared sequence past them so new inserts
  // never collide.
  `SELECT setval('source_entry_id_seq',
      GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM account_entries),
        (SELECT COALESCE(MAX(id), 0) FROM instance_entries),
        (SELECT COALESCE(MAX(id), 0) FROM source_entries)
      ) + 1, false)`,
]

const globalForMigrations = globalThis as unknown as { __poolSchemaEnsured?: Promise<void> }

export function ensureSchema(): Promise<void> {
  globalForMigrations.__poolSchemaEnsured ??= (async () => {
    for (const statement of STATEMENTS) {
      try {
        await db.execute(sql.raw(statement))
      } catch (err) {
        // Never break the request that triggered the migration because of a race with
        // another instance running the same CREATE IF NOT EXISTS concurrently. The data
        // migration statements can also fail harmlessly when source_entries does not
        // exist yet on a fresh database — the split tables are then simply empty.
        console.error("[db] ensureSchema statement failed:", err instanceof Error ? err.message : err)
      }
    }
  })()
  return globalForMigrations.__poolSchemaEnsured
}
