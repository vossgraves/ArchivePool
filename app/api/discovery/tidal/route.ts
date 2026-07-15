import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { getDiscovery } from "@/lib/queries"

export const dynamic = "force-dynamic"

// App-compatible discovery feed. ArchiveTune's TidalAudioProvider.discoverInstances()
// parses this { streaming, api } shape directly. Requires a valid per-app key when
// READ_KEYS_ENFORCED=true; on auth failure we return an empty feed with 401 so the
// app degrades gracefully rather than crashing.
export async function GET(req: NextRequest) {
  if (!(await verifyReadKey(req))) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }
  try {
    const data = await getDiscovery("tidal")
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}
