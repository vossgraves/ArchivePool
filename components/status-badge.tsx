import type { CategoryStatus } from "@/lib/queries"

const CONFIG: Record<
  CategoryStatus["health"],
  { label: string; dot: string; text: string }
> = {
  operational: { label: "Operational", dot: "bg-foreground", text: "text-foreground" },
  degraded: { label: "Degraded", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  down: { label: "Down", dot: "bg-destructive", text: "text-destructive" },
  unknown: { label: "No data", dot: "bg-border", text: "text-muted-foreground" },
}

export function StatusBadge({ health }: { health: CategoryStatus["health"] }) {
  const cfg = CONFIG[health]
  return (
    <span className={`inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider ${cfg.text}`}>
      <span className={`h-2 w-2 rounded-full ${cfg.dot} ${health === "operational" ? "animate-pulse" : ""}`} />
      {cfg.label}
    </span>
  )
}
