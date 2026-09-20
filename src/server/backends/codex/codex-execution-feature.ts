import { z } from "zod";
import type { BoundedValue } from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";

export const CODEX_EXECUTION_FEATURE_REF = Object.freeze({
  featureId: "codex.execution",
  schemaVersion: 1,
} as const);

export const codexSandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export const codexNetworkAccessSchema = z.enum(["disabled", "enabled"]);
export const codexApprovalPolicySchema = z.enum([
  "untrusted",
  "on-request",
  "never",
]);
export const codexApprovalReviewerSchema = z.enum(["user", "auto_review"]);

const codexExecutionSelectionSchema = z
  .object({
    sandboxMode: codexSandboxModeSchema,
    networkAccess: codexNetworkAccessSchema,
    approvalPolicy: codexApprovalPolicySchema,
    approvalReviewer: codexApprovalReviewerSchema,
  })
  .strict();

const codexEffectiveExecutionSelectionSchema = z
  .object({
    sandboxMode: codexSandboxModeSchema.nullable(),
    networkAccess: codexNetworkAccessSchema.nullable(),
    approvalPolicy: codexApprovalPolicySchema.nullable(),
    approvalReviewer: codexApprovalReviewerSchema.nullable(),
  })
  .strict();

export const codexExecutionStateV1Schema = z
  .object({
    desired: codexExecutionSelectionSchema.nullable(),
    effective: codexEffectiveExecutionSelectionSchema.nullable(),
  })
  .strict();
export type CodexExecutionStateV1 = z.infer<typeof codexExecutionStateV1Schema>;

const emptyArgumentsSchema = z.null();

function operation(actionId: string, label: string) {
  return {
    actionId,
    label: { text: label },
    argumentsSchema: emptyArgumentsSchema,
    effects: {
      application: "write",
      modelUsage: "none",
      external: "none",
    },
    confirmation: "none",
    execution: "inline",
  } as const;
}

export const codexExecutionFeatureModule = Object.freeze({
  ref: CODEX_EXECUTION_FEATURE_REF,
  backendKind: "codex_app_server",
  kind: "stateful",
  label: { text: "Codex execution" },
  description: {
    text: "Controls the Codex sandbox, network, approval policy, and approval reviewer for the next turn.",
  },
  presentationSlots: ["thread_details"],
  stateSchema: codexExecutionStateV1Schema,
  projectState(state: CodexExecutionStateV1): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation("set_sandbox_read_only", "Use read-only sandbox"),
    operation("set_sandbox_workspace", "Use workspace sandbox"),
    operation("set_sandbox_unrestricted", "Use unrestricted sandbox"),
    operation("set_network_disabled", "Disable network"),
    operation("set_network_enabled", "Enable network"),
    operation("set_approval_untrusted", "Approve untrusted commands"),
    operation("set_approval_on_request", "Approve on request"),
    operation("set_approval_never", "Never request approval"),
    operation("set_reviewer_user", "Use user approval"),
    operation("set_reviewer_auto_review", "Use automatic review"),
  ],
} as const satisfies ProviderFeatureModule<CodexExecutionStateV1>);
