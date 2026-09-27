import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { backendConversationSnapshotSchema, backendHistoryPageSchema, backendItemSchema, backendTurnSchema,
  MAXIMUM_BACKEND_ITEMS_PER_TURN, type BackendConversationSnapshot, type BackendItem, type BackendTurn } from "../../../shared/protocol/backend.js";
import type { BackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES, MAXIMUM_MESSAGE_ITEM_BYTES, serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import { boundDisplayText, boundText, boundToolResult, boundValue, preserveMessageText } from "../../conversations/payload-policy.js";
import type { BackendHistoryPage, HistoryPageInput, LocateTurnInput, LocateTurnResult } from "../contracts.js";
import { turnFailure } from "../turn-failure.js";
import type { OpenCodeNativeMessage } from "./opencode-native-api.js";
import { OpenCodeHistoryError, openCodeHistoryFingerprint, openCodeHistoryLimits, type OpenCodeHistoryLimits, type OpenCodeRetainedHistory } from "./opencode-history-reader.js";

export interface OpenCodeObservedPart {
  readonly text: string;
  /** An exact native full-value ended event, not merely a stopped transport. */
  readonly completed: boolean;
}

export interface OpenCodeHistoryProjectionInput {
  /** Canonical server-derived tenant/principal/thread/backend/store/session identity. */
  readonly bindingScope: readonly string[];
  readonly generation: string;
  readonly activity: "running" | "idle" | "unknown";
  readonly backgroundActivity?: BackgroundActivity;
  readonly observedParts?: ReadonlyMap<string, OpenCodeObservedPart>;
  readonly limits?: Partial<OpenCodeHistoryLimits>;
  readonly signal?: AbortSignal;
  /** Reuse unchanged closed turns from this same scoped projection. */
  readonly previous?: OpenCodeHistoryProjection;
}

export function openCodeHistoryTurnId(sessionId: string, openingMessageId: string): string {
  return `opencode-turn:${openCodeHistoryFingerprint([sessionId, openingMessageId])}`;
}
export function openCodeHistoryItemId(messageId: string, part: string | number = "message"): string {
  return `opencode-item:${openCodeHistoryFingerprint([messageId, part])}`;
}
/** Native fragment ordinals count text and reasoning independently of content-array positions. */
export function openCodeHistoryPartKey(messageId: string, kind: "text" | "reasoning", ordinal: number): string {
  return `opencode-part:${openCodeHistoryFingerprint([messageId, kind, ordinal])}`;
}

/** A persisted full value replaces any observed prefix, including a completed empty value. */
export function openCodeNativePartEnded(
  message: Extract<OpenCodeNativeMessage, { type: "assistant" }>,
  part: Extract<Extract<OpenCodeNativeMessage, { type: "assistant" }>["content"][number], { type: "text" | "reasoning" }>,
): boolean {
  return part.text.length > 0 || message.time.streamed !== undefined ||
    (part.type === "reasoning" && part.time?.completed !== undefined) ||
    (message.time.completed !== undefined && !message.error);
}

const cursorSchema = z.strictObject({ v: z.literal(1), s: z.string().length(43), g: z.string().length(43),
  n: z.number().int().nonnegative().max(100_000), f: z.string().length(43), b: z.number().int().nonnegative().max(100_000),
  a: z.string().length(43), p: z.string().length(43) });

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OpenCodeHistoryError("cancelled");
}
function timestamp(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000) throw new OpenCodeHistoryError("invalid");
  return new Date(value).toISOString();
}
function parsed<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw new OpenCodeHistoryError("invalid"); }
}

interface CachedPeriod {
  readonly messages: readonly OpenCodeNativeMessage[];
  readonly boundary: OpenCodeNativeMessage;
  readonly turn: BackendTurn;
  readonly items: Readonly<Record<string, BackendItem>>;
  readonly bytes: number;
  readonly wholeBytes: number;
  readonly fingerprint: string;
}

