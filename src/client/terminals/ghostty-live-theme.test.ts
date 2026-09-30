import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { GHOSTTY_THEMES } from "./ghostty-emulator.js";
import {
  installGhosttyLiveTheme,
  themeColorRemap,
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
    draw: (...cells: ThemedCell[]) => renderer.renderLine(cells, 0, cells.length),
  };
}

describe("ghostty live theme", () => {
  it("maps every themed role from the creation theme to the current theme", () => {
    const remap = themeColorRemap(GHOSTTY_THEMES.light, GHOSTTY_THEMES.dark);
    expect(remap.get(Number.parseInt("24272d", 16))).toEqual(rgb("#e5e7eb"));
    expect(remap.get(Number.parseInt("f7f7f8", 16))).toEqual(rgb("#111318"));
    expect(remap.get(Number.parseInt("287a42", 16))).toEqual(rgb("#86efac"));
    // Both themes use the same bright black, so it needs no mapping.
    expect(remap.has(Number.parseInt("6b7280", 16))).toBe(false);
    expect(themeColorRemap(GHOSTTY_THEMES.dark, GHOSTTY_THEMES.dark).size).toBe(0);
  });

  it("draws text written under the old theme with the new theme's colors", () => {
    const fake = fakeTerminal();
    const live = installGhosttyLiveTheme(fake.terminal, GHOSTTY_THEMES.light);
    fake.draw(cell("#24272d", "#f7f7f8"), cell("#287a42", "#f7f7f8"));
    expect(colors(fake.drawn[0]![0]!)).toEqual({
      foreground: rgb("#24272d"),
      background: rgb("#f7f7f8"),
    });

    live.setTheme(GHOSTTY_THEMES.dark);
    expect(fake.renderer.setTheme).toHaveBeenCalledWith(GHOSTTY_THEMES.dark);
    // The whole screen is repainted at once, not only rows that change later.
    expect(fake.renderer.render).toHaveBeenCalledWith(fake.wasmTerm, true, 3, fake.terminal, 0);

    fake.draw(
      cell("#24272d", "#f7f7f8"),
      cell("#287a42", "#f7f7f8"),
      cell("#123456", "#654321"),
    );
    expect(fake.drawn[1]!.map(colors)).toEqual([
      { foreground: rgb("#e5e7eb"), background: rgb("#111318") },
      { foreground: rgb("#86efac"), background: rgb("#111318") },
      // Truecolor output keeps the color the program asked for.
      { foreground: rgb("#123456"), background: rgb("#654321") },
    ]);

    live.setTheme(GHOSTTY_THEMES.light);
    fake.draw(cell("#24272d", "#f7f7f8"));
    expect(colors(fake.drawn[2]![0]!)).toEqual({
      foreground: rgb("#24272d"),
      background: rgb("#f7f7f8"),
    });
  });

  it("restores the renderer on dispose", () => {
    const fake = fakeTerminal();
    const live = installGhosttyLiveTheme(fake.terminal, GHOSTTY_THEMES.light);
    expect(fake.renderer.renderLine).not.toBe(fake.originalRenderLine);
    live.dispose();
    expect(fake.renderer.renderLine).toBe(fake.originalRenderLine);
  });
});
