import { z } from "zod";

export const PAYLOAD_LIMITS = {
  displayTextCharacters: 4_096,
  textCharacters: 65_536,
  collectionEntries: 200,
  toolResultParts: 32,
  inlineImageBase64Characters: 1_400_000,
  inlineImageBytes: 1_048_576,
} as const;

export const MAXIMUM_BROWSER_ENTITY_BYTES = 512 * 1_024;
// Conversation messages are authoritative text, not display/tool previews.
// The complete serialized item and its containing page must also fit their
// independent limits; oversized messages are rejected, never shortened.
export const MAXIMUM_MESSAGE_TEXT_BYTES = 16 * 1_024 * 1_024;
export const MAXIMUM_MESSAGE_ITEM_BYTES = 16 * 1_024 * 1_024;
/**
 * Aggregate timeline limits are deliberately separate from the per-entity
 * browser limit. Backend IDs are replaced during normalization, so the
 * normalized representation receives bounded expansion headroom. The SSE
 * limit covers the complete wire frame, including event metadata.
 */
export const MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES = 16 * 1_024 * 1_024;
export const MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES = 32 * 1_024 * 1_024;
export const MAXIMUM_SSE_EVENT_BYTES = 36 * 1_024 * 1_024;

const utf8Encoder = new TextEncoder();

export function serializedUtf8Bytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

export function requireSerializedByteLimit(
  value: unknown,
  context: z.RefinementCtx,
  maximumBytes: number,
  message: string,
): void {
  if (serializedUtf8Bytes(value) > maximumBytes) {
    context.addIssue({ code: "custom", message });
  }
}

export const truncationInfoSchema = z.strictObject({
  truncated: z.literal(true),
  originalBytes: z.number().int().nonnegative().optional(),
  retainedBytes: z.number().int().nonnegative(),
  reason: z.enum([
    "byte_limit",
    "depth_limit",
    "entry_limit",
    "binary_omitted",
  ]),
});
export type TruncationInfo = z.infer<typeof truncationInfoSchema>;

export const boundedDisplayTextSchema = z.strictObject({
  text: z.string().max(PAYLOAD_LIMITS.displayTextCharacters),
  truncation: truncationInfoSchema.optional(),
});
export type BoundedDisplayText = z.infer<typeof boundedDisplayTextSchema>;

export const boundedTextSchema = z.strictObject({
  text: z.string().max(PAYLOAD_LIMITS.textCharacters),
  truncation: truncationInfoSchema.optional(),
});
export type BoundedText = z.infer<typeof boundedTextSchema>;

export const messageTextSchema = z
  .strictObject({ text: z.string().max(MAXIMUM_MESSAGE_TEXT_BYTES) })
  .superRefine((value, context) => {
    requireSerializedByteLimit(
      value,
      context,
      MAXIMUM_MESSAGE_TEXT_BYTES,
      "Message text exceeds the serialized byte limit.",
    );
  });
export type MessageText = z.infer<typeof messageTextSchema>;

export type BoundedValue =
  | null
  | boolean
  | number
  | BoundedText
  | {
      kind: "array";
      values: BoundedValue[];
      truncation?: TruncationInfo;
    }
  | {
      kind: "object";
      entries: Array<{ key: BoundedDisplayText; value: BoundedValue }>;
      truncation?: TruncationInfo;
    }
  | { kind: "redacted"; reason: "sensitive_key" }
  | {
      kind: "omitted";
      reason: "binary" | "cycle" | "unsupported";
    };

const boundedValueSchemaInternal: z.ZodType<BoundedValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    boundedTextSchema,
    z.strictObject({
      kind: z.literal("array"),
      values: z
        .array(boundedValueSchemaInternal)
        .max(PAYLOAD_LIMITS.collectionEntries),
      truncation: truncationInfoSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("object"),
      entries: z
        .array(
          z.strictObject({
            key: boundedDisplayTextSchema,
            value: boundedValueSchemaInternal,
          }),
        )
        .max(PAYLOAD_LIMITS.collectionEntries),
      truncation: truncationInfoSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("redacted"),
      reason: z.literal("sensitive_key"),
    }),
    z.strictObject({
      kind: z.literal("omitted"),
      reason: z.enum(["binary", "cycle", "unsupported"]),
    }),
  ]),
);

export const boundedValueSchema = boundedValueSchemaInternal;

