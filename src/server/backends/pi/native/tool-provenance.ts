import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BoundedJsonValue } from "../../../provider-protocol/json/bounded-json-snapshot.js";
import { piBoundedJson, piImageSchema, type PiNativeEntry } from "./rpc/pi-rpc-wire.js";

export const PI_NATIVE_TOOL_MARKER = "sedes.native.tool.v1";
export const PI_NATIVE_TOOL_RESULT_MARKER = "sedes.native.tool-result.v1";
const id = z.string().min(1).max(512);
const json = z.custom<BoundedJsonValue>();
export const piNativeToolCallSchema = z.object({
  toolCallId: id, toolName: id, assistantEntryId: id, userEntryId: id,
  parentToolCallId: id.optional(),
  sourceInfo: z.object({ source: id, path: z.string().min(1).max(16_384), scope: id.optional(), origin: id.optional() }).strict(),
  arguments: z.record(z.string(), json).optional(),
  managed: z.enum(["codemode", "agent", "mcp", "tool_search"]).optional(),
}).strict();
export const piNativeToolResultSchema = z.object({
  toolCallId: id, assistantEntryId: id, userEntryId: id,
  content: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }).strict(), piImageSchema])).max(65_536),
  details: json.optional(), isError: z.boolean(),
}).strict();
export type PiNativeToolCall = z.infer<typeof piNativeToolCallSchema>;
export type PiNativeToolResult = z.infer<typeof piNativeToolResultSchema>;

export function piNativeToolAuthenticationBytes(marker: string, sessionId: string, payload: unknown): string {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, stable(child)]));
    return value;
  }
  return JSON.stringify(stable([marker, sessionId, payload]));
}
function sign(marker: string, sessionId: string, payload: unknown, key: Uint8Array): string {
  if (key.byteLength < 32) throw new Error("pi_native_authentication_key_invalid");
  return createHmac("sha256", key).update(piNativeToolAuthenticationBytes(marker, sessionId, payload)).digest("base64url");
}
export function signPiNativeToolCall(sessionId: string, call: PiNativeToolCall, key: Uint8Array): string {
  return sign(PI_NATIVE_TOOL_MARKER, sessionId, call, key);
}
export function signPiNativeToolResult(sessionId: string, result: PiNativeToolResult, key: Uint8Array): string {
  return sign(PI_NATIVE_TOOL_RESULT_MARKER, sessionId, result, key);
}
function authenticated(marker: string, sessionId: string, payload: unknown, authentication: string, key: Uint8Array): boolean {
  const expected = Buffer.from(sign(marker, sessionId, payload, key));
  const actual = Buffer.from(authentication);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function same(a: unknown, b: unknown): boolean {
  return piNativeToolAuthenticationBytes("", "", a) === piNativeToolAuthenticationBytes("", "", b);
}

/** Attestation establishes which implementation ran, not whether it succeeded.
 * Ordinary native tool names and copied records from another session confer no
 * builtin or managed-tool authority.
 */
export function verifyPiNativeToolCalls(entries: readonly PiNativeEntry[], sessionId: string, key: Uint8Array): readonly PiNativeToolCall[] {
  const calls = new Map<string, PiNativeToolCall>();
  const known = new Map(entries.map(entry => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_NATIVE_TOOL_MARKER) continue;
    let bounded: BoundedJsonValue;
    try { bounded = piBoundedJson(entry.data); } catch { continue; }
    const parsed = z.object({ version: z.literal(1), call: piNativeToolCallSchema, authentication: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().safeParse(bounded);
    if (!parsed.success) continue;
    const { call, authentication } = parsed.data;
    if (!authenticated(PI_NATIVE_TOOL_MARKER, sessionId, call, authentication, key)) continue;
    const assistant = known.get(call.assistantEntryId);
    const user = known.get(call.userEntryId);
    if (assistant?.type !== "message" || assistant.message.role !== "assistant" || user?.type !== "message" || user.message.role !== "user") continue;
    let ancestor = assistant.parentId;
    const seen = new Set<string>();
    while (ancestor && ancestor !== user.id && !seen.has(ancestor)) { seen.add(ancestor); ancestor = known.get(ancestor)?.parentId ?? null; }
    if (ancestor !== user.id) continue;
    if (call.parentToolCallId) {
      const parent = calls.get(`${call.assistantEntryId}\0${call.parentToolCallId}`);
      if (!parent || parent.managed !== "codemode" || parent.assistantEntryId !== call.assistantEntryId || parent.userEntryId !== call.userEntryId) continue;
    } else {
      const matching = assistant.message.content.filter(block => block.type === "toolCall" && block.id === call.toolCallId);
      const direct = matching[0];
      if (matching.length !== 1 || !direct || direct.type !== "toolCall" || direct.name !== call.toolName) continue;
    }
    const identity = `${call.assistantEntryId}\0${call.toolCallId}`;
    const previous = calls.get(identity);
    if (previous && !same(previous, call)) throw new Error("pi_native_tool_identity_conflict");
    calls.set(identity, call);
  }
  return [...calls.values()];
}

export function verifyPiNativeToolResults(entries: readonly PiNativeEntry[], sessionId: string, key: Uint8Array): readonly PiNativeToolResult[] {
  const calls = new Map(verifyPiNativeToolCalls(entries, sessionId, key).map(call => [`${call.assistantEntryId}\0${call.toolCallId}`, call]));
  const results = new Map<string, PiNativeToolResult>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_NATIVE_TOOL_RESULT_MARKER) continue;
    let bounded: BoundedJsonValue;
    try { bounded = piBoundedJson(entry.data); } catch { continue; }
    const parsed = z.object({ version: z.literal(1), result: piNativeToolResultSchema, authentication: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().safeParse(bounded);
    if (!parsed.success) continue;
    const { result, authentication } = parsed.data;
    if (!authenticated(PI_NATIVE_TOOL_RESULT_MARKER, sessionId, result, authentication, key)) continue;
    const identity = `${result.assistantEntryId}\0${result.toolCallId}`;
    const call = calls.get(identity);
    if (!call || call.assistantEntryId !== result.assistantEntryId || call.userEntryId !== result.userEntryId) continue;
    const previous = results.get(identity);
    if (previous && !same(previous, result)) throw new Error("pi_native_tool_result_conflict");
    results.set(identity, result);
  }
  return [...results.values()];
}
