import { z } from "zod";
import { workspaceIdSchema } from "./domain.js";
import {
  workspaceFilePathSchema,
  workspaceFileRootIdSchema,
} from "./workspace-files.js";
import {
  workspaceDiffComparisonIdSchema,
  workspaceDiffFileIdSchema,
  workspaceDiffFingerprintSchema,
} from "./workspace-diffs.js";
import type { MaterializedTaskContext } from "./tasks.js";

export const MAXIMUM_CONTEXT_EXCERPTS = 16;
export const MAXIMUM_CONTEXT_EXCERPT_BYTES = 16 * 1_024;
export const MAXIMUM_CONTEXT_EXCERPT_NOTE_BYTES = 4 * 1_024;
export const MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES = 512;
export const MAXIMUM_CONTEXT_HEADING_ENTRIES = 16;
export const MAXIMUM_CONTEXT_HEADING_BYTES = 240;
export const MAXIMUM_CONTEXT_PROVENANCE_PATH_BYTES = 4_096;
export const MAXIMUM_COMPOSER_INPUT_BYTES = 262_144;

const encoder = new TextEncoder();

function hasAtMostUtf8Bytes(value: string, maximumBytes: number): boolean {
  return encoder.encode(value).byteLength <= maximumBytes;
}

function boundedUtf8String(maximumBytes: number, message: string) {
  return z
    .string()
    .refine((value) => hasAtMostUtf8Bytes(value, maximumBytes), { message });
}

const nonemptyBoundedUtf8String = (maximumBytes: number, message: string) =>
  boundedUtf8String(maximumBytes, message).refine((value) => value.length > 0, {
    message: "Value must not be empty.",
  });

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const contextProvenancePathSchema = nonemptyBoundedUtf8String(
  MAXIMUM_CONTEXT_PROVENANCE_PATH_BYTES,
  "Context provenance path exceeds the UTF-8 byte limit.",
).refine((value) => !value.includes("\0"), {
  message: "Context provenance paths must not contain NUL bytes.",
});

const workspaceFileContextSourceSchema = z.strictObject({
  kind: z.literal("workspace_file"),
  rootId: workspaceFileRootIdSchema,
  path: workspaceFilePathSchema,
  revision: z.string().min(1).max(160),
});

/**
 * Immutable display provenance copied from the server-returned Compare
 * snapshot at selection time. These fields make persisted context traceable;
 * they must never be reused as authority for a later repository operation.
 */
export const workspaceDiffContextSourceSchema = z
  .strictObject({
    kind: z.literal("workspace_diff"),
    workspaceId: workspaceIdSchema,
    rootId: workspaceFileRootIdSchema,
    comparisonId: workspaceDiffComparisonIdSchema,
    comparisonFingerprint: workspaceDiffFingerprintSchema,
    fileId: workspaceDiffFileIdSchema,
    oldPath: workspaceFilePathSchema.optional(),
    newPath: workspaceFilePathSchema.optional(),
  })
  .refine(
    (source) => source.oldPath !== undefined || source.newPath !== undefined,
    {
      message: "Workspace diff context requires an old or new display path.",
      path: ["newPath"],
    },
  );
export type WorkspaceDiffContextSource = z.infer<
  typeof workspaceDiffContextSourceSchema
>;

const conversationDiffContextSourceSchema = z.strictObject({
  kind: z.literal("conversation_diff"),
  itemId: z.string().min(1).max(160),
  itemRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  path: contextProvenancePathSchema,
  destinationPath: contextProvenancePathSchema.optional(),
});

