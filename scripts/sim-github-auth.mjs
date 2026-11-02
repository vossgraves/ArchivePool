#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression checks for the GitHub sign-in flow (Sol review of d025a3c, updated
// for the auto-account + dashboard-recovery model).
// Runs the REAL cookie pack/parse, username-derivation and claim-decision code
// compiled straight from lib/github-cookies.ts + lib/hmac-cookie.ts — the same
// modules the routes import.
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
// Exits 1 if any check fails.

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
async function check(name, cond) {
  const ok = await Promise.resolve(cond)
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
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
await check("every candidate matches the site pattern (typical)", allValid("octo-cat"))
await check("every candidate matches the site pattern (edge)", allValid("a"))
await check("preferred candidate omitted when invalid", !deriveGithubUsernameCandidates("ab")[0]?.includes("ab") || deriveGithubUsernameCandidates("ab")[0] !== "ab")
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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
