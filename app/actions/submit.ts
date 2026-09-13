"use server"

import { revalidatePath } from "next/cache"
import { describeSaveError, ingestSource } from "@/lib/ingest"
import { isKind, isService, type Kind, type Service } from "@/lib/sources"
import { getSessionUserId } from "@/lib/sessions"
import { findUsernameById } from "@/lib/users"

/**
 * Parses the contributor's declared expiry. Date-only input is pinned to the end of that day in
 * UTC, so "expires today" stays servable for the rest of the day rather than dying at midnight
 * in whatever zone the server happens to run in. A past or unparseable date is rejected rather
 * than silently dropped, since an entry with no expiry is treated as never expiring.
 */
function parseExpiry(raw: string): { value: Date | null; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { value: null, error: null }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  const parsed = new Date(dateOnly ? `${trimmed}T23:59:59Z` : trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return { value: null, error: "Enter the expiry as YYYY-MM-DD, or leave it blank." }
  }
  if (parsed.getTime() <= Date.now()) {
    return { value: null, error: "That expiry date has already passed." }
  }
  return { value: parsed, error: null }
}

export interface SubmitState {
  ok: boolean
  message: string
  status?: string
  premium?: boolean
  /** The username this submission was credited to, when the contributor opted in. */
  creditedTo?: string | null
}

function buildPayload(service: Service, kind: Kind, form: FormData): Record<string, unknown> {
  const note = String(form.get("note") ?? "").trim() || undefined
  if (kind === "api") {
    return {
      baseUrl: String(form.get("baseUrl") ?? "").trim(),
      healthPath: String(form.get("healthPath") ?? "").trim() || undefined,
      probeUrl: String(form.get("probeUrl") ?? "").trim() || undefined,
      note,
    }
  }
  if (service === "tidal") {
    return {
      token: String(form.get("token") ?? "").trim(),
      refreshToken: String(form.get("refreshToken") ?? "").trim() || undefined,
      countryCode: String(form.get("countryCode") ?? "").trim() || undefined,
      note,
    }
  }
  if (service === "deezer") {
    return {
      arl: String(form.get("arl") ?? "").trim(),
      // Optional override for the Blowfish key-derivation secret. The app ships a working
      // default, so this only needs filling in if Deezer ever rotates it.
      masterSecret: String(form.get("masterSecret") ?? "").trim() || undefined,
      note,
    }
  }
  if (service === "apple-music") {
    return {
      token: String(form.get("token") ?? "").trim(),
      note,
    }
  }
  // qobuz account
  return {
    token: String(form.get("token") ?? "").trim(),
    appId: String(form.get("appId") ?? "").trim(),
    appSecret: String(form.get("appSecret") ?? "").trim(),
    username: String(form.get("username") ?? "").trim() || undefined,
    note,
  }
}

function validate(service: Service, kind: Kind, payload: Record<string, unknown>): string | null {
  if (kind === "api") {
    const url = String(payload.baseUrl ?? "")
    try {
      const u = new URL(url)
      if (!/^https?:$/.test(u.protocol)) return "Base URL must be http(s)."
    } catch {
      return "Enter a valid base URL (including https://)."
    }
    return null
  }
  if (service === "deezer") {
    // Deezer authenticates with an ARL cookie instead of a token, so it must be checked before
    // the generic token requirement below.
    const arl = String(payload.arl ?? "").trim()
    if (!arl) return "Deezer submissions need an ARL cookie value."
    if (!/^[a-f0-9]{100,}$/i.test(arl)) {
      return "That doesn't look like an ARL — expected a long hexadecimal string."
    }
    return null
  }
  if (service === "apple-music") {
    const token = String(payload.token ?? "").trim()
    if (!token) return "Apple Music submissions need a Media-User-Token."
    if (!token.startsWith("0.")) return "That doesn't look like a Media-User-Token — it should start with \"0.\"."
    return null
  }
  if (!String(payload.token ?? "").trim()) return "A token is required for account submissions."
  if (service === "qobuz") {
    if (!String(payload.appId ?? "").trim()) return "Qobuz submissions need an app_id."
    if (!String(payload.appSecret ?? "").trim())
      return "Qobuz submissions need an app_secret (required to sign stream URLs)."
  }
  return null
}

export async function submitSource(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const service = form.get("service")
  const kind = form.get("kind")
  if (!isService(service) || !isKind(kind)) {
    return { ok: false, message: "Pick a valid service and type." }
  }

  const payload = buildPayload(service, kind, form)
  const invalid = validate(service, kind, payload)
  if (invalid) return { ok: false, message: invalid }

  const expiry = parseExpiry(String(form.get("expiresAt") ?? ""))
  if (expiry.error) return { ok: false, message: expiry.error }

  // Attribution is opt-in, and the form carries only a boolean — never a name. The credited
  // username is resolved from the verified session server-side, so a client cannot claim to be
  // somebody else. Logged-out or unchecked submissions stay anonymous (contributor = null).
  let contributor: string | null = null
  if (form.get("credit") === "on") {
    const userId = await getSessionUserId()
    if (userId) contributor = await findUsernameById(userId)
  }

  // Validate immediately so the contributor gets instant feedback.
  let result
  try {
    result = await ingestSource(service, kind, payload, { contributor, expiresAt: expiry.value })
  } catch (e) {
    console.log("[v0] submit ingest failed:", e instanceof Error ? e.stack : e)
    return { ok: false, message: describeSaveError(e) }
  }

  revalidatePath("/")

  if (!result.saved) {
    // Pool admission policy: rejected because the live check failed, or because the source
    // works but has no premium/lossless entitlement. Nothing was stored.
    return {
      ok: false,
      status: result.status,
      premium: result.premium,
      message: result.ok
        ? "Not added: this source works but has no premium/lossless entitlement. The pool only accepts premium sources."
        : `Not added: the live check failed (${result.detail}). Only working, premium sources are accepted.`,
    }
  }
  return {
    ok: true,
    status: result.status,
    premium: result.premium,
    creditedTo: contributor,
    message: contributor
      ? `Verified as working and premium — added to the pool, credited to @${contributor}. Thank you!`
      : "Verified as working and premium — added to the pool. Thank you!",
  }
}
