import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BoundedJsonValue } from "../../../../provider-protocol/json/bounded-json-snapshot.js";
import { piBoundedJson, piNativeEntrySchema, type PiNativeEntry } from "./pi-rpc-wire.js";
import { piNativeToolCallSchema, piNativeToolResultSchema, type PiNativeToolCall, type PiNativeToolResult } from "../tool-provenance.js";

export const PI_MANAGED_PROTOCOL_VERSION = 2;
export const PI_MANAGED_INPUT_MARKER = "sedes.native.input.v1";
const id = z.string().min(1).max(512);
const json = z.custom<BoundedJsonValue>();
const agentToolSchema = z.object({ name: id, label: id.optional(), description: z.string().max(65_536),
  parameters: z.record(z.string(), json), readOnly: z.boolean() }).strict();
export const piManagedInputSchema = z.object({
  operationId: id,
  mutationId: id,
  reconciliationToken: id,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["submit", "steer"]),
  targetTurnId: id.optional(),
  text: z.string().max(4 * 1024 * 1024),
  presentation: json.optional(),
}).strict();
export type PiManagedInput = z.infer<typeof piManagedInputSchema>;
export const piManagedOperationSchema = z.object({
  input: piManagedInputSchema,
  phase: z.enum(["intent", "enqueued", "accepted", "lost", "rejected"]),
  userEntryId: id.optional(),
  targetTurnId: id.optional(),
}).strict();
export type PiManagedOperation = z.infer<typeof piManagedOperationSchema>;
export const piManagedPolicySchema = z.object({
  mode: z.enum(["full", "read_only", "ask"]),
  allowedModels: z.array(z.object({ provider: id, modelId: id, thinkingLevels: z.array(id).optional() }).strict()).max(4096).optional(),
}).strict();
export type PiManagedPolicy = z.infer<typeof piManagedPolicySchema>;
export const piManagedCommandSchema = z.union([
  z.object({ type: z.literal("prepare_submission"), input: piManagedInputSchema }).strict(),
  z.object({ type: z.literal("complete_submission"), operationId: id, disposition: z.enum(["started", "queued", "handled", "rejected"]) }).strict(),
  z.object({ type: z.literal("get_submission"), operationId: id }).strict(),
  z.object({ type: z.literal("snapshot"), since: id.optional() }).strict(),
  z.object({ type: z.literal("set_policy"), policy: piManagedPolicySchema }).strict(),
  z.object({ type: z.literal("set_active_tools"), names: z.array(id).max(4096) }).strict(),
  z.object({ type: z.enum(["begin_stop", "end_stop"]) }).strict(),
  z.object({ type: z.literal("resolve_tool_approval"), id, approved: z.boolean() }).strict(),
  z.object({ type: z.literal("configure_agent_tools"), tools: z.array(agentToolSchema).max(1024), instructions: z.string().max(1_048_576).optional() }).strict(),
  z.object({ type: z.literal("resolve_agent_tool"), id, result: z.object({ content: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: id }).strict(),
  ])), details: json.optional(), structuredContent: json.optional() }).strict(), isError: z.boolean().optional() }).strict(),
]);
export type PiManagedCommand = z.infer<typeof piManagedCommandSchema>;
export interface PiManagedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: BoundedJsonValue;
  readonly sourceInfo?: BoundedJsonValue;
  readonly exposure?: string;
  readonly managed?: "codemode" | "agent" | "mcp" | "tool_search";
}
export const piManagedContextUsageSchema = z.object({
  tokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive(),
  percent: z.number().finite().nonnegative().nullable(),
}).strict().refine(value => (value.tokens === null) === (value.percent === null), {
  message: "Unknown context tokens and percentage must agree",
});
export type PiManagedContextUsage = z.infer<typeof piManagedContextUsageSchema>;
export interface PiManagedState {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly entries: readonly PiNativeEntry[];
  readonly leafId: string | null;
  readonly operations: readonly PiManagedOperation[];
  readonly toolCalls: readonly PiNativeToolCall[];
  readonly toolResults: readonly PiNativeToolResult[];
  readonly tools: readonly PiManagedTool[];
  readonly activeTools: readonly string[];
  readonly isIdle: boolean;
  readonly model?: { readonly provider: string; readonly id: string; readonly input?: readonly string[] };
  readonly thinkingLevel?: string;
  readonly contextUsage?: PiManagedContextUsage;
}
export type PiManagedEvent =
  | Readonly<{ type: "state_changed" }>
  | Readonly<{ type: "operation_changed"; operation: PiManagedOperation }>
  | Readonly<{ type: "tool_approval_requested"; id: string; toolCallId: string; toolName: string; parameters: BoundedJsonValue }>
  | Readonly<{ type: "tool_approval_closed"; id: string }>
  | Readonly<{ type: "agent_tool_call"; id: string; toolCallId: string; name: string; arguments: BoundedJsonValue; assistantEntryId: string; userEntryId: string; parentToolCallId?: string }>
  | Readonly<{ type: "agent_tool_cancelled"; id: string }>
  | Readonly<{ type: "request_usage"; assistantEntryId: string; outputTokens: number; requestDurationMs: number }>
  | Readonly<{ type: "failure"; code: string }>;

