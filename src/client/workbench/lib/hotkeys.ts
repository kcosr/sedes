/** Keyboard shortcut helpers. Combos: "mod+k", "/", "j", "shift+?", "escape". */
import { useEffect, useLayoutEffect, useRef } from "react";
import { hasBlockingLayer, isTypingTarget } from "./layers";

export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the platform modifier: "⌘" or "Ctrl". */
export const modKeyLabel: string = isMac ? "⌘" : "Ctrl";
/** Label for the command palette shortcut: "⌘K" or "Ctrl K". */
export const paletteShortcutLabel: string = isMac ? "⌘K" : "Ctrl K";

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  esc: "escape",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

/**
 * Does `e` match `combo`? "mod" is Ctrl or Cmd. Modifiers not named in the
 * combo must be up, except Shift for symbol keys ("?" needs Shift on most
 * layouts).
 */
export function matchesHotkey(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const raw = parts.pop();
  if (raw === undefined) return false;
  const want = raw === "" ? "+" : (KEY_ALIASES[raw] ?? raw);
  const mods = new Set(parts);
  const mod = mods.has("mod");
  const ctrl = mods.has("ctrl");
  const meta = mods.has("meta");
  if (mod) {
    if (!(e.ctrlKey || e.metaKey)) return false;
  } else {
    if (e.ctrlKey !== ctrl || e.metaKey !== meta) return false;
  }
  if (e.altKey !== mods.has("alt")) return false;
  const key = e.key.toLowerCase();
  const got = KEY_ALIASES[key] ?? key;
  if (got !== want) return false;
  if (mods.has("shift")) return e.shiftKey;
  return !(e.shiftKey && /^[a-z0-9]$/.test(want));
}

export interface HotkeyOptions {
  enabled?: boolean | undefined;
  /** Fire even while focus is in a text field (default false). */
  allowInInputs?: boolean | undefined;
  /** Fire even while a blocking layer (modal, palette, menu) is open (default false). */
  whenBlocked?: boolean | undefined;
  /** preventDefault() on match (default true). */
  preventDefault?: boolean | undefined;
}

/** Run `handler` when one of `combos` is pressed anywhere in the document. */
export function useHotkey(
  combos: string | readonly string[],
  handler: (e: KeyboardEvent) => void,
  options: HotkeyOptions = {},
): void {
  const {
    enabled = true,
    allowInInputs = false,
    whenBlocked = false,
    preventDefault = true,
  } = options;
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  const list = typeof combos === "string" ? [combos] : combos;
  const key = list.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const wanted = key.split("\n");
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!allowInInputs && isTypingTarget(document.activeElement)) return;
      if (!whenBlocked && hasBlockingLayer()) return;
      if (!wanted.some((c) => matchesHotkey(e, c))) return;
      if (preventDefault) e.preventDefault();
      ref.current(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, enabled, allowInInputs, whenBlocked, preventDefault]);
}

/** Ctrl/Cmd-K toggles the command palette, from anywhere (inputs and open layers included). */
export function useCommandPaletteHotkey(
  onToggle: () => void,
  enabled = true,
): void {
  useHotkey("mod+k", () => onToggle(), {
    enabled,
    allowInInputs: true,
    whenBlocked: true,
  });
}
