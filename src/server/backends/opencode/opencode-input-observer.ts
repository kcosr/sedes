import { acknowledgeOpenCodeTerminalOperation, openCodeOperationControl } from "./opencode-operation-control.js";
import { BackendAgentToolRequestError, type BackendAgentToolAccessDecisionAuthority } from "../../agent-tools/adapters/backend-facade.js";
import { randomUUID } from "node:crypto";
import { SessionInbox } from "@opencode/schema/session-inbox";
import type { AttachConversationInput, SubmissionReconciliation } from "../contracts.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { openCodeRuntimeTarget, requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { OpenCodeInputEvidenceRepository, openCodeOperationFingerprint, openCodePreparedPayloadFingerprint,
  type OpenCodeInputEvidence, type OpenCodeInputKind } from "./opencode-input-evidence.js";
import { OpenCodeNativeApi, OpenCodeNativeProtocolError, openCodeNativeParser, type OpenCodeNativeEvent,
  type OpenCodeNativeMessage } from "./opencode-native-api.js";
import { readOpenCodeNativeLog, type OpenCodeNativeDurableEvent } from "./opencode-native-log.js";
import { OpenCodeNativeMutations, type OpenCodeNativePromptAdmission } from "./opencode-native-mutations.js";
import type { OpenCodeNativePort, OpenCodePortObservation, OpenCodeObservationBoundary,
  } from "./opencode-native-port.js";
import { OpenCodeObservationCursorRepository, type OpenCodeObservationCheckpoint } from "./opencode-observation-cursor-repository.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";

const MAX_INPUTS = 100_000;
const MAX_EVENT_PROOFS = 100_000;
const parseAdmission = openCodeNativeParser<OpenCodeNativePromptAdmission>(SessionInbox.User);
const unresolved = (text = "OpenCode has not yet proved consumption or withdrawal of this input."): SubmissionReconciliation =>
  ({ status: "unresolved", diagnostic: boundDisplayText(text) });
const lost = (): SubmissionReconciliation => ({ status: "failed_unknown", diagnostic: boundDisplayText(
  "OpenCode input tracking was lost. The input may have been consumed or withdrawn, and a delayed request may still be admitted. Review the retained input before deciding what to do; it has not been resent.") });
interface Tracked { readonly operationId: string; readonly kind: OpenCodeInputKind; readonly inputId: string; }
interface ReadState { readonly trackerId: string; readonly admissionRevision: number; readonly pending: boolean; readonly absent: boolean; }
interface EventProof {
  readonly fingerprint: string;
  readonly type: string;
  readonly inputId?: string;
  readonly boundary?: string;
}
export interface OpenCodeInputObserverOptions { readonly onProofChanged?: () => void; }

/**
 * Operation evidence, independent of the transcript/actor mutex. A tracker is
 * one continuous live subscription, not the native process generation. Only
 * exact private dispatched IDs confer authority; native metadata never does.
 */
export class OpenCodeInputObserver {
  readonly #repository: OpenCodeInputEvidenceRepository;
  readonly #cursors: OpenCodeObservationCursorRepository;
  readonly #api: OpenCodeNativeApi;
  readonly #mutations: OpenCodeNativeMutations;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #sessionID: string;
  readonly #threadID: string;
  readonly #tracked = new Map<string, Tracked>();
  readonly #byInput = new Map<string, Tracked>();
  readonly #reads = new Map<string, ReadState>();
  readonly #admissionRevisions = new Map<string, number>();
  readonly #reading = new Map<string, Promise<void>>();
  readonly #notified = new Set<string>();
  readonly #events = new Map<number, EventProof>();
  readonly #boundaries = new Map<string, number>();
  readonly #waiters = new Set<() => void>();
  readonly #lostOperations = new Set<string>();
  #afterCommit?: (() => void)[];
  #cacheUndo?: (() => void)[];
  #currentInput?: string;
  #inputAuthority = new AbortController();
  #trackerId: string = randomUUID();
  #connected = false;
  #started = false;
  #closed = false;
  #observation?: OpenCodePortObservation;
  #liveFrontier = -1;
  #refreshTimer?: ReturnType<typeof setTimeout>;
  #refreshing = false;
  #refreshOffset = 0;
  #logRead?: Promise<void>;
  #logTracker?: string;

