import { formAnswersSchema } from "./interactions.js";
import {
  environmentVariableOverridesSchema,
  environmentVariablesRevisionSchema,
} from "./environment-variables.js";
import { steerTargetSchema, threadRunStateSchema } from "./conversation.js";
import { backgroundActivitySchema } from "./background-activity.js";
import { z } from "zod";
import { questionRequestsResultSchema } from "./questions.js";
import {
  automationMisfirePolicySchema,
  automationRunModeSchema,
  applicationTurnIdSchema,
  environmentIdSchema,
  mutationIdSchema,
  stashIdSchema,
  taskIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "./domain.js";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
} from "./automation.js";
import {
  providerFeatureActionIdSchema,
  providerFeatureArgumentsSchema,
  providerFeatureRefSchema,
} from "./provider-feature.js";
import { openTaskDispositionSchema, taskTitleSchema } from "./tasks.js";
import {
  agentToolAccessBoundarySchema,
  agentToolIdSchema,
  agentToolPresentationSchema,
  activityDetailModeSchema,
  executionWorkspaceSelectionSchema,
  normalizedDraftSchema,
  queuedInputSummarySchema,
  threadEventIdSchema,
} from "./conversation.js";
import {
  contextExcerptArraySchema,
  requireComposerInputByteLimit,
} from "./context-excerpts.js";
import { THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE } from "./diagnostics.js";
import {
  browserQuestionnaireAnswerSchema,
  INTERACTION_LIMITS,
} from "./interactions.js";
import {
  composerAttachmentDescriptorSchema,
  composerAttachmentFileNameSchema,
  composerAttachmentIdSchema,
  composerAttachmentReferenceArraySchema,
} from "./composer-attachments.js";
import { composerTaskReferenceIdsSchema } from "./tasks.js";
import {
  agentToolBootstrapPolicySchema,
  normalizedAgentConfigurationOverridesSchema,
  savedAgentIdSchema,
} from "./saved-agents.js";
import { applicationEventIdSchema } from "./application.js";

export const apiErrorCodeSchema = z.enum([
  "authentication_required",
  "authentication_scope_denied",
  "authentication_busy",
  "pairing_invalid",
  "pairing_rate_limited",
  "invalid_content_type",
  "bad_request",
  "not_found",
  "conflict",
  "draft_revision_conflict",
  "inventory_revision_conflict",
  "pin_revision_conflict",
  "bookmark_revision_conflict",
  "group_assignment_revision_conflict",
  "group_revision_conflict",
  "group_name_conflict",
  "task_revision_conflict",
  "task_reference_unresolved",
  "task_context_too_large",
  "workspace_file_revision_conflict",
  "workspace_file_download_too_large",
  "workspace_file_write_outcome_unknown",
  "range_not_supported",
  "invalid_transition",
  "attachment_quota_exceeded",
  "stash_limit_reached",
  "cursor_invalid",
  "workspace_missing",
  "environment_unavailable",
  "runtime_unavailable",
  "backend_unavailable",
  "backend_incompatible_protocol",
  "backend_invalid_state",
  "backend_permission_denied",
  "backend_not_found",
  "backend_overloaded",
  "backend_rejected",
  "backend_submission_unknown",
  "backend_internal",
  "materialization_unresolved",
  "archived_thread",
  "operation_outcome_uncertain",
  "application_draining",
  "attachment_payload_too_large",
  "thread_payload_too_large",
  "csrf_token_invalid",
  "host_not_allowed",
  "origin_not_allowed",
  "forwarded_origin_not_allowed",
  "provider_pulse_unavailable",
  "experimental_usage_disabled",
  "internal_error",
]);

export const apiErrorDetailSchema = z.strictObject({
  code: apiErrorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});

export const apiErrorSchema = z.strictObject({
  error: apiErrorDetailSchema,
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * One classified failure that prevented a thread EventSource from reaching
 * its initial authoritative snapshot. HTTP status and JSON bodies are opaque
 * to native EventSource, so this control frame is the browser-visible error
 * boundary for a single stream attempt.
 */
export const threadLoadErrorSchema = z.strictObject({
  format: z.literal("sedes-thread-load-error-v1"),
  requestId: z.string().min(1).max(128),
  error: apiErrorDetailSchema,
});
export type ThreadLoadError = z.infer<typeof threadLoadErrorSchema>;

const normalizedThreadTitleSchema = z
  .string()
  .trim()
  .max(240)
  .transform((title) => title.replace(/[\r\n]+/g, " ").trim());

/** Shared title normalization for rename (trim, collapse newlines, 1–240). */
export const threadTitleInputSchema = normalizedThreadTitleSchema.pipe(
  z.string().min(1).max(240),
);

export const DEFAULT_THREAD_TITLE = "New thread";

/**
 * Required create-time title. Empty/whitespace values coerce to
 * {@link DEFAULT_THREAD_TITLE}; non-empty values use the same rules as rename.
 */
export const createThreadTitleSchema = normalizedThreadTitleSchema
  .transform((title) => {
    return title.length === 0 ? DEFAULT_THREAD_TITLE : title;
  })
  .pipe(z.string().min(1).max(240));

const createThreadTargetIdSchema = z.string().min(1).max(160);

export const createThreadRequestSchema = z.strictObject({
  environmentVariables: environmentVariableOverridesSchema.optional(),
  environmentVariablesRevision: environmentVariablesRevisionSchema.optional(),
  workspaceId: workspaceIdSchema,
  title: createThreadTitleSchema,
  executionWorkspace: executionWorkspaceSelectionSchema,
  configuration: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("saved_agent"),
      agentId: savedAgentIdSchema,
      targetId: createThreadTargetIdSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("custom"),
      targetId: createThreadTargetIdSchema,
      backendOverrides: normalizedAgentConfigurationOverridesSchema.optional(),
      sedesTools: agentToolBootstrapPolicySchema.optional(),
    }),
  ]),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const createThreadResultSchema = z.strictObject({
  threadId: threadIdSchema,
  workspaceId: workspaceIdSchema,
  targetId: createThreadTargetIdSchema,
});
export type CreateThreadResult = z.infer<typeof createThreadResultSchema>;

