import { eq } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"
import { resolveAdmin } from "@/lib/admin-auth"
import { decryptAtRest } from "@/lib/crypto"
import { db } from "@/lib/db"
import { accountEntries } from "@/lib/db/schema"
import { ensureSchema } from "@/lib/db/ensure"

export const dynamic = "force-dynamic"

const CLIENT_ID = "fX2JxdmntZWK0ixT"
const CLIENT_SECRET = "1Nn9AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg="

function decodeJwt(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

// TEMPORARY: proves a stored Tidal credential can still renew itself. Returns ONLY the verdict and
// the token's internal client id — never a token, secret or ciphertext. REMOVE AFTER TESTING.
export async function POST(req: NextRequest) {
  const actor = await resolveAdmin(req)
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  let body: { id?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }
  if (typeof body.id !== "number") return NextResponse.json({ error: "id required" }, { status: 400 })

  await ensureSchema()
  const [row] = await db.select().from(accountEntries).where(eq(accountEntries.id, body.id)).limit(1)
  if (!row || row.service !== "tidal") return NextResponse.json({ error: "not found" }, { status: 404 })

  const plain = decryptAtRest(row.payload)
  const refresh = String((plain as Record<string, unknown>).refreshToken ?? "").trim()
  const access = String((plain as Record<string, unknown>).token ?? "").trim()
  const refreshCid = decodeJwt(refresh)?.cid
  const accessCid = decodeJwt(access)?.cid

  if (!refresh) return NextResponse.json({ ok: false, error: "no refresh token stored", accessCid })

  const res = await fetch("https://auth.tidal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "TIDAL/1000 (Linux; Android 10)",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
      scope: "r_usr+w_usr+w_sub",
    }),
    cache: "no-store",
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    error?: string
    error_description?: string
  }
  return NextResponse.json({
    refreshCid,
    accessCid,
    httpStatus: res.status,
    refreshWorks: res.ok && Boolean(json.access_token),
    newAccessCid: json.access_token ? decodeJwt(json.access_token)?.cid : undefined,
    error: json.error,
    error_description: json.error_description,
  })
}
