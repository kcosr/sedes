import { describe, expect, it } from "vitest";
import { codexForkSettingsEligibility } from "../../src/server/backends/codex/codex-fork-settings-eligibility.js";
import type { CodexThreadExecutionSettingsRecord } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";

const executionPolicy = {
  allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} as const;

function record(
  overrides: Partial<CodexThreadExecutionSettingsRecord> = {},
): CodexThreadExecutionSettingsRecord {
  return {
    tenantId: "tenant",
    ownerPrincipalId: "principal",
    applicationThreadId: "thread",
    desired: null,
    effective: {
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      serviceTierClassification: "recognized",
      sandboxMode: "workspace-write",
      sandboxClassification: "recognized",
      networkAccess: "disabled",
      networkClassification: "recognized",
      approvalPolicy: "on-request",
      approvalPolicyClassification: "recognized",
      approvalReviewer: "user",
      approvalReviewerClassification: "recognized",
    },
    effectiveDaemonGeneration: 3,
    effectiveConfirmationState: "confirmed",
    revision: 7,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("Codex fork settings eligibility", () => {
  it("returns the exact complete confirmed tuple", () => {
    expect(codexForkSettingsEligibility(record(), executionPolicy)).toEqual({
      availability: "available",
      settingsRevision: 7,
      settings: {
        model: "gpt-5.6",
        reasoningEffort: "low",
        serviceTier: "standard",
        sandboxMode: "workspace-write",
        networkAccess: "disabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
      },
    });
  });

  it("fails closed before current-generation confirmation", () => {
    expect(codexForkSettingsEligibility(undefined, executionPolicy)).toEqual({
      availability: "unavailable",
      settingsRevision: 0,
      reason: "confirmation_unavailable",
    });
    expect(
      codexForkSettingsEligibility(
        record({ effectiveConfirmationState: "unknown", revision: 8 }),
        executionPolicy,
      ),
    ).toEqual({
      availability: "unavailable",
      settingsRevision: 8,
      reason: "confirmation_unavailable",
    });
  });

  it("rejects every external or incomplete effective axis", () => {
    const baseline = record();
    expect(
      codexForkSettingsEligibility(
        record({
          effective: {
            ...baseline.effective!,
            sandboxMode: null,
            sandboxClassification: "external_custom",
          },
          revision: 9,
        }),
        executionPolicy,
      ),
    ).toEqual({
      availability: "unavailable",
      settingsRevision: 9,
      reason: "external_custom",
    });
  });

  it("rejects a recognized tuple revoked by runtime policy", () => {
    expect(
      codexForkSettingsEligibility(record(), {
        ...executionPolicy,
        allowedSandboxModes: ["read-only"],
      }),
    ).toEqual({
      availability: "unavailable",
      settingsRevision: 7,
      reason: "policy_disallowed",
    });
  });
});
