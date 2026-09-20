// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  terminals: [] as unknown[],
  ghosttyInstances: [] as unknown[],
  fitCalls: 0,
  fitDimensions: { cols: 80, rows: 24 },
}));

vi.mock("ghostty-web", () => {
  class Ghostty {
    static async load() {
      const instance = new Ghostty();
      fake.ghosttyInstances.push(instance);
      return instance;
    }
  }
  class FakeCell {
    constructor(readonly text: string) {}
    getChars() {
      return this.text;
    }
    getCodepoint() {
      return this.text.codePointAt(0) ?? 0;
    }
    getWidth() {
      return 1;
    }
    isInvisible() {
      return false;
    }
  }
  class FakeLine {
    readonly cells: FakeCell[];
    constructor(
      text: string,
      readonly isWrapped = false,
    ) {
      this.cells = Array.from(text, (value) => new FakeCell(value));
    }
    get length() {
      return this.cells.length;
    }
    getCell(column: number) {
      return this.cells[column];
    }
  }
  class Terminal {
    cols = 80;
    rows = 24;
    viewportY = 0;
    scrollbackLength = 1;
    outputScrollbackGrowth = 0;
    alternateScreen = false;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    listeners = new Set<(data: string) => void>();
    writes: string[] = [];
    selected: [number, number, number] | undefined;
    scrolledTo: number | undefined;
    options: Record<string, unknown>;
    lines = [new FakeLine("first line"), new FakeLine("second match")];
    buffer = {
      active: {
        type: "normal" as const,
        cursorX: 2,
        cursorY: 1,
        get length() {
          return 2;
        },
        getLine: (row: number) => this.lines[row],
      },
    };
    canvas = document.createElement("canvas");
    renderer = {
      getCanvas: () => this.canvas,
      getMetrics: () => ({ width: 9, height: 16 }),
      remeasureFont: vi.fn(),
      resize: vi.fn(),
      setTheme: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    };
    selectionManager = {
      selectionStart: null as { col: number; absoluteRow: number } | null,
      selectionEnd: null as { col: number; absoluteRow: number } | null,
      requestRender: vi.fn(),
      selectionChangedEmitter: { fire: vi.fn() },
    };
    wasmTerm = { isAlternateScreen: () => this.alternateScreen };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options, disableStdin: false };
      fake.terminals.push(this);
    }
    loadAddon(addon: { activate(terminal: Terminal): void }) {
      addon.activate(this);
    }
    attachCustomKeyEventHandler() {}
    open(container: HTMLElement) {
      this.element = container;
      container.tabIndex = 0;
      container.setAttribute("contenteditable", "true");
      this.textarea = document.createElement("textarea");
      container.append(this.canvas, this.textarea);
      Object.defineProperty(this.canvas, "getBoundingClientRect", {
        value: () => ({
          left: 10,
          top: 20,
          width: 720,
          height: 384,
          right: 730,
          bottom: 404,
          x: 10,
          y: 20,
          toJSON: () => ({}),
        }),
      });
      container.focus();
    }
    onData(listener: (data: string) => void) {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    }
    write(data: string | Uint8Array) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      this.writes.push(text);
      this.scrollbackLength += this.outputScrollbackGrowth;
      this.viewportY = 0;
      if (text.includes("\x1b[6n")) {
        for (const listener of this.listeners) listener("\x1b[2;3R");
      }
    }
    input(data: string, user = false) {
      if (user && !this.options.disableStdin) {
        for (const listener of this.listeners) listener(data);
      }
    }
    resize(columns: number, rows: number) {
      this.cols = columns;
      this.rows = rows;
    }
    reset() {}
    clearSelection = vi.fn(() => {
      this.selectionManager.selectionStart = null;
      this.selectionManager.selectionEnd = null;
    });
    hasMouseTracking() {
      return false;
    }
    scrollLines() {}
    getScrollbackLength() {
      return this.scrollbackLength;
    }
    scrollToLine(line: number) {
      this.scrolledTo = line;
      this.viewportY = Math.max(0, Math.min(this.scrollbackLength, line));
    }
    select(column: number, row: number, length: number) {
      this.selected = [column, row, length];
    }
    focus() {
      this.element?.focus();
    }
    blur() {
      this.element?.blur();
      this.textarea?.blur();
    }
    dispose() {
      this.element?.replaceChildren();
    }
  }
  class FitAddon {
    activate() {}
    proposeDimensions() {
      fake.fitCalls += 1;
      return fake.fitDimensions;
    }
    dispose() {}
  }
  return { Terminal, FitAddon, Ghostty };
});

import { GhosttyEmulator, terminalBufferLines } from "./ghostty-emulator.js";

