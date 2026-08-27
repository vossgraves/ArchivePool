import { NextResponse, type NextRequest } from "next/server"
import { setSessionCookie } from "@/lib/sessions"
import { createUser, findUserByUsername, validateCredentials } from "@/lib/users"

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

  const user = await createUser(username, password)
  await setSessionCookie(user.id)
  return NextResponse.json({ username: user.username })
}
