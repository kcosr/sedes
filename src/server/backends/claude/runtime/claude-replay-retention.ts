import type { ClaudePersistentEvent } from "./claude-persistent-runtime-wire.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
/** Validated JSON snapshots can have null prototypes. Provider content equality
 * concerns JSON fields, not the transport parser's object prototype. */
function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => equivalent(value, b[index]));
  if (Array.isArray(b)) return false;
  const left = record(a), right = record(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equivalent(left[key], right[key]));
}
export function replayMessage(event: ClaudePersistentEvent): RecordValue | undefined {
  return event.payload.kind === "message" ? record(event.payload.message) : undefined;
}

/** These admitted frames have no durable transcript, settings, lifecycle, or
 * consumption effect. An application ACK ends their presentation lifetime. */
export function isTransientReplay(event: ClaudePersistentEvent): boolean {
  if (event.payload.kind === "message" && event.payload.consumedTurnRootUuid) return false;
  const message = replayMessage(event);
  if (!message) return false;
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    // Neither current host nor handle treats an unstamped estimate as input
    // acceptance, lifecycle, or billed usage. Preserve unexpected stamp shapes.
    return !Object.hasOwn(message, "user_message_uuid") && !Object.hasOwn(message, "user_message_uuids");
  }
  if (["tool_progress", "tool_use_summary", "rate_limit_event"].includes(String(message.type))) return true;
  return message.type === "system" && ["task_progress", "api_retry", "informational", "hook_started", "hook_progress", "hook_response"].includes(String(message.subtype));
}

export function replayStateKey(message: RecordValue): string | undefined {
  if (message.type !== "system") return undefined;
  if (message.subtype === "status") return `status:${typeof message.permissionMode === "string" ? "permission" : "plain"}`;
  if (message.subtype === "session_state_changed") return `state:${message.state === "idle" ? "idle" : "active"}`;
  // The admitted SDK stamps one input UUID on each thinking estimate. Keep
  // that identity available without retaining every progress tick. A future
  // plural stamp is not part of this contract and remains conservative.
  if (message.subtype === "thinking_tokens" && typeof message.user_message_uuid === "string" &&
      message.user_message_uuid.length > 0 && message.user_message_uuid.length <= 512 && !Object.hasOwn(message, "user_message_uuids")) {
    return `thinking:${message.user_message_uuid}`;
  }
  return undefined;
}

type Block = { value: RecordValue; stopped: boolean; json: string };
type Group = { id: string; streams: ClaudePersistentEvent[]; complete: ClaudePersistentEvent[]; blocks: Map<number, Block>; stopped: boolean; valid: boolean };

/** Only remove a fully framed, fully acknowledged stream whose complete native
 * assistant messages exactly cover its blocks. Never synthesize SDK frames or
 * infer a block index from a complete message's ordinal position. */
export function compactedStreamSequences(replay: ReadonlyMap<number, ClaudePersistentEvent>, unacknowledged: ReadonlyMap<number, ClaudePersistentEvent>): number[] {
  const groups: Group[] = [];
  const byId = new Map<string, Group>();
  let current: Group | undefined;
  for (const event of [...replay.values()].sort((a, b) => a.sequence - b.sequence)) {
    const message = replayMessage(event);
    if (!message) continue;
    if (message.type === "assistant") {
      const id = record(message.message)?.id;
      if (typeof id === "string") byId.get(id)?.complete.push(event);
      continue;
    }
    if (message.type !== "stream_event") continue;
    const frame = record(message.event);
    if (frame?.type === "message_start") {
      const start = record(frame.message);
      if (typeof start?.id !== "string") { current = undefined; continue; }
      const previous = byId.get(start.id);
      if (previous) previous.valid = false;
      current = { id: start.id, streams: [], complete: [], blocks: new Map(), stopped: false,
        valid: !previous && Array.isArray(start.content) && start.content.length === 0 };
      groups.push(current); byId.set(start.id, current);
    }
    if (!current || !frame || current.stopped) continue;
    current.streams.push(event);
    const index = frame.index;
    if (frame.type === "content_block_start") {
      const block = record(frame.content_block);
      if (!Number.isInteger(index) || typeof index !== "number" || !block || current.blocks.has(index)) { current.valid = false; continue; }
      current.blocks.set(index, { value: { ...block }, stopped: false, json: "" });
    } else if (frame.type === "content_block_delta") {
      const block = typeof index === "number" ? current.blocks.get(index) : undefined;
      const delta = record(frame.delta);
      if (!block || block.stopped || !delta) { current.valid = false; continue; }
      if (delta.type === "text_delta" && block.value.type === "text" && typeof block.value.text === "string" && typeof delta.text === "string") block.value.text += delta.text;
      else if (delta.type === "thinking_delta" && block.value.type === "thinking" && typeof block.value.thinking === "string" && typeof delta.thinking === "string") block.value.thinking += delta.thinking;
      else if (delta.type === "signature_delta" && block.value.type === "thinking" && typeof delta.signature === "string") block.value.signature = String(block.value.signature ?? "") + delta.signature;
      else if (delta.type === "input_json_delta" && block.value.type === "tool_use" && typeof delta.partial_json === "string") block.json += delta.partial_json;
      else current.valid = false;
    } else if (frame.type === "content_block_stop") {
      const block = typeof index === "number" ? current.blocks.get(index) : undefined;
      if (!block || block.stopped) { current.valid = false; continue; }
      block.stopped = true;
      if (block.json) {
        try { block.value.input = JSON.parse(block.json); } catch { current.valid = false; }
      }
    } else if (frame.type === "message_stop") current.stopped = true;
    else if (frame.type !== "message_start" && frame.type !== "message_delta") current.valid = false;
  }
  const remove: number[] = [];
  for (const group of groups) {
    if (!group.valid || !group.stopped || !group.blocks.size || !group.complete.length ||
        [...group.streams, ...group.complete].some(event => unacknowledged.has(event.sequence))) continue;
    const complete = group.complete.flatMap(event => {
      const content = record(replayMessage(event)?.message)?.content;
      return Array.isArray(content) ? content : [];
    });
    if (complete.length !== group.blocks.size) continue;
    const blocks = [...group.blocks.values()];
    if (blocks.every(block => block.stopped && complete.filter(value => equivalent(value, block.value)).length === 1) &&
        complete.every(value => blocks.filter(block => equivalent(value, block.value)).length === 1)) remove.push(...group.streams.map(event => event.sequence));
  }
  return remove;
}

