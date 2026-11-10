# Marketing site

`site/` is the landing page as deployed: `pages.yml` uploads it unchanged on pushes to `main` that touch
it. There is no build step. Preview with `npm run dev:site`.

## Artwork

The hero illustration is `site/assets/zen-engawa.webp` (1774 × 887, WebP quality 88): the Edo
woodblock artwork with a painted finish (Kuwahara paint patches and brush streaks) baked in from an earlier
WebGL renderer. The laptop screen keeps the original artwork's crisp pixels. The hero spans the viewport, with
real HTML copy over faded sand on the left. Between 761px and the full width the scene crops from the left,
keeping the laptop; at 760px and below the artwork is hidden. Gradients blend the scene into the paper without obscuring the laptop.

## Water

`<svg class="garden-water">` in `site/index.html` sits over the artwork in its own pixel coordinates
(`viewBox="0 0 1774 887"`), so it scales and crops with the scene. A stream runs from the spout (1597, 278)
to the water surface (y 321), with a dashed highlight flowing down it; three ripples grow and fade in turn,
clipped to the basin (centre 1598, 321; radii 44 × 7). Timing and colors (`--water`, `--water-light`) are in
`style.css`. Reduced motion stops the flow and hides the ripples.

## Laptop screen

The `.laptop-screen` element is a 320 × 210 design canvas holding the animated chat (`laptop-chat.js`). Use
ordinary pixel sizes or container query units (`cqw`) inside it. A projective transform in `main.js` aligns it
to the artwork's four inner screen corners: (1204, 374), (1517, 390), (1494, 597), and (1181, 563), and a
ResizeObserver scales it with the scene. Keep the artwork's aspect ratio; crop the scene and overlay together,
never the image independently. If the artwork changes, recalibrate the corners and the water.

## Theme

`site/assets/style.css` holds the whole theme, hero layout, and fades. Every color is a `:root`
variable: add a variable rather than a literal color (a test enforces it). `sand-ripples.svg` is a decorative
pattern of flowing lines and elliptical rings; its placement and scale vary by section. The logo keeps the
original green (`--brand-green`), matching the favicon. Both pages share the theme.