export const createThreadFromSettingsRequestSchema = z.strictObject({
  title: createThreadTitleSchema,
  mutationId: mutationIdSchema,
});
export type CreateThreadFromSettingsRequest = z.infer<
  typeof createThreadFromSettingsRequestSchema
>;

const automationDefinitionFields = {
  prompt: automationPromptSchema,
  runMode: automationRunModeSchema,
  schedule: automationScheduleSchema,
  misfirePolicy: automationMisfirePolicySchema,
  precheck: automationPrecheckSchema.nullable(),
} as const;

export const createAutomationRequestSchema = z.strictObject({
  ...automationDefinitionFields,
  mutationId: mutationIdSchema,
});

export const updateAutomationRequestSchema = z.strictObject({
  ...automationDefinitionFields,
  expectedRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});

export const automationStateRequestSchema = z.strictObject({
  action: z.enum(["enable", "pause"]),
  expectedRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});

export const deleteAutomationRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});

export const runAutomationNowRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
});

export const previewAutomationScheduleRequestSchema = z.strictObject({
  schedule: automationScheduleSchema,
  count: z.number().int().min(1).max(10).default(5),
});

export const testAutomationPrecheckRequestSchema = z.strictObject({
  prompt: automationPromptSchema,
  precheck: automationPrecheckSchema,
});

export const dismissThreadAttentionRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("wake"),
      wokeAt: z.iso.datetime(),
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      kind: z.literal("automation_context"),
      runId: z.uuid(),
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      kind: z.literal("unseen_completion"),
      operationId: z.string().min(1).max(160),
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      kind: z.literal("queue_failure"),
      queuedInputId: z.string().min(1).max(160),
      mutationId: mutationIdSchema,
    }),
  ],
);
export type DismissThreadAttentionRequest = z.infer<
  typeof dismissThreadAttentionRequestSchema
>;

export const listAutomationRunsQuerySchema = z.strictObject({
  cursor: z.string().max(2048).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const resolveAutomationRunRequestSchema = z.strictObject({
  action: z.literal("mark_failed"),
});

export const automationRunRouteParametersSchema = z.strictObject({
  threadId: threadIdSchema,
  runId: z.uuid(),
});

export const openWorkspaceRequestSchema = z.strictObject({
  environmentId: environmentIdSchema,
  path: z.string().min(1).max(4096),
});

export const saveDraftRequestSchema = z
  .strictObject({
    text: z.string().max(262_144),
    selectedSkillId: z.string().min(1).max(160).optional(),
    contextExcerpts: contextExcerptArraySchema,
    attachmentIds: composerAttachmentReferenceArraySchema,
    taskReferenceIds: composerTaskReferenceIdsSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .superRefine(requireComposerInputByteLimit);

/** Metadata accompanying the raw, immutable attachment request body. */
export const putComposerAttachmentQuerySchema = z.strictObject({
  fileName: composerAttachmentFileNameSchema,
  declaredMediaType: z.string().min(1).max(127).optional(),
});
export type PutComposerAttachmentQuery = z.infer<
  typeof putComposerAttachmentQuerySchema
>;

export const putComposerAttachmentResultSchema = z.strictObject({
  attachment: composerAttachmentDescriptorSchema,
});
export type PutComposerAttachmentResult = z.infer<
  typeof putComposerAttachmentResultSchema
>;

export const composerAttachmentRouteParametersSchema = z.strictObject({
  threadId: threadIdSchema,
  attachmentId: composerAttachmentIdSchema,
});
export type ComposerAttachmentRouteParameters = z.infer<
  typeof composerAttachmentRouteParametersSchema
>;

export const stashDraftRequestSchema = z.strictObject({
  expectedDraftRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});

export const restoreStashRequestSchema = z.strictObject({
  expectedDraftRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});

export const stashRouteParametersSchema = z.strictObject({
  threadId: threadIdSchema,
  stashId: stashIdSchema,
});

const executionWorkspaceArchiveDispositionSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("keep") }),
    z.strictObject({
      kind: z.literal("delete"),
      expectedRevision: z.number().int().nonnegative(),
      operationId: mutationIdSchema,
    }),
  ],
);

