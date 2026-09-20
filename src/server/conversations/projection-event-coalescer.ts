import type {
  ConversationItem,
  ConversationTurn,
  NormalizedThreadEvent,
} from "../../shared/protocol/conversation.js";

export interface ProjectionEventClock {
  now(): number;
}

export interface ProjectionEventScheduledTask {
  cancel(): void;
}

export interface ProjectionEventScheduler {
  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): ProjectionEventScheduledTask;
}

export type ProjectionCoalescerFailureReason =
  | "coalescer_overflow"
  | "projection_generation_mismatch"
  | "item_revision_regression"
  | "item_updated_after_terminal"
  | "turn_revision_regression"
  | "turn_revision_conflict";

export type ProjectionCoalescerOutput =
  | {
      readonly kind: "event";
      readonly event: NormalizedThreadEvent;
    }
  | {
      readonly kind: "resnapshot_required";
      readonly generation: string;
      readonly reason: ProjectionCoalescerFailureReason;
    };

export interface ProjectionEventCoalescerOptions {
  readonly intervalMilliseconds: number;
  readonly maximumPendingItems: number;
  readonly maximumPendingBytes: number;
  readonly emit: (output: ProjectionCoalescerOutput) => void;
  readonly clock?: ProjectionEventClock;
  readonly scheduler?: ProjectionEventScheduler;
}

export interface ProjectionEventSeed {
  readonly generation: string;
  readonly turnsById: Readonly<Record<string, ConversationTurn>>;
  readonly itemsById: Readonly<Record<string, ConversationItem>>;
}

interface PendingItem {
  event: Extract<NormalizedThreadEvent, { type: "item_upsert" }>;
  bytes: number;
  sequence: number;
  dueAt: number;
  task: ProjectionEventScheduledTask;
}

interface SeenItem {
  revision: number;
  terminal: boolean;
}

const defaultClock: ProjectionEventClock = {
  now: () => Date.now(),
};

