import { CODEX_SPEED_REF, speedArgumentsWireSchema, speedStateSchema, type SpeedState } from "../../../shared/provider-features/codex-speed.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";
export { codexServiceTierSelectionSchema, type CodexServiceTierSelection } from "./codex-service-tier.js";

export const CODEX_FAST_MODE_FEATURE_REF = CODEX_SPEED_REF;
export const CODEX_SPEED_TIER_DESCRIPTION_MAXIMUM_LENGTH = 240;
export const codexFastModeFeatureModule = Object.freeze({
  ref: CODEX_FAST_MODE_FEATURE_REF,
  backendKind: "codex_app_server",
  kind: "stateful",
  label: { text: "Speed" },
  description: { text: "Save Speed for future turns and request it from the next model step in the current turn. Faster speeds use more of your plan's usage." },
  presentationSlots: ["composer_action"],
  stateSchema: speedStateSchema,
  projectState: (state: SpeedState) => boundValue(state),
  operations: [{
    actionId: "set_speed", label: { text: "Set Speed" }, argumentsSchema: speedArgumentsWireSchema,
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
    confirmation: "none", execution: "inline",
  }],
} as const satisfies ProviderFeatureModule<SpeedState>);
