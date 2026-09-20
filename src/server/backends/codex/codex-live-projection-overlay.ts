import { performance } from "node:perf_hooks";
import {
  MAXIMUM_MESSAGE_TEXT_BYTES,
  PAYLOAD_LIMITS,
  serializedUtf8Bytes,
} from "../../../shared/protocol/payload.js";
import { DEFAULT_PAYLOAD_LIMITS } from "../../conversations/payload-policy.js";
import type { CodexThreadItem } from "./codex-c1-protocol.js";
import {
  CODEX_C2_MAX_COLLECTION_ITEMS,
  CODEX_C2_MAX_TEXT_BYTES,
} from "./codex-c2-protocol.js";
import type { CodexProjectedItemCoordinate } from "./codex-history-projector.js";

export interface CodexLiveProjectionClock {
  now(): number;
}

export interface CodexLiveProjectionScheduledTask {
  cancel(): void;
}

export interface CodexLiveProjectionScheduler {
  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): CodexLiveProjectionScheduledTask;
}

export interface CodexLiveProjectionSeed {
  readonly item: CodexThreadItem;
  readonly coordinate: CodexProjectedItemCoordinate;
}

export interface CodexLiveProjectionFlushItem {
  readonly nativeTurnId: string;
  readonly nativeItemId: string;
  readonly item: CodexThreadItem;
  readonly coordinate: CodexProjectedItemCoordinate;
}

export interface CodexLiveProjectionOverlayOptions {
  readonly intervalMilliseconds: number;
  readonly onFlush: (
    items: readonly CodexLiveProjectionFlushItem[],
  ) => ReadonlySet<string> | false;
  readonly onInvalid: () => void;
  readonly enqueue?: (operation: () => void) => void;
  readonly clock?: CodexLiveProjectionClock;
  readonly scheduler?: CodexLiveProjectionScheduler;
}

type TextProgress = {
  readonly preserveFullText: boolean;
  prefix: string;
  chunks: string[];
  logicalCodeUnits: number;
  logicalUtf8Bytes: number;
  logicalTrailingHighSurrogate: boolean;
  retainedUtf8Bytes: number;
  retainedTrailingHighSurrogate: boolean;
};

type ReasoningProgress = {
  readonly summary: TextProgress[];
  readonly content: TextProgress[];
};

type LiveEntry = {
  readonly coordinate: CodexProjectedItemCoordinate;
  readonly seed: CodexThreadItem;
  readonly progress:
    | { readonly kind: "agent"; readonly text: TextProgress }
    | { readonly kind: "plan"; readonly text: TextProgress }
    | {
        readonly kind: "command";
        readonly text: TextProgress;
        hasOutput: boolean;
      }
    | { readonly kind: "reasoning"; readonly reasoning: ReasoningProgress }
    | {
        readonly kind: "file";
        changes: Extract<
          CodexThreadItem,
          { readonly type: "fileChange" }
        >["changes"];
      }
    | {
        readonly kind: "mcp";
        readonly messages: TextProgress[];
        logicalCodeUnits: number;
        logicalUtf8Bytes: number;
      };
  dirty: boolean;
  dirtySequence: number;
  lastProjectedAt: number;
  acceptedLogicalCodeUnits: number;
  acceptedLogicalUtf8Bytes: number;
};

const RETAINED_TEXT_UTF8_BYTES = DEFAULT_PAYLOAD_LIMITS.maximumStringBytes + 8;
const MAXIMUM_RETAINED_TEXT_UTF8_BYTES = RETAINED_TEXT_UTF8_BYTES + 1;
const RETAINED_MCP_CONTENT_PARTS = PAYLOAD_LIMITS.toolResultParts + 1;
const MAXIMUM_REASONING_PARTS = 1_000;
const MAXIMUM_OVERLAY_LOGICAL_CODE_UNITS = CODEX_C2_MAX_TEXT_BYTES;
const MAXIMUM_OVERLAY_UTF8_BYTES = MAXIMUM_MESSAGE_TEXT_BYTES;

const defaultClock: CodexLiveProjectionClock = {
  now: () => performance.now(),
};

