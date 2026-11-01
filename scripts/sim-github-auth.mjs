#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression checks for the GitHub sign-in hardening (Sol review of d025a3c).
// Runs the REAL cookie pack/parse and claim-decision code compiled straight from
// lib/github-cookies.ts + lib/hmac-cookie.ts — the same modules the routes import.
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
  packPendingCookie,
  readPendingCookie,
  canLinkGithubId,
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

// --- 1: purpose tags + canonical fields -------------------------------------
const oauth = await packOauthCookie("abcdef0123456789AB", "verifier-0123456789abc")
await check("oauth cookie round-trips", (await readOauthCookie(oauth))?.state === "abcdef0123456789AB")
await check("oauth cookie is NOT a pending identity", (await readPendingCookie(oauth)) === null)

// The reported exploit: an OAuth state that begins with digits parsed via
// parseInt as a pending github_id — must be rejected by tag + canonical regex.
const oauthDigits = await packOauthCookie("4242424242424242AB", "verifier-0123456789abc")
await check("digit-prefixed oauth cookie is NOT pending", (await readPendingCookie(oauthDigits)) === null)

const pending = await packPendingCookie(42424242, "octo-user")
const ident = await readPendingCookie(pending)
await check("pending cookie round-trips", ident?.id === 42424242 && ident?.login === "octo-user")
await check("pending cookie is NOT oauth state", (await readOauthCookie(pending)) === null)

await check("numeric-prefix id rejected", (await readPendingCookie(await forge(`gh-pending-v1.42abc.octo.${future}`))) === null)
await check("leading-zero id rejected", (await readPendingCookie(await forge(`gh-pending-v1.042.octo.${future}`))) === null)
await check("zero id rejected", (await readPendingCookie(await forge(`gh-pending-v1.0.octo.${future}`))) === null)
await check("expired cookie rejected", (await readPendingCookie(await forge(`gh-pending-v1.42.octo.${past}`))) === null)
await check("tampered signature rejected", (await readPendingCookie(pending.slice(0, -4) + "AAAA")) === null)
await check("wrong signed tag rejected", (await readPendingCookie(await forge(`gh-oauth-v1.42.octo.${future}`))) === null)
await check("non-canonical login rejected", (await readPendingCookie(await forge(`gh-pending-v1.42.oc..to.${future}`))) === null)
await check("extra field rejected", (await readPendingCookie(await forge(`gh-pending-v1.42.octo.${future}.extra`))) === null)

// --- 2: claim proof decision -------------------------------------------------
await check("active owned key -> link", claimDecision({ revoked: false }) === "link")
await check("revoked owned key -> pending admin claim", claimDecision({ revoked: true }) === "pending")
await check("key not belonging to account -> reject", claimDecision(null) === "reject")

// --- 3: atomic link predicate ------------------------------------------------
await check("NULL github_id is linkable", canLinkGithubId(null, 42))
await check("same github_id re-links (idempotent)", canLinkGithubId(42, 42))
await check("different github_id conflicts", !canLinkGithubId(7, 42))
await check("undefined github_id is linkable", canLinkGithubId(undefined, 42))

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
