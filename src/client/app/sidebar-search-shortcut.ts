import {
  matchesKeyboardShortcut,
  SIDEBAR_SEARCH_FOCUS_COMMAND,
} from "./keyboard-shortcuts.js";

/** Marks the sidebar's thread search input; both sidebar copies carry it. */
export const SIDEBAR_SEARCH_ATTRIBUTE = "data-sidebar-search";

/** Frames to wait for a revealed sidebar or drawer to render its search. */
const REVEAL_FRAMES = 10;

/** The terminal emulator consumes every key it receives, so the shortcut is claimed before it. */
const TERMINAL_EMULATOR_SELECTOR = ".terminal-panel-emulator";

export interface SidebarSearchShortcutControls {
  /** False while the sidebar shows something other than the inventory, such as Settings. */
  readonly isAvailable: () => boolean;
  /** Expands a collapsed sidebar, or opens the drawer in the narrow layout. */
  readonly reveal: () => void;
  /** The navigation drawer is a dialog too, but the shortcut still belongs to it. */
  readonly drawerId: string;
}

/** Installs Ctrl+Shift+F (⌘⇧F): reveal the sidebar, then focus and select its search. */
export function installSidebarSearchShortcut(
  target: Window,
  controls: SidebarSearchShortcutControls,
): () => void {
  const claim = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return false;
    if (!matchesKeyboardShortcut(event, SIDEBAR_SEARCH_FOCUS_COMMAND.defaultBinding)) return false;
    if (!controls.isAvailable()) return false;
    // A dialog above the workbench keeps its keys.
    const dialog = event.target instanceof Element
      ? event.target.closest('[role="dialog"], [role="alertdialog"]')
      : null;
    if (dialog && dialog.id !== controls.drawerId) return false;
    event.preventDefault();
    controls.reveal();
    focusSidebarSearch(target);
    return true;
  };
  // A focused terminal swallows the chord before it bubbles, so take it there
  // during capture and keep it from reaching the shell. Elsewhere, bubbling
  // lets focused editors and widgets handle the key first.
  const onCapture = (event: KeyboardEvent) => {
    if (insideTerminal(event.target) && claim(event)) event.stopPropagation();
  };
  const onBubble = (event: KeyboardEvent) => {
    if (!insideTerminal(event.target)) claim(event);
  };
  target.addEventListener("keydown", onCapture, { capture: true });
  target.addEventListener("keydown", onBubble);
  return () => {
    target.removeEventListener("keydown", onCapture, { capture: true });
    target.removeEventListener("keydown", onBubble);
  };
}

function insideTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TERMINAL_EMULATOR_SELECTOR) !== null;
}

/**
 * Focuses and selects the rendered sidebar search. A revealed sidebar or drawer
 * renders on a later frame, so this waits a few frames for a visible input.
 */
export function focusSidebarSearch(target: Window, frames = REVEAL_FRAMES): void {
  const input = visibleSidebarSearch(target.document);
  if (input) {
    input.focus();
    input.select();
    return;
  }
  if (frames > 0) target.requestAnimationFrame(() => focusSidebarSearch(target, frames - 1));
}

function visibleSidebarSearch(document: Document): HTMLInputElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[${SIDEBAR_SEARCH_ATTRIBUTE}]`),
  ).find((input) =>
    input.isConnected &&
    input.getClientRects().length > 0 &&
    !input.closest('[inert], [hidden], [aria-hidden="true"]'));
}
