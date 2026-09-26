# ArchivePool Railway Deployment Guide

## Quick Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

## Environment Variables

### Required
- `DATABASE_URL` - Postgres connection string (Neon/Railway Postgres)
- `POOL_ENCRYPTION_KEY` - 32-byte base64 key for encrypting account credentials
- `POOL_CLIENT_KEY` - 32-byte base64 key for client-side decryption

### Optional
- `ADMIN_TOKEN` - Admin authentication token (or use `ADMIN_TOKEN_HASH`)
- `CRON_SECRET` - Bearer token for `/api/cron/*` endpoints
- `READ_KEYS_ENFORCED=true` - Enable API key authentication
- `NEXT_PUBLIC_SITE_URL` - Full site URL for OpenGraph (auto-detected on Railway)

## Setup Steps

### 1. Generate Encryption Keys

```bash
# Install dependencies
npm install

# Generate keys (DO NOT lose these!)
npm run keygen
```

This outputs:
```
POOL_ENCRYPTION_KEY=<base64-string>
POOL_CLIENT_KEY=<base64-string>
```

**⚠️ CRITICAL**: Store these safely. Losing them = all pooled accounts become permanently unusable.

### 2. Deploy to Railway

1. Click "Deploy on Railway" button above
2. Connect your GitHub repo: `vossgraves/ArchivePool`
3. Add a Postgres database (Railway provisions automatically)
4. Set environment variables:
   - `POOL_ENCRYPTION_KEY` - from keygen
   - `POOL_CLIENT_KEY` - from keygen
   - `ADMIN_TOKEN` - create strong random token
   - `CRON_SECRET` - create strong random token

### 3. Configure ArchiveTune App

In ArchiveTune's `local.properties` or build config:
```properties
POOL_DISCOVERY_URL=https://<your-railway-app>.up.railway.app/api/discovery
POOL_CLIENT_KEY=<same-as-server-POOL_CLIENT_KEY>
SOURCE_PROVIDER_KEY=<API-key-from-dashboard>
```

### 4. Create API Keys

1. Visit `https://<your-app>.up.railway.app/dashboard`
2. Sign up for an account
3. Generate a read API key
4. Add key to ArchiveTune config as `SOURCE_PROVIDER_KEY`

## Go Backend (Optional)

The Go server (`server/`) is a drop-in replacement for Next.js routes:

### Build & Run
```bash
cd server
go build -o archivepool ./cmd/archivepool
./archivepool
```

### Environment
Same variables as Next.js, reads from `.env` or environment.

### Railway Go Deploy
Create `railway.toml`:
```toml
[build]
builder = "NIXPACKS"
buildCommand = "cd server && go build -o archivepool ./cmd/archivepool"

[deploy]
startCommand = "./server/archivepool"
```

## Health Checks

Railway automatically configures health checks via `/api/status`.

## Cron Jobs

Set up Railway Cron Plugin or external cron service:

**Health Sweep** (every 6 hours):
```
POST /api/cron/health
Authorization: Bearer <CRON_SECRET>
```

**Instance Sync** (every 6 hours):
```
POST /api/cron/monochrome
Authorization: Bearer <CRON_SECRET>
```

## Monitoring

- Status board: `https://<your-app>.up.railway.app/`
- API status: `https://<your-app>.up.railway.app/api/status`
- Dashboard: `https://<your-app>.up.railway.app/dashboard`

## Troubleshooting

### "DATABASE_URL is not set"
Add Postgres database in Railway dashboard, `DATABASE_URL` auto-populates.

### "Empty discovery feed"
1. Check `READ_KEYS_ENFORCED` - if true, need valid API key
2. Check pool has entries: visit dashboard
3. Check encryption keys match between server and client

### "Pool sources appear encrypted"
`POOL_CLIENT_KEY` mismatch or encryption disabled on server but enabled in client.

## Scaling

Railway auto-scales. For multiple instances:
- ⚠️ Current implementation uses in-memory cache (not shared across instances)
- ⚠️ Health sweeps may run simultaneously on multiple instances
- Consider: Redis for distributed cache + locking (future enhancement)

## Migration from Vercel

See `scripts/deploy-vercel.sh` for migration guide.

## Security

- Never commit `.env` files
- Rotate `ADMIN_TOKEN` and `CRON_SECRET` regularly
- Use `ADMIN_TOKEN_HASH` (SHA-256) instead of plaintext token in production
- Enable `READ_KEYS_ENFORCED=true` to require API keys

## Support

Issues: https://github.com/vossgraves/ArchivePool/issues
Docs: `docs/` directory
