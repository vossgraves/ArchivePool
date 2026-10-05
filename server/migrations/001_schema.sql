-- SPDX-License-Identifier: GPL-3.0-or-later
-- ArchivePool database schema
-- Run this once against your Postgres database (Neon, Supabase, plain Postgres, etc.)
-- e.g.  psql "$DATABASE_URL" -f scripts/schema.sql

-- ============================================================================
-- Pool storage is SPLIT BY CREDENTIAL TYPE (2026-08-30):
--   account_entries  → contributed account credentials (tokens/ARLs/secrets). Payloads are
--                      AES-256-GCM encrypted at rest with POOL_ENCRYPTION_KEY (field-level;
--                      see lib/crypto.ts). Only /api/accounts serves them, re-encrypted
--                      end-to-end with POOL_CLIENT_KEY.
--   instance_entries → contributed instance base URLs. baseUrl stays readable for discovery;
--                      sensitive extras (note) are encrypted.
--
-- Both tables share the `source_entry_id_seq` sequence so an id is globally unique across
-- them — health_log.entry_id, /api/report and the admin endpoints stay unambiguous.
--
-- The legacy mixed `source_entries` table is NOT created for fresh installs. Deployments
-- upgrading from the pre-split schema: see "Upgrading from the original schema" below.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS source_entry_id_seq;

