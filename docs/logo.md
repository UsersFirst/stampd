# Logo

The source artwork is `docs/logo-source.png` — 1536×1024, white line art on a transparent
background, with a pale blue check mark. Everything else is generated from it.

## The problem with the source

It is white. On a dark background it reads well; on a light one it is effectively invisible
(75% of its visible pixels sit at luminance 224–255, and the blue check is `#becfe9`, which
has almost no contrast against white). It is also raster, so it cannot be scaled up for
print, projection, or a badge template.

## What is generated

```
python3 scripts/logo/build-logo.py        # needs: brew install potrace imagemagick
```

| Output | Use |
| --- | --- |
| `apps/dashboard/src/components/LogoArt.tsx` | Inlined in the app. Ink is `currentColor`. |
| `apps/dashboard/public/stampd-{mark,lockup}-{light,dark}.svg` | Standalone, colours baked in. |

**`currentColor` is why the component is inlined rather than loaded as an image.** An SVG
referenced through `<img>` cannot inherit the page's colour, so it would need one file per
theme. Inlined, a single component takes whatever colour the surrounding text has and both
themes are covered for free. The check keeps its own hue through the `--logo-check` variable.

The standalone files exist for everything outside the app — README embeds, social cards,
slide decks — where colours must be baked in. In-SVG `@media (prefers-color-scheme)` was
tried and rejected: ImageMagick ignores it, and GitHub strips `<style>` from SVGs entirely,
so a self-theming single file would silently render as the wrong ink in exactly the places
it matters most.

## How the trace works

1. **Split into two layers first.** Pixels where `B > R + 18` are the check mark; everything
   else is ink. Tracing them separately is what keeps the check a distinct fill instead of
   being flattened into one monochrome silhouette.
2. **Use alpha as the mask, not colour.** The source's own white is discarded — only the
   shape matters, and the ink colour gets decided at render time.
3. **`mkbitmap -f 4 -s 2 -t 0.45`** upscales 2× and thresholds, which smooths the curves
   potrace then fits.
4. **`potrace -a 1.2 -O 0.3 -t 4`** traces, with despeckling to drop the anti-aliasing crumbs.

Two regions are cropped from the source: the `mark` (the circle and stamp) and the `lockup`
(mark plus the "stampd" wordmark and "was there" tagline).

### Watch the padding

`PAD = 12` in the build script is load-bearing. The crop boxes are flush against the
artwork, and mkbitmap's 2× upscale expands strokes slightly — without padding, the outer
glyphs of the wordmark (`s` and `d`) get clipped at the crop edge. The first trace shipped
with exactly that bug before it was caught by rendering the result back to raster and
looking at it.

## Favicons

`apps/dashboard/public/favicon-{light,dark}.png` are still raster, generated from the source
at 64×64 and padded to square (browsers stretch non-square icons). They are swapped by
`prefers-color-scheme` in `index.html`, which works because those are separate `<link>`
elements rather than styling inside one file.

## If a true vector original turns up

This is a trace, so curves are potrace's approximation of the raster, not the original
geometry. If the designer's vector source appears, prefer it: drop it in place of the
generated SVGs, and keep the `currentColor` treatment in `LogoArt.tsx`.