const defaultScheduler: ProjectionEventScheduler = {
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

/**
 * Coalesces only full normalized item replacements. It does not parse backend
 * payloads, build projection identity, or own an SSE cursor.
 */
export class ProjectionEventCoalescer {
  readonly #intervalMilliseconds: number;
  readonly #maximumPendingItems: number;
  readonly #maximumPendingBytes: number;
  readonly #emitOutput: (output: ProjectionCoalescerOutput) => void;
  readonly #clock: ProjectionEventClock;
  readonly #scheduler: ProjectionEventScheduler;
  readonly #encoder = new TextEncoder();
  readonly #pending = new Map<string, PendingItem>();
  readonly #lastEmittedAt = new Map<string, number>();
  readonly #seenItems = new Map<string, SeenItem>();
  readonly #turns = new Map<string, ConversationTurn>();
  #generation: string | undefined;
  #pendingBytes = 0;
  #nextPendingSequence = 0;
  #invalidated = false;

  constructor(options: ProjectionEventCoalescerOptions) {
    requirePositiveSafeInteger(
      options.intervalMilliseconds,
      "intervalMilliseconds",
    );
    requirePositiveSafeInteger(
      options.maximumPendingItems,
      "maximumPendingItems",
    );
    requirePositiveSafeInteger(
      options.maximumPendingBytes,
      "maximumPendingBytes",
    );
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#maximumPendingItems = options.maximumPendingItems;
    this.#maximumPendingBytes = options.maximumPendingBytes;
    this.#emitOutput = options.emit;
    this.#clock = options.clock ?? defaultClock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  accept(event: NormalizedThreadEvent): void {
    if (event.type === "snapshot") {
      this.reset({
        generation: event.generation,
        turnsById: event.snapshot.turnsById,
        itemsById: event.snapshot.itemsById,
      });
      this.#emit(event);
      return;
    }
    if (this.#invalidated) return;
    if (this.#generation === undefined) {
      this.#generation = event.generation;
    } else if (event.generation !== this.#generation) {
      this.#invalidate("projection_generation_mismatch");
      return;
    }

    if (event.type === "item_upsert") {
      this.#acceptItem(event);
      return;
    }
    if (event.type === "turn_upsert") {
      this.#acceptTurn(event);
      return;
    }
    if (event.type === "history_prepend") {
      for (const turn of Object.values(event.page.turnsById)) {
        this.#turns.set(turn.id, turn);
      }
      for (const item of Object.values(event.page.itemsById)) {
        this.#seenItems.set(item.id, {
          revision: item.revision,
          terminal: terminalItem(item),
        });
      }
    }
    this.#emit(event);
  }

  flush(): void {
    if (this.#invalidated) return;
    const pending = [...this.#pending.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const entry of pending) {
      this.#emitPending(entry.event.item.id);
    }
  }

  reset(seed: ProjectionEventSeed): void {
    this.#clearPending();
    this.#generation = seed.generation;
    this.#invalidated = false;
    this.#lastEmittedAt.clear();
    this.#seenItems.clear();
    this.#turns.clear();
    for (const turn of Object.values(seed.turnsById)) {
      this.#turns.set(turn.id, turn);
    }
    for (const item of Object.values(seed.itemsById)) {
      this.#seenItems.set(item.id, {
        revision: item.revision,
        terminal: terminalItem(item),
      });
    }
  }

  dispose(): void {
    this.#clearPending();
    this.#invalidated = true;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get invalidated(): boolean {
    return this.#invalidated;
  }

  #acceptItem(
    event: Extract<NormalizedThreadEvent, { type: "item_upsert" }>,
  ): void {
    const { item } = event;
    const seen = this.#seenItems.get(item.id);
    if (seen && item.revision <= seen.revision) {
      this.#invalidate("item_revision_regression");
      return;
    }
    if (seen?.terminal) {
      this.#invalidate("item_updated_after_terminal");
      return;
    }
    this.#seenItems.set(item.id, {
      revision: item.revision,
      terminal: terminalItem(item),
    });

    if (terminalItem(item)) {
      this.#removePending(item.id);
      this.#emit(event);
      this.#lastEmittedAt.set(item.id, this.#clock.now());
      return;
    }

    const now = this.#clock.now();
    const lastEmittedAt = this.#lastEmittedAt.get(item.id);
    if (
      lastEmittedAt === undefined ||
      now - lastEmittedAt >= this.#intervalMilliseconds
    ) {
      this.#removePending(item.id);
      this.#emit(event);
      this.#lastEmittedAt.set(item.id, now);
      return;
    }
    this.#retainPending(event, lastEmittedAt + this.#intervalMilliseconds, now);
  }

  #acceptTurn(
    event: Extract<NormalizedThreadEvent, { type: "turn_upsert" }>,
  ): void {
    const prior = this.#turns.get(event.turn.id);
    if (prior && event.turn.revision < prior.revision) {
      this.#invalidate("turn_revision_regression");
      return;
    }
    if (
      prior &&
      event.turn.revision === prior.revision &&
      !equalTurn(prior, event.turn)
    ) {
      this.#invalidate("turn_revision_conflict");
      return;
    }
    if (prior && equalTurn(prior, event.turn)) return;
    this.#turns.set(event.turn.id, event.turn);
    this.#emit(event);
  }

  #retainPending(
    event: Extract<NormalizedThreadEvent, { type: "item_upsert" }>,
    dueAt: number,
    now: number,
  ): void {
    const itemId = event.item.id;
    const bytes = this.#serializedBytes(event);
    const prior = this.#pending.get(itemId);
    const nextCount = this.#pending.size + (prior ? 0 : 1);
    const nextBytes = this.#pendingBytes - (prior?.bytes ?? 0) + bytes;
    if (
      nextCount > this.#maximumPendingItems ||
      nextBytes > this.#maximumPendingBytes
    ) {
      this.#invalidate("coalescer_overflow");
      return;
    }

    if (prior) {
      this.#pendingBytes = nextBytes;
      prior.event = event;
      prior.bytes = bytes;
      return;
    }

    const task = this.#scheduler.schedule(Math.max(0, dueAt - now), () => {
      this.#onTimer(itemId);
    });
    this.#pending.set(itemId, {
      event,
      bytes,
      sequence: this.#nextPendingSequence,
      dueAt,
      task,
    });
    this.#nextPendingSequence += 1;
    this.#pendingBytes = nextBytes;
  }

  #onTimer(itemId: string): void {
    if (this.#invalidated) return;
    const pending = this.#pending.get(itemId);
    if (!pending) return;
    const now = this.#clock.now();
    if (now < pending.dueAt) {
      pending.task = this.#scheduler.schedule(pending.dueAt - now, () =>
        this.#onTimer(itemId),
      );
      return;
    }
    this.#emitPending(itemId);
  }

  #emitPending(itemId: string): void {
    const pending = this.#pending.get(itemId);
    if (!pending) return;
    this.#pending.delete(itemId);
    this.#pendingBytes = Math.max(0, this.#pendingBytes - pending.bytes);
    pending.task.cancel();
    this.#emit(pending.event);
    this.#lastEmittedAt.set(itemId, this.#clock.now());
  }

  #removePending(itemId: string): void {
    const pending = this.#pending.get(itemId);
    if (!pending) return;
    this.#pending.delete(itemId);
    this.#pendingBytes = Math.max(0, this.#pendingBytes - pending.bytes);
    pending.task.cancel();
  }

  #clearPending(): void {
    for (const pending of this.#pending.values()) {
      pending.task.cancel();
    }
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  #invalidate(reason: ProjectionCoalescerFailureReason): void {
    if (this.#invalidated) return;
    if (!this.#generation) {
      throw new Error("projection_coalescer_generation_missing");
    }
    this.#invalidated = true;
    this.#clearPending();
    this.#emitOutput({
      kind: "resnapshot_required",
      generation: this.#generation,
      reason,
    });
  }

  #serializedBytes(event: NormalizedThreadEvent): number {
    return this.#encoder.encode(JSON.stringify(event)).byteLength;
  }

  #emit(event: NormalizedThreadEvent): void {
    this.#emitOutput({ kind: "event", event });
  }
}

function terminalItem(item: ConversationItem): boolean {
  return (
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "interrupted"
  );
}

function equalTurn(left: ConversationTurn, right: ConversationTurn): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.endedBy === right.endedBy &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    equalStrings(left.orderedItemIds, right.orderedItemIds)
  );
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`projection_coalescer_${name}_invalid`);
  }
}
