import { z } from "zod";
import type { BoundedValue } from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";
import {
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
} from "./claude-permission-policy.js";

export const CLAUDE_PERMISSIONS_FEATURE_REF = Object.freeze({
  featureId: "claude.permissions",
  schemaVersion: 1,
} as const);

export const claudePermissionModeSchema = z.enum(CLAUDE_PERMISSION_MODES);

export const claudePermissionEffectiveStateSchema = z.enum([
  "unconfirmed",
  "confirmed",
  "unknown",
]);
export type ClaudePermissionEffectiveState = z.infer<
  typeof claudePermissionEffectiveStateSchema
>;

export const claudePermissionsStateV1Schema = z
  .object({
    desired: claudePermissionModeSchema.nullable(),
    effective: claudePermissionModeSchema.nullable(),
    effectiveState: claudePermissionEffectiveStateSchema,
  })
  .strict();
export type ClaudePermissionsStateV1 = z.infer<
  typeof claudePermissionsStateV1Schema
>;

export const CLAUDE_PERMISSION_ACTION_BY_MODE = Object.freeze({
  default: "set_permission_default",
  acceptEdits: "set_permission_accept_edits",
  dontAsk: "set_permission_dont_ask",
  auto: "set_permission_auto",
  bypassPermissions: "set_permission_bypass",
} as const satisfies Readonly<Record<ClaudePermissionMode, string>>);

export function claudePermissionModeForAction(
  actionId: string,
): ClaudePermissionMode | undefined {
  return CLAUDE_PERMISSION_MODES.find(
    (mode) => CLAUDE_PERMISSION_ACTION_BY_MODE[mode] === actionId,
  );
}

export function claudePermissionActionIds(
  modes: readonly ClaudePermissionMode[],
): readonly string[] {
  return modes.map((mode) => CLAUDE_PERMISSION_ACTION_BY_MODE[mode]);
}

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

export const claudePermissionsFeatureModule = Object.freeze({
  ref: CLAUDE_PERMISSIONS_FEATURE_REF,
  backendKind: "claude_agent_sdk",
  kind: "stateful",
  label: { text: "Claude permissions" },
  description: {
    text: "Controls Claude's native permission mode for the next turn.",
  },
  presentationSlots: ["thread_details"],
  stateSchema: claudePermissionsStateV1Schema,
  projectState(state: ClaudePermissionsStateV1): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation("set_permission_default", "Use default permissions"),
    operation("set_permission_accept_edits", "Accept file edits"),
    operation("set_permission_dont_ask", "Deny unapproved tools"),
    operation("set_permission_auto", "Use automatic permissions"),
    operation("set_permission_bypass", "Bypass permissions"),
  ],
} as const satisfies ProviderFeatureModule<ClaudePermissionsStateV1>);
