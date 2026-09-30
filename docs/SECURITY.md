# Security Fix: Unauthorized Account Creation

## Vulnerability

Prior to this fix, **public user registration was always enabled** with no way to disable it. This allowed anyone to:

1. Create an account via `/api/auth/signup` (no admin approval required)
2. Sign in and request API keys via `/api/keys` POST
3. While key requests went into a "pending" state requiring admin approval, the ability to create accounts and spam requests created unnecessary risk and moderation overhead

An AI assistant was able to create an account and request an API key without being given the database connection string or admin token, demonstrating that the registration flow was completely open.

## Fix

Added `ALLOW_PUBLIC_SIGNUP` as an explicit opt-**out** kill-switch:

- **Default behavior** (`ALLOW_PUBLIC_SIGNUP` unset, or anything other than `"false"`): Public signup is **enabled**
  - `/signup` and `/api/auth/signup` work normally
  - Rate limiting (5 accounts per IP+UA per 24h) remains active

- **Opt-out behavior** (`ALLOW_PUBLIC_SIGNUP="false"`): Public signup is **disabled**
  - `/api/auth/signup` returns HTTP 403 with error `signup_disabled`
  - `/signup` page shows "Registration Disabled" message
  - Only admins can create accounts via `POST /api/admin/users`

> The default is deliberately **open, not closed**. An earlier revision failed closed, so a
> deployment that had never heard of the variable silently lost its contributor flow: no accounts,
> no "credit this to me" on `/submit`, and no UI to create the first admin. Locking signup down is
> now a deliberate act — set `ALLOW_PUBLIC_SIGNUP="false"` and redeploy.

## Migration

### For existing deployments

1. (Optional) Add `ALLOW_PUBLIC_SIGNUP="false"` to your environment variables to close public signup
2. Redeploy
3. If you closed signup, create user accounts manually via the admin API (see below) or re-open it


### For new deployments

The `.env.example` now includes:
```bash
ALLOW_PUBLIC_SIGNUP="true"
```

This is the default and matches the code's behaviour when the variable is unset. Change it to
`"false"` to close public registration.

## Admin user creation

When public signup is disabled, admins can create accounts via the API:

```bash
# Create a regular user
curl -X POST https://your-pool.vercel.app/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secure-password-here", "role": "user"}'

# Create an admin user
curl -X POST https://your-pool.vercel.app/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "bob", "password": "another-secure-password", "role": "admin"}'
```

Response on success:
```json
{
  "ok": true,
  "userId": 5,
  "username": "alice",
  "role": "user"
}
```

## Why this matters

### Before the fix
- Anyone could create accounts without authorization
- No way to prevent account spam
- API key request queue could be flooded
- Admin moderation overhead was unavoidable

### After the fix
- **Fails closed**: signup disabled by default
- Admins explicitly create accounts for trusted users
- No public-facing account creation endpoint
- API key requests come only from vetted users

## Security best practices

1. **Keep `ALLOW_PUBLIC_SIGNUP="false"` in production**
2. Create user accounts manually for trusted contributors only
3. Regularly audit user accounts via `GET /api/admin/users`
4. Monitor API key requests via the `/admin` dashboard
5. Rotate `SESSION_SECRET` and `ADMIN_TOKEN` periodically

## Related environment variables

- `SESSION_SECRET` — signs session cookies; must be set for login/signup to work
- `ADMIN_TOKEN_HASH` or `ADMIN_TOKEN` — required for all admin operations
- `READ_KEYS_ENFORCED="true"` — gates discovery feeds (separate from user accounts)

## Testing the fix

### Verify signup is blocked
```bash
curl -X POST https://your-pool.vercel.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"username": "test", "password": "testpassword"}'
```

Expected response (when `ALLOW_PUBLIC_SIGNUP="false"`):
```json
{
  "error": "signup_disabled",
  "detail": "Public registration is disabled. Contact the administrator."
}
```

### Verify admin can create accounts
```bash
curl -X POST https://your-pool.vercel.app/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "legituser", "password": "securepass123", "role": "user"}'
```

Expected response:
```json
{
  "ok": true,
  "userId": 1,
  "username": "legituser",
  "role": "user"
}
```

## Audit trail

User creation by admins is logged in the `audit_log` table with:
- `action`: `user.create`
- `resource`: `user:<userId>`
- `metadata`: `{ "username": "...", "role": "..." }`

Check audit logs via `GET /api/admin/audit`.