CREATE TABLE IF NOT EXISTS account_entries (
  id                   integer PRIMARY KEY DEFAULT nextval('source_entry_id_seq'),
  service              text NOT NULL,                       -- 'tidal' | 'qobuz' | 'deezer' | 'apple-music'
  label                text NOT NULL,                       -- masked, safe to show publicly
  payload              jsonb NOT NULL,                       -- ENCRYPTED credentials, never shown publicly
  fingerprint          text NOT NULL UNIQUE,                 -- dedupe key
  status               text NOT NULL DEFAULT 'pending',      -- pending | alive | preview | dead
  premium              boolean NOT NULL DEFAULT false,
  detail               text,
  latency_ms           integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  check_count          integer NOT NULL DEFAULT 0,
  ok_count             integer NOT NULL DEFAULT 0,
  disabled             boolean NOT NULL DEFAULT false,       -- auto-disabled by health checks
  removed              boolean NOT NULL DEFAULT false,       -- hard-removed by admin
  last_checked_at      timestamptz,
  last_leased_at       timestamptz,                          -- least-recently-leased rotation
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instance_entries (
  id                   integer PRIMARY KEY DEFAULT nextval('source_entry_id_seq'),
  service              text NOT NULL,                       -- 'tidal' | 'qobuz'
  label                text NOT NULL,
  payload              jsonb NOT NULL,                       -- { baseUrl, healthPath?, note? }
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
);

CREATE INDEX IF NOT EXISTS idx_account_entries_service ON account_entries (service);
CREATE INDEX IF NOT EXISTS idx_account_entries_active ON account_entries (status, disabled, removed);
-- Supports the lease query's "premium first, then least recently leased" ordering.
CREATE INDEX IF NOT EXISTS idx_account_entries_lease ON account_entries (service, premium DESC, last_leased_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_instance_entries_service ON instance_entries (service);
CREATE INDEX IF NOT EXISTS idx_instance_entries_active ON instance_entries (status, disabled, removed);
CREATE INDEX IF NOT EXISTS idx_instance_entries_lease ON instance_entries (service, premium DESC, last_leased_at NULLS FIRST);

-- Per-check health history (used for the aggregate public status). entry_id is globally unique
-- across account_entries + instance_entries thanks to the shared id sequence.
CREATE TABLE IF NOT EXISTS health_log (
  id         serial PRIMARY KEY,
  entry_id   integer NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL,
  premium    boolean NOT NULL DEFAULT false,
  latency_ms integer,
  detail     text
);

CREATE INDEX IF NOT EXISTS idx_health_log_entry ON health_log (entry_id, checked_at);

-- Per-app read keys. Apps present these to read the sensitive pool JSON (/api/accounts,
-- /api/sources, /api/discovery/*). User identity lives ONLY in `users`; pool tables never
-- reference it — the two data domains are fully separate.
-- Only the SHA-256 hash of the key is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  revoked      boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  use_count    integer NOT NULL DEFAULT 0,
  service      text,                                  -- NULL = every service; else the one this key may read
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Site accounts: username + password (scrypt hash), used to request/manage API keys.
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,                        -- scrypt: N:r:p:salt:hash (hex parts)
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Keys belong to a user (NULL = legacy/admin-created key, visible only in /admin).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys (deleted);

-- User IP/UA tracking for abuse prevention.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ua text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ua text NOT NULL DEFAULT '';

-- API key requests: subject + reason workflow with admin approval.
-- Enforces 1 request per IP+UA (see lib/api-keys.ts countRequestsByIpUa).
CREATE TABLE IF NOT EXISTS api_key_requests (
  id               serial PRIMARY KEY,
  user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject          text NOT NULL,
  reason           text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  ip_address       text NOT NULL DEFAULT '',
  user_agent       text NOT NULL DEFAULT '',
  resulting_key_id integer REFERENCES api_keys(id) ON DELETE SET NULL,
  requested_service text,                              -- NULL = any service; else the one requested
  discord_id        text,                             -- how to reach the requester; optional
  telegram_id       text,
  contact_note      text,
  reviewed_at      timestamptz,
  reviewed_by      integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_user ON api_key_requests (user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_ua ON api_key_requests (ip_address, user_agent, status);

-- Post-release columns (same set lib/db/ensure.ts self-heals on deploy).
-- review_note: the reason an admin gives when rejecting a request; shown to the requester.
-- contributor: username a logged-in contributor OPTED IN to be credited by (NULL = anonymous).
--   It is display-only — never included in a feed handed to apps.
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS contributor text;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS contributor text;

-- Scoped read keys (2026-09-20). `service` NULL is every service, i.e. the pre-scope behaviour, so
-- the column adds no backfill. The request side records what was asked for plus the requester's
-- contact details; the admin queue reads all four.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS service text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS requested_service text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS discord_id text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS telegram_id text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS contact_note text;

-- Per-read-key sticky leases: which account_entries a key currently holds. A key keeps the same
-- entries until they expire (LEASE_TTL_HOURS, lib/queries.ts) or the app reports one dead/
-- not_premium via /api/report, which releases the row. Not exclusive -- several keys may hold
-- the same entry; this is a stickiness hint, not a mutex. `service` is denormalized from the
-- entry so /api/report can cap replacements per service without a join.
CREATE TABLE IF NOT EXISTS api_key_leases (
  key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
  service   text NOT NULL,
  leased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_api_key_leases_entry ON api_key_leases (entry_id);

-- ============================================================================
-- Upgrading from the original (pre-split) schema
-- ============================================================================
-- The app also runs this migration automatically on first request after deploy (see
-- lib/db/ensure.ts), so running it manually is optional. Manual equivalent:
--
--   INSERT INTO account_entries (id, service, label, payload, fingerprint, status, premium,
--       detail, latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
--       last_checked_at, last_leased_at, created_at)
--     SELECT id, service, label, payload, fingerprint, status, premium,
--       detail, latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
--       last_checked_at, last_leased_at, created_at
--     FROM source_entries WHERE kind = 'account'
--     ON CONFLICT (fingerprint) DO NOTHING;
--
--   INSERT INTO instance_entries (id, service, label, payload, fingerprint, status, premium,
--       detail, latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
--       last_checked_at, last_leased_at, created_at)
--     SELECT id, service, label, payload, fingerprint, status, premium,
--       detail, latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
--       last_checked_at, last_leased_at, created_at
--     FROM source_entries WHERE kind = 'api'
--     ON CONFLICT (fingerprint) DO NOTHING;
--
--   SELECT setval('source_entry_id_seq',
--       GREATEST((SELECT COALESCE(MAX(id),0) FROM account_entries),
--                (SELECT COALESCE(MAX(id),0) FROM instance_entries),
--                (SELECT COALESCE(MAX(id),0) FROM source_entries)) + 1, false);
--
-- After verifying the row counts match, drop the legacy table (application code no longer
-- reads or writes it):
--
--   DROP TABLE source_entries;
-- ============================================================================
