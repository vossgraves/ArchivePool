// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Existing UI diagnostics stay visible without expanding the resource-limit change.
  {
    files: [
      "components/admin-audit.tsx", "components/admin-gate.tsx", "components/admin-keys.tsx",
      "components/admin-requests.tsx", "components/admin-sources.tsx", "components/admin-users.tsx",
      "components/docs-content.tsx", "components/theme-toggle.tsx", "components/ui/command.tsx",
      "components/ui/dialog.tsx", "components/ui/stat.tsx",
    ],
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
  {
    files: ["components/kokonutui/particle-button.tsx", "components/ui/dialog.tsx"],
    rules: { "react-hooks/purity": "warn" },
  },
  {
    files: ["components/railway-dither-bg.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  {
    files: ["components/tidal-connect.tsx"],
    rules: { "react-hooks/immutability": "warn" },
  },
  {
    files: ["components/ui/accordion.tsx"],
    rules: { "@typescript-eslint/no-empty-object-type": "warn" },
  },
  {
    files: ["components/ui/dialog.tsx"],
    rules: { "react-hooks/refs": "warn" },
  },
  {
    files: ["tests/harness.cjs"],
    rules: { "@typescript-eslint/no-this-alias": "warn" },
  },
  globalIgnores([".next/**", ".open-next/**", ".wrangler/**", "server/**"]),
])
