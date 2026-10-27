import { createHash } from "node:crypto";
import type { PiNativeHistory } from "../port.js";
import { BackendError, type BackendHistoryPage, type HistoryPageInput, type LocateTurnInput, type LocateTurnResult } from "../../../contracts.js";
import { backendItemSchema, type BackendConversationSnapshot, type BackendItem, type BackendTurn } from "../../../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../../../shared/protocol/conversation.js";
import { boundDisplayText, boundText, preserveMessageText } from "../../../../conversations/payload-policy.js";
import { selectPiHistoryPage, selectPiProjectionWindow } from "../../pi-timeline-window.js";
import { turnFailure } from "../../../turn-failure.js";
import { parsePiNativeEntry } from "../rpc/pi-rpc-wire.js";
import { contextExcerptArraySchema } from "../../../../../shared/protocol/context-excerpts.js";
import { materializedTaskContextsSchema, presentMessageTaskContext } from "../../../../domain/materialized-task-contexts.js";
import { composerAttachmentDescriptorSchema } from "../../../../../shared/protocol/composer-attachments.js";
import { PI_MANAGED_INPUT_MARKER, type PiManagedOperation } from "../rpc/pi-managed-protocol.js";
import { nativeToolIdentity, nativeToolKey, projectNativeTool, selectedNativeTools } from "./tool-projection.js";
import { PI_NATIVE_TOOL_RESULT_MARKER, type PiNativeToolCall } from "../tool-provenance.js";
import type { NormalizedImage } from "../../../../../shared/protocol/output-artifacts.js";
import type { ConversationBinding } from "../../../contracts.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES, OUTPUT_IMAGE_MEDIA_TYPES, type OutputArtifactPublisher, type OutputImageMediaType } from "../../../../output-artifacts/contracts.js";
import { inspectSupportedRasterImage } from "../../../../images/raster-image-inspector.js";

