// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useEffect, useActionState, useRef, useState } from "react"
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Globe,
  KeyRound,
  Lock,
  Music2,
  Radio,
  Server,
  Shield,
  Sparkles,
} from "lucide-react"
import { submitSource, type SubmitState } from "@/app/actions/submit"
import { TidalConnect } from "@/components/tidal-connect"
import { QobuzConnect } from "@/components/qobuz-connect"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckField, Field as TextField } from "@/components/ui/field"
import { Notice } from "@/components/ui/notice"
import { KIND_LABELS, SERVICE_LABELS, type Kind, type Service } from "@/lib/sources"
import { cn } from "@/lib/utils"

const initial: SubmitState = { ok: false, message: "" }

const PROVIDER_METADATA: Record<
  Service,
  { label: string; quality: string; subtitle: string; tag: string }
> = {
  tidal: {
    label: "Tidal",
    quality: "Hi-Res FLAC 24/192",
    subtitle: "OAuth Device Flow or Token",
    tag: "OAuth / JWT",
  },
  qobuz: {
    label: "Qobuz",
    quality: "24-bit Studio Master",
    subtitle: "App Secret & User Auth",
    tag: "Native Auth",
  },
  deezer: {
    label: "Deezer",
    quality: "16-bit FLAC / 320k",
    subtitle: "ARL Cookie or Stream Relay",
    tag: "ARL Cookie",
  },
  "apple-music": {
    label: "Apple Music",
    quality: "ALAC Lossless / AAC",
    subtitle: "Media-User-Token (0.Ap…)",
    tag: "Session Token",
  },
  "amazon-music": {
    label: "Amazon Music",
    quality: "Ultra HD Lossless",
    subtitle: "Web Session & Turnstile Auth",
    tag: "Web Session",
  },
}

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

