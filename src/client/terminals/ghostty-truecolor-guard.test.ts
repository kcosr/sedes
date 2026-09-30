import { describe, expect, it } from "vitest";
import { GHOSTTY_SENTINEL_COLORS, GHOSTTY_WASM_THEME } from "./ghostty-live-theme.js";
import { GhosttyTruecolorGuard } from "./ghostty-truecolor-guard.js";

const bytes = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));
const text = (value: Uint8Array) => String.fromCharCode(...value);
const guard = () => new GhosttyTruecolorGuard(GHOSTTY_SENTINEL_COLORS);
const packed = Number.parseInt(GHOSTTY_WASM_THEME.red!.slice(1), 16);
const [r, g, b] = [packed >> 16, (packed >> 8) & 0xff, packed & 0xff];
const fix = (layer: 38 | 48) => `\x1b[${layer};2;${r};${g};${b ^ 1}m`;

describe("ghostty truecolor guard", () => {
  it("returns unchanged output as the same bytes", () => {
    for (const output of [
      "plain output\r\n",
      "\x1b[1;38;2;36;39;45;48;2;255;255;255mtext\x1b[0m",
      `\x1b[38;5;1m\x1b]8;;https://example.test/38;2;${r};${g};${b}m\x07link\x1b]8;;\x1b\\`,
      `\x1b[38;2;${r};${g};${b};39mdefault again`,
    ]) {
      const input = bytes(output);
      expect(guard().transform(input)).toBe(input);
    }
  });

  it("appends a correction after an SGR that leaves a sentinel, in every spelling Ghostty accepts", () => {
    const cases: Array<[string, string]> = [
      [`\x1b[38;2;${r};${g};${b}m`, fix(38)],
      [`\x1b[48;2;${r};${g};${b}m`, fix(48)],
      [`\x1b[038;02;00${r};${g};${b}m`, fix(38)], // leading zeros
      [`\x1b[38;2;${r};${g};${b + 256}m`, fix(38)], // channels truncate to 8 bits
      [`\x1b[38;2;${r};${g}\x08;${b}m`, fix(38)], // a C0 control executes inside the CSI
      [`\x1b[38;2;${r};${g};${b}\x7fm`, fix(38)], // DEL is ignored
      [`\x1b[38;2:${r}:${g}:${b}m`, fix(38)], // mixed separators
      [`\x1b[38:2::${r}:${g}:${b}m`, fix(38)],
      [`\x1b[38;2;9\x1b[38;2;${r};${g};${b}m`, fix(38)], // ESC restarts
      [`\x1bPq\x9b38;2;${r};${g};${b}m`, fix(38)], // C1 CSI inside a DCS
    ];
    for (const [input, correction] of cases) {
      expect(text(guard().transform(bytes(`${input}x`))), JSON.stringify(input)).toBe(`${input}${correction}x`);
    }
    // Both colors in one SGR get one correction.
    expect(text(guard().transform(bytes(`\x1b[38;2;${r};${g};${b};48;2;${r};${g};${b}m`))))
      .toBe(`\x1b[38;2;${r};${g};${b};48;2;${r};${g};${b}m\x1b[38;2;${r};${g};${b ^ 1};48;2;${r};${g};${b ^ 1}m`);
  });

  it("leaves sequences Ghostty does not apply alone", () => {
    for (const output of [
      `\x1b[38:2;${r};${g};${b}m`, // colon then semicolons is not a direct color
      `\x1b[>38;2;${r};${g};${b}m`, // private marker
      `\x1b[38;2;${r};${g};${b} m`, // intermediate
      `\x1b[38;2;${r}\x18;${g};${b}m`, // CAN aborts the CSI
      `\x1b[${"1;".repeat(20)}38;2;${r};${g};${b}m`, // 24 separators: dropped
      `\x1b([38;2;${r};${g};${b}m`, // '[' ends ESC ( here
      `\xc2\x9b38;2;${r};${g};${b}m`, // C1 is text in the UTF-8 ground state
      `\x1b]0;a\x9b38;2;${r};${g};${b}m`, // and inside OSC strings
    ]) {
      const input = bytes(output);
      expect(guard().transform(input), JSON.stringify(output)).toBe(input);
    }
  });

  it("carries parser state across writes", () => {
    const stream = `ok \x1b[38;2;${r};${g};${b}mred\x1bP1;2\x9b48;2;${r};${g};${b}m é \x1b[0m`;
    const expected = text(guard().transform(bytes(stream)));
    expect(expected).toContain(`m${fix(38)}red`);
    expect(expected).toContain(`m${fix(48)} é`);
    const input = bytes(stream);
    for (let split = 0; split <= input.length; split += 1) {
      const current = guard();
      const output = [...current.transform(input.subarray(0, split)), ...current.transform(input.subarray(split))];
      expect(String.fromCharCode(...output), `split at ${split}`).toBe(expected);
    }
  });

  it("scans a large escape-heavy checkpoint without copying it", () => {
    // Benchmark note: about 60 ms for 8 MiB on the reference host; the bound
    // below only catches a gross regression under a loaded test run.
    const unit = bytes("\x1b[1;38;2;36;39;45;48;2;255;255;255mx\x1b[38:2::12:34:56m\x1b[0;4:3my\x1b[m ");
    const input = new Uint8Array(8 * 1024 * 1024);
    for (let offset = 0; offset + unit.length <= input.length; offset += unit.length) input.set(unit, offset);
    const started = performance.now();
    const output = guard().transform(input);
    const elapsed = performance.now() - started;
    expect(output).toBe(input);
    expect(elapsed).toBeLessThan(1_000);
  });
});
