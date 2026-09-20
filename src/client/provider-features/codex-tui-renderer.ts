import { installGhosttyRenderScheduling } from "../terminals/ghostty-render-scheduling.js";
import { isWindowsClient } from "../terminals/client-platform.js";
import type { ITheme, Terminal } from "ghostty-web";
import type { TerminalPreferences } from "../app/settings.js";
import { installTerminalTouchScroll } from "./codex-tui-touch-scroll.js";

export interface CodexTuiRenderer {
  mount(
    container: HTMLElement,
  ): Promise<{ readonly cols: number; readonly rows: number }>;
  write(data: Uint8Array): void;
  fit(): { readonly cols: number; readonly rows: number } | undefined;
  focus(): void;
  blur(): void;
  hasFocus(): boolean;
  setTheme(theme: CodexTuiTheme): void;
  setCursorBlink(enabled: boolean): void;
  onInput(callback: (data: string) => void): () => void;
  dispose(): void;
}

export type CodexTuiRendererFactory = () => CodexTuiRenderer;

export type CodexTuiTheme = "light" | "dark";

export const CODEX_TUI_PALETTES: Readonly<Record<CodexTuiTheme, ITheme>> =
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

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

export function browserCodexTuiRendererFactory(
  preferences: {
    readonly fontSize: number;
    readonly scrollback: number;
  },
  theme: CodexTuiTheme,
): CodexTuiRendererFactory {
  return () => new GhosttyCodexTuiRenderer(preferences, theme);
}

class GhosttyCodexTuiRenderer implements CodexTuiRenderer {
  readonly #preferences: Pick<TerminalPreferences, "fontSize" | "scrollback">;
  #theme: CodexTuiTheme;
  #ghostty?: typeof import("ghostty-web");
  #container?: HTMLElement;
  #terminal?: import("ghostty-web").Terminal;
  #fitAddon?: import("ghostty-web").FitAddon;
  #inputCallback?: (data: string) => void;
  #inputDisposable?: { dispose(): void };
  #touchScrollCleanup?: () => void;
  #disposed = false;
  #cursorBlink = !isWindowsClient();
  #renderScheduling: ReturnType<typeof installGhosttyRenderScheduling> | undefined;

  constructor(preferences: Pick<TerminalPreferences, "fontSize" | "scrollback">, theme: CodexTuiTheme) {
    this.#preferences = preferences;
    this.#theme = theme;
  }

  async mount(
    container: HTMLElement,
  ): Promise<{ readonly cols: number; readonly rows: number }> {
    const ghostty = await import("ghostty-web");
    await ghostty.init();
    if (this.#disposed) throw new Error("The terminal renderer was disposed.");
    this.#ghostty = ghostty;
    this.#container = container;
    this.#createTerminal();
    const terminal = this.#terminal;
    if (!terminal)
      throw new Error("The terminal renderer could not be initialized.");
    return this.fit() ?? { cols: terminal.cols, rows: terminal.rows };
  }

  #createTerminal(): void {
    const ghostty = this.#ghostty;
    const container = this.#container;
    if (!ghostty || !container) return;
    this.#touchScrollCleanup?.();
    const terminal = new ghostty.Terminal({
      convertEol: false,
      cursorBlink: this.#cursorBlink,
      fontFamily: FONT_FAMILY,
      fontSize: this.#preferences.fontSize,
      scrollback: this.#preferences.scrollback,
      smoothScrollDuration: 0,
      theme: CODEX_TUI_PALETTES[this.#theme],
    });
    const fitAddon = new ghostty.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    this.#renderScheduling = installGhosttyRenderScheduling(terminal, isWindowsClient());
    // ghostty's open() marks the container contenteditable and focuses it,
    // which pops the mobile soft keyboard even when blurred in the same
    // task. Drop the editable marker and blur both focus targets (herdr-web
    // policy): the keyboard then opens only through a deliberate focus().
    container.removeAttribute("contenteditable");
    container.blur();
    terminal.textarea?.blur();
    if (terminal.renderer) {
      applyCanvasTheme(terminal.renderer, CODEX_TUI_PALETTES[this.#theme]);
    }
    this.#terminal = terminal;
    this.#fitAddon = fitAddon;
    if (this.#inputCallback) {
      this.#inputDisposable = terminal.onData(this.#inputCallback);
    }
    this.#touchScrollCleanup = installTerminalTouchScroll(
      container,
      {
        hasMouseTracking: () => terminal.hasMouseTracking(),
        isAlternateScreen: () =>
          (
            terminal as unknown as {
              wasmTerm?: { isAlternateScreen?: () => boolean };
            }
          ).wasmTerm?.isAlternateScreen?.() ?? false,
        scrollLines: (amount) => terminal.scrollLines(amount),
        renderer: terminal.renderer,
        ...(terminal.textarea ? { textarea: terminal.textarea } : {}),
      },
      (data) => this.#inputCallback?.(data),
    );
  }

  write(data: Uint8Array): void {
    this.#terminal?.write(data);
    this.#renderScheduling?.request();
  }

  fit(): { readonly cols: number; readonly rows: number } | undefined {
    const terminal = this.#terminal;
    if (!terminal) return undefined;
    this.#fitAddon?.fit();
    return { cols: terminal.cols, rows: terminal.rows };
  }

  focus(): void {
    // Focus the real text input (herdr-web policy): the container is no
    // longer contenteditable, so the textarea is the reliable key target.
    const textarea = this.#terminal?.textarea;
    if (textarea) textarea.focus({ preventScroll: true });
    else this.#terminal?.focus();
  }

  blur(): void {
    this.#terminal?.textarea?.blur();
    this.#container?.blur();
  }

  hasFocus(): boolean {
    return this.#container?.contains(document.activeElement) ?? false;
  }

  setCursorBlink(enabled: boolean): void {
    this.#cursorBlink = enabled;
    this.#renderScheduling?.setCursorBlink(enabled);
  }

  setTheme(theme: CodexTuiTheme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    if (!this.#terminal) return;
    // The recreated terminal starts blurred, so remember whether the old one
    // held keyboard focus and restore only that — never stealing focus from
    // the composer or another control on a theme flip.
    const hadFocus =
      this.#container?.contains(document.activeElement) ?? false;
    this.#inputDisposable = undefined;
    this.#renderScheduling?.dispose();
    this.#renderScheduling = undefined;
    this.#terminal.dispose();
    this.#terminal = undefined;
    this.#fitAddon = undefined;
    this.#createTerminal();
    this.fit();
    if (hadFocus) this.focus();
  }

  onInput(callback: (data: string) => void): () => void {
    this.#inputDisposable?.dispose();
    this.#inputCallback = callback;
    this.#inputDisposable = this.#terminal?.onData(callback);
    return () => {
      if (this.#inputCallback !== callback) return;
      this.#inputDisposable?.dispose();
      this.#inputDisposable = undefined;
      this.#inputCallback = undefined;
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#renderScheduling?.dispose();
    this.#renderScheduling = undefined;
    this.#touchScrollCleanup?.();
    this.#fitAddon?.dispose();
    this.#terminal?.dispose();
    this.#inputDisposable = undefined;
    this.#inputCallback = undefined;
    this.#fitAddon = undefined;
    this.#terminal = undefined;
    this.#container = undefined;
    this.#ghostty = undefined;
  }
}

function applyCanvasTheme(
  renderer: NonNullable<import("ghostty-web").Terminal["renderer"]>,
  palette: ITheme,
): void {
  renderer.getCanvas().style.backgroundColor =
    palette.background ?? "transparent";
  renderer.clear();
}
