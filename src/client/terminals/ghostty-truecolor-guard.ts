// Keeps explicit truecolor output off the sentinel palette the live theme
// uses to recognize default and palette cells (see ghostty-live-theme.ts).
//
// The guard mirrors the pinned Ghostty (ghostty-web 0.4.0) VT parser for
// everything that decides the colors an SGR leaves in the pen: a DEC-style
// state machine with Ghostty's byte classes (C0 controls execute inside a
// sequence, CAN/SUB abort, ESC restarts, DEL and 0xA0-0xFF are ignored, 8-bit
// C1 controls act outside ground and OSC), 16-bit saturating parameters with
// at most 24 per sequence, colon sub-parameters, and Ghostty's SGR walk with
// 8-bit truncated channels. When an SGR leaves the foreground or background at
// a sentinel, the guard appends an SGR that sets the same color with blue ^ 1.
// Nothing is buffered or rewritten: input is returned as is (zero copy) unless
// a correction is appended. ghostty-live-theme.wasm.test.ts checks the model
// differentially against the WASM terminal; re-run it when upgrading.

const GROUND = 0; // also OSC strings: only ESC leaves them
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTERMEDIATE = 5;
const CSI_IGNORE = 6;
const STRING = 7; // DCS, SOS, PM and APC, where C1 controls still act

const ESC = 0x1b;
const MAX_PARAMS = 24;
const UNCHANGED = 0;
const RESET = 1; // default or palette color
const DIRECT = 2;

export class GhosttyTruecolorGuard {
  readonly #sentinels: ReadonlySet<number>;
  readonly #params = new Uint16Array(MAX_PARAMS);
  /** #colons[i] is 1 when a ':' followed #params[i]. */
  readonly #colons = new Uint8Array(MAX_PARAMS);
  /** Encoded corrections by (foreground, background) sentinel pair. */
  readonly #corrections = new Map<number, Uint8Array>();
  #state = GROUND;
  #count = 0;
  #accumulator = 0;
  #digits = false;
  #intermediates = 0;
  // Pen colors an SGR leaves: kind (UNCHANGED/RESET/DIRECT) and packed RGB.
  #foreground = UNCHANGED;
  #foregroundRgb = 0;
  #background = UNCHANGED;
  #backgroundRgb = 0;

  constructor(sentinels: ReadonlySet<number>) {
    this.#sentinels = sentinels;
  }

  reset(): void {
    this.#state = GROUND;
  }

  transform(input: Uint8Array): Uint8Array {
    let positions: number[] | undefined;
    let corrections: Uint8Array[] | undefined;
    let state = this.#state;
    // The parameter hot path works on locals; #dispatch reads the fields.
    const params = this.#params;
    const colons = this.#colons;
    let count = this.#count;
    let accumulator = this.#accumulator;
    let digits = this.#digits;
    let index = 0;
    while (index < input.length) {
      if (state === GROUND) {
        const escape = input.indexOf(ESC, index);
        if (escape < 0) break;
        state = ESCAPE;
        index = escape + 1;
        continue;
      }
      const byte = input[index++]!;
      if ((state === CSI_PARAM || state === CSI_ENTRY) && byte >= 0x30 && byte <= 0x3b) {
        if (byte <= 0x39) {
          // Saturating 16-bit accumulation (accumulator is 0 before a digit).
          accumulator = Math.min(accumulator * 10 + byte - 0x30, 0xffff);
          digits = true;
        } else if (count < MAX_PARAMS) {
          // ';' or ':' ends a parameter; past 24 Ghostty ignores it.
          params[count] = accumulator;
          colons[count] = byte === 0x3a ? 1 : 0;
          count += 1;
          accumulator = 0;
          digits = false;
        }
        state = CSI_PARAM;
        continue;
      }
      if (byte >= 0x80) {
        if (byte >= 0xa0) continue; // ignored outside ground
        if (byte === 0x9b) {
          count = accumulator = this.#intermediates = 0;
          digits = false;
          state = CSI_ENTRY;
        } else state = byte === 0x90 || byte === 0x98 || byte >= 0x9e ? STRING : GROUND;
        continue;
      }
      if (byte < 0x20 || byte === 0x7f) {
        if (byte === ESC) state = ESCAPE;
        else if (byte === 0x18 || byte === 0x1a) state = GROUND;
        continue; // other C0 controls execute; DEL is ignored
      }
      switch (state) {
        case STRING:
          break;
        case ESCAPE:
          if (byte === 0x5b) {
            count = accumulator = this.#intermediates = 0;
            digits = false;
            state = CSI_ENTRY;
          } else if (byte <= 0x2f) state = ESCAPE_INTERMEDIATE;
          else state = byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f ? STRING : GROUND;
          break;
        case ESCAPE_INTERMEDIATE:
          if (byte >= 0x30) state = GROUND;
          break;
        case CSI_IGNORE:
          if (byte >= 0x40) state = GROUND;
          break;
        default: // CSI_ENTRY, CSI_PARAM, CSI_INTERMEDIATE
          if (byte >= 0x40) {
            state = GROUND;
            this.#count = count;
            this.#accumulator = accumulator;
            this.#digits = digits;
            const correction = this.#dispatch(byte);
            if (correction) {
              (positions ??= []).push(index);
              (corrections ??= []).push(correction);
            }
          } else if (byte <= 0x2f) {
            this.#intermediates += 1;
            state = CSI_INTERMEDIATE;
          } else if (state === CSI_ENTRY && byte >= 0x3c) {
            this.#intermediates += 1; // private marker
            state = CSI_PARAM;
          } else {
            // A parameter byte after an intermediate, or a private marker
            // after parameters: Ghostty ignores the sequence.
            state = CSI_IGNORE;
          }
      }
    }
    this.#state = state;
    this.#count = count;
    this.#accumulator = accumulator;
    this.#digits = digits;
    return positions && corrections ? splice(input, positions, corrections) : input;
  }

