import type { ITheme, Terminal } from "ghostty-web";

// Compatibility adapter for the pinned ghostty-web 0.4.0. Re-audit the
// private renderer members below when upgrading. Do not patch the bundle.
//
// Ghostty resolves the default foreground/background and the 16 ANSI palette
// entries into every cell's RGB when its WASM terminal is created, and
// ghostty-web ignores `options.theme` after open(). Rebuilding the terminal
// would discard its screen until the server replays a checkpoint, so a live
// theme switch recolors at draw time instead: a cell color equal to a
// creation-theme entry is drawn with the current theme's entry. Extended
// (16-255) and truecolor cells keep their own colors, unless one happens to
// equal a theme entry exactly.

const PALETTE_KEYS = [
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

export interface ThemedCell {
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
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

function parseHexColor(value: string | undefined): Rgb | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value ?? "");
  if (!match) return undefined;
  const hex = match[1]!.length === 3
    ? [...match[1]!].map((digit) => digit + digit).join("")
    : match[1]!;
  const packed = Number.parseInt(hex, 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

const packRgb = (red: number, green: number, blue: number) =>
  (red << 16) | (green << 8) | blue;

/** Maps each creation-theme color to the current theme's color for that role. */
export function themeColorRemap(
  created: ITheme,
  current: ITheme,
): ReadonlyMap<number, Rgb> {
  const remap = new Map<number, Rgb>();
  for (const key of PALETTE_KEYS) {
    const from = parseHexColor(created[key]);
    const to = parseHexColor(current[key]);
    if (!from || !to) continue;
    const packed = packRgb(...from);
    // The first role wins when a theme reuses one color for two roles.
    if (!remap.has(packed)) remap.set(packed, to);
  }
  for (const [packed, to] of remap) {
    if (packRgb(...to) === packed) remap.delete(packed);
  }
  return remap;
}

function remapCellColors(
  cell: ThemedCell,
  remap: ReadonlyMap<number, Rgb>,
): void {
  const foreground = remap.get(packRgb(cell.fg_r, cell.fg_g, cell.fg_b));
  if (foreground) [cell.fg_r, cell.fg_g, cell.fg_b] = foreground;
  const background = remap.get(packRgb(cell.bg_r, cell.bg_g, cell.bg_b));
  if (background) [cell.bg_r, cell.bg_g, cell.bg_b] = background;
}

export interface GhosttyLiveTheme {
  setTheme(theme: ITheme): void;
  dispose(): void;
}

/**
 * Lets an open Ghostty terminal follow theme changes. `created` must be the
 * theme the terminal was constructed with.
 */
export function installGhosttyLiveTheme(
  instance: Terminal,
  created: ITheme,
): GhosttyLiveTheme {
  const terminal = instance as unknown as LiveThemeTerminal;
  const renderer = terminal.renderer;
  if (!renderer) return { setTheme() {}, dispose() {} };
  let remap: ReadonlyMap<number, Rgb> = new Map();
  const originalRenderLine = renderer.renderLine;
  // Ghostty copies cells per line before rendering, so they can be recolored
  // in place without touching terminal state.
  renderer.renderLine = function (cells, y, columns) {
    if (remap.size > 0) for (const cell of cells) remapCellColors(cell, remap);
    return originalRenderLine.call(this, cells, y, columns);
  };
  return {
    setTheme(theme: ITheme): void {
      remap = themeColorRemap(created, theme);
      renderer.setTheme(theme);
      if (terminal.wasmTerm) {
        renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, 0);
      }
    },
    dispose(): void {
      renderer.renderLine = originalRenderLine;
      remap = new Map();
    },
  };
}
