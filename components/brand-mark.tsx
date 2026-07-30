/*
 * The ArchiveTune app mark.
 *
 * The two paths are copied verbatim from the Android vector drawable at
 * app/src/main/res/drawable/app_icon_small.xml in the ArchiveTune repo. Android's `pathData` uses
 * the same grammar as SVG's `d`, so this is the real geometry rather than a redraw, and the
 * 185x185 viewBox is that drawable's viewport.
 *
 * Brand colours are sampled from the shipped launcher PNG (mipmap-xxxhdpi/ic_launcher.png), not
 * eyeballed. Kept as literal hex rather than design tokens on purpose: this is a fixed brand
 * asset, and it is also rendered by Satori in opengraph-image.tsx, which cannot resolve CSS
 * variables. app/icon.svg carries the same paths standalone, since a favicon has to be a real file.
 *
 * No "use client" — this is pure markup, so it works in a server component and under Satori.
 */

const MARK_NAVY = "#113853"
const MARK_DISC = "#edf4fb"

/*
 * The mark's bounding box is x 41.5-150.5, y 42.5-150.5, putting its centre at (96, 96.5) while
 * the canvas centre is (92.5, 92.5) — left alone it sits low and to the right, so this recentres it.
 *
 * Scale is 0.86, not the 1.1 I first tried. Rendering the favicon at 16/24/32/96px side by side
 * showed 1.1 pushed the mark's corners right up against the disc edge; that looks fine at 96px but
 * turns into a smudge at 16px, where a tab favicon actually lives. Backing off leaves the padding
 * the launcher icon has and keeps the counter in the "T" open when it is tiny.
 */
const RECENTRE = "translate(92.5 92.5) scale(0.86) translate(-96 -96.5)"

const PATH_BAR =
  "M 136.5,42.5 C 139.572,42.1826 142.572,42.5159 145.5,43.5C 147.696,46.5596 149.363,49.893 150.5,53.5C 141.188,70.7896 131.355,87.7896 121,104.5C 115.248,101.04 109.415,97.7069 103.5,94.5C 108.706,84.5868 114.04,74.7535 119.5,65C 93.5133,65.9659 67.5133,67.1326 41.5,68.5C 41.5,61.1667 41.5,53.8333 41.5,46.5C 73.3416,45.5964 105.008,44.2631 136.5,42.5 Z"

const PATH_STEM =
  "M 77.5,75.5 C 84.8406,76.1159 92.174,76.7826 99.5,77.5C 97.8365,97.8139 94.3365,117.814 89,137.5C 87.8225,142.225 85.9892,146.559 83.5,150.5C 76.3087,148.954 69.3087,146.954 62.5,144.5C 69.9692,122.011 74.9692,99.011 77.5,75.5 Z"

export function BrandMark({
  size = 28,
  /**
   * `disc` reproduces the launcher icon: navy mark on its light circle. `bare` drops the circle and
   * draws the mark in the inherited text colour, for placing directly on a dark surface.
   */
  variant = "disc",
}: {
  size?: number
  variant?: "disc" | "bare"
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 185 185"
      // Decorative: every place this is used already has an adjacent text label, so announcing it
      // again would just make screen readers repeat the brand name.
      aria-hidden="true"
      focusable="false"
    >
      {variant === "disc" && (
        <>
          {/* The disc is #edf4fb, so against white browser chrome it all but disappears and the
              mark looks like it is floating. A hairline ring in the mark's own navy at low alpha
              defines the edge on white without being visible on a dark surface. Inset by half the
              stroke width so it is not clipped by the viewBox. */}
          <circle cx="92.5" cy="92.5" r="92.5" fill={MARK_DISC} />
          <circle
            cx="92.5"
            cy="92.5"
            r="90.5"
            fill="none"
            stroke={MARK_NAVY}
            strokeOpacity="0.16"
            strokeWidth="4"
          />
        </>
      )}
      <g fill={variant === "disc" ? MARK_NAVY : "currentColor"} transform={RECENTRE}>
        <path d={PATH_BAR} />
        <path d={PATH_STEM} />
      </g>
    </svg>
  )
}

/** Raw values so Satori (which cannot read CSS variables or import SVG) can reuse the mark. */
export const BRAND_MARK = { navy: MARK_NAVY, disc: MARK_DISC, recentre: RECENTRE, PATH_BAR, PATH_STEM }
