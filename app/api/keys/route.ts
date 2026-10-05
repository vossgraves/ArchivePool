// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { getSessionUserId } from "@/lib/sessions"
import {
  MAX_KEYS_PER_USER,
  countRequestsByIpUa,
  createKeyRequest,
  listUserApiKeys,
  listUserRequests,
} from "@/lib/api-keys"
import { isService } from "@/lib/sources"

export const dynamic = "force-dynamic"

/** List the signed-in user's API keys and pending requests. */
export async function GET() {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  try {
    const [keys, requests] = await Promise.all([listUserApiKeys(userId), listUserRequests(userId)])
    return NextResponse.json(
      { keys, requests },
      { headers: { "cache-control": "private, no-store" } },
    )
  } catch (err) {
    console.error("[keys] list failed:", err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not load your keys. Please try again shortly." },
      { status: 500 },
    )
  }
}

/** Request a new API key (subject, reason, optional source + contact details). Admin must approve. Limited to 1 per IP+UA. */
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId()
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: {
    subject?: string
    name?: string
    reason?: string
    requestedService?: string | null
    discordId?: string
    telegramId?: string
    contactNote?: string
  }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const subject = (body.subject ?? body.name ?? "").trim().slice(0, 64)
  const reason = (body.reason ?? "").trim().slice(0, 500)
  // Absent or unrecognised means "any service" — the same meaning as NULL in the column.
  const requestedService = isService(body.requestedService) ? body.requestedService : null
  const discordId = (body.discordId ?? "").trim().slice(0, 64) || null
  const telegramId = (body.telegramId ?? "").trim().slice(0, 64) || null
  const contactNote = (body.contactNote ?? "").trim().slice(0, 500) || null
  if (!subject) {
    return NextResponse.json({ error: "invalid_input", detail: "Subject is required." }, { status: 400 })
  }
  if (!reason || reason.length < 10) {
    return NextResponse.json({ error: "invalid_input", detail: "Reason must be at least 10 characters." }, { status: 400 })
  }

  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "").slice(0, 64)
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)

  // Enforce 1 active/pending request per IP+UA (30 days) to prevent spam
  if (ip && ua) {
    const recent = await countRequestsByIpUa(ip, ua, 720)
    if (recent >= 1) {
      return NextResponse.json(
        { error: "rate_limited", detail: "One request per device/network. You already have a pending or recent request." },
        { status: 429 },
      )
    }
  }

  const existing = await listUserApiKeys(userId)
  if (existing.filter((k) => !k.revoked).length >= MAX_KEYS_PER_USER) {
    return NextResponse.json(
      { error: "key_limit", detail: `At most ${MAX_KEYS_PER_USER} active keys per account.` },
      { status: 409 },
    )
  }
  try {
    const created = await createKeyRequest(userId, subject, reason, ip, ua, {
      requestedService,
      discordId,
      telegramId,
      contactNote,
    })
    return NextResponse.json(
      { id: created.id, status: "pending" },
      { headers: { "cache-control": "private, no-store" } },
    )
  } catch (err) {
    // Surface DB problems as structured JSON — an unhandled throw here rendered a generic
    // "unknown error occurred" page for users whose deployments predated a schema migration.
    console.error("[keys] createKeyRequest failed:", err)
    return NextResponse.json(
      { error: "internal_error", detail: "Could not save the request. Please try again shortly." },
      { status: 500 },
    )
  }
}
