import { z } from "zod";

const opaqueIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export const opaqueIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const threadIdSchema = z.uuid();
export const workspaceIdSchema = z.uuid();
export const environmentIdSchema = z.uuid();
export const stashIdSchema = z.uuid();
export const taskIdSchema = z.uuid();
export const outputArtifactIdSchema = z
  .uuid()
  .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
export const mutationIdSchema = z.uuid();
export const applicationTurnIdSchema = z.string().min(1).max(160);

export const automationRunModeSchema = z.enum(["same_thread", "clone"]);
export type AutomationRunMode = z.infer<typeof automationRunModeSchema>;

export const automationScheduleKindSchema = z.enum([
  "date_time",
  "interval",
  "cron",
]);
export type AutomationScheduleKind = z.infer<
  typeof automationScheduleKindSchema
>;

export const automationMisfirePolicySchema = z.enum(["coalesce", "skip"]);
export type AutomationMisfirePolicy = z.infer<
  typeof automationMisfirePolicySchema
>;

export const automationDefinitionStatusSchema = z.enum(["enabled", "paused"]);
export type AutomationDefinitionStatus = z.infer<
  typeof automationDefinitionStatusSchema
>;

export const automationRunStateSchema = z.enum([
  "claimed",
  "dispatching",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "uncertain",
]);
export type AutomationRunState = z.infer<typeof automationRunStateSchema>;

export const environmentAvailabilitySchema = z.enum([
  "available",
  "unavailable",
]);
export type EnvironmentAvailability = z.infer<
  typeof environmentAvailabilitySchema
>;

export const environmentSummarySchema = z.object({
  id: environmentIdSchema,
  label: z.string().min(1).max(120),
  availability: environmentAvailabilitySchema,
  diagnosticCode: z.string().max(120).nullable(),
  revision: z.number().int().nonnegative(),
});
export type EnvironmentSummary = z.infer<typeof environmentSummarySchema>;

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  environmentId: environmentIdSchema,
  displayName: z.string().min(1).max(240),
  displayPath: z.string().min(1).max(4096),
  availability: environmentAvailabilitySchema,
  trustState: z.enum(["trusted", "untrusted"]),
  revision: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
