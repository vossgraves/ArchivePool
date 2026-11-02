-- SPDX-License-Identifier: GPL-3.0-or-later
-- Migration 003 — shared rate-limit buckets for the legacy-claim endpoint (2026-11-02).
--
-- Idempotent: safe to run repeatedly. Also delivered at runtime by lib/db/ensure.ts.
--
-- The claim endpoint's rate limits (per user, per target username, per IP) cannot
-- live in process memory: Workers isolates do not share it, so the effective ceiling
-- would be limit × isolate-count and a determined claim brute-force would slip
-- under it. One row per bucket, upserted atomically inside the limit check
-- (dbRateLimit in lib/rate-limit.ts); when window_start ages past the window the
-- same upsert resets it.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket       text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  n            integer NOT NULL DEFAULT 0
);
