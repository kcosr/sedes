import { codexEnvironmentFingerprintInput } from "./codex-runtime-environment-fingerprint.js";
import { createHash, randomUUID } from "node:crypto";
import { attachmentDiagnostic, type AttachmentDiagnosticFields } from "../../../diagnostics/attachment-diagnostics.js";
import {
  admitCodexServerNotification, decodeCodexServerRequestParams,
} from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { codexThreadResumeMethod } from "../codex-c1-protocol.js";
import type { VerifiedCodexRuntimeVersion } from "../codex-release-guard.js";
import type { CodexRuntimeReceiptSink, CodexRuntimeReceiptObservation } from "./codex-runtime-receipt-store.js";
import { CodexSharedClientFacade, type CodexReadyClientGeneration } from "../codex-client-facade.js";
import { CodexServerRequestRouter } from "../codex-server-request-router.js";
import { CodexRpcDeliveryError, CodexRpcProtocolError, CodexRpcRemoteError, codexSteerRejectionReason } from "../rpc/errors.js";
import type { CodexInboundServerRequest, CodexRpcMethod, CodexRpcRequestOptions, CodexRpcRequestReceipt } from "../rpc/codex-rpc-client.js";
import {
  CODEX_RUNTIME_PROTOCOL_VERSION, codexRuntimeRequestKey, isCodexRuntimeRead,
  type CodexRuntimeAuthority, type CodexRuntimeConnection, type CodexRuntimeEvent,
  type CodexRuntimeOutcome, type CodexRuntimeSnapshot,
} from "./codex-runtime-protocol.js";

export interface CodexRuntimeAttachmentFailure {
  readonly stage: "receipt_record" | "receipt_acknowledge" | "thread_evict";
  readonly error: unknown;
  readonly operationId?: string;
  readonly method?: string;
}

/** Application-side facade over the enduring provider owner. Closing this
 * facade detaches only; registry lifecycle controls own remote termination. */
export class CodexRuntimeClient {
  readonly client: CodexSharedClientFacade;
  readonly serverRequests: CodexServerRequestRouter;
  readonly #connection: CodexRuntimeConnection;
  readonly #authority: CodexRuntimeAuthority;
  readonly #receipts: CodexRuntimeReceiptSink;
  readonly #onRuntimeVersionAssessment: (assessment: VerifiedCodexRuntimeVersion) => void;
  readonly #onAttachmentFailure: (failure: CodexRuntimeAttachmentFailure) => void;
  readonly #onIdleReleaseError: (error: unknown) => void;
  readonly #pending = new Map<string, { request: CodexInboundServerRequest; controller: AbortController; responding: boolean; response?: { result: unknown } }>();
  readonly #outcomes = new Map<string, CodexRuntimeOutcome>();
  readonly #acknowledgements = new Map<string, Promise<void>>();
  readonly #acknowledged = new Set<string>();
  readonly #deferredAttachmentFailures = new Map<string, CodexRuntimeAttachmentFailure>();
  // Suppress only already acknowledged no-effect outcomes still buffered on the
  // carrier. Durable accepted/unknown operations always consult SQLite.
  readonly #releasedRejections = new Map<string, string>();
  readonly #waiters = new Map<string, { notify(outcome: CodexRuntimeOutcome): void; disconnect(): void }>();
  #current: CodexReadyClientGeneration | undefined;
  #generation = 0;
  #providerGeneration = 0;
  readonly #generationOffset: number;
  #attached = false;
  #retry: ReturnType<typeof setInterval> | undefined;

