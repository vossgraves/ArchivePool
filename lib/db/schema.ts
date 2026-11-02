// SPDX-License-Identifier: GPL-3.0-or-later
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  type AnyPgColumn,
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
  // Per-entry verify lease claimed by /api/report before paying for a live check: without it,
  // concurrent serverless instances all see a stale verdict and all probe the provider at once.
  verifyLeaseUntil: timestamp("verify_lease_until", { withTimezone: true }),
  // Set (to the check's own timestamp) by every check that ran and SUCCEEDED, any entitlement.
  // The report path refuses to record a report-driven failure over a success newer than the
  // report itself — without this a racing check's verdict can be overwritten by the report.
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}

/** Contributed account credentials (encrypted payload). */
export const accountEntries = pgTable(
  "account_entries",
  {
    ...entryColumns,
    // Single-flight marker for credential refresh (Tidal token POST, Deezer ARL rotation,
    // Qobuz re-login): whoever wins the conditional claim refreshes and clears it in the same
    // UPDATE that persists the rotated credential — a concurrent lease on another instance must
    // never double-POST, because a rotated refresh token invalidates the one just spent.
    refreshInFlightUntil: timestamp("refresh_in_flight_until", { withTimezone: true }),
    // Skip refresh attempts until this instant: set on Tidal abuse_detected/429 (15 min,
    // doubling to 6h while it keeps arriving) and on transient refresh failures (2 min). A
    // cooling account is never marked dead — the provider's rate limiter is not a verdict.
    refreshCooldownUntil: timestamp("refresh_cooldown_until", { withTimezone: true }),
    // The abuse hold's CURRENT duration in ms, persisted so it survives the cooldown expiring:
    // each repeat doubles it (up to 6h), a successful refresh resets it to NULL. Cooldown
    // expiry alone must not erase the escalation history.
    refreshBackoffMs: integer("refresh_backoff_ms"),
  },
  (t) => ({
    serviceIdx: index("idx_account_entries_service").on(t.service),
    activeIdx: index("idx_account_entries_active").on(t.status, t.disabled, t.removed),
    leaseIdx: index("idx_account_entries_lease").on(t.service, t.premium, t.lastLeasedAt),
  }),
)

/**
 * Tiny cross-instance key/value row for pool-wide signals that do not belong on any entry —
 * today: the global Tidal refresh backoff shared by every account when abuse_detected shows up
 * on several of them inside a minute.
 */
export const poolState = pgTable("pool_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}).$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

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
  // GitHub OAuth subject (numeric id from /user). NULL for password-era accounts and
  // for legacy accounts not yet claimed. Unique when present — one GitHub per account.
  githubId: bigint("github_id", { mode: "number" }),
  // The GitHub login captured at OAuth time (display/review only — identity is github_id).
  githubLogin: text("github_login").notNull().default(""),
  // Set when a newer account proved ownership of this legacy account and absorbed its
  // per-user rows (api_keys, api_key_requests). Claimed accounts are also disabled so
  // the shell cannot be reused; the keys themselves keep working on their new owner.
  claimedBy: integer("claimed_by").references((): AnyPgColumn => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A pending username claim from the GitHub sign-in flow: the GitHub identity proved
 * control of an OAuth account but the chosen legacy username could not be proven by an
 * API key, so an admin reviews and links it. Same shape discipline as api_key_requests.
 */
export const githubClaims = pgTable(
  "github_claims",
  {
    id: serial("id").primaryKey(),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull().default(""),
    // The existing account being claimed — its username string, resolved to a user id
    // only when the claim is approved.
    username: text("username").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    reviewNote: text("review_note").notNull().default(""),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("idx_github_claims_status").on(t.status),
  }),
)

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
