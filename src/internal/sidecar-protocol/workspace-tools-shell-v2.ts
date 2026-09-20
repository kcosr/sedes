import { resolvedEnvironmentVariablesSchema } from "./environment-variables-v1.js";
import { z } from "zod";
import {
  defineSidecarOperation,
  type SidecarOperationContext,
  type SidecarOperationHandler,
  type SidecarOperationRegistry,
} from "./operation-registry.js";
import {
  WORKSPACE_TOOLS_CAPABILITY_ID,
  WORKSPACE_TOOLS_MAJOR_VERSION,
} from "./workspace-tools-v2.js";

const opaqueIdSchema = z.string().uuid();
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_INITIAL_CREDIT_BYTES =
  16 * 1024 * 1024;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_CHUNK_BYTES = 1024 * 1024;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_RAW_OUTPUT_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES = 8;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES_PER_WORKSPACE = 4;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_DURATION_MILLISECONDS = 600_000;
export const WORKSPACE_TOOLS_SHELL_TERMINATION_GRACE_MILLISECONDS = 1_000;
export const WORKSPACE_TOOLS_SHELL_DRAIN_MILLISECONDS = 1_000;
export const WORKSPACE_TOOLS_SHELL_V2_LIMITS = Object.freeze({
  streamLimits: Object.freeze({
    maximumInitialCreditBytes:
      WORKSPACE_TOOLS_SHELL_MAXIMUM_INITIAL_CREDIT_BYTES,
    maximumChunkBytes: WORKSPACE_TOOLS_SHELL_MAXIMUM_CHUNK_BYTES,
    maximumRawOutputBytes: WORKSPACE_TOOLS_SHELL_MAXIMUM_RAW_OUTPUT_BYTES,
    reservedTerminalQueueBytes: 64 * 1024,
    reservedTerminalQueueFrames: 16,
  }),
  processLimits: Object.freeze({
    maximumProcesses: WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES,
    maximumProcessesPerWorkspace:
      WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES_PER_WORKSPACE,
    maximumDurationMilliseconds:
      WORKSPACE_TOOLS_SHELL_MAXIMUM_DURATION_MILLISECONDS,
    terminationGraceMilliseconds:
      WORKSPACE_TOOLS_SHELL_TERMINATION_GRACE_MILLISECONDS,
    drainMilliseconds: WORKSPACE_TOOLS_SHELL_DRAIN_MILLISECONDS,
  }),
});

export const workspaceToolsShellStartRequestSchema = z.strictObject({
  workspaceHandle: z.string().min(24).max(240),
  operationId: opaqueIdSchema,
  streamId: opaqueIdSchema,
  environmentVariables: resolvedEnvironmentVariablesSchema.optional(),
  environmentIdentity: z.string().uuid().optional(),
  command: z
    .string()
    .min(1)
    .max(1024 * 1024),
  initialCreditBytes: z
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_TOOLS_SHELL_MAXIMUM_INITIAL_CREDIT_BYTES),
  timeoutMilliseconds: z
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_TOOLS_SHELL_MAXIMUM_DURATION_MILLISECONDS),
});
export const workspaceToolsShellStartResponseSchema = z.strictObject({
  streamId: opaqueIdSchema,
  admitted: z.literal(true),
});
export const workspaceToolsShellCancelRequestSchema = z.strictObject({
  streamId: opaqueIdSchema,
});
export const workspaceToolsShellCancelResponseSchema = z.strictObject({
  accepted: z.boolean(),
});

const nonnegativeByteTotalSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const workspaceToolsShellTerminalSchema = z.strictObject({
  outcome: z.enum([
    "exited",
    "cancelled",
    "timed_out",
    "output_limited",
    "spawn_failed",
  ]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.string().min(1).max(32).nullable(),
  stdoutBytes: nonnegativeByteTotalSchema,
  stderrBytes: nonnegativeByteTotalSchema,
  emittedBytes: nonnegativeByteTotalSchema,
  omittedBytes: nonnegativeByteTotalSchema,
  truncated: z.boolean(),
});

export type WorkspaceToolsShellStartRequest = z.infer<
  typeof workspaceToolsShellStartRequestSchema
>;
export type WorkspaceToolsShellTerminal = z.infer<
  typeof workspaceToolsShellTerminalSchema
>;

// Finite command recovery is a bounded receipt, not a replayable stdout log.
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_PREVIEW_BYTES = 64 * 1024;
export const WORKSPACE_TOOLS_SHELL_MAXIMUM_RECEIPTS = 256;
export const workspaceToolsShellListOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
  operation: "shell.list",
  requestSchema: z.strictObject({}),
  responseSchema: z.strictObject({
    streamIds: z
      .array(opaqueIdSchema)
      .max(WORKSPACE_TOOLS_SHELL_MAXIMUM_RECEIPTS),
  }),
  maximumDeadlineMilliseconds: 10_000,
  lane: "control",
});
export const workspaceToolsShellInspectOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
  operation: "shell.inspect",
  requestSchema: z.strictObject({ streamId: opaqueIdSchema }),
  responseSchema: z.strictObject({
    state: z.enum(["running", "completed", "unknown"]),
    terminal: workspaceToolsShellTerminalSchema.nullable(),
    stdoutBase64: z.string().max(90_000),
    stderrBase64: z.string().max(90_000),
    previewOmittedBytes: nonnegativeByteTotalSchema,
  }),
  maximumDeadlineMilliseconds: 10_000,
  lane: "control",
});
export const workspaceToolsShellAcknowledgeOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
  operation: "shell.acknowledge",
  requestSchema: z.strictObject({ streamId: opaqueIdSchema }),
  responseSchema: z.strictObject({ acknowledged: z.boolean() }),
  maximumDeadlineMilliseconds: 10_000,
  lane: "control",
});

export const workspaceToolsShellStartOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
  operation: "shell.start",
  requestSchema: workspaceToolsShellStartRequestSchema,
  responseSchema: workspaceToolsShellStartResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const workspaceToolsShellCancelOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
  operation: "shell.cancel",
  requestSchema: workspaceToolsShellCancelRequestSchema,
  responseSchema: workspaceToolsShellCancelResponseSchema,
  maximumDeadlineMilliseconds: 10_000,
  lane: "control",
});

export interface WorkspaceToolsShellV2Handlers {
  readonly list: SidecarOperationHandler<
    Record<string, never>,
    { streamIds: string[] }
  >;
  readonly inspect: SidecarOperationHandler<
    z.infer<typeof workspaceToolsShellInspectOperation.requestSchema>,
    z.infer<typeof workspaceToolsShellInspectOperation.responseSchema>
  >;
  readonly acknowledge: SidecarOperationHandler<
    z.infer<typeof workspaceToolsShellAcknowledgeOperation.requestSchema>,
    z.infer<typeof workspaceToolsShellAcknowledgeOperation.responseSchema>
  >;
  readonly start: SidecarOperationHandler<
    z.infer<typeof workspaceToolsShellStartRequestSchema>,
    z.infer<typeof workspaceToolsShellStartResponseSchema>
  >;
  readonly cancel: SidecarOperationHandler<
    z.infer<typeof workspaceToolsShellCancelRequestSchema>,
    z.infer<typeof workspaceToolsShellCancelResponseSchema>
  >;
}

export function registerWorkspaceToolsShellV2Operations(
  registry: SidecarOperationRegistry,
  handlers: WorkspaceToolsShellV2Handlers,
): void {
  registry.register(workspaceToolsShellStartOperation, handlers.start);
  registry.register(workspaceToolsShellCancelOperation, handlers.cancel);
  registry.register(workspaceToolsShellListOperation, handlers.list);
  registry.register(workspaceToolsShellInspectOperation, handlers.inspect);
  registry.register(
    workspaceToolsShellAcknowledgeOperation,
    handlers.acknowledge,
  );
}

export const workspaceToolsShellV2Operations = Object.freeze([
  workspaceToolsShellStartOperation,
  workspaceToolsShellCancelOperation,
  workspaceToolsShellListOperation,
  workspaceToolsShellInspectOperation,
  workspaceToolsShellAcknowledgeOperation,
]);
