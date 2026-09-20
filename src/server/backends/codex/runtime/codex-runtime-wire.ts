import { z } from "zod";
import { isCodexClientRequestMethod, isCodexServerRequestMethod, isCodexServerNotificationMethod, decodeCodexServerRequestParams, admitCodexServerNotification, type CodexClientRequestMethod, type CodexServerRequestMethod, type CodexServerNotificationMethod } from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { CodexRuntimeEvent, CodexRuntimeOutcome, CodexRuntimeSnapshot } from "./codex-runtime-protocol.js";
import { codexRuntimeMethod } from "./codex-runtime-protocol.js";

const identifier = z.string().min(1).max(512);
const generation = z.number().int().positive();
const sequence = z.number().int().nonnegative();
const method = z.custom<CodexClientRequestMethod>(value => typeof value === "string" && isCodexClientRequestMethod(value) && value !== "initialize");
const requestMethod = z.custom<CodexServerRequestMethod>(value => typeof value === "string" && isCodexServerRequestMethod(value));
const notificationMethod = z.custom<CodexServerNotificationMethod>(value => typeof value === "string" && isCodexServerNotificationMethod(value));
const requestId = z.union([identifier, z.number().int()]);
export const codexRuntimeAuthoritySchema = z.strictObject({
  scope: z.strictObject({ tenantId: identifier, principalId: identifier, executionEnvironmentId: identifier, backendInstanceId: identifier }),
  runtimeId: identifier, controllerId: identifier,
});
const lifecycleSchema = z.strictObject({ state: z.enum(["idle", "unavailable", "starting", "reconciling", "ready", "circuit_open", "closing", "closed"]), generation: sequence, unavailableReason: z.literal("runtime_configuration_unavailable").optional() });
const assessmentSchema = z.strictObject({ version: z.string().min(1).max(128), newerThanTested: z.boolean() });
const pendingRequestSchema = z.strictObject({ generation, sequence, id: requestId, method: requestMethod, params: z.unknown(), trace: z.unknown().optional() }).transform(value => ({ ...value, params: decodeCodexServerRequestParams(value.method, value.params) }));
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending"), operationId: identifier, method }),
  z.strictObject({ status: z.literal("completed"), operationId: identifier, method, receipt: z.strictObject({ generation, inboundSequence: sequence, result: z.unknown() }) }).transform(value => ({ ...value, receipt: { ...value.receipt, result: codexRuntimeMethod(value.method).decodeResult(value.receipt.result) } })),
  z.strictObject({ status: z.literal("failed"), operationId: identifier, method, failure: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("delivery"), code: z.string().min(1).max(256), delivery: z.enum(["not_sent", "sent_outcome_unknown"]), generation, method }),
    z.strictObject({ kind: z.literal("remote"), code: z.number().int(), message: z.string().max(8192), generation, method, data: z.unknown().optional() }),
  ]) }),
]);
export const codexRuntimeOutcomeSchema: z.ZodType<CodexRuntimeOutcome> = outcomeSchema;
export const codexRuntimeOutcomeReferencesSchema = z.array(z.strictObject({ status: z.enum(["pending", "completed", "failed"]), operationId: identifier, method })).max(128);
export const codexRuntimeSnapshotSchema: z.ZodType<CodexRuntimeSnapshot> = z.strictObject({ protocolVersion: z.literal(1), runtimeId: identifier, lifecycle: lifecycleSchema, runtimeAssessment: assessmentSchema.nullable(), pendingRequests: z.array(pendingRequestSchema).max(128), outcomes: z.array(z.strictObject({ status: z.enum(["pending", "completed", "failed"]), operationId: identifier, method })).max(128) });
const notificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decoded_notification"), generation, sequence, method: notificationMethod, params: z.unknown(), emittedAtMs: sequence.optional() }).transform(value => {
    const admission = admitCodexServerNotification(value.method, value.params);
    if (admission.status !== "decoded") throw new Error("codex_runtime_notification_invalid");
    return { ...value, params: admission.params };
  }),
  z.strictObject({ kind: z.literal("undecodable_notification"), generation, sequence, method: notificationMethod, nativeThreadId: identifier, code: z.literal("codex_rpc_notification_params_undecodable") }),
]);
export const codexRuntimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("runtime_assessment"), assessment: assessmentSchema }),
  z.strictObject({ type: z.literal("lifecycle"), lifecycle: lifecycleSchema }),
  z.strictObject({ type: z.literal("notification"), notification: notificationSchema }),
  z.strictObject({ type: z.literal("server_request"), request: pendingRequestSchema }),
  z.strictObject({ type: z.literal("server_request_settled"), generation, requestId }),
  z.strictObject({ type: z.literal("outcome"), outcome: outcomeSchema }),
]) as z.ZodType<CodexRuntimeEvent>;
export const codexRuntimeCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("shell_path"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("evict_thread"), authority: codexRuntimeAuthoritySchema, threadId: identifier, generation }),
  z.strictObject({ action: z.literal("idle"), authority: codexRuntimeAuthoritySchema, generation }),
  z.strictObject({ action: z.literal("wake"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("attach"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("detach"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("submit"), authority: codexRuntimeAuthoritySchema, input: z.strictObject({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), generation, method, params: z.unknown(), environmentVariablesFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), timeoutMilliseconds: z.number().int().min(1).max(86_400_000) }) }),
  z.strictObject({ action: z.literal("outcome"), authority: codexRuntimeAuthoritySchema, operationId: identifier }),
  z.strictObject({ action: z.literal("recover_outcomes"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("recover_outcome"), authority: codexRuntimeAuthoritySchema, operationId: identifier }),
  z.strictObject({ action: z.literal("acknowledge_recovered_outcome"), authority: codexRuntimeAuthoritySchema, operationId: identifier }),
  z.strictObject({ action: z.literal("acknowledge"), authority: codexRuntimeAuthoritySchema, operationId: identifier }),
  z.strictObject({ action: z.literal("respond"), authority: codexRuntimeAuthoritySchema, input: z.strictObject({ generation, requestId, result: z.unknown() }) }),
  z.strictObject({ action: z.literal("inspect"), authority: codexRuntimeAuthoritySchema }),
  z.strictObject({ action: z.literal("stop"), authority: codexRuntimeAuthoritySchema, expectedRevision: z.string().min(1).max(160), force: z.boolean() }),
  z.strictObject({ action: z.literal("reattach_thread"), authority: codexRuntimeAuthoritySchema, threadId: identifier, timeoutMilliseconds: z.number().int().min(1).max(600_000) }),
  z.strictObject({ action: z.literal("retire"), authority: codexRuntimeAuthoritySchema, generation, reason: z.string().min(1).max(128).regex(/^[a-z0-9_]+$/u) }),
]);
export type CodexRuntimeCommand = z.infer<typeof codexRuntimeCommandSchema>;
