import { NextResponse } from "next/server"
import { startDeviceAuth } from "@/lib/tidal-oauth"

export const dynamic = "force-dynamic"

// Begins a Tidal device authorization. Returns the user code + link.tidal.com URL to display.
export async function POST() {
  try {
    const start = await startDeviceAuth()
    return NextResponse.json(start)
  } catch (e) {
    const detail = e instanceof Error ? e.message : "error"
    return NextResponse.json({ error: "start_failed", detail }, { status: 502 })
  }
}
