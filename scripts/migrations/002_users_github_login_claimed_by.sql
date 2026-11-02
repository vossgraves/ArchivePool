-- SPDX-License-Identifier: GPL-3.0-or-later
-- Migration 002 — GitHub sign-in auto-accounts + legacy account recovery (2026-11-02).
--
-- Idempotent: safe to run repeatedly and against databases at either side of the
-- change. Also delivered at runtime by lib/db/ensure.ts on first request, so a
-- deployment can rely on that path alone; this file is the reviewable/applied
-- record for Neon.
--
-- What it adds:
--   users.github_login  the GitHub login captured at OAuth time (display/review
--                       only — identity is users.github_id).
--   users.claimed_by    set when a newer account proves ownership of this legacy
--                       account and absorbs its per-user rows (api_keys and
--                       api_key_requests get user_id re-pointed; key_hash stays
--                       the same so existing keys keep working). Claimed rows are
--                       also marked disabled so the shell cannot be reused.

ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_by integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_users_claimed_by ON users (claimed_by);
