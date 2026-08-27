-- ArchivePool database schema
-- Run this once against your Postgres database (Neon, Supabase, plain Postgres, etc.)
-- e.g.  psql "$DATABASE_URL" -f scripts/schema.sql

-- Contributed source entries (Tidal/Qobuz API instances + accounts).
CREATE TABLE IF NOT EXISTS source_entries (
  id                   serial PRIMARY KEY,
  service              text NOT NULL,                       -- 'tidal' | 'qobuz'
  kind                 text NOT NULL,                       -- 'api' | 'account'
  label                text NOT NULL,
  payload              jsonb NOT NULL,                       -- sensitive material, never shown publicly
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

-- Added after the initial release; safe to re-run on an existing database.
ALTER TABLE source_entries ADD COLUMN IF NOT EXISTS last_leased_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_source_entries_service_kind ON source_entries (service, kind);
CREATE INDEX IF NOT EXISTS idx_source_entries_active ON source_entries (status, disabled, removed);
-- Supports the lease query's "premium first, then least recently leased" ordering.
CREATE INDEX IF NOT EXISTS idx_source_entries_lease ON source_entries (service, kind, premium DESC, last_leased_at NULLS FIRST);

-- Per-check health history (used for the aggregate public status).
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

-- Per-app read keys. Apps present these to read the sensitive pool JSON.
-- Only the SHA-256 hash is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  revoked      boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  use_count    integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Added 2026-08-26: user accounts + ownership of API keys.
-- Users sign up on the site (username + password) and request API keys from /dashboard.
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
