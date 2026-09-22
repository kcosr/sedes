import { codexEnvironmentFingerprintInput } from "./codex-runtime-environment-fingerprint.js";
import { CodexRuntimeSessions } from "./codex-runtime-sessions.js";
import type { VerifiedCodexRuntimeVersion } from "../codex-release-guard.js";
import { createHash } from "node:crypto";
import { sameProviderTransportScope, type ProviderTransportScope } from "../../../provider-protocol/transport/assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../../provider-protocol/transport/framed-message-limits.js";
import { CODEX_SERVER_REQUEST_METHODS, encodeCodexServerRequestResult } from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { CodexServerRequestRouter } from "../codex-server-request-router.js";
import type { CodexSharedClientFacade } from "../codex-client-facade.js";
import type { CodexInboundServerRequest, CodexServerRequestHandlers } from "../rpc/codex-rpc-client.js";
import { CodexRpcDeliveryError, CodexRpcRemoteError } from "../rpc/errors.js";
import {
  CODEX_RUNTIME_PROTOCOL_VERSION, codexRuntimeMethod, codexRuntimeRequestKey, isCodexRuntimeRead,
  type CodexRuntimeAuthority, type CodexRuntimeConnection, type CodexRuntimeEvent,
  type CodexRuntimeOutcome, type CodexRuntimePendingRequest,
} from "./codex-runtime-protocol.js";

type Pending = { request: CodexRuntimePendingRequest; resolve(value: unknown): void; reject(error: Error): void };
type Operation = { fingerprint: string; outcome: CodexRuntimeOutcome; bytes: number; generation: number; dispatched: boolean };

/** Supervisor/RPC ownership survives every upstream attachment. No transcript
 * journal: notification subscribers may disappear; receipts and live requests
 * remain bounded and are never evicted to admit new work. */
export class CodexRuntimeHost implements CodexRuntimeConnection {
  readonly serverRequests: CodexServerRequestRouter;
  readonly #scope: ProviderTransportScope;
  readonly #runtimeId: string;
  readonly #operations = new Map<string, Operation>();
  readonly #pending = new Map<string, Pending>();
  readonly #responses = new Map<string, string>();
  readonly #maximumOperations: number;
  readonly #maximumBytes: number;
  #retainedBytes = 0;
  #pendingBytes = 0;
  #runtimeAssessment: VerifiedCodexRuntimeVersion | null = null;
  #client: CodexSharedClientFacade | undefined;
  #sessions: CodexRuntimeSessions | undefined;
  #lastGeneration = 0;
  #reads = 0;
  #idleRequest: { authority: CodexRuntimeAuthority; generation: number; retire: () => Promise<void | boolean> } | undefined;
  #revision = 0;
  #accepting = true;
  #admissionRevision = 0;
  #abandoning = false;
  readonly #acknowledged = new Set<string>();
  // Account for actual queued inputs and retained outcomes. Four native calls
  // may finish above the admission high-water mark; their results remain
  // recoverable, and no further native calls dispatch until storage drains.
  readonly #mutations = new RuntimeRequestQueue(4);
  #attachment: { controllerId: string; listener(event: CodexRuntimeEvent): void } | undefined;
  #unsubscribe: (() => void)[] = [];

