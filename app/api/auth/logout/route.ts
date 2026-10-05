// SPDX-License-Identifier: GPL-3.0-or-later
import { NextResponse } from "next/server"
import { clearSessionCookie } from "@/lib/sessions"

export const dynamic = "force-dynamic"

export async function POST() {
  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
