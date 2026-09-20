export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export const CODEX_NETWORK_ACCESS_VALUES = ["disabled", "enabled"] as const;
export const CODEX_APPROVAL_POLICIES = [
  "untrusted",
  "on-request",
  "never",
] as const;
export const CODEX_APPROVAL_REVIEWERS = ["user", "auto_review"] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexNetworkAccess =
  (typeof CODEX_NETWORK_ACCESS_VALUES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export type CodexApprovalReviewer = (typeof CODEX_APPROVAL_REVIEWERS)[number];

export interface CodexExecutionPolicySelection {
  readonly sandboxMode: CodexSandboxMode;
  readonly networkAccess: CodexNetworkAccess;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly approvalReviewer: CodexApprovalReviewer;
}

export interface CodexExecutionPolicyAllowlist {
  readonly allowedSandboxModes: readonly CodexSandboxMode[];
  readonly allowedNetworkAccess: readonly CodexNetworkAccess[];
  readonly allowedApprovalPolicies: readonly CodexApprovalPolicy[];
  readonly allowedApprovalReviewers: readonly CodexApprovalReviewer[];
}

type CodexSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: boolean }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: string[];
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: true;
      readonly excludeSlashTmp: true;
    };

type CodexThreadExecutionConfig = Readonly<
  Partial<
    Record<
      | "sandbox_workspace_write.network_access"
      | "sandbox_workspace_write.exclude_tmpdir_env_var"
      | "sandbox_workspace_write.exclude_slash_tmp",
      boolean
    >
  >
>;

export interface CodexProviderExecutionPolicy {
  readonly thread: {
    readonly sandbox: CodexSandboxMode;
    readonly approvalPolicy: CodexApprovalPolicy;
    readonly approvalsReviewer: CodexApprovalReviewer;
    readonly configOverrides: CodexThreadExecutionConfig;
  };
  readonly turn: {
    readonly sandboxPolicy: CodexSandboxPolicy;
    readonly approvalPolicy: CodexApprovalPolicy;
    readonly approvalsReviewer: CodexApprovalReviewer;
  };
}

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return includes(CODEX_SANDBOX_MODES, value);
}

export function isCodexNetworkAccess(
  value: unknown,
): value is CodexNetworkAccess {
  return includes(CODEX_NETWORK_ACCESS_VALUES, value);
}

export function isCodexApprovalPolicy(
  value: unknown,
): value is CodexApprovalPolicy {
  return includes(CODEX_APPROVAL_POLICIES, value);
}

export function isCodexApprovalReviewer(
  value: unknown,
): value is CodexApprovalReviewer {
  return includes(CODEX_APPROVAL_REVIEWERS, value);
}

export function normalizeCodexExecutionPolicySelection(
  selection: CodexExecutionPolicySelection,
): CodexExecutionPolicySelection {
  assertSelectionShape(selection);
  return selection.sandboxMode === "danger-full-access" &&
      selection.networkAccess !== "enabled"
    ? { ...selection, networkAccess: "enabled" }
    : selection;
}

export function assertCodexExecutionPolicySelection(
  selection: CodexExecutionPolicySelection,
): void {
  assertSelectionShape(selection);
  if (
    selection.sandboxMode === "danger-full-access" &&
    selection.networkAccess !== "enabled"
  ) {
    throw new Error("codex_execution_policy_combination_invalid");
  }
}

export function isCodexExecutionPolicyAllowed(
  selection: CodexExecutionPolicySelection,
  allowlist: CodexExecutionPolicyAllowlist,
): boolean {
  try {
    assertCodexExecutionPolicySelection(selection);
  } catch {
    return false;
  }
  return (
    allowlist.allowedSandboxModes.includes(selection.sandboxMode) &&
    allowlist.allowedNetworkAccess.includes(selection.networkAccess) &&
    allowlist.allowedApprovalPolicies.includes(selection.approvalPolicy) &&
    allowlist.allowedApprovalReviewers.includes(selection.approvalReviewer)
  );
}

export function hasAllowedCodexExecutionPolicySelection(
  allowlist: CodexExecutionPolicyAllowlist,
): boolean {
  return (
    allowlist.allowedApprovalPolicies.length > 0 &&
    allowlist.allowedApprovalReviewers.length > 0 &&
    allowlist.allowedSandboxModes.some((sandboxMode) =>
      allowlist.allowedNetworkAccess.some((networkAccess) =>
        isCodexExecutionPolicyAllowed(
          {
            sandboxMode,
            networkAccess,
            approvalPolicy: allowlist.allowedApprovalPolicies[0]!,
            approvalReviewer: allowlist.allowedApprovalReviewers[0]!,
          },
          allowlist,
        ),
      ),
    )
  );
}

export function codexExecutionPolicy(
  selection: CodexExecutionPolicySelection,
): CodexProviderExecutionPolicy {
  assertCodexExecutionPolicySelection(selection);
  const networkAccess = selection.networkAccess === "enabled";
  const threadConfigOverrides: CodexThreadExecutionConfig =
    selection.sandboxMode === "workspace-write"
      ? {
          "sandbox_workspace_write.network_access": networkAccess,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        }
      : {};
  const sandboxPolicy: CodexSandboxPolicy =
    selection.sandboxMode === "danger-full-access"
      ? { type: "dangerFullAccess" }
      : selection.sandboxMode === "read-only"
        ? { type: "readOnly", networkAccess }
        : {
            type: "workspaceWrite",
            // Codex always makes the thread cwd writable. This collection is
            // only for additional writable roots outside that workspace.
            writableRoots: [],
            networkAccess,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          };
  return {
    thread: {
      sandbox: selection.sandboxMode,
      approvalPolicy: selection.approvalPolicy,
      approvalsReviewer: selection.approvalReviewer,
      configOverrides: threadConfigOverrides,
    },
    turn: {
      sandboxPolicy,
      approvalPolicy: selection.approvalPolicy,
      approvalsReviewer: selection.approvalReviewer,
    },
  };
}

function assertSelectionShape(
  selection: CodexExecutionPolicySelection,
): void {
  if (
    !isCodexSandboxMode(selection.sandboxMode) ||
    !isCodexNetworkAccess(selection.networkAccess) ||
    !isCodexApprovalPolicy(selection.approvalPolicy) ||
    !isCodexApprovalReviewer(selection.approvalReviewer)
  ) {
    throw new Error("codex_execution_policy_invalid");
  }
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return (
    typeof value === "string" && values.includes(value as Values[number])
  );
}
