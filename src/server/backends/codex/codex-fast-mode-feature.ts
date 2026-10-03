import { z } from "zod";
import type { BoundedValue } from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type { ProviderFeatureModule } from "../../provider-features/contracts.js";
import {
  CODEX_ACCELERATED_SERVICE_TIERS,
  codexServiceTierSelectionSchema,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export {
  codexServiceTierSelectionSchema,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export const CODEX_FAST_MODE_FEATURE_REF = Object.freeze({
  featureId: "codex.fast_mode",
  schemaVersion: 2,
} as const);

export const CODEX_SPEED_TIER_DESCRIPTION_MAXIMUM_LENGTH = 240;

/**
 * `offered` lists the accelerated tiers the desired model advertises, in
 * Sedes order. Standard is always offered. Descriptions are bounded catalog
 * text.
 */
export const codexFastModeStateV2Schema = z
  .object({
    desired: codexServiceTierSelectionSchema.nullable(),
    effective: codexServiceTierSelectionSchema.nullable(),
    applicationState: z.enum(["applied", "pending", "unknown"]),
    offered: z
      .array(
        z
          .object({
            selection: z.enum(CODEX_ACCELERATED_SERVICE_TIERS),
            description: z
              .string()
              .min(1)
              .max(CODEX_SPEED_TIER_DESCRIPTION_MAXIMUM_LENGTH)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(CODEX_ACCELERATED_SERVICE_TIERS.length)
      .refine(
        (offered) =>
          offered.every(
            ({ selection }, index) =>
              index === 0 ||
              CODEX_ACCELERATED_SERVICE_TIERS.indexOf(
                offered[index - 1]!.selection,
              ) < CODEX_ACCELERATED_SERVICE_TIERS.indexOf(selection),
          ),
        "Offered speeds must be unique and in Sedes order.",
      ),
  })
  .strict();
export type CodexFastModeStateV2 = z.infer<typeof codexFastModeStateV2Schema>;

export const CODEX_SPEED_ACTION_BY_SELECTION = Object.freeze({
  standard: "set_standard",
  fast: "set_fast",
  ultrafast: "set_ultrafast",
} as const satisfies Record<CodexServiceTierSelection, string>);
export type CodexSpeedActionId =
  (typeof CODEX_SPEED_ACTION_BY_SELECTION)[CodexServiceTierSelection];

export function codexSpeedSelectionForAction(
  actionId: string,
): CodexServiceTierSelection | undefined {
  return (
    Object.entries(CODEX_SPEED_ACTION_BY_SELECTION) as [
      CodexServiceTierSelection,
      string,
    ][]
  ).find(([, candidate]) => candidate === actionId)?.[0];
}

const emptyArgumentsSchema = z.null();

function operation(actionId: CodexSpeedActionId, label: string) {
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
  label: { text: "Speed" },
  description: {
    text: "Faster speeds respond sooner and use more of your plan's usage",
  },
  presentationSlots: ["composer_action"],
  stateSchema: codexFastModeStateV2Schema,
  projectState(state: CodexFastModeStateV2): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation("set_standard", "Use Standard speed"),
    operation("set_fast", "Use Fast speed"),
    operation("set_ultrafast", "Use Ultrafast speed"),
  ],
} as const satisfies ProviderFeatureModule<CodexFastModeStateV2>);
