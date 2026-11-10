#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression checks for the Tidal instance probe — the check that decides whether a restream
// instance may enter the pool (lib/health.ts checkTidalInstance, mirrored by
// server/internal/health/health.go checkTidalInstance).
//
// The probe replaced a `GET {baseUrl}` reachability test that could never admit a HiFi-RestAPI /
// Monochrome instance: their root answers 200 with `{"version","Repo"}`, which carries no hi-res
// marker, so every healthy instance came back `preview` and the premium gate rejected it — the pool's
// Tidal API tier stayed empty for as long as that probe existed. These checks pin the behaviour that
// replaced it, driving the REAL module through its public entry point (`runCheck("tidal","api",…)`)
// against a 127.0.0.1 stub server.
//
// Deliberately local-only: no community instance, no Tidal API, no external host of any kind. The
// stub server IS the instance, so every expected verdict comes from this file rather than from a
// live service.
//
//   node scripts/check-tidal-probe.mjs        (exit 1 if any expectation fails)
//
// Needs the repo's dependencies installed (`npm ci`) — esbuild ships with wrangler.

import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const REPO = path.resolve(new URL("..", import.meta.url).pathname)
const WORK = path.join(REPO, "node_modules", ".cache", "check-tidal-probe")

const MANIFEST = "/trackManifests/"
const TRACK = "/track/"
const TRACK_ID = "155142501534011392"
const UA = "ArchiveTune-Android"

function esbuildBin() {
  const local = path.join(REPO, "node_modules", ".bin", "esbuild")
  if (fs.existsSync(local)) return local
  console.error("esbuild not found. Run `npm ci` first (esbuild ships with wrangler).")
  process.exit(1)
}

// The harness entry is generated inside the repo so esbuild resolves node_modules from the repo and
// picks up tsconfig.json for lib/health.ts's own `@/*` imports (`node_modules/.cache` itself is in
// tsconfig `exclude`, so the entry reaches the module by path instead of by alias).
function build() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  const healthModule = path.relative(WORK, path.join(REPO, "lib", "health")).split(path.sep).join("/")
  fs.writeFileSync(
    path.join(WORK, "entry.ts"),
    `import { runCheck } from ${JSON.stringify(healthModule.startsWith(".") ? healthModule : `./${healthModule}`)}\nexport { runCheck }\n`,
  )
  // `server-only` throws outside a Next.js server bundle; the probe code never needs the guard.
  fs.writeFileSync(path.join(WORK, "server-only.js"), "export {}\n")
  execFileSync(
    esbuildBin(),
    [
      path.join(WORK, "entry.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      `--alias:server-only=${path.join(WORK, "server-only.js")}`,
      `--outfile=${path.join(WORK, "bundle.mjs")}`,
    ],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  )
  return pathToFileURL(path.join(WORK, "bundle.mjs")).href
}

