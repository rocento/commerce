# Recento brand

## Rocento spelling correction

`rocento-logo.png` is the corrected lowercase wordmark used by the shared admin/storefront logo. It uses raster artwork rather than a replacement browser font. The original exports are retained, and the standalone icon is unchanged.

Created with built-in ImageGen editing. Final prompt: “Use case: text-localization. Image 1 is the exact edit target. Correct ONLY the second letter of the lowercase wordmark from e to o: 'recento' must become 'rocento' (r-o-c-e-n-t-o). Preserve the exact original bold geometric font, dark charcoal lettering color, kerning, baseline, lowercase case, and original angular terracotta orange icon and its shape/color/size/position. The final o in the original wordmark is the exact glyph to duplicate for the new second letter. Change absolutely nothing else. Same horizontal composition and tightly cropped proportions as original, with genuinely transparent background. This is a spelling correction, not a redesign. Keep the original icon unchanged.” Transparent outer padding was cropped for the original 156px display width.

Approved identity: lowercase wordmark, standalone angular terracotta icon, no frame.

## Wordmark alignment — 2026-10-12

The `rocento-logo.png` wordmark was lowered slightly to balance it optically with the angular icon. The existing icon design, lowercase font style, and colors are retained. The transparent production canvas remains 2170 × 520, so existing component dimensions remain valid. This was a built-in ImageGen edit; the model output is a raster edit, not a pixel-identical layer translation.

The shared `commerce-web/packages/ui/src/brand/rocento-logo-320.webp` and `rocento-logo-640.webp` exports and the three app public PNG copies were refreshed. The white-background export at `commerce-assets/high-resolution/rocento-full-logo.png` was also refreshed. Standalone icon and favicon artwork are unchanged. Previous artwork and the editing prompt are retained under `commerce-output/rocento-logo-alignment-20261012/`.

Final refinement prompt: “Move the existing charcoal 'rocento' wordmark upward by 47 pixels in the first aligned draft, preserving the icon position, existing font/glyph shapes, letter sizes, bold weight, kerning, spelling, texture, colors, and transparent background. Treat the lettering as an intact layer; do not redraw or redesign.” The first draft had lowered the wordmark too far; this refinement leaves it slightly below its original position. Excess transparent outer padding was removed when exporting the production canvas.

- `approved-original.png`: unchanged approved ImageGen output.
- `recento-logo.png`: trimmed transparent horizontal logo, preserving the approved lettering.
- `recento-icon.png`: standalone icon extracted from the approved image.
- `favicon.ico`: browser icon with 16, 32 and 48 px sizes.
- `favicon-32.png`, `icon-192.png`, `icon-512.png`: square transparent browser/app exports.
- `apple-touch-icon.png`: 180 px touch icon.

These are raster assets. Source artwork was created using built-in ImageGen with the direction: “Previous Recento wordmark, current angular terracotta icon, remove the hexagonal frame.” Exports preserve that artwork rather than substituting a font or redrawing the icon.

Run `python3 commerce-ops/scripts/sync-brand-assets.py` from the repository root after updating exports. All four frontend apps and rengine receive identical public artwork under `/brand/`. Legacy `recento-logo.png` URLs serve the corrected Rocento wordmark, and legacy SVG favicons embed the approved icon. App Studio declares browser and Apple touch icons explicitly. rengine uses the full wordmark on sign-in and the standalone icon in its sidebar. Admin and storefront use the shared `BrandLogo` component; the public website has a React 19 wrapper using the same assets. Keep brand artwork independent of storefront theme fonts and colors.
