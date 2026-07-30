#!/usr/bin/env bash
#
# One-shot bootstrap: deploy ArchivePool to Vercel, wire up every secret, schedule the health
# sweep, and repoint the Android app at the new URL.
#
# Idempotent -- safe to re-run. Existing Vercel env vars are replaced, not duplicated.
#
#   VERCEL_TOKEN=...            (required) https://vercel.com/account/tokens
#   POOL_ENCRYPTION_KEY=...     (required) COPY VERBATIM from the old host, see below
#   POOL_CLIENT_KEY=...         (required) COPY VERBATIM from the old host
#   DATABASE_URL=...            (required) pooled Postgres URL
#   ADMIN_TOKEN=...             (optional) generated if unset
#   CRON_SECRET=...             (optional) generated if unset
#   VERCEL_SCOPE=...            (optional) team slug/id
#   REPO=owner/name             (optional) defaults to vossgraves/ArchivePool
#   APP_REPO=owner/name         (optional) Android repo to repoint, "" to skip
#
# Usage:
#   export VERCEL_TOKEN=... POOL_ENCRYPTION_KEY=... POOL_CLIENT_KEY=... DATABASE_URL=...
#   ./scripts/deploy-vercel.sh
#
set -euo pipefail

REPO="${REPO:-vossgraves/ArchivePool}"
APP_REPO="${APP_REPO-vossgraves/ArchiveTune}"
PROJECT="${PROJECT:-archivepool}"

die()  { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }

vc() { vercel --token "$VERCEL_TOKEN" ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} "$@"; }

# ---------------------------------------------------------------------------
step "preflight"

[ -n "${VERCEL_TOKEN:-}" ] || die "VERCEL_TOKEN is not set. Create one at https://vercel.com/account/tokens"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. Use a POOLED connection string -- a direct
         one exhausts the connection limit under serverless (Neon: the -pooler host;
         Supabase: the port-6543 transaction pooler)."

# These two are load-bearing for existing data and must never be auto-generated. 13 of the ~16
# source_entries rows hold AES-GCM ciphertext keyed to POOL_ENCRYPTION_KEY; a fresh key makes every
# stored Tidal/Qobuz account permanently undecryptable. POOL_CLIENT_KEY must equal the Android
# app's BuildConfig.POOL_CLIENT_KEY or the app cannot decrypt the feed at all.
for v in POOL_ENCRYPTION_KEY POOL_CLIENT_KEY; do
  [ -n "${!v:-}" ] || die "$v is not set.

         Copy it VERBATIM from the host you are migrating off (Railway -> Variables tab).
         This script refuses to generate one: a new POOL_ENCRYPTION_KEY permanently destroys
         every encrypted account already in the database, and a mismatched POOL_CLIENT_KEY
         silently breaks the feed for every app install."
done

command -v vercel >/dev/null || die "vercel CLI not found: npm i -g vercel"
command -v gh     >/dev/null || die "gh CLI not found"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated: gh auth login"
ok "tokens present, CLIs ready"

ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -base64 32)}"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -base64 32)}"
# Only the hash reaches the server, so an environment leak yields nothing usable. Presenting the
# hash itself is rejected by lib/admin-auth.ts.
ADMIN_TOKEN_HASH="$(printf %s "$ADMIN_TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')"
ok "admin token + cron secret ready"

# ---------------------------------------------------------------------------
step "link vercel project"

vc link --yes --project "$PROJECT" >/dev/null 2>&1 || die "vercel link failed -- is VERCEL_TOKEN valid?"
ok "linked to $PROJECT"

# ---------------------------------------------------------------------------
step "set environment variables"

# `env add` has no --force, so replace = remove then add. printf (not echo) avoids appending a
# newline into the secret value, which would silently corrupt every hash comparison.
set_env() {
  local key="$1" val="$2"
  for tgt in production preview development; do
    vc env remove "$key" "$tgt" --yes >/dev/null 2>&1 || true
    printf %s "$val" | vc env add "$key" "$tgt" >/dev/null 2>&1 \
      || warn "could not set $key ($tgt)"
  done
  ok "$key"
}

set_env DATABASE_URL        "$DATABASE_URL"
set_env ADMIN_TOKEN_HASH    "$ADMIN_TOKEN_HASH"
set_env CRON_SECRET         "$CRON_SECRET"
set_env POOL_ENCRYPTION_KEY "$POOL_ENCRYPTION_KEY"
set_env POOL_CLIENT_KEY     "$POOL_CLIENT_KEY"
set_env READ_KEYS_ENFORCED  "true"

# Belt and braces: the plaintext fallback must not linger once the hash is in place, or a stale
# value would keep working as a second valid credential.
for tgt in production preview development; do
  vc env remove ADMIN_TOKEN "$tgt" --yes >/dev/null 2>&1 && ok "removed legacy plaintext ADMIN_TOKEN ($tgt)" || true
done

# ---------------------------------------------------------------------------
step "apply database schema"

