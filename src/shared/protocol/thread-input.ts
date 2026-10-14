import { z } from "zod";
import { mutationIdSchema, threadIdSchema, applicationTurnIdSchema } from "./domain.js";
import { steerTargetSchema, threadRunStateSchema } from "./conversation.js";
import { MAXIMUM_THREAD_INPUT_BYTES } from "./context-excerpts.js";
import { boundedDisplayTextSchema } from "./payload.js";
import { PAGE_RESPONSE_MAX_BYTES, pageResponseReferenceSchema } from "./pages.js";

/** Server-stamped input attribution from the registered client connection. This ID is never authentication. */
export const clientOriginSchema = z.strictObject({
  clientId: z.string().uuid(),
});
export type ClientOrigin = z.infer<typeof clientOriginSchema>;

// Every admitted byte may need six JSON bytes (for example, a control character).
export const MAX_DIRECT_INPUT_REQUEST_BYTES = 2_097_152;

const directInputFieldsSchema = z.strictObject({
  mutationId: mutationIdSchema,
  text: z.string().superRefine((text, context) => {
    if (text.trim().length === 0) {
      context.addIssue({ code: "custom", message: "Input must contain text." });
    }
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_THREAD_INPUT_BYTES) {
      context.addIssue({ code: "custom", message: "Input exceeds the text byte limit." });
    }
  }),
  origin: clientOriginSchema,
  pageResponse: pageResponseReferenceSchema.optional(),
  runningPolicy: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("queue") }),
    z.strictObject({
      mode: z.literal("steer"),
      target: steerTargetSchema,
      onUnavailable: z.literal("queue"),
    }),
  ]),
});
function validatePageResponse(
  input: z.infer<typeof directInputFieldsSchema> | Omit<z.infer<typeof directInputFieldsSchema>, "origin">,
  context: z.RefinementCtx,
): void {
  if (!input.pageResponse) return;
  if (input.runningPolicy.mode !== "queue") {
    context.addIssue({ code: "custom", path: ["runningPolicy"], message: "Page responses must queue while the thread is running." });
  }
  if (new TextEncoder().encode(input.text).byteLength > PAGE_RESPONSE_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["text"], message: "Page response exceeds the text byte limit." });
  }
}
/** The connection registry supplies origin; the browser cannot select it. */
export const directInputRequestBodySchema = directInputFieldsSchema.omit({ origin: true }).superRefine(validatePageResponse);
export const directInputRequestSchema = directInputFieldsSchema.superRefine(validatePageResponse);
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
  /** Current scoped display text; renames do not change activity authority. */
  threadTitle: boundedDisplayTextSchema.shape.text,
  activityToken: z.string().min(1).max(160),
  userInputRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  authority: z.enum(["current", "unbound", "unavailable"]),
  runState: threadRunStateSchema.nullable(),
  sourceTurnId: applicationTurnIdSchema.optional(),
  automaticListenEligible: z.boolean(),
  /** Local permission to capture new input; submission still validates current provider admission. */
  manualListenEligible: z.boolean(),
  steer: z.discriminatedUnion("availability", [
    z.strictObject({ availability: z.literal("available"), target: steerTargetSchema }),
    z.strictObject({ availability: z.literal("unsupported") }),
    z.strictObject({ availability: z.literal("unavailable") }),
  ]),
});
export type ThreadInputContext = z.infer<typeof threadInputContextSchema>;
