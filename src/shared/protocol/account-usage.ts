import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const identifier = z.string().min(1).max(160);
export const MAXIMUM_ACCOUNT_USAGE_WINDOWS = 8;
export const MAXIMUM_ACCOUNT_USAGE_MODEL_LABEL_LENGTH = 80;
export const MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS = 32;
export const accountUsageModelKeySchema = z.string().min(1).max(160);

/** Only quota fields may cross a provider's execution-host boundary. */
export const backendAccountUsageReportSchema = z.strictObject({
  capturedAt: timestamp,
  accountId: z.string().min(1).max(512).nullable(),
  plan: z.string().min(1).max(80).nullable(),
  includedUsageAllowed: z.boolean().nullable(),
  windows: z.array(z.strictObject({
    scope: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("account") }),
      z.strictObject({
        kind: z.literal("model"),
        label: z.string().min(1).max(MAXIMUM_ACCOUNT_USAGE_MODEL_LABEL_LENGTH),
        key: accountUsageModelKeySchema.nullable(),
      }),
    ]),
    remainingPercent: z.number().min(0).max(100),
    durationMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    resetsAt: timestamp.nullable(),
  })).min(1).max(MAXIMUM_ACCOUNT_USAGE_WINDOWS),
});
export type BackendAccountUsageReport = z.infer<typeof backendAccountUsageReportSchema>;

/** Sedes attaches application thread membership atomically to account-specific readings. */
export const backendAccountUsageSchema = backendAccountUsageReportSchema.extend({
  /** Display source for provider-reported readings that may be cached upstream. */
  reportedBy: z.string().min(1).max(80).optional(),
  /** Omitted for backend-wide observations. Every listed ID belongs to the source's principal. */
  eligibleThreadIds: z.array(identifier).min(1).max(MAXIMUM_ACCOUNT_USAGE_ELIGIBLE_THREADS)
    .refine(ids => new Set(ids).size === ids.length, "Eligible account usage threads must be unique.").optional(),
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
