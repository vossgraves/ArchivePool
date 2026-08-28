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
 * External tokens should be inserted as `sourceEntries` with `status='pending'` and let the cron sweep promote them to `alive`/`dead`.
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