type FakeTerminal = {
  viewportY: number;
  scrollbackLength: number;
  outputScrollbackGrowth: number;
  alternateScreen: boolean;
  readonly textarea: HTMLTextAreaElement;
  readonly options: Record<string, unknown>;
  readonly selectionManager: {
    readonly selectionStart: { col: number; absoluteRow: number } | null;
    readonly selectionEnd: { col: number; absoluteRow: number } | null;
  };
  readonly scrolledTo?: number;
  readonly clearSelection: ReturnType<typeof vi.fn>;
  input(data: string, user?: boolean): void;
};

afterEach(() => {
  document.body.replaceChildren();
  fake.terminals.length = 0;
  fake.ghosttyInstances.length = 0;
  fake.fitCalls = 0;
  fake.fitDimensions = { cols: 80, rows: 24 };
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("GhosttyEmulator", () => {
  it("keeps scrolled history visible during output and follows again at the bottom", async () => {
    const emulator = new GhosttyEmulator({ cursorBlink: true, fontSize: 13, scrollback: 100, colorScheme: "dark" });
    await emulator.mount(document.createElement("div"));
    const terminal = fake.terminals[0] as FakeTerminal;
    terminal.scrollbackLength = 40;
    terminal.viewportY = 10;
    terminal.outputScrollbackGrowth = 3;
    emulator.write(new TextEncoder().encode("more output\r\n"));
    expect(terminal.viewportY).toBe(13);
    terminal.outputScrollbackGrowth = 0;
    emulator.write(new TextEncoder().encode("partial line"));
    expect(terminal.viewportY).toBe(13);
    terminal.viewportY = 0;
    terminal.outputScrollbackGrowth = 2;
    emulator.write(new TextEncoder().encode("latest output\r\n"));
    expect(terminal.viewportY).toBe(0);
    emulator.dispose();
  });

  it("does not restore main-screen scrollback when output enters an alternate screen", async () => {
    const emulator = new GhosttyEmulator({ cursorBlink: true, fontSize: 13, scrollback: 100, colorScheme: "dark" });
    await emulator.mount(document.createElement("div"));
    const terminal = fake.terminals[0] as FakeTerminal;
    terminal.scrollbackLength = 40;
    terminal.viewportY = 10;
    terminal.alternateScreen = true;
    emulator.write(new TextEncoder().encode("TUI output"));
    expect(terminal.viewportY).toBe(0);
    emulator.dispose();
  });

  it("removes open-time focus and suppresses output-generated query replies", async () => {
    const container = document.createElement("div");
    const staleRenderer = document.createElement("canvas");
    staleRenderer.dataset.terminal = "stale";
    container.append(staleRenderer);
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 8_000,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    expect(container.querySelector('[data-terminal="stale"]')).toBeNull();
    const input: string[] = [];
    emulator.onInput((data) => input.push(data));
    emulator.setController(true);

    expect(container).not.toHaveAttribute("contenteditable");
    expect(document.activeElement).not.toBe(container);
    emulator.write(new TextEncoder().encode("\x1b[6n"));
    expect(input).toEqual([]);

    (fake.terminals[0] as FakeTerminal).input("typed", true);
    expect(input).toEqual(["typed"]);
    emulator.dispose();
  });

  it("focuses the real textarea only on a deliberate request", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "light",
    });
    await emulator.mount(container);
    const terminal = fake.terminals[0] as FakeTerminal;
    expect(document.activeElement).not.toBe(terminal.textarea);
    emulator.focus();
    expect(document.activeElement).toBe(terminal.textarea);
    expect(terminal.textarea.style.left).toBe("28px");
    emulator.dispose();
  });

  it("reconstructs and scrubs the Ghostty renderer on checkpoint reset", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    const first = fake.terminals[0] as FakeTerminal & {
      readonly canvas: HTMLCanvasElement;
      readonly writes: readonly string[];
    };

    await emulator.reset();

    const second = fake.terminals[1] as FakeTerminal & {
      readonly canvas: HTMLCanvasElement;
      readonly writes: readonly string[];
    };
    expect(fake.terminals).toHaveLength(2);
    expect(fake.ghosttyInstances).toHaveLength(2);
    expect(first.options.ghostty).not.toBe(second.options.ghostty);
    expect(first.canvas.isConnected).toBe(false);
    expect(second.canvas.isConnected).toBe(true);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(first.writes).toContain("\u001bc\u001b[3J\u001b[2J\u001b[H");
    expect(second.writes).toContain("\u001bc\u001b[3J\u001b[2J\u001b[H");
    emulator.dispose();
  });

  it("updates font size, refits, and preserves terminal focus only", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(container, outside);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "light",
    });
    await emulator.mount(container);
    const terminal = fake.terminals[0] as FakeTerminal & {
      cols: number;
      rows: number;
      options: Record<string, unknown>;
    };
    terminal.cols = 72;
    terminal.rows = 20;
    fake.fitDimensions = { cols: 72, rows: 20 };
    fake.fitCalls = 0;

    emulator.focus();
    expect(emulator.hasFocus()).toBe(true);
    expect(emulator.setFontSize(17)).toEqual({ columns: 72, rows: 20 });
    expect(terminal.options.fontSize).toBe(17);
    expect(fake.fitCalls).toBe(1);
    expect(emulator.hasFocus()).toBe(true);

    outside.focus();
    expect(emulator.hasFocus()).toBe(false);
    emulator.setFontSize(18);
    vi.runAllTimers();
    expect(document.activeElement).toBe(outside);
    emulator.dispose();
  });

  it("refits after a restore frame directly resized the emulator", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    const terminal = fake.terminals[0] as FakeTerminal & {
      cols: number;
      rows: number;
    };

    emulator.resize(64, 18);
    expect([terminal.cols, terminal.rows]).toEqual([64, 18]);
    fake.fitDimensions = { cols: 96, rows: 31 };

    expect(emulator.fit()).toEqual({ columns: 96, rows: 31 });
    expect([terminal.cols, terminal.rows]).toEqual([96, 31]);
    emulator.dispose();
  });

  it("remeasures font metrics and forces a render before returning refreshed geometry", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    const terminal = fake.terminals[0] as FakeTerminal & {
      readonly renderer: {
        readonly remeasureFont: ReturnType<typeof vi.fn>;
        readonly resize: ReturnType<typeof vi.fn>;
        readonly render: ReturnType<typeof vi.fn>;
      };
    };
    fake.fitDimensions = { cols: 104, rows: 33 };
    terminal.renderer.render.mockClear();

    expect(emulator.refreshMetrics()).toEqual({ columns: 104, rows: 33 });
    expect(terminal.renderer.remeasureFont).toHaveBeenCalledOnce();
    expect(terminal.renderer.resize).toHaveBeenCalledWith(104, 33);
    expect(terminal.renderer.render).toHaveBeenCalledOnce();
    emulator.dispose();
  });

  it("blur and dispose cancel delayed terminal refocus", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(container, outside);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);

    emulator.focus();
    emulator.blur();
    outside.focus();
    vi.runAllTimers();
    expect(document.activeElement).toBe(outside);
    expect(emulator.hasFocus()).toBe(false);

    emulator.focus();
    emulator.dispose();
    outside.focus();
    vi.runAllTimers();
    expect(document.activeElement).toBe(outside);
  });

  it("commits IME text once and keeps preedit out of terminal input", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    emulator.setController(true);
    const output: string[] = [];
    emulator.onInput((data) => output.push(data));
    const textarea = (fake.terminals[0] as FakeTerminal).textarea;
    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { data: "" }),
    );
    textarea.value = "ni";
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "ni" }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "ni",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    expect(output).toEqual([]);
    textarea.value = "你好";
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", { data: "你好" }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "你好",
        inputType: "insertText",
        isComposing: false,
      }),
    );
    expect(output).toEqual(["你好"]);
    emulator.dispose();
  });

  it("provides transcript and cycling search over the Ghostty buffer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    expect(emulator.transcript()).toBe("first line\nsecond match");
    expect(emulator.find("match", 1)).toEqual({
      found: true,
      index: 1,
      total: 1,
    });
    expect(emulator.searchNext("match")).toBe(true);
    expect(
      (fake.terminals[0] as FakeTerminal).selectionManager.selectionStart,
    ).toEqual({ col: 7, absoluteRow: 1 });
    expect(
      (fake.terminals[0] as FakeTerminal).selectionManager.selectionEnd,
    ).toEqual({ col: 11, absoluteRow: 1 });
    expect(
      (fake.terminals[0] as FakeTerminal).clearSelection,
    ).toHaveBeenCalled();
    expect(emulator.find("missing", 1)).toEqual({
      found: false,
      index: 0,
      total: 0,
    });
    emulator.dispose();
    expect(container).toBeEmptyDOMElement();
  });

  it("maps wide and combining graphemes to terminal cell columns", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    type SearchTerminal = FakeTerminal & {
      lines: Array<{
        readonly length: number;
        getCell(column: number): unknown;
      }>;
    };
    let terminal = fake.terminals[0] as SearchTerminal;
    const cells = [
      { getChars: () => "🙂", getWidth: () => 2, isInvisible: () => false },
      { getChars: () => "", getWidth: () => 0, isInvisible: () => false },
      { getChars: () => " ", getWidth: () => 1, isInvisible: () => false },
      {
        getChars: () => "e\u0301",
        getWidth: () => 1,
        isInvisible: () => false,
      },
      { getChars: () => "m", getWidth: () => 1, isInvisible: () => false },
    ];
    terminal.lines = [
      {
        length: cells.length,
        getCell: (column: number) => cells[column],
      },
    ];

    expect(emulator.searchNext("e\u0301m")).toBe(true);
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 3,
      absoluteRow: 0,
    });
    expect(terminal.selectionManager.selectionEnd).toEqual({
      col: 4,
      absoluteRow: 0,
    });
    await emulator.reset();
    terminal = fake.terminals.at(-1) as SearchTerminal;
    terminal.lines = [
      {
        length: cells.length,
        getCell: (column: number) => cells[column],
      },
    ];
    expect(emulator.searchNext("🙂 ")).toBe(true);
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 0,
      absoluteRow: 0,
    });
    expect(terminal.selectionManager.selectionEnd).toEqual({
      col: 2,
      absoluteRow: 0,
    });
    emulator.dispose();
  });

  it("cycles same-row occurrences and searches across soft wraps", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    type SearchTerminal = FakeTerminal & {
      lines: Array<{
        readonly length: number;
        readonly isWrapped: boolean;
        getCell(column: number): unknown;
      }>;
    };
    let terminal = fake.terminals[0] as SearchTerminal;
    const line = (text: string, isWrapped = false) => {
      const cells = Array.from(text, (value) => ({
        getChars: () => value,
        getCodepoint: () => value.codePointAt(0) ?? 0,
        getWidth: () => 1,
        isInvisible: () => false,
      }));
      return {
        length: cells.length,
        isWrapped,
        getCell: (column: number) => cells[column],
      };
    };
    terminal.lines = [line("match then match")];
    expect(emulator.find("match", 1)).toEqual({
      found: true,
      index: 1,
      total: 2,
    });
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 0,
      absoluteRow: 0,
    });
    expect(emulator.find("match", 1)).toEqual({
      found: true,
      index: 2,
      total: 2,
    });
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 11,
      absoluteRow: 0,
    });
    expect(emulator.searchNext("match")).toBe(true);
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 0,
      absoluteRow: 0,
    });
    expect(emulator.search("match", -1)).toBe(true);
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 11,
      absoluteRow: 0,
    });

    await emulator.reset();
    terminal = fake.terminals.at(-1) as SearchTerminal;
    terminal.lines = [line("soft"), line("wrap", true)];
    expect(emulator.find("softwrap", 1)).toEqual({
      found: true,
      index: 1,
      total: 1,
    });
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 0,
      absoluteRow: 0,
    });
    expect(terminal.selectionManager.selectionEnd).toEqual({
      col: 3,
      absoluteRow: 1,
    });

    await emulator.reset();
    terminal = fake.terminals.at(-1) as SearchTerminal;
    terminal.lines = [line("ΟΣ")];
    expect(emulator.searchNext("ΟΣ")).toBe(true);
    expect(terminal.selectionManager.selectionStart).toEqual({
      col: 0,
      absoluteRow: 0,
    });
    expect(terminal.selectionManager.selectionEnd).toEqual({
      col: 1,
      absoluteRow: 0,
    });
    emulator.dispose();
  });

  it("does not carry rendered or buffered text between terminal hosts", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const first = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await first.mount(container);
    const firstTerminal = fake.terminals[0] as FakeTerminal & {
      lines: Array<{ readonly length: number; getCell(column: number): unknown }>;
    };
    firstTerminal.lines = [
      {
        length: 15,
        getCell: (column: number) => {
          const value = "ONLY-TERMINAL-A"[column]!;
          return {
            getChars: () => value,
            getCodepoint: () => value.codePointAt(0) ?? 0,
            getWidth: () => 1,
            isInvisible: () => false,
          };
        },
      },
    ];
    expect(first.transcript()).toContain("ONLY-TERMINAL-A");
    first.dispose();

    const second = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await second.mount(container);
    expect(second.transcript()).toBe("first line\nsecond match");
    expect(second.transcript()).not.toContain("ONLY-TERMINAL-A");
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    second.dispose();
  });
});

describe("terminalBufferLines", () => {
  it("skips continuation cells and trims trailing blanks", () => {
    const cells = [
      { getChars: () => "🙂", getWidth: () => 2, isInvisible: () => false },
      { getChars: () => "", getWidth: () => 0, isInvisible: () => false },
      { getChars: () => " ", getWidth: () => 1, isInvisible: () => false },
    ];
    expect(
      terminalBufferLines({
        buffer: {
          active: {
            type: "normal",
            length: 1,
            getLine: () => ({
              length: cells.length,
              getCell: (column: number) => cells[column],
            }),
          },
        },
      } as never),
    ).toEqual(["🙂"]);
  });
});