const defaultScheduler: CodexLiveProjectionScheduler = {
  schedule(delayMilliseconds, callback) {
    const timer = setTimeout(callback, delayMilliseconds);
    timer.unref?.();
    return {
      cancel() {
        clearTimeout(timer);
      },
    };
  },
};

export class CodexLiveProjectionOverlay {
  readonly #intervalMilliseconds: number;
  readonly #onFlush: CodexLiveProjectionOverlayOptions["onFlush"];
  readonly #onInvalid: CodexLiveProjectionOverlayOptions["onInvalid"];
  readonly #enqueue: (operation: () => void) => void;
  readonly #clock: CodexLiveProjectionClock;
  readonly #scheduler: CodexLiveProjectionScheduler;
  readonly #entries = new Map<string, LiveEntry>();
  #generation = 0;
  #installEpoch = 0;
  #disposalEpoch = 0;
  #nextDirtySequence = 0;
  #task: CodexLiveProjectionScheduledTask | undefined;
  #taskDueAt: number | undefined;
  #logicalCodeUnits = 0;
  #logicalBytes = 0;
  #retainedBytes = 0;
  #invalidated = true;

  constructor(options: CodexLiveProjectionOverlayOptions) {
    if (
      !Number.isSafeInteger(options.intervalMilliseconds) ||
      options.intervalMilliseconds <= 0
    ) {
      throw new Error("codex_live_projection_interval_invalid");
    }
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#onFlush = options.onFlush;
    this.#onInvalid = options.onInvalid;
    this.#enqueue = options.enqueue ?? ((operation) => operation());
    this.#clock = options.clock ?? defaultClock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  reset(input: {
    readonly generation: number;
    readonly installEpoch: number;
    readonly seeds: readonly CodexLiveProjectionSeed[];
  }): void {
    this.#cancelTask();
    const priorEntries =
      input.generation === this.#generation
        ? new Map(this.#entries)
        : new Map<string, LiveEntry>();
    this.#entries.clear();
    this.#generation = input.generation;
    this.#installEpoch = input.installEpoch;
    this.#disposalEpoch += 1;
    this.#nextDirtySequence = 0;
    this.#logicalCodeUnits = 0;
    this.#logicalBytes = 0;
    this.#retainedBytes = 0;
    this.#invalidated = false;
    const now = this.#clock.now();
    for (const seed of input.seeds) {
      const entry = createEntry(seed, now - this.#intervalMilliseconds);
      if (!entry || this.#entries.has(coordinateKey(seed.coordinate))) {
        this.#fail();
        return;
      }
      const prior = priorEntries.get(coordinateKey(seed.coordinate));
      if (prior && sameOverlayCoordinate(prior, entry)) {
        carryAcceptedLifetime(prior, entry);
      }
      this.#entries.set(coordinateKey(seed.coordinate), entry);
      this.#logicalCodeUnits += entry.acceptedLogicalCodeUnits;
      this.#logicalBytes += entry.acceptedLogicalUtf8Bytes;
      this.#retainedBytes += entryRetainedBytes(entry);
    }
    if (!this.#withinBounds()) this.#fail();
  }

  dispose(): void {
    this.#cancelTask();
    this.#entries.clear();
    this.#logicalCodeUnits = 0;
    this.#logicalBytes = 0;
    this.#retainedBytes = 0;
    this.#invalidated = true;
    this.#disposalEpoch += 1;
  }

  remove(nativeTurnId: string, nativeItemId: string): void {
    const key = coordinateKey({ nativeTurnId, nativeItemId });
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#logicalCodeUnits -= entry.acceptedLogicalCodeUnits;
    this.#logicalBytes -= entry.acceptedLogicalUtf8Bytes;
    this.#retainedBytes -= entryRetainedBytes(entry);
    this.#reschedule();
  }

  removeTurn(nativeTurnId: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.coordinate.nativeTurnId !== nativeTurnId) continue;
      this.remove(entry.coordinate.nativeTurnId, entry.coordinate.nativeItemId);
    }
  }

  materializedItems(): readonly CodexLiveProjectionFlushItem[] {
    return [...this.#entries.values()].map((entry) => ({
      nativeTurnId: entry.coordinate.nativeTurnId,
      nativeItemId: entry.coordinate.nativeItemId,
      coordinate: entry.coordinate,
      item: materializeEntry(entry),
    }));
  }

  appendText(
    nativeTurnId: string,
    nativeItemId: string,
    itemType: "agentMessage" | "plan" | "commandExecution",
    delta: string,
  ): boolean {
    const entry = this.#entry(nativeTurnId, nativeItemId);
    if (!entry) return false;
    const progress = entry.progress;
    const text =
      itemType === "agentMessage" && progress.kind === "agent"
        ? progress.text
        : itemType === "plan" && progress.kind === "plan"
          ? progress.text
          : itemType === "commandExecution" && progress.kind === "command"
            ? progress.text
            : undefined;
    if (!text) return false;
    const outputStarted = progress.kind === "command" && !progress.hasOutput;
    if (outputStarted) progress.hasOutput = true;
    const appended = this.#append(entry, text, delta);
    if (appended === false) return false;
    if (appended === "visible" || outputStarted) this.#markDirty(entry);
    return true;
  }

  addReasoningSummaryPart(
    nativeTurnId: string,
    nativeItemId: string,
    index: number,
  ): boolean {
    const reasoning = this.#reasoning(nativeTurnId, nativeItemId);
    if (!reasoning || !validReasoningIndex(index)) return false;
    const entry = reasoning.entry;
    const before = entryRetainedBytes(entry);
    ensureTextProgress(reasoning.progress.summary, index);
    this.#retainedBytes += entryRetainedBytes(entry) - before;
    if (!this.#withinBounds()) return this.#failAndReturnFalse();
    return true;
  }

  appendReasoningSummary(
    nativeTurnId: string,
    nativeItemId: string,
    index: number,
    delta: string,
  ): boolean {
    const reasoning = this.#reasoning(nativeTurnId, nativeItemId);
    if (!reasoning || !validReasoningIndex(index)) return false;
    const progress = ensureTextProgress(reasoning.progress.summary, index);
    const appended = this.#append(reasoning.entry, progress, delta);
    if (appended === false) return false;
    if (appended === "visible") this.#markDirty(reasoning.entry);
    return true;
  }

  appendReasoningContent(
    nativeTurnId: string,
    nativeItemId: string,
    index: number,
    delta: string,
  ): boolean {
    const reasoning = this.#reasoning(nativeTurnId, nativeItemId);
    if (!reasoning || !validReasoningIndex(index)) return false;
    const progress = ensureTextProgress(reasoning.progress.content, index);
    const appended = this.#append(reasoning.entry, progress, delta);
    if (appended === false) return false;
    if (appended === "visible") this.#markDirty(reasoning.entry);
    return true;
  }

  replaceFileChanges(
    nativeTurnId: string,
    nativeItemId: string,
    changes: Extract<
      CodexThreadItem,
      { readonly type: "fileChange" }
    >["changes"],
  ): boolean {
    const entry = this.#entry(nativeTurnId, nativeItemId);
    if (!entry || entry.progress.kind !== "file") return false;
    if (JSON.stringify(entry.progress.changes) === JSON.stringify(changes)) {
      return true;
    }
    const priorBytes = entryRetainedBytes(entry);
    const priorLogical = entry.acceptedLogicalCodeUnits;
    const priorLogicalBytes = entry.acceptedLogicalUtf8Bytes;
    entry.progress.changes = changes;
    const nextBytes = entryRetainedBytes(entry);
    const nextLogical = entryLogicalCodeUnits(entry);
    const nextLogicalBytes = entryLogicalBytes(entry);
    entry.acceptedLogicalCodeUnits = nextLogical;
    entry.acceptedLogicalUtf8Bytes = nextLogicalBytes;
    this.#retainedBytes += nextBytes - priorBytes;
    this.#logicalCodeUnits += nextLogical - priorLogical;
    this.#logicalBytes += nextLogicalBytes - priorLogicalBytes;
    if (!this.#withinBounds()) return this.#failAndReturnFalse();
    this.#markDirty(entry);
    return true;
  }

  appendMcpProgress(
    nativeTurnId: string,
    nativeItemId: string,
    message: string,
  ): boolean {
    const entry = this.#entry(nativeTurnId, nativeItemId);
    if (!entry || entry.progress.kind !== "mcp") return false;
    if (
      this.#logicalCodeUnits + message.length >
      MAXIMUM_OVERLAY_LOGICAL_CODE_UNITS
    ) {
      return this.#failAndReturnFalse();
    }
    this.#logicalCodeUnits += message.length;
    entry.progress.logicalCodeUnits += message.length;
    const messageBytes = utf8Bytes(message);
    this.#logicalBytes += messageBytes;
    entry.progress.logicalUtf8Bytes += messageBytes;
    entry.acceptedLogicalCodeUnits += message.length;
    entry.acceptedLogicalUtf8Bytes += messageBytes;
    const existingContent =
      entry.seed.type === "mcpToolCall"
        ? (entry.seed.result?.content.length ?? 0)
        : 0;
    let retained = false;
    if (
      existingContent + entry.progress.messages.length <
      RETAINED_MCP_CONTENT_PARTS
    ) {
      const progress = textProgress(message);
      entry.progress.messages.push(progress);
      retained = true;
      this.#retainedBytes += textProgressBytes(progress);
      if (!this.#withinBounds()) return this.#failAndReturnFalse();
    }
    if (retained) this.#markDirty(entry);
    return true;
  }

  get pendingCount(): number {
    return [...this.#entries.values()].filter(({ dirty }) => dirty).length;
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  get acceptedLogicalBytes(): number {
    return this.#logicalBytes;
  }

  get invalidated(): boolean {
    return this.#invalidated;
  }

  #entry(nativeTurnId: string, nativeItemId: string): LiveEntry | undefined {
    if (this.#invalidated) return undefined;
    return this.#entries.get(coordinateKey({ nativeTurnId, nativeItemId }));
  }

  #reasoning(
    nativeTurnId: string,
    nativeItemId: string,
  ):
    | {
        readonly entry: LiveEntry;
        readonly progress: ReasoningProgress;
      }
    | undefined {
    const entry = this.#entry(nativeTurnId, nativeItemId);
    if (!entry || entry.progress.kind !== "reasoning") return undefined;
    return { entry, progress: entry.progress.reasoning };
  }

  #append(
    entry: LiveEntry,
    progress: TextProgress,
    delta: string,
  ): "visible" | "hidden" | false {
    if (
      this.#logicalCodeUnits + delta.length >
        MAXIMUM_OVERLAY_LOGICAL_CODE_UNITS ||
      progress.logicalCodeUnits + delta.length > CODEX_C2_MAX_TEXT_BYTES
    ) {
      return this.#failAndReturnFalse();
    }
    const priorLogicalBytes = progress.logicalUtf8Bytes;
    const priorRetainedBytes = progress.retainedUtf8Bytes;
    const nextLogicalBytes = appendedUtf8Bytes(
      priorLogicalBytes,
      progress.logicalTrailingHighSurrogate,
      delta,
    );
    progress.logicalCodeUnits += delta.length;
    progress.logicalUtf8Bytes = nextLogicalBytes;
    if (delta.length > 0) {
      progress.logicalTrailingHighSurrogate = endsWithHighSurrogate(delta);
    }
    this.#logicalCodeUnits += delta.length;
    this.#logicalBytes += nextLogicalBytes - priorLogicalBytes;
    entry.acceptedLogicalCodeUnits += delta.length;
    entry.acceptedLogicalUtf8Bytes += nextLogicalBytes - priorLogicalBytes;
    const retained = retainableTextPrefix(progress, delta);
    if (retained.length > 0) {
      progress.chunks.push(retained);
      progress.retainedUtf8Bytes = appendedUtf8Bytes(
        progress.retainedUtf8Bytes,
        progress.retainedTrailingHighSurrogate,
        retained,
      );
      progress.retainedTrailingHighSurrogate = endsWithHighSurrogate(retained);
    }
    this.#retainedBytes += progress.retainedUtf8Bytes - priorRetainedBytes;
    if (!this.#withinBounds()) return this.#failAndReturnFalse();
    return progress.retainedUtf8Bytes === priorRetainedBytes
      ? "hidden"
      : "visible";
  }

  #markDirty(entry: LiveEntry): void {
    if (!entry.dirty) {
      entry.dirty = true;
      entry.dirtySequence = this.#nextDirtySequence;
      this.#nextDirtySequence += 1;
    }
    const now = this.#clock.now();
    if (now - entry.lastProjectedAt >= this.#intervalMilliseconds) {
      this.#flushDue(now);
      return;
    }
    this.#reschedule();
  }

  #flushDue(now: number): void {
    if (this.#invalidated) return;
    const due = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.dirty &&
          now - entry.lastProjectedAt >= this.#intervalMilliseconds,
      )
      .sort((left, right) => left.dirtySequence - right.dirtySequence);
    if (due.length === 0) {
      this.#reschedule();
      return;
    }
    const generation = this.#generation;
    const installEpoch = this.#installEpoch;
    const disposalEpoch = this.#disposalEpoch;
    const published = this.#onFlush(
      due.map((entry) => ({
        nativeTurnId: entry.coordinate.nativeTurnId,
        nativeItemId: entry.coordinate.nativeItemId,
        coordinate: entry.coordinate,
        item: materializeEntry(entry),
      })),
    );
    if (
      published === false ||
      this.#invalidated ||
      generation !== this.#generation ||
      installEpoch !== this.#installEpoch ||
      disposalEpoch !== this.#disposalEpoch
    ) {
      if (!this.#invalidated) this.#fail();
      return;
    }
    for (const entry of due) {
      commitEntry(entry);
      entry.dirty = false;
      entry.lastProjectedAt = now;
    }
    this.#reschedule();
  }

  #reschedule(): void {
    if (this.#invalidated) return;
    const dueAt = [...this.#entries.values()]
      .filter(({ dirty }) => dirty)
      .reduce<number | undefined>((earliest, entry) => {
        const candidate = entry.lastProjectedAt + this.#intervalMilliseconds;
        return earliest === undefined || candidate < earliest
          ? candidate
          : earliest;
      }, undefined);
    if (dueAt === undefined) {
      this.#cancelTask();
      return;
    }
    if (this.#task && this.#taskDueAt === dueAt) return;
    this.#cancelTask();
    const generation = this.#generation;
    const installEpoch = this.#installEpoch;
    const disposalEpoch = this.#disposalEpoch;
    this.#taskDueAt = dueAt;
    this.#task = this.#scheduler.schedule(
      Math.max(0, dueAt - this.#clock.now()),
      () => {
        this.#enqueue(() => {
          if (
            this.#invalidated ||
            generation !== this.#generation ||
            installEpoch !== this.#installEpoch ||
            disposalEpoch !== this.#disposalEpoch
          ) {
            return;
          }
          this.#task = undefined;
          this.#taskDueAt = undefined;
          this.#flushDue(this.#clock.now());
        });
      },
    );
  }

  #cancelTask(): void {
    this.#task?.cancel();
    this.#task = undefined;
    this.#taskDueAt = undefined;
  }

  #withinBounds(): boolean {
    return (
      this.#entries.size <= CODEX_C2_MAX_COLLECTION_ITEMS &&
      this.#logicalCodeUnits <= MAXIMUM_OVERLAY_LOGICAL_CODE_UNITS &&
      this.#logicalBytes <= MAXIMUM_OVERLAY_UTF8_BYTES &&
      this.#retainedBytes <= MAXIMUM_OVERLAY_UTF8_BYTES
    );
  }

  #failAndReturnFalse(): false {
    this.#fail();
    return false;
  }

  #fail(): void {
    if (this.#invalidated) return;
    this.dispose();
    this.#onInvalid();
  }
}

