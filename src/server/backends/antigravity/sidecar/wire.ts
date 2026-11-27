import { validToolPath, validToolDirectory } from "../../agent-tool-route.js";
import { z } from "zod";
import type { InitializeResponse, LoadSessionResponse, PromptRequest, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { decodeInitializeResponse, decodeLoadSessionResponse, decodePromptRequest, decodeRequestPermissionRequest,
  decodeRequestPermissionResponse, decodeSessionNotification } from "../../../provider-protocol/bindings/acp-v1/generated/1.3.0/projectors.js";
import { snapshotBoundedJson } from "../../../provider-protocol/json/bounded-json-snapshot.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../../provider-protocol/transport/framed-message-limits.js";
import { environmentVariableOverridesSchema } from "../../../../shared/protocol/environment-variables.js";
import { sidecarRuntimeBodySchema } from "../../../sidecar/runtime-body-channel.js";
import type { SidecarOperationDefinition } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { antigravityNativeHistorySchema } from "../native-schema.js";

const id = z.string().min(1).max(512);
const hostPath = z.string().min(1).max(4096);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const antigravityAgentToolsSchema = z.strictObject({ surface: z.enum(["native", "cli"]), mode: z.enum(["progressive", "individual"]),
  endpoint: z.url().max(4096), sourceCapability: z.string().min(1).max(32 * 1024), executableDirectory: hostPath.refine(validToolDirectory), inheritedPath: z.string().refine(validToolPath) });
const limits = { maximumEncodedBytes: MAXIMUM_PROVIDER_FRAME_BYTES, maximumStringBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
  maximumArrayItems: MAXIMUM_PROVIDER_FRAME_BYTES, maximumTotalNodes: MAXIMUM_PROVIDER_FRAME_BYTES, maximumDepth: 32 };
function acp<T>(decode: (value: unknown) => unknown | undefined) {
  return z.unknown().transform((value, context): T => {
    try {
      const decoded = decode(snapshotBoundedJson(value, limits));
      if (decoded === undefined) throw new Error();
      return snapshotBoundedJson(decoded, limits) as T;
    } catch { context.addIssue({ code: "custom", message: "Invalid Antigravity ACP value." }); return z.NEVER; }
  });
}
export const antigravityConfigurationSchema = z.strictObject({
  tenantId: id, principalId: id, backendInstanceId: id, executionEnvironmentId: id,
  executablePath: hostPath.optional(), geminiDirectory: hostPath.optional(),
  initializationTimeoutMs: z.number().int().min(1000).max(120_000), startupEnvironmentVariables: environmentVariableOverridesSchema.optional(),
});
export const antigravityIdentitySchema = z.strictObject({ sessionId: id, cwd: hostPath });
export const antigravitySetupSchema = z.strictObject({ initialize: acp<InitializeResponse>(decodeInitializeResponse), session: acp<LoadSessionResponse>(decodeLoadSessionResponse),
  modelOptions: z.array(z.strictObject({ modelId: id, thinkingLevels: z.array(id).max(100), defaultThinkingLevel: id.optional() })).max(1000).optional() });
export const antigravityHistorySchema = antigravityIdentitySchema.extend({ setup: antigravitySetupSchema.optional(), native: antigravityNativeHistorySchema });
export const antigravityHistoryReadSchema = antigravityIdentitySchema.extend({ knownRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
export const antigravityCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("prompt"), prompt: acp<PromptRequest>(value => decodePromptRequest({ sessionId: "validation", prompt: value })).transform(value => value.prompt) }),
  z.strictObject({ type: z.literal("steer"), prompt: acp<PromptRequest>(value => decodePromptRequest({ sessionId: "validation", prompt: value })).transform(value => value.prompt) }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("set_config"), configId: id, value: z.string().max(8192) }),
  z.strictObject({ type: z.literal("set_mode"), modeId: id }),
  z.strictObject({ type: z.literal("permission"), requestId: id, response: acp<RequestPermissionResponse>(decodeRequestPermissionResponse) }),
]);
const handle = z.strictObject({ handleId: id });
const operation = handle.extend({ operationId: id });
const authority = { controllerEpoch: z.number().int().positive(), serviceIncarnation: id };
function command<const Action extends string, Schema extends z.ZodType>(action: Action, input: Schema) {
  return z.strictObject({ ...authority, runtimeId: id, action: z.literal(action), input });
}
export const antigravityHostCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...authority, action: z.literal("ensure"), configuration: antigravityConfigurationSchema }),
  z.strictObject({ ...authority, action: z.literal("lookup"), configuration: antigravityConfigurationSchema }),
  z.strictObject({ ...authority, action: z.literal("lookup_retained"), backendInstanceId: id }),
  command("catalog", z.strictObject({ cwd: hostPath })),
  command("connect", z.strictObject({})),
  command("create", z.strictObject({ cwd: hostPath, operationId: id, title: z.string().max(4096).optional(), executionEnvironment: environmentVariableOverridesSchema.optional(), agentTools: antigravityAgentToolsSchema.optional() })),
  command("acknowledge_creation", antigravityIdentitySchema.extend({ operationId: id })),
  command("list", z.strictObject({ cwd: hostPath, cursor: id.optional() })),
  command("history", antigravityHistoryReadSchema),
  command("attach", antigravityIdentitySchema.extend({ executionEnvironment: environmentVariableOverridesSchema.optional(), agentTools: antigravityAgentToolsSchema.optional() })),
  command("attach_existing", antigravityIdentitySchema),
  command("request", operation.extend({ command: antigravityCommandSchema })),
  command("outcome", operation), command("acknowledge_operation", operation),
  command("observe", handle.extend({ afterSequence: position })),
  command("acknowledge", handle.extend({ throughSequence: position })),
  command("release", handle), command("retire_session", antigravityIdentitySchema), command("inspect", z.strictObject({})),
  command("stop", z.strictObject({ expectedRevision: id, force: z.boolean() })),
]);
export type AntigravityHostCommand = z.infer<typeof antigravityHostCommandSchema>;
export type AntigravityHostCommandInput = AntigravityHostCommand extends infer Command
  ? Command extends AntigravityHostCommand ? Omit<Command, "controllerEpoch" | "serviceIncarnation"> : never : never;