/** Starts a stub instance on 127.0.0.1 and records every request the probe makes. */
function serve(routes) {
  const recorded = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const [routePath, query = ""] = (req.url ?? "/").split("?")
      recorded.push({ path: routePath, query, userAgent: String(req.headers["user-agent"] ?? "") })
      const route = routes[routePath]
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(`{"detail":"not found"}`)
        return
      }
      res.writeHead(route.status, { "content-type": "application/json" })
      res.end(route.body)
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${address.port}/`, recorded })
    })
  })
}

const FULL = `{"data":{"data":{"attributes":{"trackPresentation":"FULL","assetPresentation":"FULL"}}}}`
const FLAT_FULL = `{"data":{"attributes":{"assetPresentation":"FULL"}}}`
const PREVIEW = `{"data":{"data":{"attributes":{"trackPresentation":"PREVIEW"}}}}`
const V2_LOSSLESS = `{"data":{"assetPresentation":"LOSSLESS","manifest":"bWFuaWZlc3Q="}}`
const V2_PREVIEW = `{"data":{"assetPresentation":"PREVIEW","manifest":"bWFuaWZlc3Q="}}`

const cases = [
  {
    name: "manifest dialect: a FULL stream is premium",
    routes: { [MANIFEST]: { status: 200, body: FULL } },
    want: { ok: true, premium: true, status: "alive", detail: "trackManifests FULL" },
    paths: [MANIFEST],
    // The request itself is the contract with the instance: the trailing slash is load-bearing, and
    // the query is the one the app sends.
    query: [TRACK_ID, "formats=FLAC", "adaptive=false", "manifestType=MPEG_DASH", "uriScheme=HTTPS", "usage=PLAYBACK"],
  },
  {
    name: "manifest dialect: the flat nesting is accepted too",
    routes: { [MANIFEST]: { status: 200, body: FLAT_FULL } },
    want: { ok: true, premium: true, status: "alive", detail: "trackManifests FULL" },
    paths: [MANIFEST],
  },
  {
    name: "manifest dialect: PREVIEW is reachable but not premium",
    routes: { [MANIFEST]: { status: 200, body: PREVIEW } },
    want: { ok: true, premium: false, status: "preview", detail: "trackManifests PREVIEW" },
    paths: [MANIFEST],
  },
  {
    name: "a root body with no manifest document is NOT a pass (the old probe's bug)",
    routes: { [MANIFEST]: { status: 200, body: `{"version":"3.5","Repo":"https://github.com/binimum/hifi-api"}` } },
    want: { ok: false, premium: false, status: "dead", detail: "answered without a manifest document" },
    paths: [MANIFEST],
  },
  {
    name: "429 is rate limiting, not a verdict",
    routes: { [MANIFEST]: { status: 429, body: `{"detail":"Too Many Requests"}` } },
    want: { ok: false, premium: false, status: "pending", skipped: true, detail: "429" },
    paths: [MANIFEST],
  },
  {
    name: "a missing manifest route falls back to the 2.x track route",
    routes: { [TRACK]: { status: 200, body: V2_LOSSLESS } },
    want: { ok: true, premium: true, status: "alive", detail: "track LOSSLESS" },
    paths: [MANIFEST, TRACK],
    query: ["quality=LOSSLESS", TRACK_ID],
  },
  {
    name: "2.x PREVIEW is reachable but not premium",
    routes: { [TRACK]: { status: 200, body: V2_PREVIEW } },
    want: { ok: true, premium: false, status: "preview", detail: "track PREVIEW" },
    paths: [MANIFEST, TRACK],
  },
  {
    name: "2.x answer without a manifest is not a pass",
    routes: { [TRACK]: { status: 200, body: `{"data":{"assetPresentation":"LOSSLESS","manifest":""}}` } },
    want: { ok: false, premium: false, status: "dead", detail: "served no manifest" },
    paths: [MANIFEST, TRACK],
  },
  {
    name: "429 on the fallback route is rate limiting too",
    routes: { [TRACK]: { status: 429, body: `{"detail":"Too Many Requests"}` } },
    want: { ok: false, premium: false, status: "pending", skipped: true, detail: "429" },
    paths: [MANIFEST, TRACK],
  },
  {
    name: "a 500 on the manifest route does not fall back (the instance is simply not serving)",
    routes: {
      [MANIFEST]: { status: 500, body: `{"detail":"backend down"}` },
      [TRACK]: { status: 200, body: V2_LOSSLESS },
    },
    want: { ok: false, premium: false, status: "dead", detail: "trackManifests HTTP 500" },
    paths: [MANIFEST],
  },
  {
    name: "a configured probe track is used instead of the default",
    routes: { [MANIFEST]: { status: 200, body: FULL } },
    payload: { probeTrackId: "999" },
    want: { ok: true, premium: true, status: "alive", detail: "trackManifests FULL" },
    paths: [MANIFEST],
    query: ["id=999"],
  },
  {
    name: "trailing slashes on the base URL collapse",
    baseSuffix: "////",
    routes: { [MANIFEST]: { status: 200, body: FULL } },
    want: { ok: true, premium: true, status: "alive", detail: "trackManifests FULL" },
    paths: [MANIFEST],
  },
  {
    name: "missing base URL is dead, not a crash",
    payload: { baseUrl: "" },
    routes: {},
    want: { ok: false, premium: false, status: "dead", detail: "missing baseUrl" },
    paths: [],
  },
]

let failures = 0
const bundle = build()
const { runCheck } = await import(bundle)

for (const testCase of cases) {
  const started = Date.now()
  if (testCase.payload?.baseUrl === "") {
    const result = await runCheck("tidal", "api", testCase.payload)
    report(testCase, result, [], Date.now() - started)
    continue
  }
  const { server, url, recorded } = await serve(testCase.routes)
  try {
    const result = await runCheck("tidal", "api", {
      ...(testCase.payload ?? {}),
      baseUrl: url + (testCase.baseSuffix ?? ""),
    })
    report(testCase, result, recorded, Date.now() - started)
  } finally {
    server.close()
  }
}

function report(testCase, result, recorded, elapsedMs) {
  const problems = []
  const { want } = testCase
  if (result.ok !== want.ok) problems.push(`ok=${result.ok}, want ${want.ok}`)
  if (result.premium !== want.premium) problems.push(`premium=${result.premium}, want ${want.premium}`)
  if (result.status !== want.status) problems.push(`status=${result.status}, want ${want.status}`)
  if (Boolean(result.skipped) !== Boolean(want.skipped)) problems.push(`skipped=${result.skipped}, want ${want.skipped}`)
  if (!String(result.detail).includes(want.detail)) {
    problems.push(`detail=${JSON.stringify(result.detail)}, want it to contain ${want.detail}`)
  }
  const probed = recorded.map((r) => r.path)
  if (probed.join(",") !== testCase.paths.join(",")) {
    problems.push(`probed ${JSON.stringify(probed)}, want ${JSON.stringify(testCase.paths)}`)
  }
  for (const [i, wantPath] of testCase.paths.entries()) {
    if (recorded[i]?.userAgent !== UA) {
      problems.push(`probe ${i} sent User-Agent ${JSON.stringify(recorded[i]?.userAgent)}, want ${UA}`)
    }
  }
  for (const needle of testCase.query ?? []) {
    if (!recorded.some((r) => r.query.includes(needle))) {
      problems.push(`no probe carried ${JSON.stringify(needle)}`)
    }
  }
  if (problems.length > 0) {
    failures++
    console.log(`FAIL ${testCase.name}\n  ${problems.join("\n  ")}`)
    return
  }
  console.log(`ok   ${testCase.name} (${result.status}, ${elapsedMs} ms)`)
}

if (failures === 0) {
  fs.rmSync(WORK, { recursive: true, force: true })
  console.log(`\nAll ${cases.length} Tidal probe checks passed.`)
} else {
  console.log(`\n${failures} of ${cases.length} Tidal probe checks failed.`)
}
process.exit(failures === 0 ? 0 : 1)
