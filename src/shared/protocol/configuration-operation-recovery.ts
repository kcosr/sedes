import { z } from "zod";

export const configurationOperationRecoveryKindSchema = z.enum([
  "file",
  "workspace",
  "shell",
]);
export const configurationOperationRecoveryReferenceSchema = z.strictObject({
  kind: configurationOperationRecoveryKindSchema,
  receiptId: z.string().uuid(),
});
export const configurationOperationRecoverySummarySchema =
  configurationOperationRecoveryReferenceSchema.extend({
    state: z.enum(["pending", "unknown", "failed", "succeeded"]),
    summary: z.string().max(512),
    acknowledgeable: z.boolean(),
  });
export const configurationOperationRecoveryDetailsSchema =
  configurationOperationRecoverySummarySchema.extend({
    details: z.string().max(65_536),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
    omittedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  });
export const configurationOperationRecoveryListSchema = z.strictObject({
  receipts: z.array(configurationOperationRecoverySummarySchema).max(2304),
});
export const configurationOperationRecoveryAcknowledgmentSchema =
  z.strictObject({
    acknowledged: z.boolean(),
  });

export const configurationOperationRecoveryInspectionSchema = z.strictObject({
  operation: configurationOperationRecoveryDetailsSchema,
  confirmationToken: z.string().min(1).max(512).nullable(),
});
export const configurationOperationRecoveryAcknowledgeRequestSchema =
  z.strictObject({ confirmationToken: z.string().min(1).max(512) });

export type ConfigurationOperationRecoveryInspection = z.infer<
  typeof configurationOperationRecoveryInspectionSchema
>;
export type ConfigurationOperationRecoveryAcknowledgeRequest = z.infer<
  typeof configurationOperationRecoveryAcknowledgeRequestSchema
>;
export type ConfigurationOperationRecoveryKind = z.infer<
  typeof configurationOperationRecoveryKindSchema
>;
export type ConfigurationOperationRecoveryReference = z.infer<
  typeof configurationOperationRecoveryReferenceSchema
>;
export type ConfigurationOperationRecoverySummary = z.infer<
  typeof configurationOperationRecoverySummarySchema
>;
export type ConfigurationOperationRecoveryDetails = z.infer<
  typeof configurationOperationRecoveryDetailsSchema
>;