const capability = { capabilityId: "antigravity_runtime", majorVersion: 6 } as const;
export const antigravityExecuteOperation = { ...capability, operation: "runtime.execute", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const antigravityControlOperation = { ...capability, operation: "runtime.control", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "control", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const antigravityRuntimeOperations = [antigravityExecuteOperation, antigravityControlOperation] as const;
export const antigravityRuntimeCapability = { ...capability, operations: antigravityRuntimeOperations.map(operation => operation.operation) };
export function antigravityHostCommandLane(value: AntigravityHostCommand | AntigravityHostCommandInput): "operation" | "control" {
  if (value.action === "request") return ["cancel", "permission"].includes(value.input.command.type) ? "control" : "operation";
  return ["ensure", "connect", "catalog", "create", "list", "history", "attach"].includes(value.action) ? "operation" : "control";
}
export const antigravityFailureSchema = z.strictObject({ code: z.string().regex(/^antigravity_[a-z0-9_]{1,100}$/u), delivery: z.enum(["not_sent", "sent_outcome_unknown", "rejected"]) });
export const antigravityOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }), z.strictObject({ status: z.literal("completed"), result: z.unknown(), cancelledAtNativeRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional() }),
  z.strictObject({ status: z.literal("failed"), failure: antigravityFailureSchema }),
]);
export const antigravityHostResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), runtimeVersion: z.string().max(128).nullable(), value: z.unknown() }),
  z.strictObject({ status: z.literal("failed"), runtimeVersion: z.string().max(128).nullable(), failure: antigravityFailureSchema }),
]);
export const antigravityAttachmentSchema = antigravityIdentitySchema.extend({ toolPeerStamp: z.string().regex(/^[0-9a-f]{64}$/u).optional(), handleId: id, generation: id, setup: antigravitySetupSchema,
  loading: z.literal(true).optional(), closed: z.literal(true).optional(),
  createdByOperationId: id.optional(),
  throughSequence: position, retainedAfterSequence: position, retainedOperationIds: z.array(id).max(640), activePromptIds: z.array(id).max(32),
  pendingPermissions: z.array(z.strictObject({ requestId: id, openedAt: z.iso.datetime(), request: acp<RequestPermissionRequest>(decodeRequestPermissionRequest) })).max(64) });
const eventPosition = { sequence: position };
export const antigravityEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...eventPosition, kind: z.literal("session_loaded"), session: acp<LoadSessionResponse>(decodeLoadSessionResponse) }),
  z.strictObject({ ...eventPosition, kind: z.literal("update"), notification: acp<SessionNotification>(decodeSessionNotification) }),
  z.strictObject({ ...eventPosition, kind: z.literal("permission"), requestId: id, openedAt: z.iso.datetime(), request: acp<RequestPermissionRequest>(decodeRequestPermissionRequest) }),
  z.strictObject({ ...eventPosition, kind: z.literal("permission_resolved"), requestId: id }),
  z.strictObject({ ...eventPosition, kind: z.literal("operation"), operationId: id, outcome: antigravityOutcomeSchema }),
  z.strictObject({ ...eventPosition, kind: z.literal("failure"), failure: antigravityFailureSchema }),
]);
export const antigravityObservationSchema = z.strictObject({ activePromptIds: z.array(id).max(32), events: z.array(antigravityEventSchema).max(256), throughSequence: position, retainedAfterSequence: position, closed: z.boolean() });
export const antigravityInspectionSchema = z.strictObject({ runtimeId: id, state: z.enum(["idle", "active", "unknown"]), revision: id,
  blockers: z.array(z.enum(["active_work", "pending_interaction", "unsettled_outcome", "cleanup_unproven", "unknown_state"])).max(5),
  retainedSessions: z.array(antigravityIdentitySchema.extend({ handleId: id, generation: id, closed: z.boolean() })).max(32) });
export const antigravityListSchema = z.strictObject({ sessions: z.array(antigravityIdentitySchema.extend({ title: z.string().max(4096).optional(), updatedAt: z.string().optional() })).max(500), cursor: id.optional() });
export const antigravitySuccessSchema = z.strictObject({ ok: z.literal(true) });
export const antigravityRetirementSchema = z.enum(["retired", "absent", "busy", "undelivered"]);
