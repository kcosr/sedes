/**
 * Historical read-only encoding. Sedes no longer writes a model-visible
 * boundary when it forks a conversation, but authenticated markers already
 * persisted by older releases must remain recognizable and hidden.
 */
export interface HistoricalForkContextBoundary {
  readonly kind: "fork_context_boundary";
  readonly version: 1;
  readonly content: string;
}

export const USER_FORK_CONTEXT_BOUNDARY_VERSION = 1 as const;

export const USER_FORK_CONTEXT_BOUNDARY_TEXT =
  "Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.\n\n" +
  "Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this conversation. The user may ask brief side questions, give you a new task, or explicitly ask you to continue the original task, but do not assume the original task is still in scope.";

export const USER_FORK_CONTEXT_BOUNDARY = Object.freeze({
  kind: "fork_context_boundary",
  version: USER_FORK_CONTEXT_BOUNDARY_VERSION,
  content: USER_FORK_CONTEXT_BOUNDARY_TEXT,
} as const satisfies HistoricalForkContextBoundary);