function createEntry(
  seed: CodexLiveProjectionSeed,
  lastProjectedAt: number,
): LiveEntry | undefined {
  const item = seed.item;
  const base = {
    coordinate: seed.coordinate,
    seed: item,
    dirty: false,
    dirtySequence: -1,
    lastProjectedAt,
    acceptedLogicalCodeUnits: 0,
    acceptedLogicalUtf8Bytes: 0,
  };
  switch (item.type) {
    case "agentMessage":
      return withInitialAcceptedLifetime({
        ...base,
        seed: { ...item, text: "" },
        progress: { kind: "agent", text: messageTextProgress(item.text) },
      });
    case "plan":
      return withInitialAcceptedLifetime({
        ...base,
        seed: { ...item, text: "" },
        progress: { kind: "plan", text: textProgress(item.text) },
      });
    case "commandExecution":
      return withInitialAcceptedLifetime({
        ...base,
        seed: { ...item, aggregatedOutput: null },
        progress: {
          kind: "command",
          text: textProgress(item.aggregatedOutput ?? ""),
          hasOutput: item.aggregatedOutput !== null,
        },
      });
    case "reasoning":
      return withInitialAcceptedLifetime({
        ...base,
        seed: { ...item, summary: [], content: [] },
        progress: {
          kind: "reasoning",
          reasoning: {
            summary: item.summary.map(textProgress),
            content: item.content.map(textProgress),
          },
        },
      });
    case "fileChange":
      return withInitialAcceptedLifetime({
        ...base,
        seed: { ...item, changes: [] },
        progress: { kind: "file", changes: item.changes },
      });
    case "mcpToolCall":
      return withInitialAcceptedLifetime({
        ...base,
        progress: {
          kind: "mcp",
          messages: [],
          logicalCodeUnits: 0,
          logicalUtf8Bytes: 0,
        },
      });
    default:
      return undefined;
  }
}

