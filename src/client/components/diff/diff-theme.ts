/**
 * The one look every Pierre surface shares (the Changes diff, the Browse file
 * viewer and chat file-change diffs). Import this module only from lazy
 * chunks: it loads `@pierre/diffs`.
 *
 * - Syntax colours are CSS variables: the theme pair below reads the same
 *   `--syntax-*` palette as chat Markdown code blocks, so a light/dark switch
 *   needs no re-highlighting and code looks the same everywhere.
 * - `.sedes-diff-surface` (styles.css) sets Pierre's `--diffs-*` knobs from
 *   Sedes tokens; `pierre-unsafe.css` covers what variables cannot reach.
 * - The metrics below must match those stylesheets: a virtualized CodeView
 *   positions rows from them instead of measuring.
 */
import {
  createCSSVariablesTheme,
  registerCustomTheme,
  type ThemeRegistration,
} from "@pierre/diffs";
import unsafeCSS from "./pierre-unsafe.css?inline";

export const SEDES_DIFF_THEMES = Object.freeze({
  light: "sedes-light",
  dark: "sedes-dark",
} as const);

/** Pierre's `unsafeCSS`, injected into every Pierre shadow root. */
export const SEDES_PIERRE_UNSAFE_CSS: string = unsafeCSS;

/** `--diffs-line-height` in `.sedes-diff-surface`. */
export const SEDES_DIFF_LINE_HEIGHT = 18;
/** Hunk separator band, fine pointers (pierre-unsafe.css). */
export const SEDES_DIFF_SEPARATOR_HEIGHT = 24;
/** Hunk separator band on coarse pointers (`--sedes-diff-touch`). */
export const SEDES_DIFF_TOUCH_SEPARATOR_HEIGHT = 40;

let registered = false;

/** Registers the light and dark syntax themes once; Pierre resolves them by name. */
export function registerSedesDiffThemes(): void {
  if (registered) return;
  registered = true;
  for (const type of ["light", "dark"] as const) {
    const base = createCSSVariablesTheme({
      name: SEDES_DIFF_THEMES[type],
      variablePrefix: "--syntax-",
      fontStyle: false,
    });
    const theme: ThemeRegistration = {
      ...base,
      type,
      // Pierre derives its added/deleted/modified colours from these.
      colors: {
        ...base.colors,
        "gitDecoration.addedResourceForeground": "var(--success)",
        "gitDecoration.deletedResourceForeground": "var(--destructive)",
        "gitDecoration.modifiedResourceForeground": "var(--info)",
      },
    };
    registerCustomTheme(SEDES_DIFF_THEMES[type], () => Promise.resolve(theme));
  }
}

registerSedesDiffThemes();
