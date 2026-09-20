# Sedes branding sources

`sedes-icon.svg` is the canonical complete application icon. `sedes-glyph.svg`
is the transparent foreground used when a platform supplies or masks its own
background, including Android adaptive and themed icons.

The PNG files under `public/`, `electron/assets/`, and Android resource-density
directories are derived packaging assets. Make geometry or color changes in
these SVG sources first, then refresh every derived size and inspect the icon at
favicon, in-product, launcher-mask, and splash-screen scales.

Run `npm run generate:brand-assets` to regenerate every derived PNG. Android's
adaptive foreground is intentionally rendered at 68% of its layer canvas so
the complete mark stays inside circular launcher masks and their safe zone.