function withInitialAcceptedLifetime(entry: LiveEntry): LiveEntry {
  entry.acceptedLogicalCodeUnits = entryLogicalCodeUnits(entry);
  entry.acceptedLogicalUtf8Bytes = entryLogicalBytes(entry);
  return entry;
}

function sameOverlayCoordinate(previous: LiveEntry, next: LiveEntry): boolean {
  return (
    previous.coordinate.nativeTurnId === next.coordinate.nativeTurnId &&
    previous.coordinate.nativeItemId === next.coordinate.nativeItemId &&
    previous.coordinate.nativeOrdinal === next.coordinate.nativeOrdinal &&
    previous.coordinate.itemType === next.coordinate.itemType
  );
}

function carryAcceptedLifetime(previous: LiveEntry, next: LiveEntry): void {
  next.acceptedLogicalCodeUnits = previous.acceptedLogicalCodeUnits;
  next.acceptedLogicalUtf8Bytes = previous.acceptedLogicalUtf8Bytes;
  if (previous.progress.kind !== next.progress.kind) return;
  switch (previous.progress.kind) {
    case "agent":
    case "plan":
      if (next.progress.kind !== "agent" && next.progress.kind !== "plan") {
        return;
      }
      carryTextLifetime(previous.progress.text, next.progress.text);
      return;
    case "command":
      if (next.progress.kind !== "command") return;
      carryTextLifetime(previous.progress.text, next.progress.text);
      next.progress.hasOutput = previous.progress.hasOutput;
      return;
    case "reasoning":
      if (next.progress.kind !== "reasoning") return;
      carryTextArrayLifetime(
        previous.progress.reasoning.summary,
        next.progress.reasoning.summary,
      );
      carryTextArrayLifetime(
        previous.progress.reasoning.content,
        next.progress.reasoning.content,
      );
      return;
    case "file":
    case "mcp":
      return;
  }
}

