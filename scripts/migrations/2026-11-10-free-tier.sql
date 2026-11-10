-- SPDX-License-Identifier: GPL-3.0-or-later
ALTER TABLE account_entries ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE instance_entries ADD COLUMN IF NOT EXISTS removed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_health_log_retention ON health_log (checked_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_health_log_success ON health_log (entry_id, checked_at DESC) WHERE ok AND premium AND (detail IS NULL OR detail NOT LIKE 'app report%');
CREATE INDEX IF NOT EXISTS idx_api_key_leases_retention ON api_key_leases (leased_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_retention ON rate_limit_buckets (window_start);
CREATE INDEX IF NOT EXISTS idx_key_requests_retention ON api_key_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_github_claims_retention ON github_claims (created_at);
CREATE INDEX IF NOT EXISTS idx_account_entries_removed ON account_entries (removed_at) WHERE removed;
CREATE INDEX IF NOT EXISTS idx_instance_entries_removed ON instance_entries (removed_at) WHERE removed;
