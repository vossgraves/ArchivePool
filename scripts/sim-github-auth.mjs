#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression checks for the GitHub sign-in flow (Sol review of d025a3c, updated
// for the auto-account + dashboard-recovery model and the PR-#14 hardening).
//
// PART 1 runs the REAL cookie pack/parse, username-derivation and claim-decision
// code compiled straight from lib/github-cookies.ts + lib/hmac-cookie.ts.
//
// PART 2 is a live integration pass: it talks HTTP to a running dev worker,
// SQL to Postgres, and calls the REAL lib/claim-transfer.ts transaction
// (compiled for node below) directly — locks, FOR UPDATE re-checks and
// repoints included — so the mid-claim revoke race is tested against the code
// that ships, with no test seam in production code.
//
// The sim compiles the modules it needs into /tmp/ghc itself; the only
// requirements are a dev worker (defaults below) and a LOCAL postgres.
//   node scripts/sim-github-auth.mjs
//
// Live-part environment (defaults match the repo's local test rig):
//   BASE_URL            dev worker origin        (http://localhost:8788)
//   SIM_DATABASE_URL    postgres connection      (postgresql://postgres:postgres@127.0.0.1:5432/archivepool)
//                       — must be local (localhost/127.0.0.1/::1/ap-pg/docker
//                       name); anything else aborts unless
//                       SIM_ALLOW_REMOTE_DB=1 is passed explicitly
//   MOCK_GITHUB_PORT    port of the token+/user  (8999 — if nothing listens there
//                       mock the bundle calls    this sim serves it itself)
//
// Exits 1 if any check fails; live checks print SKIP (not FAIL) when the rig is
// unavailable.

process.env.SESSION_SECRET ??= "sim-secret-for-regression"

import { execFileSync } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import http from "node:http"

const REPO = path.resolve(new URL("..", import.meta.url).pathname)
const OUT = "/tmp/ghc"

// Compile the REAL modules the tests exercise. The sed passes rewrite emitted
// specifiers: Next's bundler needs extensionless imports while node ESM needs
// the .js file names.
execFileSync(path.join(REPO, "node_modules/.bin/tsc"), [
  "lib/github-cookies.ts", "lib/hmac-cookie.ts", "lib/claim-transfer.ts", "lib/db/schema.ts",
  "--outDir", OUT, "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { cwd: REPO, stdio: "inherit" })
for (const [file, spec] of [
  ["github-cookies.js", '"./hmac-cookie"'],
  ["claim-transfer.js", '"./db/schema"'],
]) {
  const p = path.join(OUT, file)
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll(spec, spec.slice(0, -1) + '.js"'))
}
// The compiled claim-transfer/schema files resolve drizzle-orm/pg-core and pg
// from node_modules — point them at the repo's copy.
if (!fs.existsSync(path.join(OUT, "node_modules"))) {
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(OUT, "node_modules"))
}
const pg = (await import("pg")).default
const ghc = await import("file:///tmp/ghc/github-cookies.js")
const hmac = await import("file:///tmp/ghc/hmac-cookie.js")
const transferMod = await import("file:///tmp/ghc/claim-transfer.js")
const schemaMod = await import("file:///tmp/ghc/db/schema.js")
const { drizzle } = await import("drizzle-orm/node-postgres")
const {
  packOauthCookie,
  readOauthCookie,
  githubUsernameBase,
  deriveGithubUsernameCandidates,
  canClaimLegacyUser,
  claimDecision,
} = ghc
const { runLegacyClaimTransfer } = transferMod

let failures = 0
let skips = 0
async function check(name, cond) {
  const ok = await Promise.resolve(cond)
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
}
function skip(name, why) {
  skips++
  console.log(`SKIP  ${name} (${why})`)
}
const forge = async (body) => `${body}.${await hmac.signWithSessionSecret(body)}`
const future = Date.now() + 600_000
const past = Date.now() - 1000
const USERNAME_RE = /^[a-z0-9_]{3,24}$/