export const inventoryTransitionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("settle"),
    expectedRevision: z.number().int().nonnegative(),
    expectedStashedPromptCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    mutationId: mutationIdSchema,
    openTaskDisposition: openTaskDispositionSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("unsettle"),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
  }),
  z.strictObject({
    action: z.literal("snooze"),
    snoozedUntil: z.iso.datetime(),
    wakeReminder: z.string().min(1).max(1_000).optional(),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
  }),
  z.strictObject({
    action: z.literal("remind"),
    wakeReminder: z.string().trim().min(1).max(1_000),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
  }),
  z.strictObject({
    action: z.literal("wake"),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
  }),
  z.strictObject({
    action: z.literal("archive"),
    expectedRevision: z.number().int().nonnegative(),
    expectedStashedPromptCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    mutationId: mutationIdSchema,
    openTaskDisposition: openTaskDispositionSchema.optional(),
    executionWorkspaceDisposition: executionWorkspaceArchiveDispositionSchema,
  }),
  z.strictObject({
    action: z.literal("archive_family"),
    expectedRevision: z.number().int().nonnegative(),
    expectedStashedPromptCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    mutationId: mutationIdSchema,
    openTaskDisposition: openTaskDispositionSchema.optional(),
    executionWorkspaceDisposition: executionWorkspaceArchiveDispositionSchema,
  }),
  z.strictObject({
    action: z.literal("restore"),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
  }),
]);
export type InventoryTransitionRequest = z.infer<
  typeof inventoryTransitionSchema
>;

export const updateThreadPinRequestSchema = z.strictObject({
  pinned: z.boolean(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: mutationIdSchema,
});
export type UpdateThreadPinRequest = z.infer<
  typeof updateThreadPinRequestSchema
>;

const archiveAvailabilitySchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    unavailableReason: z.string().min(1).max(500),
  }),
]);

export const ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT = 100;

const archiveImpactTaskSummarySchema = z.strictObject({
  id: taskIdSchema,
  title: taskTitleSchema,
  threadId: threadIdSchema,
});

const archiveImpactTaskCollectionSchema = z
  .strictObject({
    items: z
      .array(archiveImpactTaskSummarySchema)
      .max(ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    omitted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    ({ items, total, omitted }) => total === items.length + omitted,
    "Archive task totals must equal returned and omitted summaries.",
  );

export const MAXIMUM_BULK_INVENTORY_TARGETS = 1_000;
export const BULK_INVENTORY_BLOCKER_SUMMARY_LIMIT = 100;
export const MAXIMUM_BULK_INVENTORY_OPEN_TASKS = 10_000;

export const bulkInventoryActionSchema = z.enum([
  "settle",
  "unsettle",
  "archive",
]);
export type BulkInventoryAction = z.infer<typeof bulkInventoryActionSchema>;

const bulkInventoryThreadIdsSchema = z
  .array(threadIdSchema)
  .min(2)
  .max(MAXIMUM_BULK_INVENTORY_TARGETS)
  .refine(
    (threadIds) => new Set(threadIds).size === threadIds.length,
    "Bulk inventory thread IDs must be unique.",
  );

export const bulkInventoryImpactRequestSchema = z.strictObject({
  action: bulkInventoryActionSchema,
  threadIds: bulkInventoryThreadIdsSchema,
});
export type BulkInventoryImpactRequest = z.infer<
  typeof bulkInventoryImpactRequestSchema
>;

export const bulkInventoryTargetSchema = z.strictObject({
  threadId: threadIdSchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BulkInventoryTarget = z.infer<typeof bulkInventoryTargetSchema>;

const bulkInventoryTargetsSchema = z
  .array(bulkInventoryTargetSchema)
  .min(2)
  .max(MAXIMUM_BULK_INVENTORY_TARGETS)
  .refine(
    (targets) =>
      new Set(targets.map(({ threadId }) => threadId)).size === targets.length,
    "Bulk inventory targets must be unique.",
  );

export const bulkInventoryBlockerReasonSchema = z.enum(["running", "active"]);
export type BulkInventoryBlockerReason = z.infer<
  typeof bulkInventoryBlockerReasonSchema
>;

const bulkInventoryBlockerSchema = z.strictObject({
  threadId: threadIdSchema,
  reason: bulkInventoryBlockerReasonSchema,
});

const bulkInventoryBlockerCollectionSchema = z
  .strictObject({
    items: z
      .array(bulkInventoryBlockerSchema)
      .max(BULK_INVENTORY_BLOCKER_SUMMARY_LIMIT),
    total: z.number().int().nonnegative().max(MAXIMUM_BULK_INVENTORY_TARGETS),
    omitted: z.number().int().nonnegative().max(MAXIMUM_BULK_INVENTORY_TARGETS),
  })
  .refine(
    ({ items, total, omitted }) => total === items.length + omitted,
    "Bulk inventory blocker totals must equal returned and omitted summaries.",
  )
  .refine(
    ({ items }) =>
      new Set(items.map(({ threadId }) => threadId)).size === items.length,
    "Bulk inventory blocker threads must be unique.",
  );

export const bulkInventoryImpactSchema = z
  .strictObject({
    action: bulkInventoryActionSchema,
    targets: bulkInventoryTargetsSchema,
    targetCount: z.number().int().min(2).max(MAXIMUM_BULK_INVENTORY_TARGETS),
    affectedCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_BULK_INVENTORY_TARGETS),
    unchangedCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_BULK_INVENTORY_TARGETS),
    blockers: bulkInventoryBlockerCollectionSchema,
    pendingQuestionCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    openTasks: archiveImpactTaskCollectionSchema,
    stashedPromptCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    available: z.boolean(),
  })
  .refine(
    ({ targets, targetCount, affectedCount, unchangedCount }) =>
      targets.length === targetCount &&
      affectedCount + unchangedCount === targetCount,
    "Bulk inventory impact counts must match its frozen targets.",
  )
  .refine(
    ({ available, blockers, affectedCount, openTasks }) =>
      available ===
      (blockers.total === 0 &&
        affectedCount > 0 &&
        openTasks.total <= MAXIMUM_BULK_INVENTORY_OPEN_TASKS),
    "Bulk inventory availability must match its blockers and affected threads.",
  );
export type BulkInventoryImpact = z.infer<typeof bulkInventoryImpactSchema>;

const confirmedBulkInventoryCountsSchema = {
  expectedStashedPromptCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  expectedOpenTaskCount: z
    .number()
    .int()
    .nonnegative()
    .max(MAXIMUM_BULK_INVENTORY_OPEN_TASKS),
  openTaskDisposition: openTaskDispositionSchema.optional(),
};

export const bulkInventoryMutationRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.strictObject({
      action: z.literal("settle"),
      targets: bulkInventoryTargetsSchema,
      mutationId: mutationIdSchema,
      ...confirmedBulkInventoryCountsSchema,
    }),
    z.strictObject({
      action: z.literal("unsettle"),
      targets: bulkInventoryTargetsSchema,
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      action: z.literal("archive"),
      targets: bulkInventoryTargetsSchema,
      mutationId: mutationIdSchema,
      ...confirmedBulkInventoryCountsSchema,
    }),
  ],
);
export type BulkInventoryMutationRequest = z.infer<
  typeof bulkInventoryMutationRequestSchema