function carryTextArrayLifetime(
  previous: readonly TextProgress[],
  next: readonly TextProgress[],
): void {
  for (
    let index = 0;
    index < Math.min(previous.length, next.length);
    index += 1
  ) {
    carryTextLifetime(previous[index]!, next[index]!);
  }
}

function carryTextLifetime(previous: TextProgress, next: TextProgress): void {
  next.logicalCodeUnits = previous.logicalCodeUnits;
  next.logicalUtf8Bytes = previous.logicalUtf8Bytes;
  next.logicalTrailingHighSurrogate = previous.logicalTrailingHighSurrogate;
}

function materializeEntry(entry: LiveEntry): CodexThreadItem {
  const progress = entry.progress;
  switch (progress.kind) {
    case "agent":
      return { ...entry.seed, text: materializeText(progress.text) } as Extract<
        CodexThreadItem,
        { readonly type: "agentMessage" }
      >;
    case "plan":
      return { ...entry.seed, text: materializeText(progress.text) } as Extract<
        CodexThreadItem,
        { readonly type: "plan" }
      >;
    case "command":
      return {
        ...entry.seed,
        aggregatedOutput: progress.hasOutput
          ? materializeText(progress.text)
          : null,
      } as Extract<CodexThreadItem, { readonly type: "commandExecution" }>;
    case "reasoning":
      return {
        ...entry.seed,
        summary: progress.reasoning.summary.map(materializeText),
        content: progress.reasoning.content.map(materializeText),
      } as Extract<CodexThreadItem, { readonly type: "reasoning" }>;
    case "file":
      return { ...entry.seed, changes: progress.changes } as Extract<
        CodexThreadItem,
        { readonly type: "fileChange" }
      >;
    case "mcp": {
      const seed = entry.seed as Extract<
        CodexThreadItem,
        { readonly type: "mcpToolCall" }
      >;
      return {
        ...seed,
        result: {
          content: [
            ...(seed.result?.content ?? []),
            ...progress.messages.map((message) => ({
              type: "text" as const,
              text: materializeText(message),
            })),
          ],
          structuredContent: seed.result?.structuredContent ?? null,
          _meta: seed.result?._meta ?? null,
        },
      };
    }
  }
}

