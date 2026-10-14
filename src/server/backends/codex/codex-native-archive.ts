import { posix, win32 } from "node:path";
import type { CodexThread } from "./codex-c1-protocol.js";
import { CodexRpcRemoteError } from "./rpc/errors.js";

/** Installation-owned switch. Restoring previously archived threads must keep
 * working after an operator disables future native archive synchronization. */
export function readCodexNativeArchiveSyncEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.SEDES_CODEX_ARCHIVE_SYNC;
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEDES_CODEX_ARCHIVE_SYNC must be true or false.");
}

/** Codex 0.162.1 exposes archived state through the stored rollout location,
 * not an archived field on Thread. Its local archive puts rollouts directly
 * under CODEX_HOME/archived_sessions, on the execution host's path platform.
 * Keep this native storage interpretation out of shared inventory contracts. */
export function isCodexThreadArchived(thread: Pick<CodexThread, "path">): boolean {
  if (thread.path === null) return false;
  const paths = win32.isAbsolute(thread.path) && !posix.isAbsolute(thread.path)
    ? win32 : posix;
  return paths.basename(paths.dirname(thread.path)) === "archived_sessions";
}

/** Exact released read failures only: access failures and arbitrary remote
 * errors never become evidence that a conversation has disappeared. */
export function isCodexNativeArchiveThreadMissing(error: unknown, threadId: string): boolean {
  return error instanceof CodexRpcRemoteError && error.method === "thread/read" &&
    error.code === -32600 && [
      `thread not loaded: ${threadId}`,
      `thread not found: ${threadId}`,
      `no rollout found for thread id ${threadId}`,
    ].includes(error.message);
}

/** Read-only authority refreshes can outlive their caller; abandon the wait
 * at its deadline, and require the caller to recheck before any native effect. */
export async function waitForCodexArchiveInspection<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
  let rejectAborted!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation, aborted]);
  } finally { signal.removeEventListener("abort", abort); }
}
