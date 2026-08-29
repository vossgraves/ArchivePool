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
]

const globalForMigrations = globalThis as unknown as { __poolSchemaEnsured?: Promise<void> }

export function ensureSchema(): Promise<void> {
  globalForMigrations.__poolSchemaEnsured ??= (async () => {
    for (const statement of STATEMENTS) {
      try {
        await db.execute(sql.raw(statement))
      } catch (err) {
        // Never break the request that triggered the migration because of a race with
        // another instance running the same CREATE IF NOT EXISTS concurrently.
        console.error("[db] ensureSchema statement failed:", err instanceof Error ? err.message : err)
      }
    }
  })()
  return globalForMigrations.__poolSchemaEnsured
}