>;

export const bulkInventoryMutationResultSchema = z.strictObject({
  changedThreadIds: z
    .array(threadIdSchema)
    .min(1)
    .max(MAXIMUM_BULK_INVENTORY_TARGETS)
    .refine(
      (threadIds) => new Set(threadIds).size === threadIds.length,
      "Changed bulk inventory thread IDs must be unique.",
    ),
});
export type BulkInventoryMutationResult = z.infer<
  typeof bulkInventoryMutationResultSchema
>;

const threadExecutionWorkspaceGitStatusSchema = z.discriminatedUnion(
  "available",
  [
    z.strictObject({
      available: z.literal(true),
      trackedChangeCount: z.number().int().nonnegative(),
      untrackedFileCount: z.number().int().nonnegative(),
      upstream: z.string().min(1).max(1_024).nullable(),
      aheadCount: z.number().int().nonnegative().nullable(),
    }),
    z.strictObject({
      available: z.literal(false),
      reason: z.string().min(1).max(500),
    }),
  ],
);

export const threadExecutionWorkspaceResourceSchema = z.discriminatedUnion(
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
      allocationRevision: z.number().int().nonnegative(),
      networkProfile: z.enum(["isolated", "execution_host"]),
      hostPaths: z.strictObject({
        home: z.string().min(1).max(4_096),
        workspace: z.string().min(1).max(4_096),
      }),
      branch: z.string().min(1).max(1_024).nullable(),
      gitStatus: threadExecutionWorkspaceGitStatusSchema,
    }),
  ],
);
export type ThreadExecutionWorkspaceResource = z.infer<
  typeof threadExecutionWorkspaceResourceSchema
>;

