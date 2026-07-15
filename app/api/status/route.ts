import { NextResponse } from "next/server"
import { getStatus } from "@/lib/queries"

export const dynamic = "force-dynamic"

export async function GET() {
  const categories = await getStatus()
  return NextResponse.json(
    { generatedAt: new Date().toISOString(), categories },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    },
  )
}
