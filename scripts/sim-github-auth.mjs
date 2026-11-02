#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression checks for the GitHub sign-in flow (Sol review of d025a3c, updated
// for the auto-account + dashboard-recovery model and the PR-#14 hardening).
//
// PART 1 runs the REAL cookie pack/parse, username-derivation and claim-decision
// code compiled straight from lib/github-cookies.ts + lib/hmac-cookie.ts — the
// same modules the routes import.
//
// PART 2 is a live integration pass: it talks HTTP to a running dev worker and
// SQL to Postgres, asserting the security invariants that only exist at runtime —
// the FOR UPDATE proof re-check, dead sessions, mutual-claim protection, racing
// account creation, shared DB rate-limit buckets and approval-time account
// materialization.
//
// Build step (run from the repo root before this script). The sed line rewrites
// the emitted specifier: Next's bundler needs the extensionless import while node
// ESM needs the .js file name.
//   corepack pnpm exec tsc lib/github-cookies.ts lib/hmac-cookie.ts \
//     --outDir /tmp/ghc --module esnext --target es2022 \
//     --moduleResolution bundler --skipLibCheck
//   sed -i 's|"./hmac-cookie"|"./hmac-cookie.js"|' /tmp/ghc/github-cookies.js
// then:
//   node scripts/sim-github-auth.mjs
//
// Live-part environment (defaults match the repo's local test rig):
//   BASE_URL          dev worker origin        (http://localhost:8788)
//   SIM_DATABASE_URL  postgres connection      (postgresql://postgres:postgres@127.0.0.1:5432/archivepool)
//   MOCK_GITHUB_PORT  port of the token+/user  (8999 — if nothing listens there
//                     mock the bundle calls     this sim serves it itself)
//
// Exits 1 if any check fails; live checks print SKIP (not FAIL) when the rig is
// unavailable.

process.env.SESSION_SECRET ??= "sim-secret-for-regression"

const ghc = await import("file:///tmp/ghc/github-cookies.js")
const hmac = await import("file:///tmp/ghc/hmac-cookie.js")
const {
  packOauthCookie,
  readOauthCookie,
  githubUsernameBase,
  deriveGithubUsernameCandidates,
  canClaimLegacyUser,
  claimDecision,
} = ghc

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
// A legacy name "octo" already taken -> the next candidate is a DIFFERENT string (never the takeover).
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

let pg = null
let http2 = null
let crypto2 = null
let fs2 = null
let pgClient = null
try {
  pg = (await import("pg")).default
  http2 = await import("node:http")
  crypto2 = await import("node:crypto")
  fs2 = await import("node:fs")
} catch {
  // no live deps — part 2 stays skipped
}

function liveSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== "sim-secret-for-regression") {
    return process.env.SESSION_SECRET
  }
  for (const p of ["../.dev.vars", ".dev.vars"]) {
    try {
      const vars = fs2.readFileSync(new URL(p, import.meta.url), "utf8")
      const m = vars.match(/^SESSION_SECRET=(.*)$/m)
      if (m) return m[1].trim().replace(/^"|"$/g, "")
    } catch { /* next candidate */ }
  }
  return process.env.SESSION_SECRET ?? ""
}

function mintSession(uid, secret) {
  const payload = `${uid}.${Date.now() + 30 * 24 * 3600 * 1000}`
  const sig = crypto2.createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

function mintOauth(secret, state = "simstate987654321", verifier = "simverifier98765432109876") {
  const body = `gh-oauth-v1.${state}.${verifier}.${Date.now() + 600_000}`
  const sig = crypto2.createHmac("sha256", secret).update(body).digest("base64url")
  return { cookie: `${body}.${sig}`, state }
}

const hashKey = (key) => crypto2.createHash("sha256").update(key).digest("hex")

let liveReady = false
let sql = null
if (pg) {
  try {
    pgClient = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 })
    await pgClient.connect()
    sql = async (q, params = []) => (await pgClient.query(q, params)).rows
    const probe = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(4000) }).catch(() => null)
    liveReady = probe !== null
  } catch (e) {
    liveReady = false
  }
}

