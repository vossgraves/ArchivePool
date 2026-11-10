// SPDX-License-Identifier: GPL-3.0-or-later
import { sql } from "drizzle-orm"
import { db } from "./index"
import { kvGetText, kvPutText } from "@/lib/pool-cache"
import { ResourceUnavailable } from "@/lib/resource-budget"
import { cfBindings } from "@/lib/cf-env"

/**
 * Bump whenever a statement is added below. The version is stored in KV after a clean run so
 * the 57 idempotent statements do not run on every cold isolate.
 *
 * Why this is not just an optimisation: Hyperdrive Free meters **every database statement**
 * against 100,000/day (a `CREATE INDEX IF NOT EXISTS` counts even when it is a no-op), and a
 * Workers isolate is short-lived. Running this list on each new isolate burned 57 of those
 * statements per cold start — easily six figures a day across a global worker — which is how
 * the deployment hit Hyperdrive's daily limit and every SQL query started failing.
 *
 * The gate is a KV read (one per isolate), not a query. When KV is absent or unreadable the
 * old run-every-process behaviour returns, so a non-Workers host is unchanged.
 */
export const SCHEMA_VERSION = "2026-11-10.2"
const SCHEMA_MARKER_KEY = "schema:applied"

/** Idempotent schema migration, run once per deploy (Workers) / process (elsewhere). See docs/SCHEMA.md. */
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
  // 2026-09-20: a read key may be scoped to one source; NULL = every service (pre-scope behaviour).
  // The request side also carries the requester's contact details for the admin queue.
  `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS service text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS requested_service text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS discord_id text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS telegram_id text`,
  `ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS contact_note text`,
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

  // 2026-11-01: GitHub sign-in. github_id links an OAuth subject to an account
  // (unique when set — NULLs allowed so password-era rows are unaffected); the claims
  // table holds pending username claims an admin can approve.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id bigint`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users (github_id) WHERE github_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS github_claims (
    id           serial PRIMARY KEY,
    github_id    bigint NOT NULL,
    github_login text NOT NULL DEFAULT '',
    username     text NOT NULL,
    status       text NOT NULL DEFAULT 'pending',
    review_note  text NOT NULL DEFAULT '',
    reviewed_at  timestamptz,
    reviewed_by  integer REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_github_claims_status ON github_claims (status)`,
  // 2026-11-02: the GitHub login captured at OAuth time, and the "claimed by" pointer a
  // legacy account gets when a signed-in user proves ownership and absorbs its rows.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_by integer REFERENCES users(id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_claimed_by ON users (claimed_by)`,

  // 2026-11-02: shared rate-limit counters for the claim endpoint — process-local
  // limits do not hold across Workers isolates, so the claim buckets live here,
  // upserted atomically (see dbRateLimit in lib/rate-limit.ts).
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket       text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    n            integer NOT NULL DEFAULT 0
  )`,

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

  // 2026-11-01: per-entry verify lease for report-driven checks (see app/api/report).
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS verify_lease_until timestamptz`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS verify_lease_until timestamptz`,

  // 2026-11-01: last successful-check timestamp — the report path's park/failure UPDATEs are
  // no-ops when a success newer than the report landed (see app/api/report).
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS last_ok_at timestamptz`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS last_ok_at timestamptz`,

  // 2026-11-01: credential-refresh single-flight + backoff (see lib/health.ts refresh helpers).
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_in_flight_until timestamptz`,
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_cooldown_until timestamptz`,
  // Escalating abuse-hold duration; persisted so expiry does not reset the doubling.
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_backoff_ms integer`,
  `CREATE TABLE IF NOT EXISTS pool_state (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS removed_at timestamptz`,
  `ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS removed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS idx_health_log_retention ON health_log (checked_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_health_log_success ON health_log (entry_id, checked_at DESC) WHERE ok AND premium AND (detail IS NULL OR detail NOT LIKE 'app report%')`,
  `CREATE INDEX IF NOT EXISTS idx_api_key_leases_retention ON api_key_leases (leased_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limit_retention ON rate_limit_buckets (window_start)`,
  `CREATE INDEX IF NOT EXISTS idx_key_requests_retention ON api_key_requests (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_github_claims_retention ON github_claims (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_account_entries_removed ON account_entries (removed_at) WHERE removed`,
  `CREATE INDEX IF NOT EXISTS idx_instance_entries_removed ON instance_entries (removed_at) WHERE removed`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_retention ON audit_log (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_account_entries_contributor ON account_entries (contributor)`,
  `CREATE INDEX IF NOT EXISTS idx_instance_entries_contributor ON instance_entries (contributor)`,
  `CREATE INDEX IF NOT EXISTS idx_instance_entries_expires ON instance_entries (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_key_requests_recent ON api_key_requests (ip_address, user_agent, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_users_recent ON users (created_ip, created_ua, created_at)`,
]

const globalForMigrations = globalThis as unknown as { __poolSchemaEnsured?: Promise<void> }

/**
 * True when this exact schema version already ran to a usable state. Read from KV, never the
 * database: the whole point is to spend zero statements on a warm schema.
 */
async function schemaAlreadyApplied(): Promise<boolean> {
  return (await kvGetText(SCHEMA_MARKER_KEY, true)) === SCHEMA_VERSION
}

export function ensureSchema(): Promise<void> {
  globalForMigrations.__poolSchemaEnsured ??= (async () => {
    if (await schemaAlreadyApplied()) return
    // Even a once-only DDL pass exceeds Free's CPU allowance. Apply migrations outside
    // Workers and publish the marker after rollout; reads never bootstrap a database.
    if (cfBindings()) throw new ResourceUnavailable()

    let failed = 0
    for (const statement of STATEMENTS) {
      try {
        await db.execute(sql.raw(statement))
      } catch (err) {
        failed++
        // A concurrent instance running the same statement, or a missing source_entries on a
        // fresh database, must not break the request that triggered the migration.
        console.error("[db] ensureSchema statement failed:", err instanceof Error ? err.message : err)
      }
    }

    // Only mark a *usable* schema. The legacy-copy INSERTs are expected to fail on a fresh
    // database (there is no source_entries), so failures alone are not disqualifying — but a
    // database that cannot answer even one trivial read is, and marking it would cache an
    // outage as "migrated" for the lifetime of the version. A clean statement pass is also
    // enough on its own: if the verification query is what hit the Hyperdrive cap, the schema
    // itself did apply and every later isolate should skip the 57 statements.
    let usable = failed === 0
    if (!usable) {
      try {
        await db.execute(sql`select 1 from account_entries limit 1`)
        usable = true
      } catch (err) {
        console.error("[db] ensureSchema verification failed:", err instanceof Error ? err.message : err)
      }
    }
    if (usable) {
      await kvPutText(SCHEMA_MARKER_KEY, SCHEMA_VERSION)
      if (failed > 0) {
        console.error(
          `[db] ensureSchema marked ${SCHEMA_VERSION} applied with ${failed} best-effort statement(s) failed`,
        )
      }
    }
  })()
  return globalForMigrations.__poolSchemaEnsured
}
