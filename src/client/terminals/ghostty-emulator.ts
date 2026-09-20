import { installGhosttyRenderScheduling } from "./ghostty-render-scheduling.js";
import { isWindowsClient } from "./client-platform.js";
import type { ITheme, Terminal } from "ghostty-web";
import type { TerminalEmulatorSink } from "./terminal-session.js";
import {
  beforeInputOutput,
  idleTerminalImeState,
  isImeComposingKeyEvent,
  keyboardEventOutput,
  reduceTerminalImeState,
  shouldDeferBeforeInputToIme,
  textareaDelta,
  type TerminalImeState,
} from "./terminal-ime-input.js";
import { installTerminalTouchScroll } from "../provider-features/codex-tui-touch-scroll.js";

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

export type TerminalColorScheme = "light" | "dark";

export const GHOSTTY_THEMES: Readonly<Record<TerminalColorScheme, ITheme>> =
  Object.freeze({
    light: Object.freeze({
      background: "#f7f7f8",
      foreground: "#24272d",
      cursor: "#17191d",
      selectionBackground: "#c9d7ed",
      selectionForeground: "#17191d",
      black: "#363a43",
      red: "#b4232f",
      green: "#287a42",
      yellow: "#8a6414",
      blue: "#245fa8",
      magenta: "#7c3fa0",
      cyan: "#177784",
      white: "#d9dce1",
      brightBlack: "#6b7280",
      brightRed: "#d13a46",
      brightGreen: "#329653",
      brightYellow: "#a87916",
      brightBlue: "#3377c5",
      brightMagenta: "#9554b8",
      brightCyan: "#258d9a",
      brightWhite: "#ffffff",
    }),
    dark: Object.freeze({
      background: "#111318",
      foreground: "#e5e7eb",
      cursor: "#f9fafb",
      selectionBackground: "#374151",
      selectionForeground: "#f9fafb",
      black: "#374151",
      red: "#f87171",
      green: "#86efac",
      yellow: "#fde68a",
      blue: "#93c5fd",
      magenta: "#d8b4fe",
      cyan: "#67e8f9",
      white: "#d1d5db",
      brightBlack: "#6b7280",
      brightRed: "#fca5a5",
      brightGreen: "#bbf7d0",
      brightYellow: "#fef3c7",
      brightBlue: "#bfdbfe",
      brightMagenta: "#e9d5ff",
      brightCyan: "#a5f3fc",
      brightWhite: "#f9fafb",
    }),
  });

export interface GhosttyEmulatorOptions {
  readonly cursorBlink: boolean;
  readonly fontSize: number;
  readonly scrollback: number;
  readonly colorScheme: TerminalColorScheme;
}

export interface TerminalSearchResult {
  readonly found: boolean;
  readonly index: number;
  readonly total: number;
}

const noTerminalSearchResult: TerminalSearchResult = Object.freeze({
  found: false,
  index: 0,
  total: 0,
});

type GhosttyModule = typeof import("ghostty-web");
let ghosttyModule: Promise<GhosttyModule> | undefined;

// Do not call ghostty-web init() here. Its shared WASM allocator can recycle
// freed terminal pages into a later renderer. Each mounted renderer and reset
// instead receives a separately instantiated Ghostty below.
async function loadGhostty(): Promise<GhosttyModule> {
  ghosttyModule ??= import("ghostty-web")
    .then((module) => module)
    .catch((error: unknown) => {
      ghosttyModule = undefined;
      throw error;
    });
  return ghosttyModule;
}

/** General terminal renderer backed by the same Ghostty WASM used by Herdr. */
export class GhosttyEmulator implements TerminalEmulatorSink {
  readonly #options: GhosttyEmulatorOptions;
  #ghostty?: GhosttyModule;
  #wasm?: import("ghostty-web").Ghostty;
  #terminal?: Terminal;
  #fitAddon?: import("ghostty-web").FitAddon;
  #renderScheduling: ReturnType<typeof installGhosttyRenderScheduling> | undefined;
  #cursorBlink: boolean;
  #container?: HTMLElement;
  #inputCallback?: (data: string) => void;
  #inputDisposable?: { dispose(): void };
  #touchCleanup?: () => void;
  #imeCleanup?: () => void;
  #delayedFocus?: number;
  #applyingOutput = false;
  #disposed = false;
  #lastSearch = "";
  #lastSearchOffset = -1;