  /** The correcting SGR for a finished CSI, if its SGR leaves a sentinel. */
  #dispatch(finalByte: number): Uint8Array | undefined {
    if (this.#count >= MAX_PARAMS) return undefined;
    if (this.#digits) {
      this.#params[this.#count] = this.#accumulator;
      this.#colons[this.#count] = 0;
      this.#count += 1;
    }
    if (finalByte !== 0x6d || this.#intermediates > 0) return undefined;
    this.#walkSgr();
    const foreground = this.#foreground === DIRECT && this.#sentinels.has(this.#foregroundRgb);
    const background = this.#background === DIRECT && this.#sentinels.has(this.#backgroundRgb);
    if (!foreground && !background) return undefined;
    const key = (foreground ? this.#foregroundRgb + 1 : 0) * 0x2000000 + (background ? this.#backgroundRgb + 1 : 0);
    let correction = this.#corrections.get(key);
    if (!correction) {
      const colors = [
        ...(foreground ? [`38;2;${nudged(this.#foregroundRgb)}`] : []),
        ...(background ? [`48;2;${nudged(this.#backgroundRgb)}`] : []),
      ];
      correction = encoder.encode(`\x1b[${colors.join(";")}m`);
      this.#corrections.set(key, correction);
    }
    return correction;
  }

  /** Ghostty's SGR walk, reduced to the foreground and background it sets. */
  #walkSgr(): void {
    const params = this.#params;
    const colons = this.#colons;
    const count = this.#count;
    this.#foreground = count === 0 ? RESET : UNCHANGED;
    this.#background = count === 0 ? RESET : UNCHANGED;
    let at = 0;
    while (at < count) {
      const value = params[at]!;
      const colon = colons[at] === 1;
      const remaining = count - at;
      at += 1;
      if (colon && value !== 4 && value !== 38 && value !== 48 && value !== 58) {
        while (at < count && colons[at] === 1) at += 1;
        at += 1;
        continue;
      }
      if (value === 0) {
        this.#foreground = RESET;
        this.#background = RESET;
      } else if (value === 4) {
        if (colon && remaining >= 2) at += colons[at] === 1 ? colonRun(colons, count, at) + 1 : 1;
      } else if ((value >= 30 && value <= 37) || value === 39 || (value >= 90 && value <= 97)) {
        this.#foreground = RESET;
      } else if ((value >= 40 && value <= 47) || value === 49 || (value >= 100 && value <= 107)) {
        this.#background = RESET;
      } else if ((value === 38 || value === 48 || value === 58) && remaining >= 2) {
        const kind = params[at];
        let rgb = -1;
        if (kind === 5 && remaining >= 3) {
          at += 2;
          if (value === 38) this.#foreground = RESET;
          else if (value === 48) this.#background = RESET;
        } else if (kind === 2 && remaining >= 5) {
          // r;g;b, r:g:b or colorspace:r:g:b; other colon forms are consumed unapplied.
          const run = colon ? colonRun(colons, count, at) : 3;
          const first = at + run - 2;
          if (run === 3 || run === 4) rgb = ((params[first]! & 0xff) << 16) | ((params[first + 1]! & 0xff) << 8) | (params[first + 2]! & 0xff);
          at += run + 1;
        }
        if (rgb >= 0 && value === 38) {
          this.#foreground = DIRECT;
          this.#foregroundRgb = rgb;
        } else if (rgb >= 0 && value === 48) {
          this.#background = DIRECT;
          this.#backgroundRgb = rgb;
        }
      }
    }
  }
}

/** Ghostty's countColon: consecutive ':' separators from `from`, excluding the last parameter. */
function colonRun(colons: Uint8Array, count: number, from: number): number {
  let run = 0;
  while (from + run < count - 1 && colons[from + run] === 1) run += 1;
  return run;
}

const encoder = new TextEncoder();
const nudged = (rgb: number) => `${rgb >> 16};${(rgb >> 8) & 0xff};${(rgb & 0xff) ^ 1}`;

/** The input with each correction inserted at its position. */
function splice(input: Uint8Array, positions: readonly number[], corrections: readonly Uint8Array[]): Uint8Array {
  let length = input.length;
  for (const correction of corrections) length += correction.length;
  const output = new Uint8Array(length);
  let from = 0;
  let offset = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const at = positions[index]!;
    const correction = corrections[index]!;
    output.set(input.subarray(from, at), offset);
    offset += at - from;
    output.set(correction, offset);
    offset += correction.length;
    from = at;
  }
  output.set(input.subarray(from), offset);
  return output;
}
