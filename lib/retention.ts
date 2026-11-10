// SPDX-License-Identifier: GPL-3.0-or-later
import { sql } from "drizzle-orm"
import { db } from "@/lib/db"

export async function purgeRetainedData(): Promise<void> {
  for (const statement of [
    "delete from health_log where checked_at < now() - interval '30 days' or id in (select id from health_log order by checked_at desc, id desc offset 200000)",
    "delete from audit_log where created_at < now() - interval '90 days' or id in (select id from audit_log order by created_at desc, id desc offset 50000)",
    "delete from api_key_leases where leased_at < now() - interval '72 hours'",
    "delete from rate_limit_buckets where window_start < now() - interval '1 day'",
    "delete from api_key_requests where created_at < now() - interval '90 days'",
    "delete from github_claims where created_at < now() - interval '90 days'",
    "update account_entries set removed_at = now() where removed and removed_at is null",
    "update instance_entries set removed_at = now() where removed and removed_at is null",
    "delete from account_entries where removed and removed_at < now() - interval '30 days'",
    "delete from instance_entries where removed and removed_at < now() - interval '30 days'",
  ]) await db.execute(sql.raw(statement))
}