function commitEntry(entry: LiveEntry): void {
  const progress = entry.progress;
  switch (progress.kind) {
    case "agent":
    case "plan":
    case "command":
      commitText(progress.text);
      return;
    case "reasoning":
      for (const text of progress.reasoning.summary) commitText(text);
      for (const text of progress.reasoning.content) commitText(text);
      return;
    case "file":
    case "mcp":
      return;
  }
}

function textProgress(value: string): TextProgress {
  const prefix = utf8Prefix(value);
  return {
    preserveFullText: false,
    prefix,
    chunks: [],
    logicalCodeUnits: value.length,
    logicalUtf8Bytes: utf8Bytes(value),
    logicalTrailingHighSurrogate: endsWithHighSurrogate(value),
    retainedUtf8Bytes: utf8Bytes(prefix),
    retainedTrailingHighSurrogate: endsWithHighSurrogate(prefix),
  };
}

function messageTextProgress(value: string): TextProgress {
  const bytes = utf8Bytes(value);
  const trailingHighSurrogate = endsWithHighSurrogate(value);
  return {
    preserveFullText: true,
    prefix: value,
    chunks: [],
    logicalCodeUnits: value.length,
    logicalUtf8Bytes: bytes,
    logicalTrailingHighSurrogate: trailingHighSurrogate,
    retainedUtf8Bytes: bytes,
    retainedTrailingHighSurrogate: trailingHighSurrogate,
  };
}

