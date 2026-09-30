// Runs the pinned ghostty-web WASM terminal (no DOM) to prove the facts the
// live theme relies on: default and palette cells resolve to the configured
// sentinel palette, explicit truecolor and 256-color cells resolve to their
// own RGB, and the truecolor guard keeps every explicit color off the
// sentinels without changing anything else. Re-run when upgrading ghostty-web.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Ghostty, GhosttyCell, GhosttyTerminal, ITheme } from "ghostty-web";
import { GHOSTTY_THEMES } from "./ghostty-emulator.js";
import {
  GHOSTTY_SENTINEL_COLORS,
  GHOSTTY_WASM_THEME,
  applyThemeColors,
  themeColorMap,
} from "./ghostty-live-theme.js";
import { GhosttyTruecolorGuard } from "./ghostty-truecolor-guard.js";

type GhosttyTerminalConfig = Parameters<Ghostty["createTerminal"]>[2];
type BuildWasmConfig = (this: {
  readonly options: { readonly theme: ITheme; readonly scrollback: number };
  parseColorToHex(color?: string): number;
}) => GhosttyTerminalConfig | undefined;

const CLEAR = "\x1bc\x1b[3J\x1b[2J\x1b[H";
let ghostty: Ghostty;
let buildConfig: (theme: ITheme) => GhosttyTerminalConfig;

beforeAll(async () => {
  // ghostty-web resolves its inlined WASM against the page location.
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", new URL("http://localhost/"));
  const module = await import("ghostty-web");
  ghostty = await module.Ghostty.load();
  // The exact config path Terminal.open() uses for the emulator's theme.
  const prototype = module.Terminal.prototype as unknown as {
    buildWasmConfig: BuildWasmConfig;
    parseColorToHex(color?: string): number;
  };
  buildConfig = (theme) =>
    prototype.buildWasmConfig.call({
      options: { theme, scrollback: 100 },
      parseColorToHex: prototype.parseColorToHex,
    });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const bytes = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));
