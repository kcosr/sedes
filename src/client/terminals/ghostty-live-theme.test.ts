import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { GHOSTTY_THEMES } from "./ghostty-emulator.js";
import {
  GHOSTTY_WASM_THEME,
  GhosttyTruecolorGuard,
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

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
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

describe("ghostty truecolor guard", () => {
  const [sr, sg, sb] = rgb(wasm.red!);

  it("passes output without escapes through untouched", () => {
    const guard = new GhosttyTruecolorGuard();
    const input = bytes("plain output\r\n");
    expect(guard.transform(input)).toBe(input);
  });

  it("nudges only truecolor that equals a sentinel, in every SGR form", () => {
    const guard = new GhosttyTruecolorGuard();
    const nudged = String(sb ^ 1);
    expect(text(guard.transform(bytes(`a\x1b[1;38;2;${sr};${sg};${sb};48;2;1;2;3mb`))))
      .toBe(`a\x1b[1;38;2;${sr};${sg};${nudged};48;2;1;2;3mb`);
    expect(text(guard.transform(bytes(`\x1b[48;2;${sr};${sg};${sb}m`)))).toBe(`\x1b[48;2;${sr};${sg};${nudged}m`);
    expect(text(guard.transform(bytes(`\x1b[38:2::${sr}:${sg}:${sb}m`)))).toBe(`\x1b[38:2::${sr}:${sg}:${nudged}m`);
    expect(text(guard.transform(bytes(`\x1b[38:2:${sr}:${sg}:${sb}m`)))).toBe(`\x1b[38:2:${sr}:${sg}:${nudged}m`);
    for (const untouched of [
      "\x1b[38;2;36;39;45;48;2;255;255;255m",
      `\x1b[38;5;${sb}m`,
      `\x1b[38;5;1;38;2;${sr};${sg};${sb + 1}m`,
      `\x1b[>4;2m\x1b[${sr};${sg};${sb}H`,
      `\x1b]8;;https://example.test/38;2;${sr};${sg};${sb}m\x07link\x1b]8;;\x1b\\`,
      `\x1bP1;38;2;${sr};${sg};${sb}m\x1b\\`,
    ]) {
      expect(text(guard.transform(bytes(untouched)))).toBe(untouched);
    }
  });

  it("handles sequences split across writes at any point", () => {
    const stream = `ok \x1b[38;2;${sr};${sg};${sb}mred\x1b]0;title 38;2;${sr};${sg};${sb}m\x07 é \x1b[0m`;
    const expected = text(new GhosttyTruecolorGuard().transform(bytes(stream)));
    expect(expected).toContain(`38;2;${sr};${sg};${sb ^ 1}m`);
    expect(expected).toContain(`title 38;2;${sr};${sg};${sb}m`);
    const input = bytes(stream);
    for (let split = 0; split <= input.length; split += 1) {
      const guard = new GhosttyTruecolorGuard();
      const first = guard.transform(input.subarray(0, split));
      const second = guard.transform(input.subarray(split));
      expect(text(Uint8Array.from([...first, ...second])), `split at ${split}`).toBe(expected);
    }
  });

  it("drops a held partial sequence on reset", () => {
    const guard = new GhosttyTruecolorGuard();
    expect(text(guard.transform(bytes("before\x1b[38;2")))).toBe("before\x1b[");
    guard.reset();
    expect(text(guard.transform(bytes("after")))).toBe("after");
  });
});