  constructor(options: GhosttyEmulatorOptions) {
    this.#options = options;
    this.#cursorBlink = options.cursorBlink;
  }

  async mount(
    container: HTMLElement,
  ): Promise<{ readonly columns: number; readonly rows: number }> {
    const ghostty = await loadGhostty();
    const wasm = await ghostty.Ghostty.load();
    if (this.#disposed) throw new Error("The terminal renderer was disposed.");
    // A renderer host belongs to exactly one terminal incarnation. Clear any
    // stale canvas/textarea left by a prior renderer before Ghostty opens.
    this.#ghostty = ghostty;
    this.#wasm = wasm;
    this.#container = container;
    return this.#mountTerminal();
  }

  async reset(): Promise<void> {
    const terminal = this.#requireTerminal();
    const columns = terminal.cols;
    const rows = terminal.rows;
    const disableStdin = terminal.options.disableStdin;
    const ghostty = this.#ghostty;
    if (!ghostty) throw new Error("The terminal renderer is not available.");
    this.#disposeTerminal();
    this.#container?.replaceChildren();
    const wasm = await ghostty.Ghostty.load();
    if (this.#disposed) return;
    this.#wasm = wasm;
    this.#mountTerminal({ columns, rows, disableStdin });
    this.#lastSearch = "";
    this.#lastSearchOffset = -1;
  }

  #mountTerminal(input?: {
    readonly columns: number;
    readonly rows: number;
    readonly disableStdin: boolean;
  }): { readonly columns: number; readonly rows: number } {
    const ghostty = this.#ghostty;
    const wasm = this.#wasm;
    const container = this.#container;
    if (!ghostty || !wasm || !container || this.#disposed)
      throw new Error("The terminal renderer is not available.");
    container.replaceChildren();
    const terminal = new ghostty.Terminal({
      ...(input
        ? {
            cols: input.columns,
            rows: input.rows,
            disableStdin: input.disableStdin,
          }
        : {}),
      ghostty: wasm,
      convertEol: false,
      cursorBlink: this.#cursorBlink,
      fontFamily: FONT_FAMILY,
      fontSize: this.#options.fontSize,
      scrollback: this.#options.scrollback,
      smoothScrollDuration: 0,
      theme: GHOSTTY_THEMES[this.#options.colorScheme],
    });
    const fitAddon = new ghostty.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    this.#renderScheduling = installGhosttyRenderScheduling(terminal, isWindowsClient());
    blankGhosttyBootstrap(terminal);
    terminal.attachCustomKeyEventHandler((event) => {
      if (isImeComposingKeyEvent(event)) return false;
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey)
        return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      terminal.input(event.shiftKey ? "\x1b[Z" : "\t", true);
      return true;
    });
    container.removeAttribute("contenteditable");
    container.blur();
    terminal.textarea?.blur();
    container.style.touchAction = "none";
    this.#terminal = terminal;
    this.#fitAddon = fitAddon;
    this.#installInputListener();
    this.#imeCleanup = installGhosttyImeBridge({
      container,
      terminal,
      focusTextInput: () => this.focus(),
    });
    this.#touchCleanup = installTerminalTouchScroll(
      container,
      {
        hasMouseTracking: () => terminal.hasMouseTracking(),
        isAlternateScreen: () =>
          terminal.wasmTerm?.isAlternateScreen() ?? false,
        scrollLines: (amount) => terminal.scrollLines(amount),
        renderer: terminal.renderer,
        ...(terminal.textarea ? { textarea: terminal.textarea } : {}),
      },
      (data) => terminal.input(data, true),
    );
    const background = GHOSTTY_THEMES[this.#options.colorScheme].background;
    const canvas = terminal.renderer?.getCanvas();
    if (canvas) canvas.style.backgroundColor = background ?? "transparent";
    const size = this.fit();
    return { columns: size.columns, rows: size.rows };
  }

  write(bytes: Uint8Array): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    const viewportY = terminal.viewportY;
    const scrollbackLength = terminal.getScrollbackLength();
    // ghostty-web emits terminal-generated DA/DSR responses through onData
    // synchronously inside write(). The server headless emulator is the sole
    // responder, so output-originated onData must never return to the PTY.
    this.#applyingOutput = true;
    try {
      terminal.write(bytes);
      // ghostty-web 0.4.0 unconditionally scrolls to the bottom on write.
      // Restore a reader's viewport synchronously, before its next paint.
      // viewportY is measured backwards from the live screen, so account for
      // newly retained lines to keep the same history visible as the buffer
      // grows. At its retention cap, preserve the distance from the bottom.
      if (viewportY > 0 && !terminal.wasmTerm?.isAlternateScreen()) {
        terminal.scrollToLine(
          viewportY + Math.max(0, terminal.getScrollbackLength() - scrollbackLength),
        );
      }
    } finally {
      this.#applyingOutput = false;
      this.#renderScheduling?.request();
    }
  }

  setCursorBlink(enabled: boolean): void {
    this.#cursorBlink = enabled;
    this.#renderScheduling?.setCursorBlink(enabled);
  }

  resize(columns: number, rows: number): void {
    this.#terminal?.resize(columns, rows);
  }

  fit(): { readonly columns: number; readonly rows: number } {
    const terminal = this.#requireTerminal();
    // FitAddon caches its last proposal. Server restore frames resize the
    // emulator directly, so calling fit() afterward can otherwise be skipped
    // as "unchanged" even though the terminal is no longer at that size.
    const proposed = this.#fitAddon?.proposeDimensions();
    if (
      proposed &&
      (proposed.cols !== terminal.cols || proposed.rows !== terminal.rows)
    )
      terminal.resize(proposed.cols, proposed.rows);
    return { columns: terminal.cols, rows: terminal.rows };
  }

  /** Remeasure canvas font metrics before fitting after a layout/font change. */
  refreshMetrics(): { readonly columns: number; readonly rows: number } {
    const terminal = this.#requireTerminal();
    terminal.renderer?.remeasureFont();
    const size = this.fit();
    if (terminal.renderer && terminal.wasmTerm) {
      // fit() intentionally skips a terminal resize when the grid dimensions
      // did not change. Font metrics can still change the grid's pixel size,
      // so refresh the canvas even for the same rows and columns.
      terminal.renderer.resize(terminal.cols, terminal.rows);
      terminal.renderer.render(
        terminal.wasmTerm,
        true,
        terminal.viewportY,
        terminal,
        0,
      );
    }
    return size;
  }

  setFontSize(fontSize: number): {
    readonly columns: number;
    readonly rows: number;
  } {
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      throw new RangeError("Terminal font size must be a positive number.");
    }
    const terminal = this.#requireTerminal();
    const restoreFocus = this.hasFocus();
    terminal.options.fontSize = fontSize;
    const size = this.refreshMetrics();
    if (restoreFocus) this.focus();
    return size;
  }

  setController(controller: boolean): void {
    if (this.#terminal) this.#terminal.options.disableStdin = !controller;
  }

  onInput(listener: (data: string) => void): () => void {
    this.#inputCallback = listener;
    this.#installInputListener();
    return () => {
      if (this.#inputCallback !== listener) return;
      this.#inputDisposable?.dispose();
      this.#inputDisposable = undefined;
      this.#inputCallback = undefined;
    };
  }

  focus(): void {
    const terminal = this.#terminal;
    const textarea = terminal?.textarea;
    this.#cancelDelayedFocus();
    if (!terminal || !textarea) {
      terminal?.focus();
      return;
    }
    positionGhosttyTextarea(textarea, terminal);
    textarea.focus({ preventScroll: true });
    this.#delayedFocus = window.setTimeout(() => {
      this.#delayedFocus = undefined;
      if (!textarea.isConnected || this.#terminal !== terminal) return;
      positionGhosttyTextarea(textarea, terminal);
      // A control focused after the terminal request owns focus now. Never
      // steal it merely because Ghostty's delayed positioning work ran later.
      if (this.hasFocus() && document.activeElement !== textarea) {
        textarea.focus({ preventScroll: true });
      }
    }, 0);
  }

  blur(): void {
    this.#cancelDelayedFocus();
    this.#terminal?.textarea?.blur();
    this.#terminal?.blur();
  }

  hasFocus(): boolean {
    const active = document.activeElement;
    return Boolean(active && this.#container?.contains(active));
  }

  clearSelection(): void {
    this.#terminal?.clearSelection();
  }

  searchNext(query: string): boolean {
    return this.search(query, 1);
  }

  search(query: string, direction: -1 | 1): boolean {
    return this.find(query, direction).found;
  }

  find(query: string, direction: -1 | 1): TerminalSearchResult {
    const terminal = this.#terminal;
    const needle = query.toLocaleLowerCase();
    if (!terminal || !needle) return noTerminalSearchResult;
    const rows = terminalBufferRows(terminal);
    const ranges = findTerminalSearchRanges(rows, needle);
    if (ranges.length === 0) {
      terminal.clearSelection();
      this.#lastSearch = query;
      this.#lastSearchOffset = -1;
      return noTerminalSearchResult;
    }
    const continuing = query === this.#lastSearch;
    const range = direction === 1
      ? continuing
        ? (ranges.find(
            (candidate) => candidate.offset > this.#lastSearchOffset,
          ) ?? ranges[0]!)
        : ranges[0]!
      : continuing
        ? ([...ranges].reverse().find(
            (candidate) => candidate.offset < this.#lastSearchOffset,
          ) ?? ranges.at(-1)!)
        : ranges.at(-1)!;
    const scrollback = terminal.getScrollbackLength();
    const viewportY = Math.max(
      0,
      Math.min(scrollback, scrollback - range.start.absoluteRow),
    );
    terminal.scrollToLine(viewportY);
    const visibleRow = range.start.absoluteRow - (scrollback - viewportY);
    selectGhosttyAbsoluteRange(terminal, range, visibleRow);
    this.#lastSearch = query;
    this.#lastSearchOffset = range.offset;
    return {
      found: true,
      index: ranges.indexOf(range) + 1,
      total: ranges.length,
    };
  }

  transcript(): string {
    return this.#terminal ? terminalBufferLines(this.#terminal).join("\n") : "";
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelDelayedFocus();
    this.#disposeTerminal();
    if (this.#container) {
      this.#container.style.touchAction = "";
      this.#container.replaceChildren();
    }
    this.#inputCallback = undefined;
    this.#ghostty = undefined;
    this.#wasm = undefined;
    this.#container = undefined;
  }

  #disposeTerminal(): void {
    this.#renderScheduling?.dispose();
    this.#renderScheduling = undefined;
    this.#cancelDelayedFocus();
    this.#touchCleanup?.();
    this.#imeCleanup?.();
    this.#inputDisposable?.dispose();
    this.#fitAddon?.dispose();
    this.#terminal?.dispose();
    this.#touchCleanup = undefined;
    this.#imeCleanup = undefined;
    this.#inputDisposable = undefined;
    this.#fitAddon = undefined;
    this.#terminal = undefined;
    this.#applyingOutput = false;
  }

  #installInputListener(): void {
    this.#inputDisposable?.dispose();
    const terminal = this.#terminal;
    const callback = this.#inputCallback;
    if (!terminal || !callback) {
      this.#inputDisposable = undefined;
      return;
    }
    this.#inputDisposable = terminal.onData((data) => {
      if (!this.#applyingOutput) callback(data);
    });
  }

  #requireTerminal(): Terminal {
    if (!this.#terminal)
      throw new Error("The terminal renderer is not mounted.");
    return this.#terminal;
  }

  #cancelDelayedFocus(): void {
    if (this.#delayedFocus === undefined) return;
    window.clearTimeout(this.#delayedFocus);
    this.#delayedFocus = undefined;
  }
}