export interface NativeInputEvidence {
  readonly operationId: string;
  readonly userEntryId?: string;
  readonly targetTurnId?: string;
  readonly mode: "submit" | "steer";
  readonly phase: string;
  readonly presentation?: unknown;
}
export interface NativeHistoryProjection {
  readonly snapshot: BackendConversationSnapshot;
  readonly usage: UsageSnapshot;
  readonly leafByTurn: ReadonlyMap<string, string>;
  readonly revision: string;
}
export function inputEvidence(operations: readonly PiManagedOperation[]): readonly NativeInputEvidence[] {
  return operations.map(operation => ({ operationId: operation.input.operationId, mode: operation.input.mode,
    phase: operation.phase, userEntryId: operation.userEntryId, targetTurnId: operation.targetTurnId,
    presentation: operation.input.presentation }));
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function invalid(): never {
  throw new BackendError({ category: "incompatible_protocol", retryable: false, crossedSubmissionBoundary: false,
    safeMessage: "Pi returned inconsistent native history.", backendCode: "pi_native_history_invalid" });
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Read only the authoritative parent chain. Entries from abandoned branches never leak into it. */
export function nativeBranch(history: PiNativeHistory): readonly Record<string, unknown>[] {
  if (history.entries.length > 250_000) invalid();
  const entries = new Map<string, Record<string, unknown>>();
  for (const raw of history.entries) {
    const candidate = parsePiNativeEntry(raw);
    const id = string(candidate.id);
    if (!id || id.length > 512 || entries.has(id) || typeof candidate.type !== "string") invalid();
    entries.set(id, candidate);
  }
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let id = history.leafId;
  while (id !== null) {
    if (visited.has(id)) invalid();
    visited.add(id);
    const entry = entries.get(id);
    if (!entry || !(entry.parentId === null || typeof entry.parentId === "string")) invalid();
    branch.push(entry);
    id = entry.parentId as string | null;
  }
  return branch.reverse();
}

function blocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.map(object) : [];
}

export function nativeImageKey(sessionId: string, entryId: string, index: number): string {
  return `pi-native-image:${createHash("sha256").update(JSON.stringify([sessionId, entryId, index])).digest("hex")}`;
}

/** Publish only exact bytes already present in the selected native history.
 * Paths in tool arguments/results never authorize reading a host file. */
export async function publishNativeHistoryArtifacts(history: PiNativeHistory,
  binding: Pick<ConversationBinding, "tenantId" | "ownerPrincipalId" | "applicationThreadId">,
  publisher?: OutputArtifactPublisher): Promise<ReadonlyMap<string, NormalizedImage>> {
  const images = new Map<string, NormalizedImage>();
  const branch = nativeBranch(history);
  const tools = selectedNativeTools(history, branch);
  const scope = { tenantId: binding.tenantId, principalId: binding.ownerPrincipalId };
  for (const entry of branch) {
    const message = object(entry.message);
    let content: unknown;
    if (entry.type === "message" && (message.role === "assistant" || message.role === "toolResult")) content = message.content;
    else if (entry.type === "custom" && entry.customType === PI_NATIVE_TOOL_RESULT_MARKER) {
      const raw = object(object(entry.data).result);
      const key = nativeToolKey(String(raw.assistantEntryId), String(raw.toolCallId));
      if (tools.calls.get(key)?.parentToolCallId) content = tools.results.get(key)?.content;
    }
    for (const [index, block] of blocks(content).entries()) {
      if (block.type !== "image") continue;
      const key = nativeImageKey(history.sessionId, String(entry.id), index);
      if (!OUTPUT_IMAGE_MEDIA_TYPES.includes(block.mimeType as OutputImageMediaType)) { images.set(key, { representation: "omitted", reason: "unsupported_mime" }); continue; }
      const mediaType = block.mimeType as OutputImageMediaType;
      const omitted = (reason: "byte_limit" | "invalid_data") => images.set(key, { representation: "omitted", mimeType: mediaType, reason });
      if (typeof block.data !== "string" || block.data.length === 0) { omitted("invalid_data"); continue; }
      if (block.data.length > Math.ceil(MAXIMUM_OUTPUT_IMAGE_BYTES / 3) * 4) { omitted("byte_limit"); continue; }
      if (block.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(block.data)) { omitted("invalid_data"); continue; }
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== block.data) { omitted("invalid_data"); continue; }
      if (bytes.length > MAXIMUM_OUTPUT_IMAGE_BYTES) { omitted("byte_limit"); continue; }
      if (inspectSupportedRasterImage(bytes)?.mediaType !== mediaType) { omitted("invalid_data"); continue; }
      if (!publisher) continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        const descriptor = publisher.findImage(scope, binding.applicationThreadId, key) ?? await publisher.publishImage({ scope,
          threadId: binding.applicationThreadId, publicationKey: key, mediaType, bytes, expectedByteSize: bytes.length, expectedSha256: sha256 });
        if (descriptor.sha256 !== sha256 || descriptor.byteSize !== bytes.length || descriptor.mediaType !== mediaType) { omitted("invalid_data"); continue; }
        images.set(key, { representation: "artifact", artifactId: descriptor.artifactId, mimeType: descriptor.mediaType, byteSize: descriptor.byteSize, sha256: descriptor.sha256 });
      } catch { /* A later refresh may publish the new child; never mutate an omitted terminal item. */ }
    }
  }
  return images;
}

