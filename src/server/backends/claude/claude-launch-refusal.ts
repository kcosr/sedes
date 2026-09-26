import { isClaudeRuntimeReleaseFailure } from "./claude-release-guard.js";

/**
 * Worker error code for a start that failed before the Claude Code query was
 * created, suffixed with its {@link ClaudeLaunchRefusal}.
 */
export const CLAUDE_QUERY_NOT_LAUNCHED_CODE_PREFIX =
  "claude_runtime_query_not_launched";

/** Why a start stopped before launching: CLI version, login, or anything else. */
export type ClaudeLaunchRefusal = "version" | "login" | "unavailable";

export function claudeLaunchRefusal(error: unknown): ClaudeLaunchRefusal {
  if (isClaudeRuntimeReleaseFailure(error)) return "version";
  if (
    error instanceof Error &&
    error.message === "claude_subscription_auth_unavailable"
  ) {
    return "login";
  }
  return "unavailable";
}