/**
 * ghostty-web 0.4.0 can expose cells left in reused WASM pages when a terminal
 * is disposed and another is opened in the same process. Reset the parser,
 * erase its saved scrollback, and erase the display before the authoritative
 * server checkpoint is applied.
 */
function blankGhosttyBootstrap(terminal: Terminal): void {
  const canvas = terminal.renderer?.getCanvas();
  if (canvas) canvas.style.visibility = "hidden";
  terminal.write("\u001bc\u001b[3J\u001b[2J\u001b[H");
  if (terminal.renderer && terminal.wasmTerm) {
    terminal.renderer.render(
      terminal.wasmTerm,
      true,
      terminal.viewportY,
      terminal,
      0,
    );
  }
  if (canvas) canvas.style.visibility = "";
}

type GhosttySelectionAccess = {
  selectionStart: { col: number; absoluteRow: number } | null;
  selectionEnd: { col: number; absoluteRow: number } | null;
  requestRender(): void;
  selectionChangedEmitter?: { fire?(): void };
};

function selectGhosttyAbsoluteRange(
  terminal: Terminal,
  range: TerminalSearchRange,
  fallbackVisibleRow: number,
): void {
  // ghostty-web 0.4.0's public select() adds viewportY directly to the row,
  // which does not match its combined scrollback/screen coordinate mapping.
  // Use its pinned selection manager so search highlights the row it reveals.
  const selection = (
    terminal as unknown as {
      selectionManager?: GhosttySelectionAccess;
    }
  ).selectionManager;
  if (!selection) {
    const fallbackLength =
      range.start.absoluteRow === range.end.absoluteRow
        ? range.end.column - range.start.column + 1
        : 1;
    terminal.select(range.start.column, fallbackVisibleRow, fallbackLength);
    return;
  }
  terminal.clearSelection();
  selection.selectionStart = {
    col: range.start.column,
    absoluteRow: range.start.absoluteRow,
  };
  selection.selectionEnd = {
    col: range.end.column,
    absoluteRow: range.end.absoluteRow,
  };
  selection.requestRender();
  selection.selectionChangedEmitter?.fire?.();
}

