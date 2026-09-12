# Pool schema

## Why storage is split in two

`account_entries` and `instance_entries` exist separately so credentials and instance URLs never
share a table or a feed.

| Table | Holds | Encryption | Served by |
|---|---|---|---|
| `account_entries` | contributed account credentials — tokens, ARLs, secrets | always encrypted at rest (`POOL_ENCRYPTION_KEY`), re-encrypted per requester on the way out | `/api/accounts`, legacy `/api/sources` |
| `instance_entries` | contributed instance base URLs | `baseUrl` stays readable server-side for discovery; sensitive extras are still encrypted | `/api/instances/[service]`, `/api/discovery/*` |

Both draw ids from one `source_entry_id_seq`, so an id is globally unique across the pair. That
keeps `health_log.entry_id` unambiguous and lets `/api/report` and the admin endpoints resolve an
id without a discriminator column.

## The legacy table

`source_entries` predates the split. It is read exactly once, by the idempotent migration in
`lib/db/ensure.ts`, and never touched by application code again. Drop it once the migration is
verified — see `scripts/schema.sql`, "Upgrading".

## Migrations

There is no migration tool. Every table or column added after the initial rollout gets an
idempotent statement in `STATEMENTS` in `lib/db/ensure.ts`, which runs once per process before the
first query that needs it. `scripts/schema.sql` is for fresh installs only, and a database created
from an older copy of it self-heals on the next request.

Put `ALTER TABLE … ADD COLUMN IF NOT EXISTS` *after* the `CREATE TABLE IF NOT EXISTS` for the same
table: the create is a no-op on an existing database, so an alter placed before it would run
against the old shape.
