import { randomUUID } from "node:crypto";
import type { BackendCapabilityDocument, BackendConversationEvent, SequencedBackendEvent } from "../../../shared/protocol/backend.js";
import { backendConversationEventSchema } from "../../../shared/protocol/backend.js";
import type { BackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { AttachConversationInput, BackendEventListener, ConversationControl, ConversationHandle,
  EstablishProjectionInput, EstablishedBackendProjection, HistoryPageInput, InterruptConversationInput, LocateTurnInput } from "../contracts.js";
import { ConversationInterruptLedger } from "../conversation-interrupt.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import { openCodeConversationError, requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { OpenCodeNativeApi, OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError, type OpenCodeNativeActivity, type OpenCodeNativeEvent, type OpenCodeNativeObservation } from "./opencode-native-api.js";
import { OpenCodeHistoryError, OPENCODE_HISTORY_LIMITS, openCodeHistoryFingerprint, readOpenCodeHistory,
  refreshOpenCodeHistory, restartOpenCodeHistoryAcquisition, type OpenCodeRetainedHistory } from "./opencode-history-reader.js";
import { OpenCodeHistoryProjection, openCodeHistoryPartKey, openCodeNativePartEnded, type OpenCodeObservedPart } from "./opencode-history-projection.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";

const JOURNAL_BYTES = 16 * 1024 * 1024;
const JOURNAL_RECORDS = 4096;
const unknownActivity: BackgroundActivity = { state: "unknown", agents: 0, commands: 0, other: 0 };

export function openCodeObservedActivity(value: OpenCodeNativeActivity): BackgroundActivity {
  return { state: "known", agents: value.activeChildren.length,
    commands: value.shells.filter(shell => shell.status === "running").length, other: 0 };
}

export function openCodeUnsupported(): Error {
  return openCodeConversationError("opencode_operation_unavailable", "This OpenCode operation is unavailable.", "invalid_state");
}

/** Abort a caller's wait without cancelling shared resident-runtime startup. */
export async function waitOpenCode<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new OpenCodeHistoryError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** One disposable projection/control client. The native owner outlives this handle. */
export class OpenCodeConversationHandle implements ConversationHandle {
  readonly automaticEviction = "client_detach";
  readonly binding: AttachConversationInput["binding"];
  readonly control: ConversationControl;
  readonly #local = new AbortController();
  readonly #lifetime: AbortSignal;
  readonly #api: OpenCodeNativeApi;
  readonly #interrupts = new ConversationInterruptLedger();
  readonly #rawListeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #listeners = new Set<BackendEventListener>();
  readonly #journal: { readonly value: SequencedBackendEvent; readonly bytes: number }[] = [];
  readonly #parts = new Map<string, OpenCodeObservedPart>();
  readonly #nativePartCounts = new Map<string, { text: number; reasoning: number }>();
  readonly #seenEvents = new Set<string>();
  readonly #childIds = new Set<string>();
  readonly #shellIds = new Set<string>();
  readonly #dirtyParts = new Set<string>();
  #eventBytes = 0;
  #eventRecords = 0;
  #partBytes = 0;
  #retainedPartAllowance = 0;
  #journalBytes = 0;
  #sequence = 0;
  #closed = false;
  #released = false;
  #invalidated = false;
  #generation = randomUUID();
  #observation?: OpenCodeNativeObservation;
  #projection?: OpenCodeHistoryProjection;
  #retained?: OpenCodeRetainedHistory;
  #activity: "running" | "idle" | "unknown" = "unknown";
  #background: BackgroundActivity = unknownActivity;
  #tail: Promise<unknown> = Promise.resolve();
  #pump?: Promise<void>;
  #structuralRevision = 0;
  #projectedRevision = 0;
  #activityRevision = 0;
  #observedActivityRevision = 0;

  constructor(readonly context: OpenCodeDriverContext, readonly input: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly lease: OpenCodeRuntimeLease) {
    this.binding = Object.freeze({ ...input.binding });
    this.#api = new OpenCodeNativeApi(lease.client);
    this.#lifetime = AbortSignal.any([this.#local.signal, lease.client.lifetime]);
    this.control = Object.freeze({
      generation: `${lease.generation}:${randomUUID()}`, lifetime: this.#lifetime,
      interrupt: (value: InterruptConversationInput) => this.interrupt(value),
      reconcileInterrupt: (value: InterruptConversationInput) => this.reconcileInterrupt(value),
    });
    lease.client.lifetime.addEventListener("abort", this.#ownerLost, { once: true });
    if (lease.client.lifetime.aborted) this.#ownerLost();
  }

  async establishProjection(input: EstablishProjectionInput): Promise<EstablishedBackendProjection> {
    return this.#acquire(input.signal, async signal => {
      this.#assertOpen();
      await this.#startObservation(signal);
      const projection = await this.#refresh(signal);
      this.#assertOpen(); signal.throwIfAborted();
      const result = projection.snapshot({ signal });
      this.#invalidated = false;
      const after = this.#sequence;
      const generation = this.#generation;
      this.#startPump();
      return {
        handleSequence: after, snapshot: result.snapshot,
        history: { operational: true, ...(result.previousCursor ? { previousCursor: result.previousCursor } : {}) },
        subscribeFromNext: listener => {
          this.#assertOpen();
          if (generation !== this.#generation || this.#invalidated || after < (this.#journal[0]?.value.handleSequence ?? after + 1) - 1) {
            listener({ handleSequence: this.#sequence + 1, event: { type: "resnapshot_required", reason: "buffer_overflow" } });
            return () => undefined;
          }
          // No await between replay and registration: native events cannot fall into the gap.
          for (const entry of this.#journal) if (entry.value.handleSequence > after) listener(entry.value);
          this.#listeners.add(listener);
          return () => this.#listeners.delete(listener);
        },
      };
    });
  }

  async history(input: HistoryPageInput) {
    return this.#acquire(input.signal, async signal => {
      this.#assertSynchronized();
      return this.#projection!.history({ ...input, signal });
    });
  }
  async locateTurn(input: LocateTurnInput) {
    return this.#acquire(input.signal, async signal => {
      this.#assertSynchronized();
      return this.#projection!.locateTurn({ ...input, signal });
    });
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    return { revision: "opencode-v2-history-1", actions: [], deliveryModes: [], steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false }, nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
      branching: { availability: "unavailable", reason: boundDisplayText("Native branching is not qualified.") },
      interactionKinds: [], usageAccounting: "unsupported", usageSections: [], effectiveSettings: {} };
  }
  async usage() { this.#assertOpen(); return {}; }
  async captureSubmissionRetryAnchor(): Promise<never> { throw openCodeUnsupported(); }
  async submit(..._input: Parameters<ConversationHandle["submit"]>): Promise<never> { throw openCodeUnsupported(); }
  async steer(..._input: Parameters<ConversationHandle["steer"]>): Promise<never> { throw openCodeUnsupported(); }
  async perform(..._input: Parameters<ConversationHandle["perform"]>): Promise<never> { throw openCodeUnsupported(); }
  async reconcileAction(..._input: Parameters<ConversationHandle["reconcileAction"]>): Promise<never> { throw openCodeUnsupported(); }
  async respond(..._input: Parameters<ConversationHandle["respond"]>): Promise<never> { throw openCodeUnsupported(); }
  async reconcileInteractionResponse(..._input: Parameters<ConversationHandle["reconcileInteractionResponse"]>): Promise<never> { throw openCodeUnsupported(); }

  async interrupt(input: InterruptConversationInput): Promise<void> {
    this.#assertOpen();
    await this.#interrupts.execute(input, this.#lifetime, async budget => {
      requireOpenCodeBinding(this.context, this.input);
      await budget.wait(this.runtime.assertCurrent(budget.signal));
      const session = await budget.wait(this.#api.getSession(this.binding.backendConversationId, budget.signal));
      if (session.location.directory !== this.input.workspace.canonicalPath) {
        this.#ownerLost();
        throw openCodeConversationError("opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "permission_denied");
      }
      await budget.wait(this.runtime.assertCurrent(budget.signal));
      // Control never waits for the projection mutex or its history requests.
      budget.dispatch();
      await budget.wait(this.#api.interruptSession(this.binding.backendConversationId, budget.signal));
    });
  }
  async reconcileInterrupt(input: InterruptConversationInput) { return this.#interrupts.reconcile(input); }
  subscribe(listener: (event: BackendConversationEvent) => void): () => void {
    this.#assertOpen(); this.#rawListeners.add(listener); return () => this.#rawListeners.delete(listener);
  }

  async close(_options?: { readonly reason: "evicted" }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#local.abort();
    this.lease.client.lifetime.removeEventListener("abort", this.#ownerLost);
    await this.#observation?.close();
    this.#release(); this.#rawListeners.clear(); this.#listeners.clear();
    this.#journal.length = 0; this.#journalBytes = 0; this.#parts.clear(); this.#partBytes = 0; this.#nativePartCounts.clear();
    this.#retained = undefined; this.#projection = undefined;
  }

  readonly #ownerLost = () => {
    if (this.#closed || this.#local.signal.aborted) return;
    this.#invalidate("provider_handle_closed");
    this.#local.abort(); this.#release();
  };
  #release(): void { if (!this.#released) { this.#released = true; this.lease.release(); } }
  #assertOpen(): void {
    if (this.#closed || this.#lifetime.aborted) throw openCodeConversationError("opencode_handle_closed", "The OpenCode conversation connection is closed.");
  }
  #assertSynchronized(): void {
    this.#assertOpen();
    if (this.#invalidated || !this.#observation || !this.#projection) throw new OpenCodeHistoryError("invalidated");
  }
  async #acquire<T>(signal: AbortSignal | undefined, effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = Date.now() + OPENCODE_HISTORY_LIMITS.milliseconds;
    const timeout = AbortSignal.timeout(OPENCODE_HISTORY_LIMITS.milliseconds);
    const budget = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    try {
      const value = await this.#exclusive(budget, effect);
      if (timeout.aborted || Date.now() >= deadline) throw new OpenCodeHistoryError("time");
      budget.throwIfAborted(); return value;
    } catch (error) {
      if (timeout.aborted || Date.now() >= deadline) throw new OpenCodeHistoryError("time");
      throw this.#readError(error);
    }
  }
  #readError(error: unknown) {
    const mapped = mapOpenCodeConversationError(error);
    if (mapped.backendCode === "opencode_runtime_identity_changed") this.#ownerLost();
    return mapped;
  }
  #exclusive<T>(signal: AbortSignal | undefined, effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const budget = AbortSignal.any([this.#lifetime, ...(signal ? [signal] : [])]);
    const work = this.#tail.catch(() => undefined).then(async () => {
      this.#assertOpen(); budget.throwIfAborted(); return effect(budget);
    });
    this.#tail = work.catch(() => undefined);
    return waitOpenCode(work, budget);
  }

  async #startObservation(signal: AbortSignal): Promise<void> {
    if (this.#observation && !this.#invalidated && !this.#observation.failure) {
      await waitOpenCode(this.#observation.ready, signal); return;
    }
    await this.#observation?.close();
    signal.throwIfAborted(); this.#assertOpen();
    this.#generation = randomUUID(); this.#parts.clear(); this.#partBytes = 0; this.#seenEvents.clear(); this.#nativePartCounts.clear();
    this.#retained = undefined; this.#projection = undefined;
    this.#dirtyParts.clear(); this.#projectedRevision = this.#structuralRevision;
    this.#observedActivityRevision = this.#activityRevision;
    const observation = this.#api.observe({ signal: this.#lifetime, include: event => {
      if ((event.type === "session.moved" || event.type === "session.deleted") && event.data.sessionID === this.binding.backendConversationId) {
        this.#ownerLost(); return false;
      }
      if ("sessionID" in event.data && event.data.sessionID === this.binding.backendConversationId) {
        // Only replayable parent changes and text overlays affect the timeline.
        // Compaction/tool fragments and progress have no durable full value yet.
        return "durable" in event || event.type === "session.text.delta" || event.type === "session.reasoning.delta";
      }
      if ((event.type === "session.created" || event.type === "session.forked") && event.data.parentID === this.binding.backendConversationId) {
        this.#childIds.add(event.data.sessionID); return true;
      }
      if ("sessionID" in event.data && this.#childIds.has(event.data.sessionID)) {
        return event.type === "session.execution.started" || event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" || event.type === "session.execution.interrupted" ||
          event.type === "session.moved" || event.type === "session.deleted";
      }
      if (event.type === "shell.created" && event.data.info.metadata.sessionID === this.binding.backendConversationId) {
        this.#shellIds.add(event.data.info.id); return true;
      }
      return (event.type === "shell.exited" || event.type === "shell.deleted") && this.#shellIds.has(event.data.id);
    } });
    this.#observation = observation;
    void observation.ended.then(end => {
      if (this.#observation !== observation || this.#closed || this.#lifetime.aborted || end.reason === "closed") return;
      this.#invalidate(end.reason === "overflow" ? "buffer_overflow" : "sequence_gap");
    });
    await waitOpenCode(observation.ready, signal);
  }

  async #refresh(parent: AbortSignal): Promise<OpenCodeHistoryProjection> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(OPENCODE_HISTORY_LIMITS.milliseconds);
    const signal = AbortSignal.any([parent, timeout]);
    const observation = this.#observation;
    if (!observation) throw new OpenCodeHistoryError("invalidated");
    const generation = this.#generation;
    const initialEventBytes = this.#eventBytes, initialEventRecords = this.#eventRecords;
    let peakPartBytes = this.#partBytes;
    let consumedBytes = 0, consumedRecords = 0, chargedExtraBytes = 0, chargedExtraRecords = 0;
    const extra = () => ({ decodedBytes: this.#eventBytes - initialEventBytes + peakPartBytes - chargedExtraBytes,
      records: this.#eventRecords - initialEventRecords - chargedExtraRecords });
    const check = () => {
      this.#assertOpen();
      if (timeout.aborted || Date.now() - started >= OPENCODE_HISTORY_LIMITS.milliseconds) throw new OpenCodeHistoryError("time");
      if (parent.aborted) throw new OpenCodeHistoryError("cancelled");
      if (this.#observation !== observation || this.#generation !== generation || observation.failure) throw new OpenCodeHistoryError("invalidated");
      this.#drain(observation);
      peakPartBytes = Math.max(peakPartBytes, this.#partBytes);
      if (consumedBytes + extra().decodedBytes > OPENCODE_HISTORY_LIMITS.decodedBytes) throw new OpenCodeHistoryError("bytes");
      if (consumedRecords + extra().records > OPENCODE_HISTORY_LIMITS.records) throw new OpenCodeHistoryError("records");
    };
    try {
      await this.runtime.assertCurrent(signal); check();
      const revision = this.#structuralRevision, activityRevision = this.#activityRevision;
      const readInput = { sessionId: this.binding.backendConversationId, signal, assertCurrent: check, additionalUsage: extra };
      // Install one finite native cut. Work observed during acquisition remains
      // dirty for the pump; unrelated or continuous streaming cannot demand quiet.
      const retained = this.#retained
        ? await refreshOpenCodeHistory(this.#api, restartOpenCodeHistoryAcquisition(this.#retained), readInput)
        : await readOpenCodeHistory(this.#api, readInput);
      consumedBytes = retained.decodedBytes; consumedRecords = retained.records;
      chargedExtraBytes = this.#eventBytes - initialEventBytes + peakPartBytes;
      chargedExtraRecords = this.#eventRecords - initialEventRecords;
      this.#retained = retained;
      this.#pruneParts(retained);
      const [session, activity, pending, interactions] = await Promise.all([
        this.#api.getSession(this.binding.backendConversationId, signal),
        this.#api.getActivity(this.binding.backendConversationId, this.input.workspace.canonicalPath, signal),
        this.#api.getPending(this.binding.backendConversationId, signal),
        this.#api.getInteractions(this.binding.backendConversationId, signal),
      ]);
      if (session.location.directory !== this.input.workspace.canonicalPath) {
        this.#ownerLost(); throw new OpenCodeHistoryError("invalidated");
      }
      const suffix = retained.messages.slice(retained.messages.findLastIndex(message => message.type === "idle") + 1);
      const unfinished = suffix.some(message => ["user", "assistant", "synthetic", "compaction"].includes(message.type));
      // An empty process-local active list cannot settle an orphaned busy period.
      // A newer active inventory also cannot invent an opening coordinate in an
      // older idle cut; the queued finite catch-up supplies that native record.
      this.#activity = activity.active ? suffix.length ? "running" : "unknown"
        : unfinished || pending.length || interactions.permissions.length || interactions.forms.length ? "unknown" : "idle";
      this.#acceptActivity(activity);
      await this.runtime.assertCurrent(signal);
      check();
      const remaining = extra();
      this.#retained = { ...retained, decodedBytes: retained.decodedBytes + remaining.decodedBytes, records: retained.records + remaining.records };
      this.#retainedPartAllowance = peakPartBytes;
      const projection = this.#project(signal); check();
      const prior = this.#projection; this.#projection = projection;
      this.#projectedRevision = revision; this.#observedActivityRevision = activityRevision;
      this.#dirtyParts.clear();
      if (prior && !this.#invalidated) this.#diff(prior, projection);
      return projection;
    } catch (error) {
      if (!parent.aborted && !this.#lifetime.aborted) this.#invalidate("history_changed");
      if (timeout.aborted) throw new OpenCodeHistoryError("time");
      if (error instanceof OpenCodeNativeReadLimitError) throw new OpenCodeHistoryError(error.limit === "response_bytes" ? "response_bytes" : "records");
      if (error instanceof OpenCodeNativeProtocolError) throw new OpenCodeHistoryError("invalid");
      throw this.#readError(error);
    }
  }

  #project(signal?: AbortSignal): OpenCodeHistoryProjection {
    if (!this.#retained) throw new OpenCodeHistoryError("invalidated");
    const binding = this.binding;
    // A text-only live update retains both native DTOs and an independent
    // overlay. Charge new overlay storage even before the next native refresh.
    const retained = { ...this.#retained, decodedBytes: this.#retained.decodedBytes + Math.max(0, this.#partBytes - this.#retainedPartAllowance) };
    return new OpenCodeHistoryProjection(retained, { bindingScope: [binding.tenantId, binding.ownerPrincipalId,
      binding.applicationThreadId, binding.backendInstanceId, binding.connectionProfileId, binding.executionEnvironmentId,
      this.context.nativeNamespaceKey], generation: this.#generation, activity: this.#activity,
      backgroundActivity: this.#background, observedParts: this.#parts, previous: this.#projection, signal });
  }

  #drain(observation: OpenCodeNativeObservation): boolean {
    let changed = false;
    for (const { event, decodedBytes } of observation.drain()) {
      this.#eventBytes += decodedBytes; this.#eventRecords++;
      if (this.#seenEvents.has(event.id)) continue;
      this.#seenEvents.add(event.id);
      if (this.#seenEvents.size > JOURNAL_RECORDS) this.#seenEvents.delete(this.#seenEvents.values().next().value!);
      changed = true;
      if ("sessionID" in event.data && event.data.sessionID === this.binding.backendConversationId &&
          (event.type === "session.deleted" || event.type === "session.moved")) {
        this.#ownerLost(); throw new OpenCodeHistoryError("invalidated");
      }
      if ("sessionID" in event.data && event.data.sessionID === this.binding.backendConversationId && event.type.startsWith("session.revert.")) {
        this.#generation = randomUUID(); this.#parts.clear(); this.#partBytes = 0;
        this.#invalidate("history_changed"); throw new OpenCodeHistoryError("invalidated");
      }
      if ("sessionID" in event.data && event.data.sessionID === this.binding.backendConversationId) {
        if (this.#observeText(event)) continue;
        if ("durable" in event) this.#structuralRevision++;
      } else {
        if ((event.type === "session.created" || event.type === "session.forked") && event.data.parentID === this.binding.backendConversationId) this.#childIds.add(event.data.sessionID);
        if (event.type === "session.deleted") this.#childIds.delete(event.data.sessionID);
        if (event.type === "shell.created") this.#shellIds.add(event.data.info.id);
        if (event.type === "shell.deleted") this.#shellIds.delete(event.data.id);
        this.#activityRevision++;
      }
    }
    return changed;
  }

  #observeText(event: OpenCodeNativeEvent): boolean {
    if (event.type !== "session.text.delta" && event.type !== "session.reasoning.delta" &&
        event.type !== "session.text.ended" && event.type !== "session.reasoning.ended") return false;
    const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
    const data = event.data;
    const key = openCodeHistoryPartKey(data.assistantMessageID, kind, data.ordinal);
    const previous = this.#parts.get(key);
    const ended = "text" in data;
    // Ended is an authoritative replacement. A delayed delta cannot reopen it.
    if (previous?.completed) {
      if ("text" in data && previous.text !== data.text) throw new OpenCodeHistoryError("invalidated");
      return true;
    }
    const text = "text" in data ? data.text : (previous?.text ?? "") + data.delta;
    const bytes = this.#partBytes - Buffer.byteLength(previous?.text ?? "") + Buffer.byteLength(text);
    if (bytes > JOURNAL_BYTES || (!previous && this.#parts.size >= JOURNAL_RECORDS)) throw new OpenCodeHistoryError("bytes");
    this.#parts.set(key, { text, completed: ended }); this.#partBytes = bytes; this.#dirtyParts.add(key);
    if ((this.#nativePartCounts.get(data.assistantMessageID)?.[kind] ?? 0) <= data.ordinal) this.#structuralRevision++;
    return true;
  }

  #pruneParts(retained: OpenCodeRetainedHistory): void {
    this.#nativePartCounts.clear();
    for (const message of retained.messages) {
      if (message.type !== "assistant") continue;
      const ordinals = { text: 0, reasoning: 0 };
      for (const part of message.content) {
        if (part.type !== "text" && part.type !== "reasoning") continue;
        const key = openCodeHistoryPartKey(message.id, part.type, ordinals[part.type]++);
        const observed = this.#parts.get(key);
        if (observed && openCodeNativePartEnded(message, part)) {
          this.#partBytes -= Buffer.byteLength(observed.text); this.#parts.delete(key);
        }
      }
      this.#nativePartCounts.set(message.id, ordinals);
    }
  }

  #acceptActivity(activity: OpenCodeNativeActivity): void {
    this.#background = openCodeObservedActivity(activity);
    this.#childIds.clear(); for (const child of activity.children) this.#childIds.add(child.id);
    this.#shellIds.clear(); for (const shell of activity.shells) this.#shellIds.add(shell.id);
  }

  async #refreshActivity(signal: AbortSignal): Promise<void> {
    const revision = this.#activityRevision;
    await this.runtime.assertCurrent(signal);
    const activity = await this.#api.getActivity(this.binding.backendConversationId, this.input.workspace.canonicalPath, signal);
    await this.runtime.assertCurrent(signal); this.#assertOpen(); signal.throwIfAborted();
    const previous = this.#background;
    this.#acceptActivity(activity); this.#observedActivityRevision = revision;
    this.#projection?.updateRuntimeState({ backgroundActivity: this.#background });
    if (openCodeHistoryFingerprint(previous) !== openCodeHistoryFingerprint(this.#background)) {
      this.#emit({ type: "background_activity_changed", activity: this.#background });
    }
  }

  #startPump(): void {
    const observation = this.#observation;
    if (!observation || this.#pump) return;
    const work = (async () => {
      while (!this.#closed && !this.#lifetime.aborted && this.#observation === observation && !this.#invalidated) {
        if (this.#projectedRevision === this.#structuralRevision && this.#observedActivityRevision === this.#activityRevision && !this.#dirtyParts.size) {
          await observation.wait(this.#lifetime);
        }
        await this.#exclusive(this.#lifetime, async signal => {
          if (this.#observation !== observation || this.#invalidated) return;
          this.#drain(observation);
          if (this.#projectedRevision !== this.#structuralRevision) { await this.#refresh(signal); return; }
          if (this.#observedActivityRevision !== this.#activityRevision) await this.#refreshActivity(signal);
          if (!this.#dirtyParts.size || !this.#projection) return;
          const changed = this.#projection.applyObservedParts({ observedParts: this.#parts, changedPartKeys: this.#dirtyParts,
            signal, additionalDecodedBytes: Math.max(0, this.#partBytes - this.#retainedPartAllowance) });
          this.#dirtyParts.clear();
          for (const item of changed) this.#emit({ type: item.status === "streaming" ? "item_updated" : "item_completed", item });
        });
      }
    })();
    this.#pump = work.catch(error => {
      this.#readError(error);
      if (this.#observation === observation && !this.#lifetime.aborted && !this.#closed) this.#invalidate("history_changed");
    }).finally(() => {
      this.#pump = undefined;
      if (this.#observation !== observation && !this.#closed && !this.#invalidated) this.#startPump();
    });
  }

  #diff(before: OpenCodeHistoryProjection, after: OpenCodeHistoryProjection): void {
    if (before.orderedBackendTurnIds.some(id => !after.turnsById[id]) || Object.keys(before.itemsById).some(id => !after.itemsById[id])) {
      this.#invalidate("history_changed"); return;
    }
    const same = (a: unknown, b: unknown) => a === b || openCodeHistoryFingerprint(a) === openCodeHistoryFingerprint(b);
    for (const id of after.orderedBackendTurnIds) {
      const turn = after.turnsById[id]!; const prior = before.turnsById[id];
      if (!prior) this.#emit({ type: "turn_started", turn: { backendTurnId: turn.backendTurnId,
        status: "in_progress", startedAt: turn.startedAt, orderedBackendItemIds: [] } });
      for (const itemId of turn.orderedBackendItemIds) {
        const item = after.itemsById[itemId]!; const old = before.itemsById[itemId];
        if (!old || !same(old, item)) this.#emit({ type: item.status !== "streaming" ? "item_completed" : old ? "item_updated" : "item_started", item });
      }
      if (!prior || !same(prior, turn)) this.#emit({ type: turn.status === "in_progress" ? "turn_updated" : "turn_completed", turn });
    }
    if (before.runState !== after.runState || before.activeBackendTurnId !== after.activeBackendTurnId) this.#emit({ type: "run_state_changed",
      state: after.runState, ...(after.activeBackendTurnId ? { activeBackendTurnId: after.activeBackendTurnId } : {}) });
    this.#emit({ type: "background_activity_changed", activity: this.#background });
  }

  #invalidate(reason: Extract<BackendConversationEvent, { type: "resnapshot_required" }>["reason"]): void {
    if (this.#invalidated && reason !== "provider_handle_closed") return;
    this.#invalidated = true; this.#activity = "unknown"; this.#background = unknownActivity;
    this.#emit({ type: "resnapshot_required", reason });
  }
  #emit(value: BackendConversationEvent): void {
    const event = backendConversationEventSchema.parse(value);
    const sequenced = Object.freeze({ handleSequence: ++this.#sequence, event });
    const bytes = Buffer.byteLength(JSON.stringify(sequenced));
    this.#journal.push({ value: sequenced, bytes }); this.#journalBytes += bytes;
    while (this.#journal.length > JOURNAL_RECORDS || this.#journalBytes > JOURNAL_BYTES) this.#journalBytes -= this.#journal.shift()!.bytes;
    for (const listener of this.#rawListeners) { try { listener(event); } catch { /* Observers cannot alter native authority. */ } }
    for (const listener of this.#listeners) { try { listener(sequenced); } catch { /* Same observer boundary. */ } }
  }
}
