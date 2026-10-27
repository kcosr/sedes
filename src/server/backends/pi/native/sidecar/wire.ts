import { z } from "zod";
import { environmentVariableOverridesSchema } from "../../../../../shared/protocol/environment-variables.js";
import { sidecarRuntimeBodySchema } from "../../../../sidecar/runtime-body-channel.js";
import type { SidecarOperationDefinition } from "../../../../../internal/sidecar-protocol/operation-registry.js";
import { piManagedOperationSchema } from "../rpc/pi-managed-protocol.js";
import { piNativeCommandIsControl } from "../command-policy.js";
import { piNativeAgentToolEnvironmentSchema } from "../launch-environment.js";
import { piNativeToolCallSchema, piNativeToolResultSchema } from "../tool-provenance.js";

const id = z.string().min(1).max(512);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hostPath = z.string().min(1).max(4096);
export const piNativeConfigurationSchema = z.strictObject({
  tenantId: id, principalId: id, backendInstanceId: id, executionEnvironmentId: id,
  executablePath: hostPath.optional(), agentDirectory: hostPath.optional(), sessionDirectory: hostPath.optional(),
  initializationTimeoutMs: z.number().int().min(1000).max(120_000),
  projectTrusted: z.boolean(),
  startupEnvironmentVariables: environmentVariableOverridesSchema.optional(),
});
export const piNativeIdentitySchema = z.strictObject({ sessionId: id, sessionFile: hostPath, cwd: hostPath });
export const piNativeSessionDirectorySchema = hostPath;
const create = z.strictObject({ cwd: hostPath, sessionId: id, operationId: id, title: z.string().max(4096).optional() });
const fork = z.strictObject({ cwd: hostPath, sourceSessionId: id, sourceSessionFile: hostPath,
  sourceEntryId: id, childSessionId: id, operationId: id, title: z.string().max(4096).optional(),
  inheritedSettings: z.strictObject({ model: z.strictObject({ provider: id, id }).optional(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(), toolAccess: z.enum(["read_only", "ask", "full"]) }) });
const handle = z.strictObject({ handleId: id });
const operation = handle.extend({ operationId: id });
const nativeCommand = z.strictObject({ channel: z.enum(["rpc", "companion"]), command: z.record(z.string(), z.unknown()) });
const authority = { serviceIncarnation: id, controllerEpoch: z.number().int().positive() };
const runtime = { ...authority, runtimeId: id };
function command<const Action extends string, Schema extends z.ZodType>(action: Action, input: Schema) {
  return z.strictObject({ ...runtime, action: z.literal(action), input });
}
export const piNativeHostCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...authority, action: z.literal("ensure"), configuration: piNativeConfigurationSchema }),
  z.strictObject({ ...authority, action: z.literal("lookup"), configuration: piNativeConfigurationSchema }),
  z.strictObject({ ...authority, action: z.literal("lookup_retained"), backendInstanceId: id }),
  command("catalog", z.strictObject({ cwd: hostPath })),
  command("resolve_session_directory", z.strictObject({ cwd: hostPath })),
  command("create", create), command("fork", fork), command("reconcile_fork", fork),
  command("list", z.strictObject({ cwd: hostPath, cursor: id.optional(), limit: z.number().int().min(1).max(500).optional() })),
  command("history", piNativeIdentitySchema),
  command("attach", piNativeIdentitySchema.extend({ executionEnvironment: environmentVariableOverridesSchema.optional(), agentToolEnvironment: piNativeAgentToolEnvironmentSchema.optional() })),
  command("attach_for_drain", piNativeIdentitySchema),
  command("attach_for_control", piNativeIdentitySchema),
  command("request", operation.extend({ command: nativeCommand, retainOutcome: z.boolean() })),
  command("outcome", operation), command("acknowledge_operation", operation),
  command("abandon_observation", operation),
  command("observe", handle.extend({ afterSequence: position })),
  command("acknowledge", handle.extend({ throughSequence: position })),
  command("acknowledge_observation_gap", handle.extend({ generation: id, throughSequence: position })),
  command("release", handle), command("retire_session", piNativeIdentitySchema), command("inspect", z.strictObject({})),
  command("stop", z.strictObject({ expectedRevision: id, force: z.boolean() })),
]);
export type PiNativeHostCommand = z.infer<typeof piNativeHostCommandSchema>;
export type PiNativeHostCommandInput = PiNativeHostCommand extends infer Command
  ? Command extends PiNativeHostCommand ? Omit<Command, "serviceIncarnation" | "controllerEpoch"> : never : never;
