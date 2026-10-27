import { randomUUID } from "node:crypto";
import { attachmentDiagnostic, type AttachmentDiagnosticFields } from "../../../../diagnostics/attachment-diagnostics.js";
import {
  FrameWriteError,
  isValidFramedTransportAssurance,
  sameProviderTransportScope,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type ProviderTransportScope,
} from "../../../../provider-protocol/transport/assured-framed-transport.js";
import {
  parsePiRpcCommand,
  parsePiRpcRecord,
  parsePiRpcUIResponse,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcExtensionUIRequest,
  type PiRpcExtensionUIResponse,
  type PiRpcResult,
} from "./pi-rpc-wire.js";

export type PiRpcDelivery = "not_sent" | "sent_outcome_unknown" | "rejected";
export class PiRpcCallError extends Error {
  constructor(readonly code: string, readonly delivery: PiRpcDelivery, options?: ErrorOptions) {
    super(code, options);
    this.name = "PiRpcCallError";
  }
}
export interface PiRpcRequestOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number | null;
}
type Pending = {
  readonly command: PiRpcCommand["type"];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PiRpcCallError) => void;
  delivery: "not_sent" | "sent_outcome_unknown";
  cleanup(): void;
};
export type PiNativeDiagnosticContext = Pick<AttachmentDiagnosticFields,
  "attachmentId" | "runtimeId" | "handleId" | "handleGeneration" | "backendInstanceId" | "executionEnvironmentId" | "role">;

/** A native, non-JSON-RPC protocol over an already assured owned channel.
 * Reads continuously, independently of consumers, and never resends mutations.
 */
export class PiRpcClient {
  readonly closed: Promise<FramedTransportClosure>;
  readonly #transport: FramedMessageTransport;
  readonly #pending = new Map<string, Pending>();
  readonly #retired = new Set<string>();
  readonly #listeners = new Set<(event: PiRpcEvent | PiRpcExtensionUIRequest) => void>();
  readonly #resolveClosed: (closure: FramedTransportClosure) => void;
  readonly #diagnostic: PiNativeDiagnosticContext;
  #closure?: FramedTransportClosure;
  #closing?: Promise<void>;
  #requestedClose = false;

