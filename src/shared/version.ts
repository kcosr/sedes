/**
 * The Sedes product version. `npm run version:set -- X.Y.Z` rewrites this
 * constant together with every package manifest, and `npm run check:version`
 * fails when any of them disagree. Keep it a plain string literal so bundled
 * artifacts carry the version without reading a manifest at runtime.
 */
export const SEDES_VERSION = "0.1.1";
