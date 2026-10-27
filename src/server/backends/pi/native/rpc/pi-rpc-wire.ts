import { z } from "zod";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../../../provider-protocol/transport/framed-message-limits.js";
import {
  snapshotBoundedJson,
  type BoundedJsonValue,
} from "../../../../provider-protocol/json/bounded-json-snapshot.js";

/** Reviewed wire contract: earendil-works/pi v1.4.0 (4a080252f06c).
 * No SDK runtime or SDK message types cross this boundary. Provider-specific
 * message/model metadata remains bounded JSON; consumed fields are validated.
 */
export const PI_RPC_VERSION = "1.4.0";
export const PI_RPC_MAXIMUM_BYTES = MAXIMUM_PROVIDER_FRAME_BYTES;
const id = z.string().min(1).max(512);
const text = z.string().max(PI_RPC_MAXIMUM_BYTES);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const json = z.custom<BoundedJsonValue>();
const jsonObject = z.record(z.string(), json);
export const piImageSchema = z.object({
  type: z.literal("image"), data: text, mimeType: z.string().min(1).max(128),
}).strict();
const contentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text }).passthrough(),
  z.object({ type: z.literal("thinking"), thinking: text }).passthrough(),
  piImageSchema,
  z.object({ type: z.literal("toolCall"), id, name: id, arguments: jsonObject }).passthrough(),
]);
const content = z.union([text, z.array(contentBlock).max(65_536)]);
const messageBase = { timestamp: finite };
export const piNativeMessageSchema = z.discriminatedUnion("role", [
  z.object({ ...messageBase, role: z.literal("user"), content }).passthrough(),
  z.object({ ...messageBase, role: z.literal("assistant"), content: z.array(contentBlock),
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    provider: id, model: id, api: id, usage: jsonObject,
  }).passthrough(),
  z.object({ ...messageBase, role: z.literal("toolResult"), toolCallId: id, toolName: id,
    content: z.array(contentBlock), isError: z.boolean(),
  }).passthrough(),
  z.object({ ...messageBase, role: z.literal("system"), content: z.union([text, z.array(z.object({ type: z.literal("text"), text }).passthrough())]) }).passthrough(),
  z.object({ ...messageBase, role: z.literal("custom"), customType: id, content,
    display: z.boolean(), details: json.optional(),
  }).passthrough(),
  z.object({ ...messageBase, role: z.literal("bashExecution"), command: text, output: text }).passthrough(),
  z.object({ ...messageBase, role: z.literal("compactionSummary"), summary: text }).passthrough(),
  z.object({ ...messageBase, role: z.literal("branchSummary"), summary: text }).passthrough(),
]);
export type PiNativeMessage = z.infer<typeof piNativeMessageSchema>;
const entryBase = { id, parentId: id.nullable(), timestamp: z.string().datetime({ offset: true }) };
export const piNativeEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...entryBase, type: z.literal("message"), message: piNativeMessageSchema }).strict(),
  z.object({ ...entryBase, type: z.literal("thinking_level_change"), thinkingLevel: id }).strict(),
  z.object({ ...entryBase, type: z.literal("model_change"), provider: id, modelId: id }).strict(),
  z.object({ ...entryBase, type: z.literal("usage"), kind: id, provider: id, model: id, usage: jsonObject, note: text.optional() }).strict(),
  z.object({ ...entryBase, type: z.literal("compaction"), summary: text, firstKeptEntryId: id.nullable(),
    tokensBefore: finite, details: json.optional(), usage: jsonObject.optional(), fromHook: z.boolean().optional(),
    systemMessage: piNativeMessageSchema.optional(),
  }).strict(),
  z.object({ ...entryBase, type: z.literal("branch_summary"), fromId: id, summary: text,
    details: json.optional(), usage: jsonObject.optional(), fromHook: z.boolean().optional(),
  }).strict(),
  z.object({ ...entryBase, type: z.literal("custom"), customType: id, data: json.optional() }).strict(),
  z.object({ ...entryBase, type: z.literal("custom_message"), customType: id, content,
    display: z.boolean(), details: json.optional(),
  }).strict(),
  z.object({ ...entryBase, type: z.literal("context_edit"), targetId: id,
    replacement: z.object({ content }).strict().nullable(),
  }).strict(),
  z.object({ ...entryBase, type: z.literal("label"), targetId: id, label: text.optional() }).strict(),
  z.object({ ...entryBase, type: z.literal("session_info"), name: text.optional() }).strict(),
]);
export type PiNativeEntry = z.infer<typeof piNativeEntrySchema>;
const headerSchema = z.object({ type: z.literal("session"), version: z.literal(3), id,
  timestamp: z.string().datetime({ offset: true }), cwd: id, parentSession: text.optional(),
}).strict();
export type PiNativeSessionHeader = z.infer<typeof headerSchema>;