export const threadArchiveImpactSchema = z.strictObject({
  descendantCount: z.number().int().nonnegative().max(10_000),
  pendingQuestions: z.strictObject({
    root: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    descendants: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  stashedPrompts: z.strictObject({
    root: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    descendants: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  openTasks: z.strictObject({
    root: archiveImpactTaskCollectionSchema,
    descendants: archiveImpactTaskCollectionSchema,
  }),
  executionWorkspace: threadExecutionWorkspaceResourceSchema,
  archiveOnly: archiveAvailabilitySchema,
  archiveAll: archiveAvailabilitySchema,
});
export type ThreadArchiveImpact = z.infer<typeof threadArchiveImpactSchema>;

export const deleteThreadExecutionWorkspaceRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  operationId: mutationIdSchema,
});
export type DeleteThreadExecutionWorkspaceRequest = z.infer<
  typeof deleteThreadExecutionWorkspaceRequestSchema
>;

export const deleteThreadExecutionWorkspaceResultSchema = z.strictObject({
  state: z.literal("deleted"),
  allocationRevision: z.number().int().nonnegative(),
  operationId: mutationIdSchema,
});
export type DeleteThreadExecutionWorkspaceResult = z.infer<
  typeof deleteThreadExecutionWorkspaceResultSchema
>;

export const importThreadExecutionWorkspaceRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  operationId: mutationIdSchema,
});
export type ImportThreadExecutionWorkspaceRequest = z.infer<
  typeof importThreadExecutionWorkspaceRequestSchema
>;

export const importThreadExecutionWorkspaceResultSchema = z.strictObject({
  branch: z.string().min(1).max(1_024),
  headOid: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/),
  sourceRepositoryPath: z.string().min(1).max(4_096),
});
export type ImportThreadExecutionWorkspaceResult = z.infer<
  typeof importThreadExecutionWorkspaceResultSchema
>;

export const handoffThreadExecutionWorkspaceRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  operationId: mutationIdSchema,
});
export type HandoffThreadExecutionWorkspaceRequest = z.infer<
  typeof handoffThreadExecutionWorkspaceRequestSchema
>;

export const handoffThreadExecutionWorkspaceResultSchema = z.strictObject({
  state: z.literal("retained"),
  allocationRevision: z.number().int().nonnegative(),
  workspacePath: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(1_024),
});
export type HandoffThreadExecutionWorkspaceResult = z.infer<
  typeof handoffThreadExecutionWorkspaceResultSchema
>;

export const threadForceResetBlockerKindSchema = z.enum([
  "pending_interaction",
  "completion_callback",
  "queued_input",
  "conversation_operation",
  "provider_feature_operation",
  "creation_attempt",
  "thread_creation_state",
  "fork_origin",
  "automation_run",
  "conversation_runtime",
]);
export type ThreadForceResetBlockerKind = z.infer<
  typeof threadForceResetBlockerKindSchema
>;

export const threadForceResetBlockerSummarySchema = z.strictObject({
  kind: threadForceResetBlockerKindSchema,
  count: z.number().int().positive().max(10_000),
});
export type ThreadForceResetBlockerSummary = z.infer<
  typeof threadForceResetBlockerSummarySchema
>;

const threadForceResetBlockerSummariesSchema = z
  .array(threadForceResetBlockerSummarySchema)
  .max(threadForceResetBlockerKindSchema.options.length)
  .refine(
    (summaries) =>
      new Set(summaries.map(({ kind }) => kind)).size === summaries.length,
    "Force-reset blocker kinds must be unique.",
  );

export const threadForceResetWarningSchema = z.strictObject({
  code: z.enum([
    "running_work_will_stop",
    "provider_side_effects_may_remain",
    "native_fork_orphan_may_remain",
    "provider_activity_may_reappear",
  ]),
  message: z.string().min(1).max(500),
});
export type ThreadForceResetWarning = z.infer<
  typeof threadForceResetWarningSchema
>;

const forceResetFingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

/** One thread a force reset would touch, named for the preview. */
export const threadForceResetAffectedThreadSchema = z.strictObject({
  threadId: threadIdSchema,
  title: z.string().min(1).max(240),
  /** The loaded runtime the reset would replace, if any. */
  runtime: z
    .strictObject({
      runState: threadRunStateSchema,
      backgroundActivity: backgroundActivitySchema.optional(),
    })
    .optional(),
});

export const threadForceResetImpactSchema = z.strictObject({
  blockerFingerprint: forceResetFingerprintSchema,
  resettable: z.boolean(),
  blockers: threadForceResetBlockerSummariesSchema,
  affectedThreads: z.array(threadForceResetAffectedThreadSchema).min(1).max(10_000),
  warnings: z.array(threadForceResetWarningSchema).max(4),
});
export type ThreadForceResetImpact = z.infer<
  typeof threadForceResetImpactSchema
>;

export const threadForceResetRequestSchema = z.strictObject({
  expectedBlockerFingerprint: forceResetFingerprintSchema,
  mutationId: mutationIdSchema,
});
export type ThreadForceResetRequest = z.infer<
  typeof threadForceResetRequestSchema
>;

export const threadForceResetResultSchema = z.strictObject({
  resetAt: z.number().int().nonnegative(),
  blockerFingerprint: forceResetFingerprintSchema,
  resetBlockers: threadForceResetBlockerSummariesSchema,
  affectedThreadIds: z.array(threadIdSchema).min(1).max(10_000),
});
export type ThreadForceResetResult = z.infer<
  typeof threadForceResetResultSchema
>;

export const threadArchiveMutationResultSchema = z.strictObject({
  archivedThreadIds: z.array(threadIdSchema).min(1).max(10_000),
});
export type ThreadArchiveMutationResult = z.infer<
  typeof threadArchiveMutationResultSchema
