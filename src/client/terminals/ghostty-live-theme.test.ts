import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { GHOSTTY_THEMES } from "./ghostty-emulator.js";
import {
  GHOSTTY_WASM_THEME,
  installGhosttyLiveTheme,
  themeColorMap,
  type ThemedCell,
} from "./ghostty-live-theme.js";

function rgb(hex: string): [number, number, number] {
  const packed = Number.parseInt(hex.slice(1), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

function cell(foreground: string, background: string): ThemedCell {
  const [fg_r, fg_g, fg_b] = rgb(foreground);
  const [bg_r, bg_g, bg_b] = rgb(background);
  return { fg_r, fg_g, fg_b, bg_r, bg_g, bg_b };
}

const colors = (value: ThemedCell) => ({
  foreground: [value.fg_r, value.fg_g, value.fg_b],
  background: [value.bg_r, value.bg_g, value.bg_b],
});

function fakeTerminal() {
  const drawn: ThemedCell[][] = [];
  const renderer = {
    renderLine: vi.fn((cells: ThemedCell[], _y: number, _columns: number) => {
      drawn.push(cells.map((value) => ({ ...value })));
    }),
    setTheme: vi.fn(),
    render: vi.fn(),
  };
  const originalRenderLine = renderer.renderLine;
  const wasmTerm = {};
  const terminal = { renderer, wasmTerm, viewportY: 3 };
  return {
    terminal: terminal as unknown as Terminal,
    renderer,
    originalRenderLine,
    wasmTerm,
    drawn,
    // Ghostty hands renderLine fresh cell copies for every line it draws.
    draw: (...cells: ThemedCell[]) => renderer.renderLine(cells.map((value) => ({ ...value })), 0, cells.length),
  };
}

const wasm = GHOSTTY_WASM_THEME;

describe("ghostty live theme", () => {
  it("maps every sentinel role to the theme's color for that role", () => {
    const light = themeColorMap(GHOSTTY_THEMES.light);
    const packed = (hex: string) => Number.parseInt(hex.slice(1), 16);
    expect(light.get(packed(wasm.foreground!))).toEqual(rgb("#24272d"));
    expect(light.get(packed(wasm.background!))).toEqual(rgb("#f7f7f8"));
    expect(light.get(packed(wasm.green!))).toEqual(rgb("#287a42"));
    expect(light.size).toBe(18);
    // Theme colors themselves are never sentinels.
    expect(light.has(packed("#24272d"))).toBe(false);
  });

  it("keeps explicit truecolor that equals a theme color across a theme switch", () => {
    const fake = fakeTerminal();
    const live = installGhosttyLiveTheme(fake.terminal, GHOSTTY_THEMES.light);
    expect(fake.renderer.setTheme).toHaveBeenCalledWith(GHOSTTY_THEMES.light);
    const screen = [
      cell(wasm.foreground!, wasm.background!), // default colors
      cell(wasm.green!, wasm.background!), // SGR 32
      cell("#24272d", "#ffffff"), // truecolor equal to light foreground / bright white
      cell("#123456", "#654321"), // other truecolor
    ];
    fake.draw(...screen);
    expect(fake.drawn[0]!.map(colors)).toEqual([
      { foreground: rgb("#24272d"), background: rgb("#f7f7f8") },
      { foreground: rgb("#287a42"), background: rgb("#f7f7f8") },
      { foreground: rgb("#24272d"), background: rgb("#ffffff") },
      { foreground: rgb("#123456"), background: rgb("#654321") },
    ]);

    live.setTheme(GHOSTTY_THEMES.dark);
    expect(fake.renderer.setTheme).toHaveBeenLastCalledWith(GHOSTTY_THEMES.dark);
    // The whole screen is repainted at once, not only rows that change later.
    expect(fake.renderer.render).toHaveBeenCalledWith(fake.wasmTerm, true, 3, fake.terminal, 0);
    fake.draw(...screen);
    expect(fake.drawn[1]!.map(colors)).toEqual([
      { foreground: rgb("#e5e7eb"), background: rgb("#111318") },
      { foreground: rgb("#86efac"), background: rgb("#111318") },
      // Explicit colors are not theme colors, even when they match one.
      { foreground: rgb("#24272d"), background: rgb("#ffffff") },
      { foreground: rgb("#123456"), background: rgb("#654321") },
    ]);
  });

  it("restores the renderer on dispose", () => {
    const fake = fakeTerminal();
    const live = installGhosttyLiveTheme(fake.terminal, GHOSTTY_THEMES.light);
    expect(fake.renderer.renderLine).not.toBe(fake.originalRenderLine);
    live.dispose();
    expect(fake.renderer.renderLine).toBe(fake.originalRenderLine);
  });
});