SCHEMA="$(dirname "$0")/schema.sql"

# schema.sql is CREATE TABLE IF NOT EXISTS throughout, so this is safe against a populated
# database -- it creates what is missing and leaves existing rows alone.
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SCHEMA" \
    && ok "schema applied via psql (existing data untouched)" \
    || warn "schema apply failed; run manually: psql \"\$DATABASE_URL\" -f scripts/schema.sql"
elif [ -d node_modules/pg ]; then
  # psql is often absent on CI images, but `pg` is already a dependency of this project.
  DATABASE_URL="$DATABASE_URL" SCHEMA_PATH="$SCHEMA" node -e '
    const {Client} = require("pg");
    const sql = require("fs").readFileSync(process.env.SCHEMA_PATH, "utf8");
    const c = new Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
    c.connect().then(() => c.query(sql)).then(() => c.end())
     .then(() => process.exit(0))
     .catch(e => { console.error(e.message); process.exit(1); });
  ' >/dev/null 2>&1 \
    && ok "schema applied via node/pg (existing data untouched)" \
    || warn "schema apply failed -- run scripts/schema.sql against the database manually"
else
  warn "no psql and no node_modules -- run once: psql \"\$DATABASE_URL\" -f scripts/schema.sql"
fi

# ---------------------------------------------------------------------------
step "deploy"

# Progress goes to stderr and the URL to stdout, but grep for the URL rather than trusting the
# last line -- a trailing hint or blank line would otherwise be captured as the hostname.
DEPLOY_URL="$(vc deploy --prod 2>/dev/null | grep -oE 'https://[A-Za-z0-9._-]+' | tail -1)"
[ -n "$DEPLOY_URL" ] || die "deploy produced no URL. Run 'vercel deploy --prod' directly to see why
         (most often: the build failed, or the token lacks access to the project)."
ok "deployed: $DEPLOY_URL"

# ---------------------------------------------------------------------------
step "verify the deployment actually works"

check() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }

code="$(check "$DEPLOY_URL/api/status")"
[ "$code" = "200" ] && ok "/api/status -> 200" || warn "/api/status -> $code"

# The admin surface must reject a bad token. A 500 here means the auth path is broken; a 200
# would mean it is wide open.
code="$(check -H 'Authorization: Bearer definitely-wrong' "$DEPLOY_URL/api/admin/keys")"
case "$code" in
  401) ok "admin rejects bad token (401, fails closed)" ;;
  200) die "admin route accepted a WRONG token -- do not use this deployment" ;;
  *)   warn "admin route returned $code (expected 401)" ;;
esac

code="$(check -H "Authorization: Bearer $ADMIN_TOKEN" "$DEPLOY_URL/api/admin/keys")"
[ "$code" = "200" ] && ok "admin accepts the real token (200)" \
  || warn "admin rejected the real token ($code) -- check ADMIN_TOKEN_HASH"

# ---------------------------------------------------------------------------
step "schedule the health sweep"

# vercel.json intentionally has no crons block: on the Hobby plan a cron more frequent than once
# per DAY makes the deployment fail outright, and daily is far too coarse for a pool sweep. These
# workflows are the real scheduler and only need a URL + shared secret.
gh secret set HEALTH_URL  --repo "$REPO" --body "$DEPLOY_URL" >/dev/null 2>&1 && ok "HEALTH_URL secret set"  || warn "could not set HEALTH_URL"
gh secret set CRON_SECRET --repo "$REPO" --body "$CRON_SECRET" >/dev/null 2>&1 && ok "CRON_SECRET secret set" || warn "could not set CRON_SECRET"

gh workflow run health-cron.yml --repo "$REPO" >/dev/null 2>&1 \
  && ok "triggered an immediate health sweep" \
  || warn "could not trigger health-cron.yml (run it from the Actions tab)"

# ---------------------------------------------------------------------------
step "repoint the Android app"

if [ -z "${APP_REPO:-}" ]; then
  warn "APP_REPO empty -- skipping"
else
  # Precedence in build.gradle.kts is local.properties -> env var -> baked default. Setting the
  # repo variable overrides the default for CI builds without a code change, so a wrong value is
  # trivially reversible.
  gh variable set SOURCE_PROVIDER_URL --repo "$APP_REPO" --body "$DEPLOY_URL" >/dev/null 2>&1 \
    && ok "SOURCE_PROVIDER_URL variable set on $APP_REPO -- CI builds now use Vercel" \
    || warn "could not set SOURCE_PROVIDER_URL on $APP_REPO"
fi

# ---------------------------------------------------------------------------
cat <<EOF

=======================================================================
 done -- $DEPLOY_URL
=======================================================================

 SAVE YOUR ADMIN TOKEN. Only its hash is stored server-side, so this
 value cannot be recovered:

   $ADMIN_TOKEN

 Log in at $DEPLOY_URL/admin

 Remaining manual steps:
   - Rotate the old host's database password if its URL was ever shared.
   - Tear down the Railway service once you have confirmed this works.

EOF