>;

export const threadRouteParametersSchema = z.strictObject({
  threadId: threadIdSchema,
});

export const threadSnapshotQuerySchema = z.strictObject({
  activityDetail: activityDetailModeSchema,
});

export const threadEventStreamQuerySchema = z.strictObject({
  activityDetail: activityDetailModeSchema,
  diagnostics: z.literal(THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE).optional(),
  replayCursor: threadEventIdSchema.optional(),
});

export const applicationEventStreamQuerySchema = z
  .strictObject({
    replayCursor: applicationEventIdSchema.optional(),
    handshake: z.literal("authoritative_replacement").optional(),
  })
  .superRefine((query, context) => {
    if (query.replayCursor && query.handshake) {
      context.addIssue({
        code: "custom",
        message:
          "Application replay and authoritative replacement are mutually exclusive.",
      });
    }
  });

export const forkThreadRequestSchema = z.discriminatedUnion("boundary", [
  z.strictObject({
    boundary: z.literal("selected_completed_turn"),
    sourceTurnId: applicationTurnIdSchema,
    expectedTurnRevision: z.number().int().nonnegative(),
    mutationId: mutationIdSchema,
    environmentVariables: environmentVariableOverridesSchema.optional(),
  }),
  z.strictObject({
    boundary: z.literal("latest_provider_snapshot"),
    mutationId: mutationIdSchema,
    environmentVariables: environmentVariableOverridesSchema.optional(),
  }),
]);
export type ForkThreadRequest = z.infer<typeof forkThreadRequestSchema>;

export const forkThreadResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("created"),
    childThreadId: threadIdSchema,
  }),
  z.strictObject({
    status: z.literal("recovery_required"),
    childThreadId: threadIdSchema,
    retryable: z.boolean(),
    uncertaintyKind: z.literal("fork_unknown").nullable(),
    diagnostic: z.string().min(1).max(500),
  }),
  z.strictObject({
    status: z.literal("aborted"),
    childThreadId: threadIdSchema,
    diagnostic: z.string().min(1).max(500),
    /** False when a new fork of the same boundary would fail the same way. */
    restartable: z.boolean(),
  }),
]);
export type ForkThreadResult = z.infer<typeof forkThreadResultSchema>;

export const updateThreadLineagePlacementRequestSchema = z.strictObject({
  mode: z.enum(["nested_under_source", "top_level"]),
  expectedRevision: z.number().int().nonnegative(),
  mutationId: mutationIdSchema,
});
export type UpdateThreadLineagePlacementRequest = z.infer<
  typeof updateThreadLineagePlacementRequestSchema
>;

export const listThreadDescendantsQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const THREAD_HISTORY_PAGE_SIZES = [5, 10, 25, 50, 100] as const;
export type ThreadHistoryPageSize = (typeof THREAD_HISTORY_PAGE_SIZES)[number];

export const loadThreadHistoryRequestSchema = z.strictObject({
  activityDetail: activityDetailModeSchema,
  cursor: z.string().min(1).max(512),
  limit: z.union([
    z.literal(THREAD_HISTORY_PAGE_SIZES[0]),
    z.literal(THREAD_HISTORY_PAGE_SIZES[1]),
    z.literal(THREAD_HISTORY_PAGE_SIZES[2]),
    z.literal(THREAD_HISTORY_PAGE_SIZES[3]),
    z.literal(THREAD_HISTORY_PAGE_SIZES[4]),
  ]),
});
export type LoadThreadHistoryRequest = z.infer<
  typeof loadThreadHistoryRequestSchema
>;

export const seekThreadHistoryRequestSchema = z.strictObject({
  activityDetail: activityDetailModeSchema,
  turnId: applicationTurnIdSchema,
});

const threadPerformOperationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("rename"),
    title: threadTitleInputSchema,
  }),
  z.strictObject({
    action: z.literal("compact"),
    instructions: z.string().max(65_536).optional(),
  }),
  z.strictObject({
    action: z.literal("set_setting"),
    settingId: z.enum(["model", "thinking_level", "tool_access"]),
    value: z.string().min(1).max(1_024).nullable(),
  }),
  z.strictObject({
    action: z.literal("perform_provider_feature"),
    feature: providerFeatureRefSchema,
    actionId: providerFeatureActionIdSchema,
    arguments: providerFeatureArgumentsSchema,
    /** Required evidence when the advertised action requires confirmation. */
    confirmed: z.literal(true).optional(),
    expectedFeatureRevision: z.number().int().nonnegative(),
  }),
]);