function retainableTextPrefix(progress: TextProgress, value: string): string {
  if (progress.preserveFullText) return value;
  return value.slice(
    0,
    retainedPrefixCodeUnits(
      value,
      progress.retainedUtf8Bytes,
      progress.retainedTrailingHighSurrogate,
    ),
  );
}

function utf8Prefix(value: string): string {
  return value.slice(0, retainedPrefixCodeUnits(value, 0, false));
}

function retainedPrefixCodeUnits(
  value: string,
  startingBytes: number,
  startsWithDanglingHighSurrogate: boolean,
): number {
  let bytes = startingBytes;
  let trailingHighSurrogate = startsWithDanglingHighSurrogate;
  let end = 0;
  while (end < value.length) {
    const unit = value.slice(end, end + 1);
    const nextBytes = appendedUtf8Bytes(bytes, trailingHighSurrogate, unit);
    const completesBoundaryPair =
      trailingHighSurrogate && isLowSurrogate(unit.charCodeAt(0));
    if (
      nextBytes > RETAINED_TEXT_UTF8_BYTES &&
      !(
        completesBoundaryPair &&
        bytes <= RETAINED_TEXT_UTF8_BYTES &&
        nextBytes <= MAXIMUM_RETAINED_TEXT_UTF8_BYTES
      )
    ) {
      break;
    }
    bytes = nextBytes;
    trailingHighSurrogate = endsWithHighSurrogate(unit);
    end += 1;
  }
  return end;
}

