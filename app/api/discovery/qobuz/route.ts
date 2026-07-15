import { NextResponse, type NextRequest } from "next/server"
import { verifyReadKey } from "@/lib/api-keys"
import { getDiscovery } from "@/lib/queries"

export const dynamic = "force-dynamic"

// App-compatible discovery feed for Qobuz instances ({ streaming, api } shape).
// Requires a valid per-app key when READ_KEYS_ENFORCED=true.
export async function GET(req: NextRequest) {
  if (!(await verifyReadKey(req))) {
    return NextResponse.json({ streaming: [], api: [] }, { status: 401 })
  }
  try {
    const data = await getDiscovery("qobuz")
    return NextResponse.json(data, {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return NextResponse.json({ streaming: [], api: [] })
  }
}