  constructor(input: { connection: CodexRuntimeConnection; authority: CodexRuntimeAuthority; serverRequests?: CodexServerRequestRouter; generationOffset?: number; receipts: CodexRuntimeReceiptSink; onRuntimeVersionAssessment?: (assessment: VerifiedCodexRuntimeVersion) => void; onAttachmentFailure?: (failure: CodexRuntimeAttachmentFailure) => void; onIdleReleaseError?: (error: unknown) => void }) {
    this.#connection = input.connection;
    this.#authority = input.authority;
    this.#receipts = input.receipts;
    this.#onRuntimeVersionAssessment = input.onRuntimeVersionAssessment ?? (() => {});
    this.#onAttachmentFailure = input.onAttachmentFailure ?? (() => {});
    this.#onIdleReleaseError = input.onIdleReleaseError ?? (() => {});
    this.#generationOffset = input.generationOffset ?? 0;
    this.serverRequests = input.serverRequests ?? new CodexServerRequestRouter();
    this.client = new CodexSharedClientFacade({
      persistentSessions: {
        reattachThread: async (threadId, options) => {
          if (options.signal?.aborted) throw options.signal.reason;
          const started = performance.now();
          this.#diagnostic("stage_start", { stage: "thread_reattach", method: "thread/read" });
          const receipt = await this.#connection.reattachThread(this.#authority, threadId, options.timeoutMilliseconds).catch((error: unknown) => {
            this.#diagnostic("stage_failed", { stage: "thread_reattach", method: "thread/read", durationMs: performance.now() - started }, error);
            if (error instanceof CodexRpcRemoteError) throw new CodexRpcRemoteError({ ...error, message: error.message, generation: error.generation + this.#generationOffset });
            if (error instanceof CodexRpcProtocolError) throw new CodexRpcProtocolError(error.message, error.generation + this.#generationOffset, { cause: error });
            if (error instanceof CodexRpcDeliveryError) throw new CodexRpcDeliveryError({ ...error, code: error.message, generation: error.generation + this.#generationOffset, cause: error });
            throw new CodexRpcDeliveryError({ code: "codex_runtime_reattach_unavailable", delivery: "sent_outcome_unknown", generation: this.#generation, method: "thread/read", cause: error });
          });
          try {
            const result = receipt ? { ...receipt, generation: receipt.generation + this.#generationOffset, result: codexThreadResumeMethod.decodeResult(receipt.result) } : undefined;
            this.#diagnostic("stage_complete", { stage: "thread_reattach", method: "thread/read", durationMs: performance.now() - started, outcome: receipt ? "attached" : "absent" });
            return result;
          } catch (error) {
            this.#diagnostic("stage_failed", { stage: "reattach_decode", method: "thread/read", durationMs: performance.now() - started }, error);
            throw error;
          }
        },
        // Main shutdown/carrier loss preserves residency; only actual idle
        // eviction releases the execution host's retained conversation.
        detachThread: async (threadId, generation, evicted) => {
          if (!evicted) return;
          try { await this.#connection.evictThread(this.#authority, threadId, generation - this.#generationOffset); }
          catch (error) {
            // Main has released only its idle presentation. The authoritative
            // host retains residency unless it accepted this explicit release.
            try { this.#onIdleReleaseError(error); } catch { /* Diagnostics only. */ }
            this.#diagnostic("stage_failed", { stage: "thread_evict" }, error);
            this.#onAttachmentFailure({ stage: "thread_evict", error });
          }
        },
      },
      current: () => this.#current,
      latestGeneration: () => this.#generation,
      retireGeneration: (generation, reason) => {
        this.#diagnostic("generation_retire_requested", { generation, reason });
        return this.#connection.retire(this.#authority, generation - this.#generationOffset, reason);
      },
    });
  }

  async start(): Promise<void> {
    if (this.#attached) return;
    const buffered: CodexRuntimeEvent[] = [];
    let installed = false;
    const started = performance.now();
    this.#diagnostic("stage_start", { stage: "runtime_attach" });
    const snapshot = await this.#connection.attach(this.#authority, event => {
      if (installed) this.#receive(event); else buffered.push(event);
    }).catch(error => {
      this.#diagnostic("stage_failed", { stage: "runtime_attach", durationMs: performance.now() - started }, error);
      throw error;
    });
    if (snapshot.protocolVersion !== CODEX_RUNTIME_PROTOCOL_VERSION || snapshot.runtimeId !== this.#authority.runtimeId) throw new Error("codex_runtime_protocol_mismatch");
    this.#diagnostic("stage_complete", { stage: "runtime_attach", durationMs: performance.now() - started, outcomeCount: snapshot.outcomes.length, pendingRequestCount: snapshot.pendingRequests.length });
    this.#attached = true;
    const snapshotStarted = performance.now();
    try { await this.#installSnapshot(snapshot); }
    catch (error) {
      this.#diagnostic("stage_failed", { stage: "snapshot_install", durationMs: performance.now() - snapshotStarted }, error);
      throw error;
    }
    this.#diagnostic("stage_complete", { stage: "snapshot_install", durationMs: performance.now() - snapshotStarted });
    installed = true;
    for (const event of buffered) this.#receive(event);
    this.#retry = setInterval(() => this.#dispatchRequests(), 250);
    this.#retry.unref();
  }

  /** Carrier must call this immediately on loss, independently of close(). */
  disconnected(): void {
    this.#attached = false;
    this.#current = undefined;
    if (this.#retry) clearInterval(this.#retry);
    this.#retry = undefined;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    for (const waiter of this.#waiters.values()) waiter.disconnect();
    this.#waiters.clear();
    this.client.updateLifecycle({ state: "reconciling", generation: this.#generation });
  }

  async drainAcknowledgements(): Promise<void> {
    await Promise.all([...this.#acknowledgements.values()]);
  }

  async close(): Promise<void> {
    const attached = this.#attached;
    this.disconnected();
    if (attached) await this.#connection.detach(this.#authority);
    this.client.updateLifecycle({ state: "closed", generation: this.#generation });
  }

  /** Outcomes from a prior main process are exposed for durable application
   * reconciliation. They must only be acknowledged after that commit. */
  retainedOutcomes(): readonly CodexRuntimeOutcome[] { return [...this.#outcomes.values()]; }
  async acknowledgeRecoveredOutcome(operationId: string): Promise<void> {
    await this.#connection.acknowledge(this.#authority, operationId);
    this.#outcomes.delete(operationId);
  }

  async #installSnapshot(snapshot: CodexRuntimeSnapshot): Promise<void> {
    if (snapshot.runtimeAssessment) this.#onRuntimeVersionAssessment(snapshot.runtimeAssessment);
    this.#receipts.reconcileRecordedApplicationState(this.#authority);
    this.#outcomes.clear();
    for (const reference of snapshot.outcomes) {
      const outcome = await this.#connection.outcome(this.#authority, reference.operationId);
      this.#outcomes.set(outcome.operationId, outcome);
      if (outcome.status !== "pending") await this.#recordAndAcknowledge(outcome);
    }
    this.#receive({ type: "lifecycle", lifecycle: snapshot.lifecycle });
    for (const request of snapshot.pendingRequests) this.#receive({ type: "server_request", request });
  }

  #receive(event: CodexRuntimeEvent): void {
    if (!this.#attached) return;
    try { this.#receiveEvent(event); }
    catch (error) {
      this.#diagnostic("event_processing_failed", { stage: event.type }, error);
      throw error;
    }
  }

  #receiveEvent(event: CodexRuntimeEvent): void {
    switch (event.type) {
      case "runtime_assessment": this.#onRuntimeVersionAssessment(event.assessment); return;
      case "lifecycle": {
        this.#providerGeneration = event.lifecycle.generation;
        this.#generation = event.lifecycle.generation + this.#generationOffset;
        this.#diagnostic("provider_lifecycle", { outcome: event.lifecycle.state, reason: event.lifecycle.unavailableReason });
        if (event.lifecycle.state === "ready") {
          this.serverRequests.activateGeneration(this.#generation);
          this.#current = { generation: this.#generation, request: (method, params, options) => this.#request(method, params, options).then(receipt => receipt.result), requestWithReceipt: (method, params, options) => this.#request(method, params, options) };
        } else this.#current = undefined;
        this.client.updateLifecycle({ ...event.lifecycle, generation: this.#generation });
        return;
      }
      case "notification": {
        let notification = { ...event.notification, generation: event.notification.generation + this.#generationOffset };
        if (notification.kind === "decoded_notification") {
          const admission = admitCodexServerNotification(notification.method, notification.params);
          if (admission.status !== "decoded") throw new Error("codex_runtime_notification_invalid");
          notification = { ...notification, params: admission.params } as typeof notification;
        }
        this.client.forwardNotification(notification.generation, notification);
        this.#dispatchRequests();
        return;
      }
      case "server_request": {
        const request = { ...event.request, generation: event.request.generation + this.#generationOffset };
        const key = codexRuntimeRequestKey(request.generation, request.id);
        if (this.#pending.has(key)) return;
        const controller = new AbortController();
        const params = decodeCodexServerRequestParams(request.method, request.params);
        this.#pending.set(key, { request: { ...request, params, signal: controller.signal } as CodexInboundServerRequest, controller, responding: false });
        this.#dispatchRequests();
        return;
      }
      case "server_request_settled": {
        const key = codexRuntimeRequestKey(event.generation + this.#generationOffset, event.requestId);
        const pending = this.#pending.get(key);
        // Host settlement removes the forwarding request, not the provider's
        // approval confirmation. A submitted response still awaits the exact
        // serverRequest/resolved notification (or its bounded timeout).
        // Unanswered requests did expire/resolve elsewhere and must be aborted.
        if (pending && !pending.response) pending.controller.abort();
        this.#pending.delete(key);
        return;
      }
      case "outcome":
        this.#diagnostic("outcome_received", { operationId: event.outcome.operationId, method: event.outcome.method, outcome: event.outcome.status });
        this.#outcomes.set(event.outcome.operationId, event.outcome);
        if (event.outcome.status !== "pending") {
          void this.#recordAndAcknowledge(event.outcome).then(() => this.#waiters.get(event.outcome.operationId)?.notify(event.outcome), error => {
            this.disconnected();
            this.#onAttachmentFailure({ stage: "receipt_record", error, operationId: event.outcome.operationId, method: event.outcome.method });
          });
        }
        return;
    }
  }

  #dispatchRequests(): void {
    if (!this.#attached || !this.#current) return;
    for (const pending of this.#pending.values()) {
      if (pending.responding || !this.serverRequests.canHandleRequest(pending.request)) continue;
      pending.responding = true;
      const handler = this.serverRequests.handlersForGeneration(pending.request.generation)[pending.request.method] as ((request: CodexInboundServerRequest) => Promise<unknown>);
      const response = pending.response ? Promise.resolve(pending.response.result) : handler(pending.request);
      void response.then(async result => {
        pending.response = { result };
        if (pending.controller.signal.aborted || !this.#attached) return;
        await this.#connection.respond(this.#authority, { generation: pending.request.generation - this.#generationOffset, requestId: pending.request.id, result });
      }).catch(() => { pending.responding = false; });
    }
  }

  #acknowledge(operationId: string): Promise<void> {
    if (this.#acknowledged.has(operationId)) return Promise.resolve();
    const existing = this.#acknowledgements.get(operationId);
    if (existing) return existing;
    const started = performance.now();
    const acknowledgement = Promise.resolve().then(() => this.#connection.acknowledge(this.#authority, operationId)).then(() => {
      this.#diagnostic("stage_complete", { stage: "receipt_acknowledge", operationId, durationMs: performance.now() - started });
      this.#outcomes.delete(operationId);
      this.#acknowledged.add(operationId);
      while (this.#acknowledged.size > 4096) this.#acknowledged.delete(this.#acknowledged.values().next().value!);
    });
    this.#acknowledgements.set(operationId, acknowledgement);
    void acknowledgement.then(() => {
      this.#acknowledgements.delete(operationId);
    }, error => {
      this.#acknowledgements.delete(operationId);
      const failure: CodexRuntimeAttachmentFailure = { stage: "receipt_acknowledge", operationId, error };
      this.#diagnostic("stage_failed", { stage: failure.stage, operationId, durationMs: performance.now() - started, deferred: this.#waiters.has(operationId) }, error);
      if (this.#waiters.has(operationId)) this.#deferredAttachmentFailures.set(operationId, failure);
      else if (this.#attached) this.#onAttachmentFailure(failure);
    });
    return acknowledgement;
  }

  async #recordAndAcknowledge(outcome: CodexRuntimeOutcome): Promise<void> {
    if (outcome.status === "pending") return;
    const started = performance.now();
    try {
      const observation = receiptObservation(outcome);
      const released = this.#releasedRejections.get(outcome.operationId);
      if (released !== undefined) {
        if (released !== rejectedFingerprint(observation)) throw new Error("codex_runtime_receipt_outcome_conflict");
        this.#outcomes.delete(outcome.operationId);
        return;
      }
      this.#receipts.recordOutcome(this.#authority, observation);
      this.#diagnostic("stage_complete", { stage: "receipt_record", operationId: outcome.operationId, method: outcome.method, durationMs: performance.now() - started, outcome: outcome.status });
      // SQLite proves delivery before housekeeping begins. ACK latency or carrier
      // failure must not delay a known result or transform it into uncertainty.
      void this.#acknowledge(outcome.operationId);
    } catch (error) {
      this.#diagnostic("stage_failed", { stage: "receipt_record", operationId: outcome.operationId, method: outcome.method, durationMs: performance.now() - started }, error);
      throw error;
    }
  }

  #releaseHandledRejection(observation: CodexRuntimeReceiptObservation): void {
    const fingerprint = rejectedFingerprint(observation);
    if (fingerprint === undefined) return;
    // Keep proof until both the caller receives the rejection and the host has
    // dropped its outcome. A failed ACK leaves proof available on reconnect.
    void this.#acknowledge(observation.operationId).then(() => {
      if (!this.#receipts.releaseRejected(this.#authority, observation.operationId)) return;
      this.#releasedRejections.set(observation.operationId, fingerprint);
      while (this.#releasedRejections.size > 4096) this.#releasedRejections.delete(this.#releasedRejections.keys().next().value!);
    }).catch(() => {
      // Durable proof remains if ACK or local release failed; the next explicit
      // retry can replay the same rejection and try the handoff again.
    });
  }

  async #request<Params, Result>(specification: CodexRpcMethod<Params, Result>, params: Params, options: CodexRpcRequestOptions): Promise<CodexRpcRequestReceipt<Result>> {
    const generation = this.#generation;
    if (!this.#attached || options.signal?.aborted) throw new CodexRpcDeliveryError({ code: "codex_runtime_not_attached", delivery: "not_sent", generation, method: specification.method });
    const encoded = specification.encodeParams(params);
    let operationId = randomUUID() as string;
    if (options.runtimeCorrelation) {
      this.#receipts.reconcileRecordedApplicationState(this.#authority);
      const reserved = this.#receipts.reserve(this.#authority, {
        operationId, method: specification.method,
        requestFingerprint: createHash("sha256").update(JSON.stringify([specification.method, codexEnvironmentFingerprintInput(specification.method, encoded, options.environmentVariablesFingerprint)])).digest("hex"),
        correlation: options.runtimeCorrelation,
      });
      operationId = reserved.operationId;
      if (reserved.state !== "reserved") {
        const prior = reserved.outcome;
        // A persisted rejection remains a rejection. Do not transform a known
        // no-effect result into an uncertain steer on the next attempt.
        if (prior?.status === "failed") {
          this.#releaseHandledRejection({ status: "failed", operationId, method: specification.method,
            failure: { ...prior.failure, generation: prior.generation } });
          if (prior.failure.kind === "remote") throw new CodexRpcRemoteError({ code: prior.failure.code,
            rejectionReason: prior.failure.rejectionReason, message: "Codex previously rejected this operation.",
            generation, method: specification.method });
          throw new CodexRpcDeliveryError({ code: prior.failure.code, delivery: prior.failure.delivery, generation, method: specification.method });
        }
        throw new CodexRpcDeliveryError({ code: "codex_runtime_operation_already_recorded", delivery: "sent_outcome_unknown", generation, method: specification.method });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      const outcome = await new Promise<CodexRuntimeOutcome>((resolve, reject) => {
        const settle = (outcome: CodexRuntimeOutcome) => {
          if (outcome.status === "pending") return;
          if (isCodexRuntimeRead(specification.method)) { resolve(outcome); return; }
          void this.#recordAndAcknowledge(outcome).then(() => resolve(outcome), error => reject(new CodexRpcDeliveryError({ code: "codex_runtime_receipt_record_unconfirmed", delivery: "sent_outcome_unknown", generation, method: specification.method, cause: error })));
        };
        // Outcome events have already crossed the durable sink before notify.
        this.#waiters.set(operationId, { notify: resolve, disconnect: () => reject(new CodexRpcDeliveryError({ code: "codex_runtime_attachment_lost", delivery: "sent_outcome_unknown", generation, method: specification.method })) });
        abort = () => reject(new CodexRpcDeliveryError({ code: "codex_runtime_request_aborted", delivery: "sent_outcome_unknown", generation, method: specification.method }));
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, options.timeoutMilliseconds);
        timer.unref();
        void this.#connection.submit(this.#authority, { operationId, generation: this.#providerGeneration, method: specification.method, params: encoded, environmentVariablesFingerprint: options.environmentVariablesFingerprint, timeoutMilliseconds: options.timeoutMilliseconds }).then(settle, error => reject(error instanceof CodexRpcDeliveryError ? error : new CodexRpcDeliveryError({ code: "codex_runtime_submit_unconfirmed", delivery: "sent_outcome_unknown", generation, method: specification.method, cause: error })));
      });
      if (outcome.status === "pending") throw new Error("codex_runtime_pending_result");
      if (outcome.status === "failed") {
        if (options.runtimeCorrelation) this.#releaseHandledRejection(receiptObservation(outcome));
        if (outcome.failure.kind === "remote") throw new CodexRpcRemoteError({ ...outcome.failure, generation: outcome.failure.generation + this.#generationOffset });
        throw new CodexRpcDeliveryError({ ...outcome.failure, generation: outcome.failure.generation + this.#generationOffset });
      }
      const result = specification.decodeResult(outcome.receipt.result);
      // The compact durable receipt was committed before host acknowledgement;
      // application binding/submission reconciliation may complete later.
      return { ...outcome.receipt, generation: outcome.receipt.generation + this.#generationOffset, result };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.#waiters.delete(operationId);
      // A failed housekeeping ACK cannot disconnect this waiter before its
      // already durable native result reaches the caller.
      const failure = this.#deferredAttachmentFailures.get(operationId);
      if (this.#deferredAttachmentFailures.delete(operationId) && this.#attached) this.#onAttachmentFailure(failure!);
    }
  }

  #diagnostic(event: string, fields: AttachmentDiagnosticFields, error?: unknown): void {
    if (event === "stage_complete" && (fields.stage === "receipt_record" || fields.stage === "receipt_acknowledge") && (fields.durationMs ?? 0) < 1000) return;
    attachmentDiagnostic(event, { backendInstanceId: this.#authority.scope.backendInstanceId,
      executionEnvironmentId: this.#authority.scope.executionEnvironmentId, generation: this.#generation,
      controllerEpoch: Number(this.#authority.controllerId), ...fields }, error);
  }
}

function receiptObservation(outcome: Exclude<CodexRuntimeOutcome, { status: "pending" }>): CodexRuntimeReceiptObservation {
  if (outcome.status !== "failed" || outcome.failure.kind !== "remote") return outcome;
  const rejectionReason = codexSteerRejectionReason(outcome.failure);
  return { ...outcome, failure: { ...outcome.failure, ...(rejectionReason ? { rejectionReason } : {}) } };
}

function rejectedFingerprint(observation: CodexRuntimeReceiptObservation): string | undefined {
  const failure = observation.failure;
  if (observation.status !== "failed" || !failure ||
    (failure.kind === "delivery" ? failure.delivery !== "not_sent"
      : failure.code !== -32001 &&
        (observation.method !== "turn/steer" || failure.code !== -32600 || !failure.rejectionReason))) return undefined;
  return JSON.stringify([observation.method, failure.kind, failure.code, failure.generation,
    failure.delivery ?? null, failure.rejectionReason ?? null]);
}
