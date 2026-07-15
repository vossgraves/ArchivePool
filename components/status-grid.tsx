import type { CategoryStatus } from "@/lib/queries"
import { StatusBadge } from "./status-badge"

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

function CategoryCard({ cat }: { cat: CategoryStatus }) {
  const aliveRatio = cat.total > 0 ? cat.alive / cat.total : 0
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold tracking-tight">{cat.label}</h3>
          <span className="font-mono text-xs text-muted-foreground">
            checked {timeAgo(cat.lastCheckedAt)}
          </span>
        </div>
        <StatusBadge health={cat.health} />
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${aliveRatio * 100}%` }} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Total" value={cat.total} />
        <Stat label="Alive" value={cat.alive} />
        <Stat label="Premium" value={cat.premium} />
        <Stat label="Uptime" value={cat.uptimePct === null ? "—" : `${cat.uptimePct}%`} />
      </div>
    </div>
  )
}

export function StatusGrid({ categories }: { categories: CategoryStatus[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {categories.map((cat) => (
        <CategoryCard key={`${cat.service}-${cat.kind}`} cat={cat} />
      ))}
    </div>
  )
}
