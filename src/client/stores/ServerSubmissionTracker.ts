import type {
  BoundedDisplayText,
  MessageContentPart,
  NormalizedThreadSnapshot,
  QueuedInputPresentation,
  QueuedInputSummary,
} from "../../shared/index.js";
import { MAXIMUM_MESSAGE_ITEM_BYTES, serializedUtf8Bytes } from "../../shared/protocol/payload.js";
import { ApiError } from "../api/ApiClient.js";

/** Presentation only. These records never participate in composer mutations. */
export interface PendingServerSubmission {
  readonly kind: "server";
  readonly operationId: string;
  readonly queuedInputId: string;
  readonly createdAt: string;
  readonly preview: BoundedDisplayText;
  readonly content?: readonly MessageContentPart[];
  readonly attachmentCount: number;
  readonly taskCount: number;
  readonly phase: "sending" | "confirming" | "accepted" | "unconfirmed";
  readonly presentationSequence: number;
  readonly baselineOrderedTurnIds: readonly string[];
  readonly baselineTailTurnId?: string;
  readonly baselineTailTurnItemIds: readonly string[];
  readonly baselineTailItemId?: string;
  readonly baselineActiveTurnId?: string;
}

interface Entry {
  view: PendingServerSubmission;
  signature: string;
  observedRevision: number;
  observation: number;
  needsRead: boolean;
  accepted: boolean;
  contentBytes: number;
  attempts: number;
  retry?: ReturnType<typeof setTimeout>;
  request?: { readonly abort: AbortController; readonly observation: number };
}

const MAXIMUM_SUBMISSIONS = 64;
const MAXIMUM_RETIRED_OPERATIONS = 2_048;
const MAXIMUM_CONCURRENT_READS = 4;
const MAXIMUM_READ_ATTEMPTS = 8;

type SubmissionSnapshot = Pick<NormalizedThreadSnapshot,
  "itemsById" | "queue" | "orderedTurnIds" | "turnsById" | "activeTurnId"> & {
    readonly thread: Pick<NormalizedThreadSnapshot["thread"], "threadRevision">;
  };

export function isOrdinaryPendingSubmission(input: QueuedInputSummary): boolean {
  return input.origin === "user" && input.inputOrigin === undefined &&
    input.resolvedDeliveryMode === "submit" &&
    (input.state === "pending" || input.state === "dispatching");
}

/**
 * Bridges server-owned sends to exact transcript materialization. Queue
 * disappearance is ambiguous: only the scoped detail read can distinguish
 * provider acceptance from another client's cancellation or restoration.
 */