const rgb = (hex: string): [number, number, number] => {
  const packed = Number.parseInt(hex.slice(1), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
};
const packCell = (red: number, green: number, blue: number) => (red << 16) | (green << 8) | blue;
const guarded = (text: string) => new GhosttyTruecolorGuard(GHOSTTY_SENTINEL_COLORS).transform(bytes(text));

function screen(terminal: GhosttyTerminal, rows: number): GhosttyCell[] {
  return Array.from({ length: rows }, (_, row) => terminal.getLine(row) ?? []).flat();
}

function firstCell(input: Uint8Array): GhosttyCell {
  const terminal = ghostty.createTerminal(40, 2, buildConfig(GHOSTTY_WASM_THEME));
  terminal.write(bytes(CLEAR));
  terminal.write(input);
  const cell = terminal.getLine(0)![0]!;
  terminal.free();
  return cell;
}

describe("ghostty live theme with the pinned WASM terminal", () => {
  const [sr, sg, sb] = rgb(GHOSTTY_WASM_THEME.red!);

  it("repaints default and palette cells and keeps explicit colors", () => {
    const terminal = ghostty.createTerminal(20, 2, buildConfig(GHOSTTY_WASM_THEME));
    terminal.write(bytes(CLEAR));
    terminal.write(guarded([
      "D",
      "\x1b[31mR",
      "\x1b[38;5;1mI",
      "\x1b[38;2;36;39;45;48;2;255;255;255mT",
      `\x1b[0m\x1b[38;2;${sr};${sg};${sb}mS`,
      "\x1b[0m\x1b[38;5;196mX",
    ].join("")));
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

  it("guards every spelling of a sentinel that Ghostty parses", () => {
    const sentinel = [sr, sg, sb];
    const nudged = [sr, sg, sb ^ 1];
    for (const spelling of [
      `\x1b[038;2;${sr};${sg};${sb}m`, // leading zeros
      `\x1b[38;02;${sr};${sg};${sb}m`,
      `\x1b[38;2;${sr};${sg};${sb + 256}m`, // 8-bit channel truncation
      `\x1b[38;2;${sr};${sg};${sb + 65280}m`,
      `\x1b[38;2;${sr};${sg}\x08;${sb}m`, // C0 executed inside the CSI
      `\x1b[38;2;${sr};${sg};${sb}\x7fm`, // DEL ignored
      `\x1b[38;2;${sr};${sg};${sb}\xe9m`, // GR byte ignored
      `\x1b[38;2:${sr}:${sg}:${sb}m`, // mixed separators
      `\x1b[38:2::${sr}:${sg}:${sb}m`,
      `\x1b[${"1;".repeat(19)}38;2;${sr};${sg};${sb}m`, // 24 parameters, still applied
      `\x1b[38;2;9\x1b[38;2;${sr};${sg};${sb}m`, // ESC restarts
      `\x1b[38;2;9\x9b38;2;${sr};${sg};${sb}m`, // C1 CSI restarts
      `\x1b_Gq\x9b38;2;${sr};${sg};${sb}m`, // C1 CSI inside APC
    ]) {
      const cell = (input: Uint8Array) => { const value = firstCell(input); return [value.fg_r, value.fg_g, value.fg_b]; };
      expect(cell(bytes(`${spelling}x`)), `unguarded ${JSON.stringify(spelling)}`).toEqual(sentinel);
      expect(cell(guarded(`${spelling}x`)), `guarded ${JSON.stringify(spelling)}`).toEqual(nudged);
    }
  });

  it("never resolves a 256-color entry to a sentinel", () => {
    const terminal = ghostty.createTerminal(240, 2, buildConfig(GHOSTTY_WASM_THEME));
    terminal.write(bytes(CLEAR));
    terminal.write(bytes(Array.from({ length: 240 }, (_, index) => `\x1b[38;5;${index + 16}m#`).join("")));
    const resolved = terminal.getLine(0)!.map((cell) => packCell(cell.fg_r, cell.fg_g, cell.fg_b));
    expect(resolved).toHaveLength(240);
    expect(resolved.filter((color) => GHOSTTY_SENTINEL_COLORS.has(color))).toEqual([]);
    terminal.free();
  });

  it("does not let programs repaint the palette (OSC 4, 10, 11)", () => {
    // If an upgrade adds these, sentinels could appear on explicit output:
    // re-audit the live theme and the guard.
    const cell = firstCell(bytes("\x1b]4;1;rgb:12/34/56\x07\x1b]10;rgb:12/34/56\x07\x1b[31mx"));
    expect(packCell(cell.fg_r, cell.fg_g, cell.fg_b)).toBe(Number.parseInt(GHOSTTY_WASM_THEME.red!.slice(1), 16));
  });

  it("matches the WASM parser on fuzzed output (differential)", { timeout: 30_000 }, () => {
    const random = mulberry32(0x5eed);
    const columns = 64;
    const rows = 6;
    // Palette B differs from the sentinels in every role: a cell color that is
    // the same under both palettes did not come from the palette.
    const paletteB = Object.fromEntries(
      Object.entries(GHOSTTY_WASM_THEME).map(([role, hex], index) => [role, `#c864${(0x10 + 2 * index).toString(16)}`]),
    );
    const rawA = ghostty.createTerminal(columns, rows, buildConfig(GHOSTTY_WASM_THEME));
    const rawB = ghostty.createTerminal(columns, rows, buildConfig(paletteB));
    const guardedA = ghostty.createTerminal(columns, rows, buildConfig(GHOSTTY_WASM_THEME));
    // Ghostty logs every malformed sequence the fuzzer produces.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mismatches: string[] = [];
    let corrected = 0;
    for (let round = 0; round < 1500; round += 1) {
      const input = bytes(CLEAR + fuzzedOutput(random));
      rawA.write(input);
      rawB.write(input);
      const guard = new GhosttyTruecolorGuard(GHOSTTY_SENTINEL_COLORS);
      for (let offset = 0; offset < input.length;) {
        const size = 1 + Math.floor(random() * 24);
        guardedA.write(guard.transform(input.subarray(offset, offset + size)));
        offset += size;
      }
      const [a, b, g] = [screen(rawA, rows), screen(rawB, rows), screen(guardedA, rows)];
      for (let index = 0; index < a.length && mismatches.length < 5; index += 1) {
        const [cellA, cellB, cellG] = [a[index]!, b[index]!, g[index]!];
        const colors = [
          [packCell(cellA.fg_r, cellA.fg_g, cellA.fg_b), packCell(cellB.fg_r, cellB.fg_g, cellB.fg_b), packCell(cellG.fg_r, cellG.fg_g, cellG.fg_b)],
          [packCell(cellA.bg_r, cellA.bg_g, cellA.bg_b), packCell(cellB.bg_r, cellB.bg_g, cellB.bg_b), packCell(cellG.bg_r, cellG.bg_g, cellG.bg_b)],
        ] as const;
        const wrong = cellG.codepoint !== cellA.codepoint || cellG.flags !== cellA.flags || colors.some(([raw, other, guardedColor]) => {
          const explicitSentinel = raw === other && GHOSTTY_SENTINEL_COLORS.has(raw);
          if (explicitSentinel) corrected += 1;
          return guardedColor !== (explicitSentinel ? raw ^ 1 : raw);
        });
        if (wrong) {
          mismatches.push(`round ${round} cell ${index} ${JSON.stringify(colors)}: ${JSON.stringify(String.fromCharCode(...input))}`);
        }
      }
    }
    log.mockRestore();
    for (const terminal of [rawA, rawB, guardedA]) terminal.free();
    expect(mismatches).toEqual([]);
    // The fuzzer must actually produce explicit sentinels to be meaningful.
    expect(corrected).toBeGreaterThan(200);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Terminal output mixing SGRs in every spelling with controls, strings and text. */
function fuzzedOutput(random: () => number): string {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const sentinels = [...GHOSTTY_SENTINEL_COLORS];
  const noise = () => String.fromCharCode(pick([0x07, 0x08, 0x0d, 0x18, 0x1a, 0x1b, 0x7f, 0x9b, 0x98, 0x90, 0x9c, 0x9d, 0x88, 0xa0, 0xc3, 0xe9, 0xff]));
  const spell = (value: number) => (random() < 0.15 ? "0".repeat(1 + Math.floor(random() * 2)) : "") + value;
  const channel = (value: number) => {
    const roll = random();
    // Wider than 8 bits: Ghostty truncates; wider than 16 bits: it saturates first.
    if (roll < 0.1) return spell(value + 256 * (1 + Math.floor(random() * 3)));
    if (roll < 0.18) return spell(value + 65536 * (1 + Math.floor(random() * 3)));
    return spell(value);
  };
  const directColor = () => {
    const layer = pick([38, 48, 48, 38, 58]);
    const color = random() < 0.7 ? pick(sentinels) : Math.floor(random() * 0x1000000);
    const [red, green, blue] = [color >> 16, (color >> 8) & 255, color & 255].map(channel);
    switch (pick(["semicolon", "semicolon", "colon", "colon-space", "mixed"])) {
      case "colon": return `${layer}:2:${red}:${green}:${blue}`;
      case "colon-space": return `${layer}:2::${red}:${green}:${blue}`;
      case "mixed": return [layer, 2, red, green, blue].map(String).join("").length > 0
        ? `${layer}${pick([";", ":"])}2${pick([";", ":"])}${red}${pick([";", ":"])}${green}${pick([";", ":"])}${blue}`
        : "";
      default: return `${layer};2;${red};${green};${blue}`;
    }
  };
  const sgr = (introducer = random() < 0.9 ? "\x1b[" : "\x9b") => {
    const params: string[] = [];
    const extra = () => spell(pick([0, 1, 2, 3, 4, 5, 22, 39, 49, 31, 41, 91, 101, 38, 48, 7, 27, Math.floor(random() * 300), 65535, 99999]));
    for (let count = Math.floor(random() * 3); count > 0; count -= 1) params.push(extra());
    if (random() < 0.8) params.push(directColor());
    if (random() < 0.3) params.push(`${pick([38, 48])}${pick([";", ":"])}5${pick([";", ":"])}${Math.floor(random() * 256)}`);
    for (let count = Math.floor(random() * 3); count > 0; count -= 1) params.push(extra());
    if (random() < 0.08) for (let count = 18 + Math.floor(random() * 10); count > 0; count -= 1) params.unshift("1");
    let body = params.join(random() < 0.85 ? ";" : pick([":", ";;"]));
    if (random() < 0.15) {
      const at = Math.floor(random() * (body.length + 1));
      body = body.slice(0, at) + noise() + body.slice(at);
    }
    if (random() < 0.08) body += pick([":", ";"]); // trailing separator
    const marker = random() < 0.05 ? pick(["?", ">", "<", "="]) : "";
    const intermediate = random() < 0.05 ? pick([" ", "$", "!"]) : "";
    const final = random() < 0.92 ? "m" : pick(["H", "J", "K", "@", "~"]);
    return `${introducer}${marker}${body}${intermediate}${final}${pick(["x", "y", "z", "  "])}`;
  };
  // Strings, including ones opened by a C1 byte where C1 is live (after ESC
  // or inside a CSI); inside DCS/SOS/PM/APC a C1 CSI (0x9b) starts an SGR.
  const string = () => {
    const opener = pick(["\x1b]0;", "\x1bP", "\x1b_G", "\x1bX", "\x1b^", "\x9d0;", "\x90q", "\x1b\x90q", "\x1b\x98", "\x1b[1\x9e", "\x1b(\x9f", "\x1b\x9d0;"]);
    const content = random() < 0.6 ? sgr(random() < 0.6 ? "\x9b" : "\x1b[") : "abc";
    return `${opener}${content}${pick(["\x07", "\x1b\\", "\x9c", "\x18", ""])}`;
  };
  const parts: string[] = [];
  for (let count = 4 + Math.floor(random() * 10); count > 0; count -= 1) {
    const kind = random();
    if (kind < 0.6) parts.push(sgr());
    else if (kind < 0.72) parts.push(string());
    else if (kind < 0.82) parts.push(noise());
    else if (kind < 0.9) parts.push(`\x1b${pick(["(", "#", "7", "8", "(B", "[", " "])}`);
    else parts.push(pick(["text ", "é", "\xc2\x9b", "\r\n"]));
  }
  return parts.join("");
}