const conversationMessageContextSourceSchema = z.strictObject({
  kind: z.literal("conversation_message"),
  itemId: z.string().min(1).max(160),
  itemRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const contextExcerptSourceSchema = z.discriminatedUnion("kind", [
  workspaceFileContextSourceSchema,
  workspaceDiffContextSourceSchema,
  conversationDiffContextSourceSchema,
  conversationMessageContextSourceSchema,
]);
export type ContextExcerptSource = z.infer<typeof contextExcerptSourceSchema>;

const lineRangeLocatorSchema = z
  .strictObject({
    kind: z.literal("line_range"),
    startLine: positiveSafeIntegerSchema,
    endLine: positiveSafeIntegerSchema,
  })
  .refine((range) => range.endLine >= range.startLine, {
    message: "Context line range must not run backwards.",
    path: ["endLine"],
  });

const diffLineEndpointSchema = z.strictObject({
  side: z.enum(["old", "new"]),
  line: positiveSafeIntegerSchema,
});

const diffLineRangeLocatorSchema = z
  .strictObject({
    kind: z.literal("diff_line_range"),
    start: diffLineEndpointSchema,
    end: diffLineEndpointSchema,
  })
  .refine(
    (range) =>
      range.start.side !== range.end.side || range.end.line >= range.start.line,
    {
      message: "Same-side context diff ranges must not run backwards.",
      path: ["end", "line"],
    },
  );

const textQuoteLocatorSchema = z
  .strictObject({
    kind: z.literal("text_quote"),
    prefix: boundedUtf8String(
      MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
      "Context quote prefix exceeds the UTF-8 byte limit.",
    ).optional(),
    suffix: boundedUtf8String(
      MAXIMUM_CONTEXT_QUOTE_AFFIX_BYTES,
      "Context quote suffix exceeds the UTF-8 byte limit.",
    ).optional(),
    headingTrail: z
      .array(
        nonemptyBoundedUtf8String(
          MAXIMUM_CONTEXT_HEADING_BYTES,
          "Context heading exceeds the UTF-8 byte limit.",
        ),
      )
      .max(MAXIMUM_CONTEXT_HEADING_ENTRIES)
      .optional(),
    sourceStartLine: positiveSafeIntegerSchema.optional(),
    sourceEndLine: positiveSafeIntegerSchema.optional(),
  })
  .superRefine((locator, context) => {
    if (
      (locator.sourceStartLine === undefined) !==
      (locator.sourceEndLine === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Context quote source line hints must be supplied together.",
        path: [
          locator.sourceStartLine === undefined
            ? "sourceStartLine"
            : "sourceEndLine",
        ],
      });
    }
    if (
      locator.sourceStartLine !== undefined &&
      locator.sourceEndLine !== undefined &&
      locator.sourceEndLine < locator.sourceStartLine
    ) {
      context.addIssue({
        code: "custom",
        message: "Context quote source line range must not run backwards.",
        path: ["sourceEndLine"],
      });
    }
  });

export const contextExcerptLocatorSchema = z.discriminatedUnion("kind", [
  lineRangeLocatorSchema,
  diffLineRangeLocatorSchema,
  textQuoteLocatorSchema,
]);
export type ContextExcerptLocator = z.infer<typeof contextExcerptLocatorSchema>;

export const contextExcerptSchema = z
  .strictObject({
    id: z.uuid(),
    excerpt: nonemptyBoundedUtf8String(
      MAXIMUM_CONTEXT_EXCERPT_BYTES,
      "Context excerpt exceeds the UTF-8 byte limit.",
    ),
    note: nonemptyBoundedUtf8String(
      MAXIMUM_CONTEXT_EXCERPT_NOTE_BYTES,
      "Context excerpt note exceeds the UTF-8 byte limit.",
    ).optional(),
    source: contextExcerptSourceSchema,
    locator: contextExcerptLocatorSchema,
  })
  .superRefine((excerpt, context) => {
    if (
      (excerpt.source.kind === "conversation_diff" ||
        excerpt.source.kind === "workspace_diff") &&
      excerpt.locator.kind !== "diff_line_range"
    ) {
      context.addIssue({
        code: "custom",
        message: "Diff excerpts require a diff line range.",
        path: ["locator"],
      });
    }
    if (
      excerpt.source.kind === "workspace_file" &&
      excerpt.locator.kind === "diff_line_range"
    ) {
      context.addIssue({
        code: "custom",
        message: "Workspace file excerpts cannot use a diff line range.",
        path: ["locator"],
      });
    }
    if (
      excerpt.source.kind === "conversation_message" &&
      excerpt.locator.kind !== "text_quote"
    ) {
      context.addIssue({
        code: "custom",
        message: "Conversation message excerpts require a text quote.",
        path: ["locator"],
      });
    }
  });
export type ContextExcerpt = z.infer<typeof contextExcerptSchema>;

export const contextExcerptArraySchema = z
  .array(contextExcerptSchema)
  .max(MAXIMUM_CONTEXT_EXCERPTS)
  .superRefine((excerpts, context) => {
    const seen = new Set<string>();
    excerpts.forEach((excerpt, index) => {
      if (seen.has(excerpt.id)) {
        context.addIssue({
          code: "custom",
          message: "Context excerpt identifiers must be unique.",
          path: [index, "id"],
        });
      }
      seen.add(excerpt.id);
    });
  });

export function requireComposerInputByteLimit(
  value: {
    readonly text: string;
    readonly contextExcerpts: readonly ContextExcerpt[];
    readonly taskContexts?: readonly MaterializedTaskContext[];
  },
  context: z.RefinementCtx,
): void {
  const bytes = composerInputUtf8Bytes(value);
  if (bytes > MAXIMUM_COMPOSER_INPUT_BYTES) {
    context.addIssue({
      code: "custom",
      message:
        "Composer text, excerpts, notes, and task contexts exceed the UTF-8 byte limit.",
      path: ["contextExcerpts"],
    });
  }
}

export function composerInputUtf8Bytes(value: {
  readonly text: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts?: readonly MaterializedTaskContext[];
}): number {
  let bytes = encoder.encode(value.text).byteLength;
  for (const excerpt of value.contextExcerpts) {
    bytes += encoder.encode(excerpt.excerpt).byteLength;
    if (excerpt.note !== undefined) {
      bytes += encoder.encode(excerpt.note).byteLength;
    }
  }
  if (value.taskContexts && value.taskContexts.length > 0) {
    bytes += encoder.encode(JSON.stringify(value.taskContexts)).byteLength;
  }
  return bytes;
}

export function requireValidContextExcerptContentParts(
  parts: readonly {
    readonly kind: string;
    readonly excerpt?: ContextExcerpt;
  }[],
  context: z.RefinementCtx,
): void {
  const excerpts = parts.flatMap((part) =>
    part.kind === "context_excerpt" && part.excerpt ? [part.excerpt] : [],
  );
  if (excerpts.length > MAXIMUM_CONTEXT_EXCERPTS) {
    context.addIssue({
      code: "custom",
      message: "User message contains too many context excerpts.",
      path: ["content"],
    });
  }
  const seen = new Set<string>();
  parts.forEach((part, index) => {
    if (part.kind !== "context_excerpt" || !part.excerpt) return;
    if (seen.has(part.excerpt.id)) {
      context.addIssue({
        code: "custom",
        message: "User message context excerpt identifiers must be unique.",
        path: ["content", index, "excerpt", "id"],
      });
    }
    seen.add(part.excerpt.id);
  });
}
