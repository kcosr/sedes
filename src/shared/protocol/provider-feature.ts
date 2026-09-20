import { z } from "zod";
import {
  boundedDisplayTextSchema,
  boundedValueSchema,
  requireSerializedByteLimit,
} from "./payload.js";

export const MAXIMUM_PROVIDER_FEATURES_PER_THREAD = 32;
export const MAXIMUM_PROVIDER_FEATURE_ACTIONS = 32;
export const MAXIMUM_PROVIDER_FEATURE_ARGUMENT_BYTES = 64 * 1_024;
export const MAXIMUM_PROVIDER_FEATURE_STATE_BYTES = 128 * 1_024;
export const MAXIMUM_PROVIDER_FEATURE_CONVERSATION_ITEM_BYTES = 64 * 1_024;
export const MAXIMUM_PROVIDER_FEATURES_PER_CONVERSATION_ITEM = 4;

export const providerFeatureIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  );

export const providerFeatureActionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export const providerFeatureRefSchema = z.strictObject({
  featureId: providerFeatureIdSchema,
  schemaVersion: z.number().int().positive().max(1_000_000),
});
export type ProviderFeatureRef = z.infer<typeof providerFeatureRefSchema>;

export const providerFeatureAvailabilitySchema = z.enum([
  "available",
  "read_only",
  "unavailable",
]);
export type ProviderFeatureAvailability = z.infer<
  typeof providerFeatureAvailabilitySchema
>;

export const providerFeaturePresentationSlotSchema = z.enum([
  "thread_details",
  "composer_action",
  "conversation_item",
]);
export type ProviderFeaturePresentationSlot = z.infer<
  typeof providerFeaturePresentationSlotSchema
>;

export const providerFeatureEffectsSchema = z.strictObject({
  application: z.enum(["read", "write", "destructive"]),
  modelUsage: z.enum(["none", "agent_execution"]),
  external: z.enum(["none", "durable_side_effect"]),
});
export type ProviderFeatureEffects = z.infer<
  typeof providerFeatureEffectsSchema
>;

export const providerFeatureActionDescriptorSchema = z.strictObject({
  actionId: providerFeatureActionIdSchema,
  label: boundedDisplayTextSchema,
  effects: providerFeatureEffectsSchema,
  confirmation: z.enum(["none", "explicit"]),
  execution: z.enum(["inline", "durable"]),
});
export type ProviderFeatureActionDescriptor = z.infer<
  typeof providerFeatureActionDescriptorSchema
>;

export const providerFeatureCapabilitySchema = z
  .strictObject({
    ref: providerFeatureRefSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    label: boundedDisplayTextSchema,
    description: boundedDisplayTextSchema.optional(),
    availability: providerFeatureAvailabilitySchema,
    unavailableReason: boundedDisplayTextSchema.optional(),
    operations: z
      .array(providerFeatureActionDescriptorSchema)
      .max(MAXIMUM_PROVIDER_FEATURE_ACTIONS),
    presentationSlots: z.array(providerFeaturePresentationSlotSchema).max(4),
  })
  .superRefine((capability, context) => {
    requireUniqueStrings(
      capability.operations.map(({ actionId }) => actionId),
      context,
      ["operations"],
      "Provider feature action identifiers must be unique.",
    );
    requireUniqueStrings(
      capability.presentationSlots,
      context,
      ["presentationSlots"],
      "Provider feature presentation slots must be unique.",
    );
    if (
      capability.availability === "available" &&
      capability.unavailableReason !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An available provider feature cannot include an unavailable reason.",
        path: ["unavailableReason"],
      });
    }
  });
export type ProviderFeatureCapability = z.infer<
  typeof providerFeatureCapabilitySchema
>;

export const providerFeatureStateEnvelopeSchema = z
  .strictObject({
    ref: providerFeatureRefSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: boundedValueSchema,
  })
  .superRefine((envelope, context) => {
    requireSerializedByteLimit(
      envelope,
      context,
      MAXIMUM_PROVIDER_FEATURE_STATE_BYTES,
      "Provider feature state exceeds the browser-safe byte limit.",
    );
  });
export type ProviderFeatureStateEnvelope = z.infer<
  typeof providerFeatureStateEnvelopeSchema
>;

/**
 * Immutable item-scoped provider presentation. The schema version belongs to
 * the feature ref; unlike thread state, historical item presentation has no
 * mutable revision to reconcile with the current capability document.
 */
export const providerFeatureConversationItemEnvelopeSchema = z
  .strictObject({
    ref: providerFeatureRefSchema,
    payload: boundedValueSchema,
  })
  .superRefine((envelope, context) => {
    requireSerializedByteLimit(
      envelope,
      context,
      MAXIMUM_PROVIDER_FEATURE_CONVERSATION_ITEM_BYTES,
      "Provider feature conversation-item presentation exceeds the browser-safe byte limit.",
    );
  });
export type ProviderFeatureConversationItemEnvelope = z.infer<
  typeof providerFeatureConversationItemEnvelopeSchema
>;

export const providerFeatureArgumentsSchema = boundedValueSchema.superRefine(
  (argumentsValue, context) => {
    requireSerializedByteLimit(
      argumentsValue,
      context,
      MAXIMUM_PROVIDER_FEATURE_ARGUMENT_BYTES,
      "Provider feature arguments exceed the request byte limit.",
    );
  },
);

function requireUniqueStrings(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}