interface ImeBridgeTerminal {
  readonly textarea?: HTMLTextAreaElement;
  readonly renderer?: Terminal["renderer"];
  readonly buffer: Terminal["buffer"];
  readonly options: Terminal["options"];
  input(data: string, wasUserInput?: boolean): void;
}

/** Herdr-style mobile/desktop IME bridge for Ghostty's hidden textarea. */
export function installGhosttyImeBridge(input: {
  readonly container: HTMLElement;
  readonly terminal: ImeBridgeTerminal;
  readonly focusTextInput: () => void;
}): () => void {
  const textarea = input.terminal.textarea;
  if (!textarea) return () => undefined;
  hideGhosttyTextarea(textarea);
  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  overlay.hidden = true;
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "6",
    pointerEvents: "none",
    whiteSpace: "pre",
    padding: "0 2px",
    borderRadius: "2px",
    textDecoration: "underline",
    background: "rgba(17, 19, 24, .9)",
    color: "#f3f4f6",
  });
  input.container.append(overlay);
  let processedValue = "";
  let lastKeydown: { readonly data: string; readonly time: number } | undefined;
  let imeState: TerminalImeState = idleTerminalImeState();

  const clearTextarea = () => {
    textarea.value = "";
    processedValue = "";
    lastKeydown = undefined;
  };
  const emit = (value: string) => input.terminal.input(value, true);
  const refreshPreedit = () => {
    positionGhosttyTextarea(textarea, input.terminal);
    const preedit = imeState.phase === "composing" ? imeState.preedit : "";
    overlay.hidden = !preedit;
    overlay.textContent = preedit;
    if (preedit) {
      overlay.style.left = textarea.style.left;
      overlay.style.top = textarea.style.top;
      overlay.style.fontFamily = FONT_FAMILY;
      overlay.style.fontSize = `${input.terminal.options.fontSize}px`;
      overlay.style.lineHeight = textarea.style.height;
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (imeState.phase === "composing" || isImeComposingKeyEvent(event)) {
      event.stopImmediatePropagation();
      return;
    }
    if (imeState.pendingInput !== null) {
      imeState = reduceTerminalImeState(imeState, { type: "settle" }).state;
    }
    const special =
      event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey
        ? event.shiftKey
          ? "\x1b[Z"
          : "\t"
        : null;
    if (special) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearTextarea();
      emit(special);
      return;
    }
    const output = keyboardEventOutput(event);
    if (output) lastKeydown = { data: output, time: performance.now() };
  };
  const onBeforeInput = (event: InputEvent) => {
    if (shouldDeferBeforeInputToIme(imeState, event)) return;
    const output = beforeInputOutput(event);
    if (!output) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (
      lastKeydown?.data === output &&
      performance.now() - lastKeydown.time < 100
    ) {
      clearTextarea();
      return;
    }
    clearTextarea();
    emit(output);
  };
  const onInput = (event: Event) => {
    const current = event as InputEvent;
    const transition = reduceTerminalImeState(imeState, {
      type: "input",
      data: current.data,
      inputType: current.inputType,
      isComposing: current.isComposing,
      textareaValue: textarea.value,
    });
    imeState = transition.state;
    if (transition.suppressInput) {
      if (transition.clearTextarea) clearTextarea();
      refreshPreedit();
      return;
    }
    const output = textareaDelta(processedValue, textarea.value);
    processedValue = textarea.value;
    if (output) emit(output);
  };
  const onCompositionStart = (event: CompositionEvent) => {
    imeState = reduceTerminalImeState(imeState, {
      type: "compositionstart",
      data: event.data,
      textareaValue: textarea.value,
    }).state;
    processedValue = textarea.value;
    lastKeydown = undefined;
    refreshPreedit();
    event.stopImmediatePropagation();
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    imeState = reduceTerminalImeState(imeState, {
      type: "compositionupdate",
      data: event.data,
      textareaValue: textarea.value,
    }).state;
    refreshPreedit();
    event.stopImmediatePropagation();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    event.stopImmediatePropagation();
    const transition = reduceTerminalImeState(imeState, {
      type: "compositionend",
      data: event.data,
      textareaValue: textarea.value,
    });
    imeState = transition.state;
    overlay.hidden = true;
    overlay.textContent = "";
    if (transition.clearTextarea) clearTextarea();
    if (transition.output) emit(transition.output);
    const ended = imeState;
    if (ended.phase === "idle" && ended.pendingInput?.kind !== "cancellation") {
      queueMicrotask(() => {
        if (imeState === ended) {
          imeState = reduceTerminalImeState(imeState, { type: "settle" }).state;
        }
      });
    }
  };
  const onFocus = () => positionGhosttyTextarea(textarea, input.terminal);
  const onBlur = () => {
    imeState = reduceTerminalImeState(imeState, { type: "reset" }).state;
    clearTextarea();
    overlay.hidden = true;
    hideGhosttyTextarea(textarea);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (
      event.target instanceof Node &&
      input.container.contains(event.target) &&
      event.target !== textarea
    )
      input.focusTextInput();
  };

  textarea.addEventListener("keydown", onKeydown, { capture: true });
  textarea.addEventListener("beforeinput", onBeforeInput, { capture: true });
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("compositionstart", onCompositionStart, {
    capture: true,
  });
  textarea.addEventListener("compositionupdate", onCompositionUpdate, {
    capture: true,
  });
  textarea.addEventListener("compositionend", onCompositionEnd, {
    capture: true,
  });
  textarea.addEventListener("focus", onFocus);
  textarea.addEventListener("blur", onBlur);
  input.container.addEventListener("focusin", onFocusIn);
  return () => {
    textarea.removeEventListener("keydown", onKeydown, { capture: true });
    textarea.removeEventListener("beforeinput", onBeforeInput, {
      capture: true,
    });
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("compositionstart", onCompositionStart, {
      capture: true,
    });
    textarea.removeEventListener("compositionupdate", onCompositionUpdate, {
      capture: true,
    });
    textarea.removeEventListener("compositionend", onCompositionEnd, {
      capture: true,
    });
    textarea.removeEventListener("focus", onFocus);
    textarea.removeEventListener("blur", onBlur);
    input.container.removeEventListener("focusin", onFocusIn);
    overlay.remove();
  };
}

