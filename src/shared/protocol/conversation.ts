import { usageIntegerSchema } from "./usage-accounting.js";
import { formFieldsSchema, formAnswersSchema } from "./interactions.js";
import { questionResponseOriginSchema } from "./questions.js";
import { backgroundActivitySchema } from "./background-activity.js";
import { questionRequestsResultSchema } from "./questions.js";
import { nonblockingQuestionsPayloadSchema } from "./questions.js";
import { z } from "zod";
import {
  allowedImageMimeSchema,
  agentToolInvocationCorrelationSchema,
  boundedDisplayTextSchema,
  boundedTextSchema,
  messageTextSchema,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  boundedToolResultSchema,
  boundedValueSchema,
  fileReplacementSchema,
  fileRangeSchema,
  MAXIMUM_BROWSER_ENTITY_BYTES,
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  operationPhaseSchema,
  requireSerializedByteLimit,
  requireConsistentFileReplacement,
  safeItemErrorSchema,
  turnFailureSchema,
  truncationInfoSchema,
  unifiedDiffSchema,
} from "./payload.js";
import { normalizedImageSchema } from "./output-artifacts.js";
import {
  MAXIMUM_PROVIDER_FEATURES_PER_CONVERSATION_ITEM,
  MAXIMUM_PROVIDER_FEATURES_PER_THREAD,
  providerFeatureCapabilitySchema,
  providerFeatureConversationItemEnvelopeSchema,
  providerFeatureStateEnvelopeSchema,
} from "./provider-feature.js";
import { applicationTurnIdSchema } from "./domain.js";
import {
  contextExcerptArraySchema,
  contextExcerptSchema,
  requireComposerInputByteLimit,
  requireValidContextExcerptContentParts,
} from "./context-excerpts.js";
import {
  decisionActionRoleSchema,
  interactionKindSchema,
  interactionInvocationSchema,
  INTERACTION_LIMITS,
  questionnaireQuestionPresentationShape,
  questionnaireSingleChoicePresentationShape,
  questionnaireTextInputSchema,
  requireUniqueQuestionnaireIdentities,
} from "./interactions.js";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  composerAttachmentArraySchema,
  composerAttachmentCapabilitySchema,
  composerAttachmentDescriptorSchema,
  requireUniqueComposerAttachmentContentParts,
} from "./composer-attachments.js";
import {
  MAXIMUM_COMPOSER_TASK_REFERENCES,
  composerTaskReferencesSchema,
  materializedTaskContextSchema,
  requireUniqueTaskContextContentParts,
} from "./tasks.js";

// Retained provider messages can contain far more parts than a Sedes composer
// submission. Like the timeline count guards below, this is a structural
// resource ceiling; the complete message byte limit is the effective bound
// for content-heavy messages. Composer attachment/context/task limits remain
// independently enforced by their input contracts.
export const MAXIMUM_USER_MESSAGE_CONTENT_PARTS = 10_000;

export const MAXIMUM_NORMALIZED_TIMELINE_TURNS = 1_000;
// Count ceilings are wide resource-safety guards. Serialized snapshot/page
// bounds remain the effective limit for content-heavy timelines.
export const MAXIMUM_NORMALIZED_TIMELINE_ITEMS = 100_000;
export const MAXIMUM_NORMALIZED_ITEMS_PER_TURN = 20_000;
export const MAXIMUM_REASONING_SUMMARY_PARTS = 1_000;

export const reasoningSummaryPartsSchema = z
  .array(boundedTextSchema)
  .min(1)
  .max(MAXIMUM_REASONING_SUMMARY_PARTS);

export const normalizedItemKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
  "activity_summary",
  "collaboration",
  "image",
  "viewed_image",
  "review_marker",
  "compaction",
  "notice",
]);
export type NormalizedItemKind = z.infer<typeof normalizedItemKindSchema>;

export const activityDetailModeSchema = z.enum(["full", "summary"]);
export type ActivityDetailMode = z.infer<typeof activityDetailModeSchema>;

export const summarizedActivityKindSchema = z.enum([
  "reasoning",
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
]);
export type SummarizedActivityKind = z.infer<
  typeof summarizedActivityKindSchema
>;

export const conversationTurnStatusSchema = z.enum([
  "in_progress",
  "completed",
  "interrupted",
  "failed",
]);

export const conversationTurnSchema = z
  .strictObject({
    id: applicationTurnIdSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: conversationTurnStatusSchema,
    failure: turnFailureSchema.optional(),
    endedBy: z
      .enum(["agent_settled", "steer", "interrupted", "failed"])
      .optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    /** Why this completed turn cannot be an exact fork boundary. */
    forkUnavailableReason: boundedDisplayTextSchema.optional(),
    orderedItemIds: z
      .array(z.string().min(1).max(160))
      .max(MAXIMUM_NORMALIZED_ITEMS_PER_TURN),
  })
  .superRefine((turn, context) => {
    if ((turn.status === "failed") !== (turn.failure !== undefined)) {
      context.addIssue({ code: "custom", path: ["failure"], message: "Failure details belong to failed turns and are required for them." });
    }
    if (turn.forkUnavailableReason !== undefined && turn.status !== "completed") {
      context.addIssue({ code: "custom", path: ["forkUnavailableReason"], message: "Only a completed turn can explain why it is not a fork boundary." });
    }
    requireUniqueTimelineIdentifiers(
      turn.orderedItemIds,
      context,
      ["orderedItemIds"],
      "Conversation turn item identifiers must be unique.",
    );
  });
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const turnForkCapabilitySchema = z
  .strictObject({
    sourceTurnId: applicationTurnIdSchema,
    expectedTurnRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    available: z.boolean(),
    unavailableReason: boundedDisplayTextSchema.optional(),
  })
  .superRefine((capability, context) => {
    if (capability.available === Boolean(capability.unavailableReason)) {
      context.addIssue({
        code: "custom",
        message:
          "An unavailable fork capability requires exactly one unavailable reason.",
        path: ["unavailableReason"],
      });
    }
  });
export type TurnForkCapability = z.infer<typeof turnForkCapabilitySchema>;

export const forkAvailabilitySchema = z
  .strictObject({
    available: z.boolean(),
    unavailableReason: boundedDisplayTextSchema.optional(),
  })
  .superRefine((capability, context) => {
    if (capability.available === Boolean(capability.unavailableReason)) {
      context.addIssue({
        code: "custom",
        message:
          "An unavailable fork boundary requires exactly one unavailable reason.",
        path: ["unavailableReason"],
      });
    }
  });
export type ForkAvailability = z.infer<typeof forkAvailabilitySchema>;

export const threadForkSourceCapabilitySchema = z.strictObject({
  selectedCompletedTurn: forkAvailabilitySchema,
  latestProviderSnapshot: forkAvailabilitySchema,
});
export type ThreadForkSourceCapability = z.infer<
  typeof threadForkSourceCapabilitySchema
>;

const conversationItemBaseShape = {
  id: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  status: z.enum(["streaming", "completed", "failed", "interrupted"]),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  error: safeItemErrorSchema.optional(),
  providerFeatures: uniqueProviderFeatures(
    z
      .array(providerFeatureConversationItemEnvelopeSchema)
      .max(MAXIMUM_PROVIDER_FEATURES_PER_CONVERSATION_ITEM),
  ).optional(),
} as const;

export const messageContentPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: messageTextSchema,
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: boundedDisplayTextSchema,
  }),
  z.strictObject({
    kind: z.literal("context_excerpt"),
    excerpt: contextExcerptSchema,
  }),
  z.strictObject({
    kind: z.literal("task_context"),
    task: materializedTaskContextSchema,
  }),
  z.strictObject({
    kind: z.literal("image"),
    mimeType: allowedImageMimeSchema.optional(),
    fileName: boundedDisplayTextSchema.optional(),
    alt: boundedDisplayTextSchema.optional(),
    omitted: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("attachment"),
    attachment: composerAttachmentDescriptorSchema,
  }),
]);
export type MessageContentPart = z.infer<typeof messageContentPartSchema>;

export const deliveryInputOriginSchema = z.discriminatedUnion("kind", [
  questionResponseOriginSchema,
  z.strictObject({
    kind: z.literal("agent_message"),
    sourceThreadId: z.string().min(1).max(160),
    sourceThreadLabel: boundedDisplayTextSchema,
  }),
  z.strictObject({
    kind: z.literal("agent_result"),
    callbackId: z.string().min(1).max(160),
    sourceThreadId: z.string().min(1).max(160),
    sourceThreadLabel: boundedDisplayTextSchema,
  }),
]);
export type DeliveryInputOrigin = z.infer<typeof deliveryInputOriginSchema>;