function messageText(value: string) {
  try { return preserveMessageText(value); } catch { throw new OpenCodeHistoryError("turn_bytes"); }
}

/** A disposable, complete retained projection. Only bounded whole-turn selections escape it. */
export class OpenCodeHistoryProjection {
  readonly orderedBackendTurnIds: readonly string[];
  readonly turnsById: Readonly<Record<string, BackendTurn>>;
  readonly itemsById: Readonly<Record<string, BackendItem>>;
  #runState!: BackendConversationSnapshot["runState"];
  #activeBackendTurnId?: string;
  #projectedBytes = 0;
  #additionalDecodedBytes = 0;
  get runState() { return this.#runState; }
  get activeBackendTurnId() { return this.#activeBackendTurnId; }
  get decodedBytes() { return this.retained.decodedBytes + this.#projectedBytes + this.#additionalDecodedBytes; }
  readonly #scope: string;
  readonly #generation: string;
  readonly #messagePrefixes: readonly string[];
  readonly #turnPrefixes: string[];
  #backgroundActivity?: BackgroundActivity;
  readonly #turnFingerprints: string[] = [];
  readonly #dirtyTurnPrefixes = new Set<number>();
  readonly #turnBytes = new Map<string, number>();
  readonly #turnIndex = new Map<string, number>();
  readonly #periods = new Map<string, CachedPeriod>();
  readonly #partSources = new Map<string, { message: Extract<OpenCodeNativeMessage, { type: "assistant" }>; turnId: string; contentIndex: number }>();
  readonly #limits: OpenCodeHistoryLimits;

  constructor(readonly retained: OpenCodeRetainedHistory, input: OpenCodeHistoryProjectionInput) {
    const started = Date.now();
    this.#limits = openCodeHistoryLimits(input.limits);
    if (!input.generation || !input.bindingScope.length || input.bindingScope.some(value => !value)) throw new OpenCodeHistoryError("invalid");
    this.#scope = openCodeHistoryFingerprint([...input.bindingScope, retained.sessionId]);
    this.#generation = openCodeHistoryFingerprint(input.generation);
    this.#backgroundActivity = input.backgroundActivity;
    const ids: string[] = [];
    const turns: Record<string, BackendTurn> = Object.create(null);
    const items: Record<string, BackendItem> = Object.create(null);
    const messagePrefixes: string[] = [];
    const messageHash = createHash("sha256").update("opencode-history-frontier-v1\0");
    const turnPrefixes: string[] = [];

    messagePrefixes.push(messageHash.copy().digest("base64url"));
    turnPrefixes.push(openCodeHistoryFingerprint("opencode-history-turns-v2"));
    let projectedBytes = 0;
    const check = () => {
      cancelled(input.signal);
      if (Date.now() - started >= this.#limits.milliseconds) throw new OpenCodeHistoryError("time");
      if (retained.records > this.#limits.records || retained.messages.length > this.#limits.records) throw new OpenCodeHistoryError("records");
      if (retained.decodedBytes + projectedBytes > this.#limits.decodedBytes) throw new OpenCodeHistoryError("bytes");
    };
    check();
    const seen = new Set<string>();
    let period: OpenCodeNativeMessage[] = [];
    const addPeriod = (boundary?: Extract<OpenCodeNativeMessage, { type: "idle" }>) => {
      const opening = period[0] ?? boundary;
      if (!opening) return;
      const backendTurnId = openCodeHistoryTurnId(retained.sessionId, opening.id);
      const status: BackendTurn["status"] = !boundary ? "in_progress" : boundary.outcome === "succeeded" ? "completed" : boundary.outcome;
      let turn: BackendTurn;
      let selectedItems: Readonly<Record<string, BackendItem>>;
      let fingerprint: string;
      let wholeBytes: number;
      const previous = input.previous;
      const cached = boundary && previous && previous.#scope === this.#scope && previous.#generation === this.#generation
        ? previous.#periods.get(opening.id) : undefined;
      if (cached && cached.boundary === boundary && cached.messages.length === period.length &&
          cached.messages.every((message, index) => message === period[index])) {
        ({ turn, items: selectedItems, fingerprint, wholeBytes } = cached);
        projectedBytes += cached.bytes; check();
        this.#periods.set(opening.id, cached);
      } else {
        const beforeBytes = projectedBytes;
        const orderedBackendItemIds: string[] = [];
        const builtItems: Record<string, BackendItem> = Object.create(null);
        const add = (item: BackendItem) => {
          if (orderedBackendItemIds.length >= MAXIMUM_BACKEND_ITEMS_PER_TURN) throw new OpenCodeHistoryError("turn_items");
          if (items[item.backendItemId] || builtItems[item.backendItemId]) throw new OpenCodeHistoryError("invalid");
          if (serializedUtf8Bytes(item) > MAXIMUM_MESSAGE_ITEM_BYTES) throw new OpenCodeHistoryError("turn_bytes");
          const validated = parsed(backendItemSchema, item);
          projectedBytes += serializedUtf8Bytes(validated); check();
          builtItems[validated.backendItemId] = validated;
          orderedBackendItemIds.push(validated.backendItemId);
        };
        for (const message of period) {
          check();
          projectMessage(message, backendTurnId, status, input.observedParts, add, () => orderedBackendItemIds.length);
        }
        let diagnostic: string | undefined;
        for (let index = period.length - 1; index >= 0; index--) {
          const message = period[index]!;
          if (message.type === "assistant" && message.error || message.type === "compaction" && message.status === "failed") {
            diagnostic = message.error!.message; break;
          }
        }
        turn = parsed(backendTurnSchema, { backendTurnId, status, startedAt: timestamp(opening.time.created),
          ...(boundary ? { completedAt: timestamp(boundary.time.created), endedBy: status === "completed" ? "agent_settled" : status } : {}),
          ...(status === "failed" ? { failure: turnFailure(diagnostic) } : {}), orderedBackendItemIds });
        projectedBytes += serializedUtf8Bytes(turn); check();
        selectedItems = builtItems;
        const wholeTurn = { orderedBackendTurnIds: [backendTurnId], turnsById: { [backendTurnId]: turn }, itemsById: selectedItems };
        wholeBytes = serializedUtf8Bytes(wholeTurn);
        if (wholeBytes > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - 1024) throw new OpenCodeHistoryError("turn_bytes");
        fingerprint = openCodeHistoryFingerprint(wholeTurn);
        // A closed turn containing a still-mutable native record must be rebuilt.
        if (boundary && period.every(message => message.type === "assistant" ? message.time.completed !== undefined && message.content.every(part => part.type === "tool" || openCodeNativePartEnded(message, part))
          : message.type === "shell" || message.type === "compaction" ? message.status !== "running" : true)) {
          this.#periods.set(opening.id, { messages: period, boundary, turn, items: selectedItems,
            bytes: projectedBytes - beforeBytes, wholeBytes, fingerprint });
        }
      }
      for (const message of period) {
        if (message.type !== "assistant") continue;
        const ordinals = { text: 0, reasoning: 0 };
        for (const [contentIndex, part] of message.content.entries()) {
          if (part.type !== "text" && part.type !== "reasoning") continue;
          const key = openCodeHistoryPartKey(message.id, part.type, ordinals[part.type]++);
          if (!openCodeNativePartEnded(message, part)) this.#partSources.set(key, { message, turnId: backendTurnId, contentIndex });
        }
      }
      this.#turnIndex.set(backendTurnId, ids.length);
      this.#turnBytes.set(backendTurnId, wholeBytes);
      this.#turnFingerprints.push(fingerprint);
      ids.push(backendTurnId); turns[backendTurnId] = turn; Object.assign(items, selectedItems);
      turnPrefixes.push(openCodeHistoryFingerprint([turnPrefixes.at(-1), fingerprint]));
      period = [];
    };
    for (const message of retained.messages) {
      check();
      if (seen.has(message.id)) throw new OpenCodeHistoryError("invalid");
      seen.add(message.id); timestamp(message.time.created);
      messageHash.update(JSON.stringify([message.id, message.type]));
      messagePrefixes.push(messageHash.copy().digest("base64url"));
      if (message.type === "idle") addPeriod(message); else period.push(message);
    }
    addPeriod();
    this.orderedBackendTurnIds = Object.freeze(ids);
    this.turnsById = Object.freeze(turns);
    this.itemsById = items;
    this.#messagePrefixes = messagePrefixes;
    this.#turnPrefixes = turnPrefixes;
    this.#projectedBytes = projectedBytes;
    this.updateRuntimeState(input);
  }

  updateRuntimeState(input: { readonly activity?: "running" | "idle" | "unknown"; readonly backgroundActivity?: BackgroundActivity }): void {
    if (input.backgroundActivity) this.#backgroundActivity = input.backgroundActivity;
    if (input.activity === undefined) return;
    this.#runState = input.activity === "running" ? "running" : input.activity === "unknown" ? "disconnected"
      : this.turnsById[this.orderedBackendTurnIds.at(-1) ?? ""]?.status === "failed" ? "failed" : "idle";
    this.#activeBackendTurnId = input.activity === "running" && this.turnsById[this.orderedBackendTurnIds.at(-1) ?? ""]?.status === "in_progress"
      ? this.orderedBackendTurnIds.at(-1) : undefined;
  }

  /** Atomically patch only affected native assistant parts; closed history is never reparsed. */
  applyObservedParts(input: { readonly observedParts: ReadonlyMap<string, OpenCodeObservedPart>;
    readonly changedPartKeys?: ReadonlySet<string>; readonly signal?: AbortSignal; readonly additionalDecodedBytes?: number }): readonly BackendItem[] {
    cancelled(input.signal);
    const updates: BackendItem[] = [];
    const byteChanges = new Map<string, number>();
    for (const key of input.changedPartKeys ?? input.observedParts.keys()) {
      cancelled(input.signal);
      const source = this.#partSources.get(key);
      if (!source) continue;
      const { message, turnId, contentIndex } = source;
      const part = message.content[contentIndex]!;
      if (part.type !== "text" && part.type !== "reasoning") throw new OpenCodeHistoryError("invalid");
      const old = this.itemsById[openCodeHistoryItemId(message.id, contentIndex)];
      if (!old) throw new OpenCodeHistoryError("invalid");
      const item = projectAssistantTextPart(message, part, this.turnsById[turnId]!.status, input.observedParts.get(key), {
        backendItemId: old.backendItemId, backendTurnId: turnId, sourceOrder: old.sourceOrder!, startedAt: timestamp(message.time.created),
      });
      if (serializedUtf8Bytes(item) > MAXIMUM_MESSAGE_ITEM_BYTES) throw new OpenCodeHistoryError("turn_bytes");
      const value = parsed(backendItemSchema, item);
      if (JSON.stringify(old) === JSON.stringify(value)) continue;
      byteChanges.set(turnId, (byteChanges.get(turnId) ?? 0) + serializedUtf8Bytes(value) - serializedUtf8Bytes(old));
      updates.push(value);
    }
    const additional = input.additionalDecodedBytes ?? this.#additionalDecodedBytes;
    if (!Number.isSafeInteger(additional) || additional < 0) throw new OpenCodeHistoryError("invalid");
    const projectedBytes = this.#projectedBytes + [...byteChanges.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (this.retained.decodedBytes + projectedBytes + additional > this.#limits.decodedBytes) throw new OpenCodeHistoryError("bytes");
    for (const [id, bytes] of byteChanges) if (this.#turnBytes.get(id)! + bytes > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - 1024) throw new OpenCodeHistoryError("turn_bytes");
    cancelled(input.signal);
    for (const item of updates) (this.itemsById as Record<string, BackendItem>)[item.backendItemId] = item;
    this.#projectedBytes = projectedBytes; this.#additionalDecodedBytes = additional;
    for (const [id, bytes] of byteChanges) {
      this.#turnBytes.set(id, this.#turnBytes.get(id)! + bytes);
      this.#dirtyTurnPrefixes.add(this.#turnIndex.get(id)!);
    }
    return updates;
  }

  snapshot(input: { readonly limit?: number; readonly signal?: AbortSignal } = {}): { readonly snapshot: BackendConversationSnapshot; readonly previousCursor?: string } {
    const page = this.history({ limit: input.limit ?? 10, signal: input.signal });
    const { previousCursor, ...timeline } = page;
    const snapshot = parsed(backendConversationSnapshotSchema, { ...timeline, runState: this.runState,
      ...(this.activeBackendTurnId ? { activeBackendTurnId: this.activeBackendTurnId } : {}),
      ...(this.#backgroundActivity ? { backgroundActivity: this.#backgroundActivity } : {}) });
    return { snapshot, ...(previousCursor ? { previousCursor } : {}) };
  }

  history(input: HistoryPageInput): BackendHistoryPage {
    const deadline = Date.now() + this.#limits.milliseconds;
    const check = () => { cancelled(input.signal); if (Date.now() >= deadline) throw new OpenCodeHistoryError("time"); };
    check();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new OpenCodeHistoryError("invalid");
    const before = input.cursor === undefined ? this.orderedBackendTurnIds.length : this.#readCursor(input.cursor);
    let start = before;
    let selection = this.#select(start, before);
    while (start > Math.max(0, before - input.limit)) {
      check();
      const candidate = this.#select(start - 1, before);
      if (serializedUtf8Bytes(candidate) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - 1024) {
        if (start === before) throw new OpenCodeHistoryError("turn_bytes");
        break;
      }
      selection = candidate; start--;
    }
    check();
    return parsed(backendHistoryPageSchema, { ...selection, ...(start > 0 ? { previousCursor: this.#cursor(start) } : {}) });
  }

  locateTurn(input: LocateTurnInput): LocateTurnResult {
    const deadline = Date.now() + this.#limits.milliseconds;
    const check = () => { cancelled(input.signal); if (Date.now() >= deadline) throw new OpenCodeHistoryError("time"); };
    check();
    if (!Number.isSafeInteger(input.maximumTurnCandidates) || input.maximumTurnCandidates < 1) throw new OpenCodeHistoryError("invalid");
    let candidates = 0;
    for (let index = this.orderedBackendTurnIds.length - 1; index >= 0; index--) {
      check();
      if (candidates === input.maximumTurnCandidates) return { status: "search_limit_reached" };
      candidates++;
      const matches = input.matchesBackendTurnId(this.orderedBackendTurnIds[index]!);
      check();
      if (matches) {
        return { status: "found", page: parsed(backendHistoryPageSchema, this.#select(index, index + 1)) };
      }
    }
    return { status: "not_found" };
  }

  #select(start: number, before: number): BackendHistoryPage {
    const orderedBackendTurnIds = this.orderedBackendTurnIds.slice(start, before);
    const turnsById: Record<string, BackendTurn> = Object.create(null);
    const itemsById: Record<string, BackendItem> = Object.create(null);
    for (const id of orderedBackendTurnIds) {
      const turn = this.turnsById[id]!; turnsById[id] = turn;
      for (const item of turn.orderedBackendItemIds) itemsById[item] = this.itemsById[item]!;
    }
    return { orderedBackendTurnIds, turnsById, itemsById };
  }
  #refreshTurnPrefixes(before: number): void {
    let earliest = before;
    for (const index of this.#dirtyTurnPrefixes) {
      if (index >= before) continue;
      this.#turnFingerprints[index] = openCodeHistoryFingerprint(this.#select(index, index + 1));
      this.#dirtyTurnPrefixes.delete(index); earliest = Math.min(earliest, index);
    }
    for (let index = earliest; index < before; index++) {
      this.#turnPrefixes[index + 1] = openCodeHistoryFingerprint([this.#turnPrefixes[index], this.#turnFingerprints[index]]);
    }
    // Prefixes after this selection also depend on a changed earlier turn.
    if (earliest < before && before < this.orderedBackendTurnIds.length) this.#dirtyTurnPrefixes.add(before);
  }

  #cursor(before: number): string {
    this.#refreshTurnPrefixes(before);
    return Buffer.from(JSON.stringify({ v: 1, s: this.#scope, g: this.#generation, n: this.retained.messages.length,
      f: this.#messagePrefixes.at(-1), b: before, a: openCodeHistoryFingerprint(this.orderedBackendTurnIds[before] ?? null),
      p: this.#turnPrefixes[before] })).toString("base64url");
  }
  #readCursor(value: string): number {
    try {
      if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      this.#refreshTurnPrefixes(Math.min(cursor.b, this.orderedBackendTurnIds.length));
      if (cursor.s !== this.#scope || cursor.g !== this.#generation || cursor.b > this.orderedBackendTurnIds.length ||
          cursor.n > this.retained.messages.length || cursor.f !== this.#messagePrefixes[cursor.n] ||
          cursor.a !== openCodeHistoryFingerprint(this.orderedBackendTurnIds[cursor.b] ?? null) || cursor.p !== this.#turnPrefixes[cursor.b]) throw new Error();
      return cursor.b;
    } catch { throw new OpenCodeHistoryError("cursor"); }
  }
}

function projectMessage(message: OpenCodeNativeMessage, backendTurnId: string, turnStatus: BackendTurn["status"],
  observed: ReadonlyMap<string, OpenCodeObservedPart> | undefined, add: (item: BackendItem) => void, nextOrder: () => number): void {
  const base = (part: string | number = "message", status: BackendItem["status"] = "completed") => ({
    backendItemId: openCodeHistoryItemId(message.id, part), backendTurnId, status, sourceOrder: nextOrder(), startedAt: timestamp(message.time.created),
  });
  const notice = (text: string, part: string | number = "message") => add({ ...base(part), semanticKind: "notice", tone: "info", text: boundText(text) });
  const unfinishedStatus = (): BackendItem["status"] => turnStatus === "interrupted" ? "interrupted" : turnStatus === "failed" ? "failed" : "streaming";
  switch (message.type) {
    case "user": {
      const content: Extract<BackendItem, { semanticKind: "user_message" }>["content"] = [{ kind: "text", text: messageText(message.text) }];
      for (const skill of message.skills ?? []) content.push({ kind: "skill", name: boundDisplayText(skill.name) });
      for (const file of message.files ?? []) {
        if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime)) content.push({ kind: "image", omitted: true,
          mimeType: file.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          ...(file.name ? { fileName: boundDisplayText(path.basename(file.name)) } : {}) });
      }
      add({ ...base(), semanticKind: "user_message", content });
      (message.files ?? []).forEach((file, index) => {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime)) notice(`Native attachment: ${file.name ? path.basename(file.name) : file.mime} (contents unavailable)`, `file:${index}`);
      });
      (message.agents ?? []).forEach((agent, index) => notice(`Agent mention: ${agent.name}`, `agent:${index}`));
      return;
    }
    case "assistant": {
      const ordinals = { text: 0, reasoning: 0 };
      message.content.forEach((part, index) => {
        if (part.type === "text" || part.type === "reasoning") {
          const live = observed?.get(openCodeHistoryPartKey(message.id, part.type, ordinals[part.type]++));
          add(projectAssistantTextPart(message, part, turnStatus, live, base(index)));
          return;
        }
        const status: BackendItem["status"] = part.state.status === "completed" ? "completed" : part.state.status === "error" ? "failed" : unfinishedStatus();
        const phase = status === "streaming" ? part.state.status === "streaming" ? "arguments_streaming" : "preflight_or_executing" : status;
        const content = "content" in part.state ? part.state.content : undefined;
        add({ ...base(index, status), semanticKind: "tool", phase, toolName: boundDisplayText(part.name), title: boundDisplayText(part.name), category: "other",
          arguments: boundValue(part.state.input),
          ...(content ? { result: boundToolResult({ content: content.map(entry => entry.type === "text" ? entry
            : { type: "text", text: `Output file: ${entry.name ?? entry.mime} (contents unavailable)` }) }, status === "failed") } : {}),
          ...(part.state.status === "error" ? { error: { category: "rejected", message: turnFailure(part.state.error.message).message } } : {}),
        });
      });
      return;
    }
    case "shell": {
      if (message.exit !== undefined && (typeof message.exit !== "number" || !Number.isSafeInteger(message.exit))) throw new OpenCodeHistoryError("invalid");
      const exitCode = message.exit;
      const status: BackendItem["status"] = message.status === "running" ? "streaming" : message.status === "killed" ? "interrupted"
        : message.status === "timeout" || (exitCode !== undefined && exitCode !== 0) ? "failed" : "completed";
      add({ ...base("message", status), semanticKind: "command", phase: status === "streaming" ? "preflight_or_executing" : status,
        command: boundDisplayText(message.command), ...(message.output ? { output: boundText(message.output.output) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(message.time.completed !== undefined ? { completedAt: timestamp(message.time.completed) } : {}) });
      return;
    }
    case "compaction": {
      const status = message.status === "running" ? unfinishedStatus() : message.status === "completed" ? "completed" : "failed";
      add({ ...base("message", status), semanticKind: "compaction",
        ...("summary" in message && message.summary.trim() ? { summary: boundText(message.summary) } : {}),
        ...(message.status === "failed" ? { error: { category: "rejected", message: turnFailure(message.error.message).message } } : {}) });
      return;
    }
    case "agent-switched": notice(`Agent changed to ${message.agent}`); return;
    case "model-switched": notice(`Model changed to ${message.model.providerID}/${message.model.id}`); return;
    case "location-switched": notice(message.location.directory ? `Location changed to ${message.location.directory}` : "Location changed"); return;
    case "skill": notice(`Skill ${message.name}\n${message.text}`); return;
    case "system": notice(message.text); return;
    case "synthetic": notice(message.text); return;
    case "idle": return;
    default: { const unsupported: never = message; throw new OpenCodeHistoryError(unsupported); }
  }
}

function projectAssistantTextPart(
  message: Extract<OpenCodeNativeMessage, { type: "assistant" }>,
  part: Extract<Extract<OpenCodeNativeMessage, { type: "assistant" }>["content"][number], { type: "text" | "reasoning" }>,
  turnStatus: BackendTurn["status"], live: OpenCodeObservedPart | undefined,
  base: { backendItemId: string; backendTurnId: string; sourceOrder: number; startedAt: string },
): BackendItem {
  const nativeEnded = openCodeNativePartEnded(message, part);
  const ended = nativeEnded || live?.completed;
  const text = nativeEnded ? part.text : live?.text ?? "";
  const unfinished: BackendItem["status"] = turnStatus === "interrupted" ? "interrupted" : turnStatus === "failed" ? "failed" : "streaming";
  const status: BackendItem["status"] = ended ? "completed" : message.error ? (turnStatus === "interrupted" ? "interrupted" : "failed") : unfinished;
  return part.type === "text" ? { ...base, status, semanticKind: "assistant_message", markdown: messageText(text) }
    : { ...base, status, semanticKind: "reasoning", markdown: boundText(text, 65_536) };
}
