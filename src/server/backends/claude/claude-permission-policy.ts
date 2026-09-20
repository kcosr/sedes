import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "dontAsk",
  "auto",
  "bypassPermissions",
] as const satisfies readonly Exclude<PermissionMode, "plan">[];

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export interface ClaudePermissionPolicy {
  readonly allowedModes: readonly ClaudePermissionMode[];
}

export function isClaudePermissionMode(
  value: unknown,
): value is ClaudePermissionMode {
  return (
    typeof value === "string" &&
    CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode)
  );
}

export function isClaudePermissionModeAllowed(
  mode: ClaudePermissionMode,
  policy: ClaudePermissionPolicy,
): boolean {
  return policy.allowedModes.includes(mode);
}

export function claudePermissionPolicyAllowsBypass(
  policy: ClaudePermissionPolicy,
): boolean {
  return policy.allowedModes.includes("bypassPermissions");
}