function positionGhosttyTextarea(
  textarea: HTMLTextAreaElement,
  terminal: Pick<ImeBridgeTerminal, "renderer" | "buffer" | "options">,
): void {
  const canvas = terminal.renderer?.getCanvas();
  const rect = canvas?.getBoundingClientRect();
  const metrics = terminal.renderer?.getMetrics();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    hideGhosttyTextarea(textarea);
    return;
  }
  const cursor = terminal.buffer.active;
  const width = Math.max(1, metrics?.width ?? 9);
  const height = Math.max(1, metrics?.height ?? 16);
  const left = Math.min(
    window.innerWidth - width - 1,
    Math.max(1, rect.left + cursor.cursorX * width),
  );
  const top = Math.min(
    window.innerHeight - height - 1,
    Math.max(1, rect.top + cursor.cursorY * height),
  );
  Object.assign(textarea.style, {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    opacity: "0",
    color: "transparent",
    background: "transparent",
    caretColor: "transparent",
    overflow: "hidden",
    fontFamily: FONT_FAMILY,
    fontSize: `${terminal.options.fontSize}px`,
    lineHeight: `${height}px`,
    zIndex: "5",
  });
}

function hideGhosttyTextarea(textarea: HTMLTextAreaElement): void {
  Object.assign(textarea.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    color: "transparent",
    background: "transparent",
    caretColor: "transparent",
    overflow: "hidden",
    zIndex: "",
  });
}

