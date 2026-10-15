import { z } from "zod";
import {
  automationDefinitionStatusSchema,
  automationMisfirePolicySchema,
  automationRunModeSchema,
  applicationTurnIdSchema,
  automationRunStateSchema,
  automationTurnOutcomeSchema,
} from "./domain.js";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
  automationNameSchema,
  automationDeferredReasonSchema,
} from "./automation.js";

export const threadAutomationLastRunSchema = z.strictObject({
  id: z.uuid(),
  deferredReason: automationDeferredReasonSchema.optional(),
  eligibleAt: z.iso.datetime().nullable().optional(),
  state: automationRunStateSchema,
  occurrence: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  resultThreadId: z.uuid().optional(),
  errorCode: z.string().max(120).optional(),
  turn: z
    .strictObject({
      outcome: automationTurnOutcomeSchema,
      endedAt: z.iso.datetime().optional(),
    })
    .optional(),
});
export type ThreadAutomationLastRun = z.infer<
  typeof threadAutomationLastRunSchema
>;

export const automationSourceSchema = z.strictObject({
  title: z.string().max(240),
  workspaceId: z.string().min(1).max(160),
  environmentId: z.string().min(1).max(160),
  targetId: z.string().min(1).max(160),
  groupId: z.string().min(1).max(160).nullable(),
  backendLabel: z.string().min(1).max(240),
  available: z.boolean(),
  backingState: z.enum(["unbound", "creating", "bound", "creation_unknown"]),
  runState: z
    .enum([
      "idle",
      "starting",
      "running",
      "waiting_for_approval",
      "waiting_for_input",
      "stopping",
      "failed",
      "disconnected",
      "reconciling",
    ])
    .optional(),
  inventoryState: z.enum(["active", "snoozed", "settled", "archived"]),
  inventoryRevision: z.number().int().nonnegative(),
  snoozedUntil: z.iso.datetime().optional(),
});

export const threadAutomationSummarySchema = z.strictObject({
  id: z.uuid(),
  threadId: z.uuid(),
  name: automationNameSchema,
  source: automationSourceSchema,
  attention: z
    .strictObject({
      runId: z.uuid(),
      kind: z.enum(["uncertain", "failed"]),
      diagnostic: z.string().max(500).optional(),
    })
    .optional(),
  status: automationDefinitionStatusSchema,
  runMode: automationRunModeSchema,
  scheduleKind: z.enum(["date_time", "interval", "cron"]),
  nextRunAt: z.iso.datetime().optional(),
  lastRun: threadAutomationLastRunSchema.optional(),
  revision: z.number().int().nonnegative(),
  /**
   * Advances whenever the run history changes: a new run, a run state change,
   * or a run's turn settling or gaining its times.
   */
  runsRevision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  hasPrecheck: z.boolean(),
});
export type ThreadAutomationSummary = z.infer<
  typeof threadAutomationSummarySchema
>;

export const threadAutomationDefinitionSchema =
  threadAutomationSummarySchema.extend({
    prompt: automationPromptSchema,
    schedule: automationScheduleSchema,
    misfirePolicy: automationMisfirePolicySchema.nullable(),
    precheck: automationPrecheckSchema.nullable(),
  });
export type ThreadAutomationDefinition = z.infer<
  typeof threadAutomationDefinitionSchema
>;

export const threadAutomationRunSchema = z.strictObject({
  id: z.uuid(),
  automationId: z.uuid(),
  deferredReason: automationDeferredReasonSchema.optional(),
  eligibleAt: z.iso.datetime().nullable().optional(),
  initialEligibleAt: z.iso.datetime().optional(),
  acknowledgedAt: z.iso.datetime().optional(),
  occurrence: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime(),
  state: automationRunStateSchema,
  runMode: automationRunModeSchema,
  /** Definition revision the run was claimed from. */
  definitionRevision: z.number().int().nonnegative(),
  resultThreadId: z.uuid().optional(),
  coalescedCount: z.number().int().nonnegative(),
  errorCode: z.string().max(120).optional(),
  diagnostic: z.string().max(500).optional(),
  claimedAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  acceptedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  /** Present when a thread force reset abandoned the run. */
  forceResetAt: z.iso.datetime().optional(),
  /**
   * The agent turn the run's prompt started, once it settled. `id` is the
   * application turn id (turn focus and per-turn usage use it); the times
   * are the turn's own, absent when the backend reports none.
   */
  turn: z
    .strictObject({
      id: applicationTurnIdSchema,
      outcome: automationTurnOutcomeSchema,
      settledAt: z.iso.datetime(),
      startedAt: z.iso.datetime().optional(),
      endedAt: z.iso.datetime().optional(),
    })
    .optional(),
  precheck: z
    .strictObject({
      status: z.enum(["pending", "checking", "passed", "skipped", "failed"]),
      /** Command and timeout as snapshotted when the run was claimed. */
      command: automationPrecheckSchema.shape.command,
      timeoutSeconds: automationPrecheckSchema.shape.timeoutSeconds,
      durationMilliseconds: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stdoutIncluded: z.boolean(),
      exitCode: z.number().int().optional(),
    })
    .optional(),
});
export type ThreadAutomationRun = z.infer<typeof threadAutomationRunSchema>;

export const threadAutomationRunCountsSchema = z.strictObject({
  all: z.number().int().nonnegative(),
  /** Failed or uncertain runs. */
  problems: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ThreadAutomationRunCounts = z.infer<
  typeof threadAutomationRunCountsSchema
>;

/** `counts` covers the whole history and is present only on the first page. */
export const threadAutomationRunPageSchema = z.strictObject({
  items: z.array(threadAutomationRunSchema).max(100),
  nextCursor: z.string().nullable(),
  counts: threadAutomationRunCountsSchema.optional(),
});
export type ThreadAutomationRunPage = z.infer<
  typeof threadAutomationRunPageSchema
>;

/**
 * Result of resolving an uncertain run: the run and the thread's automation
 * afterwards (null when resolving ended a one-time automation).
 */
export const threadAutomationRunResolutionSchema = z.strictObject({
  run: threadAutomationRunSchema,
  automation: threadAutomationDefinitionSchema.nullable(),
});
export type ThreadAutomationRunResolution = z.infer<
  typeof threadAutomationRunResolutionSchema
>;

export const threadAutomationSchedulePreviewSchema = z.strictObject({
  occurrences: z.array(z.iso.datetime()).min(1).max(10),
});
export type ThreadAutomationSchedulePreview = z.infer<
  typeof threadAutomationSchedulePreviewSchema
>;

export const automationPrecheckTestResultSchema = z.strictObject({
  decision: z.enum(["invoke", "skip", "failed"]),
  durationMilliseconds: z.number().int().nonnegative(),
  stdoutPreview: z.string().max(16_384),
  stderrPreview: z.string().max(4_096),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  exitCode: z.number().int().optional(),
  stdoutWillBeIncluded: z.boolean(),
  effectivePromptBytes: z.number().int().nonnegative(),
  diagnosticCode: z.string().max(120).optional(),
});
export type AutomationPrecheckTestResult = z.infer<
  typeof automationPrecheckTestResultSchema
>;

export const threadAutomationDefinitionPageSchema = z.strictObject({
  items: z.array(threadAutomationDefinitionSchema).max(100),
  nextCursor: z.string().nullable(),
});
export type ThreadAutomationDefinitionPage = z.infer<
  typeof threadAutomationDefinitionPageSchema
>;
