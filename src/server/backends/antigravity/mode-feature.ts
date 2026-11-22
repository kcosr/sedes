import { z } from "zod";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";

export const ANTIGRAVITY_MODE_FEATURE_REF = Object.freeze({ featureId: "antigravity.mode", schemaVersion: 1 } as const);
export const ANTIGRAVITY_MODES = ["default", "accept-edits", "auto", "plan"] as const;
export type AntigravityMode = typeof ANTIGRAVITY_MODES[number];
export const ANTIGRAVITY_MODE_ACTIONS = Object.freeze({
  default: "set_mode_default", "accept-edits": "set_mode_accept_edits", auto: "set_mode_auto", plan: "set_mode_plan",
} as const satisfies Record<AntigravityMode, string>);
export const ANTIGRAVITY_KEEP_MODE_ACTION = "keep_native_mode";
export function antigravityModeForAction(actionId: string): AntigravityMode | null | undefined {
  return actionId === ANTIGRAVITY_KEEP_MODE_ACTION ? null : ANTIGRAVITY_MODES.find(mode => ANTIGRAVITY_MODE_ACTIONS[mode] === actionId);
}

const stateSchema = z.strictObject({ desiredMode: z.string().min(1).max(120).nullable(), application: z.literal("next_turn") });
export type AntigravityModeState = z.infer<typeof stateSchema>;
function operation(actionId: string, label: string) {
  return { actionId, label: { text: label }, argumentsSchema: z.null(),
    effects: { application: "write", modelUsage: "none", external: "none" }, confirmation: "none", execution: "inline" } as const;
}
export const antigravityModeFeatureModule = Object.freeze({
  ref: ANTIGRAVITY_MODE_FEATURE_REF, backendKind: "antigravity", kind: "stateful",
  label: { text: "Antigravity mode" }, description: { text: "Choose Antigravity's native mode for the next turn." },
  presentationSlots: ["thread_details"], stateSchema,
  projectState: (state: AntigravityModeState) => boundValue(state),
  operations: [operation(ANTIGRAVITY_KEEP_MODE_ACTION, "Keep native mode"),
    operation(ANTIGRAVITY_MODE_ACTIONS.default, "Default"), operation(ANTIGRAVITY_MODE_ACTIONS["accept-edits"], "Accept edits"),
    operation(ANTIGRAVITY_MODE_ACTIONS.auto, "Auto"), operation(ANTIGRAVITY_MODE_ACTIONS.plan, "Plan")],
} as const satisfies ProviderFeatureModule<AntigravityModeState>);
