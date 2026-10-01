import { acknowledgeOpenCodeTerminalOperation, openCodeMutationWasNotSent, openCodeOperationControl } from "./opencode-operation-control.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { randomUUID } from "node:crypto";
import type { BackendCapabilityDocument, BackendConversationEvent, SequencedBackendEvent } from "../../../shared/protocol/backend.js";
import { backendConversationEventSchema } from "../../../shared/protocol/backend.js";
import type { BackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BackendError, type AttachConversationInput, type BackendEventListener, type ConversationControl, type ConversationHandle,
  type EstablishProjectionInput, type EstablishedBackendProjection, type HistoryPageInput, type InterruptConversationInput, type LocateTurnInput } from "../contracts.js";
import { ConversationInterruptLedger } from "../conversation-interrupt.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import { openCodeConversationError, requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { OpenCodeNativeApi, OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError, type OpenCodeNativeActivity, type OpenCodeNativeEvent, type OpenCodeNativeObservation } from "./opencode-native-api.js";
import { OpenCodeHistoryError, OPENCODE_HISTORY_LIMITS, openCodeHistoryFingerprint, readOpenCodeHistory,
  refreshOpenCodeHistory, restartOpenCodeHistoryAcquisition, type OpenCodeRetainedHistory } from "./opencode-history-reader.js";
