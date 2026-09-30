// Runs the pinned ghostty-web WASM terminal (no DOM) to prove the facts the
// live theme relies on: default and palette cells resolve to the configured
// sentinel palette, explicit truecolor and 256-color cells resolve to their
// own RGB, and the guard keeps explicit colors off the sentinels.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Ghostty, ITheme } from "ghostty-web";
import { GHOSTTY_THEMES } from "./ghostty-emulator.js";
import {
  GHOSTTY_WASM_THEME,
  GhosttyTruecolorGuard,
  applyThemeColors,
  themeColorMap,
} from "./ghostty-live-theme.js";

type GhosttyTerminalConfig = Parameters<Ghostty["createTerminal"]>[2];
type BuildWasmConfig = (this: {
  readonly options: { readonly theme: ITheme; readonly scrollback: number };
  parseColorToHex(color?: string): number;
}) => GhosttyTerminalConfig | undefined;

beforeAll(() => {
  // ghostty-web resolves its inlined WASM against the page location.
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", new URL("http://localhost/"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function wasmTerminal(columns: number) {
  const { Ghostty, Terminal } = await import("ghostty-web");
  const ghostty = await Ghostty.load();
  // The exact config path Terminal.open() uses for the emulator's theme.
  const prototype = Terminal.prototype as unknown as {
    buildWasmConfig: BuildWasmConfig;
    parseColorToHex(color?: string): number;
  };
  const config = prototype.buildWasmConfig.call({
    options: { theme: GHOSTTY_WASM_THEME, scrollback: 100 },
    parseColorToHex: prototype.parseColorToHex,
  });
  return ghostty.createTerminal(columns, 2, config);
}

const rgb = (hex: string): [number, number, number] => {
  const packed = Number.parseInt(hex.slice(1), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
};

describe("ghostty live theme with the pinned WASM terminal", () => {
  it("repaints default and palette cells and keeps explicit colors", async () => {
    const terminal = await wasmTerminal(20);
    const guard = new GhosttyTruecolorGuard();
    const [sr, sg, sb] = rgb(GHOSTTY_WASM_THEME.red!);
    const output = [
      "D",
      "\x1b[31mR",
      "\x1b[38;5;1mI",
      "\x1b[38;2;36;39;45;48;2;255;255;255mT",
      `\x1b[0m\x1b[38;2;${sr};${sg};${sb}mS`,
      "\x1b[0m\x1b[38;5;196mX",
    ].join("");
    terminal.write(guard.transform(new TextEncoder().encode(output)));
    const dark = themeColorMap(GHOSTTY_THEMES.dark);
    const cells = terminal.getLine(0)!.slice(0, 6).map((cell) => {
      applyThemeColors(cell, dark);
      return {
        text: String.fromCodePoint(cell.codepoint),
        foreground: [cell.fg_r, cell.fg_g, cell.fg_b],
        background: [cell.bg_r, cell.bg_g, cell.bg_b],
      };
    });
    const darkBackground = rgb(GHOSTTY_THEMES.dark.background!);
    expect(cells).toEqual([
      { text: "D", foreground: rgb(GHOSTTY_THEMES.dark.foreground!), background: darkBackground },
      { text: "R", foreground: rgb(GHOSTTY_THEMES.dark.red!), background: darkBackground },
      { text: "I", foreground: rgb(GHOSTTY_THEMES.dark.red!), background: darkBackground },
      // Explicit #24272d on #ffffff equals light-theme colors but stays put.
      { text: "T", foreground: [36, 39, 45], background: [255, 255, 255] },
      // Truecolor that equals a sentinel is nudged, not taken for palette red.
      { text: "S", foreground: [sr, sg, sb ^ 1], background: darkBackground },
      { text: "X", foreground: [255, 0, 0], background: darkBackground },
    ]);
    terminal.free();
  });

  it("never resolves a 256-color entry to a sentinel", async () => {
    const terminal = await wasmTerminal(240);
    const output = Array.from({ length: 240 }, (_, index) => `\x1b[38;5;${index + 16}m#`).join("");
    terminal.write(new TextEncoder().encode(output));
    const sentinels = new Set(
      Object.values(GHOSTTY_WASM_THEME).map((hex) => Number.parseInt(String(hex).slice(1), 16)),
    );
    const resolved = terminal.getLine(0)!.map((cell) => (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b);
    expect(resolved).toHaveLength(240);
    expect(resolved.filter((color) => sentinels.has(color))).toEqual([]);
    terminal.free();
  });
});
