import { z } from "zod";
import { backendBrandSchema } from "./conversation.js";

export const PROVIDER_PULSE_ACCOUNT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const providerPulseAccountIdSchema = z
  .string()
  .regex(PROVIDER_PULSE_ACCOUNT_ID_PATTERN);

export const providerPulseHealthSchema = z.enum([
  "unknown",
  "running",
  "healthy",
  "stale",
  "unhealthy",
  "disabled",
]);

const providerPulseTimestampSchema = z.iso.datetime();

export const providerPulseWindowSchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  usedPercent: z.number().finite().min(0).max(100).optional(),
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  durationMinutes: z.number().finite().nonnegative().optional(),
  resetsAt: providerPulseTimestampSchema.optional(),
  reached: z.boolean().optional(),
});

export const providerPulseBalanceSchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  amount: z.number().finite().optional(),
  currency: z.string().min(1).max(16).optional(),
  unit: z.string().min(1).max(32).optional(),
  unlimited: z.boolean().optional(),
  limit: z.string().min(1).max(64).optional(),
  used: z.string().min(1).max(64).optional(),
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  resetsAt: providerPulseTimestampSchema.optional(),
});

export const providerPulseResetCreditsSchema = z.strictObject({
  availableCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  nextExpiresAt: providerPulseTimestampSchema.optional(),
});

export const providerPulseSnapshotSchema = z.strictObject({
  observedAt: providerPulseTimestampSchema,
  windows: z.array(providerPulseWindowSchema).max(32),
  balances: z.array(providerPulseBalanceSchema).max(32),
  resetCredits: providerPulseResetCreditsSchema.optional(),
});

export const providerPulseAccountUsageSchema = z.strictObject({
  health: providerPulseHealthSchema,
  inFlight: z.boolean(),
  operationId: z.string().min(1).max(128).optional(),
  lastAttemptAt: providerPulseTimestampSchema.optional(),
  lastSuccessAt: providerPulseTimestampSchema.optional(),
  snapshot: providerPulseSnapshotSchema.optional(),
});

export const providerPulseAccountSchema = z.strictObject({
  id: providerPulseAccountIdSchema,
  label: z.string().min(1).max(256),
  provider: z.string().min(1).max(64),
  brand: backendBrandSchema.optional(),
  usage: providerPulseAccountUsageSchema,
});

export const providerPulseBaselineMetricSchema = z.strictObject({
  accountId: providerPulseAccountIdSchema,
  metricKind: z.enum(["window", "balance"]),
  metricId: z.string().min(1).max(256),
  remainingPercent: z.number().finite().min(0).max(100),
  resetAt: providerPulseTimestampSchema.optional(),
  capturedAt: providerPulseTimestampSchema,
});

export const providerPulseBaselineSchema = z.strictObject({
  health: z.enum(["unknown", "healthy", "unhealthy"]),
  updatedAt: providerPulseTimestampSchema.optional(),
  metrics: z.array(providerPulseBaselineMetricSchema).max(256),
});

export const providerPulseStatusSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: providerPulseTimestampSchema,
  health: providerPulseHealthSchema,
  accounts: z.array(providerPulseAccountSchema).max(100),
  usageBaseline: providerPulseBaselineSchema,
});

export const providerPulseOperationReceiptSchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  accepted: z.boolean(),
  targetId: z.string().min(1).max(256),
  kind: z.enum(["usage-check", "heartbeat"]),
  coalesced: z.boolean(),
});

export const providerPulseCheckAllResultSchema = z.strictObject({
  receipts: z.array(providerPulseOperationReceiptSchema).max(64),
});

export const providerPulseSnapshotResultSchema = z.strictObject({
  usageBaseline: providerPulseBaselineSchema,
});

export type ProviderPulseStatus = z.infer<typeof providerPulseStatusSchema>;
export type ProviderPulseAccount = z.infer<typeof providerPulseAccountSchema>;
export type ProviderPulseWindow = z.infer<typeof providerPulseWindowSchema>;
export type ProviderPulseBalance = z.infer<typeof providerPulseBalanceSchema>;
export type ProviderPulseResetCredits = z.infer<
  typeof providerPulseResetCreditsSchema
>;
export type ProviderPulseBaselineMetric = z.infer<
  typeof providerPulseBaselineMetricSchema
>;
export type ProviderPulseOperationReceipt = z.infer<
  typeof providerPulseOperationReceiptSchema
>;