const queueMode = z.enum(["all", "one-at-a-time"]);
const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const emptyCommands = ["abort", "clear_queue", "get_state", "cycle_model", "get_available_models",
  "cycle_thinking_level", "get_available_thinking_levels", "abort_retry", "abort_bash",
  "get_session_stats", "clone", "get_fork_messages", "get_tree", "get_last_assistant_text",
  "get_messages", "get_commands"] as const;
const commandSchema = z.union([
  z.object({ type: z.enum(emptyCommands) }).strict(),
  z.object({ type: z.literal("prompt"), message: text, images: z.array(piImageSchema).max(64).optional(), streamingBehavior: z.enum(["steer", "followUp"]).optional() }).strict(),
  z.object({ type: z.enum(["steer", "follow_up"]), message: text, images: z.array(piImageSchema).max(64).optional() }).strict(),
  z.object({ type: z.literal("new_session"), parentSession: text.optional() }).strict(),
  z.object({ type: z.literal("set_model"), provider: id, modelId: id }).strict(),
  z.object({ type: z.literal("set_thinking_level"), level: thinking }).strict(),
  z.object({ type: z.enum(["set_steering_mode", "set_follow_up_mode"]), mode: queueMode }).strict(),
  z.object({ type: z.literal("compact"), customInstructions: text.optional() }).strict(),
  z.object({ type: z.enum(["set_auto_compaction", "set_auto_retry"]), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("bash"), command: text, excludeFromContext: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("export_html"), outputPath: text.optional() }).strict(),
  z.object({ type: z.literal("switch_session"), sessionPath: text }).strict(),
  z.object({ type: z.literal("fork"), entryId: id }).strict(),
  z.object({ type: z.literal("get_entries"), since: id.optional() }).strict(),
  z.object({ type: z.literal("set_session_name"), name: id }).strict(),
]);
export type PiRpcCommand = z.infer<typeof commandSchema>;
const model = z.object({ id, provider: id, name: text, contextWindow: natural,
  maxTokens: natural, reasoning: z.boolean(), input: z.array(z.enum(["text", "image"])),
}).passthrough();
const state = z.object({ model: model.optional(), thinkingLevel: thinking, isStreaming: z.boolean(),
  isCompacting: z.boolean(), steeringMode: queueMode, followUpMode: queueMode,
  sessionFile: text.optional(), sessionId: id, sessionName: text.optional(), autoCompactionEnabled: z.boolean(),
  messageCount: natural, pendingMessageCount: natural,
}).strict();
export type PiRpcState = z.infer<typeof state>;
export function parsePiRpcState(value: unknown): PiRpcState { return state.parse(piBoundedJson(value)); }
const responseEnvelope = z.union([
  z.object({ type: z.literal("response"), id: id.optional(), command: id, success: z.literal(false), error: text }).strict(),
  z.object({ type: z.literal("response"), id: id.optional(), command: id, success: z.literal(true), data: json.optional() }).strict(),
]);
export type PiRpcResponse = z.infer<typeof responseEnvelope>;
const resultSchemas = {
  prompt: z.object({ disposition: z.enum(["started", "queued", "handled"]) }).strict(),
  steer: z.object({ disposition: z.enum(["queued", "handled"]) }).strict(),
  follow_up: z.object({ disposition: z.enum(["queued", "handled"]) }).strict(),
  abort: z.undefined(), clear_queue: z.object({ steering: z.array(text), followUp: z.array(text) }).strict(),
  new_session: z.object({ cancelled: z.boolean() }).strict(), get_state: state,
  set_model: model, cycle_model: z.object({ model, thinkingLevel: thinking, isScoped: z.boolean() }).strict().nullable(),
  get_available_models: z.object({ models: z.array(model) }).strict(),
  set_thinking_level: z.undefined(), cycle_thinking_level: z.object({ level: thinking }).strict().nullable(),
  get_available_thinking_levels: z.object({ levels: z.array(thinking) }).strict(),
  set_steering_mode: z.undefined(), set_follow_up_mode: z.undefined(),
  compact: z.object({ summary: text, firstKeptEntryId: id.nullable(), tokensBefore: finite }).passthrough(),
  set_auto_compaction: z.undefined(), set_auto_retry: z.undefined(), abort_retry: z.undefined(),
  bash: z.object({ output: text, exitCode: finite.optional(), cancelled: z.boolean(), truncated: z.boolean() }).passthrough(),
  abort_bash: z.undefined(), get_session_stats: jsonObject,
  export_html: z.object({ path: text }).strict(), switch_session: z.object({ cancelled: z.boolean() }).strict(),
  fork: z.object({ text: text.optional(), cancelled: z.boolean() }).strict(), clone: z.object({ cancelled: z.boolean() }).strict(),
  get_fork_messages: z.object({ messages: z.array(z.object({ entryId: id, text }).strict()) }).strict(),
  get_entries: z.object({ entries: z.array(piNativeEntrySchema), leafId: id.nullable() }).strict(),
  get_tree: z.object({ tree: z.array(jsonObject), leafId: id.nullable() }).strict(),
  get_last_assistant_text: z.object({ text: text.nullable() }).strict(), set_session_name: z.undefined(),
  get_messages: z.object({ messages: z.array(piNativeMessageSchema) }).strict(),
  get_commands: z.object({ commands: z.array(z.object({ name: id, description: text.optional(), source: z.enum(["extension", "prompt", "skill"]), sourceInfo: jsonObject }).strict()) }).strict(),
} satisfies Record<PiRpcCommand["type"], z.ZodType>;
export type PiRpcResult<T extends PiRpcCommand["type"]> = z.infer<(typeof resultSchemas)[T]>;

