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
  // Added 2026-08-30: users IP/UA columns. Discovered on production: the database was recreated
  // from an older schema.sql that predated these ALTERs, so `select *`-shaped Drizzle queries on
  // users (login, signup) failed with "column does not exist" → HTTP 500 on the entire auth
  // flow while every other table kept working. Schema drift on any recreated database now
  // self-heals on first request instead of taking the dashboard down.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ua text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ua text NOT NULL DEFAULT ''`,
  // Same drift class for api_keys (reason/deleted/user_id were added post-release; the key
  // dashboard and per-user key ownership 500 without them on an old-schema database). The
  // ADD COLUMN form carries its FK constraint along when the column is genuinely missing.
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT ''`,
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys (deleted)`,

  // Added 2026-08: API key request workflow (request → admin approval).
  // `review_note` (added 2026-09-02) carries the rejection reason an admin sends to the requester.
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

  // Added 2026-09-02: opt-in contributor credit, and the admin's rejection note. These sit AFTER
  // the CREATE TABLE statements above on purpose — a database created by an older release (or by
  // an old scripts/schema.sql) has the tables but not these columns, and the CREATEs are no-ops
  // there. Without the ALTERs the first credited contribution would fail with "column
  // \"contributor\" does not exist" and take the submit flow down.
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS contributor text`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS contributor text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT ''`,
  // Added 2026-09: per-read-key sticky leases. Before this, every /api/accounts fetch reshuffled
  // which credentials a key held via the global last_leased_at rotation, so a single valid key
  // could walk the entire pool a few entries at a time. Now a key keeps the same entries until
  // they expire (LEASE_TTL_HOURS) or the app reports one dead/not_premium via /api/report.
  // ON DELETE CASCADE on both sides keeps the table self-cleaning if a key or entry is ever
  // hard-deleted (today both are soft-flagged, so this is a safety net, not the primary path).
  `CREATE TABLE IF NOT EXISTS api_key_leases (
    key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
    service   text NOT NULL,
    leased_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_leases_entry ON api_key_leases (entry_id)`,
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
