import { NextResponse, type NextRequest } from "next/server"
import { setSessionCookie } from "@/lib/sessions"
import { countRecentUsersByIpUa, createUser, findUserByUsername, validateCredentials } from "@/lib/users"

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

  const problem = validateCredentials(username, password)
  if (problem) {
    return NextResponse.json({ error: "invalid_input", detail: problem }, { status: 400 })
  }

  if (await findUserByUsername(username)) {
    return NextResponse.json(
      { error: "username_taken", detail: "That username is already registered." },
      { status: 409 },
    )
  }

  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "").slice(0, 64)
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 256)
  // Prevent mass account creation: at most 5 accounts per IP+UA per 24h
  if (ip && ua) {
    const recent = await countRecentUsersByIpUa(ip, ua, 24)
    if (recent >= 5) {
      return NextResponse.json(
        { error: "rate_limited", detail: "Too many accounts from this device/network. Try again later." },
        { status: 429 },
      )
    }
  }

  const user = await createUser(username, password, ip, ua)
  await setSessionCookie(user.id)
  return NextResponse.json({ username: user.username })
}