type BufferCell = {
  getChars?(): string;
  getCodepoint?(): number;
  getWidth?(): number;
  isInvisible?(): boolean | number;
  cell?: { readonly grapheme_len?: number };
};

interface TerminalBufferCellText {
  readonly text: string;
  readonly column: number;
  readonly width: number;
  readonly absoluteRow: number;
}

interface TerminalBufferRow {
  readonly text: string;
  readonly cells: readonly TerminalBufferCellText[];
  readonly wrapped: boolean;
}

interface TerminalSearchRange {
  readonly offset: number;
  readonly start: { readonly column: number; readonly absoluteRow: number };
  readonly end: { readonly column: number; readonly absoluteRow: number };
}

function findTerminalSearchRanges(
  rows: readonly TerminalBufferRow[],
  foldedNeedle: string,
): readonly TerminalSearchRange[] {
  let sourceText = "";
  const foldedCells: Array<TerminalBufferCellText | undefined> = [];
  const sourceSpans: Array<{
    readonly start: number;
    readonly end: number;
    readonly cell?: TerminalBufferCellText;
  }> = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (rowIndex > 0 && !row.wrapped) {
      const start = sourceText.length;
      sourceText += "\n";
      sourceSpans.push({ start, end: sourceText.length });
      foldedCells.push(undefined);
    }
    for (const cell of row.cells) {
      const start = sourceText.length;
      sourceText += cell.text;
      sourceSpans.push({ start, end: sourceText.length, cell });
      const folded = cell.text.toLocaleLowerCase();
      for (let index = 0; index < folded.length; index += 1) {
        foldedCells.push(cell);
      }
    }
  }
  const foldedText = sourceText.toLocaleLowerCase();
  const mappedCells =
    foldedCells.length === foldedText.length
      ? foldedCells
      : mapFoldedOffsets(sourceText, sourceSpans, foldedText.length);
  const ranges: TerminalSearchRange[] = [];
  let offset = foldedText.indexOf(foldedNeedle);
  while (offset >= 0) {
    const first = mappedCells[offset];
    const last = mappedCells[offset + foldedNeedle.length - 1];
    if (first && last) {
      ranges.push({
        offset,
        start: { column: first.column, absoluteRow: first.absoluteRow },
        end: {
          column: last.column + last.width - 1,
          absoluteRow: last.absoluteRow,
        },
      });
    }
    offset = foldedText.indexOf(foldedNeedle, offset + 1);
  }
  return ranges;
}