const blockIndex = { contentIndex: natural };
const deltaSchema = z.union([
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.enum(["text_start", "thinking_start"]), ...blockIndex }).strict(),
  z.object({ type: z.enum(["text_delta", "thinking_delta", "toolcall_delta"]), ...blockIndex, delta: text }).strict(),
  z.object({ type: z.enum(["text_end", "thinking_end"]), ...blockIndex, content: text }).strict(),
  z.object({ type: z.literal("toolcall_start"), ...blockIndex, id, toolName: id }).strict(),
  z.object({ type: z.literal("toolcall_end"), ...blockIndex, toolCall: contentBlock }).strict(),
  z.object({ type: z.literal("done"), reason: id, message: piNativeMessageSchema }).strict(),
  z.object({ type: z.literal("error"), reason: id, error: piNativeMessageSchema }).strict(),
]);
const toolBase = { toolCallId: id, toolName: id, parentToolCallId: id.optional() };
const reason = z.enum(["manual", "threshold", "overflow"]);
const eventSchema = z.union([
  z.object({ type: z.enum(["agent_start", "turn_start", "summarization_retry_finished"]) }).strict(),
  z.object({ type: z.literal("agent_end"), messages: z.array(piNativeMessageSchema), willRetry: z.boolean() }).strict(),
  z.object({ type: z.literal("agent_settled"), aborted: z.boolean() }).strict(),
  z.object({ type: z.literal("turn_end"), message: piNativeMessageSchema, toolResults: z.array(piNativeMessageSchema) }).strict(),
  z.object({ type: z.enum(["message_start", "message_end"]), message: piNativeMessageSchema }).strict(),
  z.object({ type: z.literal("message_update"), usage: jsonObject, assistantMessageEvent: deltaSchema }).strict(),
  z.object({ type: z.literal("tool_execution_start"), ...toolBase, args: jsonObject }).strict(),
  z.object({ type: z.literal("tool_execution_update"), ...toolBase, args: jsonObject, partialResult: jsonObject }).strict(),
  z.object({ type: z.literal("tool_execution_end"), ...toolBase, result: jsonObject, isError: z.boolean(), durationMs: finite.optional() }).strict(),
  z.object({ type: z.literal("queue_update"), steering: z.array(text), followUp: z.array(text) }).strict(),
  z.object({ type: z.literal("entry_appended"), entry: piNativeEntrySchema }).strict(),
  z.object({ type: z.literal("session_info_changed"), name: text.optional() }).strict(),
  z.object({ type: z.literal("thinking_level_changed"), level: thinking }).strict(),
  z.object({ type: z.literal("compaction_start"), reason }).strict(),
  z.object({ type: z.literal("compaction_end"), reason, result: jsonObject.optional(), aborted: z.boolean(), willRetry: z.boolean(), errorMessage: text.optional() }).strict(),
  z.object({ type: z.enum(["auto_retry_start", "summarization_retry_scheduled"]), attempt: natural, maxAttempts: natural, delayMs: natural, errorMessage: text }).strict(),
  z.object({ type: z.literal("auto_retry_end"), success: z.boolean(), attempt: natural, finalError: text.optional() }).strict(),
  z.object({ type: z.literal("summarization_retry_attempt_start"), source: z.literal("branchSummary") }).strict(),
  z.object({ type: z.literal("summarization_retry_attempt_start"), source: z.literal("compaction"), reason }).strict(),
  z.object({ type: z.literal("bash_execution_update"), id: id.optional(), delta: text }).strict(),
  z.object({ type: z.literal("extension_error"), extensionPath: text, event: id, error: text }).strict(),
]);
export type PiRpcEvent = z.infer<typeof eventSchema>;
const uiBase = { type: z.literal("extension_ui_request"), id };
const timeout = natural.optional();
const uiSchema = z.discriminatedUnion("method", [
  z.object({ ...uiBase, method: z.literal("select"), title: text, options: z.array(text), timeout }).strict(),
  z.object({ ...uiBase, method: z.literal("confirm"), title: text, message: text, timeout }).strict(),
  z.object({ ...uiBase, method: z.literal("input"), title: text, placeholder: text.optional(), timeout }).strict(),
  z.object({ ...uiBase, method: z.literal("editor"), title: text, prefill: text.optional() }).strict(),
  z.object({ ...uiBase, method: z.literal("notify"), message: text, notifyType: z.enum(["info", "warning", "error"]).optional() }).strict(),
  z.object({ ...uiBase, method: z.literal("setStatus"), statusKey: id, statusText: text.optional() }).strict(),
  z.object({ ...uiBase, method: z.literal("setWidget"), widgetKey: id, widgetLines: z.array(text).optional(), widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional() }).strict(),
  z.object({ ...uiBase, method: z.literal("setTitle"), title: text }).strict(),
  z.object({ ...uiBase, method: z.literal("set_editor_text"), text }).strict(),
]);
export type PiRpcExtensionUIRequest = z.infer<typeof uiSchema>;
const uiResponseSchema = z.union([
  z.object({ type: z.literal("extension_ui_response"), id, value: text }).strict(),
  z.object({ type: z.literal("extension_ui_response"), id, confirmed: z.boolean() }).strict(),
  z.object({ type: z.literal("extension_ui_response"), id, cancelled: z.literal(true) }).strict(),
]);
export type PiRpcExtensionUIResponse = z.infer<typeof uiResponseSchema>;
export type PiRpcRecord = PiRpcResponse | PiRpcEvent | PiRpcExtensionUIRequest;

