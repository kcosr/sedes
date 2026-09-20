import { z } from "zod";
import type { BoundedValue } from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";
import { codexServiceTierSelectionSchema } from "./codex-service-tier.js";

export {
  codexServiceTierSelectionSchema,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export const CODEX_FAST_MODE_FEATURE_REF = Object.freeze({
  featureId: "codex.fast_mode",
  schemaVersion: 1,
} as const);

export const codexFastModeStateV1Schema = z
  .object({
    desired: codexServiceTierSelectionSchema.nullable(),
    effective: codexServiceTierSelectionSchema.nullable(),
    applicationState: z.enum(["applied", "pending", "unknown"]),
  })
  .strict();
export type CodexFastModeStateV1 = z.infer<typeof codexFastModeStateV1Schema>;

const emptyArgumentsSchema = z.null();

function operation(actionId: "enable" | "disable", label: string) {
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

export const codexFastModeFeatureModule = Object.freeze({
  ref: CODEX_FAST_MODE_FEATURE_REF,
  backendKind: "codex_app_server",
  kind: "stateful",
  label: { text: "Fast mode" },
  description: {
    text: "Fast mode: about 1.5x speed, higher usage",
  },
  presentationSlots: ["composer_action"],
  stateSchema: codexFastModeStateV1Schema,
  projectState(state: CodexFastModeStateV1): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation("enable", "Enable Fast mode"),
    operation("disable", "Use Standard mode"),
  ],
} as const satisfies ProviderFeatureModule<CodexFastModeStateV1>);