// Mock GitHub for the patched local bundle: serves /token + /user. If a mock is
// already on the port we just write the identity files it reads; otherwise the
// sim serves its own — same /tmp file contract either way.
let mockServer = null
async function ensureMockGithub() {
  const probe = await fetch(`http://127.0.0.1:${GH_PORT}/user`, { signal: AbortSignal.timeout(1500) }).catch(() => null)
  if (probe !== null) return // external mock already up
  mockServer = http2.createServer((req, res) => {
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ access_token: "mock-token" }))
    } else if (req.url === "/user") {
      const rd = (p, d) => { try { return fs2.readFileSync(p, "utf8").trim() } catch { return d } }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: parseInt(rd("/tmp/gh-id.txt", "424242"), 10), login: rd("/tmp/gh-login.txt", "mockgh") }))
    } else {
      res.writeHead(404); res.end("{}")
    }
  })
  await new Promise((resolve) => mockServer.listen(GH_PORT, "127.0.0.1", resolve))
}
const setGhIdentity = (id, login) => {
  fs2.writeFileSync("/tmp/gh-id.txt", String(id))
  fs2.writeFileSync("/tmp/gh-login.txt", login)
}

const authed = (uid, secret) => ({ cookie: `atp_session=${mintSession(uid, secret)}`, "content-type": "application/json" })
async function claim(uid, body, secret) {
  const res = await fetch(`${BASE}/api/auth/claim-legacy`, {
    method: "POST",
    headers: authed(uid, secret),
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
async function callback(code, state, oauthCookie) {
  const res = await fetch(`${BASE}/api/auth/github/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `atp_gh_oauth=${oauthCookie}` },
  })
  return { status: res.status, location: res.headers.get("location"), cookie: res.headers.get("set-cookie") }
}

// Test-fixture helpers — every fixture name carries the run tag so repeat runs
// never collide with leftovers.
const RUN = `sim${Date.now().toString(36)}`
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
const key = (n) => `atp_${RUN}${String(n).padStart(6, "0")}abcdefabcdefabcd` // 3+ chars unique per fixture

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
    "live: claimed user's sessions die",
  ]) skip(name, "dev worker or postgres unreachable")
} else {
  // Buckets persist in Postgres across runs (10 min windows): clear them so a
  // previous run's hits cannot consume this run's per-IP/per-user allowance.
  await sql(`DELETE FROM rate_limit_buckets`).catch(() => {})

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
    // Stateless sessions cannot be revoked — resolution must refuse the dead row.
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `atp_session=${mintSession(luid, secret)}` } })
    await check("live: claimed user's sessions die", me.status === 401)
  }

  // ---- revoked key -> pending, never a transfer (the re-check gate) -----------
  {
    const lname = `${RUN}_b`.slice(0, 24)
    const luid = await makeUser(lname)
    const k1 = key(++uidSeq)
    await makeKey(luid, k1, true) // revoked before the claim is filed
    const cuid = await makeUser(`${RUN}_ghclaimer`.slice(0, 24))
    // github-linked claimer so the pending claim can be filed
    await sql(`UPDATE users SET github_id=$1, github_login=$2 WHERE id=$3`, [88000000 + luid, `${RUN}g`, cuid])
    const res = await claim(cuid, { username: lname, apiKey: k1 }, secret)
    const u = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [luid])
    const cl = await sql(`SELECT id FROM github_claims WHERE username=$1 AND status='pending'`, [lname])
    await check(
      "live: revoked key files pending, never transfers",
      res.status === 200 && res.data.status === "claim_pending" && u[0]?.claimed_by == null && u[0]?.disabled === false && cl.length === 1,
    )
  }

  // ---- in-transaction proof re-check (Sol finding: the revoked BETWEEN pre-check
  // and transfer case). The ATP_CLAIM_TEST_HOOK=revoke-proof seam in
  // transferLegacyAccount revokes an atp_hook_-prefixed key INSIDE the transfer
  // transaction, just before the locked re-read — deterministic simulation of a
  // revoke landing between the route's pre-check and the re-check. If the
  // re-check were removed, this test FAILS (the transfer would complete).
  {
    const hookActive = (() => {
      for (const p of ["../.dev.vars", ".dev.vars"]) {
        try {
          if (fs2.readFileSync(new URL(p, import.meta.url), "utf8").includes("ATP_CLAIM_TEST_HOOK=revoke-proof")) return true
        } catch { /* next */ }
      }
      return false
    })()
    if (!hookActive) {
      skip("live: mid-claim revoke loses the race", "ATP_CLAIM_TEST_HOOK not set")
    } else {
      const lname = `${RUN}_c`.slice(0, 24)
      const luid = await makeUser(lname)
      // atp_hook_ prefix arms the seam; the key is ACTIVE at the pre-check.
      const k1 = `atp_hook_${RUN}${String(++uidSeq).padStart(4, "0")}`
      await makeKey(luid, k1)
      const cuid = await makeUser(`${RUN}_ghclaimerc`.slice(0, 24))
      await sql(`UPDATE users SET github_id=$1, github_login=$2 WHERE id=$3`, [88000000 + luid + 1, `${RUN}gc`, cuid])
      const res = await claim(cuid, { username: lname, apiKey: k1 }, secret)
      const u = await sql(`SELECT claimed_by, disabled FROM users WHERE id=$1`, [luid])
      const k = await sql(`SELECT revoked, user_id FROM api_keys WHERE key_hash=$1`, [hashKey(k1)])
      // The seam revoked the key inside the tx; the re-check must catch it:
      // no transfer, the outcome is the revoked-key path (pending claim for a
      // github-linked claimer) — never "claimed".
      await check(
        "live: mid-claim revoke loses the race",
        res.data.status === "claim_pending" && u[0]?.claimed_by == null && u[0]?.disabled === false && k[0]?.revoked === true && k[0]?.user_id === luid,
      )
    }
  }

  // ---- issuance vs recovery lock-order (Sol finding: users-then-requests) ----
  // claimApprovedKey now locks the user row before the request row, matching
  // transferLegacyAccount's ascending-users order. Fired concurrently, one side
  // simply wins; neither can deadlock into a 500. Whatever the order, the end
  // state is consistent: issuance either lands on the live owner or sees the
  // request already transferred (404), and the request's owner is exactly one
  // of the two accounts afterwards.
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
      // Outcomes are order-dependent but always consistent: issuance either
      // minted the key first (200 — the row is then repointed to the claimer),
      // saw the request already transferred (400 not_found) or had its session
      // die mid-race (401). A deadlock would surface as a 500 — never allowed.
      const consistent = [200, 400, 401].includes(issueRes.status) && rq[0]?.user_id === cuid
      await check(
        `live: issuance vs recovery cannot deadlock (round ${round})`,
        no5xx && claimRes.status === 200 && u[0]?.claimed_by === cuid && consistent,
      )
    }
  }

  // ---- foreign key ------------------------------------------------------------
  {
    const lname = `${RUN}_d`.slice(0, 24)
    const luid = await makeUser(lname)
    const cuid = await makeUser(`${RUN}_claimer2`.slice(0, 24))
    const res = await claim(cuid, { username: lname, apiKey: key(999) }, secret)
    await check("live: foreign key rejected", res.status === 403 && res.data.error === "claim_proof_failed")
    void luid
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
    // B's session is now dead — B cannot even reach the endpoint to claim A back.
    const back = await claim(bid, { username: an, apiKey: ka }, secret)
    const aRow = await sql(`SELECT disabled, claimed_by FROM users WHERE id=$1`, [aid])
    await check(
      "live: mutual claim impossible",
      first.status === 200 && first.data.status === "claimed" && back.status === 401 && aRow[0]?.disabled === false && aRow[0]?.claimed_by == null,
    )
  }

  // ---- shared rate-limit bucket ---------------------------------------------------
  {
    const target = `${RUN}rl`.slice(0, 24) // need not exist — the name bucket counts attempts
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
}

if (mockServer) mockServer.close()
if (pgClient) await pgClient.end()

console.log(failures === 0 ? `\nall checks passed${skips ? ` (${skips} skipped)` : ""}` : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