const capability = { capabilityId: "pi_native_runtime", majorVersion: 1 } as const;
export const piNativeExecuteOperation = { ...capability, operation: "runtime.execute", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const piNativeControlOperation = { ...capability, operation: "runtime.control", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "control", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const piNativeRuntimeOperations = [piNativeExecuteOperation, piNativeControlOperation] as const;
export const piNativeRuntimeCapability = { ...capability, operations: piNativeRuntimeOperations.map(value => value.operation) };
export function piNativeHostCommandLane(command: PiNativeHostCommand | PiNativeHostCommandInput): "operation" | "control" {
  if (command.action === "request") return piNativeCommandIsControl(command.input.command) ? "control" : "operation";
  return ["ensure", "catalog", "resolve_session_directory", "create", "fork", "reconcile_fork", "list", "history", "attach"].includes(command.action) ? "operation" : "control";
}
export const piNativeFailureSchema = z.strictObject({ code: z.string().regex(/^pi_[a-z0-9_]{1,100}$/u),
  delivery: z.enum(["not_sent", "sent_outcome_unknown", "rejected"]) });
export const piNativeHostResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.unknown() }),
  z.strictObject({ status: z.literal("failed"), failure: piNativeFailureSchema }),
]);
export const piNativeAttachmentSchema = piNativeIdentitySchema.extend({ handleId: id, generation: id, throughSequence: position, retainedAfterSequence: position,
  retainedOperationIds: z.array(id).max(512) });
export const piNativeDrainAttachmentSchema = piNativeAttachmentSchema.extend({ closed: z.boolean(), observationGap: z.boolean() });
export const piNativeObservationReleaseSchema = z.enum(["pending", "released"]);
export const piNativeOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("completed"), result: z.unknown() }),
  z.strictObject({ status: z.literal("failed"), failure: piNativeFailureSchema }),
]);
const streamText = z.string().max(128 * 1024 * 1024);
export const piNativeStreamSnapshotSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message_snapshot"), streamId: id, contentIndex: position, semanticKind: z.enum(["assistant_message", "reasoning"]), text: streamText }),
  z.strictObject({ type: z.literal("toolcall_snapshot"), streamId: id, contentIndex: position, text: streamText }),
  z.strictObject({ type: z.literal("bash_snapshot"), streamId: id, text: streamText }),
]);
export const piNativeEventSchema = z.union([
  z.strictObject({ sequence: position, kind: z.enum(["rpc", "companion", "failure"]), payload: z.record(z.string(), z.unknown()) }),
  z.strictObject({ sequence: position, kind: z.literal("stream"), payload: piNativeStreamSnapshotSchema }),
]);
export const piNativeObservationSchema = z.strictObject({ events: z.array(piNativeEventSchema).max(256),
  throughSequence: position, retainedAfterSequence: position, closed: z.boolean() });
export const piNativeHistorySchema = piNativeIdentitySchema.extend({ entries: z.array(z.record(z.string(), z.unknown())).max(250_000), leafId: id.nullable(), operations: z.array(piManagedOperationSchema).max(16_384), toolCalls: z.array(piNativeToolCallSchema).max(250_000), toolResults: z.array(piNativeToolResultSchema).max(250_000), inheritedEntryIds: z.array(id).max(250_000), inheritance: z.enum(["none", "verified", "unknown"]), parentSessionId: id.optional() });
export const piNativeListSchema = z.strictObject({ sessions: z.array(piNativeIdentitySchema.extend({ title: z.string().max(4096).optional(), updatedAt: z.string().datetime({ offset: true }) })).max(500), cursor: id.optional() });
export const piNativeCatalogSchema = z.strictObject({ models: z.array(z.record(z.string(), z.unknown())).max(100_000), commands: z.array(z.record(z.string(), z.unknown())).max(10_000),
  defaultSelection: z.strictObject({ provider: id, modelId: id, thinkingLevel: id }).optional() });
export const piNativeInspectionSchema = z.strictObject({ runtimeId: id, state: z.enum(["idle", "active", "unknown"]),
  revision: id, blockers: z.array(z.enum(["active_work", "pending_interaction", "unsettled_outcome", "cleanup_unproven", "unknown_state"])).max(5), retainedSessions: z.array(piNativeAttachmentSchema).max(32) });
export const piNativeSuccessSchema = z.strictObject({ ok: z.literal(true) });
export const piNativeRetirementSchema = z.enum(["retired", "absent", "busy", "undelivered"]);
