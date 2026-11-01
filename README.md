# archivepool — Vercel redirect placeholder

This branch is a **redirect-only Vercel project** for when the suspended
`archivepool` Vercel account is re-enabled. It serves one purpose: answer every
request with `308 Permanent Redirect` to the Cloudflare Workers deployment
(`https://archivepool.workers.dev`), preserving path and query string.

Deploy it as a **separate Vercel project** (or re-point the existing one to this
branch) with framework preset **Other** and no build command. There are no
functions and no env vars — `vercel.json` does everything.

Replace `archivepool.workers.dev` in `vercel.json` with the real worker URL
before deploying.

The main app lives on `main` / `fix/audit-findings` — nothing here ships code.
