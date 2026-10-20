/**
 * Codex-native execution settings as observed on a thread, and the exact
 * comparisons the conversation handle uses to decide whether an observation,
 * desired tuple, or speed projection changed.
 */
import { isRecord } from "../../../shared/json-guards.js";
import {
  isCodexApprovalPolicy,
  isCodexApprovalReviewer,
  type CodexApprovalPolicy,
  type CodexApprovalReviewer,
  type CodexNetworkAccess,
  type CodexSandboxMode,
} from "./codex-execution-policy.js";
import type { CodexFastModeProjection } from "./codex-fast-mode-session.js";
import {
  decodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";
import type { CodexExecutionSettingsTuple } from "./codex-thread-execution-settings-repository.js";

interface CodexObservedExecutionSettingsBase {
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: CodexServiceTierSelection | null;
  readonly serviceTierClassification: "recognized" | "external_custom";
  readonly sandboxMode: CodexSandboxMode | null;
  readonly sandboxClassification: "recognized" | "external_custom";
  readonly networkAccess: CodexNetworkAccess | null;
  readonly networkClassification: "recognized" | "external_custom";
  readonly approvalPolicy: CodexApprovalPolicy | null;
  readonly approvalPolicyClassification: "recognized" | "external_custom";
  readonly approvalReviewer: CodexApprovalReviewer | null;
  readonly approvalReviewerClassification: "recognized" | "external_custom";
}

export type CodexObservedExecutionSettings =
  CodexObservedExecutionSettingsBase & {
    readonly policyObservation: "complete" | "incomplete";
  };

export type CodexSettingsObservationReceipt = {
  readonly generation: number;
  readonly inboundSequence: number;
  readonly modelProvider: string;
  readonly settings: CodexObservedExecutionSettings;
};

export function codexObservedExecutionSettings(
  model: string,
  reasoningEffort: string | null,
  nativeServiceTier: string | null,
  approvalPolicy: unknown,
  approvalsReviewer: unknown,
  sandboxPolicy: unknown,
): CodexObservedExecutionSettings {
  const sandbox = observedSandboxPolicy(sandboxPolicy);
  const observedApprovalPolicy = isCodexApprovalPolicy(approvalPolicy)
    ? approvalPolicy
    : null;
  const observedApprovalReviewer = isCodexApprovalReviewer(approvalsReviewer)
    ? approvalsReviewer
    : null;
  const serviceTier = decodeCodexServiceTier(nativeServiceTier);
  return {
    model,
    reasoningEffort,
    serviceTier: serviceTier ?? null,
    serviceTierClassification:
      serviceTier === undefined ? "external_custom" : "recognized",
    ...sandbox,
    approvalPolicy: observedApprovalPolicy,
    approvalPolicyClassification:
      observedApprovalPolicy === null ? "external_custom" : "recognized",
    approvalReviewer: observedApprovalReviewer,
    approvalReviewerClassification:
      observedApprovalReviewer === null ? "external_custom" : "recognized",
    policyObservation: "complete",
  };
}

export function codexObservedThreadExecutionSettings(
  model: string,
  reasoningEffort: string | null,
  nativeServiceTier: string | null,
  approvalPolicy: unknown,
  approvalsReviewer: unknown,
  sandboxPolicy: unknown,
): CodexObservedExecutionSettings {
  return {
    ...codexObservedExecutionSettings(
      model,
      reasoningEffort,
      nativeServiceTier,
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy,
    ),
    policyObservation: "complete",
  };
}

function observedSandboxPolicy(
  sandboxPolicy: unknown,
): Pick<
  CodexObservedExecutionSettingsBase,
  | "sandboxMode"
  | "sandboxClassification"
  | "networkAccess"
  | "networkClassification"
> {
  if (!isRecord(sandboxPolicy) || typeof sandboxPolicy.type !== "string") {
    return externalSandboxObservation();
  }
  if (sandboxPolicy.type === "dangerFullAccess") {
    return {
      sandboxMode: "danger-full-access",
      sandboxClassification: "recognized",
      networkAccess: "enabled",
      networkClassification: "recognized",
    };
  }
  if (
    sandboxPolicy.type === "readOnly" &&
    typeof sandboxPolicy.networkAccess === "boolean"
  ) {
    return {
      sandboxMode: "read-only",
      sandboxClassification: "recognized",
      networkAccess: observedNetworkAccess(sandboxPolicy.networkAccess),
      networkClassification: "recognized",
    };
  }
  if (
    sandboxPolicy.type === "workspaceWrite" &&
    typeof sandboxPolicy.networkAccess === "boolean"
  ) {
    const sandboxRecognized =
      Array.isArray(sandboxPolicy.writableRoots) &&
      sandboxPolicy.writableRoots.length === 0 &&
      sandboxPolicy.excludeTmpdirEnvVar === true &&
      sandboxPolicy.excludeSlashTmp === true;
    return {
      sandboxMode: sandboxRecognized ? "workspace-write" : null,
      sandboxClassification: sandboxRecognized
        ? "recognized"
        : "external_custom",
      networkAccess: observedNetworkAccess(sandboxPolicy.networkAccess),
      networkClassification: "recognized",
    };
  }
  if (sandboxPolicy.type === "externalSandbox") {
    // External `restricted` is not equivalent to Sedes's disabled boolean;
    // an explicit native `enabled` value is still independently recognizable.
    const enabled = sandboxPolicy.networkAccess === "enabled";
    return {
      sandboxMode: null,
      sandboxClassification: "external_custom",
      networkAccess: enabled ? "enabled" : null,
      networkClassification: enabled ? "recognized" : "external_custom",
    };
  }
  return externalSandboxObservation();
}

function externalSandboxObservation(): Pick<
  CodexObservedExecutionSettingsBase,
  | "sandboxMode"
  | "sandboxClassification"
  | "networkAccess"
  | "networkClassification"
> {
  return {
    sandboxMode: null,
    sandboxClassification: "external_custom",
    networkAccess: null,
    networkClassification: "external_custom",
  };
}

function observedNetworkAccess(value: boolean): CodexNetworkAccess {
  return value ? "enabled" : "disabled";
}

export function importedDesiredSettings(
  observed: CodexObservedExecutionSettings,
  reasoningEffort: string | undefined,
  retainedServiceTier?: CodexServiceTierSelection,
): CodexExecutionSettingsTuple | undefined {
  if (
    reasoningEffort === undefined ||
    observed.policyObservation !== "complete" ||
    observed.sandboxClassification !== "recognized" ||
    observed.sandboxMode === null ||
    observed.networkClassification !== "recognized" ||
    observed.networkAccess === null ||
    observed.approvalPolicyClassification !== "recognized" ||
    observed.approvalPolicy === null ||
    observed.approvalReviewerClassification !== "recognized" ||
    observed.approvalReviewer === null ||
    observed.serviceTierClassification !== "recognized" ||
    observed.serviceTier === null
  ) {
    return undefined;
  }
  return {
    model: observed.model,
    reasoningEffort,
    serviceTier: retainedServiceTier ?? observed.serviceTier,
    sandboxMode: observed.sandboxMode,
    networkAccess: observed.networkAccess,
    approvalPolicy: observed.approvalPolicy,
    approvalReviewer: observed.approvalReviewer,
  };
}

export function sameSettingsObservation(
  left: CodexSettingsObservationReceipt,
  right: CodexSettingsObservationReceipt,
): boolean {
  return (
    left.modelProvider === right.modelProvider &&
    left.settings.model === right.settings.model &&
    left.settings.reasoningEffort === right.settings.reasoningEffort &&
    left.settings.serviceTier === right.settings.serviceTier &&
    left.settings.serviceTierClassification ===
      right.settings.serviceTierClassification &&
    left.settings.sandboxMode === right.settings.sandboxMode &&
    left.settings.sandboxClassification ===
      right.settings.sandboxClassification &&
    left.settings.networkAccess === right.settings.networkAccess &&
    left.settings.networkClassification ===
      right.settings.networkClassification &&
    left.settings.approvalPolicy === right.settings.approvalPolicy &&
    left.settings.approvalPolicyClassification ===
      right.settings.approvalPolicyClassification &&
    left.settings.approvalReviewer === right.settings.approvalReviewer &&
    left.settings.approvalReviewerClassification ===
      right.settings.approvalReviewerClassification &&
    left.settings.policyObservation === right.settings.policyObservation
  );
}

export function sameDesiredSettings(
  left: CodexExecutionSettingsTuple,
  right: CodexExecutionSettingsTuple,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.sandboxMode === right.sandboxMode &&
    left.networkAccess === right.networkAccess &&
    left.approvalPolicy === right.approvalPolicy &&
    left.approvalReviewer === right.approvalReviewer
  );
}

export function sameProjection(
  left: CodexFastModeProjection | undefined,
  right: CodexFastModeProjection | undefined,
): boolean {
  return (
    left?.revision === right?.revision &&
    left?.fastEnabled === right?.fastEnabled &&
    left?.ultrafastEnabled === right?.ultrafastEnabled &&
    left?.availability === right?.availability &&
    left?.unavailableReason === right?.unavailableReason
  );
}

/** A desired tuple and whether its tier may be written natively now. */
export type CodexServiceTierResolution = {
  readonly desired: CodexExecutionSettingsTuple | null;
  readonly writable: boolean;
};

export function sameExecutionSettingsTuple(
  left: CodexExecutionSettingsTuple,
  right: CodexExecutionSettingsTuple,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.sandboxMode === right.sandboxMode &&
    left.networkAccess === right.networkAccess &&
    left.approvalPolicy === right.approvalPolicy &&
    left.approvalReviewer === right.approvalReviewer
  );
}

export function sameSpeedPolicyProjection(
  current: CodexFastModeProjection | undefined,
  recovered: CodexFastModeProjection,
): boolean {
  return (
    sameProjection(current, recovered) &&
    (current?.availability === "available" || current?.unavailableReason === "feature_disabled")
  );
}
