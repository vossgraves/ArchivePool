// SPDX-License-Identifier: GPL-3.0-or-later
import { defineCloudflareConfig } from "@opennextjs/cloudflare"

/**
 * OpenNext for Cloudflare — see docs/CLOUDFLARE.md.
 *
 * Static assets are served by the Workers Assets binding (wrangler.jsonc `assets`),
 * ISR/prerendered pages stay inside the worker (the site's pages are all dynamic
 * or build-time static). No incremental-cache binding is configured: every page
 * is either force-dynamic or rendered once at build time, so there is nothing to
 * revalidate — and an absent cache is what makes `revalidatePath` in the submit
 * action a safe no-op rather than an error.
 */
export default defineCloudflareConfig({})