/** Independent Pi 1.x projection. No SDK 0.86 parser, manager, or event assumptions. */
export function projectNativeHistory(history: PiNativeHistory, options: {
  readonly running?: boolean;
  readonly operations?: readonly NativeInputEvidence[];
  readonly images?: ReadonlyMap<string, NormalizedImage>;
} = {}): NativeHistoryProjection {
  const branch = nativeBranch(history);
  const tools = selectedNativeTools(history, branch);
  const directResults = new Map<string, { entry: Record<string, unknown>; message: Record<string, unknown> }>();
  const resultKeysByEntry = new Map<string, string>();
  const latestCalls = new Map<string, { key: string; name: string }>();
  for (const entry of branch) {
    const message = object(entry.message);
    if (entry.type !== "message") continue;
    if (message.role === "assistant") for (const block of blocks(message.content)) {
      if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") latestCalls.set(block.id, { key: nativeToolKey(String(entry.id), block.id), name: block.name });
    }
    if (message.role === "toolResult") {
      const call = latestCalls.get(String(message.toolCallId));
      if (call && call.name === message.toolName) { directResults.set(call.key, { entry, message }); resultKeysByEntry.set(String(entry.id), call.key); latestCalls.delete(String(message.toolCallId)); }
    }
  }
  const snapshot: BackendConversationSnapshot = { orderedBackendTurnIds: [], turnsById: {}, itemsById: {}, runState: options.running ? "running" : "idle" };
  const turns: Record<string, BackendTurn> = {};
  const items: Record<string, BackendItem> = {};
  const ordered: string[] = [];
  const leafByTurn = new Map<string, string>();
  const evidence = new Map<string, NativeInputEvidence>();
  for (const operation of options.operations ?? inputEvidence(history.operations)) {
    if (!operation.userEntryId || operation.phase !== "accepted") continue;
    if (evidence.has(operation.userEntryId)) invalid();
    evidence.set(operation.userEntryId, operation);
  }
  let activeRoot: string | undefined;
  for (const entry of branch) if (entry.type === "message" && object(entry.message).role === "user") {
    const operation = evidence.get(String(entry.id));
    if (operation?.mode !== "steer" || operation.targetTurnId !== activeRoot) activeRoot = String(entry.id);
  }
  let turn: BackendTurn | undefined;
  let order = 0;
  let terminalReason: string | undefined;
  let lastTime: string | undefined;
  let failure: string | undefined;
  const pendingTools = new Set<string>();
  const counters = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, compactions: 0 };
  const finish = (running: boolean) => {
    if (!turn) return;
    const status = running ? "in_progress" : terminalReason === "error" ? "failed" : terminalReason === "aborted" ? "interrupted"
      : terminalReason === "stop" || terminalReason === "length" ? "completed" : "interrupted";
    turns[turn.backendTurnId] = { ...turn, status,
      ...(status === "in_progress" ? {} : { endedBy: status === "completed" ? "agent_settled" as const : status === "failed" ? "failed" as const : "interrupted" as const }),
      ...(status === "failed" ? { failure: turnFailure(failure) } : {}),
      ...(!running && lastTime ? { completedAt: lastTime } : {}) };
  };
  const add = (entry: Record<string, unknown>, content: Record<string, unknown>, suffix: string) => {
    if (!turn) return;
    const item = backendItemSchema.parse({ backendItemId: `${entry.id}:${suffix}`, backendTurnId: turn.backendTurnId,
      sourceOrder: order++, status: "completed", ...(timestamp(entry.timestamp) ? { startedAt: timestamp(entry.timestamp), completedAt: timestamp(entry.timestamp) } : {}), ...content });
    items[item.backendItemId] = item;
    turn = { ...turn, orderedBackendItemIds: [...turn.orderedBackendItemIds, item.backendItemId] };
    turns[turn.backendTurnId] = turn;
  };
  const addTool = (entry: Record<string, unknown>, name: string, argumentsValue: unknown, suffix: string, call?: PiNativeToolCall,
    result?: Record<string, unknown>, completedAt?: string) => {
    if (!turn) return;
    const base = { backendItemId: `${entry.id}:${suffix}`, backendTurnId: turn.backendTurnId, sourceOrder: order,
      ...(timestamp(entry.timestamp) ? { startedAt: timestamp(entry.timestamp) } : {}), ...(completedAt ? { completedAt } : {}) };
    const item = projectNativeTool({ base, name, arguments: argumentsValue, call, result, running: options.running && turn.backendTurnId === activeRoot,
      ...(call ? { authenticatedResult: tools.results.get(nativeToolKey(call.assistantEntryId, call.toolCallId)) } : {}) });
    add(entry, item, suffix);
    if (!result) pendingTools.add(item.backendItemId);
  };
  const addImages = (entry: Record<string, unknown>, content: unknown, call?: PiNativeToolCall) => {
    const viewed = call && nativeToolIdentity(call.toolName, call).canonicalKind === "read";
    for (const [index, block] of blocks(content).entries()) {
      if (block.type !== "image") continue;
      if (viewed) {
        const fileName = string(object(call.arguments).path)?.split(/[\\/]/).at(-1);
        add(entry, { semanticKind: "viewed_image", ...(fileName ? { fileName: boundDisplayText(fileName) } : {}) }, `viewed:${index}`);
      }
      const image = options.images?.get(nativeImageKey(history.sessionId, String(entry.id), index));
      if (image) add(entry, { semanticKind: "image", origin: viewed ? { kind: "viewed", capture: "provider_input" } : { kind: "shown" }, image }, `image:${index}`);
      else order++;
    }
  };
  for (const [entryIndex, entry] of branch.entries()) {
    // Reserve stable per-entry positions so delayed tool attestations and image
    // publication cannot renumber items already streamed to the browser.
    order = entryIndex * 1_000_000;
    const message = object(entry.message);
    if ((entry.type === "message" && message.role !== "user") || entry.type === "compaction") lastTime = timestamp(entry.timestamp) ?? lastTime;
    if (entry.type === "message") counters.totalMessages++;
    if (entry.type === "message" && message.role === "user") {
      counters.userMessages++;
      const operation = evidence.get(String(entry.id));
      const steer = operation?.mode === "steer" && operation.targetTurnId === turn?.backendTurnId;
      if (!steer) {
        finish(false);
        terminalReason = undefined;
        failure = undefined;
        turn = { backendTurnId: String(entry.id), status: "in_progress", orderedBackendItemIds: [], ...(timestamp(entry.timestamp) ? { startedAt: timestamp(entry.timestamp) } : {}) };
        ordered.push(turn.backendTurnId);
      }
      lastTime = timestamp(entry.timestamp) ?? lastTime;
      if (operation && turn) turn = { ...turn, completionCorrelations: [...(turn.completionCorrelations ?? []), operation.operationId] };
      let content: unknown[] = blocks(message.content).flatMap<unknown>((block) => block.type === "text" && typeof block.text === "string"
        ? [{ kind: "text", text: preserveMessageText(block.text) }]
        : block.type === "image" ? [{ kind: "image", omitted: true }] : []);
      const presentation = object(operation?.presentation);
      if (operation && typeof presentation.text === "string") {
        content = [{ kind: "text", text: preserveMessageText(presentation.text) }];
        for (const excerpt of contextExcerptArraySchema.parse(presentation.contextExcerpts ?? [])) content.push({ kind: "context_excerpt", excerpt });
        for (const task of materializedTaskContextsSchema.parse(presentation.taskContexts ?? [])) content.push({ kind: "task_context", task: presentMessageTaskContext(task) });
        for (const attachment of Array.isArray(presentation.attachments) ? presentation.attachments : []) content.push({ kind: "attachment", attachment: composerAttachmentDescriptorSchema.parse(attachment) });
      }
      if (content.length === 0) content.push({ kind: "text", text: preserveMessageText("") });
      add(entry, { semanticKind: "user_message", content, ...(operation ? { deliveryOperationId: operation.operationId } : {}) }, "user");
    } else if (entry.type === "message" && message.role === "assistant") {
      counters.assistantMessages++;
      terminalReason = string(message.stopReason);
      failure = string(message.errorMessage);
      for (const [index, block] of blocks(message.content).entries()) {
        if (block.type === "text" && typeof block.text === "string") add(entry, { semanticKind: "assistant_message", markdown: preserveMessageText(block.text), responsePhase: terminalReason === "stop" || terminalReason === "length" ? "final" : "provisional" }, `text:${index}`);
        else if (block.type === "thinking" && typeof block.thinking === "string") add(entry, { semanticKind: "reasoning", markdown: boundText(block.thinking) }, `thinking:${index}`);
        else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          counters.toolCalls++;
          const key = nativeToolKey(String(entry.id), block.id);
          const call = tools.calls.get(key);
          const result = directResults.get(key);
          if (!call && !result && options.running && turn?.backendTurnId === activeRoot) { order++; continue; }
          addTool(entry, block.name, call?.arguments ?? block.arguments, `tool:${index}`, call, result?.message, timestamp(result?.entry.timestamp));
        } else if (block.type === "image") {
          const image = options.images?.get(nativeImageKey(history.sessionId, String(entry.id), index));
          if (image) add(entry, { semanticKind: "image", origin: { kind: "generated" }, image }, `image:${index}`);
          else order++;
        }
      }
    } else if (entry.type === "message" && message.role === "toolResult") {
      counters.toolResults++;
      const key = resultKeysByEntry.get(String(entry.id));
      addImages(entry, message.content, key ? tools.calls.get(key) : undefined);
    } else if (tools.nestedByEntry.has(String(entry.id))) {
      const call = tools.nestedByEntry.get(String(entry.id))!;
      const result = tools.results.get(nativeToolKey(call.assistantEntryId, call.toolCallId));
      counters.toolCalls++;
      addTool(entry, call.toolName, call.arguments, "tool", call, result as Record<string, unknown> | undefined);
    } else if (entry.type === "custom" && entry.customType === PI_NATIVE_TOOL_RESULT_MARKER) {
      const raw = object(object(entry.data).result);
      const key = nativeToolKey(String(raw.assistantEntryId), String(raw.toolCallId));
      const result = tools.results.get(key);
      const call = tools.calls.get(key);
      if (result && call?.parentToolCallId) { counters.toolResults++; addImages(entry, result.content, call); }
    } else if (entry.type === "compaction") {
      counters.compactions++;
      add(entry, { semanticKind: "compaction", ...(typeof entry.summary === "string" && entry.summary.trim() ? { summary: boundText(entry.summary) } : {}) }, "compaction");
    }
    // Settings and a future submission's signed intent may already be appended
    // before its user message. They do not belong to the completed turn's fork
    // checkpoint. Include only turn content and its authenticated acceptance.
    const recordedOperation = entry.type === "custom" && entry.customType === PI_MANAGED_INPUT_MARKER ? object(object(entry.data).operation) : undefined;
    const acceptance = recordedOperation?.phase === "accepted" && typeof recordedOperation.userEntryId === "string" ? evidence.get(recordedOperation.userEntryId) : undefined;
    const ownAcceptance = acceptance && turn && acceptance.operationId === object(recordedOperation?.input).operationId &&
      (recordedOperation?.userEntryId === turn.backendTurnId || (acceptance.mode === "steer" && acceptance.targetTurnId === turn.backendTurnId));
    if (turn && (entry.type === "message" || entry.type === "compaction" || ownAcceptance)) leafByTurn.set(turn.backendTurnId, String(entry.id));
  }
  finish(options.running === true);
  const activeTurn = options.running ? turn?.backendTurnId : undefined;
  if (activeTurn) for (const itemId of pendingTools) {
    const item = items[itemId];
    if (item && "phase" in item && item.backendTurnId === activeTurn) {
      const { completedAt: _completedAt, ...active } = item;
      items[itemId] = { ...active, status: "streaming", phase: "preflight_or_executing" };
    }
  }
  return { snapshot: { ...snapshot, orderedBackendTurnIds: ordered, turnsById: turns, itemsById: items,
    ...(!options.running && turn && turns[turn.backendTurnId]?.status === "failed" ? { runState: "failed" as const } : {}),
    ...(activeTurn ? { activeBackendTurnId: activeTurn } : {}) }, usage: { counters }, leafByTurn,
    revision: createHash("sha256").update(JSON.stringify([history.sessionId, history.leafId, branch, options.operations ?? history.operations,
      history.toolCalls, history.toolResults, options.images ? [...options.images] : [], options.running === true])).digest("hex") };
}

