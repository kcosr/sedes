import type { ApplicationClientState } from "../stores/ApplicationClientStore.js";

/** Includes loaded descendants which may be absent from the root inventory. */
export function findDefaultThread(state: ApplicationClientState, threadId: string | null | undefined) {
  if (!threadId) return undefined;
  return state.snapshot?.threads.find((thread) => thread.id === threadId)
    ?? state.visibleThreads.find((thread) => thread.id === threadId)
    ?? Object.values(state.descendantPages).flatMap((page) => page.descendants)
      .find(({ thread }) => thread.id === threadId)?.thread;
}

import { DEFAULT_THREAD_OPEN_COMMAND, matchesKeyboardShortcut } from "./keyboard-shortcuts.js";

/** The callback resolves the current selection at keypress time. */
export function installDefaultThreadShortcut(target: Window, open: () => void): () => void {
  const claim = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat ||
        !matchesKeyboardShortcut(event, DEFAULT_THREAD_OPEN_COMMAND.defaultBinding)) return;
    const dialog = event.target instanceof Element
      ? event.target.closest('[role="dialog"], [role="alertdialog"]') : null;
    if (dialog) return;
    event.preventDefault();
    open();
  };
  const terminal = (event: KeyboardEvent) => event.target instanceof Element &&
    event.target.closest(".terminal-panel-emulator") !== null;
  const capture = (event: KeyboardEvent) => {
    if (terminal(event)) { claim(event); if (event.defaultPrevented) event.stopPropagation(); }
  };
  const bubble = (event: KeyboardEvent) => { if (!terminal(event)) claim(event); };
  target.addEventListener("keydown", capture, true);
  target.addEventListener("keydown", bubble);
  return () => {
    target.removeEventListener("keydown", capture, true);
    target.removeEventListener("keydown", bubble);
  };
}
