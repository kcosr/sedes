import { z } from "zod";
import {
  automationDefinitionStatusSchema,
  automationMisfirePolicySchema,
  automationRunModeSchema,
  automationRunStateSchema,
} from "./domain.js";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
} from "./automation.js";

export const threadAutomationLastRunSchema = z.strictObject({
  id: z.uuid(),
  state: automationRunStateSchema,
  occurrence: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  resultThreadId: z.uuid().optional(),
  errorCode: z.string().max(120).optional(),
});
export type ThreadAutomationLastRun = z.infer<
  typeof threadAutomationLastRunSchema
>;

export const threadAutomationSummarySchema = z.strictObject({
  status: automationDefinitionStatusSchema,
  runMode: automationRunModeSchema,
  scheduleKind: z.enum(["date_time", "interval", "cron"]),
  nextRunAt: z.iso.datetime().optional(),
  lastRun: threadAutomationLastRunSchema.optional(),
  revision: z.number().int().nonnegative(),
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
    misfirePolicy: automationMisfirePolicySchema,
    precheck: automationPrecheckSchema.nullable(),
  });
export type ThreadAutomationDefinition = z.infer<
  typeof threadAutomationDefinitionSchema
>;

export const threadAutomationRunSchema = z.strictObject({
  id: z.uuid(),
  occurrence: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime(),
  state: automationRunStateSchema,
  runMode: automationRunModeSchema,
  resultThreadId: z.uuid().optional(),
  coalescedCount: z.number().int().nonnegative(),
  errorCode: z.string().max(120).optional(),
  diagnostic: z.string().max(500).optional(),
  claimedAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  acceptedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  precheck: z
    .strictObject({
      status: z.enum(["pending", "checking", "passed", "skipped", "failed"]),
      durationMilliseconds: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stdoutIncluded: z.boolean(),
      exitCode: z.number().int().optional(),
    })
    .optional(),
});
export type ThreadAutomationRun = z.infer<typeof threadAutomationRunSchema>;

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

export function pageResultSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
