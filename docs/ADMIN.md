# Admin access, roles and the audit log

## Two credentials, one gate

`resolveAdmin(req)` in `lib/admin-auth.ts` authorizes an admin request by either credential and
returns who acted:

| Credential | `actor.userId` | When it is used |
|---|---|---|
| `ADMIN_TOKEN` / `ADMIN_TOKEN_HASH` bearer | `null` | Pasting the token into `/admin`; cron routes, which carry no cookie |
| Signed session cookie for a user with `role = 'admin'` | that user's id | A named admin acting from their own account |

The shared token cannot identify a person, which is the whole reason named admins exist. Anything
done with it is recorded as `admin-token`.

A database failure during the role lookup returns "not authorized". An unset secret must never
mean "allow".

## Roles

`users.role` is `'user'` or `'admin'`, defaulting to `'user'`. Promote and demote from the
Accounts panel in `/admin`, or `PATCH /api/admin/users` with `{ userId, role }`.

An admin cannot demote themselves. If the shared token has since been rotated away, self-demotion
would leave the site with no administrator at all.

## Audit log

Every privileged mutation appends one `audit_log` row (`lib/audit.ts`). `recordAudit` never
throws: the action has already happened by the time it is called, and a failed write must not be
reported to the caller as a failed action.

Recorded actions: `key.create`, `key.revoke`, `key.restore`, `key.delete`, `request.approve`,
`request.reject`, `entry.remove`, `entry.force_check`, `entry.purge_dead`, `entry.purge`, `user.role_change`.

`target` is a free-form `"<kind>:<id>"` so one table covers keys, requests, entries and users
without a column per kind. Read it from the Audit log panel or `GET /api/admin/audit?limit=`.

## Setup on an existing deployment

`lib/db/ensure.ts` adds `users.role` and creates `audit_log` on the first request after deploy —
no manual migration step. Seed the first named admin by hand once:

```sql
UPDATE users SET role = 'admin' WHERE username = '<you>';
```

After that, admins promote each other from the panel.
