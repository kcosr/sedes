import type {
  BoundedDisplayText,
  MessageContentPart,
  NormalizedThreadSnapshot,
  QueuedInputPresentation,
  QueuedInputSummary,
} from "../../shared/index.js";
import { MAXIMUM_MESSAGE_ITEM_BYTES, serializedUtf8Bytes } from "../../shared/protocol/payload.js";
import { ApiError } from "../api/ApiClient.js";
import { directInputRequestSchema } from "../../shared/protocol/thread-input.js";

/** Presentation only. These records never participate in composer mutations. */
export interface PendingServerSubmission {
  readonly kind: "server";
  readonly operationId: string;
  readonly queuedInputId?: string;
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
  submittedText?: string;
  identityWait?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  request?: { readonly abort: AbortController; readonly observation: number };
}

const MAXIMUM_SUBMISSIONS = 64;
const MAXIMUM_RETIRED_OPERATIONS = 2_048;
const MAXIMUM_CONCURRENT_READS = 4;
const MAXIMUM_READ_ATTEMPTS = 8;
const QUEUE_IDENTITY_WAIT_MS = 10_000;

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

  /** Full content from the live native receipt, never a delivery authority. */
  acceptNativeSubmission(
    receipt: { readonly operationId: string; readonly queuedInputId: string | null; readonly text: string },
    snapshot: SubmissionSnapshot | undefined,
    composerOperations: ReadonlySet<string>,
  ): void {
    if (this.#disposed || this.#retired.has(receipt.operationId) ||
        !directInputRequestSchema.shape.text.safeParse(receipt.text).success) return;
    const row = snapshot?.queue.find(item => item.deliveryOperationId === receipt.operationId);
    const replacement = receipt.queuedInputId
      ? snapshot?.queue.find(item => item.id === receipt.queuedInputId) : undefined;
    if (composerOperations.has(receipt.operationId) ||
        Object.values(snapshot?.itemsById ?? {}).some(item =>
          item.kind === "user_message" && item.deliveryOperationId === receipt.operationId) ||
        (row && !isOrdinaryPendingSubmission(row))) {
      this.#retire(receipt.operationId);
      this.#publish();
      return;
    }
    let entry = this.#entries.get(receipt.operationId);
    if ((entry?.view.queuedInputId && receipt.queuedInputId !== null &&
          entry.view.queuedInputId !== receipt.queuedInputId) ||
        (row && receipt.queuedInputId !== null && row.id !== receipt.queuedInputId) ||
        (replacement && replacement.deliveryOperationId !== receipt.operationId)) return;
    if (entry?.submittedText !== undefined) return;
    if (entry?.view.content && !this.#matchesText(entry.view.content, receipt.text)) return;
    const content: readonly MessageContentPart[] = [{ kind: "text", text: { text: receipt.text } }];
    const bytes = serializedUtf8Bytes(content);
    if ((!entry && this.#entries.size >= MAXIMUM_SUBMISSIONS) ||
        this.#contentBytes - (entry?.contentBytes ?? 0) + bytes > MAXIMUM_MESSAGE_ITEM_BYTES) return;
    if (!entry) {
      const queuedInputId = row?.id ?? receipt.queuedInputId;
      entry = {
        view: {
          kind: "server", operationId: receipt.operationId,
          ...(queuedInputId ? { queuedInputId } : {}),
          createdAt: row?.createdAt ?? new Date().toISOString(), preview: row?.preview ?? { text: "" },
          attachmentCount: 0, taskCount: 0, phase: row ? "sending" : "confirming",
          presentationSequence: this.input.nextSequence(), ...this.#anchors(snapshot),
        },
        signature: row ? `${row.id}:${row.state}:${row.resolvedDeliveryMode}` : "absent",
        observedRevision: snapshot?.thread.threadRevision ?? 0, observation: 0,
        needsRead: true, accepted: false, contentBytes: 0, attempts: 0,
      };
      this.#entries.set(receipt.operationId, entry);
    }
    this.#contentBytes += bytes - entry.contentBytes;
    entry.contentBytes = bytes;
    entry.submittedText = receipt.text;
    entry.view = { ...entry.view, content };
    if (!entry.view.queuedInputId && receipt.queuedInputId) {
      entry.view = { ...entry.view, queuedInputId: receipt.queuedInputId };
    }
    this.#waitForIdentity(entry);
    this.#publish();
    this.#schedulePump();
  }

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
      for (const item of Object.values(snapshot.itemsById)) {
        if (item.kind === "user_message" && item.deliveryOperationId) this.#retire(item.deliveryOperationId);
      }
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
    for (const operationId of materialized.keys()) this.#retire(operationId);
    for (const entry of this.#entries.values()) {
      const row = queue.get(entry.view.operationId);
      const replacement = entry.view.queuedInputId ? queueById.get(entry.view.queuedInputId) : undefined;
      if ((row && !isOrdinaryPendingSubmission(row)) ||
          (row && entry.view.queuedInputId && row.id !== entry.view.queuedInputId) ||
          (replacement && replacement.deliveryOperationId !== entry.view.operationId)) {
        this.#retire(entry.view.operationId);
        continue;
      }
      if (row && !entry.view.queuedInputId) {
        entry.view = { ...entry.view, queuedInputId: row.id };
        this.#clearIdentityWait(entry);
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
      this.#waitForIdentity(entry);
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
      this.#entries.set(row.deliveryOperationId, {
        view: {
          kind: "server", operationId: row.deliveryOperationId, queuedInputId: row.id,
          createdAt: row.createdAt, preview: row.preview,
          attachmentCount: row.attachmentCount, taskCount: row.taskCount,
          phase: "sending", presentationSequence: this.input.nextSequence(),
          ...this.#anchors(snapshot),
        },
        signature: `${row.id}:${row.state}:${row.resolvedDeliveryMode}`,
        observedRevision: snapshot.thread.threadRevision, observation: 0,
        needsRead: true, accepted: false, contentBytes: 0, attempts: 0,
      });
    }
    this.#publish();
    this.#schedulePump();
  }

  retireOperation(capturedOperationId: string): void {
    // Admission can outrun the bounded presentation cache. The mutation's
    // captured operation must still retire even if it never had a bubble.
    this.#retire(capturedOperationId);
    this.#publish();
  }

  dispose(): void {
    this.#disposed = true;
    this.#active = false;
    this.#suspendReads();
    for (const entry of this.#entries.values()) this.#clearIdentityWait(entry);
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
      this.#clearIdentityWait(entry);
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

  #anchors(snapshot: SubmissionSnapshot | undefined): Pick<PendingServerSubmission,
    "baselineOrderedTurnIds" | "baselineTailTurnId" | "baselineTailTurnItemIds" |
    "baselineTailItemId" | "baselineActiveTurnId"> {
    const tailTurnId = snapshot?.orderedTurnIds.at(-1);
    const tailItems = tailTurnId ? snapshot?.turnsById[tailTurnId]?.orderedItemIds ?? [] : [];
    return {
      baselineOrderedTurnIds: [...(snapshot?.orderedTurnIds ?? [])],
      ...(tailTurnId ? { baselineTailTurnId: tailTurnId } : {}),
      baselineTailTurnItemIds: [...tailItems],
      ...(tailItems.at(-1) ? { baselineTailItemId: tailItems.at(-1)! } : {}),
      ...(snapshot?.activeTurnId ? { baselineActiveTurnId: snapshot.activeTurnId } : {}),
    };
  }

  #clearIdentityWait(entry: Entry): void {
    if (entry.identityWait !== undefined) clearTimeout(entry.identityWait);
    entry.identityWait = undefined;
  }

  #waitForIdentity(entry: Entry): void {
    if (entry.view.queuedInputId || entry.identityWait !== undefined || entry.view.phase === "unconfirmed") return;
    entry.identityWait = setTimeout(() => {
      entry.identityWait = undefined;
      if (this.#disposed || this.#entries.get(entry.view.operationId) !== entry || entry.view.queuedInputId) return;
      entry.view = { ...entry.view, phase: "unconfirmed" };
      this.#publish();
    }, QUEUE_IDENTITY_WAIT_MS);
  }

  #matchesText(content: readonly MessageContentPart[], text: string): boolean {
    return content.length === 1 && content[0]?.kind === "text" && content[0].text.text === text;
  }

  #schedulePump(): void {
    if (!this.#active || this.#disposed || this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      if (!this.#active || this.#disposed) return;
      for (const entry of this.#entries.values()) {
        if (this.#inFlight >= MAXIMUM_CONCURRENT_READS) break;
        if (entry.view.queuedInputId && entry.needsRead && !entry.request && entry.retry === undefined &&
            entry.attempts < MAXIMUM_READ_ATTEMPTS) void this.#read(entry);
      }
    });
  }

  async #read(entry: Entry): Promise<void> {
    const queuedInputId = entry.view.queuedInputId;
    if (!queuedInputId) return;
    const request = { abort: new AbortController(), observation: entry.observation };
    entry.request = request;
    entry.needsRead = false;
    entry.attempts += 1;
    this.#inFlight += 1;
    const timer = setTimeout(() => request.abort.abort(), 10_000);
    const current = () => !this.#disposed && this.#active && entry.request === request &&
      this.#entries.get(entry.view.operationId) === entry;
    try {
      const result = await this.input.read(queuedInputId, request.abort.signal);
      if (!current()) return;
      if (result.threadId !== this.input.threadId || result.queuedInputId !== entry.view.queuedInputId) {
        throw new Error("Queued input presentation identity mismatch.");
      }
      if (result.deliveryOperationId !== entry.view.operationId || result.resolvedDeliveryMode !== "submit" ||
          result.origin !== "user" || result.inputOrigin !== undefined) {
        this.#retire(entry.view.operationId);
        return;
      }
      if (entry.submittedText !== undefined && !this.#matchesText(result.content, entry.submittedText)) {
        throw new Error("Queued input presentation content mismatch.");
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
