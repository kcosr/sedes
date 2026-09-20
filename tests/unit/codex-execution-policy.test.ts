import { describe, expect, it } from "vitest";
import {
  assertCodexExecutionPolicySelection,
  codexExecutionPolicy,
  hasAllowedCodexExecutionPolicySelection,
  isCodexExecutionPolicyAllowed,
  normalizeCodexExecutionPolicySelection,
} from "../../src/server/backends/codex/codex-execution-policy.js";

const allowlist = {
  allowedSandboxModes: [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} as const;

describe("Codex execution policy", () => {
  it("maps every independent axis to exact thread and turn parameters", () => {
    expect(
      codexExecutionPolicy({
        sandboxMode: "workspace-write",
        networkAccess: "enabled",
        approvalPolicy: "untrusted",
        approvalReviewer: "auto_review",
      }),
    ).toEqual({
      thread: {
        sandbox: "workspace-write",
        approvalPolicy: "untrusted",
        approvalsReviewer: "auto_review",
        configOverrides: {
          "sandbox_workspace_write.network_access": true,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      },
      turn: {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        approvalPolicy: "untrusted",
        approvalsReviewer: "auto_review",
      },
    });
    expect(
      codexExecutionPolicy({
        sandboxMode: "read-only",
        networkAccess: "disabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
      }).turn.sandboxPolicy,
    ).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(
      codexExecutionPolicy({
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
      }).thread.configOverrides,
    ).toEqual({
      "sandbox_workspace_write.network_access": false,
      "sandbox_workspace_write.exclude_tmpdir_env_var": true,
      "sandbox_workspace_write.exclude_slash_tmp": true,
    });
  });

  it("normalizes unrestricted to enabled network and rejects the noncanonical tuple", () => {
    const invalid = {
      sandboxMode: "danger-full-access",
      networkAccess: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    } as const;
    expect(normalizeCodexExecutionPolicySelection(invalid)).toEqual({
      ...invalid,
      networkAccess: "enabled",
    });
    expect(() => assertCodexExecutionPolicySelection(invalid)).toThrow(
      "codex_execution_policy_combination_invalid",
    );
    expect(isCodexExecutionPolicyAllowed(invalid, allowlist)).toBe(false);
  });

  it("intersects all four provider axes with the deployment ceiling", () => {
    expect(isCodexExecutionPolicyAllowed({
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
    }, allowlist)).toBe(true);
    expect(isCodexExecutionPolicyAllowed({
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
      approvalReviewer: "auto_review",
    }, { ...allowlist, allowedApprovalReviewers: ["user"] })).toBe(false);
    expect(hasAllowedCodexExecutionPolicySelection(allowlist)).toBe(true);
    expect(hasAllowedCodexExecutionPolicySelection({
      ...allowlist,
      allowedSandboxModes: ["danger-full-access"],
      allowedNetworkAccess: ["disabled"],
    })).toBe(false);
  });
});
