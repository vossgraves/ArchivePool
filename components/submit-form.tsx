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
}: {
  label: string
  name: string
  placeholder?: string
  required?: boolean
  type?: string
  hint?: string
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
        className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-ring focus:ring-2"
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
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
              <Field label="Access token" name="token" placeholder="Bearer token from a Tidal session" />
              <Field label="Refresh token" name="refreshToken" placeholder="Optional" />
              <Field label="Country code" name="countryCode" placeholder="US" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Only needed if you already have a token. Sign-in above is the easy path.
              </p>
            </div>
          </details>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="User auth token" name="token" required placeholder="Qobuz user_auth_token" />
          <Field label="App ID" name="appId" required placeholder="Qobuz app_id" />
          <Field label="Username" name="username" placeholder="Optional label only" />
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
