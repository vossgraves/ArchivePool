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
import { sql } from "drizzle-orm"

/**
 * Pool storage is split by credential type so tokens and instance URLs never share a table
 * (or a feed — see /api/accounts and /api/instances/[service]):
 *
 *  - account_entries: contributed ACCOUNT credentials (tokens/ARLs/secrets). Always encrypted
 *    at rest with POOL_ENCRYPTION_KEY; never exposed except through /api/accounts (and the
 *    legacy /api/sources), re-encrypted with POOL_CLIENT_KEY.
 *  - instance_entries: contributed INSTANCE base URLs (kind 'api' rows of the old table).
 *    Payloads hold baseUrl (+optional note); baseUrl must stay readable server-side for
 *    discovery, sensitive extras are still encrypted.
 *
 * Both tables draw ids from the shared `source_entry_id_seq` sequence, so an id remains
 * globally unique across the two tables. That keeps health_log.entry_id unambiguous and
 * lets /api/report and the admin endpoints resolve an id without a discriminator column.
 *
 * `source_entries` is the pre-split legacy table. It is read ONCE by the idempotent
 * migration in lib/db/ensure.ts and then never touched again by application code; drop it
 * after verifying the migration (see scripts/schema.sql, "Upgrading").
 */

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
  // Opt-in public credit: the username a logged-in contributor chose to be shown by, or NULL
  // when they contributed anonymously. Never derived from the payload, and never sent to apps
  // in any feed — it exists only so the site can attribute a contribution to its author.
  contributor: text("contributor"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  // When this entry was last handed to an app. Drives least-recently-leased rotation, so one
  // entry does not absorb all traffic and get itself rate-limited or banned.
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
    // Globally unique across account_entries + instance_entries (shared id sequence).
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
 * (/api/accounts, /api/sources and /api/discovery/*). The public status page never requires a key.
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
 * An API key request. Users submit subject + reason; an admin approves or
 * rejects. Only approved requests materialise into a real api_keys row.
 * Enforces 1 pending/approved request per IP+UA to prevent spam.
 */
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
    // When approved, the generated key's id (for linking).
    resultingKeyId: integer("resulting_key_id").references(() => apiKeys.id),
    // The admin's note explaining a rejection, shown to the requester. Empty unless rejected.
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
 * A site account. Users sign up with username + password to request and manage
 * their own API keys from /dashboard. Passwords are stored as scrypt hashes
 * (see lib/users.ts); sessions are HMAC-signed cookies (see lib/sessions.ts).
 *
 * User identity lives ONLY here — the pool tables (account_entries/instance_entries)
 * never reference users; the two data domains are fully separate.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  // IP + User-Agent at account creation, for abuse detection.
  createdIp: text("created_ip").notNull().default(""),
  createdUa: text("created_ua").notNull().default(""),
  // Last successful login IP/UA, updated on each login.
  lastLoginIp: text("last_login_ip").notNull().default(""),
  lastLoginUa: text("last_login_ua").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type AccountEntry = typeof accountEntries.$inferSelect
export type NewAccountEntry = typeof accountEntries.$inferInsert
export type InstanceEntry = typeof instanceEntries.$inferSelect
export type NewInstanceEntry = typeof instanceEntries.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type ApiKeyRequest = typeof apiKeyRequests.$inferSelect
export type User = typeof users.$inferSelect
