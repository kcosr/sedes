import type { CodexThread } from "./codex-c1-protocol.js";

export const CODEX_DISCOVERY_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const;

export function isCodexDiscoverableThread(
  thread: CodexThread,
  canonicalWorkspacePath: string,
): boolean {
  return (
    thread.cwd === canonicalWorkspacePath &&
    !thread.ephemeral &&
    thread.parentThreadId === null &&
    typeof thread.source === "string" &&
    CODEX_DISCOVERY_SOURCE_KINDS.includes(
      thread.source as (typeof CODEX_DISCOVERY_SOURCE_KINDS)[number],
    )
  );
}
