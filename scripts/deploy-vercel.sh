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

# Prefer an explicit token, but fall back to an existing `vercel login` session. The device-code
# flow is the nicer path anyway: the credential lands in ~/.vercel instead of your shell history.
vc() {
  vercel ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} "$@"
}

# ---------------------------------------------------------------------------
step "preflight"

command -v vercel >/dev/null || die "vercel CLI not found: npm i -g vercel"
if [ -z "${VERCEL_TOKEN:-}" ]; then
  vercel whoami >/dev/null 2>&1 \
    || die "not authenticated. Either run 'vercel login' (device-code flow, works headlessly)
         or set VERCEL_TOKEN from https://vercel.com/account/tokens"
  ok "using existing vercel login ($(vercel whoami 2>/dev/null | tail -1))"
fi

# --- pull the carry-over secrets straight off the old host, if we can ------------------------
# POOL_ENCRYPTION_KEY / POOL_CLIENT_KEY / DATABASE_URL must survive the move unchanged, and
# copy-pasting them by hand is exactly where a typo silently corrupts the pool. If the Railway CLI
# is installed and logged in, read the live values instead of asking for them.
RAILWAY_JSON=""
railway_fetch() {
  command -v railway >/dev/null 2>&1 || return 1
  [ -n "$RAILWAY_JSON" ] && return 0
  RAILWAY_JSON="$(railway variable list --json \
      ${RAILWAY_PROJECT:+--project "$RAILWAY_PROJECT"} \
      ${RAILWAY_SERVICE:+--service "$RAILWAY_SERVICE"} \
      ${RAILWAY_ENVIRONMENT:+--environment "$RAILWAY_ENVIRONMENT"} 2>/dev/null)" || return 1
  [ -n "$RAILWAY_JSON" ] || return 1
  return 0
}
# Parsed with node rather than jq: node is already a dependency of this project, jq often is not.
rw_get() {
  printf %s "$RAILWAY_JSON" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const v = JSON.parse(s)[process.argv[1]];
        if (typeof v === "string" && v.length) process.stdout.write(v);
      } catch {}
    });' "$1" 2>/dev/null
}

if [ -z "${POOL_ENCRYPTION_KEY:-}" ] || [ -z "${POOL_CLIENT_KEY:-}" ] || [ -z "${DATABASE_URL:-}" ]; then
  if railway_fetch; then
    for v in POOL_ENCRYPTION_KEY POOL_CLIENT_KEY DATABASE_URL; do
      if [ -z "${!v:-}" ]; then
        val="$(rw_get "$v")"
        [ -n "$val" ] && { export "$v=$val"; ok "$v pulled from Railway"; }
      fi
    done
  else
    warn "Railway CLI unavailable or not linked -- expecting the secrets in the environment"
  fi
fi

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. Use a POOLED connection string -- a direct
         one exhausts the connection limit under serverless (Neon: the -pooler host;
         Supabase: the port-6543 transaction pooler)."

# These two are load-bearing for existing data and must never be auto-generated. Most
# source_entries rows hold AES-GCM ciphertext keyed to POOL_ENCRYPTION_KEY; a fresh key makes every
# stored Tidal/Qobuz account permanently undecryptable. POOL_CLIENT_KEY must equal the Android
# app's BuildConfig.POOL_CLIENT_KEY or the app cannot decrypt the feed at all.
for v in POOL_ENCRYPTION_KEY POOL_CLIENT_KEY; do
  [ -n "${!v:-}" ] || die "$v is not set, and could not be read from Railway.

         Copy it VERBATIM from the host you are migrating off (Railway -> Variables tab), or run
         'railway login' first so this script can read it directly. It refuses to generate one:
         a new POOL_ENCRYPTION_KEY permanently destroys every encrypted account already in the
         database, and a mismatched POOL_CLIENT_KEY silently breaks the feed for every install."
done

# GitHub access is used only to store the cron secrets and repoint the app. That is genuinely
# optional work, so a missing/unauthenticated gh must not abort the deployment itself -- it
# degrades to printing the two commands to run by hand.
GH_OK=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_OK=1
  ok "gh authenticated"
else
  warn "gh unavailable or unauthenticated -- will skip the GitHub steps and print them instead"
fi
ok "preflight complete"

ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -base64 32)}"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -base64 32)}"
# Only the hash reaches the server, so an environment leak yields nothing usable. Presenting the
# hash itself is rejected by lib/admin-auth.ts.
ADMIN_TOKEN_HASH="$(printf %s "$ADMIN_TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')"
ok "admin token + cron secret ready"

# ---------------------------------------------------------------------------
step "link vercel project"

# On a first run the project does not exist yet, so create it before linking. `project add` is a
# no-op error if it already exists, which is why its failure is ignored rather than fatal.
if ! vc link --yes --project "$PROJECT" >/dev/null 2>&1; then
  vc project add "$PROJECT" >/dev/null 2>&1 || true
  vc link --yes --project "$PROJECT" >/dev/null 2>&1 \
    || die "could not link or create the Vercel project '$PROJECT'.
         Run 'vercel link --project $PROJECT' directly to see the underlying error."
fi
ok "linked to $PROJECT"

# ---------------------------------------------------------------------------
step "set environment variables"

