# Logo

The source artwork is `docs/logo-source.png` — 1536×1024, white line art on a transparent
background, with a pale blue check mark. Everything shipped is generated from it.

```
python3 scripts/logo/build-logo.py        # needs: brew install potrace imagemagick
```

| Output | Use |
| --- | --- |
| `apps/dashboard/src/components/LogoArt.tsx` | Inlined in the app. Ink is `currentColor`. |
| `apps/dashboard/public/stampd-{mark,lockup}-{light,dark}.svg` | Standalone, colours baked in. |
| `apps/dashboard/public/favicon-{light,dark}.png` | Browser tab. Raster by necessity. |

## Why the component is inlined

An SVG referenced through `<img>` cannot inherit the page's colour, so it would need one
file per theme. Inlined, a single component takes `currentColor` from the surrounding text
and both themes are covered for free. The check keeps its own hue through `--logo-check`,
defined in `styles.css` for both themes.

This costs roughly 10 kB gzipped in the main bundle, traded for perfect theming and one
fewer request.

The standalone files exist for everything outside the app — README embeds, social cards,
slide decks — where colours must be baked in. In-SVG `@media (prefers-color-scheme)` was
tried and rejected: ImageMagick ignores it, and GitHub strips `<style>` from SVGs entirely,
so a self-theming single file would render the wrong ink in exactly the places it matters.

## How the trace works

1. **Split into two layers first.** Pixels where `B > R + 18` are the check mark; everything
   else is ink. Tracing them together flattens the check into one monochrome silhouette.
2. **Use alpha as the mask, not colour.** The source's white is discarded — only the shape
   matters, and ink colour is decided at render time.
3. **`mkbitmap -n -s 2 -t 0.45`** upscales 2× and thresholds, with filtering off.
4. **`potrace -a 1.2 -O 0.3 -t 4`** fits the curves, despeckling anti-aliasing crumbs.

Two regions are cropped from the source: the `mark` (circle and stamp) and the `lockup`
(mark plus the "stampd" wordmark and "was there" tagline).

## Two bugs that shipped once each

Both were invisible to the build and the typechecker. Both were caught only by rendering the
result back to raster and looking at it — which is the review step this pipeline needs.

**Clipped glyphs.** The crop boxes sit flush against the artwork, and mkbitmap's 2× upscale
expands strokes slightly, so the outer glyphs of the wordmark (`s` and `d`) were sliced off
at the crop edge. `PAD = 12` in the build script is the fix and is load-bearing.

**Pinholes at stroke junctions.** The wordmark showed a diamond notch where the `t`'s stem
meets its crossbar, and nicks where the bowls of `a`, `p` and `d` join their stems. The cause
was `mkbitmap -f 4`. High-pass filtering exists to flatten background gradients, and there
are none here — the input is a clean alpha channel. The filter instead carved into the
densest regions of the bitmap, which are exactly the junctions where two strokes overlap.
Passing `-n` disables it. The corrected paths are also about 30% smaller, since the filter
had been adding spurious contour detail.

## If a true vector original turns up

This is a trace, so the curves are potrace's approximation of a raster, not the original
geometry. If the designer's vector source appears, prefer it outright and keep the
`currentColor` treatment in `LogoArt.tsx`.
