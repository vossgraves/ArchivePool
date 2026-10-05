// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * End-to-end verification of the ArchivePool site: signup → dashboard →
 * request key → key-gated feed → docs/login pages render. Run against a
 * local production server (see scripts/e2e.sh) or pass BASE_URL.
 *
 * Exits non-zero on the first failed expectation. Screenshots land in
 * .e2e-screens/ for eyeballing.
 */
const { chromium } = require("playwright")
const fs = require("fs")

const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const SHOTS = ".e2e-screens"

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

;(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const username = `e2e_${Date.now().toString(36).slice(-6)}`

  // 1. Landing renders with the new hero + key CTA.
  await page.goto(`${BASE}/`)
  check("landing: hero headline", await page.getByText("gated by keys").isVisible())
  check("landing: get-key CTA", await page.getByRole("link", { name: "Get an API key" }).isVisible())
  check("landing: sign-in button top-right", await page.getByRole("link", { name: "Sign in" }).isVisible())
  await page.screenshot({ path: `${SHOTS}/landing.png`, fullPage: true })

  // 2. Feed is NOT public.
  const anon = await page.evaluate(async () => (await fetch("/api/sources")).status)
  check("api/sources anonymous → 401", anon === 401)

  // 3. Signup through the real form.
  await page.goto(`${BASE}/signup`)
  await page.getByPlaceholder("e.g. record_collector").fill(username)
  await page.getByPlaceholder("At least 8 characters").fill("e2e-password-1")
  await page.getByRole("button", { name: "Create account" }).click()
  await page.waitForURL("**/dashboard", { timeout: 15000 })
  check("signup → dashboard redirect", page.url().includes("/dashboard"))

  // 4. Dashboard: request a key, capture the reveal-once plaintext.
  await page.getByPlaceholder("Key name (e.g. my phone)").fill("e2e key")
  await page.getByRole("button", { name: "Request API key" }).click()
  await page.getByText("shown only once").waitFor({ timeout: 15000 })
  const keyText = await page.locator("code.font-mono").first().innerText()
  check("key revealed once (atp_ prefixed)", keyText.startsWith("atp_"))
  await page.screenshot({ path: `${SHOTS}/dashboard-key.png`, fullPage: true })

  // 5. The key works against the gated feed; a wrong key does not.
  const withKey = await page.evaluate(async (k) => {
    const r = await fetch("/api/sources", { headers: { Authorization: `Bearer ${k}` } })
    return { status: r.status, encrypted: (await r.json()).encrypted }
  }, keyText)
  check("api/sources with key → 200", withKey.status === 200)
  check("api/sources payloads encrypted", withKey.encrypted === true)
  const badKey = await page.evaluate(async () => {
    const r = await fetch("/api/sources", { headers: { Authorization: "Bearer atp_deadbeef" } })
    return r.status
  })
  check("api/sources wrong key → 401", badKey === 401)

  // 6. Header shows the signed-in identity; /me agrees.
  await page.reload()
  await page.getByRole("button", { name: username }).waitFor({ timeout: 10000 })
  check("header shows username after login", true)
  const me = await page.evaluate(async () => {
    const r = await fetch("/api/auth/me")
    return { status: r.status, username: (await r.json()).username }
  })
  check("api/auth/me returns the user", me.status === 200 && me.username === username)

  // 7. Docs page renders.
  await page.goto(`${BASE}/docs`)
  check("docs: title", await page.getByText("Source Pool API").isVisible())
  check("docs: curl example", await page.getByText("Authorization: Bearer atp_YOUR_KEY").isVisible())
  await page.screenshot({ path: `${SHOTS}/docs.png`, fullPage: true })

  // 8. Login page renders for signed-out users (use a fresh context).
  const anonPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await anonPage.goto(`${BASE}/login`)
  check("login: form renders", await anonPage.getByText("Welcome back").isVisible())
  await anonPage.screenshot({ path: `${SHOTS}/login.png`, fullPage: true })
  // Signed-in users get bounced to the dashboard.
  await page.goto(`${BASE}/login`)
  await page.waitForURL("**/dashboard", { timeout: 10000 })
  check("login redirects when already signed in", true)

  // 9. Logout via the header menu.
  await page.getByRole("button", { name: username }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await page.getByRole("link", { name: "Sign in" }).waitFor({ timeout: 10000 })
  check("logout returns to signed-out header", true)

  // 10. Revoked keys stop working.
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder("e.g. record_collector").fill(username)
  await page.getByPlaceholder("Your password").fill("e2e-password-1")
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL("**/dashboard", { timeout: 15000 })
  await page.getByRole("button", { name: "Revoke" }).click()
  await page.getByRole("button", { name: "Restore" }).waitFor({ timeout: 10000 })
  const revokedStatus = await page.evaluate(async (k) => {
    const r = await fetch("/api/sources", { headers: { Authorization: `Bearer ${k}` } })
    return r.status
  }, keyText)
  check("revoked key → 401", revokedStatus === 401)

  await browser.close()
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECKS FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((err) => {
  console.error("E2E crashed:", err)
  process.exit(1)
})
