// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import * as React from "react"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Key,
  Layers,
  Lock,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface EndpointSpec {
  method: "GET" | "POST"
  path: string
  auth: string
  authTone: "ok" | "warn" | "neutral"
  summary: string
  description: string
  params?: { name: string; type: string; required: boolean; desc: string }[]
  responseSample?: string
}

const ENDPOINTS: EndpointSpec[] = [
  {
    method: "GET",
    path: "/api/sources",
    auth: "API key required",
    authTone: "warn",
    summary: "Lease active, health-verified streaming sources",
    description:
      "The primary credential feed consumed by client audio tools. Leases a rotating slice of live, validated sources per service using LRU rotation. Sensitive fields are AES-256-GCM ciphertext decrypted client-side.",
    params: [
      { name: "service", type: "string", required: false, desc: "Filter by provider: tidal, qobuz, or deezer" },
      { name: "kind", type: "string", required: false, desc: "Filter by credential type: api or account" },
      { name: "limit", type: "number", required: false, desc: "Max sources returned per category (default: 5, max: 20)" },
    ],
    responseSample: `{
  "version": 1,
  "encrypted": true,
  "service": "tidal",
  "leaseTtlSeconds": 3600,
  "sources": [
    {
      "id": 12,
      "service": "tidal",
      "kind": "account",
      "premium": true,
      "status": "alive",
      "lastVerifiedAt": "2026-09-29T14:00:00Z",
      "payload": "aes-256-gcm:iv:ciphertext:tag"
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/status",
    auth: "Public feed",
    authTone: "ok",
    summary: "System-wide aggregate telemetry & sweep history",
    description:
      "Credential-free status feed providing pool health, alive/dead counts, premium ratios, and 14-day daily pass rate histories. Powers public status monitors.",
    responseSample: `{
  "generatedAt": "2026-09-29T14:45:00Z",
  "overall": { "health": "operational", "passRate14d": 99.4 },
  "categories": [
    { "service": "tidal", "kind": "account", "total": 18, "alive": 18, "premium": 18, "dead": 0, "health": "operational" }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/discovery/tidal",
    auth: "Public / Key-enforced",
    authTone: "neutral",
    summary: "Resolve active base instance URLs for Tidal",
    description:
      "Returns verified public instance URLs and proxy endpoints for Tidal without credential secrets. Equivalent endpoint exists for /api/discovery/qobuz.",
    responseSample: `{
  "service": "tidal",
  "nodes": [
    { "id": "tidal-node-us", "region": "us-east", "baseUrl": "https://api.tidal.com/v1", "healthy": true }
  ]
}`,
  },
]

const CODE_EXAMPLES = {
  curl: `curl -X GET "https://archivepool.vercel.app/api/sources?service=tidal" \\
  -H "Authorization: Bearer atp_live_your_api_key_here" \\
  -H "Accept: application/json"`,
  nodejs: `// Modern TypeScript / Node.js 18+ (Fetch API)
const response = await fetch("https://archivepool.vercel.app/api/sources?service=tidal", {
  headers: {
    "Authorization": "Bearer atp_live_your_api_key_here",
    "Accept": "application/json",
  },
});

if (!response.ok) {
  throw new Error(\`ArchivePool error: \${response.status}\`);
}

const data = await response.json();
console.log("Leased Sources:", data.sources);`,
  python: `# Python 3.9+ with requests
import requests

url = "https://archivepool.vercel.app/api/sources"
headers = {
    "Authorization": "Bearer atp_live_your_api_key_here",
    "Accept": "application/json"
}
params = {"service": "tidal"}

res = requests.get(url, headers=headers, params=params, timeout=10)
res.raise_for_status()

feed = res.json()
print(f"Received {len(feed.get('sources', []))} active leases")`,
  go: `// Go 1.20+ standard library
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"
)

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", "https://archivepool.vercel.app/api/sources?service=tidal", nil)
    req.Header.Set("Authorization", "Bearer atp_live_your_api_key_here")

    res, err := http.DefaultClient.Do(req)
    if err != nil {
        panic(err)
    }
    defer res.Body.Close()
    fmt.Println("Status:", res.Status)
}`,
}

const SECTION_KEYWORDS: Record<string, string> = {
  quickstart: "quickstart authentication bearer token key header authorization rfc 6750 signup dashboard atp_live generate free key 1 api key",
  snippets: "code snippets examples curl typescript python go request sample fetch headers source lease client integration sdk 2 javascript node",
  endpoints: "endpoints get post api sources status discovery tidal qobuz limit service kind parameters schema response 200 ok bearer payload rest 3 spec",
  encryption: "encryption aes-256-gcm ciphertext plaintext secret iv auth tag crypto node crypto subtle web decrypt decipher gcm zero plaintext 4 security",
  governance: "governance rotation lru pool rate limit 429 backoff retry-after sweeps health automatic rotation stale sources 5",
  errors: "errors http status codes 200 401 403 404 429 503 unauthorized forbidden not found rate limit server error bad request message resolution 6",
}

export function DocsContent() {
  const [search, setSearch] = React.useState("")
  const [openItems, setOpenItems] = React.useState<string[]>([
    "quickstart",
    "snippets",
    "endpoints",
  ])

  const allKeys = ["quickstart", "snippets", "endpoints", "encryption", "governance", "errors"]

  const matchingSections = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allKeys
    return allKeys.filter((key) => {
      const keywords = SECTION_KEYWORDS[key] || ""
      return keywords.toLowerCase().includes(q)
    })
  }, [search])

  React.useEffect(() => {
    if (search.trim()) {
      setOpenItems(matchingSections)
    }
  }, [search, matchingSections])

  const toggleAll = () => {
    if (openItems.length === allKeys.length) {
      setOpenItems([])
    } else {
      setOpenItems(allKeys)
    }
  }

  const isAllOpen = openItems.length === allKeys.length

  return (
    <div className="flex flex-col gap-6">
      {/* Search and Accordion Controls Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-border/80 bg-secondary/20 p-3 sm:px-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-60" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search API documentation…"
            className="h-8 w-full rounded-md border border-border/80 bg-background/70 pl-8 pr-7 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:border-ring focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleAll}
            className="h-8 px-2.5 text-xs font-mono gap-1.5"
          >
            {isAllOpen ? (
              <>
                <ChevronsDownUp className="size-3.5" />
                <span>Collapse all</span>
              </>
            ) : (
              <>
                <ChevronsUpDown className="size-3.5" />
                <span>Expand all</span>
              </>
            )}
          </Button>
          <span className="font-mono text-[11px] text-muted-foreground hidden sm:inline">
            {search.trim()
              ? `${matchingSections.length} of ${allKeys.length} sections match`
              : "6 reference sections"}
          </span>
        </div>
      </div>

      {matchingSections.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <p className="font-semibold text-sm text-foreground">No matching documentation topics</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No documentation sections matched your search for &quot;{search}&quot;. Try searching for &quot;endpoints&quot;, &quot;curl&quot;, &quot;encryption&quot;, or &quot;error codes&quot;.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSearch("")}
            className="mt-4 font-mono text-xs"
          >
            Clear Search
          </Button>
        </div>
      ) : null}

      {/* DOCUMENTATION ACCORDION SYSTEM */}
      <Accordion
        type="multiple"
        value={openItems}
        onValueChange={(val) => setOpenItems(Array.isArray(val) ? val : [val])}
        className="w-full"
      >
        {/* SECTION 1: QUICKSTART & AUTHENTICATION */}
        {matchingSections.includes("quickstart") && (
          <AccordionItem value="quickstart">
          <AccordionTrigger
            badge={
              <Badge tone="ok" dot className="font-mono text-[10px]">
                GET STARTED
              </Badge>
            }
            subtitle="Obtain API credentials and set up standard HTTP Bearer authentication"
          >
            1. Quickstart & Authentication
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/80 bg-card p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Key className="size-4 text-foreground opacity-80" />
                    <h3 className="font-semibold text-xs sm:text-sm text-foreground">
                      1. Generate Your Free API Key
                    </h3>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Create a free developer account to issue key tokens. Keys are created instantly,
                    hashed irreversibly via SHA-256 at rest, and never shared with third parties.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Link
                      href="/signup"
                      className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-7.5 text-xs")}
                    >
                      Get API Key
                    </Link>
                    <Link
                      href="/dashboard"
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7.5 text-xs")}
                    >
                      Open Dashboard
                    </Link>
                  </div>
                </div>

                <div className="rounded-lg border border-border/80 bg-card p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <ShieldCheck className="size-4 text-emerald-500" />
                    <h3 className="font-semibold text-xs sm:text-sm text-foreground">
                      2. Add HTTP Authorization Header
                    </h3>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Pass your key in the standard RFC 6750 <code className="font-mono font-semibold text-foreground">Authorization</code> header.
                    Alternatively, query parameter or <code className="font-mono text-foreground font-semibold">x-api-key</code> is accepted.
                  </p>
                  <div className="mt-3 rounded border border-border/70 bg-secondary/30 p-2 font-mono text-[11px] text-foreground flex items-center justify-between">
                    <span className="truncate">Authorization: Bearer atp_live_...</span>
                    <CopyButton value="Authorization: Bearer atp_live_your_key" size="xs" />
                  </div>
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
        )}

        {/* SECTION 2: CODE SNIPPETS & CLIENT INTEGRATIONS */}
        {matchingSections.includes("snippets") && (
          <AccordionItem value="snippets">
          <AccordionTrigger
            badge={
              <Badge tone="neutral" className="font-mono text-[10px]">
                CURL · NODE · PYTHON · GO
              </Badge>
            }
            subtitle="Ready-to-run HTTP client implementations across major languages"
          >
            2. Request Examples & Client SDKs
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <Tabs defaultValue="curl" className="w-full">
                <div className="flex items-center justify-between pb-2 border-b border-border/60 mb-3">
                  <TabsList className="h-8">
                    <TabsTrigger value="curl" className="font-mono text-xs px-2.5">
                      cURL
                    </TabsTrigger>
                    <TabsTrigger value="nodejs" className="font-mono text-xs px-2.5">
                      Node.js
                    </TabsTrigger>
                    <TabsTrigger value="python" className="font-mono text-xs px-2.5">
                      Python
                    </TabsTrigger>
                    <TabsTrigger value="go" className="font-mono text-xs px-2.5">
                      Go
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="curl" className="mt-0">
                  <div className="relative rounded-lg border border-border/80 bg-secondary/30 p-3.5 font-mono text-xs">
                    <div className="absolute right-2.5 top-2.5">
                      <CopyButton value={CODE_EXAMPLES.curl} size="xs" />
                    </div>
                    <pre className="overflow-x-auto text-foreground leading-relaxed">
                      {CODE_EXAMPLES.curl}
                    </pre>
                  </div>
                </TabsContent>

                <TabsContent value="nodejs" className="mt-0">
                  <div className="relative rounded-lg border border-border/80 bg-secondary/30 p-3.5 font-mono text-xs">
                    <div className="absolute right-2.5 top-2.5">
                      <CopyButton value={CODE_EXAMPLES.nodejs} size="xs" />
                    </div>
                    <pre className="overflow-x-auto text-foreground leading-relaxed">
                      {CODE_EXAMPLES.nodejs}
                    </pre>
                  </div>
                </TabsContent>

                <TabsContent value="python" className="mt-0">
                  <div className="relative rounded-lg border border-border/80 bg-secondary/30 p-3.5 font-mono text-xs">
                    <div className="absolute right-2.5 top-2.5">
                      <CopyButton value={CODE_EXAMPLES.python} size="xs" />
                    </div>
                    <pre className="overflow-x-auto text-foreground leading-relaxed">
                      {CODE_EXAMPLES.python}
                    </pre>
                  </div>
                </TabsContent>

                <TabsContent value="go" className="mt-0">
                  <div className="relative rounded-lg border border-border/80 bg-secondary/30 p-3.5 font-mono text-xs">
                    <div className="absolute right-2.5 top-2.5">
                      <CopyButton value={CODE_EXAMPLES.go} size="xs" />
                    </div>
                    <pre className="overflow-x-auto text-foreground leading-relaxed">
                      {CODE_EXAMPLES.go}
                    </pre>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </AccordionContent>
        </AccordionItem>
        )}

        {/* SECTION 3: REST API ENDPOINTS SPECIFICATION */}
        {matchingSections.includes("endpoints") && (
          <AccordionItem value="endpoints">
          <AccordionTrigger
            badge={
              <Badge tone="neutral" className="font-mono text-[10px]">
                REST v1 · 3 CORE
              </Badge>
            }
            subtitle="Full schemas, query parameters, authentication scopes, and return payloads"
          >
            3. Endpoints & Schema Reference
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-5">
              {ENDPOINTS.map((endpoint) => (
                <div
                  key={endpoint.path}
                  className="rounded-lg border border-border/80 bg-card overflow-hidden shadow-2xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-secondary/20 p-3 sm:px-4">
                    <div className="flex items-center gap-2.5 font-mono">
                      <span className="rounded border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10px] font-bold text-ok">
                        {endpoint.method}
                      </span>
                      <code className="text-xs sm:text-sm font-semibold text-foreground">
                        {endpoint.path}
                      </code>
                    </div>
                    <Badge tone={endpoint.authTone} dot className="font-mono text-[10px]">
                      {endpoint.auth}
                    </Badge>
                  </div>

                  <div className="p-4 sm:p-5 flex flex-col gap-3">
                    <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                      {endpoint.description}
                    </p>

                    {endpoint.params && endpoint.params.length > 0 && (
                      <div className="mt-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1.5">
                          Query Parameters:
                        </span>
                        <div className="overflow-x-auto rounded border border-border/70">
                          <table className="w-full text-left font-mono text-xs">
                            <thead className="border-b border-border/70 bg-secondary/40 text-[10px] uppercase text-muted-foreground">
                              <tr>
                                <th className="p-2 pl-3">Param</th>
                                <th className="p-2">Type</th>
                                <th className="p-2">Required</th>
                                <th className="p-2 pr-3">Description</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {endpoint.params.map((p) => (
                                <tr key={p.name} className="hover:bg-secondary/20">
                                  <td className="p-2 pl-3 font-semibold text-foreground">{p.name}</td>
                                  <td className="p-2 text-muted-foreground">{p.type}</td>
                                  <td className="p-2">
                                    {p.required ? (
                                      <span className="text-warn">Yes</span>
                                    ) : (
                                      <span className="text-muted-foreground">No</span>
                                    )}
                                  </td>
                                  <td className="p-2 pr-3 text-muted-foreground">{p.desc}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {endpoint.responseSample && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                            Response Payload (JSON):
                          </span>
                          <CopyButton value={endpoint.responseSample} size="xs" />
                        </div>
                        <div className="rounded-md border border-border/70 bg-secondary/30 p-3 font-mono text-[11px] text-foreground overflow-x-auto max-h-60">
                          <pre>{endpoint.responseSample}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
        )}

        {/* SECTION 4: CRYPTOGRAPHIC SECURITY & CIPHER MODEL */}
        {matchingSections.includes("encryption") && (
          <AccordionItem value="encryption">
          <AccordionTrigger
            badge={
              <Badge tone="ok" className="font-mono text-[10px]">
                AES-256-GCM
              </Badge>
            }
            subtitle="Authenticated envelope encryption, nonces, and zero-plaintext guarantees"
          >
            4. Cryptographic Security & Cipher Model
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3 leading-relaxed">
              <p>
                ArchivePool adheres to a strict <strong>Zero Plaintext Storage</strong> security guarantee.
                Account tokens and streaming passwords are encrypted before they ever touch disk storage.
              </p>

              <div className="grid gap-3 sm:grid-cols-3 mt-2">
                <div className="rounded-lg border border-border/80 bg-card p-3.5">
                  <span className="font-mono text-[11px] font-semibold text-foreground block mb-1">
                    Cipher Suite
                  </span>
                  <p className="text-xs text-muted-foreground">
                    AES-256-GCM authenticated symmetric encryption with 128-bit integrity tag.
                  </p>
                </div>

                <div className="rounded-lg border border-border/80 bg-card p-3.5">
                  <span className="font-mono text-[11px] font-semibold text-foreground block mb-1">
                    Key Derivation
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Master key derivation with Argon2id memory-hard hashing and unique salts.
                  </p>
                </div>

                <div className="rounded-lg border border-border/80 bg-card p-3.5">
                  <span className="font-mono text-[11px] font-semibold text-foreground block mb-1">
                    Unique Initialization
                  </span>
                  <p className="text-xs text-muted-foreground">
                    A cryptographically random 96-bit IV nonce is generated independently for each entry.
                  </p>
                </div>
              </div>

              <div className="mt-2 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs text-muted-foreground">
                <span className="font-semibold text-warn">Database breach immunity:</span> Even in the event of an arbitrary SQL dump or disk leak, ciphertext cannot be decrypted without the isolated master secret.
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
        )}

        {/* SECTION 5: POOL GOVERNANCE & LRU LEASE ROTATION */}
        {matchingSections.includes("governance") && (
          <AccordionItem value="governance">
          <AccordionTrigger
            badge={
              <Badge tone="neutral" className="font-mono text-[10px]">
                LRU ROTATION
              </Badge>
            }
            subtitle="Distribution algorithm, automated health sweeps, and account quarantine rules"
          >
            5. Pool Governance & LRU Rotation Rules
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-2.5 text-xs leading-relaxed text-muted-foreground">
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />
                  <span>
                    <strong className="text-foreground">Least-recently-used rotation:</strong> Feed requests return rotating source leases rather than dump all credentials at once. This distributes concurrent playback across all pooled sources, preventing provider rate triggers.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />
                  <span>
                    <strong className="text-foreground">Scheduled hourly sweeps:</strong> Every credential is tested with lightweight synthetic handshakes every 60 minutes.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />
                  <span>
                    <strong className="text-foreground">Immediate auto-quarantine:</strong> Sources that return authentication failures or account suspensions are isolated from dispatch immediately.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />
                  <span>
                    <strong className="text-foreground">Contributor privacy:</strong> Submissions require no email address or real name. Attribution handles are strictly optional.
                  </span>
                </li>
              </ul>
            </div>
          </AccordionContent>
        </AccordionItem>
        )}

        {/* SECTION 6: ERROR HANDLING & STATUS CODES */}
        {matchingSections.includes("errors") && (
          <AccordionItem value="errors">
          <AccordionTrigger
            badge={
              <Badge tone="neutral" className="font-mono text-[10px]">
                RFC 9110
              </Badge>
            }
            subtitle="Standard HTTP error responses, rate-limiting headers, and retry strategies"
          >
            6. Error Codes & Rate Limit Policies
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3 font-mono text-xs">
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <Table className="w-full text-left font-mono text-xs">
                  <TableHeader className="border-b border-border/80 bg-secondary/35 text-[11px] uppercase text-muted-foreground">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="p-2.5 pl-3.5 font-semibold text-muted-foreground">Status</TableHead>
                      <TableHead className="p-2.5 font-semibold text-muted-foreground">Reason</TableHead>
                      <TableHead className="p-2.5 pr-3.5 font-semibold text-muted-foreground">Resolution</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-border/60">
                    <TableRow className="hover:bg-secondary/20">
                      <TableCell className="p-2.5 pl-3.5 font-bold text-ok">200 OK</TableCell>
                      <TableCell className="p-2.5 text-foreground">Request succeeded</TableCell>
                      <TableCell className="p-2.5 pr-3.5 text-muted-foreground">Payload contains valid lease tokens</TableCell>
                    </TableRow>
                    <TableRow className="hover:bg-secondary/20">
                      <TableCell className="p-2.5 pl-3.5 font-bold text-warn">401 Unauthorized</TableCell>
                      <TableCell className="p-2.5 text-foreground">Missing or invalid API key</TableCell>
                      <TableCell className="p-2.5 pr-3.5 text-muted-foreground">Check Authorization header value</TableCell>
                    </TableRow>
                    <TableRow className="hover:bg-secondary/20">
                      <TableCell className="p-2.5 pl-3.5 font-bold text-warn">403 Forbidden</TableCell>
                      <TableCell className="p-2.5 text-foreground">Key revoked or disabled</TableCell>
                      <TableCell className="p-2.5 pr-3.5 text-muted-foreground">Regenerate key in dashboard</TableCell>
                    </TableRow>
                    <TableRow className="hover:bg-secondary/20">
                      <TableCell className="p-2.5 pl-3.5 font-bold text-destructive">429 Too Many Requests</TableCell>
                      <TableCell className="p-2.5 text-foreground">Exceeded 1,000 req/hour quota</TableCell>
                      <TableCell className="p-2.5 pr-3.5 text-muted-foreground">Back off according to Retry-After header</TableCell>
                    </TableRow>
                    <TableRow className="hover:bg-secondary/20">
                      <TableCell className="p-2.5 pl-3.5 font-bold text-destructive">503 Degraded</TableCell>
                      <TableCell className="p-2.5 text-foreground">Zero live sources in pool</TableCell>
                      <TableCell className="p-2.5 pr-3.5 text-muted-foreground">Check status board; pool currently replenishing</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
        )}
      </Accordion>
    </div>
  )
}