# Set all three targets in a single upsert via the REST API rather than `vercel env add`. The CLI
# prompts interactively for a git branch when the target is `preview` -- there is no flag to skip
# it -- so a scripted `env add ... preview` hangs and the preview environment silently ends up with
# no variables at all. `?upsert=true` also makes this idempotent, so no remove-then-add dance.
#
# JSON is assembled by node so that any character in a secret is escaped correctly; base64 values
# routinely contain `/` and `+`, and hand-rolled quoting is how those become subtly corrupted.
set_env() {
  local key="$1" val="$2" body
  body="$(KEY="$key" VAL="$val" node -e '
    process.stdout.write(JSON.stringify({
      key: process.env.KEY,
      value: process.env.VAL,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }));')"
  if printf %s "$body" \
      | vc api "/v10/projects/$PROJECT/env?upsert=true" -X POST --input - --silent >/dev/null 2>&1
  then
    ok "$key (production, preview, development)"
  else
    warn "could not set $key"
  fi
}

set_env DATABASE_URL        "$DATABASE_URL"
set_env ADMIN_TOKEN_HASH    "$ADMIN_TOKEN_HASH"
set_env CRON_SECRET         "$CRON_SECRET"
set_env POOL_ENCRYPTION_KEY "$POOL_ENCRYPTION_KEY"
set_env POOL_CLIENT_KEY     "$POOL_CLIENT_KEY"
set_env READ_KEYS_ENFORCED  "true"

# Belt and braces: the plaintext fallback must not linger once the hash is in place, or a stale
# value would keep working as a second valid credential. Done by id over the API -- `vercel env
# remove` can prompt for a branch on the preview target and would hang the script.
LEGACY_IDS="$(vc api "/v9/projects/$PROJECT/env" --raw 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    try {
      const envs = (JSON.parse(s).envs || []).filter(e => e.key === "ADMIN_TOKEN");
      process.stdout.write(envs.map(e => e.id).join(" "));
    } catch {}
  });' 2>/dev/null)"
for id in $LEGACY_IDS; do
  vc api "/v9/projects/$PROJECT/env/$id" -X DELETE --dangerously-skip-permissions --silent >/dev/null 2>&1 \
    && ok "removed legacy plaintext ADMIN_TOKEN" || true
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
BUILD_URL="$(vc deploy --prod 2>/dev/null | grep -oE 'https://[A-Za-z0-9._-]+' | tail -1)"
[ -n "$BUILD_URL" ] || die "deploy produced no URL. Run 'vercel deploy --prod' directly to see why
         (most often: the build failed, or the token lacks access to the project)."
ok "built: $BUILD_URL"

# The per-deployment URL (and the <project>-<org> alias) sit behind Vercel Deployment Protection,
# which 302-redirects unauthenticated callers to a login page. Handing that URL to the Android app
# or to the cron would break both. The short production alias is the public one, so prefer the
# shortest alias and fall back to the build URL only if none can be resolved.
ALIAS="$(vc api "/v13/deployments/${BUILD_URL#https://}" --raw 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    try {
      const d = JSON.parse(s);
      const all = (d.alias || []).concat((d.aliasAssigned && d.url) ? [d.url] : []);
      // Shortest host == the canonical production alias, e.g. archivepool.vercel.app.
      const best = all.filter(Boolean).sort((a, b) => a.length - b.length)[0];
      if (best) process.stdout.write(best.startsWith("http") ? best : "https://" + best);
    } catch {}
  });' 2>/dev/null)"

if [ -n "$ALIAS" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$ALIAS/api/status")" = "200" ]; then
  DEPLOY_URL="$ALIAS"
  ok "public URL: $DEPLOY_URL"
else
  DEPLOY_URL="$BUILD_URL"
  warn "could not confirm a public alias -- using $DEPLOY_URL.
         If this URL 302s, Deployment Protection is on: Project Settings -> Deployment Protection.
         The app and cron need a URL reachable without logging in."
fi

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
if [ "$GH_OK" = "1" ]; then
  gh secret set HEALTH_URL  --repo "$REPO" --body "$DEPLOY_URL" >/dev/null 2>&1 && ok "HEALTH_URL secret set"  || warn "could not set HEALTH_URL"
  gh secret set CRON_SECRET --repo "$REPO" --body "$CRON_SECRET" >/dev/null 2>&1 && ok "CRON_SECRET secret set" || warn "could not set CRON_SECRET"
  gh workflow run health-cron.yml --repo "$REPO" >/dev/null 2>&1 \
    && ok "triggered an immediate health sweep" \
    || warn "could not trigger health-cron.yml (run it from the Actions tab)"
else
  warn "skipped -- run these two once gh is authenticated:"
  printf '        gh secret set HEALTH_URL  --repo %s --body %s\n' "$REPO" "$DEPLOY_URL"
  printf '        gh secret set CRON_SECRET --repo %s --body <the CRON_SECRET printed below>\n' "$REPO"
fi

# ---------------------------------------------------------------------------
step "repoint the Android app"

if [ -z "${APP_REPO:-}" ]; then
  warn "APP_REPO empty -- skipping"
elif [ "$GH_OK" != "1" ]; then
  warn "skipped -- run this once gh is authenticated:"
  printf '        gh variable set SOURCE_PROVIDER_URL --repo %s --body %s\n' "$APP_REPO" "$DEPLOY_URL"
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