// --- 1: OAuth transaction cookie ---------------------------------------------
const oauth = await packOauthCookie("abcdef0123456789AB", "verifier-0123456789abc")
await check("oauth cookie round-trips", (await readOauthCookie(oauth))?.state === "abcdef0123456789AB")
await check(
  "oauth cookie returns the verifier",
  (await readOauthCookie(oauth))?.verifier === "verifier-0123456789abc",
)
await check("tampered signature rejected", (await readOauthCookie(oauth.slice(0, -4) + "AAAA")) === null)
await check("wrong tag rejected", (await readOauthCookie(await forge(`gh-pending-v1.42.x.${future}`))) === null)
await check("expired cookie rejected", (await readOauthCookie(await forge(`gh-oauth-v1.${"a".repeat(16)}.${"b".repeat(16)}.${past}`))) === null)
await check("extra field rejected", (await readOauthCookie(`${oauth}.extra`)) === null)
await check("nonce shape enforced", (await readOauthCookie(await forge(`gh-oauth-v1.short.${"b".repeat(16)}.${future}`))) === null)

// --- 2: username derivation (first GitHub sign-in) ----------------------------
const allValid = (login) => deriveGithubUsernameCandidates(login).every((c) => USERNAME_RE.test(c))
await check("simple login derives itself", deriveGithubUsernameCandidates("octocat")[0] === "octocat")
await check("hyphen becomes underscore", githubUsernameBase("octo-cat") === "octo_cat")
await check("illegal chars stripped", githubUsernameBase("oc.to!cat") === "octocat")
await check("uppercase lowered", githubUsernameBase("OcToCaT") === "octocat")
await check("long login clamped to 24", githubUsernameBase("a".repeat(39)).length === 24)
await check("underscores collapse", githubUsernameBase("oc--to--cat") === "oc_to_cat")
await check("edge underscores trimmed", githubUsernameBase("-octo-") === "octo")
await check("always >=1 valid candidate (digit login)", deriveGithubUsernameCandidates("12345").length > 0)
await check("always >=1 valid candidate (1-char login)", deriveGithubUsernameCandidates("x").length > 0)
await check("always >=1 valid candidate (symbols only)", deriveGithubUsernameCandidates("---").length > 0)
await check("always >=1 valid candidate (empty)", deriveGithubUsernameCandidates("").length > 0)
await check("every candidate matches the site pattern (typical)", allValid("octo-cat"))
await check("every candidate matches the site pattern (edge)", allValid("a"))
await check("preferred candidate omitted when invalid", deriveGithubUsernameCandidates("ab")[0] !== "ab")
const cands = deriveGithubUsernameCandidates("octo")
await check("fallbacks differ from the taken name", cands.every((c, i) => i === 0 || c !== "octo"))
await check("fallbacks are distinct", new Set(cands).size === cands.length)

// --- 3: claim proof decision ---------------------------------------------------
await check("active owned key -> claim proceeds", claimDecision({ revoked: false }) === "link")
await check("revoked owned key -> pending admin claim", claimDecision({ revoked: true }) === "pending")
await check("key not belonging to account -> reject", claimDecision(null) === "reject")

// --- 4: legacy-claim target predicate ------------------------------------------
const legacy = { id: 7, disabled: false, claimedBy: null, githubId: null }
await check("plain legacy row is claimable", canClaimLegacyUser(legacy, 42))
await check("own account is not claimable", !canClaimLegacyUser(legacy, 7))
await check("disabled target is not claimable", !canClaimLegacyUser({ ...legacy, disabled: true }, 42))
await check("already-claimed target is not claimable", !canClaimLegacyUser({ ...legacy, claimedBy: 9 }, 42))
await check("github-linked target is not a legacy account", !canClaimLegacyUser({ ...legacy, githubId: 99 }, 42))

// ================= PART 2 — live integration (worker + Postgres) =================

const BASE = (process.env.BASE_URL ?? "http://localhost:8788").replace(/\/$/, "")
const DATABASE_URL = process.env.SIM_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/archivepool"
const GH_PORT = Number(process.env.MOCK_GITHUB_PORT ?? 8999)

