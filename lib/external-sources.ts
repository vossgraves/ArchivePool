/**
 * External token fetchers for the pool.
 *
 * Two community sources are evaluated:
 *  - firehawk52 (https://rentry.co/firehawk52) — Rentry markdown with Qobuz tokens (id, token, expiry) and Deezer ARLs.
 *    The raw markdown is at https://rentry.co/firehawk52/raw (or /api/paste). It is a markdown table, not a JSON API,
 *    so we scrape it. Cloudflare protection makes direct fetch from Vercel reliable (server-side, no JS challenge),
 *    but the format can change without notice — treat as best-effort and always health-check before inserting.
 *  - qbdlxui.alwaysdata.net — QobuzDownloaderX UI (Neutralino web build). It does not expose a public token API;
 *    its tokens are the same firehawk52 set bundled in its JS. No stable API was found (the JS at /assets/index-*.js
 *    contains no token JSON). We therefore treat qbdlxui as *not* a viable pool source and keep firehawk52 as primary.
 *
 * Health checks (lib/health.ts) already verify Qobuz (appId+appSecret+token via track/getFileUrl signature) and Deezer (ARL via gw-light.php).
 * External tokens should be inserted as `accountEntries` with `status='pending'` and let the cron sweep promote them to `alive`/`dead`.
 *
 * Usage: call `fetchFirehawkTokens()` from an admin cron or manual trigger, then insert via `insertExternalTokens()`.
 */

export interface FirehawkQobuzToken {
  id: string
  token: string
  expiry?: string
}

export interface FirehawkDeezerArl {
  arl: string
  country?: string
}

const RENTRY_RAW_URLS = [
  "https://rentry.co/firehawk52/raw",
  "https://rentry.org/firehawk52/raw",
  "https://rentry.co/api/paste/firehawk52",
]

const QOBUZ_PROBE_APP_ID = "100000005"
const QOBUZ_PROBE_APP_SECRET = "d2a459d68bb42a2d6462a1230517d3d4adadc4adadc4adadc4adadc4adadc"

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "ArchiveTune-SourcePool/1.0" },
      cache: "no-store",
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export async function fetchFirehawkRaw(): Promise<string | null> {
  for (const url of RENTRY_RAW_URLS) {
    const text = await fetchText(url)
    if (text && text.includes("Qobuz") && text.includes("Deezer")) return text
  }
  return null
}

export function parseFirehawkQobuzTokens(raw: string): FirehawkQobuzToken[] {
  const tokens: FirehawkQobuzToken[] = []
  // Markdown table rows: | 2023-08-18 | `2522796` | `TOKEN` |
  const rowRe = /\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|)\s*\|\s*`?(\d{5,8})`?\s*\|\s*`([A-Za-z0-9_\-+/=]{30,})`/g
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(raw))) {
    const [, expiry, id, token] = m
    if (id && token && token.length > 40) tokens.push({ id, token, expiry: expiry || undefined })
  }
  return tokens
}

export function parseFirehawkDeezerArls(raw: string): FirehawkDeezerArl[] {
  const arls: FirehawkDeezerArl[] = []
  // ARLs are long hex strings (180+ chars) in backticks
  const arlRe = /`([a-f0-9]{180,})`/gi
  let m: RegExpExecArray | null
  while ((m = arlRe.exec(raw))) {
    const arl = m[1]
    if (arl.length >= 180) arls.push({ arl })
  }
  return arls
}

export async function fetchFirehawkTokens(): Promise<{ qobuz: FirehawkQobuzToken[]; deezer: FirehawkDeezerArl[] } | null> {
  const raw = await fetchFirehawkRaw()
  if (!raw) return null
  return { qobuz: parseFirehawkQobuzTokens(raw), deezer: parseFirehawkDeezerArls(raw) }
}