/** History cannot replace a still-retained stream's framing. Consumption
 * wrappers stay retained: native history does not carry that private receipt. */
export function historyCandidates(replay: ReadonlyMap<number, ClaudePersistentEvent>, unacknowledged: ReadonlyMap<number, ClaudePersistentEvent>): ClaudePersistentEvent[] {
  const streamingIds = new Set<string>();
  let unknownStream = false;
  let framed = false;
  for (const event of [...replay.values()].sort((a, b) => a.sequence - b.sequence)) {
    const message = replayMessage(event);
    if (message?.type !== "stream_event") continue;
    const frame = record(message.event);
    if (frame?.type === "message_start") {
      const id = record(frame.message)?.id;
      framed = typeof id === "string";
      if (framed) streamingIds.add(id as string); else unknownStream = true;
    } else if (!framed) unknownStream = true;
    if (frame?.type === "message_stop") framed = false;
  }
  if ([...replay.values()].some(event => replayMessage(event)?.type === "stream_event") && !streamingIds.size) unknownStream = true;
  return [...replay.values()].filter(event => {
    if (unacknowledged.has(event.sequence) || event.payload.kind !== "message" || event.payload.consumedTurnRootUuid) return false;
    const message = replayMessage(event);
    if (!message || typeof message.uuid !== "string" || typeof message.session_id !== "string") return false;
    // Canonical content alone cannot replay a retraction or a queued-input
    // consumption wrapper over other retained records.
    if ((Array.isArray(message.supersedes) && message.supersedes.length > 0) || message.priority === "next") return false;
    if (message.type === "user") return true;
    return message.type === "assistant" && !unknownStream && !streamingIds.has(String(record(message.message)?.id));
  });
}

export function historyCovers(candidate: ClaudePersistentEvent, history: unknown): boolean {
  const live = replayMessage(candidate), persisted = record(history);
  return !!live && !!persisted && live.type === persisted.type && live.uuid === persisted.uuid &&
    live.session_id === persisted.session_id && (live.parent_tool_use_id ?? null) === (persisted.parent_tool_use_id ?? null) &&
    (live.parent_agent_id ?? null) === (persisted.parent_agent_id ?? null) &&
    (live.type === "assistant" ? assistantHistoryCovers(live.message, persisted.message) : equivalent(live.message, persisted.message));
}

function assistantHistoryCovers(live: unknown, persisted: unknown): boolean {
  const emitted = record(live), canonical = record(persisted);
  if (!emitted || !canonical) return false;
  // The SDK emits completed blocks before finalizing usage and stop_reason.
  // Candidates are already ACKed: accounting consumed the exact original, and
  // uncommitted accounting originals never reach this comparison. History may
  // finalize a null reason, but cannot replace an already-known reason. All
  // content and remaining metadata, including unknown fields, stay exact.
  const { usage: _emittedUsage, ...emittedContent } = emitted;
  const { usage: _canonicalUsage, ...canonicalContent } = canonical;
  if (emittedContent.stop_reason === null && typeof canonicalContent.stop_reason === "string") {
    emittedContent.stop_reason = canonicalContent.stop_reason;
  }
  return equivalent(emittedContent, canonicalContent);
}