  constructor(readonly context: OpenCodeDriverContext, readonly attach: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly lease: OpenCodeRuntimeLease,
    lifetime: AbortSignal, readonly options: OpenCodeInputObserverOptions = {}) {
    const detail = requireOpenCodeBinding(context, attach);
    this.#sessionID = detail.sessionId; this.#threadID = attach.binding.applicationThreadId;
    this.#repository = new OpenCodeInputEvidenceRepository(context.repository);
    this.#cursors = new OpenCodeObservationCursorRepository(context.repository.database, lease.client.authority, context.nativeNamespaceKey);
    this.#api = new OpenCodeNativeApi(lease.client); this.#mutations = new OpenCodeNativeMutations(lease.client);
    this.#signal = AbortSignal.any([lifetime, lease.client.lifetime, this.#controller.signal]);
    this.#signal.addEventListener("abort", () => this.close(), { once: true });
    for (const evidence of this.#repository.list(context.scope, this.#threadID)) this.track(evidence);
  }

  get trackerId(): string { return this.#trackerId; }

  /** A prior user receipt is not authority for an unrelated current native turn. */
  accessDecisionAuthority(): BackendAgentToolAccessDecisionAuthority {
    return { acquire: async signal => {
      signal.throwIfAborted();
      await this.#assertCurrent(signal);
      const input = this.#currentInput;
      const epoch = this.#inputAuthority;
      const current = () => {
        try {
          this.#assertAuthority();
          if (!input || !this.#connected || epoch.signal.aborted || this.#currentInput !== input) return false;
          const tracked = this.#byInput.get(input);
          if (!tracked) return false;
          const proof = this.#evidence(tracked);
          return dispatched(proof) && proof.receipt.requestSource?.kind === "user" &&
            !!proof.consumedFingerprint && !!proof.preparedPayloadFingerprint && !proof.payloadConflict;
        } catch { return false; }
      };
      if (!current()) throw new BackendAgentToolRequestError({ code: "permission_denied", retryable: false,
        message: "An access decision requires a current user input proved by Sedes. Send a new user message before requesting this operation." });
      const controller = new AbortController();
      return { signal: AbortSignal.any([signal, epoch.signal, this.#signal, controller.signal]),
        isCurrent: current, release: () => controller.abort() };
    } };
  }

  #changeInputAuthority(input?: string): void {
    if (this.#afterCommit) { this.#afterCommit.push(() => this.#changeInputAuthority(input)); return; }
    this.#inputAuthority.abort();
    this.#inputAuthority = new AbortController();
    this.#currentInput = input;
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.#assertAuthority(); signal?.throwIfAborted();
    if (!this.#started) { this.#started = true; void this.#run(); }
    while (!this.#connected) { this.#assertAuthority(); await this.#changed(signal); }
  }

  /** Reservations may be registered before dispatch; proofs re-read disposition. */
  track(evidence: OpenCodeInputEvidence): void {
    this.#assertAuthority();
    const receipt = evidence.receipt;
    if (receipt.operationKind !== "submit" && receipt.operationKind !== "steer") throw new OpenCodeNativeProtocolError();
    const current = this.#repository.get(this.context.scope, this.#threadID, receipt.applicationOperationId, receipt.operationKind);
    if (current.receipt.nativeSessionId !== this.#sessionID || current.receipt.nativeInputId !== receipt.nativeInputId ||
        current.receipt.requestFingerprint !== receipt.requestFingerprint || !current.receipt.nativeInputId) throw new OpenCodeNativeProtocolError();
    const key = operationKey(receipt.applicationOperationId, receipt.operationKind);
    const previous = this.#byInput.get(current.receipt.nativeInputId);
    if (previous && operationKey(previous.operationId, previous.kind) !== key) throw new OpenCodeNativeProtocolError();
    if (!this.#tracked.has(key) && this.#tracked.size >= MAX_INPUTS) throw new OpenCodeNativeProtocolError();
    const tracked = { operationId: receipt.applicationOperationId, kind: receipt.operationKind, inputId: current.receipt.nativeInputId };
    this.#tracked.set(key, tracked); this.#byInput.set(tracked.inputId, tracked);
    this.#acknowledgeTerminal(current); this.#notify(current);
    this.#scheduleRefresh(0);
  }

  recordAdmission(operationId: string, kind: OpenCodeInputKind, nativeAck: OpenCodeNativePromptAdmission): void {
    this.#assertAuthority();
    const tracked = this.#requireTracked(operationId, kind); const ack = parseAdmission(nativeAck);
    if (ack.id !== tracked.inputId || ack.sessionID !== this.#sessionID) throw new OpenCodeNativeProtocolError();
    this.#admit(tracked, ack);
    this.#scheduleRefresh(0);
  }

  async reconcile(operationId: string, kind: OpenCodeInputKind, signal?: AbortSignal): Promise<SubmissionReconciliation> {
    this.#assertAuthority(); signal?.throwIfAborted();
    const tracked = this.#requireTracked(operationId, kind);
    const terminal = this.#terminal(this.#evidence(tracked)); if (terminal) return terminal;
    await this.start(signal);
    // The owner read survives cancellation of this caller's wait.
    await waitFor(this.#refresh(tracked), signal);
    let evidence = this.#evidence(tracked);
    const proved = this.#terminal(evidence); if (proved) return proved;
    if (!dispatched(evidence)) return unresolved("This OpenCode input has not crossed the submission boundary.");
    const read = this.#reads.get(operationKey(operationId, kind));
    if (read?.trackerId !== this.#trackerId || !this.#connected) return unresolved();
    if (read.pending) return unresolved("OpenCode has admitted this input and it is still pending consumption.");
    if ((evidence.trackerId !== this.#trackerId || this.#lostOperations.has(operationKey(operationId, kind))) && read.absent) {
      await waitFor(this.#recoverLog(), signal);
      evidence = this.#evidence(tracked);
      const recovered = this.#terminal(evidence); if (recovered) return recovered;
      const currentRead = this.#reads.get(operationKey(operationId, kind));
      if (this.#connected && currentRead === read && read.trackerId === this.#trackerId && !evidence.payloadConflict &&
          read.admissionRevision === (this.#admissionRevisions.get(operationKey(operationId, kind)) ?? 0)) {
        this.#repository.recordTerminalLoss(this.context.scope, this.#threadID, operationId, kind);
        const receipt = this.#evidence(tracked).receipt;
        if (receipt.disposition === "dispatched") this.context.repository.recordOutcome(this.context.scope, this.#threadID, operationId, kind, {
          expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: Date.now(),
        });
        this.#proofChanged(this.#evidence(tracked));
        return lost();
      }
    }
    return unresolved();
  }

  async awaitConsumption(operationId: string, kind: OpenCodeInputKind, maxWaitMs = 1_000, signal?: AbortSignal): Promise<SubmissionReconciliation> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 1_000) throw new OpenCodeNativeProtocolError();
    const tracked = this.#requireTracked(operationId, kind); const deadline = Date.now() + maxWaitMs;
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), maxWaitMs);
    const budget = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
    try {
      await this.start(budget);
      void this.#refresh(tracked).catch(() => undefined);
      do {
        this.#assertAuthority(); signal?.throwIfAborted();
        const terminal = this.#terminal(this.#evidence(tracked)); if (terminal) return terminal;
        if (Date.now() >= deadline) break;
        await this.#changed(budget, Math.max(1, deadline - Date.now()));
      } while (true);
    } catch (error) {
      signal?.throwIfAborted(); this.#assertAuthority(); if (!timeout.signal.aborted) throw error;
    } finally { clearTimeout(timer); }
    return this.#terminal(this.#evidence(tracked)) ?? unresolved();
  }

  /** Fresh Stop only: exact owned pending IDs; DELETE 204 is never proof. */
  async withdrawPending(signal: AbortSignal, deadlineAt: number, applicationOperationId: string): Promise<void> {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) throw new OpenCodeNativeProtocolError();
    const budget = AbortSignal.any([this.#signal, signal, AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, deadlineAt - Date.now())))]);
    const check = () => { budget.throwIfAborted(); if (Date.now() >= deadlineAt) throw new OpenCodeRuntimeError("opencode_input_withdrawal_deadline"); };
    check(); await this.start(budget); check(); await this.#assertCurrent(budget); check();
    const pending = await this.#api.getPending(this.#sessionID, budget);
    await this.#assertCurrent(budget); check();
    for (const item of pending) {
      check();
      if (item.type !== "user") continue;
      const tracked = this.#byInput.get(item.id); if (!tracked) continue;
      const evidence = this.#evidence(tracked);
      if (!dispatched(evidence) || evidence.consumedFingerprint || evidence.payloadConflict) continue;
      this.#admit(tracked, item);
      const admitted = this.#evidence(tracked); if (admitted.payloadConflict || admitted.consumedFingerprint) continue;
      await this.#assertCurrent(budget); check();
      try { await this.#mutations.cancelInput({ sessionID: this.#sessionID, inboxID: item.id }, openCodeOperationControl({ applicationOperationId, operationKind: "interrupt", deadlineAt, createdAt: 0 }, `withdraw-input:${item.id}`), budget); }
      finally { await acknowledgeOpenCodeTerminalOperation(this.lease.client,
        () => this.context.repository.readOperation(this.context.scope, this.#threadID, applicationOperationId, "interrupt")); }
      // A raced delivery or a no-op cancellation remains unresolved until proof.
      void this.#refresh(tracked).catch(() => undefined);
    }
  }

  correlations(): ReadonlyMap<string, string> {
    this.#assertAuthority();
    const result = new Map<string, string>();
    for (const tracked of this.#tracked.values()) {
      const evidence = this.#evidence(tracked);
      if (evidence.consumedFingerprint && !evidence.payloadConflict) result.set(tracked.inputId, tracked.operationId);
    }
    return result;
  }

  /** Retained native cuts supply positive user evidence, never absence proof. */
  observeHistory(messages: readonly OpenCodeNativeMessage[]): void {
    this.#assertAuthority();
    if (messages.length > MAX_INPUTS) throw new OpenCodeNativeProtocolError();
    for (const message of messages) {
      if (message.type !== "user") continue;
      const tracked = this.#byInput.get(message.id);
      if (tracked && dispatched(this.#evidence(tracked))) this.#consumeMessage(tracked, message);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#changeInputAuthority();
    this.#closed = true; this.#connected = false; this.#controller.abort();
    clearTimeout(this.#refreshTimer); this.#observation?.close(); this.#wake();
    this.#events.clear(); this.#boundaries.clear();
  }

  #assertAuthority(): void {
    this.#signal.throwIfAborted();
    if (this.#closed || this.runtime.nativeNamespaceKey !== this.context.nativeNamespaceKey ||
        this.runtime.snapshot().generation !== this.lease.generation) throw new OpenCodeRuntimeError("opencode_input_observer_stale");
    requireOpenCodeBinding(this.context, this.attach);
  }
  async #assertCurrent(signal?: AbortSignal): Promise<void> {
    this.#assertAuthority(); await this.runtime.assertCurrent(signal); this.#assertAuthority();
  }
  #requireTracked(operationId: string, kind: OpenCodeInputKind): Tracked {
    const tracked = this.#tracked.get(operationKey(operationId, kind));
    if (!tracked) throw new OpenCodeNativeProtocolError();
    return tracked;
  }
  #evidence(tracked: Tracked): OpenCodeInputEvidence {
    return this.#repository.get(this.context.scope, this.#threadID, tracked.operationId, tracked.kind);
  }
  #terminal(evidence: OpenCodeInputEvidence): SubmissionReconciliation | undefined {
    if (evidence.payloadConflict) return unresolved("OpenCode returned conflicting evidence for this input. Its outcome requires review.");
    if (evidence.consumedFingerprint) return { status: "accepted" };
    if (evidence.withdrawnFingerprint) return { status: "not_accepted", retryable: false, diagnostic: boundDisplayText(
      evidence.withdrawalKind === "reverted" ? "OpenCode reverted this pending input before consuming it. It was not sent."
        : "OpenCode withdrew this pending input before consuming it. It was not sent.") };
    return undefined;
  }
  #notify(evidence: OpenCodeInputEvidence): void {
    if (!evidence.consumedFingerprint || evidence.payloadConflict) return;
    const key = operationKey(evidence.receipt.applicationOperationId, evidence.receipt.operationKind as OpenCodeInputKind);
    if (this.#notified.has(key)) return;
    this.#notified.add(key);
    safelyNotify(() => this.attach.onSubmissionObserved?.({ backendCorrelation: evidence.receipt.applicationOperationId }));
  }
  #acknowledgeTerminal(evidence: OpenCodeInputEvidence): void {
    void acknowledgeOpenCodeTerminalOperation(this.lease.client, () => evidence.receipt);
  }
  #proofChanged(evidence: OpenCodeInputEvidence): void {
    if (this.#afterCommit) { this.#afterCommit.push(() => this.#proofChanged(evidence)); return; }
    this.#acknowledgeTerminal(evidence);
    if (evidence.payloadConflict && evidence.receipt.nativeInputId === this.#currentInput) this.#changeInputAuthority();
    this.#notify(evidence); this.#wake();
    safelyNotify(() => this.options.onProofChanged?.());
  }
  #admit(tracked: Tracked, item: Pick<OpenCodeNativePromptAdmission, "payload" | "delivery">, enqueueSequence?: number): void {
    const before = this.#evidence(tracked);
    const evidence = this.#repository.admit(this.context.scope, this.#threadID, tracked.operationId, tracked.kind,
      { payloadFingerprint: openCodePreparedPayloadFingerprint(item.payload), delivery: item.delivery,
        ...(enqueueSequence === undefined ? {} : { enqueueSequence }) });
    const key = operationKey(tracked.operationId, tracked.kind);
    this.#setMap(this.#admissionRevisions, key, (this.#admissionRevisions.get(key) ?? 0) + 1);
    if (proofKey(before) !== proofKey(evidence)) this.#proofChanged(evidence);
  }
  #consumeMessage(tracked: Tracked, message: Extract<OpenCodeNativeMessage, { type: "user" }>): void {
    const payload = openCodePreparedPayloadFingerprint(message);
    this.#proofChanged(this.#repository.consume(this.context.scope, this.#threadID, tracked.operationId, tracked.kind,
      openCodeOperationFingerprint({ kind: "native_user", sessionID: this.#sessionID, id: message.id, payload }), payload));
  }
  #event(event: OpenCodeNativeEvent | OpenCodeNativeDurableEvent, live: boolean): void {
    this.#assertAuthority();
    if (!("durable" in event) || !event.durable || !("sessionID" in event.data) || event.data.sessionID !== this.#sessionID) return;
    if (event.durable.aggregateID !== this.#sessionID || !Number.isSafeInteger(event.durable.seq) || event.durable.seq < 0) throw new OpenCodeNativeProtocolError();
    const seq = event.durable.seq;
    if (live && this.#liveFrontier >= 0 && seq !== this.#liveFrontier + 1) this.#changeInputAuthority();
    if (live) { if (seq <= this.#liveFrontier) throw new OpenCodeNativeProtocolError(); this.#liveFrontier = seq; }
    const fingerprint = openCodeOperationFingerprint(event);
    const prior = this.#events.get(seq);
    if (prior && prior.fingerprint !== fingerprint) throw new OpenCodeNativeProtocolError();
    const inputId = "inboxID" in event.data ? event.data.inboxID : undefined;
    const proof: EventProof = { fingerprint, type: event.type, ...(inputId === undefined ? {} : { inputId }),
      ...(event.type === "session.revert.committed" ? { boundary: event.data.to } : {}) };
    this.#setMap(this.#events, seq, proof);
    if (this.#events.size > MAX_EVENT_PROOFS) this.#deleteMap(this.#events, this.#events.keys().next().value!);
    const tracked = inputId === undefined ? undefined : this.#byInput.get(inputId);
    const evidence = tracked && this.#evidence(tracked);
    if (tracked && evidence && dispatched(evidence)) {
      if (event.type === "session.inbox.enqueued") {
        if (event.data.item.type !== "user") throw new OpenCodeNativeProtocolError();
        this.#admit(tracked, event.data.item, seq);
      } else if (event.type === "session.inbox.delivered") {
        this.#proofChanged(this.#repository.consume(this.context.scope, this.#threadID, tracked.operationId, tracked.kind, fingerprint));
      } else if (event.type === "session.inbox.cancelled") {
        this.#proofChanged(this.#repository.withdraw(this.context.scope, this.#threadID, tracked.operationId, tracked.kind, "cancelled", fingerprint));
      }
    }
    if (event.type === "session.inbox.delivered") this.#rememberBoundary(event.data.inboxID, seq);
    else if (event.type === "session.step.started") this.#rememberBoundary(event.data.assistantMessageID, seq);
    else if (event.type === "session.revert.committed") this.#proveRevert(event.data.to, seq, fingerprint);
    else if (event.type === "session.deleted") { this.#clearMap(this.#boundaries); this.#clearMap(this.#events); }
    if (live) {
      if (event.type === "session.inbox.delivered") this.#changeInputAuthority(event.data.inboxID);
      else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted" || event.type === "session.revert.committed" ||
          event.type === "session.revert.staged" || event.type === "session.deleted") this.#changeInputAuthority();
    }
    // No native event is retained in the handle's history queue by this observer.
  }
  #rememberBoundary(id: string, seq: number): void {
    if (!this.#boundaries.has(id)) this.#setMap(this.#boundaries, id, seq);
    if (this.#boundaries.size > MAX_EVENT_PROOFS) this.#deleteMap(this.#boundaries, this.#boundaries.keys().next().value!);
  }
  #proveRevert(boundary: string, revertSequence: number, fingerprint: string): void {
    const boundarySequence = this.#boundaries.get(boundary);
    if (boundarySequence === undefined) return;
    for (const tracked of this.#tracked.values()) {
      const evidence = this.#evidence(tracked); const enqueue = evidence.enqueueSequence;
      if (!dispatched(evidence) || evidence.consumedFingerprint || evidence.payloadConflict || !evidence.preparedPayloadFingerprint ||
          enqueue === null || boundarySequence > enqueue || enqueue >= revertSequence || revertSequence - boundarySequence > MAX_EVENT_PROOFS) continue;
      // Earlier deletion/revert could invalidate an old insertion coordinate.
      // Require dense coverage from the observed creation, not only enqueue.
      let valid = true; let enqueues = 0;
      for (let seq = boundarySequence; seq <= revertSequence; seq++) {
        const event = this.#events.get(seq);
        if (!event || event.type === "session.deleted" || event.type === "session.forked" || event.type === "session.created" ||
            (seq < revertSequence && event.type === "session.revert.committed")) { valid = false; break; }
        if (event.inputId !== tracked.inputId) continue;
        if (event.type === "session.inbox.enqueued") { enqueues++; if (seq !== enqueue) { valid = false; break; } }
        if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") { valid = false; break; }
      }
      if (valid && enqueues === 1) this.#proofChanged(this.#repository.withdraw(this.context.scope, this.#threadID,
        tracked.operationId, tracked.kind, "reverted", openCodeOperationFingerprint({ fingerprint, boundary, boundarySequence, enqueue })));
    }
    // Future reuse of an erased native ID must establish its insertion again.
    for (const [id, seq] of this.#boundaries) if (seq >= boundarySequence) this.#deleteMap(this.#boundaries, id);
  }

  #markContinuityLost(): void {
    for (const [key, tracked] of this.#tracked) {
      const evidence = this.#evidence(tracked);
      if (dispatched(evidence) && !this.#terminal(evidence) && !this.#lostOperations.has(key)) {
        this.#cacheUndo?.push(() => this.#lostOperations.delete(key)); this.#lostOperations.add(key);
      }
    }
    this.#changeInputAuthority(); this.#reads.clear(); this.#liveFrontier = -1;
  }

  #hydrateProof(boundary: OpenCodeObservationBoundary): void {
    this.#clearMap(this.#events); this.#clearMap(this.#boundaries); this.#liveFrontier = -1;
    for (const fact of boundary.proof.proofs) {
      this.#setMap(this.#events, fact.nativeSequence, { fingerprint: fact.fingerprint, type: fact.type,
        ...(fact.inputId === null ? {} : { inputId: fact.inputId }),
        ...(fact.boundaryId === null ? {} : { boundary: fact.boundaryId }) });
      if (fact.type === "session.inbox.delivered" && fact.inputId) this.#rememberBoundary(fact.inputId, fact.nativeSequence);
      if (fact.type === "session.step.started" && fact.boundaryId) this.#rememberBoundary(fact.boundaryId, fact.nativeSequence);
    }
  }

  /** No callback, permission epoch, or native ACK can escape a failed SQL commit. */
  #commitCursor(previous: OpenCodeObservationCheckpoint | undefined, next: OpenCodeObservationCheckpoint,
    apply: () => void, reset = false): void {
    const tracker = this.#trackerId, frontier = this.#liveFrontier;
    const effects: (() => void)[] = [], undo: (() => void)[] = [];
    this.#afterCommit = effects; this.#cacheUndo = undo;
    try { this.#cursors.commit(previous, next, apply, { reset }); }
    catch (error) {
      for (let index = undo.length - 1; index >= 0; index--) undo[index]!();
      this.#trackerId = tracker; this.#liveFrontier = frontier; throw error;
    } finally { this.#afterCommit = undefined; this.#cacheUndo = undefined; }
    for (const effect of effects) effect();
  }

  #setMap<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (this.#cacheUndo) {
      const had = map.has(key), before = map.get(key);
      this.#cacheUndo.push(() => { if (had) map.set(key, before!); else map.delete(key); });
    }
    map.set(key, value);
  }
  #deleteMap<K, V>(map: Map<K, V>, key: K): void {
    if (!map.has(key)) return;
    const before = map.get(key)!; this.#cacheUndo?.push(() => { map.set(key, before); }); map.delete(key);
  }
  #clearMap<K, V>(map: Map<K, V>): void {
    if (this.#cacheUndo && map.size) {
      const before = [...map]; this.#cacheUndo.push(() => { map.clear(); for (const [key, value] of before) map.set(key, value); });
    }
    map.clear();
  }

  #checkpoint(journalId: string, sequence: number, nativeContinuity: string): OpenCodeObservationCheckpoint {
    return { journalId, sequence, nativeContinuity, runtimeId: this.lease.client.authority.runtimeId,
      nativeGeneration: this.lease.client.authority.nativeGeneration };
  }

  async #follow(observation: OpenCodePortObservation, boundary: OpenCodeObservationBoundary,
    previous: OpenCodeObservationCheckpoint | undefined): Promise<void> {
    const reset = !previous || previous.journalId !== boundary.journalId ||
      previous.runtimeId !== this.lease.client.authority.runtimeId ||
      previous.nativeGeneration !== this.lease.client.authority.nativeGeneration || previous.sequence < boundary.retainedAfterSequence;
    let checkpoint = this.#checkpoint(boundary.journalId, reset ? boundary.retainedAfterSequence : previous.sequence,
      reset ? boundary.nativeContinuity : previous.nativeContinuity);
    this.#commitCursor(previous, checkpoint, () => {
      if (previous && (reset || previous.nativeContinuity !== boundary.nativeContinuity)) this.#markContinuityLost();
      this.#hydrateProof(boundary);
    }, reset);
    let caughtUp = false;
    const baseline = () => {
      if (caughtUp || checkpoint.sequence !== boundary.throughSequence) return;
      const next = { ...checkpoint, nativeContinuity: boundary.nativeContinuity };
      this.#commitCursor(checkpoint, next, () => {
        this.#trackerId = boundary.nativeContinuity;
        this.#liveFrontier = boundary.proof.nativeFrontier ?? -1;
        this.#changeInputAuthority(boundary.nativeConnected ? boundary.proof.currentInputId ?? undefined : undefined);
      });
      checkpoint = next; caughtUp = true;
      this.#connected = boundary.nativeConnected; this.#wake();
      if (this.#connected) this.#scheduleRefresh(0);
    };
    baseline();
    // A reconnect can complete without another native event. Reattach to take
    // a connected atomic baseline instead of granting authority from stale SSE.
    if (caughtUp && !boundary.nativeConnected) return;
    while (!this.#signal.aborted) {
      const records = observation.drain();
      for (const record of records) {
        if (record.journalId !== checkpoint.journalId) throw new OpenCodeRuntimeError("opencode_observation_continuity_lost");
        if (record.sequence <= checkpoint.sequence) continue;
        if (record.sequence !== checkpoint.sequence + 1) throw new OpenCodeRuntimeError("opencode_observation_continuity_lost");
        const next = this.#checkpoint(record.journalId, record.sequence, record.nativeContinuity);
        this.#commitCursor(checkpoint, next, () => {
          if (record.kind === "native_break") {
            this.#markContinuityLost(); this.#trackerId = record.nativeContinuity;
          } else this.#event(record.event, true);
        });
        checkpoint = next;
        await observation.acknowledge({ journalId: checkpoint.journalId, sequence: checkpoint.sequence });
        baseline();
        if (caughtUp && (record.kind === "native_break" && record.sequence > boundary.throughSequence || !boundary.nativeConnected)) return;
      }
      // Retrying a lost ACK is safe: the durable cursor is the release fence.
      await observation.acknowledge({ journalId: checkpoint.journalId, sequence: checkpoint.sequence });
      await observation.wait(this.#signal);
    }
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#signal.aborted) {
      try {
        await this.#assertCurrent(this.#signal);
        const checkpoint = this.#cursors.read();
        let observation: OpenCodePortObservation;
        try { observation = this.lease.client.observe({ purpose: "evidence", signal: this.#signal,
          ...(checkpoint ? { after: { journalId: checkpoint.journalId, sequence: checkpoint.sequence } } : {}) }); }
        catch (error) {
          if (!(error instanceof OpenCodeRuntimeError) || error.code !== "opencode_observation_continuity_lost") throw error;
          observation = this.lease.client.observe({ purpose: "evidence", signal: this.#signal });
        }
        this.#observation = observation;
        let boundary: OpenCodeObservationBoundary;
        try { boundary = await observation.ready; }
        catch (error) {
          if (!(error instanceof OpenCodeRuntimeError) || error.code !== "opencode_observation_continuity_lost") throw error;
          await observation.close();
          observation = this.lease.client.observe({ purpose: "evidence", signal: this.#signal });
          this.#observation = observation; boundary = await observation.ready;
        }
        await this.#assertCurrent(this.#signal);
        await this.#follow(observation, boundary, checkpoint);
      } catch (error) {
        if (error instanceof OpenCodeRuntimeError && error.code === "opencode_observation_controller_superseded") {
          this.close(); break;
        }
        // Carrier detach preserves the host journal and native continuity.
        // Only an explicit loss boundary may make unresolved input unknown.
      }
      this.#changeInputAuthority(); this.#connected = false; this.#reads.clear(); this.#wake();
      await this.#observation?.close();
      if (this.#signal.aborted) break;
      try { await delay(Math.min(1_000, 100 * ++attempt), this.#signal); } catch { break; }
    }
  }
  #refresh(tracked: Tracked): Promise<void> {
    const key = operationKey(tracked.operationId, tracked.kind); const existing = this.#reading.get(key); if (existing) return existing;
    const reading = (async () => {
      try {
        await this.start(this.#signal);
        const trackerId = this.#trackerId;
        await this.#assertCurrent(this.#signal);
        this.#reads.delete(key);
        // A replacement subscription must be ready before its inbox cut starts.
        if (!this.#connected || trackerId !== this.#trackerId) return;
        if (!dispatched(this.#evidence(tracked))) return;
        const admissionRevision = this.#admissionRevisions.get(key) ?? 0;
        const pending = await this.#api.getPending(this.#sessionID, this.#signal);
        await this.#assertCurrent(this.#signal);
        const item = pending.find(item => item.id === tracked.inputId);
        if (item) { if (item.type !== "user") throw new OpenCodeNativeProtocolError(); this.#admit(tracked, item); }
        let absent = false;
        try {
          // Always after inbox, so promotion between these reads cannot be lost.
          const message = await this.#api.getMessage(this.#sessionID, tracked.inputId, this.#signal);
          await this.#assertCurrent(this.#signal); if (message.type !== "user") throw new OpenCodeNativeProtocolError();
          this.#consumeMessage(tracked, message);
        } catch (error) {
          if (!(error instanceof OpenCodeRuntimeError) || error.code !== "opencode_native_not_found") throw error;
          absent = true;
        }
        await this.#assertCurrent(this.#signal);
        if (this.#connected && trackerId === this.#trackerId) this.#reads.set(key, { trackerId, admissionRevision, pending: item !== undefined, absent });
      } catch { this.#reads.delete(key); }
      finally { this.#wake(); this.#scheduleRefresh(); }
    })();
    this.#reading.set(key, reading);
    void reading.finally(() => { if (this.#reading.get(key) === reading) this.#reading.delete(key); });
    return reading;
  }
  #recoverLog(): Promise<void> {
    if (this.#logRead) return this.#logRead;
    if (this.#logTracker === this.#trackerId) return Promise.resolve();
    const tracker = this.#trackerId; this.#logTracker = tracker;
    const reading = (async () => {
      try {
        const cut = await readOpenCodeNativeLog(this.lease.client, { sessionID: this.#sessionID, signal: this.#signal,
          limits: { milliseconds: 2_000, records: MAX_EVENT_PROOFS } });
        await this.#assertCurrent(this.#signal);
        // The finite reader validates all coverage. Missing coordinates are
        // deliberately absent from the event map used for erasure proof.
        for (const event of cut.events) this.#event(event, false);
      } catch { /* Optional source: stock CLI retains no event payloads. */ }
    })();
    this.#logRead = reading; void reading.finally(() => { if (this.#logRead === reading) this.#logRead = undefined; });
    return reading;
  }
  #scheduleRefresh(milliseconds = 500): void {
    if (!this.#started || this.#closed || this.#refreshTimer || this.#refreshing) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined; void this.#backgroundRefresh();
    }, milliseconds); this.#refreshTimer.unref?.();
  }
  async #backgroundRefresh(): Promise<void> {
    if (this.#closed || this.#refreshing) return;
    this.#refreshing = true;
    let remains = false;
    try {
      // Terminal tracker loss and conflicting proof cannot improve by polling.
      // Keep exact live/history consumption recovery, without retaining an idle
      // actor or scanning every settled operation on each background tick.
      const pending = this.#repository.unresolved(this.context.scope, this.#threadID)
        .flatMap(ref => { const tracked = this.#tracked.get(operationKey(ref.operationId, ref.kind)); return tracked ? [tracked] : []; });
      if (!pending.length) return;
      remains = true;
      const selected = Array.from({ length: Math.min(8, pending.length) }, (_, index) => pending[(this.#refreshOffset + index) % pending.length]!);
      this.#refreshOffset = (this.#refreshOffset + selected.length) % pending.length;
      await Promise.all(selected.map(tracked => this.#refresh(tracked)));
    } catch { /* Owner closure and authority invalidation stop useful reads. */ }
    finally { this.#refreshing = false; if (remains) this.#scheduleRefresh(); }
  }
  #wake(): void { for (const wake of this.#waiters) wake(); }
  #changed(signal?: AbortSignal, milliseconds?: number): Promise<void> {
    const budget = AbortSignal.any([this.#signal, ...(signal ? [signal] : [])]);
    budget.throwIfAborted();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { this.#waiters.delete(wake); budget.removeEventListener("abort", abort); clearTimeout(timer); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(budget.reason); };
      this.#waiters.add(wake); budget.addEventListener("abort", abort, { once: true });
      if (milliseconds !== undefined) timer = setTimeout(wake, milliseconds);
    });
  }
}

interface Subscriber { readonly attach: AttachConversationInput; readonly options: OpenCodeInputObserverOptions; }
interface SharedObserver { readonly observer: OpenCodeInputObserver; readonly subscribers: Set<Subscriber>; readonly owner: AbortController; readonly lease: OpenCodeRuntimeLease; }
const registry = new Map<string, Map<string, SharedObserver>>();
function authorityKey(attach: AttachConversationInput): string {
  return JSON.stringify([attach.scope.tenantId, attach.scope.principalId, attach.binding.applicationThreadId,
    attach.binding.backendInstanceId, attach.binding.connectionProfileId, attach.binding.executionEnvironmentId,
    attach.binding.backendConversationId, attach.workspace.canonicalPath, attach.opaqueBindingDetail]);
}
export function findOpenCodeInputObserver(client: OpenCodeNativePort, attach: AttachConversationInput): OpenCodeInputObserver | undefined {
  return registry.get(client.ownerKey)?.get(authorityKey(attach))?.observer;
}
/** Readers and actors share continuity; releasing one borrow cannot lose another's tracker. */
export function acquireOpenCodeInputObserver(context: OpenCodeDriverContext, attach: AttachConversationInput,
  runtime: OpenCodeConversationRuntime, lease: OpenCodeRuntimeLease, lifetime: AbortSignal, options: OpenCodeInputObserverOptions = {}):
  { readonly observer: OpenCodeInputObserver; release(): void } {
  lifetime.throwIfAborted(); requireOpenCodeBinding(context, attach);
  let entries = registry.get(lease.client.ownerKey); if (!entries) { entries = new Map(); registry.set(lease.client.ownerKey, entries); }
  const key = authorityKey(attach); let shared = entries.get(key);
  if (!shared) {
    const subscribers = new Set<Subscriber>(); const owner = new AbortController();
    const retainedLease = runtime.acquire(openCodeRuntimeTarget(attach));
    let observer: OpenCodeInputObserver;
    try { observer = new OpenCodeInputObserver(context, { ...attach, onSubmissionObserved: input => {
      for (const subscriber of subscribers) safelyNotify(() => subscriber.attach.onSubmissionObserved?.(input));
    } }, runtime, retainedLease, owner.signal, { onProofChanged: () => {
      for (const subscriber of subscribers) safelyNotify(() => subscriber.options.onProofChanged?.());
    } }); } catch (error) { retainedLease.release(); throw error; }
    shared = { observer, subscribers, owner, lease: retainedLease }; entries.set(key, shared);
  }
  const selected = shared; const subscriber = { attach, options }; selected.subscribers.add(subscriber);
  // Replay exact durable positive proof to a newly attached actor, including
  // evidence that arrived while only a read handle owned the subscription.
  queueMicrotask(() => {
    if (!selected.subscribers.has(subscriber) || lifetime.aborted) return;
    try { for (const backendCorrelation of new Set(selected.observer.correlations().values())) {
      safelyNotify(() => attach.onSubmissionObserved?.({ backendCorrelation }));
    } } catch { /* Already retired. */ }
  });
  let released = false;
  const release = () => {
    if (released) return; released = true; lifetime.removeEventListener("abort", release); selected.subscribers.delete(subscriber);
    if (selected.subscribers.size === 0) { selected.owner.abort(); selected.observer.close(); selected.lease.release(); if (entries!.get(key) === selected) entries!.delete(key); if (entries!.size === 0) registry.delete(lease.client.ownerKey); }
  };
  lifetime.addEventListener("abort", release, { once: true });
  return { observer: selected.observer, release };
}
function dispatched(evidence: OpenCodeInputEvidence): boolean { return evidence.receipt.disposition !== "prepared" && evidence.receipt.disposition !== "not_applied"; }
function proofKey(evidence: OpenCodeInputEvidence): string {
  return JSON.stringify([evidence.preparedPayloadFingerprint, evidence.admittedDelivery, evidence.enqueueSequence,
    evidence.consumedFingerprint, evidence.withdrawnFingerprint, evidence.payloadConflict]);
}
function operationKey(operationId: string, kind: OpenCodeInputKind): string { return JSON.stringify([operationId, kind]); }
function safelyNotify(callback: () => unknown): void {
  try { void Promise.resolve(callback()).catch(() => undefined); } catch { /* Listener failures cannot interrupt native proof persistence. */ }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return waitFor(new Promise<void>(resolve => { const timer = setTimeout(resolve, milliseconds); timer.unref?.(); }), signal);
}
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted(); if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
