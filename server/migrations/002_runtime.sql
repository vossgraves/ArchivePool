-- SPDX-License-Identifier: GPL-3.0-or-later
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ua text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ua text NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys (deleted);
CREATE TABLE IF NOT EXISTS api_key_requests (
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
  );
CREATE INDEX IF NOT EXISTS idx_api_key_requests_user ON api_key_requests (user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_ua ON api_key_requests (ip_address, user_agent, status);
CREATE SEQUENCE IF NOT EXISTS source_entry_id_seq;
CREATE TABLE IF NOT EXISTS account_entries (
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
  );
CREATE TABLE IF NOT EXISTS instance_entries (
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
  );
CREATE INDEX IF NOT EXISTS idx_account_entries_service ON account_entries (service);
CREATE INDEX IF NOT EXISTS idx_account_entries_active ON account_entries (status, disabled, removed);
CREATE INDEX IF NOT EXISTS idx_account_entries_lease ON account_entries (service, premium DESC, last_leased_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_instance_entries_service ON instance_entries (service);
CREATE INDEX IF NOT EXISTS idx_instance_entries_active ON instance_entries (status, disabled, removed);
CREATE INDEX IF NOT EXISTS idx_instance_entries_lease ON instance_entries (service, premium DESC, last_leased_at NULLS FIRST);
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS contributor text;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS contributor text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS service text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS requested_service text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS discord_id text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS telegram_id text;
ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS contact_note text;
CREATE TABLE IF NOT EXISTS api_key_leases (
    key_id    integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    entry_id  integer NOT NULL REFERENCES account_entries(id) ON DELETE CASCADE,
    service   text NOT NULL,
    leased_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, entry_id)
  );
CREATE INDEX IF NOT EXISTS idx_api_key_leases_entry ON api_key_leases (entry_id);
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_account_entries_expires ON account_entries (expires_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users (github_id) WHERE github_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS github_claims (
    id           serial PRIMARY KEY,
    github_id    bigint NOT NULL,
    github_login text NOT NULL DEFAULT '',
    username     text NOT NULL,
    status       text NOT NULL DEFAULT 'pending',
    review_note  text NOT NULL DEFAULT '',
    reviewed_at  timestamptz,
    reviewed_by  integer REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  );
CREATE INDEX IF NOT EXISTS idx_github_claims_status ON github_claims (status);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_by integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_users_claimed_by ON users (claimed_by);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket       text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    n            integer NOT NULL DEFAULT 0
  );
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS audit_log (
    id             serial PRIMARY KEY,
    action         text NOT NULL,
    target         text NOT NULL DEFAULT '',
    actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
    actor_label    text NOT NULL DEFAULT '',
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address     text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
  );
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC);
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS verify_lease_until timestamptz;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS verify_lease_until timestamptz;
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS last_ok_at timestamptz;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS last_ok_at timestamptz;
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_in_flight_until timestamptz;
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_cooldown_until timestamptz;
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS refresh_backoff_ms integer;
CREATE TABLE IF NOT EXISTS pool_state (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
DO $$ BEGIN
IF to_regclass('public.source_entries') IS NOT NULL THEN
INSERT INTO account_entries (id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at)
    SELECT id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at
    FROM source_entries WHERE kind = 'account'
    ON CONFLICT (fingerprint) DO NOTHING;
INSERT INTO instance_entries (id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at)
    SELECT id, service, label, payload, fingerprint, status, premium, detail,
      latency_ms, consecutive_failures, check_count, ok_count, disabled, removed,
      last_checked_at, last_leased_at, created_at
    FROM source_entries WHERE kind = 'api'
    ON CONFLICT (fingerprint) DO NOTHING;
SELECT setval('source_entry_id_seq',
      GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM account_entries),
        (SELECT COALESCE(MAX(id), 0) FROM instance_entries),
        (SELECT COALESCE(MAX(id), 0) FROM source_entries)
      ) + 1, false);
END IF; END $$;
CREATE TABLE IF NOT EXISTS job_locks (name text PRIMARY KEY, holder text NOT NULL, expires_at timestamptz NOT NULL);
