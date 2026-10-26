import { PiToolSemanticMapperRegistry } from "../../pi-tool-mappers.js";
import type { PiToolIdentity } from "../../pi-tool-identities.js";
import type { BackendItem } from "../../../../../shared/protocol/backend.js";
import type { PiNativeHistory } from "../port.js";
import { boundText } from "../../../../conversations/payload-policy.js";
import { agentToolInvocationCorrelationSchema } from "../../../../../shared/protocol/payload.js";
import { PI_NATIVE_TOOL_MARKER, PI_NATIVE_TOOL_RESULT_MARKER, piNativeToolAuthenticationBytes,
  type PiNativeToolCall, type PiNativeToolResult } from "../tool-provenance.js";

const mapper = new PiToolSemanticMapperRegistry();
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const nativeToolKey = (assistantEntryId: string, toolCallId: string): string => `${assistantEntryId}\0${toolCallId}`;
const fingerprint = (value: unknown) => piNativeToolAuthenticationBytes("", "", value);

/** Trusted arrays come from MAC verification (disk) or the authenticated managed
 * process (live). Select their exact records from the current parent chain. */
export function selectedNativeTools(history: PiNativeHistory, branch: readonly Record<string, unknown>[]) {
  const knownCalls = new Set(history.toolCalls.map(fingerprint));
  const knownResults = new Set(history.toolResults.map(fingerprint));
  const calls = new Map<string, PiNativeToolCall>();
  const results = new Map<string, PiNativeToolResult>();
  const nestedByEntry = new Map<string, PiNativeToolCall>();
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    const data = object(entry.data);
    if (entry.customType === PI_NATIVE_TOOL_MARKER && knownCalls.has(fingerprint(data.call))) {
      const call = data.call as PiNativeToolCall;
      calls.set(nativeToolKey(call.assistantEntryId, call.toolCallId), call);
      if (call.parentToolCallId) nestedByEntry.set(String(entry.id), call);
    } else if (entry.customType === PI_NATIVE_TOOL_RESULT_MARKER && knownResults.has(fingerprint(data.result))) {
      const result = data.result as PiNativeToolResult;
      results.set(nativeToolKey(result.assistantEntryId, result.toolCallId), result);
    }
  }
  return { calls, results, nestedByEntry };
}

export function nativeToolIdentity(name: string, call?: PiNativeToolCall): PiToolIdentity {
  const source = call?.sourceInfo;
  const reviewed = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);
  if (call?.toolName === name && source?.source === "builtin" && source.path === `builtin:${name}` && reviewed.has(name)) {
    return { registrationId: `pi-native:builtin:${name}`, origin: "pi_builtin", displayName: name,
      canonicalKind: (name === "powershell" ? "bash" : name) as PiToolIdentity["canonicalKind"] };
  }
  return { registrationId: `pi-native:tool:${name}`, origin: "extension", displayName: name,
    ...(call?.managed === "mcp" ? { canonicalKind: "mcp", mcpServer: "MCP" } : {}) };
}

export function projectNativeTool(input: {
  readonly base: Pick<BackendItem, "backendItemId" | "backendTurnId" | "sourceOrder" | "startedAt" | "completedAt">;
  readonly name: string;
  readonly call?: PiNativeToolCall;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly authenticatedResult?: PiNativeToolResult;
  readonly running?: boolean;
}): BackendItem {
  const result = input.result === undefined ? undefined : object(input.result);
  const isError = result?.isError === true;
  const status = result ? (isError ? "failed" : "completed") : input.running ? "streaming" : "interrupted";
  const identity = nativeToolIdentity(input.name, input.call);
  let argumentsValue = input.arguments;
  if (identity.canonicalKind === "bash") {
    const args = object(argumentsValue);
    const timeoutMs = typeof args.timeout === "number" ? Math.floor(args.timeout * 1_000) : NaN;
    const { timeout: _timeout, ...rest } = args;
    argumentsValue = { ...rest, ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs / 1_000 } : {}) };
  } else if (identity.canonicalKind === "read") {
    const args = object(argumentsValue);
    const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1;
    const limit = typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : 1;
    if (!Number.isSafeInteger(offset + limit - 1)) {
      const { offset: _offset, limit: _limit, ...rest } = args;
      argumentsValue = rest;
    }
  }
  // Pi 1.4's `diff` is display text; only `patch` is a unified patch. Do not
  // feed its display format into the shared pure unified-diff mapper.
  const nativeResult = result && identity.canonicalKind === "edit" ? { ...result, details: { patch: object(result.details).patch } } : result;
  const item = mapper.map({ ...input.base, status, phase: status === "streaming" ? "preflight_or_executing" : status,
    identity, arguments: argumentsValue, result: nativeResult, isError });
  const attested = input.authenticatedResult;
  const call = input.call;
  if (item.semanticKind === "tool" && call?.managed === "agent" && attested && attested.toolCallId === call.toolCallId &&
      attested.assistantEntryId === call.assistantEntryId && attested.userEntryId === call.userEntryId) {
    const details = object(attested.details);
    const correlation = agentToolInvocationCorrelationSchema.safeParse(details.agentToolInvocation);
    const invocation = object(details.invocation);
    if (correlation.success && correlation.data.invocationId === invocation.invocationId) {
      const args = object(call.arguments);
      const gateway = call.toolName === "sedes_read" || call.toolName === "sedes_act";
      if (call.toolName !== "sedes_catalog" && (!gateway || (args.toolId === correlation.data.toolId && args.schemaVersion === correlation.data.schemaVersion))) {
        return { ...item, agentToolInvocation: correlation.data };
      }
    }
  }
  if (item.semanticKind === "file_change" && item.operation === "edit" && !item.diff && !item.path.truncation &&
      item.path.text.length > 0 && item.path.text !== "/dev/null" && item.path.text.trim() === item.path.text && !/[\0-\x1f\x7f]/.test(item.path.text)) {
    const edits = object(argumentsValue).edits;
    const edit = Array.isArray(edits) && edits.length === 1 ? object(edits[0]) : {};
    if (typeof edit.oldText === "string" && typeof edit.newText === "string" && edit.oldText !== edit.newText) {
      const before = boundText(edit.oldText);
      const after = boundText(edit.newText);
      if (!before.truncation && !after.truncation) return { ...item, replacement: { before, after } };
    }
  }
  return item;
}