export function piBoundedJson(value: unknown): BoundedJsonValue {
  return snapshotBoundedJson(value, { maximumEncodedBytes: PI_RPC_MAXIMUM_BYTES,
    maximumStringBytes: PI_RPC_MAXIMUM_BYTES, maximumDepth: 48 });
}
export function parsePiRpcCommand(value: unknown): PiRpcCommand {
  return commandSchema.parse(piBoundedJson(value));
}
export function parsePiNativeEntry(value: unknown): PiNativeEntry {
  return piNativeEntrySchema.parse(piBoundedJson(value));
}
export function parsePiNativeSessionHeader(value: unknown): PiNativeSessionHeader {
  return headerSchema.parse(piBoundedJson(value));
}
export function parsePiRpcUIResponse(value: unknown): PiRpcExtensionUIResponse {
  return uiResponseSchema.parse(piBoundedJson(value));
}
export function parsePiRpcRecord(raw: string): PiRpcRecord {
  if (Buffer.byteLength(raw) > PI_RPC_MAXIMUM_BYTES) throw new Error("pi_rpc_frame_limit");
  const value = piBoundedJson(JSON.parse(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi_rpc_record_invalid");
  const type = (value as { readonly type?: unknown }).type;
  if (type === "response") {
    const response = responseEnvelope.parse(value);
    if (response.success) {
      if (!Object.hasOwn(resultSchemas, response.command)) throw new Error("pi_rpc_response_command_unknown");
      resultSchemas[response.command as PiRpcCommand["type"]].parse(response.data);
    }
    return response;
  }
  return type === "extension_ui_request" ? uiSchema.parse(value) : eventSchema.parse(value);
}
