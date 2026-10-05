// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTime } from "@/lib/utils"

type UserRow = {
  id: number
  username: string
  role: string
  disabled: boolean
  createdAt: string
  lastLoginIp: string
}

function adminHeaders(): HeadersInit {
  return { authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}` }
}

export function AdminUsers() {
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users", { headers: adminHeaders() })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { users: UserRow[] }
      setRows(data.users)
    } catch {
      setRows([])
      toast.error("Could not load accounts.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function setRole(user: UserRow, role: "admin" | "user") {
    setBusyId(user.id)
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { ...adminHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ userId: user.id, role }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error(
          data.error === "cannot_demote_self"
            ? "You cannot remove your own admin role."
            : "Could not change that role.",
        )
        return
      }
      toast.success(`${user.username} is now ${role}.`)
      await load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Panel
      label="Accounts"
      description="Admins can do everything the shared token can, but every action they take is attributed to their account in the audit log."
    >
      {rows === null ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No accounts.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell>
                  <Badge tone={u.role === "admin" ? "ok" : "neutral"}>{u.role}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(u.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === u.id}
                    onClick={() => setRole(u, u.role === "admin" ? "user" : "admin")}
                  >
                    {u.role === "admin" ? "Demote" : "Make admin"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}
