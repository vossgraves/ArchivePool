import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata = { title: "API documentation" }

const ENDPOINTS = [
  {
    method: "GET",
    path: "/api/sources",
    auth: "API key — always required",
    desc: "The credential feed consumed by the ArchiveTune app. Leases a small rotating slice of live sources per service (least-recently-used), so a leaked key exposes a handful of entries, not the whole pool. Sensitive fields are AES-256-GCM ciphertext the app decrypts locally.",
  },
  {
    method: "GET",
    path: "/api/status",
    auth: "public",
    desc: "Aggregate, credential-free health per category (alive/dead/premium counts, uptime) plus a daily pass-rate history for the window the health log retains. This is what the home page renders.",
  },
  {
    method: "GET",
    path: "/api/discovery/tidal",
    auth: "API key when read-key enforcement is on",
    desc: "Public instance base URLs for one service (no account secrets). Same shape for /api/discovery/qobuz.",
  },
]

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3.5 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  )
}

export default function DocsPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader active="docs" />
      <main className="mx-auto max-w-3xl px-5 pb-20 pt-10 sm:pt-14">
        <header className="mb-10">
          <h1 className="text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Source Pool API
          </h1>
          <p className="mt-3 max-w-[62ch] text-pretty leading-relaxed text-muted-foreground">
            The pool hands live, health-checked streaming credentials to approved clients. Keys are
            free — create an account, request a key, and pass it as a Bearer token.
          </p>
        </header>

        <section className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold tracking-tight">1 · Request an API key</h2>
            <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>
                <Link href="/signup" className="font-medium text-primary hover:underline">
                  Create an account
                </Link>{" "}
                (username + password — no email needed).
              </li>
              <li>
                Open your{" "}
                <Link href="/dashboard" className="font-medium text-primary hover:underline">
                  dashboard
                </Link>{" "}
                and press “Request API key”.
              </li>
              <li>Copy the key when it is shown. It is displayed exactly once — we store only a hash.</li>
            </ol>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold tracking-tight">2 · Use the key</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Send it as a Bearer token (an <code className="font-mono text-xs">x-api-key</code>{" "}
              header also works). Query-string keys are rejected by convention — they leak into logs.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <Code>{`curl -H "Authorization: Bearer atp_YOUR_KEY" \\
  https://archivepool.vercel.app/api/sources`}</Code>
              <Code>{`# A healthy response (credentials arrive as ciphertext):
{
  "version": 1,
  "encrypted": true,
  "tidal": {
    "apis":    [ { "id": 12, "premium": true, "status": "alive", ... } ],
    "accounts": [ ... ]
  },
  "qobuz":   { "apis": [...], "accounts": [...] },
  "deezer":  { "apis": [...], "accounts": [...] }
}`}</Code>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold tracking-tight">3 · Endpoints</h2>
            <div className="mt-3 flex flex-col gap-4">
              {ENDPOINTS.map((e) => (
                <div key={e.path} className="rounded-md border border-border bg-background/40 p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-lg bg-primary/15 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                      {e.method}
                    </span>
                    <code className="font-mono text-sm font-medium">{e.path}</code>
                    <span className="ml-auto rounded-full bg-secondary px-2.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {e.auth}
                    </span>
                  </div>
                  <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">{e.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold tracking-tight">Rules of the pool</h2>
            <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>Keys are free, personal and revocable — don’t share them. Revoked keys stop working immediately.</li>
              <li>Keep a maximum of 10 active keys per account.</li>
              <li>The credential feed rotates: each call leases a few entries per service, not the whole pool.</li>
              <li>Contributing a working source keeps the pool alive for everyone — you don’t need an account for that.</li>
            </ul>
            <Link
              href="/submit"
              className={cn(buttonVariants({ size: "lg" }), "mt-4 w-fit")}
            >
              Contribute a source
            </Link>
          </div>
        </section>
      </main>
    </div>
  )
}
