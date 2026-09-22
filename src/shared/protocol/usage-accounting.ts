import { z } from "zod";

export const USAGE_TOKEN_KINDS = [
  "input", "uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning", "total", "requests",
] as const;
export type UsageTokenKind = (typeof USAGE_TOKEN_KINDS)[number];
export const usageIntegerSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, "Usage integer exceeds signed 64-bit storage.");
export const usageMoneyAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
  .max(58).refine((value) => value.replace(".", "").replace(/^0+/, "").length <= 38 &&
    (value.split(".")[1]?.length ?? 0) <= 18, "Money exceeds decimal precision.");
export const usageBasisSchema = z.enum(["provider_reported", "sdk_normalized", "derived"]);
export type UsageBasis = z.infer<typeof usageBasisSchema>;
export const usageQualitySchema = z.enum(["unreported", "partial", "complete", "conflict"]);
export const usageReasonSchema = z.enum([
  "capture_gap", "capture_failed", "history_partial", "unknown_baseline", "counter_regression",
  "conflicting_evidence", "ordering_unknown", "main_loop_only", "unknown_attribution",
  "inherited_baseline_unknown", "legacy_coverage_unknown", "child_coverage_unknown",
  "source_reset", "invalid_evidence", "unsupported", "model_coverage_unknown",
]);
export type UsageReason = z.infer<typeof usageReasonSchema>;
export const usageMetricSchema = z.strictObject({
  value: usageIntegerSchema.nullable(),
  quality: usageQualitySchema,
  basis: z.array(usageBasisSchema).max(3),
  providerPresence: z.enum(["reported", "unknown"]),
});
const metricFields = {
  input: usageMetricSchema, uncachedInput: usageMetricSchema, cacheRead: usageMetricSchema,
  cacheWrite: usageMetricSchema, output: usageMetricSchema, reasoning: usageMetricSchema,
  total: usageMetricSchema, requests: usageMetricSchema,
};
export const usageMoneySchema = z.strictObject({
  amount: usageMoneyAmountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  kind: z.enum(["estimated", "reported"]),
  provenance: z.string().min(1).max(512),
});
export type UsageMoney = z.infer<typeof usageMoneySchema>;
export const usageModelSchema = z.strictObject({
  provider: z.string().min(1).max(240).nullable(),
  model: z.string().min(1).max(240).nullable(),
});
export type UsageModel = z.infer<typeof usageModelSchema>;
export const usageSummarySchema = z.strictObject({
  metrics: z.strictObject(metricFields),
  costs: z.array(usageMoneySchema.extend({ quality: usageQualitySchema, billing: z.literal("unknown") })).max(32),
  costQuality: usageQualitySchema,
  models: z.array(usageModelSchema).max(64),
  reasons: z.array(usageReasonSchema).max(usageReasonSchema.options.length),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export const usageReportSchema = z.strictObject({
  threadId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(160).nullable(),
  revision: usageIntegerSchema,
  support: z.enum(["supported", "unsupported"]),
  state: z.enum(["unavailable", "partial", "complete"]),
  captureState: z.enum(["active", "idle", "disconnected", "failed"]),
  measurementScope: z.enum(["session", "whole_turn", "main_loop", "partial_interval"]).nullable(),
  turnState: z.enum(["in_progress", "completed", "interrupted", "failed"]).nullable(),
  lastRecordedAt: z.iso.datetime().nullable(),
  inherited: z.boolean(),
  summary: usageSummarySchema,
  legacy: usageSummarySchema.nullable(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