function ensureTextProgress(
  values: TextProgress[],
  index: number,
): TextProgress {
  while (values.length <= index) values.push(textProgress(""));
  return values[index]!;
}

function materializeText(progress: TextProgress): string {
  return progress.chunks.length === 0
    ? progress.prefix
    : `${progress.prefix}${progress.chunks.join("")}`;
}

function commitText(progress: TextProgress): void {
  progress.prefix = materializeText(progress);
  progress.chunks = [];
}

function textProgressBytes(progress: TextProgress): number {
  return progress.retainedUtf8Bytes;
}

function entryLogicalCodeUnits(entry: LiveEntry): number {
  const progress = entry.progress;
  switch (progress.kind) {
    case "agent":
    case "plan":
    case "command":
      return progress.text.logicalCodeUnits;
    case "reasoning":
      return [
        ...progress.reasoning.summary,
        ...progress.reasoning.content,
      ].reduce((total, text) => total + text.logicalCodeUnits, 0);
    case "file":
      return serializedUtf8Bytes(progress.changes);
    case "mcp":
      return (
        serializedUtf8Bytes(
          entry.seed.type === "mcpToolCall" ? entry.seed.result : null,
        ) + progress.logicalCodeUnits
      );
  }
}

function entryLogicalBytes(entry: LiveEntry): number {
  const progress = entry.progress;
  switch (progress.kind) {
    case "agent":
    case "plan":
    case "command":
      return progress.text.logicalUtf8Bytes;
    case "reasoning":
      return [
        ...progress.reasoning.summary,
        ...progress.reasoning.content,
      ].reduce((total, text) => total + text.logicalUtf8Bytes, 0);
    case "file":
      return serializedUtf8Bytes(progress.changes);
    case "mcp":
      return (
        serializedUtf8Bytes(
          entry.seed.type === "mcpToolCall" ? entry.seed.result : null,
        ) + progress.logicalUtf8Bytes
      );
  }
}

function entryRetainedBytes(entry: LiveEntry): number {
  const progress = entry.progress;
  switch (progress.kind) {
    case "agent":
    case "plan":
    case "command":
      return textProgressBytes(progress.text);
    case "reasoning":
      return [
        ...progress.reasoning.summary,
        ...progress.reasoning.content,
      ].reduce((total, text) => total + textProgressBytes(text), 0);
    case "file":
      return serializedUtf8Bytes(progress.changes);
    case "mcp":
      return (
        serializedUtf8Bytes(
          entry.seed.type === "mcpToolCall" ? entry.seed.result : null,
        ) +
        progress.messages.reduce(
          (total, message) => total + textProgressBytes(message),
          0,
        )
      );
  }
}

function coordinateKey(
  coordinate: Pick<
    CodexProjectedItemCoordinate,
    "nativeTurnId" | "nativeItemId"
  >,
): string {
  return `${coordinate.nativeTurnId}\0${coordinate.nativeItemId}`;
}

function validReasoningIndex(index: number): boolean {
  return (
    Number.isSafeInteger(index) && index >= 0 && index < MAXIMUM_REASONING_PARTS
  );
}

const textEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function appendedUtf8Bytes(
  currentBytes: number,
  currentEndsWithHighSurrogate: boolean,
  appended: string,
): number {
  if (appended.length === 0) return currentBytes;
  const first = appended.charCodeAt(0);
  const joinsSurrogatePair =
    currentEndsWithHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
  return currentBytes + utf8Bytes(appended) - (joinsSurrogatePair ? 2 : 0);
}

function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
