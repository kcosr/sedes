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
// - GhosttyTruecolorGuard rewrites explicit truecolor output that would equal
//   a sentinel by one blue step, so only default and palette cells can carry a
//   sentinel.
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
const SENTINEL_VALUES = new Set([...SENTINELS.values()].map((rgb) => packRgb(...rgb)));

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

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const MAX_CSI_BYTES = 512;
const encoder = new TextEncoder();

type GuardState = "ground" | "escape" | "csi" | "csi-passthrough" | "string" | "string-escape";

/**
 * Streams terminal output and keeps explicit truecolor SGR colors (38/48 with
 * `;2;` or `:2:` forms) off the sentinel palette. Everything else passes
 * through byte for byte, including OSC/DCS/APC/PM/SOS string contents. A CSI
 * split across writes is held until its final byte arrives.
 */
export class GhosttyTruecolorGuard {
  #state: GuardState = "ground";
  #csi: number[] = [];

  reset(): void {
    this.#state = "ground";
    this.#csi = [];
  }

  transform(input: Uint8Array): Uint8Array {
    if (this.#state === "ground" && !input.includes(ESC)) return input;
    const parts: Uint8Array[] = [];
    // Start of the pending pass-through run; -1 while CSI parameters are held.
    let runStart = this.#state === "csi" ? -1 : 0;
    const flushRun = (end: number) => {
      if (runStart >= 0 && end > runStart) parts.push(input.subarray(runStart, end));
    };
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      switch (this.#state) {
        case "ground":
          if (byte === ESC) this.#state = "escape";
          break;
        case "escape":
          if (byte === 0x5b) {
            flushRun(index + 1);
            runStart = -1;
            this.#csi = [];
            this.#state = "csi";
          } else if (byte === 0x5d || byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
            this.#state = "string";
          } else if (byte !== ESC) {
            this.#state = "ground";
          }
          break;
        case "string":
          if (byte === BEL || byte === CAN || byte === SUB) this.#state = "ground";
          else if (byte === ESC) this.#state = "string-escape";
          break;
        case "string-escape":
          // ESC \ ends the string; any other ESC sequence also ends it.
          this.#state = byte === 0x5c ? "ground" : "escape";
          if (byte !== 0x5c) index -= 1;
          break;
        case "csi":
          if (byte >= 0x40 && byte <= 0x7e) {
            const guarded = guardSgr(this.#csi, byte);
            parts.push(guarded === undefined ? Uint8Array.from(this.#csi) : encoder.encode(guarded));
            parts.push(input.subarray(index, index + 1));
            this.#csi = [];
            runStart = index + 1;
            this.#state = "ground";
          } else if (byte === ESC || byte === CAN || byte === SUB) {
            parts.push(Uint8Array.from(this.#csi));
            this.#csi = [];
            runStart = index;
            this.#state = byte === ESC ? "escape" : "ground";
          } else if (this.#csi.length >= MAX_CSI_BYTES) {
            parts.push(Uint8Array.from(this.#csi));
            this.#csi = [];
            runStart = index;
            this.#state = "csi-passthrough";
          } else {
            this.#csi.push(byte);
          }
          break;
        case "csi-passthrough":
          if (byte >= 0x40 && byte <= 0x7e) this.#state = "ground";
          else if (byte === ESC) this.#state = "escape";
          else if (byte === CAN || byte === SUB) this.#state = "ground";
          break;
      }
    }
    flushRun(input.length);
    if (parts.length === 1) return parts[0]!;
    const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
}

/**
 * The SGR parameters with any sentinel-valued truecolor nudged, or undefined
 * when the sequence stays as it was.
 */
function guardSgr(parameterBytes: readonly number[], finalByte: number): string | undefined {
  // Only plain SGR: digits, ';' and ':' (no private markers or intermediates).
  if (finalByte !== 0x6d || parameterBytes.some((byte) => (byte < 0x30 || byte > 0x3b))) return undefined;
  const raw = String.fromCharCode(...parameterBytes);
  const guard = (red: string, green: string, blue: string): string | undefined => {
    const channels = [red, green, blue].map((value) => (value === "" ? 0 : Number(value)));
    if (channels.some((value) => !Number.isInteger(value) || value > 255)) return undefined;
    if (!SENTINEL_VALUES.has(packRgb(channels[0]!, channels[1]!, channels[2]!))) return undefined;
    return String(channels[2]! ^ 1);
  };
  const parameters = raw.split(";");
  let changed = false;
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!;
    if (parameter.includes(":")) {
      const parts = parameter.split(":");
      if ((parts[0] !== "38" && parts[0] !== "48") || parts[1] !== "2") continue;
      // 38:2:r:g:b or 38:2:<colorspace>:r:g:b
      const blueIndex = parts.length >= 6 ? 5 : 4;
      if (parts.length < 5) continue;
      const blue = guard(parts[blueIndex - 2]!, parts[blueIndex - 1]!, parts[blueIndex]!);
      if (blue !== undefined) {
        parts[blueIndex] = blue;
        parameters[index] = parts.join(":");
        changed = true;
      }
    } else if ((parameter === "38" || parameter === "48") && parameters[index + 1] === "2") {
      if (index + 4 < parameters.length) {
        const blue = guard(parameters[index + 2]!, parameters[index + 3]!, parameters[index + 4]!);
        if (blue !== undefined) {
          parameters[index + 4] = blue;
          changed = true;
        }
      }
      index += 4;
    } else if ((parameter === "38" || parameter === "48") && parameters[index + 1] === "5") {
      index += 2;
    }
  }
  return changed ? parameters.join(";") : undefined;
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
