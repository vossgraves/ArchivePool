# /api/report

Apps report what they observed at playback time. The pool re-checks the entry live before acting,
so a report only ever triggers a verification and never decides the outcome on its own.

| Report | Meaning | Effect |
|---|---|---|
| `dead` | the credential refused the app — bad token, expired ARL, revoked session | live or recent stored check; a failing entry is demoted to `pending` and disabled at `DISABLE_AFTER_REPORTS` qualifying failure signals, a healthy one keeps serving |
| `not_premium` | it works but does not deliver the tier the pool believed | live or recent stored check; the entry is disabled only when the provider confirms it is not premium, otherwise the report is ignored |

This is deliberately a **side channel, not a truth source**. Nothing is deleted, and the sweep
re-checks every entry server-side (Tidal tokens even rotate there), so false reports decay on
their own.

## How verification scales

A report does not always pay for a live check. A stored verdict inside
`REPORT_VERIFY_COOLDOWN_MS` (15 min) answers in its place — the few accounts a shared key holds
are reported thousands of times a day, and re-probing each one is what feeds Tidal
`abuse_detected`. When the verdict is stale, the report claims a per-entry
`verify_lease_until` (120 s) before probing: only the claimant runs the provider check
(bounded by a 45 s signal through every fetch in the chain), and every other report in the
window resolves from the stored row. Reports therefore cannot pile onto one provider call per
report, and one hung upstream cannot hold a lease hostage.

Failure accounting is report-aware but check-anchored: a probe that ran already recorded its own
result, so the report's `consecutive_failures` increment applies only when the report itself is
the qualifying signal — and the whole park/count/disable happens in one guarded UPDATE that does
nothing when a check that succeeded after the report began already landed (`last_ok_at`). A
fresh success always outranks a report.

## Why a report can earn a replacement

A device that reports a dead token used to wait for its next scheduled feed refresh before it
could play anything. Handing back one replacement in the same response closes that gap.

A replacement is a real credential, so it is gated three times over:

1. **`identity.keyId != null`.** `/api/report` stays open when `READ_KEYS_ENFORCED` is off, and
   handing a credential to an anonymous caller would be a feed that bypasses the
   always-enforced gate on `/api/accounts`. No resolved key, no replacement — whatever `Bearer`
   header was presented.
2. **`releaseLease()` actually deleted a row.** Entry ids are sequential and enumerable, so
   without this any registered key could report ids it never received and harvest a replacement
   for each, reopening the pool-walking exposure that per-key leases exist to close. A lease row
   existing is proof the pool handed *this* entry to *this* key. Reporting an entry the key never
   held still updates status and health log — it just earns nothing.
3. **`REPLACEMENTS_PER_HOUR` per service, per key.** The real exposure ceiling: a key reporting
   everything it holds as dead pulls at most three fresh accounts per service per hour. Three
   matches `LEASE_PER_CATEGORY_ACCOUNT`, so a device may replace its whole working set for one
   service once an hour — far beyond any real dead-token rate.

The encryption gate mirrors `/api/accounts` but is non-fatal: a legacy client on a server with no
`POOL_CLIENT_KEY` gets `replacement: null`, never plaintext and never a 503. The report itself
must succeed either way.

## Rate limits

`REPORT_IP_LIMIT` / `REPORT_KEY_LIMIT` are 20 per 5 minutes. Every report costs a live provider
check, so the limit caps what one address can spend there; it is still far above any real device's
dead-token chatter.

All limiter windows are per serverless instance, not global.
