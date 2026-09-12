# Read keys in use

Apps present a read key as `Authorization: Bearer …` to reach `/api/accounts`, `/api/sources` and
`/api/discovery/*`. Only the SHA-256 hash is stored, so a key's plaintext cannot be recovered —
losing it means minting a new one, not looking the old one up.

## ArchiveTune uses three keys, and that is not a mistake

| id | Name | Prefix | Role |
|---|---|---|---|
| 11 | ArchiveTune 2026-08 (rotated app key) | `atp_022bd3` | **Current.** Baked into new builds as `SOURCE_PROVIDER_KEY`. |
| 9 | ArchiveTune (CI-baked app key) | `atp_e2f45f` | **Legacy, still required.** Baked into builds already on people's phones. |
| 5 | ArchiveTune | `atp_f943b7` | Manually created; predates the CI-baked pair. |

Rows 11 and 9 are a deliberate overlap. The key is compiled into the APK, so rotating it only
affects builds produced *after* the rotation — every installed copy keeps presenting the old one.
Deleting row 9 breaks the pool for everyone who has not updated yet. Retire it by usage, not by
date: watch `use_count` and `last_used_at` in the Keys panel and delete it once traffic has
effectively stopped.

Row 5 is the genuine duplicate. It is not referenced by any workflow — CI reads the
`SOURCE_PROVIDER_KEY` secret, which holds row 11's value — so its remaining traffic is whatever
is still presenting a hand-copied key. Revoke it first (reversible) rather than deleting; if
nothing breaks, delete it.

## Per-developer keys

Give each fork or downstream app its own key so leases, rate limits and abuse are attributable:

| id | Name | Prefix | Holder |
|---|---|---|---|
| 16 | 4nx3b ArchiveTune (dev branch) | `atp_80e307` | the 4nx3b fork |
| 15 | SpatialFlow Dev | `atp_de44e5` | `mythicalshub` |
| 12 | SpatialFlow Dev | `atp_84d73a` | `mythicalshub` — duplicate, never used |

Row 12 has zero uses and the same name and reason as row 15, which is live. It is safe to revoke.

## Why not just share one key

Leases are per key (`api_key_leases`). Two apps on one key fight over the same sticky credential
set, and a single bad actor gets every app's traffic rate-limited at once. One key per consumer
keeps `/api/report` feedback attributable too.
