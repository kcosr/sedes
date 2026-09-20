# Build resources

The packaged `icon.png` is derived from
`../../assets/branding/sedes-icon.svg`, the canonical Sedes application icon.
It is rendered at 1024×1024 so electron-builder can produce each platform's
native sizes. Run `npm run generate:brand-assets` after editing the canonical
branding SVGs.

Supported build resources:

- `icon.icns` — macOS (or a 1024x1024 `icon.png`, converted automatically)
- `icon.ico` — Windows
- `icon.png` — Linux (512x512 or larger; 1024x1024 is committed)

See https://www.electron.build/configuration/icons for details.
