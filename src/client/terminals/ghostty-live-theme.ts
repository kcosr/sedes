import type { ITheme, Terminal } from "ghostty-web";

// Compatibility adapter for the pinned ghostty-web 0.4.0. Re-audit the
// private renderer members below and the WASM color behavior (see
// ghostty-live-theme.wasm.test.ts) when upgrading. Do not patch the bundle.
//
// Ghostty resolves every cell to plain RGB: default and 16-color palette cells
// get the colors the WASM terminal was created with, and ghostty-web ignores
// theme changes after open(). The cell data has no provenance, so the adapter
// creates it:
//
// - The WASM terminal is always created with GHOSTTY_WASM_THEME, a palette of
//   reserved sentinel colors, one per theme role.
// - GhosttyTruecolorGuard (ghostty-truecolor-guard.ts) corrects explicit
//   truecolor output that would equal a sentinel by one blue step, so only
//   default and palette cells can carry a sentinel.
// - At draw time each sentinel is painted with the current theme's color for
//   its role. Explicit truecolor and 256-color cells keep their own colors, and
//   a theme switch is a repaint rather than a new terminal and session.

const THEME_ROLES = [
  "foreground",
  "background",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

type Rgb = readonly [number, number, number];

const packRgb = (red: number, green: number, blue: number) =>
  (red << 16) | (green << 8) | blue;

/**
 * rgb(1, 3, 16 + 2i) for role i. Off the xterm 256-color cube and gray ramp,
 * never black (the renderer's "no background"), and all even in blue, so a
 * guarded truecolor value (blue ^ 1) can never land on another sentinel.
 */
const SENTINELS: ReadonlyMap<(typeof THEME_ROLES)[number], Rgb> = new Map(
  THEME_ROLES.map((role, index) => [role, [1, 3, 16 + 2 * index] as const]),
);
/** Every sentinel as packed RGB, for GhosttyTruecolorGuard. */
export const GHOSTTY_SENTINEL_COLORS: ReadonlySet<number> = new Set(
  [...SENTINELS.values()].map((rgb) => packRgb(...rgb)),
);

const toHex = ([red, green, blue]: Rgb) =>
  `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** The theme every Ghostty WASM terminal is created with. Never shown. */
export const GHOSTTY_WASM_THEME: Readonly<ITheme> = Object.freeze(
  Object.fromEntries([...SENTINELS].map(([role, rgb]) => [role, toHex(rgb)])),
);

function parseHexColor(value: string | undefined): Rgb | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value ?? "");
  if (!match) return undefined;
  const hex = match[1]!.length === 3
    ? [...match[1]!].map((digit) => digit + digit).join("")
    : match[1]!;
  const packed = Number.parseInt(hex, 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

/** Sentinel color -> the theme's color for the same role. */
export function themeColorMap(theme: ITheme): ReadonlyMap<number, Rgb> {
  const map = new Map<number, Rgb>();
  for (const [role, sentinel] of SENTINELS) {
    const color = parseHexColor(theme[role]) ?? parseHexColor(theme.foreground);
    if (color) map.set(packRgb(...sentinel), color);
  }
  return map;
}

export interface ThemedCell {
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
}

export function applyThemeColors(cell: ThemedCell, map: ReadonlyMap<number, Rgb>): void {
  const foreground = map.get(packRgb(cell.fg_r, cell.fg_g, cell.fg_b));
  if (foreground) [cell.fg_r, cell.fg_g, cell.fg_b] = foreground;
  const background = map.get(packRgb(cell.bg_r, cell.bg_g, cell.bg_b));
  if (background) [cell.bg_r, cell.bg_g, cell.bg_b] = background;
}

interface LiveThemeRenderer {
  setTheme(theme: ITheme): void;
  renderLine(cells: ThemedCell[], y: number, columns: number): void;
  render(
    buffer: unknown,
    forceAll: boolean,
    viewportY: number,
    scrollbackProvider: unknown,
    scrollbarOpacity: number,
  ): void;
}

interface LiveThemeTerminal {
  readonly renderer?: LiveThemeRenderer;
  readonly wasmTerm?: unknown;
  readonly viewportY: number;
}

export interface GhosttyLiveTheme {
  setTheme(theme: ITheme): void;
  dispose(): void;
}

/**
 * Paints a Ghostty terminal created with GHOSTTY_WASM_THEME in `theme`, and
 * lets it follow later theme changes.
 */
export function installGhosttyLiveTheme(instance: Terminal, theme: ITheme): GhosttyLiveTheme {
  const terminal = instance as unknown as LiveThemeTerminal;
  const renderer = terminal.renderer;
  if (!renderer) return { setTheme() {}, dispose() {} };
  let map = themeColorMap(theme);
  renderer.setTheme(theme);
  const originalRenderLine = renderer.renderLine;
  // Ghostty copies cells per line before rendering, so they can be recolored
  // in place without touching terminal state.
  renderer.renderLine = function (cells, y, columns) {
    for (const cell of cells) applyThemeColors(cell, map);
    return originalRenderLine.call(this, cells, y, columns);
  };
  return {
    setTheme(next: ITheme): void {
      map = themeColorMap(next);
      renderer.setTheme(next);
      if (terminal.wasmTerm) {
        renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, 0);
      }
    },
    dispose(): void {
      renderer.renderLine = originalRenderLine;
    },
  };
}
