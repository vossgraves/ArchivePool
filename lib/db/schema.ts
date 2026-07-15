import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

/**
 * A single contributed source entry.
 *
 * service: "tidal" | "qobuz"
 * kind:    "api"  (a restream/instance base URL that resolves stream URLs)
 *        | "account" (raw account credentials / token that instances can use)
 *
 * payload holds the sensitive material (never exposed on the public status page):
 *   - api:     { baseUrl: string, healthPath?: string, note?: string }
 *   - account: { token?: string, refreshToken?: string, username?: string,
 *                password?: string, countryCode?: string, note?: string }
 */
export const sourceEntries = pgTable(
  "source_entries",
  {
    id: serial("id").primaryKey(),
    service: text("service").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint").notNull().unique(),
    status: text("status").notNull().default("pending"), // pending | alive | preview | dead
    premium: boolean("premium").notNull().default(false),
    detail: text("detail"),
    latencyMs: integer("latency_ms"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    checkCount: integer("check_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    disabled: boolean("disabled").notNull().default(false),
    removed: boolean("removed").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serviceKindIdx: index("idx_source_entries_service_kind").on(t.service, t.kind),
    activeIdx: index("idx_source_entries_active").on(t.status, t.disabled, t.removed),
  }),
)

export const healthLog = pgTable(
  "health_log",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    premium: boolean("premium").notNull().default(false),
    latencyMs: integer("latency_ms"),
    detail: text("detail"),
  },
  (t) => ({
    entryIdx: index("idx_health_log_entry").on(t.entryId, t.checkedAt),
  }),
)

/**
 * A per-app read key. Apps must present a valid, non-revoked key to read the sensitive pool JSON
 * (/api/sources and /api/discovery/*). The public status page never requires a key.
 *
 * Only the SHA-256 hash of the key is stored; the plaintext key is shown once at creation time.
 * `prefix` is the first few visible chars, kept for identification in the admin UI.
 */
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type SourceEntry = typeof sourceEntries.$inferSelect
export type NewSourceEntry = typeof sourceEntries.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