function AmazonInstanceAuth() {
  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value="instance-auth" className="rounded-md border border-border bg-secondary/15">
        <AccordionTrigger className="px-3.5 py-2.5 text-xs font-mono text-muted-foreground hover:text-foreground">
          Instance auth (optional)
        </AccordionTrigger>
        <AccordionContent className="flex flex-col gap-4 border-t border-border p-3.5 bg-background/50">
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
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function parseQobuzMessage(text: string): { token?: string; appId?: string; appSecret?: string; username?: string } {
  const out: { token?: string; appId?: string; appSecret?: string; username?: string } = {}
  const sep = "\\s*(?:➠|→|⇒|»|:|=|-)+\\s*"
  const grab = (labels: string[], valuePattern: string): string | undefined => {
    for (const label of labels) {
      const re = new RegExp(`${label}${sep}(${valuePattern})`, "i")
      const m = text.match(re)
      if (m?.[1]) return m[1].trim()
    }
    return undefined
  }
  out.appId = grab(["app[\\s_]?id"], "\\d{6,}")
  out.appSecret = grab(["app[\\s_]?secret"], "[a-f0-9]{20,}")
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

export function SubmitForm({ username = null }: { username?: string | null }) {
  const [service, setService] = useState<Service>("tidal")
  const [kind, setKind] = useState<Kind>("api")
  const [credit, setCredit] = useState(true)
  const [state, action, pending] = useActionState(submitSource, initial)
  // Manual-paste sections start closed, and `required` inside a closed section is a trap: native
  // validation cannot focus the hidden control, so the submit does nothing. The server already
  // validates these fields; a validation error naming a field inside one reopens it so the fix is
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
    // The verdict renders below the fold, far from the fields just filled: bring it into view
    // and focus it after every submit. focus() scrolls instantly by default, which would cut
    // the smooth scroll short, so it leaves scrolling to the line above.
    noticeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    noticeRef.current?.focus({ preventScroll: true })
  }, [state])

  // Controlled Qobuz account fields
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

  // Tidal paste helper
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
    <Card className="border-border bg-card shadow-2xs overflow-hidden">
      {/* HEADER WITH STEP 1 INDICATOR */}
      <CardHeader className="border-b border-border/80 bg-secondary/20 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground font-mono text-xs font-bold">
              1
            </div>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
                Select Provider & Credential Architecture
              </CardTitle>
              <CardDescription className="text-xs">
                Pick the streaming catalog and whether you are pooling an instance endpoint or direct account.
              </CardDescription>
            </div>
          </div>
          <Badge tone="neutral" className="font-mono text-[10px]">
            AES-256 Protected
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="p-5 sm:p-6">
        <form action={action} className="flex flex-col gap-8">
          <input type="hidden" name="service" value={service} />
          <input type="hidden" name="kind" value={kind} />

          {/* 1. PROVIDER SELECTION TILES */}
          <div className="flex flex-col gap-3">
            <span className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">
              1. Streaming Service
            </span>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {(["tidal", "qobuz", "deezer", "apple-music", "amazon-music"] as Service[]).map((opt) => {
                const meta = PROVIDER_METADATA[opt]
                const selected = service === opt
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      setService(opt)
                      if (opt === "apple-music") setKind("account")
                    }}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-lg border p-3.5 text-left transition-all",
                      selected
                        ? "border-primary bg-primary/5 shadow-2xs ring-1 ring-primary/30"
                        : "border-border bg-background hover:border-foreground/30 hover:bg-secondary/40"
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="font-semibold text-sm text-foreground">{meta.label}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono text-[10px] font-medium",
                          selected ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                        )}
                      >
                        {meta.tag}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">{meta.quality}</span>
                    <span className="text-[11px] text-muted-foreground/80 leading-tight">{meta.subtitle}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 2. ARCHITECTURE MODE (API VS ACCOUNT) */}
          {service !== "apple-music" && (
            <div className="flex flex-col gap-3">
              <span className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">
                2. Architecture Model
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setKind("api")}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3.5 text-left transition-all",
                    kind === "api"
                      ? "border-primary bg-primary/5 shadow-2xs ring-1 ring-primary/30"
                      : "border-border bg-background hover:border-foreground/30 hover:bg-secondary/40"
                  )}
                >
                  <Server className={cn("size-5 mt-0.5 shrink-0", kind === "api" ? "text-primary" : "text-muted-foreground")} />
                  <div>
                    <span className="font-semibold text-xs text-foreground block">
                      API / Restream Instance
                    </span>
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                      A self-hosted relay or reverse proxy base URL that serves audio stream URLs directly to audio clients.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setKind("account")}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3.5 text-left transition-all",
                    kind === "account"
                      ? "border-primary bg-primary/5 shadow-2xs ring-1 ring-primary/30"
                      : "border-border bg-background hover:border-foreground/30 hover:bg-secondary/40"
                  )}
                >
                  <KeyRound className={cn("size-5 mt-0.5 shrink-0", kind === "account" ? "text-primary" : "text-muted-foreground")} />
                  <div>
                    <span className="font-semibold text-xs text-foreground block">
                      Direct Account Credential
                    </span>
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                      OAuth token, ARL cookie, or web session credentials rotated across pooled playback requests.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}

          <div className="h-px bg-border/80" />

          {/* 3. DYNAMIC CREDENTIAL INPUTS ACCORDING TO SELECTION */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">
                3. Configure {PROVIDER_METADATA[service].label} ({KIND_LABELS[kind]})
              </span>
            </div>

            {kind === "api" ? (
              <div className="flex flex-col gap-4 rounded-lg border border-border/80 bg-secondary/15 p-4 sm:p-5">
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
                <Field
                  label="Health Path"
                  name="healthPath"
                  placeholder="/health"
                  hint="Optional path used to probe whether the instance is healthy."
                />
                <Field
                  label="Premium Probe URL"
                  name="probeUrl"
                  placeholder="/track/12345"
                  hint="Optional. A response mentioning FLAC / hi-res automatically marks the instance premium."
                />
                {service === "amazon-music" ? <AmazonInstanceAuth /> : null}
              </div>
            ) : service === "tidal" ? (
              <div className="flex flex-col gap-4">
                <TidalConnect />
                <Accordion
                  type="single"
                  collapsible
                  className="w-full"
                  value={tidalManualOpen ? "tidal-manual" : ""}
                  onValueChange={(v) => setTidalManualOpen(v === "tidal-manual")}
                >
                  <AccordionItem value="tidal-manual" className="rounded-lg border border-border bg-secondary/15">
                    <AccordionTrigger className="px-4 py-3 text-xs font-mono text-muted-foreground hover:text-foreground">
                      Or paste a Tidal token manually
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-4 border-t border-border p-4 bg-background/50">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-mono font-medium text-foreground">Paste from message</span>
                        <textarea
                          rows={4}
                          placeholder={"Paste the full Tidal message here…\nAccess Token ➠ …   Refresh Token ➠ …   Country ➠ …"}
                          autoComplete="off"
                          onChange={(e) => applyTidalPaste(e.target.value)}
                          onPaste={(e) => applyTidalPaste(e.clipboardData.getData("text"))}
                          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none ring-ring focus:ring-2"
                        />
                        <span className="text-xs text-muted-foreground">
                          {tPasteFeedback ?? "Auto-fills access token, refresh token and country from a share message."}
                        </span>
                      </label>

                      <div className="h-px bg-border/80" />

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
                        Only needed if you already have a token. The easy path is Sign in with Tidal above.
                      </p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ) : service === "apple-music" ? (
              <div className="flex flex-col gap-4 rounded-lg border border-border/80 bg-secondary/15 p-4 sm:p-5">
                <Field
                  key="apple-music-token"
                  label="Media-User-Token"
                  name="token"
                  required
                  placeholder="0.Ap…"
                  hint="Your personal Apple Music web token (always starts with 0.). Sign in at music.apple.com, then copy the media-user-token value from dev tools (Application → Cookies)."
                />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The token unlocks user-scoped Apple Music playback and metadata. It expires when you sign out of the web player.
                </p>
              </div>
            ) : service === "amazon-music" ? (
              <div className="flex flex-col gap-4 rounded-lg border border-border/80 bg-secondary/15 p-4 sm:p-5">
                <Field
                  key="amazon-music-session"
                  label="Amazon session artifact"
                  name="session"
                  required
                  placeholder="Paste the saved Amazon Music web session"
                  hint="Sign in to music.amazon.com, then copy the Amazon Music session cookie value from Application → Cookies."
                />
                <AmazonInstanceAuth />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Amazon&apos;s Music Web API is approval-gated. The session is verified for correct format and encrypted immediately.
                </p>
              </div>
            ) : service === "deezer" ? (
              <div className="flex flex-col gap-4 rounded-lg border border-border/80 bg-secondary/15 p-4 sm:p-5">
                <Field
                  key="deezer-arl"
                  label="ARL cookie"
                  name="arl"
                  required
                  placeholder="Long hexadecimal string"
                  hint="Log in to deezer.com, then copy the value of the arl cookie from browser dev tools."
                />
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="deezer-advanced" className="rounded-md border border-border bg-secondary/15">
                    <AccordionTrigger className="px-3.5 py-2.5 text-xs font-mono text-muted-foreground hover:text-foreground">
                      Advanced Settings
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-4 border-t border-border p-3.5 bg-background/50">
                      <Field
                        key="deezer-masterSecret"
                        label="Master secret"
                        name="masterSecret"
                        placeholder="Leave blank unless Deezer rotated it"
                        hint="Overrides default decryption key. Rarely needed."
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A paid plan is required for lossless FLAC playback. Free accounts only resolve 30s previews.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <QobuzConnect />
                <Accordion
                  type="single"
                  collapsible
                  className="w-full"
                  value={qobuzManualOpen ? "qobuz-manual" : ""}
                  onValueChange={(v) => setQobuzManualOpen(v === "qobuz-manual")}
                >
                  <AccordionItem value="qobuz-manual" className="rounded-lg border border-border bg-secondary/15">
                    <AccordionTrigger className="px-4 py-3 text-xs font-mono text-muted-foreground hover:text-foreground">
                      Or paste Qobuz tokens manually
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-4 border-t border-border p-4 bg-background/50">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-mono font-medium text-foreground">Paste from message</span>
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

                      <div className="h-px bg-border/80" />

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
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            )}
          </div>

          <div className="h-px bg-border/80" />

          {/* 4. OPTIONAL METADATA & ATTRIBUTION */}
          <div className="flex flex-col gap-4">
            <span className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">
              4. Lifecycle & Attribution
            </span>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Expires on"
                name="expiresAt"
                mono={false}
                placeholder="2026-10-07"
                hint="Optional plan end date as YYYY-MM-DD. When reached, the entry gracefully unleases."
              />
              <Field
                label="Public Note"
                name="note"
                mono={false}
                placeholder="e.g. US-East CDN or Hi-Res Tier"
                hint="Visible in pool diagnostics. Do not include personal identity or secrets."
              />
            </div>

            {username ? (
              <div className="rounded-lg border border-border/80 bg-secondary/15 p-3.5">
                <CheckField
                  name="credit"
                  label={`Credit this contribution to @${username}`}
                  description="Displays your username in the community contributions table. Uncheck to remain anonymous."
                  checked={credit}
                  onCheckedChange={setCredit}
                />
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Contributing anonymously.{" "}
                <a href="/login" className="text-foreground underline underline-offset-4 font-medium">
                  Sign in
                </a>{" "}
                if you want your handle credited to the pool leaderboard.
              </p>
            )}
          </div>

          {/* SUBMIT BUTTON & VERIFICATION FEEDBACK */}
          <div className="flex flex-col gap-3 pt-2">
            <Button
              type="submit"
              size="lg"
              disabled={pending}
              className="w-full sm:w-auto font-mono text-xs h-11 px-6 shadow-xs"
            >
              {pending ? (
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-primary-foreground animate-ping" />
                  Running Synthetic Probe Verification (~30-60s)…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span>Verify Credentials & Add to Pool</span>
                  <ArrowRight className="size-3.5" />
                </span>
              )}
            </Button>

            {state.message ? (
              <div ref={noticeRef} tabIndex={-1} className="outline-none">
                <Notice tone={state.ok ? "ok" : "error"} className="mt-2">
                  {state.ok && state.status ? (
                    <span className="mr-2 font-mono text-[10px] uppercase tracking-wider font-semibold">
                      {state.status}
                      {state.premium ? " · premium" : ""}
                    </span>
                  ) : null}
                  {state.message}
                </Notice>
              </div>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
