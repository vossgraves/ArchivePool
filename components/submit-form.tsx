"use client"

import { useEffect, useActionState, useRef, useState } from "react"
import { submitSource, type SubmitState } from "@/app/actions/submit"
import { TidalConnect } from "@/components/tidal-connect"
import { QobuzConnect } from "@/components/qobuz-connect"
import { Button } from "@/components/ui/button"
import { CheckField, Field as TextField } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"
import { KIND_LABELS, SERVICE_LABELS, type Kind, type Service } from "@/lib/sources"

const initial: SubmitState = { ok: false, message: "" }

/**
 * Thin adapter over the shared Field: the credential inputs below all speak `onChange`, and the
 * shared control takes `onValueChange`. Keeping the mapping here means every field in this form
 * gets the shared label/error/focus handling without rewriting 12 call sites.
 */
function Field({
  label,
  name,
  placeholder,
  required,
  type = "text",
  hint,
  value,
  onChange,
  mono = true,
}: {
  label: string
  name: string
  placeholder?: string
  required?: boolean
  type?: string
  hint?: string
  value?: string
  onChange?: (v: string) => void
  mono?: boolean
}) {
  return (
    <TextField
      label={label}
      name={name}
      type={type}
      placeholder={placeholder}
      required={required}
      hint={hint}
      value={value}
      mono={mono}
      onValueChange={onChange}
    />
  )
}

/**
 * Optional Amazon instance auth material, shared by the instance and account branches: the
 * instance operator's bypass token, and/or a pre-minted Cloudflare Turnstile JWT with the moment
 * it expires. The app normally solves the instance's challenge itself, so an operator only fills
 * these in when they hold one already — and the pool stores them encrypted, like every other
 * credential.
 */
