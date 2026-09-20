import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/** Pool storage, split by credential type. See docs/SCHEMA.md. */

const sharedId = () => integer("id").primaryKey().default(sql`nextval('source_entry_id_seq')`)

const entryColumns = {
  id: sharedId(),
  service: text("service").notNull(),
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
  // Opt-in credit. Never derived from the payload, never sent to an app in any feed.
  contributor: text("contributor"),
  // Contributor-declared end of the subscription. Past this the entry stops being servable
  // without waiting for a live check to fail, because a lapsed plan usually still authenticates
  // — it just silently drops to previews, which the premium gate cannot see mid-cycle.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  // Drives least-recently-leased rotation, so no one entry absorbs all traffic and gets banned.
  lastLeasedAt: timestamp("last_leased_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}

/** Contributed account credentials (encrypted payload). */
export const accountEntries = pgTable(
  "account_entries",
  entryColumns,
  (t) => ({
    serviceIdx: index("idx_account_entries_service").on(t.service),
    activeIdx: index("idx_account_entries_active").on(t.status, t.disabled, t.removed),
    leaseIdx: index("idx_account_entries_lease").on(t.service, t.premium, t.lastLeasedAt),
  }),
)

/** Contributed instance base URLs (restream/proxy servers). */
export const instanceEntries = pgTable(
  "instance_entries",
  entryColumns,
  (t) => ({
    serviceIdx: index("idx_instance_entries_service").on(t.service),
    activeIdx: index("idx_instance_entries_active").on(t.status, t.disabled, t.removed),
    leaseIdx: index("idx_instance_entries_lease").on(t.service, t.premium, t.lastLeasedAt),
  }),
)

/** @deprecated Legacy pre-split table; only ensure.ts's one-time migration reads it. */
export const sourceEntries = pgTable(
  "source_entries",
  {
    id: serial("id").primaryKey(),
    service: text("service").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint").notNull().unique(),
    status: text("status").notNull().default("pending"),
    premium: boolean("premium").notNull().default(false),
    detail: text("detail"),
    latencyMs: integer("latency_ms"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    checkCount: integer("check_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    disabled: boolean("disabled").notNull().default(false),
    removed: boolean("removed").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastLeasedAt: timestamp("last_leased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serviceKindIdx: index("idx_source_entries_service_kind").on(t.service, t.kind),
    activeIdx: index("idx_source_entries_active").on(t.status, t.disabled, t.removed),
    leaseIdx: index("idx_source_entries_lease").on(t.service, t.kind, t.premium, t.lastLeasedAt),
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

/** A per-app read key. Only its SHA-256 hash is stored. See docs/API_KEYS.md. */
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  // The single service this key may read; NULL = every service (the pre-scope behaviour).
  service: text("service"),
  // Optional one-line reason given when the key was requested (shown in the dashboard list).
  reason: text("reason").notNull().default(""),
  // Soft delete: hidden from every list (and rejected by verifyReadKey) but the row is retained.
  deleted: boolean("deleted").notNull().default(false),
  // Owning user (NULL for legacy/admin-created keys, which only /admin sees).
  userId: integer("user_id").references(() => users.id),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Which account entries a read key currently holds. A stickiness hint, not a mutex — several keys
 * may hold the same entry, so concurrent leases are harmless. See docs/LEASE_RESEARCH.md.
 */
export const apiKeyLeases = pgTable(
  "api_key_leases",
  {
    keyId: integer("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => accountEntries.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    leasedAt: timestamp("leased_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.keyId, t.entryId] }),
    entryIdx: index("idx_api_key_leases_entry").on(t.entryId),
  }),
)

/** A key request awaiting review. Only an approved one materialises into an api_keys row. */
export const apiKeyRequests = pgTable(
  "api_key_requests",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    reason: text("reason").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    ipAddress: text("ip_address").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    resultingKeyId: integer("resulting_key_id").references(() => apiKeys.id),
    // What the requester asked for; NULL = any service. Copied onto the key at claim time.
    requestedService: text("requested_service"),
    // How to reach the requester. Optional, and shown only to the reviewing admin.
    discordId: text("discord_id"),
    telegramId: text("telegram_id"),
    contactNote: text("contact_note"),
    // Shown to the requester. Empty unless rejected.
    reviewNote: text("review_note").notNull().default(""),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("idx_api_key_requests_user").on(t.userId, t.status),
    ipUaIdx: index("idx_api_key_requests_ip_ua").on(t.ipAddress, t.userAgent, t.status),
  }),
)

/**
 * A site account. User identity lives ONLY here — the pool tables never reference users, so the
 * two data domains stay separate.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // 'user' | 'admin'. An admin acts as a named account, so their actions are attributable.
  role: text("role").notNull().default("user"),
  disabled: boolean("disabled").notNull().default(false),
  // For abuse detection.
  createdIp: text("created_ip").notNull().default(""),
  createdUa: text("created_ua").notNull().default(""),
  lastLoginIp: text("last_login_ip").notNull().default(""),
  lastLoginUa: text("last_login_ua").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/** Append-only record of privileged actions. See docs/ADMIN.md. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull().default(""),
    detail: jsonb("detail").notNull().default({}).$type<Record<string, unknown>>(),
    ipAddress: text("ip_address").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index("idx_audit_log_created").on(t.createdAt),
    actionIdx: index("idx_audit_log_action").on(t.action, t.createdAt),
  }),
)

export type AuditLogRow = typeof auditLog.$inferSelect

export type AccountEntry = typeof accountEntries.$inferSelect
export type NewAccountEntry = typeof accountEntries.$inferInsert
export type InstanceEntry = typeof instanceEntries.$inferSelect
export type NewInstanceEntry = typeof instanceEntries.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type ApiKeyLease = typeof apiKeyLeases.$inferSelect
export type NewApiKeyLease = typeof apiKeyLeases.$inferInsert
export type ApiKeyRequest = typeof apiKeyRequests.$inferSelect
export type User = typeof users.$inferSelect
