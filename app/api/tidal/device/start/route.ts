// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server"
import { probeRateLimit } from "@/lib/probe-rate-limit"
import { startDeviceAuth } from "@/lib/tidal-oauth"

export const dynamic = "force-dynamic"

// Begins a Tidal device authorization. Returns the user code + link.tidal.com URL to display.
export async function POST(req: NextRequest) {
  const limited = probeRateLimit(req.headers, "tidal-start")
  if (limited) return limited
  try {
    const start = await startDeviceAuth()
    return NextResponse.json(start)
  } catch (e) {
    const detail = e instanceof Error ? e.message : "error"
    return NextResponse.json({ error: "start_failed", detail }, { status: 502 })
  }
}