function AmazonInstanceAuth() {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
        Instance auth (optional)
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-3">
        <Field
          key="amazon-bypassToken"
          label="Bypass token"
          name="bypassToken"
          placeholder="Operator-issued token"
          hint="Skips the instance's Turnstile challenge. Long-lived; encrypted at rest like any other credential."
        />
        <Field
          key="amazon-turnstileJwt"
          label="Turnstile JWT"
          name="turnstileJwt"
          placeholder="Pre-minted token"
          hint="Optional. A token you already solved the instance's challenge for; the app mints its own when this is absent."
        />
        <Field
          key="amazon-turnstileJwtExpiresAt"
          label="Turnstile JWT expires"
          name="turnstileJwtExpiresAt"
          placeholder="2026-09-20T12:00:00Z"
          hint="Optional. When the token above stops working, so a client can skip it without a failed call. Not a secret."
        />
      </div>
    </details>
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

function parseTidalMessage(text: string): { token?: string; refreshToken?: string; countryCode?: string } {
  const out: { token?: string; refreshToken?: string; countryCode?: string } = {}
  const sep = "\\s*(?:➠|→|⇒|»|:|=|-)+\\s*"
  const grab = (labels: string[], valuePattern: string): string | undefined => {
    for (const label of labels) {
      const re = new RegExp(`${label}${sep}(${valuePattern})`, "i")
      const m = text.match(re)
      if (m?.[1]) return m[1].trim()
    }
    return undefined
  }
  const jwtPat = "[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
  out.token = grab(["access[\\s_]?token", "token", "bearer[\\s_]?token"], jwtPat)
  out.refreshToken = grab(["refresh[\\s_]?token", "o2[\\s_]?refresh", "refresh"], jwtPat)
  out.countryCode = grab(["country[\\s_]?code", "country", "region", "cc"], "[A-Za-z]{2}")
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
    <div className="inline-flex w-full flex-wrap rounded-md border border-border p-1 sm:w-auto">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`flex-1 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none sm:px-4 ${
            value === opt ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

export function SubmitForm({ username = null }: { username?: string | null }) {
  const [service, setService] = useState<Service>("tidal")
  const [kind, setKind] = useState<Kind>("api")
  // Default is credited, not anonymous: a signed-in person contributing has already identified
  // themselves to the site, and the pool benefits from knowing who stands behind an entry.
  // Attribution is still theirs to decline, and the checkbox says plainly what it does.
  const [credit, setCredit] = useState(true)
  const [state, action, pending] = useActionState(submitSource, initial)
  // Manual-paste sections start closed, and `required` inside a closed <details> is a trap:
  // native validation cannot focus the hidden control, so the submit does nothing and the page
  // jumps to the top. The server already validates these fields, so the collapsed sections
  // carry no required flags; an error naming a field inside one reopens it so the fix is
  // visible right next to the notice.
  const [tidalManualOpen, setTidalManualOpen] = useState(false)
  const [qobuzManualOpen, setQobuzManualOpen] = useState(false)
  const noticeRef = useRef<HTMLDivElement>(null)
  const serviceRef = useRef(service)
  useEffect(() => {
    serviceRef.current = service
  }, [service])

  useEffect(() => {
    if (!state.message) return
    if (!state.ok) {
      const current = serviceRef.current
      if (current === "qobuz" && /token|app_?id|app_?secret/i.test(state.message)) setQobuzManualOpen(true)
      if (current === "tidal" && /token/i.test(state.message)) setTidalManualOpen(true)
    }
    // The verdict renders below the fold, far from the fields just filled: bring it into
    // view and focus it after every submit, success or failure. focus() scrolls instantly by
    // default, which would cut the smooth scroll short, so it leaves scrolling to the line above.
    noticeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    noticeRef.current?.focus({ preventScroll: true })
  }, [state])

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

  // Tidal: same paste helper as Qobuz, but for Tidal's JWT access/refresh + country
  const [tToken, setTToken] = useState("")
  const [tRefresh, setTRefresh] = useState("")
  const [tCountry, setTCountry] = useState("")
  const [tPasteFeedback, setTPasteFeedback] = useState<string | null>(null)

  function applyTidalPaste(text: string) {
    const parsed = parseTidalMessage(text)
    const filled: string[] = []
    if (parsed.token) {
      setTToken(parsed.token)
      filled.push("access token")
    }
    if (parsed.refreshToken) {
      setTRefresh(parsed.refreshToken)
      filled.push("refresh token")
    }
    if (parsed.countryCode) {
      setTCountry(parsed.countryCode.toUpperCase())
      filled.push("country")
    }
    setTPasteFeedback(filled.length ? `Filled ${filled.join(", ")}.` : "Couldn't find any Tidal fields in that text.")
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="kind" value={kind} />

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Service</span>
        <Segmented
          options={["tidal", "qobuz", "deezer", "apple-music", "amazon-music"] as Service[]}
          value={service}
          onChange={(next) => {
            setService(next)
            // Apple Music has no self-hosted instance tier, so an "api" submission is meaningless
            // for it. Deezer and Amazon both have one — a Deezer instance answers
            // GET {baseUrl}/ with an accounts document, an Amazon one GET {baseUrl}/health — so
            // both kinds stay selectable there.
            if (next === "apple-music") setKind("account")
          }}
          labels={SERVICE_LABELS}
        />
      </div>

      {service !== "apple-music" && (
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">Type</span>
          <Segmented options={["api", "account"] as Kind[]} value={kind} onChange={setKind} labels={KIND_LABELS} />
        </div>
      )}

      <div className="h-px bg-border" />

      {kind === "api" ? (
        <div className="flex flex-col gap-4">
          <Field
            label="Base URL"
            name="baseUrl"
            required
            placeholder="https://instance.example.com"
            hint={
              service === "amazon-music"
                ? "The Amazon instance base URL the app should call."
                : service === "deezer"
                  ? "The Deezer instance base URL — it answers `GET /` with an accounts document and streams from `/stream/?isrc=…`."
                  : "The restream / instance endpoint that resolves stream URLs."
            }
          />
          <Field label="Health path" name="healthPath" placeholder="/health" hint="Optional path used to verify the instance is up." />
          <Field label="Premium probe URL" name="probeUrl" placeholder="/track/12345" hint="Optional. A response mentioning FLAC / hi-res marks it premium." />
          {service === "amazon-music" ? <AmazonInstanceAuth /> : null}
        </div>
      ) : service === "tidal" ? (
        <div className="flex flex-col gap-4">
          <TidalConnect />
          <details
            className="rounded-md border border-border"
            open={tidalManualOpen}
            onToggle={(e) => setTidalManualOpen(e.currentTarget.open)}
          >
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
              Or paste a token manually
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Paste from message</span>
                <textarea
                  rows={4}
                  placeholder={"Paste the full Tidal message here…\nAccess Token ➠ …   Refresh Token ➠ …   Country ➠ …"}
                  autoComplete="off"
                  onChange={(e) => applyTidalPaste(e.target.value)}
                  onPaste={(e) => applyTidalPaste(e.clipboardData.getData("text"))}
                  className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none ring-ring focus:ring-2"
                />
                <span className="text-xs text-muted-foreground">
                  {tPasteFeedback ?? "Auto-fills access token, refresh token and country from a share message — just like Qobuz."}
                </span>
              </label>

              <div className="h-px bg-border" />

              <Field
                key="tidal-token"
                label="Access token"
                name="token"
                placeholder="Bearer token (eyJ…)"
                value={tToken}
                onChange={setTToken}
              />
              <Field
                key="tidal-refreshToken"
                label="Refresh token"
                name="refreshToken"
                placeholder="Optional — refresh JWT"
                value={tRefresh}
                onChange={setTRefresh}
              />
              <Field
                key="tidal-countryCode"
                label="Country code"
                name="countryCode"
                placeholder="US"
                value={tCountry}
                onChange={(v) => setTCountry(v.toUpperCase())}
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Only needed if you already have a token. Paste the full message above — the easy path is still Sign in with Tidal.
              </p>
            </div>
          </details>
        </div>
      ) : service === "apple-music" ? (
        <div className="flex flex-col gap-4">
          <Field
            key="apple-music-token"
            label="Media-User-Token"
            name="token"
            required
            placeholder="0.Ap…"
            hint="Your personal Apple Music web token (always starts with 0.). Sign in at music.apple.com, then copy the `media-user-token` value from your browser's dev tools (Application → Cookies) or from any authenticated API request header."
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            The token unlocks user-scoped Apple Music features (lyrics, storefront) and — with an
            active subscription — full-track playback. It expires when you sign out of the web
            player, so re-submit if your token stops working. The dev (Bearer) JWT is not needed:
            apps fetch their own.
          </p>
        </div>
      ) : service === "amazon-music" ? (
        <div className="flex flex-col gap-4">
          <Field
            key="amazon-music-session"
            label="Amazon session artifact"
            name="session"
            required
            placeholder="Paste the saved Amazon Music web session"
            hint="Sign in to music.amazon.com, then copy the Amazon Music session cookie value from your browser's dev tools (Application → Cookies)."
          />
          <AmazonInstanceAuth />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Amazon&apos;s Music Web API is approval-gated, so this pool cannot probe the session: the
            entry is checked for shape only and handed out on that basis, and the app reports it dead
            if Amazon rejects it during playback. Signing in directly in the app is the better option
            unless you specifically want to share the account. To pool an instance instead — a base
            URL the app calls, with the auth material above — submit an
            {" "}<span className="text-foreground">API / Instance</span> entry for Amazon Music.
          </p>
        </div>
      ) : service === "deezer" ? (
        <div className="flex flex-col gap-4">
          <Field
            key="deezer-arl"
            label="ARL cookie"
            name="arl"
            required
            placeholder="Long hexadecimal string"
            hint="Log in to deezer.com, then copy the value of the `arl` cookie from your browser's dev tools (Application → Cookies)."
          />
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">Advanced</summary>
            <div className="flex flex-col gap-4 border-t border-border p-3">
              <Field
                key="deezer-masterSecret"
                label="Master secret"
                name="masterSecret"
                placeholder="Leave blank unless Deezer rotated it"
                hint="Overrides the decryption key the app ships with. Almost never needed."
              />
            </div>
          </details>
          <p className="text-xs text-muted-foreground leading-relaxed">
            A paid plan is required for lossless. Free accounts are accepted but only ever resolve
            previews, so they are recorded as {'"'}preview{'"'} rather than {'"'}alive{'"'}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <QobuzConnect />
          <details
            className="rounded-md border border-border"
            open={qobuzManualOpen}
            onToggle={(e) => setQobuzManualOpen(e.currentTarget.open)}
          >
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
              Or paste a token manually
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-3">
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
                placeholder="Qobuz user_auth_token"
                value={qToken}
                onChange={setQToken}
              />
              <Field key="qobuz-appId" label="App ID" name="appId" placeholder="Qobuz app_id" value={qAppId} onChange={setQAppId} />
              <Field
                key="qobuz-appSecret"
                label="App Secret"
                name="appSecret"
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
          </details>
        </div>
      )}

      <Field
        label="Expires on"
        name="expiresAt"
        mono={false}
        placeholder="2026-10-07"
        hint="Optional. The plan's end date from the account check, as YYYY-MM-DD. Past it the entry stops being handed out — a lapsed plan usually still signs in, it just quietly drops to previews, which a health check cannot tell apart mid-cycle."
      />

      <Field
        label="Note"
        name="note"
        mono={false}
        placeholder="Optional public note — e.g. which region or CDN it serves"
        hint="Shown with the entry. Don’t include anything personal: credentials are pooled and shared."
      />

      {username ? (
        <CheckField
          name="credit"
          label={`Credit this to @${username}`}
          description="On by default for your own contributions. Uncheck to contribute anonymously — the entry is stored either way, the only difference is whether your name is attached."
          checked={credit}
          onCheckedChange={setCredit}
        />
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Contributing anonymously.{" "}
          <a href="/login" className="text-foreground underline underline-offset-4">
            Sign in
          </a>{" "}
          if you want your username credited to the entry.
        </p>
      )}

      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Verifying…" : "Verify & contribute"}
      </Button>

      {state.message ? (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <Notice tone={state.ok ? "ok" : "error"}>
            {state.ok && state.status ? (
              <span className="mr-2 font-mono text-[0.625rem] uppercase tracking-[0.1em]">
                {state.status}
                {state.premium ? " · premium" : ""}
              </span>
            ) : null}
            {state.message}
          </Notice>
        </div>
      ) : null}
    </form>
  )
}
