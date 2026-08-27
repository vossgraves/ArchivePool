import { NextResponse, type NextRequest } from "next/server"
import { setSessionCookie } from "@/lib/sessions"
import { findUserByUsername, verifyPassword } from "@/lib/users"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""
  if (!username || !password) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 })
  }

  const user = await findUserByUsername(username)
  // Uniform error for unknown user / wrong password / disabled account so the
  // response cannot be used to enumerate registered usernames.
  if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 })
  }

  await setSessionCookie(user.id)
  return NextResponse.json({ username: user.username })
}
