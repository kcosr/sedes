import type {
  CodexExecutionSettingsTuple,
  CodexThreadExecutionSettingsRecord,
} from "./codex-thread-execution-settings-repository.js";
import {
  isCodexExecutionPolicyAllowed,
  type CodexExecutionPolicyAllowlist,
} from "./codex-execution-policy.js";

export type CodexForkSettingsEligibility =
  | {
      readonly availability: "available";
      readonly settingsRevision: number;
      readonly settings: CodexExecutionSettingsTuple;
    }
  | {
      readonly availability: "unavailable";
      readonly settingsRevision: number;
      readonly reason:
        | "confirmation_unavailable"
        | "external_custom"
        | "policy_disallowed";
    };

/**
 * One provider-private authority for whether Codex can inherit the complete
 * effective execution tuple into a fork child.
 */
export function codexForkSettingsEligibility(
  record: CodexThreadExecutionSettingsRecord | undefined,
  executionPolicy: CodexExecutionPolicyAllowlist,
): CodexForkSettingsEligibility {
  const settingsRevision = record?.revision ?? 0;
  const effective = record?.effective;
  if (
    !record ||
    record.effectiveConfirmationState !== "confirmed" ||
    !effective
  ) {
    return {
      availability: "unavailable",
      settingsRevision,
      reason: "confirmation_unavailable",
    };
  }
  if (
    effective.sandboxClassification !== "recognized" ||
    effective.serviceTierClassification !== "recognized" ||
    effective.networkClassification !== "recognized" ||
    effective.approvalPolicyClassification !== "recognized" ||
    effective.approvalReviewerClassification !== "recognized" ||
    effective.sandboxMode === null ||
    effective.serviceTier === null ||
    effective.networkAccess === null ||
    effective.approvalPolicy === null ||
    effective.approvalReviewer === null
  ) {
    return {
      availability: "unavailable",
      settingsRevision,
      reason: "external_custom",
    };
  }
  const settings = {
    model: effective.model,
    reasoningEffort: effective.reasoningEffort,
    serviceTier: effective.serviceTier,
    sandboxMode: effective.sandboxMode,
    networkAccess: effective.networkAccess,
    approvalPolicy: effective.approvalPolicy,
    approvalReviewer: effective.approvalReviewer,
  };
  if (!isCodexExecutionPolicyAllowed(settings, executionPolicy)) {
    return {
      availability: "unavailable",
      settingsRevision,
      reason: "policy_disallowed",
    };
  }
  return {
    availability: "available",
    settingsRevision,
    settings,
  };
}
