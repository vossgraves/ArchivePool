---
name: pool-conventions
description: ArchivePool house rules — schema migrations, admin auth, credential handling, and the comment style this repo expects. Load before changing anything under lib/, app/api/, or components/.
---

# ArchivePool conventions

## Comments

Comments explain **why**, not what. Most code needs none. Before writing one, ask whether a
reader could get the same answer from the code itself — if yes, delete it.

Keep a comment when it records something the code cannot say:
- a constraint that bit someone (`reviewed_by` must be NULL, not 0 — no account has id 0)
- why an obvious-looking alternative is wrong (query-string keys leak into logs)
- an invariant spanning files (ids are unique across `account_entries` and `instance_entries`)

Delete narration (`// Fetch the user`), section banners, restatements of the next line, and
anything that has drifted from the code under it. Long explanations belong in `docs/`, linked
from the code, not inlined.

## Schema changes

Never hand-migrate production. Add an idempotent statement to `STATEMENTS` in `lib/db/ensure.ts`
(`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) and mirror the shape in
`lib/db/schema.ts`. It runs once per process before the first query that needs it.

Order matters: `ALTER`s for columns added to a table that `ensure.ts` also creates must come
*after* the `CREATE`, because the create is a no-op on an existing database.

## Admin routes

Gate with `resolveAdmin(req)` — never the bare token check — and record the mutation with
`recordAudit`. See `docs/ADMIN.md`. GET handlers gate but do not audit.

## Credentials

- Account payloads are encrypted at rest with `POOL_ENCRYPTION_KEY` and re-encrypted per-requester
  with `POOL_CLIENT_KEY`. Never log a payload, never return one outside `/api/accounts`.
- Only SHA-256 hashes of read keys are stored. A key's plaintext is shown exactly once.
- Instance base URLs stay readable server-side — they are not secrets.
- A contributor's `contributor` name is display-only and never goes into a feed.

## Before pushing

```bash
npx tsc --noEmit
npx next build
```

Both must pass. There is no eslint config in this repo; do not add one without asking.