/** The sim writes real rows — it must never touch a database it cannot own.
 *  Local hosts only, unless SIM_ALLOW_REMOTE_DB=1 is passed explicitly.
 *
 *  The URI hostname is NOT the effective target: pg honours a `host=` query
 *  parameter (postgresql://localhost/db?host=evil.example dials evil.example),
 *  a missing host falls back to PGHOST, and host lists are comma-separated.
 *  So the check resolves the connection the same way pg itself does — via
 *  connectionParameters — and requires EVERY resolved host to be local:
 *  localhost / 127.0.0.1 / ::1, a unix socket path, or a docker hostname. */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "ap-pg", "postgres", "host.docker.internal"])
const isLocalDbHost = (h) => {
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h // pg keeps [::1] bracketed
  return LOCAL_DB_HOSTS.has(bare) || bare.startsWith("/") || bare.startsWith(".")
}

function effectiveDbHosts(url) {
  const conn = new pg.Client({ connectionString: url })
  return String(conn.connectionParameters.host ?? "localhost")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
}

function databaseUrlIsLocal(url) {
  if (process.env.SIM_ALLOW_REMOTE_DB === "1") return true
  try {
    const hosts = effectiveDbHosts(url)
    return hosts.length > 0 && hosts.every(isLocalDbHost)
  } catch {
    return false
  }
}

// --- 5: databaseUrlIsLocal self-test (pure — no connection) --------------------
{
  const cases = [
    ["postgresql://localhost/archivepool", true],
    ["postgresql://127.0.0.1:5432/archivepool", true],
    ["postgresql://[::1]/db", true],
    ["postgresql://ap-pg/archivepool", true],
    ["postgresql://host.docker.internal/db", true],
    ["postgresql://localhost/db?host=db.example.invalid", false], // host= query override
    ["postgresql://db.example.invalid/db?host=127.0.0.1", true],  // override wins both ways
    ["postgresql:///db", true],                                    // host-less -> localhost
    ["postgresql://u@/db?host=/var/run/postgresql", true],         // unix socket path
    ["postgresql://db.example.invalid/db", false],
    ["postgresql://localhost,db.example.invalid/db", false],       // multi-host: all must be local
    ["not-a-url", false],
  ]
  for (const [u, want] of cases) {
    await check(`guard: ${u} -> ${want ? "local" : "remote"}`, databaseUrlIsLocal(u) === want)
  }
  const savedPghost = process.env.PGHOST
  const savedOverride = process.env.SIM_ALLOW_REMOTE_DB
  try {
    delete process.env.SIM_ALLOW_REMOTE_DB
    process.env.PGHOST = "db.example.invalid"
    await check("guard: remote PGHOST refused", databaseUrlIsLocal("postgresql:///db") === false)
    process.env.PGHOST = "127.0.0.1"
    await check("guard: local PGHOST allowed", databaseUrlIsLocal("postgresql:///db") === true)
    process.env.SIM_ALLOW_REMOTE_DB = "1"
    await check("guard: SIM_ALLOW_REMOTE_DB overrides", databaseUrlIsLocal("postgresql://db.example.invalid/db") === true)
  } finally {
    if (savedPghost === undefined) delete process.env.PGHOST
    else process.env.PGHOST = savedPghost
    if (savedOverride === undefined) delete process.env.SIM_ALLOW_REMOTE_DB
    else process.env.SIM_ALLOW_REMOTE_DB = savedOverride
  }
}

let pgClient = null
let txdb = null
let liveReady = false
let sql = null
if (databaseUrlIsLocal(DATABASE_URL)) {
  try {
    pgClient = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 })
    await pgClient.connect()
    sql = async (q, params = []) => (await pgClient.query(q, params)).rows
    txdb = drizzle(new pg.Pool({ connectionString: DATABASE_URL, max: 3 }), { schema: schemaMod })
    const probe = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(4000) }).catch(() => null)
    liveReady = probe !== null
  } catch {
    liveReady = false
  }
} else {
  console.log(`live rig: refusing non-local SIM_DATABASE_URL (set SIM_ALLOW_REMOTE_DB=1 to override)`)
}

function liveSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== "sim-secret-for-regression") {
    return process.env.SESSION_SECRET
  }
  for (const p of ["../.dev.vars", ".dev.vars"]) {
    try {
      const vars = fs.readFileSync(new URL(p, import.meta.url), "utf8")
      const m = vars.match(/^SESSION_SECRET=(.*)$/m)
      if (m) return m[1].trim().replace(/^"|"$/g, "")
    } catch { /* next candidate */ }
  }
  return process.env.SESSION_SECRET ?? ""
}

function mintSession(uid, secret) {
  const payload = `${uid}.${Date.now() + 30 * 24 * 3600 * 1000}`
  const sig = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

function mintOauth(secret, state = "simstate987654321", verifier = "simverifier98765432109876") {
  const body = `gh-oauth-v1.${state}.${verifier}.${Date.now() + 600_000}`
  const sig = createHmac("sha256", secret).update(body).digest("base64url")
  return { cookie: `${body}.${sig}`, state }
}

const hashKey = (key) => createHash("sha256").update(key).digest("hex")

// Mock GitHub for the patched local bundle: serves /token + /user. If a mock is
// already on the port we just write the identity files it reads; otherwise the
// sim serves its own — same /tmp file contract either way.
let mockServer = null
async function ensureMockGithub() {
  const probe = await fetch(`http://127.0.0.1:${GH_PORT}/user`, { signal: AbortSignal.timeout(1500) }).catch(() => null)
  if (probe !== null) return // external mock already up
  mockServer = http.createServer((req, res) => {
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ access_token: "mock-token" }))
    } else if (req.url === "/user") {
      const rd = (p, d) => { try { return fs.readFileSync(p, "utf8").trim() } catch { return d } }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: parseInt(rd("/tmp/gh-id.txt", "424242"), 10), login: rd("/tmp/gh-login.txt", "mockgh") }))
    } else {
      res.writeHead(404); res.end("{}")
    }
  })
  await new Promise((resolve) => mockServer.listen(GH_PORT, "127.0.0.1", resolve))
}
const setGhIdentity = (id, login) => {
  fs.writeFileSync("/tmp/gh-id.txt", String(id))
  fs.writeFileSync("/tmp/gh-login.txt", login)
}

// Test-fixture helpers — every fixture name carries the run tag so repeat runs
// never collide with leftovers. Rate-limit isolation is structural: each run
// sends a unique X-Forwarded-For (the per-IP bucket is keyed on it), uses fresh
// user ids, and RUN-tagged target names — a previous run's buckets can never
// match this run's keys, and cleanup deletes only the keys this run created.
const RUN = `sim${Date.now().toString(36)}`
const XFF = `10.${createHash("sha256").update(RUN).digest().slice(0, 3).join(".")}`
const bucketKeys = new Set()

let uidSeq = 0
async function makeUser(name, extra = "") {
  const rows = await sql(`INSERT INTO users (username, password_hash ${extra ? ", role" : ""}) VALUES ($1,'x'${extra ? `,'${extra}'` : ""}) RETURNING id`, [name])
  return rows[0].id
}
const makeKey = (userId, plaintext, revoked = false) =>
  sql(
    `INSERT INTO api_keys (name, key_hash, prefix, user_id, revoked) VALUES ('sim',$1,$2,$3,$4)`,
    [hashKey(plaintext), plaintext.slice(0, 10), userId, revoked],
  )
const key = (n) => `atp_${RUN}${String(n).padStart(6, "0")}abcdefabcdefabcd`

