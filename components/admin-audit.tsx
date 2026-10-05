// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useCallback, useEffect, useState } from "react"
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

type AuditRow = {
  id: number
  action: string
  target: string
  actorLabel: string
  actorUsername: string | null
  detail: Record<string, unknown>
  ipAddress: string
  createdAt: string
}

/** Destructive actions are called out so a scan of the list surfaces them first. */
const DESTRUCTIVE = new Set(["key.delete", "entry.remove", "entry.purge_dead", "entry.purge", "request.reject"])

export function AdminAudit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/audit", {
        headers: { authorization: `Bearer ${sessionStorage.getItem("adminToken") ?? ""}` },
      })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { entries: AuditRow[] }
      setRows(data.entries)
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Panel
      label="Audit log"
      description="Every privileged action, newest first. Actions taken with the shared token show as admin-token because it cannot identify a person."
    >
      {rows === null ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {formatDateTime(r.createdAt)}
                </TableCell>
                <TableCell>{r.actorUsername ?? r.actorLabel}</TableCell>
                <TableCell>
                  <Badge tone={DESTRUCTIVE.has(r.action) ? "danger" : "neutral"}>{r.action}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.target}</TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                  {Object.keys(r.detail).length > 0 ? JSON.stringify(r.detail) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}
