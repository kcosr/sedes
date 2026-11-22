import { DEFAULT_THREAD_OPEN_COMMAND, installThreadNavigationShortcut } from "./keyboard-shortcuts.js";
import { canUseDefaultThread } from "./default-thread.js";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { navigate, settingsPath } from "./router.js";
import { openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";

/** A refresh must not block navigation to an already-known available target. */
export function openDefaultThread(selection: {
  readonly thread?: NormalizedApplicationThreadSummary;
  readonly resolving?: boolean;
} | null): boolean {
  if (selection?.thread && canUseDefaultThread(selection.thread)) openThreadRoute(selection.thread.id);
  else if (selection?.resolving) return false;
  else navigate(settingsPath("general"));
  return true;
}

/** The callback resolves the current selection at keypress time. */
export function installDefaultThreadShortcut(target: Window, open: () => void): () => void {
  return installThreadNavigationShortcut(target, DEFAULT_THREAD_OPEN_COMMAND.defaultBinding, () => {
    open();
    return true;
  });
}