export const planEntrySchema = z.strictObject({
  id: z.string().min(1).max(160),
  text: boundedDisplayTextSchema,
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

export const userMessageItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("user_message"),
    deliveryOperationId: z.string().min(1).max(160).optional(),
    origin: deliveryInputOriginSchema.optional(),
    content: z
      .array(messageContentPartSchema)
      .min(1)
      .max(MAXIMUM_USER_MESSAGE_CONTENT_PARTS),
  })
  .superRefine((message, context) => {
    requireValidContextExcerptContentParts(message.content, context);
    requireUniqueComposerAttachmentContentParts(message.content, context);
    requireUniqueTaskContextContentParts(message.content, context);
    if (
      message.deliveryOperationId === undefined &&
      (message.origin !== undefined ||
        message.content.some(
          ({ kind }) => kind === "attachment" || kind === "task_context",
        ))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A durable message origin, attachment, or task context requires an authenticated delivery operation.",
        path: ["deliveryOperationId"],
      });
    }
  });
export const assistantMessageItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("assistant_message"),
  nonblockingQuestions: nonblockingQuestionsPayloadSchema
    .extend({
      sourceItemId: z.string().min(1).max(512),
    })
    .optional(),
  markdown: messageTextSchema,
});
export const reasoningItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("reasoning"),
  summaryParts: reasoningSummaryPartsSchema.optional(),
  markdown: boundedTextSchema,
});
export const planItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("plan"),
  entries: z.array(planEntrySchema).max(200),
});
export const commandItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("command"),
    phase: operationPhaseSchema,
    command: boundedDisplayTextSchema,
    cwd: boundedDisplayTextSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    output: boundedTextSchema.optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .superRefine(requireConsistentOperationState);
export const fileReadItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("file_read"),
    phase: operationPhaseSchema,
    path: boundedDisplayTextSchema,
    range: fileRangeSchema.optional(),
    contentPreview: boundedTextSchema.optional(),
  })
  .superRefine(requireConsistentOperationState);
export const fileChangeItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("file_change"),
    phase: operationPhaseSchema,
    operation: z.enum(["write", "edit", "delete", "move"]),
    effect: z.enum(["proposed", "applied", "not_applied", "unknown"]),
    path: boundedDisplayTextSchema,
    destinationPath: boundedDisplayTextSchema.optional(),
    range: fileRangeSchema.optional(),
    diff: unifiedDiffSchema.optional(),
    contentPreview: boundedTextSchema.optional(),
    replacement: fileReplacementSchema.optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    requireConsistentOperationState(value, context);
    requireConsistentFileReplacement(value, context);
  });
export const toolItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("tool"),
    phase: operationPhaseSchema,
    toolName: boundedDisplayTextSchema,
    title: boundedDisplayTextSchema,
    category: z.enum([
      "search",
      "filesystem",
      "network",
      "computation",
      "other",
    ]),
    agentToolInvocation: agentToolInvocationCorrelationSchema.optional(),
    arguments: boundedValueSchema.optional(),
    result: boundedToolResultSchema.optional(),
  })
  .superRefine(requireConsistentOperationState);
export const mcpItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("mcp"),
    phase: operationPhaseSchema,
    server: boundedDisplayTextSchema,
    toolName: boundedDisplayTextSchema,
    arguments: boundedValueSchema.optional(),
    result: boundedToolResultSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .superRefine(requireConsistentOperationState);
export const webSearchItemSchema = z
  .strictObject({
    ...conversationItemBaseShape,
    kind: z.literal("web_search"),
    phase: operationPhaseSchema,
    query: boundedDisplayTextSchema.optional(),
    result: boundedToolResultSchema.optional(),
  })
  .superRefine(requireConsistentOperationState);
export const activitySummaryItemSchema = z
  .strictObject({
    id: conversationItemBaseShape.id,
    turnId: conversationItemBaseShape.turnId,
    status: conversationItemBaseShape.status,
    revision: conversationItemBaseShape.revision,
    startedAt: conversationItemBaseShape.startedAt,
    completedAt: conversationItemBaseShape.completedAt,
    providerFeatures: conversationItemBaseShape.providerFeatures,
    kind: z.literal("activity_summary"),
    activityKind: summarizedActivityKindSchema,
    summaryParts: reasoningSummaryPartsSchema.optional(),
  })
  .superRefine((item, context) => {
    if (item.summaryParts && item.activityKind !== "reasoning") {
      context.addIssue({
        code: "custom",
        message:
          "Only a reasoning activity summary can include reasoning summary parts.",
        path: ["summaryParts"],
      });
    }
  });
export const collaborationItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("collaboration"),
  action: z.enum(["spawn", "message", "result", "status"]),
  agentLabel: boundedDisplayTextSchema.optional(),
  summary: boundedTextSchema.optional(),
});
export const imageItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("image"),
  image: normalizedImageSchema,
});
/** A provider viewed an image file; its captured image, if any, follows it. */
export const viewedImageItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("viewed_image"),
  fileName: boundedDisplayTextSchema.optional(),
});
export const reviewMarkerItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("review_marker"),
  verdict: z.enum(["comment", "approve", "request_changes"]),
  label: boundedDisplayTextSchema,
  body: boundedTextSchema.optional(),
  path: boundedDisplayTextSchema.optional(),
  range: fileRangeSchema.optional(),
});
export const compactionItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("compaction"),
  summary: boundedTextSchema
    .refine((summary) => summary.text.trim().length > 0, {
      message: "A compaction summary must contain text.",
    })
    .optional(),
});
export const noticeItemSchema = z.strictObject({
  ...conversationItemBaseShape,
  kind: z.literal("notice"),
  tone: z.enum(["neutral", "info", "success", "warning", "error"]),
  text: boundedTextSchema,
});

export const conversationItemSchema = z
  .discriminatedUnion("kind", [
    userMessageItemSchema,
    assistantMessageItemSchema,
    reasoningItemSchema,
    planItemSchema,
    commandItemSchema,
    fileReadItemSchema,
    fileChangeItemSchema,
    toolItemSchema,
    mcpItemSchema,
    webSearchItemSchema,
    activitySummaryItemSchema,
    collaborationItemSchema,
    imageItemSchema,
    viewedImageItemSchema,
    reviewMarkerItemSchema,
    compactionItemSchema,
    noticeItemSchema,
  ])
  .superRefine((item, context) => {
    if (item.kind === "user_message" || item.kind === "assistant_message") {
      requireSerializedByteLimit(
        item,
        context,
        MAXIMUM_MESSAGE_ITEM_BYTES,
        "Message item exceeds the serialized byte limit.",
      );
    }
  });

export type UserMessageItem = z.infer<typeof userMessageItemSchema>;
export type AssistantMessageItem = z.infer<typeof assistantMessageItemSchema>;
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type CommandItem = z.infer<typeof commandItemSchema>;
export type FileReadItem = z.infer<typeof fileReadItemSchema>;
export type FileChangeItem = z.infer<typeof fileChangeItemSchema>;
export type ToolItem = z.infer<typeof toolItemSchema>;
export type McpItem = z.infer<typeof mcpItemSchema>;
export type WebSearchItem = z.infer<typeof webSearchItemSchema>;
export type ActivitySummaryItem = z.infer<typeof activitySummaryItemSchema>;
export type CollaborationItem = z.infer<typeof collaborationItemSchema>;
export type ImageItem = z.infer<typeof imageItemSchema>;
export type ViewedImageItem = z.infer<typeof viewedImageItemSchema>;
export type ReviewMarkerItem = z.infer<typeof reviewMarkerItemSchema>;
export type CompactionItem = z.infer<typeof compactionItemSchema>;
export type NoticeItem = z.infer<typeof noticeItemSchema>;
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationHistoryWindowSchema = z.discriminatedUnion(
  "hasOlder",
  [
    z.strictObject({
      hasOlder: z.literal(true),
      olderCursor: z.string().min(1).max(512),
    }),
    z.strictObject({ hasOlder: z.literal(false) }),
  ],
);
export type ConversationHistoryWindow = z.infer<
  typeof conversationHistoryWindowSchema
>;

export const truncationBearingSchemas = {
  text: boundedTextSchema,
  displayText: boundedDisplayTextSchema,
  truncation: truncationInfoSchema,
} as const;

const safeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const settingValueSchema = z.union([
  z.string().max(1_024),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);

export const threadRunStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "stopping",
  "failed",
  "disconnected",
  "reconciling",
]);
export type ThreadRunState = z.infer<typeof threadRunStateSchema>;

