"use server"

import { sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { sourceEntries } from "@/lib/db/schema"
import { runCheck } from "@/lib/health"
import { fingerprint, isKind, isService, maskLabel, type Kind, type Service } from "@/lib/sources"

export interface SubmitState {
  ok: boolean
  message: string
  status?: string
  premium?: boolean
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
  // qobuz account
  return {
    token: String(form.get("token") ?? "").trim(),
    appId: String(form.get("appId") ?? "").trim(),
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
  if (!String(payload.token ?? "").trim()) return "A token is required for account submissions."
  if (service === "qobuz" && !String(payload.appId ?? "").trim()) return "Qobuz submissions need an app_id."
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

  const fp = fingerprint(service, kind, payload)
  const label = maskLabel(service, kind, payload)

  // Validate immediately so the contributor gets instant feedback.
  const result = await runCheck(service, kind, payload)

  try {
    await db
      .insert(sourceEntries)
      .values({
        service,
        kind,
        label,
        payload,
        fingerprint: fp,
        status: result.status,
        premium: result.premium,
        detail: result.detail,
        latencyMs: result.latencyMs,
        checkCount: 1,
        okCount: result.ok ? 1 : 0,
        consecutiveFailures: result.ok ? 0 : 1,
        lastCheckedAt: new Date(),
        removed: false,
        disabled: false,
      })
      .onConflictDoUpdate({
        target: sourceEntries.fingerprint,
        set: {
          payload,
          label,
          status: result.status,
          premium: result.premium,
          detail: result.detail,
          latencyMs: result.latencyMs,
          checkCount: sql`${sourceEntries.checkCount} + 1`,
          okCount: sql`${sourceEntries.okCount} + ${result.ok ? 1 : 0}`,
          consecutiveFailures: result.ok ? 0 : sql`${sourceEntries.consecutiveFailures} + 1`,
          lastCheckedAt: new Date(),
          removed: false,
        },
      })
  } catch {
    return { ok: false, message: "Could not save the submission. Try again." }
  }

  revalidatePath("/")

  if (!result.ok) {
    return {
      ok: true,
      status: result.status,
      premium: result.premium,
      message: `Saved, but the live check failed (${result.detail}). It will be retried automatically and excluded from the pool until it passes.`,
    }
  }
  return {
    ok: true,
    status: result.status,
    premium: result.premium,
    message:
      result.status === "alive"
        ? "Verified and added to the pool as a premium source. Thank you!"
        : "Added to the pool. It works but was not detected as premium/lossless.",
  }
}