function mapFoldedOffsets(
  sourceText: string,
  sourceSpans: readonly {
    readonly start: number;
    readonly end: number;
    readonly cell?: TerminalBufferCellText;
  }[],
  foldedLength: number,
): Array<TerminalBufferCellText | undefined> {
  const mapped = new Array<TerminalBufferCellText | undefined>(foldedLength);
  for (const span of sourceSpans) {
    const foldedStart = sourceText
      .slice(0, span.start)
      .toLocaleLowerCase().length;
    const foldedEnd = sourceText.slice(0, span.end).toLocaleLowerCase().length;
    mapped.fill(span.cell, foldedStart, foldedEnd);
  }
  return mapped;
}

function terminalBufferRows(
  terminal: Pick<Terminal, "buffer"> &
    Partial<Pick<Terminal, "wasmTerm" | "getScrollbackLength">>,
): TerminalBufferRow[] {
  const buffer = terminal.buffer.active;
  const scrollbackLength = terminal.getScrollbackLength?.() ?? 0;
  const rows: TerminalBufferRow[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    const cells: TerminalBufferCellText[] = [];
    for (let column = 0; line && column < line.length; column += 1) {
      const cell = line.getCell(column) as BufferCell | undefined;
      const width = cell?.getWidth?.() ?? 1;
      if (width === 0) continue;
      const text = terminalCellText(
        terminal,
        buffer.type,
        scrollbackLength,
        row,
        column,
        cell,
      );
      cells.push({ text, column, width, absoluteRow: row });
    }
    while (cells.at(-1)?.text === " ") cells.pop();
    rows.push({
      text: cells.map((cell) => cell.text).join(""),
      cells,
      wrapped: Boolean(
        (line as { readonly isWrapped?: boolean } | undefined)?.isWrapped,
      ),
    });
  }
  while (rows.at(-1)?.text === "") rows.pop();
  return rows;
}

function terminalCellText(
  terminal: Partial<Pick<Terminal, "wasmTerm">>,
  bufferType: string,
  scrollbackLength: number,
  row: number,
  column: number,
  cell: BufferCell | undefined,
): string {
  if (cell?.isInvisible?.()) return " ";
  const chars = cell?.getChars?.();
  const codepoint = cell?.getCodepoint?.() ?? 0;
  const grapheme = cell?.cell?.grapheme_len
    ? bufferType === "alternate"
      ? terminal.wasmTerm?.getGraphemeString?.(row, column)
      : row < scrollbackLength
        ? terminal.wasmTerm?.getScrollbackGraphemeString?.(row, column)
        : terminal.wasmTerm?.getGraphemeString?.(row - scrollbackLength, column)
    : null;
  return (
    grapheme ||
    chars ||
    (codepoint >= 32 ? String.fromCodePoint(codepoint) : " ")
  );
}

export function terminalBufferLines(
  terminal: Pick<Terminal, "buffer"> &
    Partial<Pick<Terminal, "wasmTerm" | "getScrollbackLength">>,
): string[] {
  return terminalBufferRows(terminal).map((row) => row.text);
}