export const usageSnapshotSchema = z.strictObject({
  context: z
    .strictObject({
      usedTokens: safeCountSchema.optional(),
      windowTokens: safeCountSchema,
      percent: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  counters: z
    .strictObject({
      userMessages: safeCountSchema.optional(),
      assistantMessages: safeCountSchema.optional(),
      toolCalls: safeCountSchema.optional(),
      toolResults: safeCountSchema.optional(),
      totalMessages: safeCountSchema.optional(),
      compactions: safeCountSchema.optional(),
    })
    .optional(),
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

const descriptorAvailabilityShape = {
  available: z.boolean(),
  unavailableReason: boundedDisplayTextSchema.optional(),
} as const;

/**
 * Closed Sedes-owned brand-mark registry. This is a presentation hint, not
 * a provider identifier for logic: backends that have no registered mark
 * omit it from capability presentations and the browser renders nothing
 * (fail-closed). Every member must have a brand icon registered client-side
 * and a `BackendKind` mapping server-side.
 */
export const backendBrandSchema = z.enum(["pi", "codex", "claude", "grok"]);
export type BackendBrand = z.infer<typeof backendBrandSchema>;

export const backendPresentationSchema = z.strictObject({
  label: boundedDisplayTextSchema,
  modelLabel: boundedDisplayTextSchema.optional(),
  /**
   * Optional normalized brand mark the browser may render next to the
   * thread title. Backends that have no registered mark omit it and the
   * browser renders nothing (fail-closed).
   */
  brand: backendBrandSchema.optional(),
});
export type BackendPresentation = z.infer<typeof backendPresentationSchema>;

const operationDescriptorBaseShape = {
  label: boundedDisplayTextSchema,
  destructive: z.boolean(),
  ...descriptorAvailabilityShape,
} as const;
const noParameterOperationIds = [
  "interrupt",
  "retry_submission",
  "recover_uncertain",
  "discard_fork",
  "archive",
  "settle",
  "acknowledge_attention",
  "remove_automation",
  "run_automation",
] as const;
export const threadOperationDescriptorSchema = z.discriminatedUnion("id", [
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.enum(noParameterOperationIds),
    parameters: z.strictObject({ kind: z.literal("none") }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("rename"),
    parameters: z.strictObject({
      kind: z.literal("text"),
      field: z.literal("title"),
      required: z.literal(true),
      maximumLength: z.literal(240),
    }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("compact"),
    parameters: z.strictObject({
      kind: z.literal("text"),
      field: z.literal("instructions"),
      required: z.literal(false),
      maximumLength: z.literal(65_536),
    }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("move_draft"),
    parameters: z.strictObject({ kind: z.literal("workspace") }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("snooze"),
    parameters: z.strictObject({
      kind: z.literal("date_time"),
      field: z.literal("snoozedUntil"),
    }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("attach_automation"),
    parameters: z.strictObject({ kind: z.literal("automation_editor") }),
  }),
  z.strictObject({
    ...operationDescriptorBaseShape,
    id: z.literal("update_automation"),
    parameters: z.strictObject({ kind: z.literal("automation_editor") }),
  }),
]);
export type ThreadOperationDescriptor = z.infer<
  typeof threadOperationDescriptorSchema
>;

export const steerTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("turn"),
    turnId: z.string().min(1).max(160),
  }),
  z.strictObject({ kind: z.literal("conversation") }),
]);
export type SteerTarget = z.infer<typeof steerTargetSchema>;

export const deliveryModeDescriptorSchema = z.strictObject({
  id: z.enum(["submit", "steer", "queue"]),
  steerTarget: z.enum(["turn", "conversation"]).nullable(),
  label: boundedDisplayTextSchema,
  ...descriptorAvailabilityShape,
});
export type DeliveryModeDescriptor = z.infer<
  typeof deliveryModeDescriptorSchema
>;

export const settingOptionSchema = z.strictObject({
  value: z.string().min(1).max(1_024),
  label: boundedDisplayTextSchema,
  available: z.boolean(),
});
const settingOptionsSchema = z
  .array(settingOptionSchema)
  .max(512)
  .superRefine((options, context) => {
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (seen.has(option.value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate setting option "${option.value}".`,
          path: [index],
        });
      }
      seen.add(option.value);
    }
  });
export const settingDescriptorSchema = z.strictObject({
  id: z.enum(["model", "thinking_level", "tool_access"]),
  label: boundedDisplayTextSchema,
  requiredForFirstSubmission: z.boolean(),
  options: settingOptionsSchema,
  ...descriptorAvailabilityShape,
});
export type SettingDescriptor = z.infer<typeof settingDescriptorSchema>;

export const composerActionDescriptorSchema = z.strictObject({
  id: z.enum(["stash_prompt", "restore_stash"]),
  label: boundedDisplayTextSchema,
  ...descriptorAvailabilityShape,
});
export type ComposerActionDescriptor = z.infer<
  typeof composerActionDescriptorSchema
>;

export const interactionCapabilityDescriptorSchema = z.strictObject({
  kind: interactionKindSchema,
  ...descriptorAvailabilityShape,
});
export type InteractionCapabilityDescriptor = z.infer<
  typeof interactionCapabilityDescriptorSchema
>;

export const historyCapabilitySchema = z.strictObject({
  available: z.boolean(),
  paginated: z.boolean(),
  unavailableReason: boundedDisplayTextSchema.optional(),
});
export type HistoryCapability = z.infer<typeof historyCapabilitySchema>;

export const automationCapabilitySchema = z.strictObject({
  available: z.boolean(),
  canAttach: z.boolean(),
  canRunNow: z.boolean(),
  canCloneOnRun: z.boolean(),
  unavailableReason: boundedDisplayTextSchema.optional(),
});
export type AutomationCapability = z.infer<typeof automationCapabilitySchema>;

export const threadCapabilityDocumentSchema = z.strictObject({
  revision: z.string().min(1).max(160),
  backend: backendPresentationSchema,
  interactionMode: z.enum(["interactive", "read_only"]),
  runState: threadRunStateSchema,
  operations: uniqueById(z.array(threadOperationDescriptorSchema).max(32)),
  deliveryModes: uniqueById(z.array(deliveryModeDescriptorSchema).max(3)),
  settings: uniqueById(z.array(settingDescriptorSchema).max(16)),
  composerActions: uniqueById(z.array(composerActionDescriptorSchema).max(16)),
  composerAttachments: composerAttachmentCapabilitySchema,
  nonblockingQuestions: z.boolean(),
  providerOutputArtifacts: z.strictObject({
    nativeImage: z.boolean(),
  }),
  interactions: z.array(interactionCapabilityDescriptorSchema).max(16),
  history: historyCapabilitySchema,
  automation: automationCapabilitySchema,
  providerFeatures: uniqueProviderFeatures(
    z
      .array(providerFeatureCapabilitySchema)
      .max(MAXIMUM_PROVIDER_FEATURES_PER_THREAD),
  ),
});
export type ThreadCapabilityDocument = z.infer<
  typeof threadCapabilityDocumentSchema
>;

const backendInteractionBaseShape = {
  invocation: interactionInvocationSchema.optional(),
  id: z.string().min(1).max(160),
  threadId: z.string().min(1).max(160),
  sourceLabel: boundedDisplayTextSchema,
  openedAt: z.iso.datetime(),
  secret: z.boolean(),
  destructive: z.boolean(),
  cancellable: z.boolean(),
} as const;

export const backendInteractionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...backendInteractionBaseShape,
      title: boundedDisplayTextSchema,
      kind: z.literal("form"),
      fields: formFieldsSchema,
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("choice"),
      title: boundedDisplayTextSchema,
      message: boundedTextSchema.optional(),
      options: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(160),
            label: boundedDisplayTextSchema,
            description: boundedDisplayTextSchema.optional(),
          }),
        )
        .min(1)
        .max(64)
        .superRefine((options, context) => {
          const ids = new Set<string>();
          for (const [index, option] of options.entries()) {
            if (ids.has(option.id)) {
              context.addIssue({
                code: "custom",
                message: "Interaction option IDs must be unique.",
                path: [index, "id"],
              });
            }
            ids.add(option.id);
          }
        }),
      multiple: z.boolean(),
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("confirmation"),
      title: boundedDisplayTextSchema,
      message: boundedTextSchema,
      confirmLabel: boundedDisplayTextSchema.optional(),
      cancelLabel: boundedDisplayTextSchema.optional(),
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("text_input"),
      title: boundedDisplayTextSchema,
      placeholder: boundedDisplayTextSchema.optional(),
      initialValue: boundedTextSchema.optional(),
      multiline: z.boolean(),
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("editor"),
      title: boundedDisplayTextSchema,
      initialValue: boundedTextSchema.optional(),
      language: z.string().min(1).max(120).optional(),
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("decision"),
      title: boundedDisplayTextSchema,
      message: boundedTextSchema.optional(),
      code: boundedTextSchema.optional(),
      actions: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(160),
            label: boundedDisplayTextSchema,
            description: boundedDisplayTextSchema.optional(),
            role: decisionActionRoleSchema,
          }),
        )
        .min(1)
        .max(INTERACTION_LIMITS.decisionActions),
    }),
    z.strictObject({
      ...backendInteractionBaseShape,
      kind: z.literal("questionnaire"),
      title: boundedDisplayTextSchema,
      message: boundedTextSchema.optional(),
      questions: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(160),
            ...questionnaireQuestionPresentationShape,
            input: z.discriminatedUnion("kind", [
              z.strictObject({
                ...questionnaireSingleChoicePresentationShape,
                options: z
                  .array(
                    z.strictObject({
                      id: z.string().min(1).max(160),
                      label: boundedDisplayTextSchema,
                      description: boundedDisplayTextSchema,
                    }),
                  )
                  .min(1)
                  .max(INTERACTION_LIMITS.questionnaireOptionsPerQuestion),
                other: z
                  .strictObject({
                    id: z.string().min(1).max(160),
                    label: boundedDisplayTextSchema,
                    description: boundedDisplayTextSchema.optional(),
                  })
                  .optional(),
              }),
              questionnaireTextInputSchema,
            ]),
          }),
        )
        .min(1)
        .max(INTERACTION_LIMITS.questionnaireQuestions),
    }),
  ])
  .superRefine((interaction, context) => {
    requireBoundedInteraction(interaction, context);
    if (interaction.kind === "decision") {
      const ids = new Set<string>();
      let primaryCount = 0;
      for (const [index, action] of interaction.actions.entries()) {
        if (ids.has(action.id)) {
          context.addIssue({
            code: "custom",
            message: "Decision action IDs must be unique.",
            path: ["actions", index, "id"],
          });
        }
        ids.add(action.id);
        if (action.role === "primary") primaryCount += 1;
      }
      if (primaryCount > 1) {
        context.addIssue({
          code: "custom",
          message: "A decision may have at most one primary action.",
          path: ["actions"],
        });
      }
    } else if (interaction.kind === "questionnaire") {
      requireUniqueQuestionnaireIdentities(interaction.questions, context);
      if (
        interaction.secret !==
        interaction.questions.some((question) => question.secret)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Questionnaire secret state must match its secret questions.",
          path: ["secret"],
        });
      }
    }
  });
export type BackendInteraction = z.infer<typeof backendInteractionSchema>;

function requireBoundedInteraction(
  interaction: unknown,
  context: z.RefinementCtx,
): void {
  if (
    new TextEncoder().encode(JSON.stringify(interaction)).byteLength >
    MAXIMUM_BROWSER_ENTITY_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "Interaction payload exceeds the serialized byte limit.",
    });
  }
}

export const queuedInputSummarySchema = z
  .strictObject({
    id: z.string().min(1).max(160),
    deliveryOperationId: z.string().min(1).max(160),
    sequence: safeCountSchema,
    origin: z.enum([
      "user",
      "automation",
      "agent_control",
      "principal_client_control",
      "agent_result",
    ]),
    inputOrigin: deliveryInputOriginSchema.optional(),
    initiatingAgentThreadId: z.string().min(1).max(160).optional(),
    initiatingToolClientId: z.uuid().optional(),
    isHead: z.boolean(),
    state: z.enum([
      "pending",
      "retry_wait",
      "dispatching",
      "uncertain",
      "failed",
    ]),
    requestedDeliveryMode: z.enum(["submit", "queue", "steer"]).optional(),
    resolvedDeliveryMode: z.enum(["submit", "queue", "steer"]),
    deliveryMode: z.enum(["submit", "steer"]).optional(),
    attachmentCount: z
      .number()
      .int()
      .nonnegative()
      .max(COMPOSER_ATTACHMENT_LIMITS.maximumAttachments),
    taskCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_COMPOSER_TASK_REFERENCES),
    preview: boundedDisplayTextSchema.extend({
      text: boundedDisplayTextSchema.shape.text
        .min(1)
        .refine((text) => text.trim().length > 0, {
          message: "Queued input preview must not be blank.",
        }),
    }),
    createdAt: z.iso.datetime(),
    nextAttemptAt: z.iso.datetime().optional(),
    diagnostic: boundedDisplayTextSchema.optional(),
  })
  .superRefine((item, context) => {
    const hasAgentThread = item.initiatingAgentThreadId !== undefined;
    const hasToolClient = item.initiatingToolClientId !== undefined;
    if (
      (item.origin === "agent_control" && (!hasAgentThread || hasToolClient)) ||
      (item.origin === "principal_client_control" &&
        (!hasToolClient || hasAgentThread)) ||
      ((item.origin === "user" ||
        item.origin === "automation" ||
        item.origin === "agent_result") &&
        (hasAgentThread || hasToolClient))
    ) {
      context.addIssue({
        code: "custom",
        message: "Queued input origin and initiating caller must match.",
        path: ["origin"],
      });
    }
    const expectedInputOriginKind =
      item.origin === "agent_result"
        ? "agent_result"
        : item.origin === "agent_control"
          ? "agent_message"
          : item.origin === "user" &&
              item.inputOrigin?.kind === "question_response"
            ? "question_response"
            : undefined;
    if (item.inputOrigin?.kind !== expectedInputOriginKind) {
      context.addIssue({
        code: "custom",
        message: "Agent input provenance must match its queued input origin.",
        path: ["inputOrigin"],
      });
    }
    const requiresDeliveryMode =
      item.state === "dispatching" || item.state === "uncertain";
    if (requiresDeliveryMode !== (item.deliveryMode !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "Delivery mode is required exactly while queued input delivery is active or uncertain.",
        path: ["deliveryMode"],
      });
    }
  });
export type QueuedInputSummary = z.infer<typeof queuedInputSummarySchema>;

export const threadSettingsSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  values: z
    .array(
      z.strictObject({
        id: z.enum(["model", "thinking_level", "tool_access"]),
        desiredValue: settingValueSchema,
        effectiveValue: settingValueSchema,
        applicationState: z.enum([
          "draft",
          "effective",
          "pending_next_turn",
          "confirmation_unknown",
          "external_custom",
        ]),
      }),
    )
    .max(16)
    .superRefine((values, context) => {
      requireUniqueTimelineIdentifiers(
        values.map(({ id }) => id),
        context,
        [],
        "Thread setting identifiers must be unique.",
      );
    }),
});
export type ThreadSettingsSnapshot = z.infer<
  typeof threadSettingsSnapshotSchema
>;

export const normalizedThreadRecoverySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("conversation_creation"),
    creationType: z.enum(["first_input", "fork"]),
    phase: z.enum([
      "prepared",
      "external_call_started",
      "conversation_identified",
      "first_submission_started",
      "accepted_unpersisted",
      "aborted_unpersisted",
      "recovery_required",
    ]),
    diagnostic: boundedDisplayTextSchema,
    promptPreview: boundedDisplayTextSchema.optional(),
    submissionMayHaveBeenAccepted: z.boolean(),
    forkUncertainty: z.literal("fork_unknown").nullable(),
    possibleProviderOrphan: z.literal("full_native_copy").nullable(),
    /**
     * The provider already returned the conversation's identity, so recovery
     * finishes it locally; a fork in this state cannot be discarded.
     */
    conversationIdentified: z.boolean(),
    /**
     * Who names a fork's provider child. An application-reserved child is
     * never imported by discovery after a discard; a provider-assigned one
     * may be. Null for first-input creation or an unrecorded identity.
     */
    forkChildIdentity: z
      .enum(["application_reserved", "provider_assigned"])
      .nullable(),
    recoverable: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("operation_uncertain"),
    operationCategory: z.enum([
      "delivery",
      "interrupt",
      "compaction",
      "rename",
      "settings",
      "creation",
      "automation",
      "other",
    ]),
    diagnostic: boundedDisplayTextSchema,
    submissionMayHaveBeenAccepted: z.boolean(),
    recoverable: z.boolean(),
  }),
]);
export type NormalizedThreadRecovery = z.infer<
  typeof normalizedThreadRecoverySchema
>;

export const normalizedThreadAttentionSchema = z.strictObject({
  wake: z
    .strictObject({
      wokeAt: z.iso.datetime(),
      text: boundedDisplayTextSchema.optional(),
    })
    .optional(),
  automationContext: z
    .strictObject({
      runId: z.string().min(1).max(160),
      sourceThreadId: z.string().min(1).max(160),
      triggeredAt: z.iso.datetime(),
      outcome: z.enum(["triggered", "failed"]),
      diagnostic: boundedDisplayTextSchema.optional(),
    })
    .optional(),
  unseenCompletion: z
    .strictObject({
      operationId: z.string().min(1).max(160),
      completedAt: z.iso.datetime(),
    })
    .optional(),
  queueFailure: z
    .strictObject({
      queuedInputId: z.string().min(1).max(160),
      failedAt: z.iso.datetime(),
      diagnostic: boundedDisplayTextSchema,
    })
    .optional(),
});
export type NormalizedThreadAttention = z.infer<
  typeof normalizedThreadAttentionSchema
>;

export const runtimeNoticeSchema = z.strictObject({
  id: z.string().min(1).max(160),
  tone: z.enum(["neutral", "info", "success", "warning", "error"]),
  message: boundedDisplayTextSchema,
  createdAt: z.iso.datetime(),
});
export type RuntimeNotice = z.infer<typeof runtimeNoticeSchema>;

export const normalizedEnvironmentSummarySchema = z.strictObject({
  id: z.string().min(1).max(160),
  kind: z.enum(["local", "ssh", "outbound"]),
  label: boundedDisplayTextSchema,
  available: z.boolean(),
  directoryBrowsing: z.enum(["available", "unavailable"]),
  diagnostic: boundedDisplayTextSchema.optional(),
});
export type NormalizedEnvironmentSummary = z.infer<
  typeof normalizedEnvironmentSummarySchema
>;

export const normalizedWorkspaceSummarySchema = z.strictObject({
  id: z.string().min(1).max(160),
  environmentId: z.string().min(1).max(160),
  label: boundedDisplayTextSchema,
  displayPath: boundedDisplayTextSchema,
  available: z.boolean(),
});
export type NormalizedWorkspaceSummary = z.infer<
  typeof normalizedWorkspaceSummarySchema
>;

export const executionWorkspaceNetworkProfileSchema = z.enum([
  "isolated",
  "execution_host",
]);
export type ExecutionWorkspaceNetworkProfile = z.infer<
  typeof executionWorkspaceNetworkProfileSchema
>;

export const executionWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("direct") }),
  z.strictObject({
    kind: z.literal("isolated"),
    workspaceAccess: z.enum(["writable_clone", "read_only"]),
    networkProfile: executionWorkspaceNetworkProfileSchema,
  }),
]);
export type ExecutionWorkspaceSelection = z.infer<
  typeof executionWorkspaceSelectionSchema
>;

const executionWorkspaceHostPathsSchema = z.strictObject({
  home: z.string().min(1).max(4_096),
  workspace: z.string().min(1).max(4_096),
});

export const normalizedThreadExecutionWorkspaceSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("direct") }),
    z.strictObject({
      kind: z.literal("isolated"),
      workspaceAccess: z.enum(["writable_clone", "read_only"]),
      state: z.enum([
        "provisioning",
        "provisioning_failed",
        "ready",
        "retained",
        "deleting",
        "deletion_failed",
        "deleted",
      ]),
      networkProfile: executionWorkspaceNetworkProfileSchema,
      hostPaths: executionWorkspaceHostPathsSchema,
    }),
  ],
);
export type NormalizedThreadExecutionWorkspace = z.infer<
  typeof normalizedThreadExecutionWorkspaceSchema
>;

export const normalizedThreadSavedAgentOriginSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  name: boundedDisplayTextSchema,
  available: z.boolean(),
});
export type NormalizedThreadSavedAgentOrigin = z.infer<
  typeof normalizedThreadSavedAgentOriginSchema
>;

export const normalizedThreadSummarySchema = z.strictObject({
  id: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  /** Stable application-issued connection-profile identity for this thread. */
  targetId: z.string().min(1).max(160),
  title: boundedDisplayTextSchema,
  /**
   * Backend identity of the thread's durable target, projected so inventory
   * rows can render a brand mark without attaching the conversation. `brand`
   * is required here (unlike the capability presentation): every thread row
   * is bound to a configured backend instance, and every compiled backend
   * declares its mark in the closed server-side kind→brand mapping
   * (`BACKEND_BRANDS`).
   */
  backend: z.strictObject({
    label: boundedDisplayTextSchema,
    brand: backendBrandSchema,
  }),
  backingState: z.enum(["unbound", "creating", "bound", "creation_unknown"]),
  inventoryState: z.enum(["active", "snoozed", "settled", "archived"]),
  inventoryRevision: z.number().int().nonnegative(),
  threadRevision: z.number().int().nonnegative(),
  runState: threadRunStateSchema,
  queuedInputCount: safeCountSchema,
  available: z.boolean(),
  lastActivityAt: z.iso.datetime(),
  stateChangedAt: z.iso.datetime(),
  snoozedUntil: z.iso.datetime().optional(),
  automation: z
    .strictObject({
      status: z.enum(["enabled", "paused"]),
      runMode: z.enum(["same_thread", "clone"]),
      scheduleKind: z.enum(["date_time", "interval", "cron"]),
      nextRunAt: z.iso.datetime().optional(),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      hasPrecheck: z.boolean(),
      lastRun: z
        .strictObject({
          id: z.string().min(1).max(160),
          state: z.enum([
            "claimed",
            "dispatching",
            "queued",
            "running",
            "completed",
            "failed",
            "skipped",
            "uncertain",
          ]),
          occurrence: z.enum(["scheduled", "manual"]),
          scheduledFor: z.iso.datetime(),
          finishedAt: z.iso.datetime().optional(),
          resultThreadId: z.string().min(1).max(160).optional(),
          errorCode: z.string().min(1).max(120).optional(),
        })
        .optional(),
    })
    .nullable(),
});
export type NormalizedThreadSummary = z.infer<
  typeof normalizedThreadSummarySchema
>;

export const normalizedDraftSchema = z
  .strictObject({
    text: z.string().max(262_144),
    selectedSkillId: z.string().min(1).max(160).optional(),
    contextExcerpts: contextExcerptArraySchema,
    attachments: composerAttachmentArraySchema,
    taskReferences: composerTaskReferencesSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime().optional(),
  })
  .superRefine(requireComposerInputByteLimit);
export type NormalizedDraft = z.infer<typeof normalizedDraftSchema>;

export function hasDeliverableComposerInput(input: {
  readonly text: string;
  readonly selectedSkillId?: string | null;
  readonly contextExcerpts?: readonly { readonly note?: string }[];
  readonly attachments?: readonly unknown[];
  readonly taskReferences?: readonly unknown[];
  readonly taskContexts?: readonly unknown[];
}): boolean {
  return (
    input.text.trim().length > 0 ||
    Boolean(input.selectedSkillId) ||
    Boolean(input.contextExcerpts?.some(({ note }) => note?.trim())) ||
    Boolean(input.attachments?.length) ||
    Boolean(input.taskReferences?.length) ||
    Boolean(input.taskContexts?.length)
  );
}

export const normalizedStashSchema = z
  .strictObject({
    id: z.string().min(1).max(160),
    text: z.string().max(262_144),
    selectedSkillId: z.string().min(1).max(160).optional(),
    contextExcerpts: contextExcerptArraySchema,
    attachments: composerAttachmentArraySchema,
    taskReferences: composerTaskReferencesSchema,
    createdAt: z.iso.datetime(),
  })
  .superRefine(requireComposerInputByteLimit);
export type NormalizedStash = z.infer<typeof normalizedStashSchema>;

export const composerCommandDescriptorSchema = z.strictObject({
  invocation: z.string().startsWith("/").min(2).max(240),
  source: z.enum(["extension", "prompt"]),
  description: boundedDisplayTextSchema.optional(),
  argumentHint: boundedDisplayTextSchema.optional(),
});
export type ComposerCommandDescriptor = z.infer<
  typeof composerCommandDescriptorSchema
>;

export const composerSkillDescriptorSchema = z.strictObject({
  id: z.string().min(1).max(160),
  name: boundedDisplayTextSchema,
  displayName: boundedDisplayTextSchema.optional(),
  reference: z.string().min(1).max(240),
  description: boundedDisplayTextSchema.optional(),
});
export type ComposerSkillDescriptor = z.infer<
  typeof composerSkillDescriptorSchema
>;

export const composerSkillCatalogSchema = z.strictObject({
  skills: z.array(composerSkillDescriptorSchema).max(512),
});
export type ComposerSkillCatalog = z.infer<typeof composerSkillCatalogSchema>;

export const agentToolIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]*$/)
  .max(128);
export const agentToolGroupIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]*$/)
  .max(128);
export const agentToolPresentationSurfaceSchema = z.enum(["native", "cli"]);
export type AgentToolPresentationSurface = z.infer<
  typeof agentToolPresentationSurfaceSchema
>;
export const agentToolPresentationModeSchema = z.enum([
  "progressive",
  "individual",
]);
export type AgentToolPresentationMode = z.infer<
  typeof agentToolPresentationModeSchema
>;
export const agentToolPresentationSchema = z.strictObject({
  surface: agentToolPresentationSurfaceSchema,
  mode: agentToolPresentationModeSchema,
});
export type AgentToolPresentation = z.infer<typeof agentToolPresentationSchema>;
export const agentToolPresentationOptionSchema = z
  .strictObject({
    surface: agentToolPresentationSurfaceSchema,
    modes: z.array(agentToolPresentationModeSchema).min(1).max(2),
  })
  .superRefine((option, context) => {
    if (new Set(option.modes).size !== option.modes.length) {
      context.addIssue({
        code: "custom",
        message: "Agent tool presentation modes must be unique per surface.",
        path: ["modes"],
      });
    }
  });
export type AgentToolPresentationOption = z.infer<
  typeof agentToolPresentationOptionSchema
>;
export const agentToolPresentationOptionsSchema = z
  .array(agentToolPresentationOptionSchema)
  .min(1)
  .max(2)
  .superRefine((options, context) => {
    if (
      new Set(options.map(({ surface }) => surface)).size !== options.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agent tool presentation surfaces must be unique.",
      });
    }
  });
export const agentToolEffectsSchema = z.strictObject({
  application: z.enum(["read", "write", "destructive"]),
  modelUsage: z.enum(["none", "agent_execution"]),
  external: z.enum(["none", "durable_side_effect"]),
});

const agentToolCatalogOrderSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const normalizedThreadAgentToolDescriptorSchema = z.strictObject({
  id: agentToolIdSchema,
  label: boundedDisplayTextSchema,
  description: boundedDisplayTextSchema.optional(),
  order: agentToolCatalogOrderSchema,
  effects: agentToolEffectsSchema,
  enabled: z.boolean(),
  available: z.boolean(),
  unavailableReason: boundedDisplayTextSchema.optional(),
});

export const normalizedThreadAgentToolGroupSchema = z.strictObject({
  id: agentToolGroupIdSchema,
  label: boundedDisplayTextSchema,
  description: boundedDisplayTextSchema,
  order: agentToolCatalogOrderSchema,
  tools: z.array(normalizedThreadAgentToolDescriptorSchema).min(1).max(512),
});

export const agentToolAccessBoundarySchema = z.enum([
  "thread",
  "environment",
  "unrestricted",
]);
export type AgentToolAccessBoundary = z.infer<
  typeof agentToolAccessBoundarySchema
>;

export const normalizedThreadAgentToolPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    accessBoundary: agentToolAccessBoundarySchema,
    groups: z.array(normalizedThreadAgentToolGroupSchema).max(64),
    presentation: agentToolPresentationSchema,
    presentationOptions: agentToolPresentationOptionsSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((policy, context) => {
    const tools = policy.groups.flatMap((group) => group.tools);
    if (
      new Set(policy.groups.map(({ id }) => id)).size !== policy.groups.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agent tool groups must have unique IDs.",
        path: ["groups"],
      });
    }
    if (
      new Set(policy.groups.map(({ order }) => order)).size !==
      policy.groups.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agent tool groups must have unique display orders.",
        path: ["groups"],
      });
    }
    if (tools.length > 512) {
      context.addIssue({
        code: "custom",
        message: "Agent tool policies may contain at most 512 tools.",
        path: ["groups"],
      });
    }
    if (new Set(tools.map(({ id }) => id)).size !== tools.length) {
      context.addIssue({
        code: "custom",
        message: "Agent tool descriptors must have unique IDs.",
        path: ["groups"],
      });
    }
    policy.groups.forEach((group, groupIndex) => {
      if (
        new Set(group.tools.map(({ order }) => order)).size !==
        group.tools.length
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Agent tools within a group must have unique display orders.",
          path: ["groups", groupIndex, "tools"],
        });
      }
    });
    const selectedSurface = policy.presentationOptions.find(
      ({ surface }) => surface === policy.presentation.surface,
    );
    if (!selectedSurface?.modes.includes(policy.presentation.mode)) {
      context.addIssue({
        code: "custom",
        message: "The selected agent tool presentation must be available.",
        path: ["presentation"],
      });
    }
  });
export type NormalizedThreadAgentToolPolicy = z.infer<
  typeof normalizedThreadAgentToolPolicySchema
>;

const historyPageStructureSchema = z
  .strictObject({
    orderedTurnIds: z.array(z.string().min(1).max(160)).max(500),
    turnsById: z.record(z.string(), conversationTurnSchema),
    forkSource: threadForkSourceCapabilitySchema,
    forksByTurnId: z.record(z.string(), turnForkCapabilitySchema),
    itemsById: z.record(z.string(), conversationItemSchema),
    previousCursor: z.string().min(1).max(512).optional(),
  })
  .superRefine((page, context) => {
    requireConsistentTimelineMaps(page, context);
    const turns = Object.keys(page.turnsById).sort();
    const forks = Object.keys(page.forksByTurnId).sort();
    if (
      turns.length !== forks.length ||
      turns.some((turnId, index) => forks[index] !== turnId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["forksByTurnId"],
        message: "History fork descriptors must match the projected turns.",
      });
    }
  });
export const historyPageSchema = historyPageStructureSchema.superRefine(
  (page, context) => {
    requireSerializedByteLimit(
      page,
      context,
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
      "Normalized snapshot or history page exceeds the serialized byte limit.",
    );
  },
);
export type HistoryPage = z.infer<typeof historyPageSchema>;

/**
 * Server-side preflight for adaptive history paging. This preserves the exact
 * normalized page structure while leaving aggregate transfer bytes to the
 * caller that can request a smaller whole-turn suffix.
 */
export function safeParseHistoryPageStructure(value: unknown) {
  return historyPageStructureSchema.safeParse(value);
}

export const threadHistorySeekResultSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("found"),
      targetTurnId: applicationTurnIdSchema,
      page: historyPageSchema,
    }),
    z.strictObject({
      status: z.literal("not_found"),
      targetTurnId: applicationTurnIdSchema,
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      targetTurnId: applicationTurnIdSchema,
      reason: boundedDisplayTextSchema,
      retryable: z.boolean(),
    }),
  ])
  .superRefine((result, context) => {
    if (result.status !== "found") return;
    if (result.page.previousCursor) {
      context.addIssue({
        code: "custom",
        path: ["page", "previousCursor"],
        message: "A targeted history result must not expose a backend cursor.",
      });
    }
    if (
      !result.page.orderedTurnIds.includes(result.targetTurnId) ||
      result.page.turnsById[result.targetTurnId] === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["page", "orderedTurnIds"],
        message: "A targeted history result must contain its target turn.",
      });
    }
  });
export type ThreadHistorySeekResult = z.infer<
  typeof threadHistorySeekResultSchema
>;

export const normalizedThreadSnapshotSchema = z
  .strictObject({
    thread: normalizedThreadSummarySchema,
    executionWorkspace: normalizedThreadExecutionWorkspaceSchema,
    createdWithAgent: normalizedThreadSavedAgentOriginSchema.optional(),
    /**
     * Bounded, display-only backend-native conversation identity. The server
     * never accepts this value back as authority; mutations remain scoped by
     * the Sedes-owned `thread.id`.
     */
    backendSessionId: z.string().min(1).max(128).optional(),
    workspace: normalizedWorkspaceSummarySchema,
    environment: normalizedEnvironmentSummarySchema,
    draft: normalizedDraftSchema,
    stashes: z.array(normalizedStashSchema).max(500),
    composerCommands: z.array(composerCommandDescriptorSchema).max(512),
    agentTools: normalizedThreadAgentToolPolicySchema,
    orderedTurnIds: z
      .array(z.string().min(1).max(160))
      .max(MAXIMUM_NORMALIZED_TIMELINE_TURNS),
    turnsById: z.record(z.string(), conversationTurnSchema),
    forkSource: threadForkSourceCapabilitySchema,
    forksByTurnId: z.record(z.string(), turnForkCapabilitySchema),
    itemsById: z.record(z.string(), conversationItemSchema),
    history: conversationHistoryWindowSchema,
    runState: threadRunStateSchema,
    backgroundActivity: backgroundActivitySchema.optional(),
    activeTurnId: z.string().min(1).max(160).optional(),
    queue: z.array(queuedInputSummarySchema).max(500),
    capabilities: threadCapabilityDocumentSchema,
    settings: threadSettingsSnapshotSchema,
    providerFeatures: uniqueProviderFeatures(
      z
        .array(providerFeatureStateEnvelopeSchema)
        .max(MAXIMUM_PROVIDER_FEATURES_PER_THREAD),
    ),
    usage: usageSnapshotSchema,
    interactions: z.array(backendInteractionSchema).max(32),
    recovery: normalizedThreadRecoverySchema.optional(),
    attention: normalizedThreadAttentionSchema,
  })
  .superRefine((snapshot, context) => {
    requireBoundedTimelineMaps(snapshot, context);
    if (
      snapshot.thread.runState !== snapshot.runState ||
      snapshot.capabilities.runState !== snapshot.runState
    ) {
      context.addIssue({
        code: "custom",
        message: "Thread snapshot run states are contradictory.",
        path: ["runState"],
      });
    }
    if (snapshot.thread.queuedInputCount !== snapshot.queue.length) {
      context.addIssue({
        code: "custom",
        message: "Thread queue count does not match the queue.",
        path: ["thread", "queuedInputCount"],
      });
    }
    requireConsistentProviderFeatureProjection(snapshot, context);
    requireConsistentConversationItemFeatureProjection(snapshot, context);
  });
export type NormalizedThreadSnapshot = z.infer<
  typeof normalizedThreadSnapshotSchema
>;

const normalizedThreadApplicationStateSchema = z
  .strictObject({
    thread: normalizedThreadSummarySchema,
    executionWorkspace: normalizedThreadExecutionWorkspaceSchema,
    createdWithAgent: normalizedThreadSavedAgentOriginSchema.optional(),
    workspace: normalizedWorkspaceSummarySchema,
    environment: normalizedEnvironmentSummarySchema,
    draft: normalizedDraftSchema,
    stashes: z.array(normalizedStashSchema).max(500),
    composerCommands: z.array(composerCommandDescriptorSchema).max(512),
    agentTools: normalizedThreadAgentToolPolicySchema,
    forkSource: threadForkSourceCapabilitySchema,
    queue: z.array(queuedInputSummarySchema).max(500),
    capabilities: threadCapabilityDocumentSchema,
    settings: threadSettingsSnapshotSchema,
    providerFeatures: uniqueProviderFeatures(
      z
        .array(providerFeatureStateEnvelopeSchema)
        .max(MAXIMUM_PROVIDER_FEATURES_PER_THREAD),
    ),
    interactions: z.array(backendInteractionSchema).max(32),
    recovery: normalizedThreadRecoverySchema.optional(),
    attention: normalizedThreadAttentionSchema,
  })
  .superRefine(requireConsistentProviderFeatureProjection);

const generationSchema = z.string().min(1).max(160);
export const normalizedThreadEventSchema = z.discriminatedUnion("type", [
  questionRequestsResultSchema.extend({
    type: z.literal("questions_changed"),
    generation: generationSchema,
  }),
  z.strictObject({
    type: z.literal("snapshot"),
    generation: generationSchema,
    snapshot: normalizedThreadSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("history_prepend"),
    generation: generationSchema,
    page: historyPageSchema,
  }),
  z
    .strictObject({
      type: z.literal("turn_upsert"),
      generation: generationSchema,
      turn: conversationTurnSchema,
      fork: turnForkCapabilitySchema,
    })
    .superRefine((event, context) => {
      if (
        event.fork.sourceTurnId !== event.turn.id ||
        event.fork.expectedTurnRevision !== event.turn.revision
      ) {
        context.addIssue({
          code: "custom",
          message: "Turn event fork capability does not match its turn.",
          path: ["fork"],
        });
      }
    }),
  z.strictObject({
    type: z.literal("fork_source_state_changed"),
    generation: generationSchema,
    forkSource: threadForkSourceCapabilitySchema,
  }),
  z.strictObject({
    type: z.literal("item_upsert"),
    generation: generationSchema,
    item: conversationItemSchema,
  }),
  z.strictObject({
    type: z.literal("run_state"),
    generation: generationSchema,
    state: threadRunStateSchema,
    activeTurnId: z.string().min(1).max(160).optional(),
  }),
  z.strictObject({
    type: z.literal("queue_changed"),
    generation: generationSchema,
    threadRevision: safeCountSchema,
    items: z.array(queuedInputSummarySchema).max(500),
  }),
  z
    .strictObject({
      type: z.literal("capabilities_changed"),
      generation: generationSchema,
      threadRevision: safeCountSchema,
      capabilities: threadCapabilityDocumentSchema,
      providerFeatures: uniqueProviderFeatures(
        z
          .array(providerFeatureStateEnvelopeSchema)
          .max(MAXIMUM_PROVIDER_FEATURES_PER_THREAD),
      ),
    })
    .superRefine(requireConsistentProviderFeatureProjection),
  z.strictObject({
    type: z.literal("interaction_opened"),
    generation: generationSchema,
    interaction: backendInteractionSchema,
  }),
  z.strictObject({
    type: z.literal("interaction_resolved"),
    generation: generationSchema,
    interactionId: z.string().min(1).max(160),
  }),
  z.strictObject({
    type: z.literal("usage_revision_changed"),
    generation: generationSchema,
    revision: usageIntegerSchema,
  }),
  z.strictObject({
    type: z.literal("usage_changed"),
    generation: generationSchema,
    usage: usageSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("background_activity_changed"),
    generation: generationSchema,
    activity: backgroundActivitySchema,
  }),
  z.strictObject({
    type: z.literal("thread_changed"),
    generation: generationSchema,
    thread: normalizedThreadSummarySchema,
  }),
  z.strictObject({
    type: z.literal("draft_changed"),
    generation: generationSchema,
    draft: normalizedDraftSchema,
  }),
  z.strictObject({
    type: z.literal("stashes_changed"),
    generation: generationSchema,
    stashes: z.array(normalizedStashSchema).max(500),
  }),
  z.strictObject({
    type: z.literal("settings_changed"),
    generation: generationSchema,
    settings: threadSettingsSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("attention_changed"),
    generation: generationSchema,
    attention: normalizedThreadAttentionSchema,
  }),
  z.strictObject({
    type: z.literal("application_state_changed"),
    generation: generationSchema,
    state: normalizedThreadApplicationStateSchema,
  }),
  z.strictObject({
    type: z.literal("notice"),
    generation: generationSchema,
    notice: runtimeNoticeSchema,
  }),
]);
export type NormalizedThreadEvent = z.infer<typeof normalizedThreadEventSchema>;

export const threadEventIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:0|[1-9][0-9]*)$/,
  )
  .max(240)
  .refine((eventId) => {
    const sequence = Number(eventId.slice(eventId.lastIndexOf(".") + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0;
  }, "Thread event sequence must be a safe nonnegative integer.");

export const threadEventEnvelopeSchema = z
  .strictObject({
    eventId: threadEventIdSchema,
    projectionGeneration: generationSchema,
    event: normalizedThreadEventSchema,
  })
  .superRefine((envelope, context) => {
    if (envelope.projectionGeneration !== envelope.event.generation) {
      context.addIssue({
        code: "custom",
        message: "Envelope and event projection generations must match.",
        path: ["projectionGeneration"],
      });
    }
  });
export type ThreadEventEnvelope = z.infer<typeof threadEventEnvelopeSchema>;

/**
 * Per-connection materialized state at an exact published-event watermark.
 * This is a transport checkpoint, not a new event in the shared thread log.
 * Events following it must have strictly newer transport sequences. Controls
 * remain non-authoritative until the stream's thread-live boundary arrives.
 */
export const threadCheckpointSchema = z
  .strictObject({
    eventId: threadEventIdSchema,
    projectionGeneration: generationSchema,
    snapshot: normalizedThreadSnapshotSchema,
    notices: z.array(runtimeNoticeSchema).max(100),
    // A checkpoint must not claim that older capabilities were refreshed at
    // the latest thread revision simply because it carries a current snapshot.
    capabilityThreadRevision: z.number().int().nonnegative(),
    // Unlike the snapshot's consistent display fields, this preserves the
    // run state for which the provider actually supplied its controls.
    capabilityRunState: threadRunStateSchema,
  })
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.capabilityThreadRevision >
      checkpoint.snapshot.thread.threadRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Checkpoint capabilities cannot exceed the thread revision.",
        path: ["capabilityThreadRevision"],
      });
    }
  });
export type ThreadCheckpoint = z.infer<typeof threadCheckpointSchema>;

function requireConsistentOperationState(
  value: { status: string; phase: string },
  context: z.RefinementCtx,
): void {
  const terminal = new Set(["completed", "failed", "interrupted"]);
  const statusTerminal = terminal.has(value.status);
  const phaseTerminal = terminal.has(value.phase);
  if (
    statusTerminal !== phaseTerminal ||
    (statusTerminal && value.status !== value.phase)
  ) {
    context.addIssue({
      code: "custom",
      message: "Operation status and phase are contradictory.",
      path: ["phase"],
    });
  }
}

function uniqueById<Schema extends z.ZodArray>(schema: Schema): Schema {
  return schema.superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, candidate] of values.entries()) {
      const value = candidate as {
        readonly id?: string;
        readonly kind?: string;
      };
      const key = value.id ?? value.kind;
      if (!key || !seen.has(key)) {
        if (key) seen.add(key);
        continue;
      }
      context.addIssue({
        code: "custom",
        message: `Duplicate descriptor "${key}".`,
        path: [index],
      });
    }
  }) as Schema;
}

function uniqueProviderFeatures<Schema extends z.ZodArray>(
  schema: Schema,
): Schema {
  return schema.superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const candidate = value as {
        readonly ref?: {
          readonly featureId?: string;
          readonly schemaVersion?: number;
        };
      };
      const ref = candidate.ref;
      if (!ref?.featureId || ref.schemaVersion === undefined) continue;
      const key = `${ref.featureId}@${ref.schemaVersion}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate provider feature "${key}".`,
          path: [index],
        });
      }
      seen.add(key);
    }
  }) as Schema;
}

function requireConsistentProviderFeatureProjection(
  projection: {
    readonly capabilities: {
      readonly providerFeatures: readonly {
        readonly ref: {
          readonly featureId: string;
          readonly schemaVersion: number;
        };
        readonly revision: number;
      }[];
    };
    readonly providerFeatures: readonly {
      readonly ref: {
        readonly featureId: string;
        readonly schemaVersion: number;
      };
      readonly revision: number;
    }[];
  },
  context: z.RefinementCtx,
): void {
  const capabilities = new Map(
    projection.capabilities.providerFeatures.map((feature) => [
      providerFeatureKey(feature.ref),
      feature,
    ]),
  );
  for (const [index, feature] of projection.providerFeatures.entries()) {
    const capability = capabilities.get(providerFeatureKey(feature.ref));
    if (!capability) {
      context.addIssue({
        code: "custom",
        message:
          "Provider feature state has no matching advertised capability.",
        path: ["providerFeatures", index, "ref"],
      });
    } else if (capability.revision !== feature.revision) {
      context.addIssue({
        code: "custom",
        message:
          "Provider feature state and capability revisions are contradictory.",
        path: ["providerFeatures", index, "revision"],
      });
    }
  }
}

function requireConsistentConversationItemFeatureProjection(
  projection: {
    readonly capabilities: {
      readonly providerFeatures: readonly {
        readonly ref: {
          readonly featureId: string;
          readonly schemaVersion: number;
        };
        readonly presentationSlots: readonly string[];
      }[];
    };
    readonly itemsById: Readonly<
      Record<
        string,
        {
          readonly providerFeatures?: readonly {
            readonly ref: {
              readonly featureId: string;
              readonly schemaVersion: number;
            };
          }[];
        }
      >
    >;
  },
  context: z.RefinementCtx,
): void {
  const capabilities = new Map(
    projection.capabilities.providerFeatures.map((feature) => [
      providerFeatureKey(feature.ref),
      feature,
    ]),
  );
  for (const [itemId, item] of Object.entries(projection.itemsById)) {
    for (const [index, feature] of (item.providerFeatures ?? []).entries()) {
      const capability = capabilities.get(providerFeatureKey(feature.ref));
      if (!capability) {
        context.addIssue({
          code: "custom",
          message:
            "Provider feature item presentation has no matching advertised capability.",
          path: ["itemsById", itemId, "providerFeatures", index, "ref"],
        });
      } else if (!capability.presentationSlots.includes("conversation_item")) {
        context.addIssue({
          code: "custom",
          message:
            "Provider feature item presentation requires the conversation_item slot.",
          path: ["itemsById", itemId, "providerFeatures", index, "ref"],
        });
      }
    }
  }
}

function providerFeatureKey(ref: {
  readonly featureId: string;
  readonly schemaVersion: number;
}): string {
  return `${ref.featureId}@${ref.schemaVersion}`;
}

function requireBoundedTimelineMaps(
  value: {
    orderedTurnIds: readonly string[];
    turnsById: Record<string, ConversationTurn>;
    forksByTurnId: Record<string, TurnForkCapability>;
    itemsById: Record<string, ConversationItem>;
    activeTurnId?: string;
  },
  context: z.RefinementCtx,
): void {
  requireConsistentTimelineMaps(value, context);
  requireSerializedByteLimit(
    value,
    context,
    MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    "Normalized snapshot or history page exceeds the serialized byte limit.",
  );
}

function requireConsistentTimelineMaps(
  value: {
    orderedTurnIds: readonly string[];
    turnsById: Record<string, ConversationTurn>;
    forksByTurnId: Record<string, TurnForkCapability>;
    itemsById: Record<string, ConversationItem>;
    activeTurnId?: string;
  },
  context: z.RefinementCtx,
): void {
  const maximumTurns = MAXIMUM_NORMALIZED_TIMELINE_TURNS;
  const maximumItems = MAXIMUM_NORMALIZED_TIMELINE_ITEMS;
  if (Object.keys(value.turnsById).length > maximumTurns) {
    context.addIssue({
      code: "custom",
      message: "Timeline contains too many turns.",
      path: ["turnsById"],
    });
  }
  if (Object.keys(value.itemsById).length > maximumItems) {
    context.addIssue({
      code: "custom",
      message: "Timeline contains too many items.",
      path: ["itemsById"],
    });
  }
  requireUniqueTimelineIdentifiers(
    value.orderedTurnIds,
    context,
    ["orderedTurnIds"],
    "Timeline turn identifiers must be unique.",
  );
  const orderedTurnIds = new Set(value.orderedTurnIds);
  const forkTurnIds = new Set(Object.keys(value.forksByTurnId));
  const referencedItemIds = new Set<string>();
  for (const [recordKey, turn] of Object.entries(value.turnsById)) {
    if (turn.id !== recordKey) {
      context.addIssue({
        code: "custom",
        message: "Turn record key does not match its identifier.",
        path: ["turnsById", recordKey, "id"],
      });
    }
    if (!orderedTurnIds.has(recordKey)) {
      context.addIssue({
        code: "custom",
        message: "Timeline contains an unordered turn record.",
        path: ["turnsById", recordKey],
      });
    }
    for (const itemId of turn.orderedItemIds) {
      const item = value.itemsById[itemId];
      if (!item) {
        context.addIssue({
          code: "custom",
          message: "Turn references a missing item.",
          path: ["turnsById", recordKey, "orderedItemIds"],
        });
        continue;
      }
      if (item.turnId !== recordKey) {
        context.addIssue({
          code: "custom",
          message: "Conversation item belongs to another turn.",
          path: ["itemsById", itemId, "turnId"],
        });
      }
      if (referencedItemIds.has(itemId)) {
        context.addIssue({
          code: "custom",
          message: "Conversation item is referenced by more than one turn.",
          path: ["itemsById", itemId],
        });
      }
      referencedItemIds.add(itemId);
    }
  }
  for (const turnId of value.orderedTurnIds) {
    if (!value.turnsById[turnId]) {
      context.addIssue({
        code: "custom",
        message: "Timeline references a missing turn.",
        path: ["orderedTurnIds"],
      });
    }
    const fork = value.forksByTurnId[turnId];
    if (!fork) {
      context.addIssue({
        code: "custom",
        message: "Timeline turn is missing its fork capability.",
        path: ["forksByTurnId", turnId],
      });
    } else {
      if (fork.sourceTurnId !== turnId) {
        context.addIssue({
          code: "custom",
          message: "Fork capability source turn does not match its record key.",
          path: ["forksByTurnId", turnId, "sourceTurnId"],
        });
      }
      if (fork.expectedTurnRevision !== value.turnsById[turnId]?.revision) {
        context.addIssue({
          code: "custom",
          message: "Fork capability revision does not match its source turn.",
          path: ["forksByTurnId", turnId, "expectedTurnRevision"],
        });
      }
    }
  }
  for (const turnId of forkTurnIds) {
    if (!orderedTurnIds.has(turnId)) {
      context.addIssue({
        code: "custom",
        message: "Timeline contains a fork capability for an unknown turn.",
        path: ["forksByTurnId", turnId],
      });
    }
  }
  for (const [recordKey, item] of Object.entries(value.itemsById)) {
    if (item.id !== recordKey) {
      context.addIssue({
        code: "custom",
        message: "Item record key does not match its identifier.",
        path: ["itemsById", recordKey, "id"],
      });
    }
    if (!referencedItemIds.has(recordKey)) {
      context.addIssue({
        code: "custom",
        message: "Timeline contains an unreferenced item record.",
        path: ["itemsById", recordKey],
      });
    }
  }
  if (value.activeTurnId && !value.turnsById[value.activeTurnId]) {
    context.addIssue({
      code: "custom",
      message: "Active turn is missing from the timeline.",
      path: ["activeTurnId"],
    });
  }
}

function requireUniqueTimelineIdentifiers(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>,
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
