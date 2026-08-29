import { NextResponse } from "next/server"
import { clearSessionCookie } from "@/lib/sessions"

export const dynamic = "force-dynamic"

export async function POST() {
  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
