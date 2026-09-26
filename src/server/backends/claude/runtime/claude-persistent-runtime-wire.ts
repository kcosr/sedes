import { backgroundActivitySchema } from "../../../../shared/protocol/background-activity.js";
import { z } from "zod";
import * as worker from "../worker/claude-runtime-v1.js";

/** Resident sessions plus running fork launches, per persistent runtime. */
export const CLAUDE_PERSISTENT_MAXIMUM_SESSIONS = 32;
const id = z.string().min(1).max(512);
export const claudePersistentConfigurationSchema = worker.claudeRuntimeInitializeRequestSchema.omit({ startupEnvironment: true }).extend({
  tenantId: id, principalId: id, backendInstanceId: id, executionEnvironmentId: id,
});
export type ClaudePersistentConfiguration = z.infer<typeof claudePersistentConfigurationSchema>;
const session = z.strictObject({ sessionId: z.string().uuid() });
const authority = { runtimeId: id, controllerEpoch: z.number().int().positive() };
function command<const Action extends string, Schema extends z.ZodType>(action: Action, request: Schema) {
  return z.strictObject({ ...authority, action: z.literal(action), request });
}
/** A fork launch is only ever the one-shot `fork` command, never a session. */
export const claudePersistentOpenRequestSchema = worker.claudeRuntimeQueryOpenRequestSchema.refine(
  request => request.launch !== "fork", "A persistent session never adopts a fork launch.");
export const claudePersistentCommandSchema = z.discriminatedUnion("action", [
  command("probe", worker.claudeRuntimeProbeRequestSchema),
  command("list", worker.claudeRuntimeSessionListRequestSchema),
  command("info", worker.claudeRuntimeSessionInfoRequestSchema),
  command("messages", worker.claudeRuntimeSessionMessagesRequestSchema),
  command("transcript", worker.claudeRuntimeSessionTranscriptRequestSchema),
  command("rename", worker.claudeRuntimeSessionRenameRequestSchema),
  command("open", claudePersistentOpenRequestSchema).extend({ replay: z.enum(["full", "unacknowledged"]) }),
  command("fork", worker.claudeRuntimeForkRequestSchema),
  command("send", worker.claudeRuntimeQuerySendRequestSchema),
  command("interrupt", z.strictObject({ queryId: z.string().uuid() })),
  command("set_model", worker.claudeRuntimeQuerySetModelRequestSchema),
  command("set_effort", worker.claudeRuntimeQuerySetEffortRequestSchema),
  command("set_permission_mode", worker.claudeRuntimeQuerySetPermissionModeRequestSchema),
  command("attach", session).extend({ replay: z.enum(["full", "unacknowledged"]) }), command("detach", session), command("evict", session),
  command("submission_disposition", session.extend({ operationId: z.string().uuid(), cwd: worker.claudeRuntimeProbeRequestSchema.shape.cwd })),
  command("acknowledge", session.extend({ sequence: z.number().int().nonnegative() })),
  command("respond_permission", session.extend({ requestId: id, toolUseID: id, response: worker.claudeRuntimeCanUseToolResponseSchema })),
]);
export type ClaudePersistentCommand = z.infer<typeof claudePersistentCommandSchema>;
export const claudePersistentEventSchema = z.strictObject({
  sessionId: z.string().uuid(), sequence: z.number().int().positive(),
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("message"), message: worker.claudeRuntimeQueryMessageEventSchema.shape.message, consumedTurnRootUuid: z.string().uuid().optional() }),
    z.strictObject({ kind: z.literal("failed"), code: id }),
    z.strictObject({ kind: z.literal("permission"), request: worker.claudeRuntimeCanUseToolRequestSchema }),
    z.strictObject({ kind: z.literal("permission_delivered"), requestId: id, toolUseID: id }),
    z.strictObject({ kind: z.literal("permission_failed"), requestId: id, toolUseID: id }),
  ]),
});
export type ClaudePersistentEvent = z.infer<typeof claudePersistentEventSchema>;
/** Only these owner-side refusals prove this send did not reach the native query. */
export const claudePersistentSendResponseSchema = z.discriminatedUnion("accepted", [
  z.strictObject({ accepted: z.literal(true) }),
  z.strictObject({ accepted: z.literal(false), code: z.enum([
    "claude_persistent_query_busy", "claude_persistent_query_closed",
    "claude_persistent_input_capacity_exceeded", "claude_persistent_operation_capacity_exceeded",
  ]) }),
]);
export const claudePersistentAttachmentSchema = z.strictObject({
  queryId: z.string().uuid(), startupProbeUuid: z.string().uuid(), reattached: z.boolean(),
  initialization: worker.claudeRuntimeInitializationSchema,
  failureCode: id.nullable(),
  backgroundActivity: backgroundActivitySchema,
  pendingBackgroundTaskIds: z.array(z.string().min(1).max(512)).max(8192),
  confirmedEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  events: z.array(claudePersistentEventSchema).max(8192),
});