export function projectionWindow(projection: NativeHistoryProjection, sessionId: string) {
  return selectPiProjectionWindow(projection.snapshot, 100, `${sessionId}:${projection.revision}`);
}
export function historyPage(projection: NativeHistoryProjection, sessionId: string, input: HistoryPageInput): BackendHistoryPage {
  input.signal?.throwIfAborted();
  const identity = `${sessionId}:${projection.revision}`;
  let before = projection.snapshot.orderedBackendTurnIds.length;
  if (input.cursor !== undefined) {
    const prefix = `pi-history:${encodeURIComponent(identity)}:`;
    if (!input.cursor.startsWith(prefix) || !/^\d+$/.test(input.cursor.slice(prefix.length))) invalid();
    before = Number(input.cursor.slice(prefix.length));
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || before < 0 || before > projection.snapshot.orderedBackendTurnIds.length) invalid();
  return selectPiHistoryPage(projection.snapshot, identity, before, input.limit);
}
export function locateHistory(projection: NativeHistoryProjection, input: LocateTurnInput): LocateTurnResult {
  input.signal?.throwIfAborted();
  if (!Number.isSafeInteger(input.maximumTurnCandidates) || input.maximumTurnCandidates < 1) invalid();
  const ids = projection.snapshot.orderedBackendTurnIds;
  let examined = 0;
  for (let index = ids.length - 1; index >= 0; index--) {
    input.signal?.throwIfAborted();
    if (examined++ >= input.maximumTurnCandidates) return { status: "search_limit_reached" };
    const id = ids[index]!;
    if (!input.matchesBackendTurnId(id)) continue;
    const turn = projection.snapshot.turnsById[id]!;
    return { status: "found", page: { orderedBackendTurnIds: [id], turnsById: { [id]: turn }, itemsById: Object.fromEntries(turn.orderedBackendItemIds.map(itemId => [itemId, projection.snapshot.itemsById[itemId]!])) } };
  }
  return { status: "not_found" };
}