  constructor(input: { scope: ProviderTransportScope; runtimeId: string; maximumOperations?: number; maximumBytes?: number }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#runtimeId = input.runtimeId;
    this.#maximumOperations = input.maximumOperations ?? 128;
    this.#maximumBytes = input.maximumBytes ?? 512 * 1024 * 1024;
    if (!input.runtimeId || !Number.isSafeInteger(this.#maximumOperations) || this.#maximumOperations < 1 || this.#maximumBytes < MAXIMUM_PROVIDER_FRAME_BYTES) throw new Error("codex_runtime_limits_invalid");
    this.serverRequests = new RuntimeRequestRouter(request => this.#handleRequest(request));
  }

  get runtimeId(): string { return this.#runtimeId; }
  observeRuntimeVersion(assessment: VerifiedCodexRuntimeVersion): void {
    this.#runtimeAssessment = assessment;
    this.#emit({ type: "runtime_assessment", assessment });
  }

  bind(client: CodexSharedClientFacade): void {
    if (this.#client) throw new Error("codex_runtime_already_bound");
    this.#client = client;
    this.#sessions = new CodexRuntimeSessions(client);
    this.#unsubscribe = [
      client.subscribeLifecycle(lifecycle => {
        if (lifecycle.state === "idle" || lifecycle.generation !== this.#lastGeneration) { this.#sessions!.invalidate(); this.#lastGeneration = lifecycle.generation; this.#revision++; }
        this.#emit({ type: "lifecycle", lifecycle });
      }),
      client.subscribeNotifications(notification => { this.#sessions!.observeNotification(notification); this.#emit({ type: "notification", notification }); this.#retryIdle(); }),
    ];
  }

  async attach(authority: CodexRuntimeAuthority, listener: (event: CodexRuntimeEvent) => void) {
    this.#assertScope(authority);
    if (!authority.controllerId) throw new Error("codex_runtime_controller_invalid");
    this.cancelIdle();
    this.#attachment = { controllerId: authority.controllerId, listener };
    return {
      protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION,
      runtimeId: this.#runtimeId,
      lifecycle: this.#getClient().lifecycleSnapshot(),
      runtimeAssessment: this.#runtimeAssessment,
      pendingRequests: [...this.#pending.values()].map(entry => entry.request),
      outcomes: [...this.#operations.values()].map(({ outcome }) => ({ operationId: outcome.operationId, method: outcome.method, status: outcome.status })),
    } as const;
  }

  async evictThread(authority: CodexRuntimeAuthority, threadId: string, generation: number): Promise<void> {
    this.#assertAuthority(authority);
    this.#sessions?.evict(threadId, generation);
    this.#revision++;
  }

  cancelIdle(): void { this.#idleRequest = undefined; }

  async idle(authority: CodexRuntimeAuthority, generation: number, retire: () => Promise<void | boolean>): Promise<boolean> {
    this.#assertAuthority(authority);
    this.#idleRequest = { authority, generation, retire };
    return await this.#tryIdle();
  }

  async #tryIdle(): Promise<boolean> {
    const request = this.#idleRequest;
    if (!request || !this.#accepting || this.#attachment?.controllerId !== request.authority.controllerId ||
        request.generation !== this.#getClient().lifecycleSnapshot().generation ||
        this.#reads || this.unsettledCount() || !this.#sessions?.canIdle()) return false;
    this.#idleRequest = undefined;
    if (this.#getClient().lifecycleSnapshot().state === "idle") return true;
    this.freezeAdmission();
    const admissionRevision = this.#admissionRevision;
    try { return await request.retire() !== false; }
    finally { if (this.#admissionRevision === admissionRevision) this.restoreAdmission(); }
  }

  #retryIdle(): void {
    // Supervisor cleanup failures publish lifecycle/ownership failure; retain
    // them there without letting notification/receipt observers throw.
    if (this.#idleRequest) void this.#tryIdle().catch(() => undefined);
  }

  async detach(authority: CodexRuntimeAuthority): Promise<void> {
    this.#assertAuthority(authority);
    this.cancelIdle();
    this.#attachment = undefined;
  }

  isRetainedThreadRead(input: Parameters<CodexRuntimeConnection["submit"]>[1]): boolean {
    if (!["thread/read", "thread/turns/list", "thread/items/list", "thread/goal/get"].includes(input.method)) return false;
    const threadId = input.params && typeof input.params === "object" && "threadId" in input.params ? input.params.threadId : undefined;
    return typeof threadId === "string" && this.#sessions?.hasCurrent(threadId) === true;
  }

  async submit(authority: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["submit"]>[1]): Promise<CodexRuntimeOutcome> {
    this.#assertAuthority(authority);
    if (!this.#accepting) throw new CodexRpcDeliveryError({ code: "codex_runtime_draining", delivery: "not_sent", generation: input.generation, method: input.method });
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.operationId) || !Number.isSafeInteger(input.timeoutMilliseconds) || input.timeoutMilliseconds < 1 || input.timeoutMilliseconds > 24 * 60 * 60 * 1000) throw new Error("codex_runtime_request_invalid");
    const method = codexRuntimeMethod(input.method);
    const params = method.encodeParams(input.params);
    if (isCodexRuntimeRead(input.method)) return await this.#read(authority, input, method, params);
    const fingerprint = digest([input.generation, input.method, codexEnvironmentFingerprintInput(input.method, params, input.environmentVariablesFingerprint), input.timeoutMilliseconds]);
    if (this.#acknowledged.has(input.operationId)) throw new CodexRpcDeliveryError({ code: "codex_runtime_operation_acknowledged", delivery: "sent_outcome_unknown", generation: input.generation, method: input.method });
    const existing = this.#operations.get(input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("codex_runtime_operation_conflict");
      return existing.outcome;
    }
    const client = this.#getClient();
    if (client.lifecycleSnapshot().generation !== input.generation || client.lifecycleSnapshot().state !== "ready") throw new CodexRpcDeliveryError({ code: "codex_runtime_generation_unavailable", delivery: "not_sent", generation: input.generation, method: input.method });
    const inputBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    if (this.#operations.size >= this.#maximumOperations || this.#retainedBytes + this.#pendingBytes + inputBytes > this.#maximumBytes) throw new CodexRpcDeliveryError({ code: "codex_runtime_receipt_capacity_exceeded", delivery: "not_sent", generation: input.generation, method: input.method });
    const operation: Operation = { fingerprint, bytes: inputBytes, generation: input.generation, dispatched: false, outcome: { status: "pending", operationId: input.operationId, method: input.method } };
    this.#operations.set(input.operationId, operation);
    this.#revision++;
    this.#retainedBytes += operation.bytes;
    // Deliberately no carrier AbortSignal: timeout belongs to this admitted
    // operation, not to the lifetime of its caller's transport.
    const deadline = Date.now() + input.timeoutMilliseconds;
    void this.#mutations.run(async () => {
      const remaining = deadline - Date.now();
      // Accepted queued work survives carrier replacement, but never moves
      // across native generations or runs after its admission deadline.
      if (this.#abandoning || remaining <= 0 || client.lifecycleSnapshot().generation !== input.generation || client.lifecycleSnapshot().state !== "ready" || this.#retainedBytes + this.#pendingBytes > this.#maximumBytes) {
        throw new CodexRpcDeliveryError({ code: "codex_runtime_dispatch_unavailable", delivery: "not_sent", generation: input.generation, method: input.method });
      }
      operation.dispatched = true;
      const resume = input.method === "thread/resume"
        ? this.#sessions!.trackResume((params as { threadId: string }).threadId, input.generation) : undefined;
      try {
        const receipt = await client.requestWithReceipt(method, params, { timeoutMilliseconds: remaining });
        if (!this.#abandoning) {
          try {
            if (resume) resume.apply(receipt);
            else this.#sessions!.observeResult(input.method, receipt.result, receipt.generation);
          } catch { this.#sessions!.markUnknown(); }
        }
        return receipt;
      } finally { resume?.close(); }
    }).then(receipt => {
      if (this.#abandoning) return;
      this.#settle(operation, { status: "completed", operationId: input.operationId, method: input.method, receipt });
    }, error => {
      const failure = error instanceof CodexRpcRemoteError
        ? { kind: "remote" as const, code: error.code, message: error.message.slice(0, 8192), generation: error.generation, method: input.method, ...(error.data === undefined ? {} : { data: error.data }) }
        : { kind: "delivery" as const, code: error instanceof CodexRpcDeliveryError ? error.message : "codex_runtime_outcome_unknown", delivery: error instanceof CodexRpcDeliveryError ? error.delivery : "sent_outcome_unknown" as const, generation: input.generation, method: input.method };
      this.#settle(operation, { status: "failed", operationId: input.operationId, method: input.method, failure });
    });
    return operation.outcome;
  }

  async outcome(authority: CodexRuntimeAuthority, operationId: string): Promise<CodexRuntimeOutcome> {
    this.#assertAuthority(authority);
    return this.readRetainedOutcome(operationId);
  }

  /** Sidecar composition calls these only after service-controller and scope
   * checks. Receipt recovery does not replace a live event subscription. */
  retainedOutcomeReferences(): readonly Pick<CodexRuntimeOutcome, "operationId" | "method" | "status">[] {
    return [...this.#operations.values()].map(({ outcome }) => ({ operationId: outcome.operationId, method: outcome.method, status: outcome.status }));
  }
  readRetainedOutcome(operationId: string): CodexRuntimeOutcome {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("codex_runtime_operation_unknown");
    return operation.outcome;
  }

  async acknowledge(authority: CodexRuntimeAuthority, operationId: string): Promise<void> {
    this.#assertAuthority(authority);
    this.acknowledgeRetainedOutcome(operationId);
  }
  acknowledgeRetainedOutcome(operationId: string): void {
    const operation = this.#operations.get(operationId);
    if (!operation) return;
    if (operation.outcome.status === "pending") throw new Error("codex_runtime_operation_pending");
    this.#acknowledged.add(operationId);
    // Main's durable, application-correlated receipt fences critical mutations
    // after ACK. This short transport replay window must not permanently fill
    // a resident service with already-consumed ids.
    if (this.#acknowledged.size > 4096) this.#acknowledged.delete(this.#acknowledged.values().next().value!);
    this.#operations.delete(operationId);
    this.#revision++;
    this.#retainedBytes -= operation.bytes;
    this.#retryIdle();
  }

  async respond(authority: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["respond"]>[1]): Promise<void> {
    this.#assertAuthority(authority);
    const key = codexRuntimeRequestKey(input.generation, input.requestId);
    const responseFingerprint = digest(input.result);
    const settled = this.#responses.get(key);
    if (settled) {
      if (settled !== responseFingerprint) throw new Error("codex_runtime_response_conflict");
      return;
    }
    if (!this.#accepting) throw new Error("codex_runtime_draining");
    const pending = this.#pending.get(key);
    if (!pending) throw new Error("codex_runtime_server_request_unknown");
    const result = encodeCodexServerRequestResult(pending.request.method, input.result);
    if (this.#responses.size >= this.#maximumOperations) {
      const oldestSettled = [...this.#responses.keys()].find(candidate => !this.#pending.has(candidate));
      if (!oldestSettled) throw new Error("codex_runtime_response_capacity_exceeded");
      this.#responses.delete(oldestSettled);
    }
    this.#responses.set(key, responseFingerprint);
    pending.resolve(result);
  }

  async reattachThread(authority: CodexRuntimeAuthority, threadId: string, timeoutMilliseconds: number) {
    this.#assertAuthority(authority);
    if (!this.#accepting) throw new Error("codex_runtime_draining");
    this.#reads++;
    try { return await this.#sessions!.reattach(threadId, { timeoutMilliseconds }); }
    finally { this.#reads--; this.#retryIdle(); }
  }

  async #read(authority: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["submit"]>[1],
    method: ReturnType<typeof codexRuntimeMethod>, params: unknown): Promise<CodexRuntimeOutcome> {
    let dispatched = false;
    this.#reads++;
    try {
      // Reads use the native client's existing pending-request bound. An
      // additional relay queue would make unrelated threads wait without
      // bounding the later body transfer, which has its own byte limits.
      this.#assertAuthority(authority);
      if (!this.#accepting || this.#getClient().lifecycleSnapshot().state !== "ready" || this.#getClient().lifecycleSnapshot().generation !== input.generation) {
        throw new CodexRpcDeliveryError({ code: "codex_runtime_read_unavailable", delivery: "not_sent", generation: input.generation, method: input.method });
      }
      dispatched = true;
      const receipt = await this.#getClient().requestWithReceipt(method, params, { timeoutMilliseconds: input.timeoutMilliseconds });
      return { status: "completed", operationId: input.operationId, method: input.method, receipt };
    } catch (error) {
      const failure = error instanceof CodexRpcRemoteError
        ? { kind: "remote" as const, code: error.code, message: error.message.slice(0, 8192), generation: error.generation, method: input.method, ...(error.data === undefined ? {} : { data: error.data }) }
        : { kind: "delivery" as const, code: error instanceof CodexRpcDeliveryError ? error.message : "codex_runtime_read_unavailable", delivery: error instanceof CodexRpcDeliveryError ? error.delivery : dispatched ? "sent_outcome_unknown" as const : "not_sent" as const, generation: input.generation, method: input.method };
      return { status: "failed", operationId: input.operationId, method: input.method, failure };
    } finally { this.#reads--; this.#retryIdle(); }
  }

  async retire(authority: CodexRuntimeAuthority, generation: number, reason: string): Promise<void> {
    this.#assertAuthority(authority);
    await this.#getClient().retireGeneration(generation, reason);
  }

  /** The runtime registry uses this conservative blocker count. Native active
   * turns and independently active external clients require additional provider
   * inspection; absence here alone never proves upgrade safety. */
  assertAuthority(authority: CodexRuntimeAuthority): void { this.#assertAuthority(authority); }
  assertScope(authority: CodexRuntimeAuthority): void { this.#assertScope(authority); }
  freezeAdmission(): void { this.#admissionRevision++; this.#accepting = false; }
  restoreAdmission(): void { this.#admissionRevision++; if (!this.#abandoning) this.#accepting = true; }
  abandonmentEvidence() {
    return { revision: this.revision(), activity: this.activity(),
      operations: [...this.#operations.values()].map(({ outcome, generation, dispatched }) => ({ operationId: outcome.operationId, method: outcome.method, status: outcome.status, generation, dispatched,
        ...(outcome.status === "failed" ? { failure: outcome.failure.kind === "delivery" ? { kind: outcome.failure.kind, code: outcome.failure.code, delivery: outcome.failure.delivery } : { kind: outcome.failure.kind, code: outcome.failure.code } } : {}) })),
      pendingRequests: [...this.#pending.values()].map(({ request }) => ({ id: request.id, generation: request.generation, method: request.method })) };
  }
  /** Explicit abandonment settles callers without claiming sent work failed to
   * execute. Native shutdown still owns termination and process cleanup proof. */
  abandonPendingWork(): void {
    this.#abandoning = true;
    this.freezeAdmission();
    for (const operation of this.#operations.values()) {
      if (operation.outcome.status !== "pending") continue;
      this.#settle(operation, { status: "failed", operationId: operation.outcome.operationId, method: operation.outcome.method,
        failure: { kind: "delivery", code: "codex_runtime_operator_stopped", delivery: operation.dispatched ? "sent_outcome_unknown" : "not_sent", generation: operation.generation, method: operation.outcome.method } });
    }
    for (const pending of this.#pending.values()) pending.reject(new Error("codex_runtime_operator_stopped"));
  }
  async interruptOwnedActiveTurns(): Promise<void> { await this.#sessions?.interruptKnownActiveTurns(); }
  pendingOutcomeCount(): number { return this.#operations.size; }
  pendingInteractionCount(): number { return this.#pending.size; }
  activity() { return this.#sessions?.activity() ?? "unknown"; }
  async prepareRestart(): Promise<void> {
    // Refresh invalidates its previous evidence before issuing native reads.
    // Any unsupported/incomplete/error result remains explicitly unknown.
    if (this.#getClient().lifecycleSnapshot().state === "idle") return;
    this.#reads++;
    try { await this.#sessions?.refreshActivity(); } catch { /* unknown */ }
    finally { this.#reads--; this.#retryIdle(); }
  }
  revision(): string { return digest([this.#revision, this.#sessions?.revision(), [...this.#pending.keys()]]); }
  unsettledCount(): number { return this.#pending.size + this.#operations.size; }

  dispose(): void {
    this.cancelIdle();
    this.#attachment = undefined;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    for (const pending of this.#pending.values()) pending.reject(new Error("codex_runtime_stopped"));
  }

  #getClient(): CodexSharedClientFacade {
    if (!this.#client) throw new Error("codex_runtime_not_bound");
    return this.#client;
  }
  #assertScope(authority: CodexRuntimeAuthority): void {
    if (authority.runtimeId !== this.#runtimeId || !sameProviderTransportScope(authority.scope, this.#scope)) throw new Error("codex_runtime_scope_denied");
  }
  #assertAuthority(authority: CodexRuntimeAuthority): void {
    this.#assertScope(authority);
    if (!this.#attachment || this.#attachment.controllerId !== authority.controllerId) throw new Error("codex_runtime_controller_stale");
  }
  #emit(event: CodexRuntimeEvent): void {
    try { this.#attachment?.listener(event); } catch { this.#attachment = undefined; }
  }
  #settle(operation: Operation, outcome: CodexRuntimeOutcome): void {
    if (operation.outcome.status !== "pending") return;
    this.#retainedBytes -= operation.bytes;
    operation.bytes = Buffer.byteLength(JSON.stringify(outcome), "utf8");
    this.#retainedBytes += operation.bytes;
    operation.outcome = outcome;
    this.#revision++;
    this.#emit({ type: "outcome", outcome });
  }
  async #handleRequest(request: CodexInboundServerRequest): Promise<unknown> {
    if (this.#abandoning) throw new Error("codex_runtime_operator_stopped");
    if (request.method === "item/tool/call") return { contentItems: [], success: false };
    if (request.method === "account/chatgptAuthTokens/refresh" || request.method === "attestation/generate") throw new Error("codex_runtime_request_unsupported");
    if (request.signal.aborted) throw new Error("codex_runtime_request_expired");
    if (this.#pending.size >= this.#maximumOperations) throw new Error("codex_runtime_pending_capacity_exceeded");
    const { signal, ...wire } = request;
    const bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
    // An attach snapshot includes every pending interaction. Keep their total
    // below one native frame; the body channel reserves envelope headroom.
    if (this.#pendingBytes + bytes > MAXIMUM_PROVIDER_FRAME_BYTES) throw new Error("codex_runtime_pending_capacity_exceeded");
    if (this.#retainedBytes + this.#pendingBytes + bytes > this.#maximumBytes) throw new Error("codex_runtime_pending_capacity_exceeded");
    const key = codexRuntimeRequestKey(request.generation, request.id);
    if (this.#pending.has(key)) throw new Error("codex_runtime_request_duplicate");
    this.#pendingBytes += bytes;
    let abort = () => {};
    try {
      return await new Promise((resolve, reject) => {
        this.#pending.set(key, { request: wire, resolve, reject });
        this.#revision++;
        abort = () => reject(new Error("codex_runtime_request_expired"));
        signal.addEventListener("abort", abort, { once: true });
        this.#emit({ type: "server_request", request: wire });
      });
    } finally {
      signal.removeEventListener("abort", abort);
      this.#pending.delete(key);
      this.#pendingBytes -= bytes;
      this.#revision++;
      this.#emit({ type: "server_request_settled", generation: request.generation, requestId: request.id });
      this.#retryIdle();
    }
  }
}

/** A free slot always takes the oldest waiting call. Assigning requests to
 * fixed promise lanes would leave free slots idle behind an unrelated slow
 * request in one lane. Admission and retained-byte limits belong to the host. */
class RuntimeRequestQueue {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(readonly maximumRunning: number) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.#running++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.#running--;
          this.#waiting.shift()?.();
        });
      };
      if (this.#running < this.maximumRunning) start();
      else this.#waiting.push(start);
    });
  }
}

class RuntimeRequestRouter extends CodexServerRequestRouter {
  constructor(readonly receive: (request: CodexInboundServerRequest) => Promise<unknown>) { super(); }
  override handlersForGeneration(_generation: number): CodexServerRequestHandlers {
    return Object.fromEntries(CODEX_SERVER_REQUEST_METHODS.map(method => [method, this.receive])) as CodexServerRequestHandlers;
  }
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