export class ServerSubmissionTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #retired = new Set<string>();
  #views: readonly PendingServerSubmission[] = [];
  #active = false;
  #disposed = false;
  #pumpQueued = false;
  #inFlight = 0;
  #contentBytes = 0;

  constructor(readonly input: {
    readonly threadId: string;
    readonly read: (queuedInputId: string, signal: AbortSignal) => Promise<QueuedInputPresentation>;
    readonly nextSequence: () => number;
    readonly changed: () => void;
  }) {}

  getSnapshot(): readonly PendingServerSubmission[] { return this.#views; }

  reanchorAfter(
    preceding: { readonly presentationSequence: number; readonly baselineTailItemId?: string },
    itemId: string,
  ): void {
    for (const entry of this.#entries.values()) {
      if (entry.view.presentationSequence > preceding.presentationSequence &&
          entry.view.baselineTailItemId === preceding.baselineTailItemId) {
        entry.view = { ...entry.view, baselineTailItemId: itemId };
      }
    }
    this.#publish();
  }

  /** Call for every applied envelope, including intermediate batched states. */
  observe(
    snapshot: SubmissionSnapshot | undefined,
    authoritative: boolean,
    composerOperations: ReadonlySet<string>,
  ): void {
    if (this.#disposed) return;
    const wasActive = this.#active;
    this.#active = authoritative;
    if (!authoritative) this.#suspendReads();
    if (!snapshot) return;
    for (const operationId of composerOperations) this.#retire(operationId);
    if (this.#entries.size === 0 && (!authoritative || !snapshot.queue.some(row =>
      isOrdinaryPendingSubmission(row) && !this.#retired.has(row.deliveryOperationId)))) {
      for (const row of snapshot.queue) {
        if (!isOrdinaryPendingSubmission(row)) this.#retire(row.deliveryOperationId);
      }
      this.#publish();
      return;
    }

    const materialized = new Map(Object.entries(snapshot.itemsById).flatMap(([id, item]) =>
      item.kind === "user_message" && item.deliveryOperationId
        ? [[item.deliveryOperationId, id] as const] : []));
    const queue = new Map(snapshot.queue.map(item => [item.deliveryOperationId, item]));
    const queueById = new Map(snapshot.queue.map(item => [item.id, item]));

    // Resolve earlier placeholders before capturing later submissions' anchors.
    for (const entry of [...this.#entries.values()].sort((a, b) =>
      a.view.presentationSequence - b.view.presentationSequence)) {
      const itemId = materialized.get(entry.view.operationId);
      if (!itemId) continue;
      for (const later of this.#entries.values()) {
        if (later.view.presentationSequence > entry.view.presentationSequence &&
            later.view.baselineTailItemId === entry.view.baselineTailItemId) {
          later.view = { ...later.view, baselineTailItemId: itemId };
        }
      }
      this.#retire(entry.view.operationId);
    }
    for (const entry of this.#entries.values()) {
      const row = queue.get(entry.view.operationId);
      const replacement = queueById.get(entry.view.queuedInputId);
      if ((row && !isOrdinaryPendingSubmission(row)) ||
          (replacement && replacement.deliveryOperationId !== entry.view.operationId)) {
        this.#retire(entry.view.operationId);
        continue;
      }
      const signature = row ? `${row.id}:${row.state}:${row.resolvedDeliveryMode}` : "absent";
      if (signature !== entry.signature) {
        entry.signature = signature;
        entry.observation += 1;
        entry.observedRevision = snapshot.thread.threadRevision;
        entry.attempts = 0;
        this.#clearRetry(entry);
        if (!entry.accepted) {
          entry.needsRead = true;
          entry.view = { ...entry.view, phase: row ? "sending" : "confirming" };
        }
      }
      if (authoritative && !wasActive && !entry.accepted) {
        entry.needsRead = true;
        entry.attempts = 0;
      }
    }

    for (const row of snapshot.queue) {
      if (!isOrdinaryPendingSubmission(row)) {
        // Failure demotion is one-way. An automatic retry keeps its strip;
        // an explicit retry has a new operation identity and can be presented.
        this.#retire(row.deliveryOperationId);
        continue;
      }
      if (!authoritative || this.#entries.size >= MAXIMUM_SUBMISSIONS ||
          this.#entries.has(row.deliveryOperationId) || this.#retired.has(row.deliveryOperationId) ||
          materialized.has(row.deliveryOperationId)) continue;
      const tailTurnId = snapshot.orderedTurnIds.at(-1);
      const tailItems = tailTurnId ? snapshot.turnsById[tailTurnId]?.orderedItemIds ?? [] : [];
      this.#entries.set(row.deliveryOperationId, {
        view: {
          kind: "server", operationId: row.deliveryOperationId, queuedInputId: row.id,
          createdAt: row.createdAt, preview: row.preview,
          attachmentCount: row.attachmentCount, taskCount: row.taskCount,
          phase: "sending", presentationSequence: this.input.nextSequence(),
          baselineOrderedTurnIds: [...snapshot.orderedTurnIds],
          ...(tailTurnId ? { baselineTailTurnId: tailTurnId } : {}),
          baselineTailTurnItemIds: [...tailItems],
          ...(tailItems.at(-1) ? { baselineTailItemId: tailItems.at(-1)! } : {}),
          ...(snapshot.activeTurnId ? { baselineActiveTurnId: snapshot.activeTurnId } : {}),
        },
        signature: `${row.id}:${row.state}:${row.resolvedDeliveryMode}`,
        observedRevision: snapshot.thread.threadRevision, observation: 0,
        needsRead: true, accepted: false, contentBytes: 0, attempts: 0,
      });
    }
    this.#publish();
    this.#schedulePump();
  }

  retireQueuedInput(queuedInputId: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.view.queuedInputId === queuedInputId) this.#retire(entry.view.operationId);
    }
    this.#publish();
  }

  dispose(): void {
    this.#disposed = true;
    this.#active = false;
    this.#suspendReads();
    this.#entries.clear();
    this.#retired.clear();
    this.#views = [];
    this.#contentBytes = 0;
  }

  #retire(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry) {
      entry.request?.abort.abort();
      this.#clearRetry(entry);
      this.#contentBytes -= entry.contentBytes;
      this.#entries.delete(operationId);
    }
    this.#retired.add(operationId);
    if (this.#retired.size > MAXIMUM_RETIRED_OPERATIONS) {
      this.#retired.delete(this.#retired.values().next().value!);
    }
  }

  #suspendReads(): void {
    for (const entry of this.#entries.values()) {
      entry.request?.abort.abort();
      entry.request = undefined;
      this.#clearRetry(entry);
    }
  }

  #clearRetry(entry: Entry): void {
    if (entry.retry !== undefined) clearTimeout(entry.retry);
    entry.retry = undefined;
  }

  #schedulePump(): void {
    if (!this.#active || this.#disposed || this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      if (!this.#active || this.#disposed) return;
      for (const entry of this.#entries.values()) {
        if (this.#inFlight >= MAXIMUM_CONCURRENT_READS) break;
        if (entry.needsRead && !entry.request && entry.retry === undefined &&
            entry.attempts < MAXIMUM_READ_ATTEMPTS) void this.#read(entry);
      }
    });
  }

  async #read(entry: Entry): Promise<void> {
    const request = { abort: new AbortController(), observation: entry.observation };
    entry.request = request;
    entry.needsRead = false;
    entry.attempts += 1;
    this.#inFlight += 1;
    const timer = setTimeout(() => request.abort.abort(), 10_000);
    const current = () => !this.#disposed && this.#active && entry.request === request &&
      this.#entries.get(entry.view.operationId) === entry;
    try {
      const result = await this.input.read(entry.view.queuedInputId, request.abort.signal);
      if (!current()) return;
      if (result.threadId !== this.input.threadId || result.queuedInputId !== entry.view.queuedInputId) {
        throw new Error("Queued input presentation identity mismatch.");
      }
      if (result.deliveryOperationId !== entry.view.operationId || result.resolvedDeliveryMode !== "submit" ||
          result.origin !== "user" || result.inputOrigin !== undefined) {
        this.#retire(entry.view.operationId);
        return;
      }
      // Content is immutable for this exact operation, even if its status read
      // raced a newer event. Retain at most one message-page budget of content.
      const bytes = serializedUtf8Bytes(result.content);
      if (this.#contentBytes - entry.contentBytes + bytes <= MAXIMUM_MESSAGE_ITEM_BYTES) {
        this.#contentBytes += bytes - entry.contentBytes;
        entry.contentBytes = bytes;
        entry.view = { ...entry.view, content: result.content };
      }
      if (request.observation !== entry.observation || result.threadRevision < entry.observedRevision) {
        this.#retry(entry);
        return;
      }
      if (["cancelled", "failed", "retry_wait", "uncertain"].includes(result.state)) {
        this.#retire(entry.view.operationId);
      } else if (result.state === "accepted") {
        entry.accepted = true;
        entry.view = { ...entry.view, phase: "accepted" };
      } else if (entry.signature === "absent") {
        this.#retry(entry);
      } else {
        entry.view = { ...entry.view, phase: "sending" };
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 404) this.#retire(entry.view.operationId);
      else this.#retry(entry);
    } finally {
      clearTimeout(timer);
      this.#inFlight -= 1;
      if (entry.request === request) entry.request = undefined;
      this.#publish();
      this.#schedulePump();
    }
  }

  #retry(entry: Entry): void {
    entry.needsRead = true;
    if (entry.signature === "absent") entry.view = {
      ...entry.view, phase: entry.attempts >= MAXIMUM_READ_ATTEMPTS ? "unconfirmed" : "confirming",
    };
    if (entry.retry !== undefined || entry.attempts >= MAXIMUM_READ_ATTEMPTS) return;
    entry.retry = setTimeout(() => {
      entry.retry = undefined;
      this.#schedulePump();
    }, Math.min(500 * 2 ** Math.max(0, entry.attempts - 1), 30_000));
  }

  #publish(): void {
    if (this.#disposed) return;
    const views = [...this.#entries.values()].map(entry => entry.view)
      .sort((a, b) => a.presentationSequence - b.presentationSequence);
    if (views.length === this.#views.length && views.every((view, index) => view === this.#views[index])) return;
    this.#views = views;
    this.input.changed();
  }
}
