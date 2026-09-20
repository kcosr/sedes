import headless from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import serialize from "@xterm/addon-serialize";

const { Terminal } = headless;
const { Unicode11Addon } = unicode11;
const { SerializeAddon } = serialize;

export const TERMINAL_SERVER_SCROLLBACK_ROWS = 20_000;
export const TERMINAL_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Server-side parser authority for device-query replies and bounded ANSI
 * restore checkpoints. Raw records remain authoritative between checkpoints.
 */
export class TerminalHeadlessEmulator {
  readonly #terminal: InstanceType<typeof Terminal>;
  readonly #serializeAddon: InstanceType<typeof SerializeAddon>;
  readonly #queryHandlers: { dispose(): void }[] = [];
  #eraseScrollbackSeen = false;

  constructor(input: {
    readonly rows: number;
    readonly columns: number;
    readonly onData: (bytes: Uint8Array) => void;
  }) {
    this.#terminal = new Terminal({
      rows: input.rows,
      cols: input.columns,
      allowProposedApi: true,
      scrollback: TERMINAL_SERVER_SCROLLBACK_ROWS,
    });
    this.#serializeAddon = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializeAddon);
    this.#terminal.loadAddon(new Unicode11Addon());
    this.#terminal.unicode.activeVersion = "11";
    this.#terminal.onData((data) => input.onData(Buffer.from(data, "utf8")));
    const reply = (value: string) =>
      input.onData(Buffer.from(`\u001b]${value}\u001b\\`, "utf8"));
    this.#queryHandlers.push(
      this.#terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
        if (params.length === 1 && params[0] === 3) {
          // Return false so xterm's built-in ED handler still applies the
          // erase. The flag is consumed only after write's completion
          // callback, when the parser has applied the sequence in-order.
          this.#eraseScrollbackSeen = true;
        }
        return false;
      }),
      this.#terminal.parser.registerOscHandler(4, (data) => {
        const fields = data.split(";");
        if (fields.length < 2 || fields.length % 2 !== 0) return false;
        let handled = false;
        for (let index = 0; index < fields.length; index += 2) {
          const paletteIndex = Number(fields[index]);
          if (
            fields[index + 1] !== "?" ||
            !Number.isSafeInteger(paletteIndex) ||
            paletteIndex < 0 ||
            paletteIndex > 255
          ) continue;
          reply(`4;${paletteIndex};${paletteColor(paletteIndex)}`);
          handled = true;
        }
        return handled;
      }),
      ...([10, 11, 12] as const).map((identifier) =>
        this.#terminal.parser.registerOscHandler(identifier, (data) => {
          if (data !== "?") return false;
          reply(`${identifier};${identifier === 11 ? "rgb:0000/0000/0000" : "rgb:ffff/ffff/ffff"}`);
          return true;
        }),
      ),
    );
  }

  write(bytes: Uint8Array): Promise<{ readonly erasedScrollback: boolean }> {
    return new Promise((resolve) => {
      this.#terminal.write(bytes, () => {
        const erasedScrollback = this.#eraseScrollbackSeen;
        this.#eraseScrollbackSeen = false;
        resolve({ erasedScrollback });
      });
    });
  }

  /**
   * Produces terminal input bytes that reconstruct the current screen, modes,
   * cursor, and a bounded tail of scrollback in another VT-compatible
   * emulator. The row limit is canonical; the byte bound prevents one restore
   * from becoming an unbounded WebSocket frame.
   */
  checkpoint(): Uint8Array {
    let low = 0;
    let high = TERMINAL_SERVER_SCROLLBACK_ROWS;
    let best = this.#serialize(0);
    if (best.byteLength > TERMINAL_CHECKPOINT_MAX_BYTES) {
      throw new Error("terminal_checkpoint_visible_state_too_large");
    }
    while (low <= high) {
      const candidateRows = Math.floor((low + high) / 2);
      const candidate = this.#serialize(candidateRows);
      if (candidate.byteLength <= TERMINAL_CHECKPOINT_MAX_BYTES) {
        best = candidate;
        low = candidateRows + 1;
      } else {
        high = candidateRows - 1;
      }
    }
    return best;
  }

  resize(rows: number, columns: number): void {
    this.#terminal.resize(columns, rows);
  }

  dispose(): void {
    for (const handler of this.#queryHandlers) handler.dispose();
    this.#terminal.dispose();
  }

  #serialize(scrollback: number): Uint8Array {
    return Buffer.from(this.#serializeAddon.serialize({ scrollback }), "utf8");
  }
}

const ANSI_COLORS = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd,
  0x00cdcd, 0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00,
  0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
] as const;

function paletteColor(index: number): string {
  let red: number;
  let green: number;
  let blue: number;
  if (index < ANSI_COLORS.length) {
    const packed = ANSI_COLORS[index]!;
    red = packed >> 16;
    green = (packed >> 8) & 0xff;
    blue = packed & 0xff;
  } else if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255] as const;
    red = levels[Math.floor(value / 36)]!;
    green = levels[Math.floor((value % 36) / 6)]!;
    blue = levels[value % 6]!;
  } else {
    red = green = blue = 8 + (index - 232) * 10;
  }
  const component = (value: number) =>
    value.toString(16).padStart(2, "0").repeat(2);
  return `rgb:${component(red)}/${component(green)}/${component(blue)}`;
}
