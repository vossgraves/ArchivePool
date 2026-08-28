"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

interface RequestRow {
  id: number
  subject: string
  reason: string
  status: string
  ipAddress: string
  userAgent: string
  createdAt: string
  username: string
}

export function AdminRequests() {
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [filter, setFilter] = useState<"pending" | "all">("pending")

  async function load() {
    const token = sessionStorage.getItem("adminToken") ?? ""
    const res = await fetch("/api/admin/requests", {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (res.ok) setRequests(await res.json())
  }

  useEffect(() => {
    void load()
  }, [])

  async function act(id: number, action: "approve" | "reject") {
    const token = sessionStorage.getItem("adminToken") ?? ""
    await fetch(`/api/admin/requests/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action }),
    })
    await load()
  }

  const filtered = requests?.filter((r) => (filter === "pending" ? r.status === "pending" : true)) ?? []

  return (
    <section className="rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Key requests</h2>
        <div className="flex gap-2">
          <Button variant={filter === "pending" ? "default" : "outline"} size="sm" onClick={() => setFilter("pending")}>
            Pending
          </Button>
          <Button variant={filter === "all" ? "default" : "outline"} size="sm" onClick={() => setFilter("all")}>
            All
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Approve to generate a key (shown once to the user), reject to close. One per IP+UA enforced at request time.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {filtered === null ? (
          <div className="h-20 animate-pulse rounded-xl bg-muted" />
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No {filter} requests.</p>
        ) : (
          filtered.map((r) => (
            <div key={r.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {r.subject} <span className="ml-2 rounded-full border px-2 py-0.5 text-xs">{r.status}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    by {r.username} · {new Date(r.createdAt).toLocaleString()} · {r.ipAddress} · {r.userAgent.slice(0, 60)}
                  </p>
                </div>
                {r.status === "pending" && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => act(r.id, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => act(r.id, "reject")}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-2 text-sm">“{r.reason}”</p>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