export const piManagedStateSchema = z.object({
  sessionId: id, sessionFile: z.string().optional(), entries: z.array(piNativeEntrySchema), leafId: id.nullable(),
  operations: z.array(piManagedOperationSchema), toolCalls: z.array(piNativeToolCallSchema), toolResults: z.array(piNativeToolResultSchema), tools: z.array(z.object({ name: id, description: z.string().optional(),
    parameters: json.optional(), sourceInfo: json.optional(), exposure: z.string().optional(), managed: z.enum(["codemode", "agent", "mcp", "tool_search"]).optional() }).strict()),
  activeTools: z.array(id), isIdle: z.boolean(), model: z.object({ provider: id, id, input: z.array(z.string()).optional() }).strict().optional(), thinkingLevel: id.optional(),
  contextUsage: piManagedContextUsageSchema.optional(),
}).strict();
export const piManagedEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state_changed") }).strict(),
  z.object({ type: z.literal("operation_changed"), operation: piManagedOperationSchema }).strict(),
  z.object({ type: z.literal("tool_approval_requested"), id, toolCallId: id, toolName: id, parameters: json }).strict(),
  z.object({ type: z.literal("tool_approval_closed"), id }).strict(),
  z.object({ type: z.literal("agent_tool_call"), id, toolCallId: id, name: id, arguments: json, assistantEntryId: id, userEntryId: id, parentToolCallId: id.optional() }).strict(),
  z.object({ type: z.literal("agent_tool_cancelled"), id }).strict(),
  z.object({ type: z.literal("request_usage"), assistantEntryId: id, outputTokens: z.number().int().nonnegative(), requestDurationMs: z.number().finite().nonnegative() }).strict(),
  z.object({ type: z.literal("failure"), code: id }).strict(),
]);
export function parsePiManagedResult(command: PiManagedCommand, value: unknown): unknown {
  const bounded = value === undefined ? undefined : piBoundedJson(value);
  switch (command.type) {
    case "snapshot": return piManagedStateSchema.parse(bounded);
    case "prepare_submission": return z.object({ wireText: id, operation: piManagedOperationSchema }).strict().parse(bounded);
    case "complete_submission": return piManagedOperationSchema.parse(bounded);
    case "get_submission": return piManagedOperationSchema.nullable().parse(bounded);
    case "begin_stop": case "end_stop": return z.object({ ok: z.literal(true) }).strict().parse(bounded);
    case "set_policy": case "set_active_tools": case "resolve_tool_approval": case "configure_agent_tools": case "resolve_agent_tool": return z.object({}).strict().parse(bounded);
  }
}

export function parsePiManagedCommand(value: unknown): PiManagedCommand {
  return piManagedCommandSchema.parse(piBoundedJson(value));
}

/** Canonical key order is shared with the generated companion implementation. */
export function piManagedAuthenticationBytes(sessionId: string, operation: PiManagedOperation): string {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)]));
    return value;
  }
  return JSON.stringify(stable([PI_MANAGED_INPUT_MARKER, sessionId, operation]));
}

export function signPiManagedOperation(sessionId: string, operation: PiManagedOperation, key: Uint8Array): string {
  if (key.byteLength < 32) throw new Error("pi_managed_authentication_key_invalid");
  return createHmac("sha256", key).update(piManagedAuthenticationBytes(sessionId, operation)).digest("base64url");
}

/** Raw native custom records never confer Sedes authority without their MAC.
 * Forks must re-attest records against the new native session ID explicitly.
 */
export function verifyPiManagedOperations(entries: readonly PiNativeEntry[], sessionId: string, key: Uint8Array): readonly PiManagedOperation[] {
  const latest = new Map<string, PiManagedOperation>();
  const knownEntries = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_MANAGED_INPUT_MARKER) continue;
    const decoded = z.object({ version: z.literal(1), operation: piManagedOperationSchema,
      authentication: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }).strict().safeParse(entry.data);
    if (!decoded.success) continue;
    const { operation, authentication } = decoded.data;
    const wanted = Buffer.from(signPiManagedOperation(sessionId, operation, key));
    const actual = Buffer.from(authentication);
    if (wanted.length !== actual.length || !timingSafeEqual(wanted, actual)) continue;
    if (operation.phase === "accepted") {
      const user = operation.userEntryId && knownEntries.get(operation.userEntryId);
      if (!user || user.type !== "message" || user.message.role !== "user") continue;
    }
    const old = latest.get(operation.input.operationId);
    if (old && JSON.stringify(old.input) !== JSON.stringify(operation.input)) throw new Error("pi_managed_operation_identity_conflict");
    // Final outcomes cannot regress to a new intent after reconnect/replay.
    if (old && ["accepted", "lost", "rejected"].includes(old.phase) && old.phase !== operation.phase) throw new Error("pi_managed_operation_outcome_conflict");
    latest.set(operation.input.operationId, operation);
  }
  return [...latest.values()];
}
