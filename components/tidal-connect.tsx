"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

type Phase = "idle" | "starting" | "waiting" | "success" | "expired" | "error"

function fullUrl(uri: string): string {
  return uri.startsWith("http") ? uri : `https://${uri}`
}

export function TidalConnect() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [device, setDevice] = useState<DeviceStart | null>(null)
  const [message, setMessage] = useState("")
  const [secondsLeft, setSecondsLeft] = useState(0)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
    pollRef.current = null
    countdownRef.current = null
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const poll = useCallback(
    (deviceCode: string, intervalMs: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const res = await fetch("/api/tidal/device/poll", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode }),
          })
          const data = await res.json()
          switch (data.state) {
            case "pending":
              poll(deviceCode, intervalMs)
              break
            case "slow_down":
              poll(deviceCode, intervalMs + 2000)
              break
            case "authorized": {
              clearTimers()
              if (data.saved) {
                setPhase("success")
                setMessage(
                  data.ok
                    ? data.premium
                      ? "Signed in. Your Tidal account was verified and added to the pool as a premium source. Thank you!"
                      : "Signed in and added to the pool. The account works but was not detected as premium/lossless."
                    : `Signed in, but the live check failed (${data.detail}). It will be retried automatically.`,
                )
              } else {
                setPhase("error")
                setMessage(data.detail || "Signed in but could not save the account.")
              }
              break
            }
            case "expired":
              clearTimers()
              setPhase("expired")
              setMessage("The code expired before you signed in. Start again.")
              break
            default:
              clearTimers()
              setPhase("error")
              setMessage(data.detail || "Something went wrong. Try again.")
          }
        } catch {
          // Transient network error: keep trying at the normal cadence.
          poll(deviceCode, intervalMs)
        }
      }, intervalMs)
    },
    [clearTimers],
  )

  const start = useCallback(async () => {
    clearTimers()
    setPhase("starting")
    setMessage("")
    try {
      const res = await fetch("/api/tidal/device/start", { method: "POST" })
      if (!res.ok) throw new Error()
      const data = (await res.json()) as DeviceStart
      setDevice(data)
      setPhase("waiting")
      setSecondsLeft(data.expiresIn)
      // Open Tidal's authorization page in a new tab for convenience.
      window.open(fullUrl(data.verificationUriComplete), "_blank", "noopener,noreferrer")
      countdownRef.current = setInterval(() => {
        setSecondsLeft((s) => (s <= 1 ? 0 : s - 1))
      }, 1000)
      poll(data.deviceCode, Math.max(1, data.interval) * 1000)
    } catch {
      setPhase("error")
      setMessage("Could not start Tidal sign-in. Try again.")
    }
  }, [clearTimers, poll])

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Sign in with Tidal</span>
        <span className="text-xs text-muted-foreground leading-relaxed">
          Log in on Tidal&apos;s own site and we&apos;ll capture the session token automatically. Your password is
          never seen by this site.
        </span>
      </div>

      {phase === "waiting" && device && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Your code</span>
            <span className="font-mono text-2xl font-semibold tracking-[0.3em]">{device.userCode}</span>
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            A Tidal tab should have opened. If not, go to{" "}
            <a
              href={fullUrl(device.verificationUri)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              {device.verificationUri}
            </a>{" "}
            and enter the code above. Waiting for you to finish…
            {secondsLeft > 0 && (
              <span className="ml-1 font-mono">
                ({Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-warn" aria-hidden />
            <span className="text-xs text-muted-foreground">Listening for authorization…</span>
          </div>
        </div>
      )}

      {phase !== "waiting" && (
        <button
          type="button"
          onClick={start}
          disabled={phase === "starting"}
          className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {phase === "starting"
            ? "Starting…"
            : phase === "success"
              ? "Sign in another account"
              : phase === "expired" || phase === "error"
                ? "Try again"
                : "Sign in with Tidal"}
        </button>
      )}

      {message && (
        <div
          className={`rounded-md border p-3 text-sm leading-relaxed ${
            phase === "success" ? "border-border bg-background" : "border-destructive/40 bg-background text-destructive"
          }`}
        >
          {message}
        </div>
      )}
    </div>
  )
}