// qbdlxui.alwaysdata.net — no public token API. The web UI is a Neutralino build whose JS
// does not contain a token list. We keep the stub for future use if the site adds an API.
export async function fetchQbdlxTokens(): Promise<FirehawkQobuzToken[] | null> {
  // Probe the site's asset list for any JSON token endpoint
  const html = await fetchText("https://qbdlxui.alwaysdata.net/")
  if (!html) return null
  // The HTML is just a shell loading /assets/index-*.js; no token API found in 2026-08.
  // Return null to signal "not a viable source" — caller should fall back to firehawk52.
  return null
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Community shared-account feeds
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * citegptapi.f5.si — an n8n-backed community pool. The QobuzDownloaderX web UI
 * (qbdlxui.alwaysdata.net) reads its "Free Accounts / Browse shared tokens" page from the
 * webhook below, so hitting the same webhook gives us the community's live shared Qobuz
 * accounts: `[{ token, country?, app_id?, app_secret?, createdAt? }, …]` (~150 entries).
 */
const CITEGPT_SHARED_URL = "https://citegptapi.f5.si/webhook/qbdlx/shared"

export interface QobuzSharedAccount {
  token: string
  appId: string
  appSecret: string
  country?: string
  note?: string
}

/** The most common (app_id, app_secret) pair in the feed, for entries missing credentials. */
function dominantAppPair(entries: Record<string, unknown>[]): { appId: string; appSecret: string } | null {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const appId = String(e.app_id ?? "").trim()
    const appSecret = String(e.app_secret ?? "").trim()
    if (appId && appSecret) counts.set(`${appId}|${appSecret}`, (counts.get(`${appId}|${appSecret}`) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!best) return null
  const [appId, appSecret] = best[0].split("|")
  return { appId, appSecret }
}

export async function fetchQbdlxShared(): Promise<QobuzSharedAccount[] | null> {
  try {
    const res = await fetch(CITEGPT_SHARED_URL, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const raw = (await res.json()) as Record<string, unknown>[]
    if (!Array.isArray(raw)) return null

    const fallback = dominantAppPair(raw) ?? { appId: QOBUZ_PROBE_APP_ID, appSecret: QOBUZ_PROBE_APP_SECRET }
    const out: QobuzSharedAccount[] = []
    for (const e of raw) {
      const token = String(e.token ?? "").trim()
      if (!token) continue
      const appId = String(e.app_id ?? "").trim() || fallback.appId
      const appSecret = String(e.app_secret ?? "").trim() || fallback.appSecret
      const country = String(e.country ?? "").trim() || undefined
      out.push({ token, appId, appSecret, country, note: "qbdlx-shared" })
    }
    return out
  } catch {
    return null
  }
}

/**
 * firehawk52.com (the rentry's replacement) sits behind a Cloudflare managed challenge that
 * plain fetch AND curl_cffi-style TLS impersonation cannot clear (verified 2026-08 — the
 * challenge requires real JS execution). The rentry's raw endpoint now demands an access
 * code too. What still works is the *rendered* rentry page through a rendering proxy, which
 * currently lists no tokens (they moved to firehawk52.com) — kept as a cheap opportunistic
 * fallback in case tokens reappear there.
 */
const JINA_READER = "https://r.jina.ai/"

export async function fetchFirehawkRendered(): Promise<{ qobuz: FirehawkQobuzToken[]; deezer: FirehawkDeezerArl[] } | null> {
  try {
    const res = await fetch(`${JINA_READER}https://rentry.co/firehawk52`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36" },
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!/qobuz/i.test(text) && !/deezer/i.test(text)) return null
    const qobuz = parseFirehawkQobuzTokens(text)
    const deezer = parseFirehawkDeezerArls(text)
    if (qobuz.length === 0 && deezer.length === 0) return null
    return { qobuz, deezer }
  } catch {
    return null
  }
}

/**
 * Fetch every external source and ingest the entries that are NOT already in the pool
 * (dedupe by fingerprint — the same sha256 basis ingestSource persists). New entries run a
 * live health check at ingest time; known ones cost one indexed SELECT, so the hourly cron
 * never re-checks the whole feed. `maxNew` bounds the per-run work.
 */
export async function ingestExternalSources(
  maxNew = 10,
): Promise<{ fetched: number; inserted: number; skippedKnown: number; rejected: number; errors: string[] }> {
  const { inArray } = await import("drizzle-orm")
  const { ingestSource } = await import("@/lib/ingest")
  const { fingerprint } = await import("@/lib/sources")
  const { db } = await import("@/lib/db")
  const { accountEntries } = await import("@/lib/db/schema")
  const { ensureSchema } = await import("@/lib/db/ensure")
  await ensureSchema() // account_entries must exist before the dedupe query below runs
  const errors: string[] = []
  let fetched = 0
  let inserted = 0
  let skippedKnown = 0
  let rejected = 0

  type Candidate = { service: "qobuz" | "deezer"; kind: "account"; payload: Record<string, unknown> }
  const candidates: Candidate[] = []

  // 1) Community shared Qobuz accounts (n8n webhook behind qbdlxui).
  const shared = await fetchQbdlxShared().catch(() => null)
  if (shared && shared.length > 0) {
    for (const a of shared) {
      candidates.push({
        service: "qobuz",
        kind: "account",
        payload: { token: a.token, appId: a.appId, appSecret: a.appSecret, country: a.country, note: a.note },
      })
    }
  } else {
    errors.push("citegptapi webhook unreachable or empty")
  }

  // 2) firehawk52 rendered rentry (opportunistic — see comment on the fetcher).
  const firehawk = await fetchFirehawkRendered().catch(() => null)
  if (firehawk) {
    for (const t of firehawk.qobuz) {
      candidates.push({ service: "qobuz", kind: "account", payload: { token: t.token } })
    }
    for (const a of firehawk.deezer) {
      candidates.push({ service: "deezer", kind: "account", payload: { arl: a.arl } })
    }
  }

  fetched = candidates.length
  if (fetched === 0) return { fetched, inserted, skippedKnown, rejected, errors }

  // Dedupe against the DB: fingerprints are unique per (service, kind, credential).
  const fps = [...new Set(candidates.map((c) => fingerprint(c.service, c.kind, c.payload)))]
  const existing = new Set<string>()
  try {
    for (let i = 0; i < fps.length; i += 100) {
      const batch = fps.slice(i, i + 100)
      const rows = await db
        .select({ fingerprint: accountEntries.fingerprint })
        .from(accountEntries)
        .where(inArray(accountEntries.fingerprint, batch))
      for (const row of rows) existing.add(row.fingerprint)
    }
    skippedKnown = candidates.length - fps.filter((fp) => !existing.has(fp)).length
  } catch (err) {
    errors.push(`dedupe query failed: ${err instanceof Error ? err.message : "unknown"}`)
  }

  const fresh = candidates.filter((c) => !existing.has(fingerprint(c.service, c.kind, c.payload)))
  const batch = fresh.slice(0, maxNew)

  // Ingest candidates CONCURRENTLY (cap 5). Each ingestSource runs a live health check with up
  // to 12s timeout; a serial loop over the full maxNew batch could take 120s on its own and
  // blow the calling cron route's maxDuration=60 → FUNCTION_INVOCATION_TIMEOUT (HTTP 504).
  // Errors stay isolated per candidate exactly as before.
  let next = 0
  const workers = Array.from({ length: Math.min(5, batch.length) }, async () => {
    while (next < batch.length) {
      const c = batch[next++]
      try {
        const result = await ingestSource(c.service, c.kind, c.payload)
        if (result.saved) inserted += 1
        else rejected += 1 // working-but-not-premium or failed live check — not stored
      } catch (err) {
        errors.push(`ingest failed: ${err instanceof Error ? err.message : "unknown"}`)
      }
    }
  })
  await Promise.all(workers)

  return { fetched, inserted, skippedKnown, rejected, errors }
}
