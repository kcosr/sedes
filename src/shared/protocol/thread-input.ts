import { z } from "zod";
import { mutationIdSchema, threadIdSchema, applicationTurnIdSchema } from "./domain.js";
import { steerTargetSchema, threadRunStateSchema } from "./conversation.js";

/** Advisory playback attribution. Authentication never comes from this value. */
export const clientOriginSchema = z.strictObject({
  clientId: z.string().uuid(),
});
export type ClientOrigin = z.infer<typeof clientOriginSchema>;

export const MAX_DIRECT_INPUT_TEXT_BYTES = 65_536;
export const MAX_DIRECT_INPUT_REQUEST_BYTES = 524_288;

export const directInputRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  text: z.string().superRefine((text, context) => {
    if (text.trim().length === 0) {
      context.addIssue({ code: "custom", message: "Input must contain text." });
    }
    if (new TextEncoder().encode(text).byteLength > MAX_DIRECT_INPUT_TEXT_BYTES) {
      context.addIssue({ code: "custom", message: "Input exceeds the text byte limit." });
    }
  }),
  origin: clientOriginSchema,
  runningPolicy: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("queue") }),
    z.strictObject({
      mode: z.literal("steer"),
      target: steerTargetSchema,
      onUnavailable: z.literal("queue"),
    }),
  ]),
});
export type DirectInputRequest = z.infer<typeof directInputRequestSchema>;

const deliveryModeSchema = z.enum(["submit", "queue", "steer"]);

/** Immutable admission identity plus the current, independently evolving dispatch state. */
export const directInputReceiptSchema = z.strictObject({
  mutationId: mutationIdSchema,
  threadId: threadIdSchema,
  operationId: mutationIdSchema,
  admittedMode: deliveryModeSchema,
  queuedInputId: z.string().min(1).max(128).optional(),
  currentMode: deliveryModeSchema,
  status: z.enum(["queued", "submitting", "accepted", "recovery_required", "failed", "cancelled"]),
  diagnostic: z.string().min(1).max(500).optional(),
});
export type DirectInputReceipt = z.infer<typeof directInputReceiptSchema>;

export const directInputReceiptLookupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), receipt: directInputReceiptSchema }),
  z.strictObject({ status: z.literal("notObserved") }),
]);
export type DirectInputReceiptLookup = z.infer<typeof directInputReceiptLookupSchema>;

export const threadInputContextSchema = z.strictObject({
  threadId: threadIdSchema,
  activityToken: z.string().min(1).max(160),
  authority: z.enum(["current", "unbound", "unavailable"]),
  runState: threadRunStateSchema.nullable(),
  sourceTurnId: applicationTurnIdSchema.optional(),
  automaticListenEligible: z.boolean(),
  steer: z.discriminatedUnion("availability", [
    z.strictObject({ availability: z.literal("available"), target: steerTargetSchema }),
    z.strictObject({ availability: z.literal("unsupported") }),
    z.strictObject({ availability: z.literal("unavailable") }),
  ]),
});
export type ThreadInputContext = z.infer<typeof threadInputContextSchema>;
