import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { recordAudit } from "@/lib/audit"
import { createUser, findUserByUsername, listUsersForAdmin, setUserRole, validateCredentials } from "@/lib/users"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  return NextResponse.json({ users: await listUsersForAdmin() })
}

/**
 * Create a user account manually (for when public signup is disabled).
 * Body: { username, password, role?: "user" | "admin" }
 */
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { username?: string; password?: string; role?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""
  const role = body.role === "admin" ? "admin" : "user"

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

  const user = await createUser(username, password, "", "")
  if (role === "admin") {
    await setUserRole(user.id, "admin")
  }

  await recordAudit(req, actor, "user.create", `user:${user.id}`, { username: user.username, role })
  return NextResponse.json({ ok: true, userId: user.id, username: user.username, role })
}

/**
 * Promote or demote an account: `{ userId, role: "admin" | "user" }`.
 *
 * A named admin may not demote themselves — the only way back would be the shared ADMIN_TOKEN,
 * and if that has been rotated away the site is left with no administrator at all.
 */
export async function PATCH(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: { userId?: number; role?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const userId = Number(body.userId)
  const role = body.role
  if (!Number.isFinite(userId)) return NextResponse.json({ error: "userId_required" }, { status: 400 })
  if (role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 })
  }
  if (role === "user" && actor.userId === userId) {
    return NextResponse.json({ error: "cannot_demote_self" }, { status: 400 })
  }

  const updated = await setUserRole(userId, role)
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 })

  await recordAudit(req, actor, "user.role_change", `user:${userId}`, {
    username: updated.username,
    role,
  })
  return NextResponse.json({ ok: true, userId, role, username: updated.username })
}
