import { z } from "zod";

/** Deliberately independent of the runtime envelope/wire version. */
export const SIDECAR_MANAGEMENT_VERSION = 1 as const;
export const SIDECAR_MANAGEMENT_MAXIMUM_BYTES = 256 * 1024;
export const SIDECAR_SERVICE_MAXIMUM_RESOURCES = 256;

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
export const sidecarServiceScopeSchema = z.strictObject({
  installationId: identity,
  tenantId: identity,
  principalId: identity,
  executionEnvironmentId: identity,
});
export type SidecarServiceScope = z.infer<typeof sidecarServiceScopeSchema>;

export const sidecarServiceConfigurationSchema = z.strictObject({
  environmentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operationsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SidecarServiceConfiguration = z.infer<typeof sidecarServiceConfigurationSchema>;

export const sidecarUpgradeBlockerSchema = z.enum([
  "active_work", "pending_interaction", "unsettled_outcome", "live_terminal",
  "transfer_in_progress", "cleanup_unproven", "unknown_state",
]);
export type SidecarUpgradeBlocker = z.infer<typeof sidecarUpgradeBlockerSchema>;
export const sidecarResourceSnapshotSchema = z.strictObject({
  resourceId: identity,
  kind: z.enum(["provider", "terminal", "operation", "transfer", "watch", "receipt"]),
  state: z.enum(["idle", "active", "unknown"]),
  revision: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:/-]+$/u),
  blockers: z.array(sidecarUpgradeBlockerSchema).max(7),
});
export type SidecarResourceSnapshot = z.infer<typeof sidecarResourceSnapshotSchema>;

export const sidecarServiceStatusSchema = z.strictObject({
  scope: sidecarServiceScopeSchema,
  serviceIncarnation: identity,
  buildId: identity,
  artifactSha256: digest,
  runtimeWireVersion: z.number().int().positive(),
  controllerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  attached: z.boolean(),
  attachmentMode: z.enum(["none", "normal", "recovery"]),
  state: z.enum(["ready", "draining", "stopping", "handoff_pending", "cleanup_unproven", "stopped"]),
  desiredConfiguration: sidecarServiceConfigurationSchema,
  effectiveConfiguration: sidecarServiceConfigurationSchema,
  configurationState: z.enum(["applied", "pending"]),
  resources: z.array(sidecarResourceSnapshotSchema).max(SIDECAR_SERVICE_MAXIMUM_RESOURCES),
  resourcesFingerprint: digest,
});
export type SidecarServiceStatus = z.infer<typeof sidecarServiceStatusSchema>;

export const sidecarManagementReceiptSchema = z.strictObject({
  mutationId: identity,
  requestFingerprint: digest,
  serviceIncarnation: identity,
  state: z.enum(["accepted", "completed", "failed", "handoff_pending", "withdrawn"]),
  code: z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/u).optional(),
});
export type SidecarManagementReceipt = z.infer<typeof sidecarManagementReceiptSchema>;

const common = {
  managementVersion: z.literal(SIDECAR_MANAGEMENT_VERSION),
  requestId: identity,
  scope: sidecarServiceScopeSchema,
};
export const sidecarManagementRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, operation: z.literal("status") }),
  z.strictObject({ ...common, operation: z.literal("receipt"), mutationId: identity }),
  /** Fences a mutation id whose acknowledgement was lost: a later arrival is refused. */
  z.strictObject({ ...common, operation: z.literal("withdraw"), mutationId: identity, expectedServiceIncarnation: identity }),
  z.strictObject({
    ...common, operation: z.literal("attach"),
    expectedBuildId: identity, expectedArtifactSha256: digest,
    runtimeWireVersion: z.number().int().positive(),
    sessionNonce: z.string().min(32).max(160).regex(/^[A-Za-z0-9_-]+$/u),
    carrierGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    configuration: sidecarServiceConfigurationSchema,
    mode: z.enum(["normal", "recovery"]),
  }),
  z.strictObject({
    ...common, operation: z.enum(["stop", "restart"]),
    expectedServiceIncarnation: identity,
    controllerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedConfiguration: sidecarServiceConfigurationSchema,
    expectedResourcesFingerprint: digest,
    force: z.boolean(),
  }),
]);
export type SidecarManagementRequest = z.infer<typeof sidecarManagementRequestSchema>;

export const sidecarManagementResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ managementVersion: z.literal(SIDECAR_MANAGEMENT_VERSION), requestId: identity, outcome: z.literal("absent") }),
  z.strictObject({ managementVersion: z.literal(SIDECAR_MANAGEMENT_VERSION), requestId: identity, outcome: z.literal("receipt"), receipt: sidecarManagementReceiptSchema.nullable() }),
  z.strictObject({
    managementVersion: z.literal(SIDECAR_MANAGEMENT_VERSION),
    requestId: identity, outcome: z.literal("ok"), status: sidecarServiceStatusSchema,
  }),
  z.strictObject({
    managementVersion: z.literal(SIDECAR_MANAGEMENT_VERSION),
    requestId: identity, outcome: z.literal("error"),
    code: z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/u),
    status: sidecarServiceStatusSchema.optional(),
  }),
]);
export type SidecarManagementResponse = z.infer<typeof sidecarManagementResponseSchema>;

export function sameSidecarServiceScope(left: SidecarServiceScope, right: SidecarServiceScope): boolean {
  return left.installationId === right.installationId && left.tenantId === right.tenantId &&
    left.principalId === right.principalId && left.executionEnvironmentId === right.executionEnvironmentId;
}
export function sameSidecarServiceConfiguration(left: SidecarServiceConfiguration, right: SidecarServiceConfiguration): boolean {
  return left.environmentRevision === right.environmentRevision && left.operationsRevision === right.operationsRevision;
}