  constructor(input: { readonly transport: FramedMessageTransport; readonly scope: ProviderTransportScope; readonly connectionGeneration: number; readonly diagnostic?: PiNativeDiagnosticContext }) {
    if (!isValidFramedTransportAssurance(input.transport.assurance) ||
      input.transport.assurance.kind !== "owned_process" ||
      !sameProviderTransportScope(input.scope, input.transport.assurance.scope) ||
      input.transport.assurance.connectionGeneration !== input.connectionGeneration) {
      throw new PiRpcCallError("pi_rpc_transport_assurance_invalid", "not_sent");
    }
    this.#transport = input.transport;
    this.#diagnostic = { ...input.diagnostic, backendInstanceId: input.scope.backendInstanceId,
      executionEnvironmentId: input.scope.executionEnvironmentId, attachmentId: input.diagnostic?.attachmentId ?? randomUUID() };
    let resolveClosed!: (closure: FramedTransportClosure) => void;
    this.closed = new Promise((resolve) => { resolveClosed = resolve; });
    this.#resolveClosed = resolveClosed;
    // Process cleanup can settle after an earlier protocol failure. Preserve
    // the carrier's own closure independently of the client admission state.
    void this.#transport.closed.then(closure => attachmentDiagnostic("pi_rpc_transport_closed", {
      ...this.#diagnostic, reason: closure.reason, requestedClose: this.#requestedClose,
    }, closure.cause), error => attachmentDiagnostic("pi_rpc_transport_failed", this.#diagnostic, error));
    void this.#read();
  }

  subscribe(listener: (event: PiRpcEvent | PiRpcExtensionUIRequest) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request<C extends PiRpcCommand>(command: C, options: PiRpcRequestOptions = {}): Promise<PiRpcResult<C["type"]>> {
    let parsed: PiRpcCommand;
    try { parsed = parsePiRpcCommand(command); }
    catch (cause) { return Promise.reject(new PiRpcCallError("pi_rpc_command_invalid", "not_sent", { cause })); }
    if (this.#closure || this.#closing) return Promise.reject(new PiRpcCallError("pi_rpc_closed", "not_sent"));
    if (options.signal?.aborted) return Promise.reject(new PiRpcCallError("pi_rpc_request_aborted", "not_sent"));
    const remaining = options.deadlineAt === null ? null : (options.deadlineAt ?? Date.now() + 30_000) - Date.now();
    if (remaining !== null && (!Number.isFinite(remaining) || remaining <= 0)) return Promise.reject(new PiRpcCallError("pi_rpc_request_expired", "not_sent"));
    if (this.#pending.size >= 128) return Promise.reject(new PiRpcCallError("pi_rpc_pending_limit", "not_sent"));
    const id = randomUUID();
    return new Promise<PiRpcResult<C["type"]>>((resolve, reject) => {
      const timer = remaining === null ? undefined : setTimeout(() => fail("pi_rpc_request_timeout"), Math.min(remaining, 2_147_483_647));
      const abort = () => fail("pi_rpc_request_aborted");
      const pending: Pending = {
        command: parsed.type, delivery: "not_sent",
        resolve: (value) => resolve(value as PiRpcResult<C["type"]>), reject,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); },
      };
      const fail = (code: string) => {
        if (!this.#pending.delete(id)) return;
        pending.cleanup();
        this.#retire(id);
        reject(new PiRpcCallError(code, pending.delivery));
      };
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      // While a write is in progress, its outcome is unknown. The transport
      // alone can prove not_sent; timeouts or connection loss cannot.
      pending.delivery = "sent_outcome_unknown";
      void this.#transport.send(JSON.stringify({ ...parsed, id }), { signal: options.signal }).catch((cause: unknown) => {
        if (!this.#pending.delete(id)) return;
        pending.cleanup();
        this.#retire(id);
        reject(new PiRpcCallError("pi_rpc_write_failed", cause instanceof FrameWriteError ? cause.delivery : "sent_outcome_unknown", { cause }));
      });
    });
  }

  async respondUI(response: PiRpcExtensionUIResponse, options: PiRpcRequestOptions = {}): Promise<void> {
    let parsed: PiRpcExtensionUIResponse;
    try { parsed = parsePiRpcUIResponse(response); }
    catch (cause) { throw new PiRpcCallError("pi_rpc_ui_response_invalid", "not_sent", { cause }); }
    if (this.#closure || this.#closing) throw new PiRpcCallError("pi_rpc_closed", "not_sent");
    if (typeof options.deadlineAt === "number" && options.deadlineAt <= Date.now()) throw new PiRpcCallError("pi_rpc_request_expired", "not_sent");
    try { await this.#transport.send(JSON.stringify(parsed), { signal: options.signal }); }
    catch (cause) { throw new PiRpcCallError("pi_rpc_write_failed", cause instanceof FrameWriteError ? cause.delivery : "sent_outcome_unknown", { cause }); }
  }

  close(reason = "pi_rpc_client_closed"): Promise<void> {
    if (!this.#requestedClose) {
      attachmentDiagnostic("pi_rpc_close_requested", { ...this.#diagnostic, reason, pendingRequestCount: this.#pending.size });
      this.#requestedClose = true;
    }
    this.#closing ??= this.#transport.close(reason).then(() => this.#finish({ reason }), (error: unknown) => {
      // A failed cleanup permanently ends protocol admission, but callers may
      // explicitly retry process cleanup while retaining the writer lease.
      this.#closing = undefined;
      attachmentDiagnostic("pi_rpc_cleanup_failed", { ...this.#diagnostic, reason }, error);
      this.#finish({ reason });
      throw error;
    });
    return this.#closing;
  }

  async #read(): Promise<void> {
    let stage = "transport_read";
    try {
      for await (const frame of this.#transport.frames) {
        stage = "record_validation";
        const record = parsePiRpcRecord(frame.text);
        if (record.type === "response") {
          stage = "response_correlation";
          if (!record.id) throw new Error("pi_rpc_uncorrelated_response");
          const pending = this.#pending.get(record.id);
          if (!pending) {
            if (this.#retired.has(record.id)) { stage = "transport_read"; continue; }
            throw new Error("pi_rpc_response_id_unknown");
          }
          if (pending.command !== record.command) throw new Error("pi_rpc_response_command_mismatch");
          this.#pending.delete(record.id);
          pending.cleanup();
          this.#retire(record.id);
          if (record.success) pending.resolve(record.data);
          else pending.reject(new PiRpcCallError("pi_rpc_command_rejected", "rejected", { cause: new Error(record.error) }));
        } else {
          stage = "listener";
          for (const listener of [...this.#listeners]) listener(record);
        }
        stage = "transport_read";
      }
      // Drain every already-admitted response before observing process exit.
      // The carrier may close while its final frames are still in the queue.
      this.#finish(await this.#transport.closed);
    } catch (cause) {
      attachmentDiagnostic("pi_rpc_protocol_failed", { ...this.#diagnostic,
        stage: stage === "record_validation" && cause instanceof SyntaxError ? "json_decode" : stage,
        pendingRequestCount: this.#pending.size }, cause);
      const error = cause instanceof Error ? cause : new Error("pi_rpc_protocol_failed");
      this.#finish({ reason: "pi_rpc_protocol_failed", cause: error });
      void this.close("pi_rpc_protocol_failed").catch(() => undefined);
    }
  }

  #retire(id: string): void {
    this.#retired.add(id);
    if (this.#retired.size > 1024) this.#retired.delete(this.#retired.values().next().value!);
  }
  #finish(closure: FramedTransportClosure): void {
    if (this.#closure) return;
    attachmentDiagnostic("pi_rpc_closed", { ...this.#diagnostic, reason: closure.reason,
      requestedClose: this.#requestedClose, pendingRequestCount: this.#pending.size }, closure.cause);
    this.#closure = closure;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new PiRpcCallError(closure.reason, pending.delivery, { cause: closure.cause }));
    }
    this.#pending.clear();
    this.#resolveClosed(closure);
  }
}
