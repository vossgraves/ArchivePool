import { revalidatePath } from "next/cache"
import { NextResponse, type NextRequest } from "next/server"
import { ingestSource } from "@/lib/ingest"
import { pollDeviceToken } from "@/lib/tidal-oauth"

export const dynamic = "force-dynamic"

// Polls a Tidal device code. When the user has authorized, the resulting access token is
// health-checked and added to the pool as a Tidal account, then we report the outcome.
export async function POST(req: NextRequest) {
  let deviceCode = ""
  try {
    const body = (await req.json()) as { deviceCode?: string }
    deviceCode = String(body.deviceCode ?? "").trim()
  } catch {
    /* fall through to validation below */
  }
  if (!deviceCode) {
    return NextResponse.json({ error: "missing_device_code" }, { status: 400 })
  }

  let outcome
  try {
    outcome = await pollDeviceToken(deviceCode)
  } catch (e) {
    const detail = e instanceof Error ? e.message : "error"
    return NextResponse.json({ state: "error", detail }, { status: 502 })
  }

  if (outcome.state !== "authorized") {
    return NextResponse.json(outcome)
  }

  // Authorized: build the account payload and ingest it exactly like a manual submission.
  const note = "Added via Tidal sign-in"
  const payload: Record<string, unknown> = {
    token: outcome.accessToken,
    refreshToken: outcome.refreshToken,
    countryCode: outcome.countryCode,
    note,
  }

  try {
    const result = await ingestSource("tidal", "account", payload)
    revalidatePath("/")
    return NextResponse.json({
      state: "authorized",
      saved: true,
      ok: result.ok,
      status: result.status,
      premium: result.premium,
      detail: result.detail,
    })
  } catch {
    return NextResponse.json(
      { state: "authorized", saved: false, detail: "Could not save the account." },
      { status: 500 },
    )
  }
}