export const allowedImageMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type AllowedImageMime = z.infer<typeof allowedImageMimeSchema>;

export const boundedToolResultContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    value: boundedTextSchema,
  }),
  z.strictObject({
    kind: z.literal("image_inline"),
    dataBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(PAYLOAD_LIMITS.inlineImageBase64Characters),
    mimeType: allowedImageMimeSchema,
    decodedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(PAYLOAD_LIMITS.inlineImageBytes),
  }),
  z.strictObject({
    kind: z.literal("image_omitted"),
    mimeType: allowedImageMimeSchema.optional(),
    reason: z.enum(["byte_limit", "unsupported_mime", "invalid_data"]),
  }),
]);
export type BoundedToolResultContent = z.infer<
  typeof boundedToolResultContentSchema
>;

export const boundedToolResultSchema = z.strictObject({
  content: z
    .array(boundedToolResultContentSchema)
    .max(PAYLOAD_LIMITS.toolResultParts),
  details: boundedValueSchema.optional(),
  isError: z.boolean(),
  truncation: truncationInfoSchema.optional(),
});
export type BoundedToolResult = z.infer<typeof boundedToolResultSchema>;

export const turnFailureSchema = z.strictObject({
  message: boundedDisplayTextSchema,
});
export type TurnFailure = z.infer<typeof turnFailureSchema>;

export const safeItemErrorSchema = z.strictObject({
  category: z.enum([
    "unavailable",
    "invalid_state",
    "permission_denied",
    "not_found",
    "rejected",
    "interrupted",
    "internal",
  ]),
  message: boundedDisplayTextSchema,
  code: z.string().min(1).max(120).optional(),
});
export type SafeItemError = z.infer<typeof safeItemErrorSchema>;

export const fileRangeSchema = z
  .strictObject({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((range) => range.endLine >= range.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });
export type FileRange = z.infer<typeof fileRangeSchema>;

export const unifiedDiffSchema = z.strictObject({
  text: boundedTextSchema,
});
export type UnifiedDiff = z.infer<typeof unifiedDiffSchema>;

const exactFileReplacementTextSchema = boundedTextSchema.refine(
  (value) => value.truncation === undefined,
  "File replacement text must be complete.",
);

/** Exact bounded before/after text for a replacement with no known file offset. */
export const fileReplacementSchema = z
  .strictObject({
    before: exactFileReplacementTextSchema,
    after: exactFileReplacementTextSchema,
  })
  .refine((replacement) => replacement.before.text !== replacement.after.text, {
    message: "File replacement before and after text must differ.",
    path: ["after"],
  });
export type FileReplacement = z.infer<typeof fileReplacementSchema>;

export function requireConsistentFileReplacement(
  value: {
    readonly operation: string;
    readonly path: BoundedDisplayText;
    readonly destinationPath?: BoundedDisplayText;
    readonly range?: FileRange;
    readonly diff?: UnifiedDiff;
    readonly contentPreview?: BoundedText;
    readonly replacement?: FileReplacement;
  },
  context: z.RefinementCtx,
): void {
  if (value.replacement === undefined) return;
  if (value.operation !== "edit") {
    context.addIssue({
      code: "custom",
      message: "Only file edits may carry an exact replacement.",
      path: ["replacement"],
    });
  }
  if (
    value.path.truncation !== undefined ||
    value.path.text.length === 0 ||
    value.path.text === "/dev/null" ||
    value.path.text.trim() !== value.path.text ||
    /[\0-\x1f\x7f]/u.test(value.path.text) ||
    value.destinationPath !== undefined ||
    value.range !== undefined ||
    value.diff !== undefined ||
    value.contentPreview !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message:
        "An exact file replacement must be the sole content carrier and cannot claim a path range or destination.",
      path: ["replacement"],
    });
  }
}

export const operationPhaseSchema = z.enum([
  "arguments_streaming",
  "arguments_complete",
  "preflight_or_executing",
  "result_streaming",
  "completed",
  "failed",
  "interrupted",
]);
export type OperationPhase = z.infer<typeof operationPhaseSchema>;

export const agentToolInvocationCorrelationSchema = z.strictObject({
  toolId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  schemaVersion: z.number().int().positive().max(1_000_000),
  invocationId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
});
export type AgentToolInvocationCorrelation = z.infer<
  typeof agentToolInvocationCorrelationSchema
>;
