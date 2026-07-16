"use client"

import { useActionState, useState } from "react"
import { submitSource, type SubmitState } from "@/app/actions/submit"
import { TidalConnect } from "@/components/tidal-connect"
import { KIND_LABELS, SERVICE_LABELS, type Kind, type Service } from "@/lib/sources"

const initial: SubmitState = { ok: false, message: "" }

function Field({
  label,
  name,
  placeholder,
  required,
  type = "text",
  hint,
  value,
  onChange,
}: {
  label: string
  name: string
  placeholder?: string
  required?: boolean
  type?: string
  hint?: string
  value?: string
  onChange?: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="text-muted-foreground"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        {...(onChange ? { value: value ?? "", onChange: (e) => onChange(e.target.value) } : {})}
        className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-ring focus:ring-2"
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

/**
 * Parses a pasted Qobuz "account drop" message into the fields we need. Handles the common
 * formats seen in share messages, e.g.:
 *   Token ➠ LD3q...       (also "user_auth_token", "auth token", with :, =, or ➠/→/- separators)
 *   User ID ➠ 13175351
 *   use app_id: 312369995 & app_secret: e79f...
 * Returns only the keys it could confidently extract so we never clobber a field with a blank.
 */
function parseQobuzMessage(text: string): { token?: string; appId?: string; appSecret?: string; username?: string } {
  const out: { token?: string; appId?: string; appSecret?: string; username?: string } = {}
  // Separators used between a label and its value: ➠ → ⇒ » : = - (any run of them, plus spaces)
  const sep = "\\s*(?:➠|→|⇒|»|:|=|-)+\\s*"
  const grab = (labels: string[], valuePattern: string): string | undefined => {
    for (const label of labels) {
      const re = new RegExp(`${label}${sep}(${valuePattern})`, "i")
      const m = text.match(re)
      if (m?.[1]) return m[1].trim()
    }
    return undefined
  }
  // app_id / app_secret are usually inline ("app_id: 3123 & app_secret: e79f...").
  out.appId = grab(["app[\\s_]?id"], "\\d{6,}")
  out.appSecret = grab(["app[\\s_]?secret"], "[a-f0-9]{20,}")
  // Token: a long URL-safe token string. Match the labelled value on its own line.
  out.token = grab(["user[\\s_]?auth[\\s_]?token", "auth[\\s_]?token", "token"], "[A-Za-z0-9_\\-]{20,}")
  out.username = grab(["user[\\s_]?id", "user[\\s_]?name", "user"], "[A-Za-z0-9_\\-@.]+")
  return out
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[]
  value: T
  onChange: (v: T) => void
  labels: Record<T, string>
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
            value === opt ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

export function SubmitForm() {
  const [service, setService] = useState<Service>("tidal")
  const [kind, setKind] = useState<Kind>("api")
  const [state, action, pending] = useActionState(submitSource, initial)

  // Controlled Qobuz account fields so the "paste from message" box can auto-fill them.
  const [qToken, setQToken] = useState("")
  const [qAppId, setQAppId] = useState("")
  const [qAppSecret, setQAppSecret] = useState("")
  const [qUsername, setQUsername] = useState("")
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null)

  function applyQobuzPaste(text: string) {
    const parsed = parseQobuzMessage(text)
    const filled: string[] = []
    if (parsed.token) {
      setQToken(parsed.token)
      filled.push("token")
    }
    if (parsed.appId) {
      setQAppId(parsed.appId)
      filled.push("app_id")
    }
    if (parsed.appSecret) {
      setQAppSecret(parsed.appSecret)
      filled.push("app_secret")
    }
    if (parsed.username) {
      setQUsername(parsed.username)
      filled.push("user id")
    }
    setPasteFeedback(filled.length ? `Filled ${filled.join(", ")}.` : "Couldn't find any Qobuz fields in that text.")
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="kind" value={kind} />

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Service</span>
        <Segmented options={["tidal", "qobuz"] as Service[]} value={service} onChange={setService} labels={SERVICE_LABELS} />
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Type</span>
        <Segmented options={["api", "account"] as Kind[]} value={kind} onChange={setKind} labels={KIND_LABELS} />
      </div>

      <div className="h-px bg-border" />

      {kind === "api" ? (
        <div className="flex flex-col gap-4">
          <Field
            label="Base URL"
            name="baseUrl"
            required
            placeholder="https://instance.example.com"
            hint="The restream / instance endpoint that resolves stream URLs."
          />
          <Field label="Health path" name="healthPath" placeholder="/health" hint="Optional path used to verify the instance is up." />
          <Field label="Premium probe URL" name="probeUrl" placeholder="/track/12345" hint="Optional. A response mentioning FLAC / hi-res marks it premium." />
        </div>
      ) : service === "tidal" ? (
        <div className="flex flex-col gap-4">
          <TidalConnect />
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
              Or paste a token manually
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-3">
              <Field key="tidal-token" label="Access token" name="token" placeholder="Bearer token from a Tidal session" />
              <Field key="tidal-refreshToken" label="Refresh token" name="refreshToken" placeholder="Optional" />
              <Field key="tidal-countryCode" label="Country code" name="countryCode" placeholder="US" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Only needed if you already have a token. Sign-in above is the easy path.
              </p>
            </div>
          </details>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Paste from message</span>
            <textarea
              rows={4}
              placeholder={"Paste the full Qobuz message here…\nToken ➠ …   app_id: …   app_secret: …"}
              autoComplete="off"
              onChange={(e) => applyQobuzPaste(e.target.value)}
              onPaste={(e) => applyQobuzPaste(e.clipboardData.getData("text"))}
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none ring-ring focus:ring-2"
            />
            <span className="text-xs text-muted-foreground">
              {pasteFeedback ?? "Auto-fills token, app_id, app_secret and user id from a share message."}
            </span>
          </label>

          <div className="h-px bg-border" />

          <Field
            key="qobuz-token"
            label="User auth token"
            name="token"
            required
            placeholder="Qobuz user_auth_token"
            value={qToken}
            onChange={setQToken}
          />
          <Field key="qobuz-appId" label="App ID" name="appId" required placeholder="Qobuz app_id" value={qAppId} onChange={setQAppId} />
          <Field
            key="qobuz-appSecret"
            label="App Secret"
            name="appSecret"
            required
            placeholder="Qobuz app_secret"
            hint="Required to sign stream URLs. Without it, the app cannot resolve Qobuz FLAC."
            value={qAppSecret}
            onChange={setQAppSecret}
          />
          <Field
            key="qobuz-username"
            label="Username"
            name="username"
            placeholder="Optional label only"
            value={qUsername}
            onChange={setQUsername}
          />
        </div>
      )}

      <Field label="Note" name="note" placeholder="Optional public note (no personal info)" />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Verifying…" : "Verify & contribute"}
      </button>

      {state.message && (
        <div
          className={`rounded-md border p-3 text-sm leading-relaxed ${
            state.ok ? "border-border bg-card" : "border-destructive/40 bg-card text-destructive"
          }`}
        >
          {state.ok && state.status && (
            <span className="mr-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              [{state.status}
              {state.premium ? " · premium" : ""}]
            </span>
          )}
          {state.message}
        </div>
      )}
    </form>
  )
}
