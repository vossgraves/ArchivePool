import { createHash } from "crypto"

export type Service = "tidal" | "qobuz"
export type Kind = "api" | "account"
export type Status = "pending" | "alive" | "preview" | "dead"

export const SERVICES: Service[] = ["tidal", "qobuz"]
export const KINDS: Kind[] = ["api", "account"]

export const SERVICE_LABELS: Record<Service, string> = {
  tidal: "Tidal",
  qobuz: "Qobuz",
}

export const KIND_LABELS: Record<Kind, string> = {
  api: "API / Instance",
  account: "Account",
}

/** The four public status categories. */
export const CATEGORIES: { service: Service; kind: Kind; label: string }[] = [
  { service: "tidal", kind: "api", label: "Tidal API" },
  { service: "tidal", kind: "account", label: "Tidal Account" },
  { service: "qobuz", kind: "api", label: "Qobuz API" },
  { service: "qobuz", kind: "account", label: "Qobuz Account" },
]

export function isService(v: unknown): v is Service {
  return v === "tidal" || v === "qobuz"
}
export function isKind(v: unknown): v is Kind {
  return v === "api" || v === "account"
}

/** Deterministic fingerprint used to dedupe identical contributions. */
export function fingerprint(service: Service, kind: Kind, payload: Record<string, unknown>): string {
  let basis = ""
  if (kind === "api") {
    basis = normalizeUrl(String(payload.baseUrl ?? ""))
  } else {
    // Prefer a token; otherwise fall back to username/password pair.
    const token = String(payload.token ?? "").trim()
    if (token) basis = token
    else basis = `${String(payload.username ?? "").trim().toLowerCase()}:${String(payload.password ?? "").trim()}`
  }
  return createHash("sha256").update(`${service}|${kind}|${basis}`).digest("hex")
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed.toLowerCase()
}

/** A short, non-reversible label safe to show publicly. */
export function maskLabel(service: Service, kind: Kind, payload: Record<string, unknown>): string {
  const svc = SERVICE_LABELS[service]
  if (kind === "api") {
    try {
      const host = new URL(String(payload.baseUrl ?? "")).host
      return `${svc} API · ${host}`
    } catch {
      return `${svc} API`
    }
  }
  const user = String(payload.username ?? "").trim()
  if (user) {
    const shown = user.length <= 2 ? user[0] ?? "" : `${user.slice(0, 2)}…`
    return `${svc} Account · ${shown}`
  }
  const token = String(payload.token ?? "").trim()
  if (token) return `${svc} Account · ****${token.slice(-4)}`
  return `${svc} Account`
}

/** Very light obfuscation so raw payloads never render, even in logs surfaced to clients. */
export function publicSummary(service: Service, kind: Kind) {
  return { service, kind, serviceLabel: SERVICE_LABELS[service], kindLabel: KIND_LABELS[kind] }
}
