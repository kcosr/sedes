const VIEW_KEY_PREFIX = "sedes.codex-tui.view.v1:";

export function readCodexTuiView(threadId: string): "chat" | "tui" {
  try {
    return window.sessionStorage.getItem(`${VIEW_KEY_PREFIX}${threadId}`) ===
      "tui"
      ? "tui"
      : "chat";
  } catch {
    return "chat";
  }
}

export function writeCodexTuiView(
  threadId: string,
  view: "chat" | "tui",
): void {
  try {
    window.sessionStorage.setItem(`${VIEW_KEY_PREFIX}${threadId}`, view);
  } catch {
    // Viewer-local persistence must never make the thread unusable.
  }
}