const authed = (uid, secret) => ({
  cookie: `atp_session=${mintSession(uid, secret)}`,
  "content-type": "application/json",
  "x-forwarded-for": XFF,
})
async function claim(uid, body, secret) {
  const res = await fetch(`${BASE}/api/auth/claim-legacy`, {
    method: "POST",
    headers: authed(uid, secret),
    body: JSON.stringify(body),
  })
  // Track exactly the buckets this run created — cleanup deletes only these.
  bucketKeys.add(`legacy-claim:ip:${XFF}`)
  bucketKeys.add(`legacy-claim:user:${uid}`)
  if (body.username) bucketKeys.add(`legacy-claim:name:${body.username}`)
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
async function callback(code, state, oauthCookie) {
  const res = await fetch(`${BASE}/api/auth/github/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `atp_gh_oauth=${oauthCookie}` },
  })
  return { status: res.status, location: res.headers.get("location"), cookie: res.headers.get("set-cookie") }
}

if (liveReady) {
  try {
    await ensureMockGithub()
  } catch (e) {
    liveReady = false
    console.log(`live rig: mock github unavailable on ${GH_PORT} (${e.message})`)
  }
}
const secret = liveReady ? liveSecret() : ""

if (!liveReady) {
  for (const name of [
    "live: auto-create on first sign-in",
    "live: racing creation signs into the winner",
    "live: claim with active key transfers",
    "live: revoked key files pending, never transfers",
    "live: mid-claim revoke loses the race",
    "live: issuance vs recovery cannot deadlock",
    "live: foreign key rejected",
    "live: disabled claimer's session is dead",
    "live: mutual claim impossible",
    "live: rate limit shared across callers",
    "live: approval materializes the github account",
  ]) skip(name, "dev worker or postgres unreachable")
} else {
  // ---- auto-create -----------------------------------------------------------
  {
    const gid = 80000000 + Math.floor(Math.random() * 899999)
    setGhIdentity(gid, `${RUN}gh`.slice(0, 24).replace(/_/g, "-"))
    const { cookie, state } = mintOauth(secret)
    const res = await callback("fake", state, cookie)
    await check("live: auto-create on first sign-in", res.status === 307 && /dashboard/.test(res.location ?? "") && /atp_session=/.test(res.cookie ?? ""))
    const rows = await sql(`SELECT id, username, github_login FROM users WHERE github_id=$1`, [gid])
    await check("live: created row has github_id + derived username", rows.length === 1 && USERNAME_RE.test(rows[0].username) && rows[0].github_login !== "")
  }

  // ---- racing creation --------------------------------------------------------
  {
    const gid = 80000000 + Math.floor(Math.random() * 899999)
    setGhIdentity(gid, `racer-${RUN}`.slice(0, 24))
    const { cookie, state } = mintOauth(secret, "racestate1234567", "raceverifier12345678901")
    const [a, b] = await Promise.all([callback("c1", state, cookie), callback("c2", state, cookie)])
    const rows = await sql(`SELECT id FROM users WHERE github_id=$1`, [gid])
    const bothSignedIn = [a, b].every((r) => r.status === 307 && /atp_session=/.test(r.cookie ?? ""))
    await check("live: racing creation signs into the winner", bothSignedIn && rows.length === 1)
  }

  // ---- claim happy path + dead sessions after claim --------------------------
  {
    const lname = `${RUN}_a`.slice(0, 24)
    const luid = await makeUser(lname)
    const k1 = key(++uidSeq)
    await makeKey(luid, k1)
    await sql(`INSERT INTO api_key_requests (user_id, subject, reason) VALUES ($1,'sim','sim fixture reason')`, [luid])
    const cuid = await makeUser(`${RUN}_claimer1`.slice(0, 24))
    const res = await claim(cuid, { username: lname, apiKey: k1 }, secret)
    await check("live: claim with active key transfers", res.status === 200 && res.data.status === "claimed" && res.data.transferred?.keys === 1)
    const u = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [luid])
    const k = await sql(`SELECT user_id FROM api_keys WHERE key_hash=$1`, [hashKey(k1)])
    const r = await sql(`SELECT user_id FROM api_key_requests WHERE user_id=$1 OR user_id=$2`, [cuid, luid])
    await check("live: legacy row claimed+disabled, rows repointed", u[0]?.disabled === true && u[0]?.claimed_by === cuid && k[0]?.user_id === cuid && r.length === 1 && r[0].user_id === cuid)
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `atp_session=${mintSession(luid, secret)}` } })
    await check("live: claimed user's sessions die", me.status === 401)
  }

  // ---- revoked key -> pending, never a transfer -------------------------------
  {
    const lname = `${RUN}_b`.slice(0, 24)
    const luid = await makeUser(lname)
    const k1 = key(++uidSeq)
    await makeKey(luid, k1, true)
    const cuid = await makeUser(`${RUN}_ghclaimer`.slice(0, 24))
    await sql(`UPDATE users SET github_id=$1, github_login=$2 WHERE id=$3`, [88000000 + luid, `${RUN}g`, cuid])
    const res = await claim(cuid, { username: lname, apiKey: k1 }, secret)
    const u = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [luid])
    const cl = await sql(`SELECT id FROM github_claims WHERE username=$1 AND status='pending'`, [lname])
    await check(
      "live: revoked key files pending, never transfers",
      res.status === 200 && res.data.status === "claim_pending" && u[0]?.claimed_by == null && u[0]?.disabled === false && cl.length === 1,
    )
  }

  // ---- in-transaction proof re-check — called DIRECTLY against the compiled
  // transaction: the caller-side pre-check says "link" (active key), the key is
  // revoked between that check and the real runLegacyClaimTransfer call, and
  // the FOR UPDATE re-read inside the transaction must lose the race. No
  // production seam: this exercises the code that ships.
  {
    const lname = `${RUN}_c`.slice(0, 24)
    const luid = await makeUser(lname)
    const k1 = key(++uidSeq)
    await makeKey(luid, k1)
    const cuid = await makeUser(`${RUN}_ghclaimerc`.slice(0, 24))
    await sql(`UPDATE users SET github_id=$1, github_login=$2 WHERE id=$3`, [88000000 + luid + 1, `${RUN}gc`, cuid])
    // The route's pre-check equivalent: classify the key as owned+active.
    const pre = await sql(`SELECT revoked FROM api_keys WHERE key_hash=$1 AND user_id=$2 AND deleted=false`, [hashKey(k1), luid])
    await check("pre-check classifies the active key", claimDecision(pre[0] ?? null) === "link")
    // The race: revoked BETWEEN the pre-check and the transaction's locked re-read.
    await sql(`UPDATE api_keys SET revoked=true WHERE key_hash=$1`, [hashKey(k1)])
    const moved = await runLegacyClaimTransfer(txdb, cuid, luid, hashKey(k1))
    const u = await sql(`SELECT claimed_by, disabled FROM users WHERE id=$1`, [luid])
    const k = await sql(`SELECT revoked, user_id FROM api_keys WHERE key_hash=$1`, [hashKey(k1)])
    await check(
      "live: mid-claim revoke loses the race",
      moved.ok === false && moved.error === "proof_revoked" && u[0]?.claimed_by == null && u[0]?.disabled === false && k[0]?.revoked === true && k[0]?.user_id === luid,
    )
  }

  // ---- issuance vs recovery lock-order ---------------------------------------
  {
    for (let round = 0; round < 3; round++) {
      const lname = `${RUN}ir${round}`.slice(0, 24)
      const luid = await makeUser(lname)
      const k1 = key(++uidSeq)
      await makeKey(luid, k1)
      const reqRows = await sql(
        `INSERT INTO api_key_requests (user_id, subject, reason, status) VALUES ($1,'sim','sim fixture reason','approved') RETURNING id`,
        [luid],
      )
      const cuid = await makeUser(`${RUN}irw${round}`.slice(0, 24))
      const [claimRes, issueRes] = await Promise.all([
        claim(cuid, { username: lname, apiKey: k1 }, secret),
        fetch(`${BASE}/api/requests/${reqRows[0].id}/claim`, {
          method: "POST",
          headers: authed(luid, secret),
          body: "{}",
        }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })),
      ])
      const u = await sql(`SELECT claimed_by, disabled FROM users WHERE id=$1`, [luid])
      const rq = await sql(`SELECT user_id, status, resulting_key_id FROM api_key_requests WHERE id=$1`, [reqRows[0].id])
      const no5xx = claimRes.status < 500 && issueRes.status < 500
      const consistent = [200, 400, 401].includes(issueRes.status) && rq[0]?.user_id === cuid
      await check(
        `live: issuance vs recovery cannot deadlock (round ${round})`,
        no5xx && claimRes.status === 200 && u[0]?.claimed_by === cuid && consistent,
      )
    }
  }

  // ---- foreign key -------------------------------------------------------------
  {
    const lname = `${RUN}_d`.slice(0, 24)
    await makeUser(lname)
    const cuid = await makeUser(`${RUN}_claimer2`.slice(0, 24))
    const res = await claim(cuid, { username: lname, apiKey: key(999) }, secret)
    await check("live: foreign key rejected", res.status === 403 && res.data.error === "claim_proof_failed")
  }

  // ---- disabled claimer --------------------------------------------------------
  {
    const duid = await makeUser(`${RUN}_dead`.slice(0, 24))
    await sql(`UPDATE users SET disabled=true WHERE id=$1`, [duid])
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `atp_session=${mintSession(duid, secret)}` } })
    const res = await claim(duid, { username: `${RUN}_anything`, apiKey: key(998) }, secret)
    await check("live: disabled claimer's session is dead", me.status === 401 && res.status === 401)
  }

  // ---- mutual claim -------------------------------------------------------------
  {
    const an = `${RUN}_ma`.slice(0, 24)
    const bn = `${RUN}_mb`.slice(0, 24)
    const aid = await makeUser(an)
    const bid = await makeUser(bn)
    const ka = key(++uidSeq)
    const kb = key(++uidSeq)
    await makeKey(aid, ka)
    await makeKey(bid, kb)
    const first = await claim(aid, { username: bn, apiKey: kb }, secret)
    const back = await claim(bid, { username: an, apiKey: ka }, secret)
    const aRow = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [aid])
    await check(
      "live: mutual claim impossible",
      first.status === 200 && first.data.status === "claimed" && back.status === 401 && aRow[0]?.disabled === false && aRow[0]?.claimed_by == null,
    )
  }

  // ---- shared rate-limit bucket ---------------------------------------------------
  {
    const target = `${RUN}rl`.slice(0, 24)
    const u1 = await makeUser(`${RUN}_r1`.slice(0, 24))
    const u2 = await makeUser(`${RUN}_r2`.slice(0, 24))
    const codes = []
    for (let i = 0; i < 3; i++) codes.push((await claim(u1, { username: target }, secret)).status)
    for (let i = 0; i < 3; i++) codes.push((await claim(u2, { username: target }, secret)).status)
    const bucket = await sql(`SELECT n FROM rate_limit_buckets WHERE bucket=$1`, [`legacy-claim:name:${target}`])
    await check(
      "live: rate limit shared across callers",
      codes.slice(0, 5).every((c) => c !== 429) && codes[5] === 429 && Number(bucket[0]?.n) >= 6,
    )
  }

  // ---- approval of a pre-upgrade pending claim (no local github account) ---------
  {
    const lname = `${RUN}_e`.slice(0, 24)
    const luid = await makeUser(lname)
    const k1 = key(++uidSeq)
    await makeKey(luid, k1)
    const ghostGid = 87000000 + Math.floor(Math.random() * 89999)
    const claimRows = await sql(
      `INSERT INTO github_claims (github_id, github_login, username) VALUES ($1,$2,$3) RETURNING id`,
      [ghostGid, `${RUN}ghost`, lname],
    )
    const adminId = await makeUser(`${RUN}_admin`.slice(0, 24), "admin")
    const res = await fetch(`${BASE}/api/admin/claims/${claimRows[0].id}`, {
      method: "POST",
      headers: authed(adminId, secret),
      body: JSON.stringify({ action: "approve" }),
    })
    const data = await res.json().catch(() => ({}))
    const ghost = await sql(`SELECT id, github_id FROM users WHERE github_id=$1`, [ghostGid])
    const u = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [luid])
    const k = await sql(`SELECT user_id FROM api_keys WHERE key_hash=$1`, [hashKey(k1)])
    await check(
      "live: approval materializes the github account",
      res.status === 200 && data.status === "approved" && ghost.length === 1 && u[0]?.claimed_by === ghost[0].id && k[0]?.user_id === ghost[0].id,
    )
  }

  // Scoped cleanup: delete only the rate-limit buckets this run created.
  if (bucketKeys.size > 0) {
    await sql(`DELETE FROM rate_limit_buckets WHERE bucket = ANY($1::text[])`, [[...bucketKeys]]).catch(() => {})
  }
}

if (mockServer) mockServer.close()
if (pgClient) await pgClient.end()

console.log(failures === 0 ? `\nall checks passed${skips ? ` (${skips} skipped)` : ""}` : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
