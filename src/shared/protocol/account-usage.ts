import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const identifier = z.string().min(1).max(160);

/** Last observed included quota; never authority to admit or reject a turn. */
export const backendAccountUsageSchema = z.strictObject({
  capturedAt: timestamp,
  accountId: z.string().min(1).max(512).nullable(),
  plan: z.string().min(1).max(80).nullable(),
  includedUsageAllowed: z.boolean().nullable(),
  windows: z.array(z.strictObject({
    remainingPercent: z.number().min(0).max(100),
    durationMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    resetsAt: timestamp.nullable(),
  })).min(1).max(8),
});
export type BackendAccountUsage = z.infer<typeof backendAccountUsageSchema>;

export const normalizedBackendAccountUsageSchema = backendAccountUsageSchema.extend({
  backendInstanceId: identifier,
  executionEnvironmentId: identifier,
});
export type NormalizedBackendAccountUsage = z.infer<typeof normalizedBackendAccountUsageSchema>;

export const MAXIMUM_BACKEND_ACCOUNT_USAGES = 64;
export const backendAccountUsagesSchema = z.array(normalizedBackendAccountUsageSchema)
  .max(MAXIMUM_BACKEND_ACCOUNT_USAGES)
  .superRefine((usages, context) => {
    const seen = new Set<string>();
    for (const [index, usage] of usages.entries()) {
      if (seen.has(usage.backendInstanceId)) context.addIssue({
        code: "custom", message: "Backend account usage must be unique.", path: [index, "backendInstanceId"],
      });
      seen.add(usage.backendInstanceId);
    }
  });
