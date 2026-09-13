# The dashboard, and the visual system it is built from

## What /dashboard is for

It answers four questions, in the order a signed-in person asks them:

1. **Is anything wrong that I can fix?** — the "Needs your attention" list, sorted worst first.
2. **What do my keys do?** — how many exist, how much traffic each carries, which pool entries each
   one is currently holding.
3. **Are my contributions still working?** — status, uptime, latency and declared expiry per entry,
   with the daily pass rate behind those figures.
4. **Can the pool serve my apps at all?** — per-category health, because a key is only as good as
   what the pool has to lease it.

Before this it listed API keys and nothing else, which meant the answer to (1), (3) and (4) was
"open three other pages, or ask an admin".

## One server read

`getDashboard(userId, username)` in `lib/queries.ts` gathers everything and the page component
passes it down as props. Two rules follow from that and are worth keeping:

- **Client components never query.** No pool table is reachable from the browser, and every query
  lists its columns by name, so `payload` cannot be selected into a view by accident.
- **Mutations refresh the server data** (`router.refresh()`), rather than each panel patching a
  local copy. The tiles at the top and the list they summarise are then always the same figures;
  they were computed from two separate fetches before, and they drifted.

Each section is wrapped so its own failure degrades to "unavailable" instead of a 500 — someone
whose history aggregate timed out still needs the Revoke button.

### Contributions are matched by contributor name

The pool tables deliberately hold no user id (`docs/SCHEMA.md`), so an entry is tied to a person
only by the opt-in `contributor` credit. A submission made with the credit box unticked therefore
cannot appear on this page. That is the contributor's choice being honoured, not a gap to fix — and
`contributor` still never leaves the server in any feed.

### What is deliberately not shown

- **`detail`** — the last check's failure string. It is short and credential-free today, but it is
  built from upstream error messages, and a page that renders arbitrary upstream text next to a
  credential is one upstream change away from leaking something. The status and the timestamps say
  the same thing for a contributor's purposes.
- **A payload, ever, in any form.** Rows carry the masked `label` the pool itself uses.

## Charts

`components/ui/chart.tsx` holds every data visual: `TrendChart`, `Sparkline`, `BarSeries`,
`SegmentBar`, `BarList`, `ChartLegend`.

They are ported from [Evil Charts](https://evilcharts.com) — its scoped `<defs>`, vertical gradient
fills, Gaussian glow, `3 3` dashed grid, rounded bar tops, left-to-right reveal mask and dashed
trailing segment for a period that has not closed — but drawn by hand in SVG and CSS rather than by
pulling in Recharts and a chart runtime for six shapes on two pages.

Three rules hold across all of them:

- **Colour comes only from the tone map** (`TONE_VAR`, `TONE_BG` in `components/ui/badge.tsx`), so a
  series and the badge beside it cannot disagree about what green means.
- **The drawing is `aria-hidden` and the figures are repeated as text** in an sr-only list, because
  a chart is emphasis and must never be the only place a number exists.
- **A percentage chart is pinned to a 0-100 axis.** Rescaling to the series' own peak makes 40%
  look like a good day.

`preserveAspectRatio="none"` stretches the line charts to their container, which is why strokes
carry `vector-effect="non-scaling-stroke"` and why dots and crosshairs are HTML overlays: a circle
in a non-uniformly scaled SVG comes out an ellipse.

`BarSeries` stacks failures **above** passes. A stack is read from the baseline up, so the anomaly
has to cap the column or a bad day just looks like a short one.

## Theme

Both themes are real. `:root` in `app/globals.css` is light, `.dark` is dark, and nothing outside
those two blocks may name a colour — a raw `bg-amber-500/15` reads as amber on both surfaces, which
is how the old status chips became unreadable the moment a light background existed.

`<html>` still ships with `class="dark"`, and the blocking script in `app/layout.tsx` removes it for
a reader whose stored choice is light. So the default stays dark (including with JavaScript off),
an unset choice follows the system, and neither theme flashes the other on first paint.

The signal colours are darker in light than in dark: the same `oklch(0.74)` green that reads as a
signal on near-black fails contrast as text on near-white, and these tones are used as text — uptime
figures, badge labels — not only as fills.