export const threadInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("form"), answers: formAnswersSchema }),
  z.strictObject({ kind: z.literal("cancel") }),
  z.strictObject({
    kind: z.literal("choice"),
    selectedOptionIds: z.array(z.string().min(1).max(160)).max(64),
  }),
  z.strictObject({
    kind: z.literal("confirmation"),
    confirmed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("text_input"),
    value: z.string().max(65_536),
  }),
  z.strictObject({
    kind: z.literal("editor"),
    value: z.string().max(262_144),
  }),
  z.strictObject({
    kind: z.literal("decision"),
    selectedActionId: z.string().min(1).max(160),
  }),
  z
    .strictObject({
      kind: z.literal("questionnaire"),
      answers: z
        .array(browserQuestionnaireAnswerSchema)
        .min(1)
        .max(INTERACTION_LIMITS.questionnaireQuestions),
    })
    .superRefine((response, context) => {
      const questionIds = new Set<string>();
      for (const [index, answer] of response.answers.entries()) {
        if (questionIds.has(answer.questionId)) {
          context.addIssue({
            code: "custom",
            message: "Questionnaire answers must have unique question IDs.",
            path: ["answers", index, "questionId"],
          });
        }
        questionIds.add(answer.questionId);
      }
    }),
]);
export type ThreadInteractionResponse = z.infer<
  typeof threadInteractionResponseSchema
>;

const threadPerformRequestSchema = z
  .strictObject({
    kind: z.literal("perform"),
    mutationId: mutationIdSchema,
    expectedThreadRevision: z.number().int().nonnegative(),
    expectedSettingsRevision: z.number().int().nonnegative().optional(),
    operation: threadPerformOperationSchema,
  })
  .superRefine((request, context) => {
    const updatesSettings = request.operation.action === "set_setting";
    if (updatesSettings && request.expectedSettingsRevision === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "A settings revision is required for settings update operations.",
        path: ["expectedSettingsRevision"],
      });
    } else if (
      !updatesSettings &&
      request.expectedSettingsRevision !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A settings revision is only valid for settings update operations.",
        path: ["expectedSettingsRevision"],
      });
    }
  });

export const threadApplicationOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("move_draft"),
    workspaceId: workspaceIdSchema,
    mutationId: mutationIdSchema,
    expectedThreadRevision: z.number().int().nonnegative(),
  }),
  z
    .strictObject({
      kind: z.literal("deliver"),
      mode: z.enum(["submit", "steer", "queue"]),
      mutationId: mutationIdSchema,
      expectedThreadRevision: z.number().int().nonnegative(),
      expectedDraftRevision: z.number().int().nonnegative(),
      steerTarget: steerTargetSchema.optional(),
    })
    .superRefine((request, context) => {
      const hasSteerTarget = request.steerTarget !== undefined;
      if (request.mode === "steer" && !hasSteerTarget) {
        context.addIssue({
          code: "custom",
          message: "Steer delivery requires an explicit target.",
          path: ["steerTarget"],
        });
      } else if (request.mode !== "steer" && hasSteerTarget) {
        context.addIssue({
          code: "custom",
          message: "Only Steer delivery may specify a steering target.",
          path: ["steerTarget"],
        });
      }
    }),
  z.strictObject({
    kind: z.literal("interrupt"),
    operationId: z.string().min(1).max(160),
  }),
  z.strictObject({
    kind: z.literal("recover_uncertain"),
  }),
  /** Remove an unfinished fork child; its provider child is never adopted. */
  z.strictObject({
    kind: z.literal("discard_fork"),
  }),
  z.strictObject({
    kind: z.literal("cancel_queued_input"),
    queuedInputId: z.string().min(1).max(160),
    mutationId: mutationIdSchema,
    expectedThreadRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("restore_queued_input"),
    queuedInputId: z.string().min(1).max(160),
    mutationId: mutationIdSchema,
    expectedThreadRevision: z.number().int().nonnegative(),
    expectedDraftRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("steer_queued_input"),
    queuedInputId: z.string().min(1).max(160),
    mutationId: mutationIdSchema,
    expectedThreadRevision: z.number().int().nonnegative(),
  }),
  z
    .strictObject({
      kind: z.literal("set_agent_tool_policy"),
      mutationId: mutationIdSchema,
      expectedPolicyRevision: z.number().int().nonnegative(),
      enabled: z.boolean(),
      enabledToolIds: z.array(agentToolIdSchema).max(512),
      presentation: agentToolPresentationSchema,
      accessBoundary: agentToolAccessBoundarySchema,
    })
    .superRefine((operation, context) => {
      if (
        new Set(operation.enabledToolIds).size !==
        operation.enabledToolIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Enabled agent tool IDs must be unique.",
          path: ["enabledToolIds"],
        });
      }
    }),
  threadPerformRequestSchema,
  z.strictObject({
    kind: z.literal("respond"),
    operationId: mutationIdSchema,
    interactionId: z.string().min(1).max(160),
    response: threadInteractionResponseSchema,
  }),
]);
export type ThreadApplicationOperation = z.infer<
  typeof threadApplicationOperationSchema
>;

const clearedDeliveryDraftSchema = z.strictObject({
  text: z.literal(""),
  contextExcerpts: z.tuple([]),
  attachments: z.tuple([]),
  taskReferences: z.tuple([]),
  revision: normalizedDraftSchema.shape.revision,
  updatedAt: z.iso.datetime(),
});