import { OpenCodeHistoryProjection, openCodeHistoryPartKey, openCodeNativePartEnded, type OpenCodeObservedPart } from "./opencode-history-projection.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";
import { acquireOpenCodeInputObserver } from "./opencode-input-observer.js";
import { OpenCodeExecutionSettings, type OpenCodeObservedSettings } from "./opencode-execution-settings.js";
import { OpenCodeDelivery } from "./opencode-delivery.js";
import { OpenCodeActions } from "./opencode-actions.js";
import { OpenCodeInteractions } from "./opencode-interactions.js";
import { qualifiedOpenCodeModelId, toEffective } from "./opencode-model-selection.js";
import { classifyOpenCodeRead, materializeOpenCodeViewedImages, type OpenCodeViewedImage } from "./opencode-viewed-images.js";
import { OpenCodeInputEvidenceRepository, openCodeOperationFingerprint } from "./opencode-input-evidence.js";

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
  readonly #usage;
  readonly #inputObservation;
  readonly #settings;
  readonly #delivery;
  readonly #actions;
  readonly #interactions;
  readonly #rawListeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #listeners = new Set<BackendEventListener>();
  readonly #journal: { readonly value: SequencedBackendEvent; readonly bytes: number }[] = [];
  readonly #parts = new Map<string, OpenCodeObservedPart>();
  readonly #nativePartCounts = new Map<string, { text: number; reasoning: number }>();
  readonly #seenEvents = new Set<string>();
  readonly #childIds = new Set<string>();
  readonly #shellIds = new Set<string>();
  readonly #dirtyParts = new Set<string>();
  readonly #dirtyMessages = new Map<string, number>();
  readonly #shellMessageIds = new Map<string, string>();
  #latestAssistantMessageId?: string;
  #latestCompactionMessageId?: string;
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
  #viewedImages: ReadonlyMap<string, OpenCodeViewedImage> = new Map();
  #retained?: OpenCodeRetainedHistory;
  #activity: "running" | "idle" | "unknown" = "unknown";
  #background: BackgroundActivity = unknownActivity;
  #tail: Promise<unknown> = Promise.resolve();
  #pump?: Promise<void>;
  #structuralRevision = 0;
  #projectedRevision = 0;
  #activityRevision = 0;
  #observedActivityRevision = 0;
  #observedSettings?: OpenCodeObservedSettings;
  #settingsRefreshSequence = 0;
  #proofRefreshPending = false;
  // Keep gates announced to a projection until a subscriber receives their
  // resolution. A native refresh may settle them before the next cut is taken.
  readonly #announcedInteractionIds = new Set<string>();

  constructor(readonly context: OpenCodeDriverContext, readonly input: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly lease: OpenCodeRuntimeLease) {
    this.binding = Object.freeze({ ...input.binding });
    this.#api = new OpenCodeNativeApi(lease.client);
    this.#usage = context.usage.acquire(context, input, runtime, lease.client);
    this.#lifetime = AbortSignal.any([this.#local.signal, lease.client.lifetime]);
    this.control = Object.freeze({
      generation: `${lease.generation}:${randomUUID()}`, lifetime: this.#lifetime,
      interrupt: (value: InterruptConversationInput) => this.interrupt(value),
      reconcileInterrupt: (value: InterruptConversationInput) => this.reconcileInterrupt(value),
    });
    this.#settings = new OpenCodeExecutionSettings(context, input, runtime, lease.client,
      `${lease.generation}:${openCodeHistoryFingerprint([this.binding, input.opaqueBindingDetail])}:${randomUUID()}`, this.#lifetime);
    this.#inputObservation = acquireOpenCodeInputObserver(context, input, runtime, lease, this.#lifetime,
      { onProofChanged: () => this.#inputProofChanged() });
    this.#delivery = new OpenCodeDelivery(context, input, this.#settings, this.#inputObservation.observer);
    this.#actions = new OpenCodeActions(context, input, this.#settings);
    this.#interactions = new OpenCodeInteractions(context, input, runtime, lease, this.#lifetime,
      `${lease.generation}:${openCodeHistoryFingerprint([this.binding, input.opaqueBindingDetail])}`, event => this.#emit(event));
    lease.client.lifetime.addEventListener("abort", this.#ownerLost, { once: true });
    if (lease.client.lifetime.aborted) this.#ownerLost();
  }

  async establishProjection(input: EstablishProjectionInput): Promise<EstablishedBackendProjection> {
    return this.#acquire(input.signal, async signal => {
      this.#assertOpen();
      await this.#inputObservation.observer.start(signal);
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
          const replayedInteractions = new Set<string>();
          for (const entry of this.#journal) if (entry.value.handleSequence > after) {
            if (entry.value.event.type === "interaction_opened") {
              replayedInteractions.add(entry.value.event.interaction.backendInteractionId);
              this.#announcedInteractionIds.add(entry.value.event.interaction.backendInteractionId);
            } else if (entry.value.event.type === "interaction_resolved") this.#announcedInteractionIds.delete(entry.value.event.backendInteractionId);
            listener(entry.value);
          }
          this.#listeners.add(listener);
          this.#toolDiagnostic();
          // Interactions are live gates, outside the native transcript snapshot.
          // Re-establishment must republish gates that opened before its cut.
          const interactions = this.#interactions.snapshotInteractions();
          const pendingIds = new Set(interactions.map(interaction => interaction.backendInteractionId));
          for (const id of this.#announcedInteractionIds) if (!pendingIds.has(id)) {
            this.#emit({ type: "interaction_resolved", backendInteractionId: id });
          }
          for (const interaction of interactions) {
            if (!replayedInteractions.has(interaction.backendInteractionId)) this.#emit({ type: "interaction_opened", interaction });
          }
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
    await this.#refreshSettings();
    return this.#capabilities();
  }
  #capabilities(): BackendCapabilityDocument {
    const observed = this.#observedSettings;
    return { revision: `opencode-v2-execution-${openCodeHistoryFingerprint(observed?.observed ?? null)}`,
      actions: ["rename", "compact", "set_model", "set_thinking_level"], deliveryModes: ["submit", "steer"], steerTarget: "conversation",
      composerAttachments: { fileStaging: true, nativeImage: observed?.observed.classification === "recognized" &&
        observed.catalog.catalog.models.some(model => model.id === qualifiedOpenCodeModelId(observed.observed.resolvedSelection!) && model.inputModalities.includes("image")) }, nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
      branching: { availability: "unavailable", reason: boundDisplayText("Native branching is not qualified.") },
      interactionKinds: ["decision", "form", "questionnaire"], usageAccounting: "supported", turnThroughput: "unsupported", usageSections: [],
      effectiveSettings: observed?.observed.classification === "recognized" && observed.observed.resolvedSelection
        ? toEffective(observed.observed.resolvedSelection, this.context.connection.id, observed.catalog.catalog) : {} };
  }
  async usage() { this.#assertOpen(); return {}; }
  async captureSubmissionRetryAnchor(): Promise<string> {
    return this.#acquire(undefined, async signal => {
      await this.#startObservation(signal);
      const projection = await this.#refresh(signal);
      if (projection.runState !== "idle" && projection.runState !== "failed") throw openCodeConversationError(
        "opencode_retry_anchor_requires_settled", "OpenCode must be settled before sending a new input.", "invalid_state");
      return JSON.stringify({ v: 1, scope: openCodeHistoryFingerprint([this.binding, this.input.opaqueBindingDetail]),
        nativeHead: this.#retained!.messages.at(-1)?.id ?? null });
    });
  }
  #toolDiagnostic(): void {
    const message = [this.context.executionEnvironment.diagnostic(this.binding.applicationThreadId),
      this.context.tools.diagnostic(this.binding.applicationThreadId)].filter(Boolean).join(" ");
    if (message && !this.#closed) this.#emit({ type: "notice", notice: { id: "opencode-tools-unavailable", tone: "warning",
      message: boundDisplayText(message), createdAt: new Date().toISOString() } });
  }
  async submit(input: Parameters<ConversationHandle["submit"]>[0]) {
    this.#assertOpen();
    try { return await this.#delivery.submit(input); } catch (error) { throw mapOpenCodeConversationError(error); }
    finally { this.#toolDiagnostic(); }
  }
  async steer(input: Parameters<ConversationHandle["steer"]>[0]) {
    this.#assertOpen();
    try { return await this.#delivery.steer(input); } catch (error) { throw mapOpenCodeConversationError(error); }
    finally { this.#toolDiagnostic(); }
  }
  async perform(input: Parameters<ConversationHandle["perform"]>[0]) {
    this.#assertOpen();
    try { const result = await this.#actions.perform(input); await this.#refreshSettings();
      this.#emit({ type: "capabilities_changed", capabilities: this.#capabilities() }); return result;
    } catch (error) { throw mapOpenCodeConversationError(error); }
    finally { this.#toolDiagnostic(); }
  }
  async reconcileAction(input: Parameters<ConversationHandle["reconcileAction"]>[0]) {
    this.#assertOpen(); return this.#actions.reconcile(input);
  }
  get retirementBlocked(): boolean {
    if (this.#closed || this.#lifetime.aborted) return false;
    try { return new OpenCodeInputEvidenceRepository(this.context.repository).hasUnresolved(this.input.scope, this.binding.applicationThreadId); }
    catch { return true; }
  }
  async respond(input: Parameters<ConversationHandle["respond"]>[0]): Promise<void> {
    this.#assertOpen(); await this.#interactions.respond(input);
  }
  async reconcileInteractionResponse(input: Parameters<ConversationHandle["reconcileInteractionResponse"]>[0]) {
    this.#assertOpen(); return this.#interactions.reconcileInteractionResponse(input);
  }

  async interrupt(input: InterruptConversationInput): Promise<void> {
    this.#assertOpen();
    requireOpenCodeBinding(this.context, this.input);
    if (!input.applicationOperationId || input.applicationOperationId.length > 160 || !Number.isSafeInteger(input.deadlineAt)) throw openCodeUnsupported();
    const repository = this.context.repository, scope = this.input.scope, threadId = this.binding.applicationThreadId;
    const fingerprint = openCodeOperationFingerprint({ operationId: input.applicationOperationId, deadlineAt: input.deadlineAt, binding: this.binding });
    const previous = repository.readOperation(scope, threadId, input.applicationOperationId, "interrupt");
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) throw openCodeUnsupported();
      await acknowledgeOpenCodeTerminalOperation(this.lease.client, () => previous);
      if (previous.disposition === "accepted") return;
      throw this.#stopUnconfirmed(previous.disposition !== "not_applied");
    }
    repository.reserveOperation(scope, { applicationThreadId: threadId, connectionProfileId: this.binding.connectionProfileId,
      executionEnvironmentId: this.binding.executionEnvironmentId, nativeSessionId: this.binding.backendConversationId,
      applicationOperationId: input.applicationOperationId, operationKind: "interrupt", nativeInputId: null,
      requestFingerprint: fingerprint, requestSource: null, deadlineAt: input.deadlineAt }, Date.now());
    let claimed = false, dispatched = false;
    try {
      await this.#interrupts.execute(input, this.#lifetime, async budget => {
        requireOpenCodeBinding(this.context, this.input);
        await budget.wait(this.runtime.assertCurrent(budget.signal));
        const session = await budget.wait(this.#api.getSession(this.binding.backendConversationId, budget.signal));
        if (session.location.directory !== this.input.workspace.canonicalPath) {
          this.#ownerLost();
          throw openCodeConversationError("opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "permission_denied");
        }
        // Subscribe before cancellation can emit its only surviving proof.
        await budget.wait(this.#inputObservation.observer.start(budget.signal));
        await budget.wait(this.runtime.assertCurrent(budget.signal));
        budget.remainingMilliseconds();
        claimed = repository.markDispatched(scope, threadId, input.applicationOperationId, "interrupt", Date.now());
        if (!claimed) throw this.#stopUnconfirmed(true);
        // Control never waits for the projection mutex or its history requests.
        budget.dispatch(); dispatched = true;
        const acknowledgement = await budget.wait(this.#api.interruptSession(this.binding.backendConversationId, openCodeOperationControl({ ...input, operationKind: "interrupt", createdAt: 0 }, "interrupt"), budget.signal));
        await budget.wait(this.runtime.assertCurrent(budget.signal));
        budget.remainingMilliseconds();
        if (!repository.recordOutcome(scope, threadId, input.applicationOperationId, "interrupt", { expected: "dispatched",
          disposition: "accepted", nativeEvidenceFingerprint: openCodeOperationFingerprint(acknowledgement), now: Date.now() })) throw this.#stopUnconfirmed(true);
        // Interrupt leaves native inbox entries intact. Cleanup is bounded by
        // this same Stop deadline, including an acknowledged idle no-op.
        await Promise.allSettled([
          budget.wait(this.#inputObservation.observer.withdrawPending(budget.signal, input.deadlineAt, input.applicationOperationId)),
          budget.wait(this.#actions.withdrawPendingCompactions(budget.signal, input.deadlineAt, input.applicationOperationId)),
        ]); // A fresh Stop can retry exact pending controls; neither cleanup extends its budget.
      });
    } catch (error) {
      const current = repository.requireOperation(scope, threadId, input.applicationOperationId, "interrupt");
      if (current.disposition === "accepted") return;
      if (error instanceof OpenCodeRuntimeError && error.code === "opencode_session_location_changed") this.#ownerLost();
      const refused = openCodeMutationWasNotSent(error);
      if (current.disposition === "prepared" || claimed && (!dispatched || refused)) {
        repository.recordOutcome(scope, threadId, input.applicationOperationId, "interrupt", {
          expected: current.disposition === "prepared" ? "prepared" : "dispatched", disposition: "not_applied", nativeEvidenceFingerprint: null, now: Date.now(),
        });
      } else if (current.disposition === "dispatched") {
        repository.recordOutcome(scope, threadId, input.applicationOperationId, "interrupt", {
          expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: Date.now(),
        });
      }
      throw dispatched && !refused ? this.#stopUnconfirmed(true) : mapOpenCodeConversationError(error);
    } finally {
      await acknowledgeOpenCodeTerminalOperation(this.lease.client,
        () => repository.readOperation(scope, threadId, input.applicationOperationId, "interrupt"));
    }
  }
  async reconcileInterrupt(input: InterruptConversationInput): Promise<import("../contracts.js").BackendMutationReconciliation> {
    this.#assertOpen(); requireOpenCodeBinding(this.context, this.input);
    const receipt = this.context.repository.readOperation(this.input.scope, this.binding.applicationThreadId, input.applicationOperationId, "interrupt");
    if (!receipt) return { outcome: "unknown" };
    if (receipt.requestFingerprint !== openCodeOperationFingerprint({ operationId: input.applicationOperationId, deadlineAt: input.deadlineAt, binding: this.binding })) throw openCodeUnsupported();
    await acknowledgeOpenCodeTerminalOperation(this.lease.client, () => receipt);
    return { outcome: receipt.disposition === "accepted" ? "accepted" : receipt.disposition === "not_applied" ? "not_applied" : "unknown" };
  }
  #stopUnconfirmed(crossed: boolean): BackendError {
    return new BackendError({ category: crossed ? "submission_unknown" : "unavailable", retryable: false,
      crossedSubmissionBoundary: crossed, backendCode: "opencode_stop_unconfirmed", safeMessage: "OpenCode Stop could not be confirmed. Nothing was repeated." });
  }
  subscribe(listener: (event: BackendConversationEvent) => void): () => void {
    this.#assertOpen(); this.#rawListeners.add(listener); return () => this.#rawListeners.delete(listener);
  }

  async close(_options?: { readonly reason: "evicted" }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#local.abort();
    this.#inputObservation.release();
    this.#interactions.close();
    this.lease.client.lifetime.removeEventListener("abort", this.#ownerLost);
    await this.#observation?.close();
    this.#release(); this.#rawListeners.clear(); this.#listeners.clear();
    this.#journal.length = 0; this.#journalBytes = 0; this.#parts.clear(); this.#partBytes = 0; this.#nativePartCounts.clear();
    this.#retained = undefined; this.#projection = undefined;
    this.#dirtyMessages.clear(); this.#shellMessageIds.clear();
  }

  readonly #ownerLost = () => {
    if (this.#closed || this.#local.signal.aborted) return;
    this.#invalidate("provider_handle_closed");
    this.#local.abort(); this.#release();
  };
  #release(): void { if (!this.#released) { this.#released = true; this.#usage.release(); this.lease.release(); } }
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
    this.#dirtyMessages.clear(); this.#shellMessageIds.clear();
    this.#latestAssistantMessageId = undefined; this.#latestCompactionMessageId = undefined;
    this.#observedActivityRevision = this.#activityRevision;
    const observation = this.#api.observe({ signal: this.#lifetime, include: event => {
      // Approval/form observations remain independent of history acquisition.
      this.#interactions.observe(event);
      if ((event.type === "session.moved" || event.type === "session.deleted") && event.data.sessionID === this.binding.backendConversationId) {
        this.#ownerLost(); return false;
      }
      if ("sessionID" in event.data && event.data.sessionID === this.binding.backendConversationId) {
        if (this.context.usage.enabled && event.type === "session.usage.updated" && this.#retained && this.#projection) {
          this.#usage.record(this.#retained.messages, Object.values(this.#projection.turnsById));
        }
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
      const dirtyMessages = new Map(this.#dirtyMessages);
      const readInput = { sessionId: this.binding.backendConversationId, signal, assertCurrent: check, additionalUsage: extra,
        dirtyMessageIds: new Set(dirtyMessages.keys()) };
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
      await this.#interactions.refresh(interactions, activity.children, activity.activeChildren);
      await this.runtime.assertCurrent(signal);
      check();
      this.#inputObservation.observer.observeHistory(retained.messages);
      if (retained.messages.some(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && classifyOpenCodeRead(part).kind === "viewed"))) {
        const catalog = await this.context.catalog.read({ connection: this.context.connection, workspace: this.input.workspace, signal });
        await this.runtime.assertCurrent(signal); check();
        this.#viewedImages = await materializeOpenCodeViewedImages({ messages: retained.messages, nativeNamespaceKey: this.context.nativeNamespaceKey,
          sessionID: this.binding.backendConversationId, scope: this.input.scope, threadId: this.binding.applicationThreadId,
          publisher: this.context.outputArtifacts, models: catalog.modelsById, signal,
          assertCurrent: async () => { await this.runtime.assertCurrent(signal); check(); } });
      } else this.#viewedImages = new Map();
      const remaining = extra();
      this.#retained = { ...retained, decodedBytes: retained.decodedBytes + remaining.decodedBytes, records: retained.records + remaining.records };
      this.#retainedPartAllowance = peakPartBytes;
      const projection = this.#project(signal); check();
      const prior = this.#projection; this.#projection = projection;
      this.#projectedRevision = revision; this.#observedActivityRevision = activityRevision;
      // An event arriving during the read retains its newer revision even if
      // this same native record was already selected for an earlier reread.
      for (const [id, dirtyRevision] of dirtyMessages) if (this.#dirtyMessages.get(id) === dirtyRevision) this.#dirtyMessages.delete(id);
      this.#dirtyParts.clear();
      if (prior && !this.#invalidated) this.#diff(prior, projection);
      if (this.context.usage.enabled) this.#usage.record(this.#retained.messages, Object.values(projection.turnsById));
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
      backgroundActivity: this.#background, observedParts: this.#parts, previous: this.#projection,
      deliveryCorrelations: this.#inputObservation.observer.correlations(), attachmentProvenanceKey: this.context.attachmentProvenanceKey,
      viewedImages: this.#viewedImages, signal });
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
        if ("durable" in event) { this.#structuralRevision++; this.#markNativeChanges(event); }
        if (event.type === "session.model.selected") void this.#refreshSettings().then(() => {
          if (!this.#closed && !this.#lifetime.aborted) this.#emit({ type: "capabilities_changed", capabilities: this.#capabilities() });
        });
        if (this.#observeText(event)) continue;
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

  #markDirtyMessage(id: string | undefined): void {
    if (!id) return;
    if (!this.#dirtyMessages.has(id) && this.#dirtyMessages.size >= JOURNAL_RECORDS) throw new OpenCodeHistoryError("records");
    this.#dirtyMessages.set(id, this.#structuralRevision);
  }

  #markNativeChanges(event: OpenCodeNativeEvent): void {
    // Pinned message-updater addresses assistant/tool mutations by message ID,
    // shell mutations by shell ID, and compaction mutations by the latest row.
    if ("assistantMessageID" in event.data) this.#markDirtyMessage(event.data.assistantMessageID);
    if (event.type === "session.step.started") {
      this.#markDirtyMessage(this.#latestAssistantMessageId);
      this.#latestAssistantMessageId = event.data.assistantMessageID;
    } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      this.#markDirtyMessage(this.#latestAssistantMessageId);
    } else if (event.type === "session.shell.started") {
      this.#shellMessageIds.set(event.data.shell.id, event.id.replace(/^evt_/, "msg_"));
      this.#markDirtyMessage(this.#shellMessageIds.get(event.data.shell.id));
    } else if (event.type === "session.shell.ended") {
      this.#markDirtyMessage(this.#shellMessageIds.get(event.data.shell.id));
    } else if (event.type === "session.compaction.started") {
      this.#latestCompactionMessageId = event.data.inputID ?? event.id.replace(/^evt_/, "msg_");
      this.#markDirtyMessage(this.#latestCompactionMessageId);
    } else if (event.type === "session.compaction.ended" || event.type === "session.compaction.failed") {
      this.#markDirtyMessage(this.#latestCompactionMessageId);
    }
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
    if ((this.#nativePartCounts.get(data.assistantMessageID)?.[kind] ?? 0) <= data.ordinal) {
      this.#structuralRevision++; this.#markDirtyMessage(data.assistantMessageID);
    }
    return true;
  }

  #pruneParts(retained: OpenCodeRetainedHistory): void {
    this.#nativePartCounts.clear();
    this.#shellMessageIds.clear(); this.#latestAssistantMessageId = undefined; this.#latestCompactionMessageId = undefined;
    for (const message of retained.messages) {
      if (message.type === "shell") this.#shellMessageIds.set(message.shellID, message.id);
      if (message.type === "compaction" && message.status === "running") this.#latestCompactionMessageId = message.id;
      if (message.type !== "assistant") continue;
      this.#latestAssistantMessageId = message.id;
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
    this.#usage.gap("capture_gap");
    this.#invalidated = true; this.#activity = "unknown"; this.#background = unknownActivity;
    this.#emit({ type: "resnapshot_required", reason });
  }
  #inputProofChanged(): void {
    this.#structuralRevision++;
    if (this.#proofRefreshPending || !this.#retained || this.#invalidated || this.#closed || this.#lifetime.aborted) return;
    this.#proofRefreshPending = true;
    // Queue one refresh without awaiting it from the independent proof observer.
    void this.#exclusive(this.#lifetime, async signal => {
      if (!this.#invalidated && this.#observation) await this.#refresh(signal);
    }).catch(() => undefined).finally(() => { this.#proofRefreshPending = false; });
  }
  async #refreshSettings(): Promise<void> {
    const sequence = ++this.#settingsRefreshSequence;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closed || this.#lifetime.aborted || sequence !== this.#settingsRefreshSequence) return;
      try {
        const observed = await this.#settings.observe(this.#lifetime);
        if (!this.#closed && !this.#lifetime.aborted && sequence === this.#settingsRefreshSequence) this.#observedSettings = observed;
        return;
      } catch (error) {
        if (this.#closed || this.#lifetime.aborted || sequence !== this.#settingsRefreshSequence) return;
        // A desired write or a newer read superseded this observation. Neither
        // invalidates an already confirmed native state; retry the current view.
        if (error instanceof BackendError && error.backendCode === "opencode_settings_changed") continue;
        this.#observedSettings = undefined;
        try { this.#settings.markUnknown(); } catch { /* Retired authority cannot publish new effective state. */ }
        return;
      }
    }
  }
  #emit(value: BackendConversationEvent): void {
    const event = backendConversationEventSchema.parse(value);
    if (this.#listeners.size || this.#rawListeners.size) {
      if (event.type === "interaction_opened") this.#announcedInteractionIds.add(event.interaction.backendInteractionId);
      else if (event.type === "interaction_resolved") this.#announcedInteractionIds.delete(event.backendInteractionId);
    }
    const sequenced = Object.freeze({ handleSequence: ++this.#sequence, event });
    const bytes = Buffer.byteLength(JSON.stringify(sequenced));
    this.#journal.push({ value: sequenced, bytes }); this.#journalBytes += bytes;
    while (this.#journal.length > JOURNAL_RECORDS || this.#journalBytes > JOURNAL_BYTES) this.#journalBytes -= this.#journal.shift()!.bytes;
    for (const listener of this.#rawListeners) { try { listener(event); } catch { /* Observers cannot alter native authority. */ } }
    for (const listener of this.#listeners) { try { listener(sequenced); } catch { /* Same observer boundary. */ } }
  }
}