const deliveryRecoveryRequiredResultSchema = z.strictObject({
  status: z.literal("recovery_required"),
  retryable: z.boolean(),
  draft: normalizedDraftSchema,
});

export const threadQueueMutationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("queue_cancelled"),
    queuedInputId: z.string().min(1).max(160),
    mutationId: mutationIdSchema,
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
  }),
  z.strictObject({
    status: z.literal("queue_restored"),
    queuedInputId: z.string().min(1).max(160),
    mutationId: mutationIdSchema,
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
    draft: normalizedDraftSchema,
  }),
  z.strictObject({
    status: z.literal("queue_steer_accepted"),
    queuedInputId: z.string().min(1).max(160),
    operationId: mutationIdSchema,
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
  }),
  z.strictObject({
    status: z.literal("queue_steer_pending_materialization"),
    queuedInputId: z.string().min(1).max(160),
    operationId: mutationIdSchema,
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
  }),
  z.strictObject({
    status: z.literal("queue_steer_recovery_required"),
    queuedInputId: z.string().min(1).max(160),
    operationId: mutationIdSchema,
    retryable: z.boolean(),
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
  }),
  z.strictObject({
    status: z.literal("queue_steer_restored"),
    queuedInputId: z.string().min(1).max(160),
    operationId: mutationIdSchema,
    threadRevision: z.number().int().nonnegative(),
    queue: z.array(queuedInputSummarySchema).max(500),
  }),
]);
export type ThreadQueueMutationResult = z.infer<
  typeof threadQueueMutationResultSchema
>;

/** A creation that was proven uncreated and discarded, with its reason when recorded. */
const abortedMutationResultSchema = z.strictObject({
  status: z.literal("aborted"),
  diagnostic: z.string().min(1).max(500).optional(),
});
export const threadApplicationMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("accepted"),
      operationId: z.string().min(1).max(160),
    }),
    z.strictObject({
      status: z.literal("queued"),
      queuedInputId: z.string().min(1).max(160),
    }),
    z.strictObject({
      status: z.literal("delivery_accepted"),
      operationId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.enum(["submit", "steer", "queue"]),
      threadRevision: z.number().int().nonnegative(),
      draft: clearedDeliveryDraftSchema,
    }),
    z.strictObject({
      status: z.literal("delivery_pending_materialization"),
      operationId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.literal("steer"),
      threadRevision: z.number().int().nonnegative(),
      draft: normalizedDraftSchema,
    }),
    z.strictObject({
      status: z.literal("delivery_queued"),
      queuedInputId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.enum(["submit", "steer", "queue"]),
      threadRevision: z.number().int().nonnegative(),
      draft: clearedDeliveryDraftSchema,
    }),
    z.strictObject({
      status: z.literal("recovery_required"),
      retryable: z.boolean(),
      draft: normalizedDraftSchema.optional(),
    }),
    abortedMutationResultSchema,
    z.strictObject({ status: z.literal("completed") }),
    ...threadQueueMutationResultSchema.options,
  ],
);
export type ThreadApplicationMutationResult = z.infer<
  typeof threadApplicationMutationResultSchema
>;

/**
 * Delivery has a stronger recovery contract than other thread mutations: the
 * response always carries the current durable draft, whether delivery consumed
 * it or retained it. Callers use this receipt to reconcile concurrent composer
 * edits without guessing from the recovery status.
 */
export const threadDeliveryMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("delivery_accepted"),
      operationId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.enum(["submit", "steer", "queue"]),
      threadRevision: z.number().int().nonnegative(),
      draft: clearedDeliveryDraftSchema,
    }),
    z.strictObject({
      status: z.literal("delivery_pending_materialization"),
      operationId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.literal("steer"),
      threadRevision: z.number().int().nonnegative(),
      draft: normalizedDraftSchema,
    }),
    z.strictObject({
      status: z.literal("delivery_queued"),
      queuedInputId: z.string().min(1).max(160),
      resolvedDeliveryMode: z.enum(["submit", "steer", "queue"]),
      threadRevision: z.number().int().nonnegative(),
      draft: clearedDeliveryDraftSchema,
    }),
    deliveryRecoveryRequiredResultSchema,
    abortedMutationResultSchema,
  ],
);
export type ThreadDeliveryMutationResult = z.infer<
  typeof threadDeliveryMutationResultSchema
>;

/** Admission receipt for a reply; completed idempotent replays have no queue row. */
export const respondToQuestionResultSchema = questionRequestsResultSchema
  .extend({
    deliveryOperationId: z.string().min(1).max(160),
    queuedInput: queuedInputSummarySchema.nullable(),
    deliveryState: z.enum(["pending", "accepted", "cancelled", "failed"]),
  })
  .refine(
    (result) =>
      (result.deliveryState === "pending") === (result.queuedInput !== null),
    "Pending delivery requires a queue receipt.",
  );
export type RespondToQuestionResult = z.infer<
  typeof respondToQuestionResultSchema
>;
