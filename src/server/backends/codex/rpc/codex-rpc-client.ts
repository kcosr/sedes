import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  FrameWriteError,
  isValidFramedTransportAssurance,
  sameProviderTransportScope,
  type ProviderTransportScope,
  type FramedMessageTransport,
  type FramedTransportClosure,
} from "../../../provider-protocol/transport/assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../../provider-protocol/transport/framed-message-limits.js";
import {
  admitCodexServerNotification,
  decodeCodexServerRequestParams,
  encodeCodexClientNotification,
  encodeCodexServerRequestResult,
} from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./errors.js";
import {
  isCodexClientRequestMethod,
  isCodexServerNotificationMethod,
  isCodexServerRequestMethod,
  type CodexClientRequestMethod,
  type CodexServerNotificationMethod,
  type CodexServerRequestMethod,
} from "./protocol.js";

const DEFAULT_MAX_FRAME_BYTES = MAXIMUM_PROVIDER_FRAME_BYTES;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_ACTIVE_SERVER_REQUESTS = 128;
const DEFAULT_MAX_TOMBSTONES = 1_024;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_SEND_SETTLE_MILLISECONDS = 250;
const MAX_SERVER_REQUEST_ID_BYTES = 256;

let processRequestSequence = 0n;

type RequestId = string | number;

type RpcErrorEnvelope = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

export interface CodexRpcMethod<Params, Result> {
  readonly method: CodexClientRequestMethod;
  encodeParams(params: Params): unknown;
  decodeResult(result: unknown): Result;
}

export function defineCodexRpcMethod<Params, Result>(
  specification: CodexRpcMethod<Params, Result>,
): CodexRpcMethod<Params, Result> {
  return Object.freeze({ ...specification });
}

export interface CodexInboundServerRequest<
  Method extends CodexServerRequestMethod = CodexServerRequestMethod,
> {
  readonly generation: number;
  readonly sequence: number;
  readonly id: RequestId;
  readonly method: Method;
  readonly params: unknown;
  readonly trace?: unknown;
  readonly signal: AbortSignal;
}

export type CodexServerRequestHandler<
  Method extends CodexServerRequestMethod = CodexServerRequestMethod,
> = (request: CodexInboundServerRequest<Method>) => unknown | Promise<unknown>;

export type CodexServerRequestHandlers = {
  readonly [
    Method in CodexServerRequestMethod
  ]?: CodexServerRequestHandler<Method>;
};

export const CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE =
  "codex_rpc_notification_params_undecodable" as const;

export interface CodexRpcDecodedNotification {
  readonly kind: "decoded_notification";
  readonly generation: number;
  readonly sequence: number;
  readonly method: CodexServerNotificationMethod;
  readonly params: unknown;
  readonly emittedAtMs?: number;
}

export interface CodexRpcUndecodableNotification {
  readonly kind: "undecodable_notification";
  readonly generation: number;
  readonly sequence: number;
  readonly method: CodexServerNotificationMethod;
  readonly nativeThreadId: string;
  readonly code: typeof CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE;
}

export type CodexRpcNotification =
  CodexRpcDecodedNotification | CodexRpcUndecodableNotification;

export function isCodexRpcUndecodableNotification(
  notification: CodexRpcNotification,
): notification is CodexRpcUndecodableNotification {
  return notification.kind === "undecodable_notification";
}

export interface CodexRpcClientOptions {
  readonly transport: FramedMessageTransport;
  readonly expectedScope: ProviderTransportScope;
  readonly generation: number;
  readonly runtimeNonce?: string;
  readonly handlers?: CodexServerRequestHandlers;
  readonly limits?: {
    readonly maxFrameBytes?: number;
    readonly maxPendingRequests?: number;
    readonly maxActiveServerRequests?: number;
    readonly maxTombstones?: number;
    readonly serverRequestTimeoutMilliseconds?: number;
    readonly sendSettleMilliseconds?: number;
  };
}

export interface CodexRpcRequestOptions {
  /** Definitions-only identity for remote idempotency; never native wire. */
  readonly environmentVariablesFingerprint?: string;
  /** Application correlation for durable remote outcome delivery; never native wire. */
  readonly runtimeCorrelation?: {
    readonly kind: "create" | "fork" | "start" | "steer";
    readonly applicationOperationId: string;
    readonly applicationThreadId: string;
  };
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal;
}

export interface CodexRpcRequestReceipt<Result> {
  readonly result: Result;
  readonly generation: number;
  /** Sequence of the response within this connection generation. */
  readonly inboundSequence: number;
}

export interface CodexRpcClosure {
  readonly generation: number;
  readonly reason: string;
  readonly cause?: Error;
}

interface PendingRequest {
  readonly id: string;
  readonly method: CodexClientRequestMethod;
  readonly decodeResult: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly sendController: AbortController;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  phase: "sending" | "sent";
  cancellationCode?: "codex_rpc_request_aborted" | "codex_rpc_request_timeout";
}

interface ActiveServerRequest {
  readonly key: string;
  readonly id: RequestId;
  readonly method: CodexServerRequestMethod;
  readonly params: unknown;
  readonly controller: AbortController;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type RequestTombstone = "late_allowed" | "settled";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.hasOwn(value, key);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRequestId(value: unknown): value is RequestId {
  return (
    (typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= MAX_SERVER_REQUEST_ID_BYTES) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function requestKey(id: RequestId): string {
  return `${typeof id === "string" ? "s" : "n"}:${String(id)}`;
}

function isRpcError(value: unknown): value is RpcErrorEnvelope {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, new Set(["code", "message", "data"])) &&
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string"
  );
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function errorFromUnknown(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export class CodexRpcClient {
  readonly generation: number;
  readonly closed: Promise<CodexRpcClosure>;

  readonly #transport: FramedMessageTransport;
  readonly #runtimeNonce: string;
  readonly #handlers: CodexServerRequestHandlers;
  readonly #maxFrameBytes: number;
  readonly #maxPendingRequests: number;
  readonly #maxActiveServerRequests: number;
  readonly #maxTombstones: number;
  readonly #serverRequestTimeoutMilliseconds: number;
  readonly #sendSettleMilliseconds: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #requestTombstones = new Map<string, RequestTombstone>();
  readonly #activeServerRequests = new Map<string, ActiveServerRequest>();
  readonly #serverRequestTombstones = new Map<string, true>();
  readonly #notificationListeners = new Set<
    (notification: CodexRpcNotification) => void
  >();
  readonly #resolveClosed: (closure: CodexRpcClosure) => void;
  #transportClosure: FramedTransportClosure | undefined;
  #logicalClosure: CodexRpcClosure | undefined;
  #closedResolved = false;
  #started = false;
  #terminated = false;
  #inboundSequence = 0;
  #termination:
    | {
        readonly closure: CodexRpcClosure;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(options: CodexRpcClientOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
      throw new Error("codex_rpc_generation_invalid");
    }
    if (!isValidFramedTransportAssurance(options.transport.assurance)) {
      throw new Error("codex_rpc_transport_assurance_invalid");
    }
    if (
      !sameProviderTransportScope(
        options.expectedScope,
        options.transport.assurance.scope,
      )
    ) {
      throw new Error("codex_rpc_transport_scope_mismatch");
    }
    if (
      options.transport.assurance.connectionGeneration !== options.generation
    ) {
      throw new Error("codex_rpc_transport_generation_mismatch");
    }
    this.generation = options.generation;
    this.#transport = options.transport;
    this.#runtimeNonce = options.runtimeNonce ?? randomUUID();
    this.#handlers = { ...options.handlers };
    this.#maxFrameBytes = positiveInteger(
      options.limits?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "codex_rpc_max_frame_bytes_invalid",
    );
    if (this.#maxFrameBytes > options.transport.maximumFrameBytes) {
      throw new Error("codex_rpc_transport_frame_capacity_invalid");
    }
    this.#maxPendingRequests = positiveInteger(
      options.limits?.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      "codex_rpc_max_pending_requests_invalid",
    );
    this.#maxActiveServerRequests = positiveInteger(
      options.limits?.maxActiveServerRequests ??
        DEFAULT_MAX_ACTIVE_SERVER_REQUESTS,
      "codex_rpc_max_active_server_requests_invalid",
    );
    this.#maxTombstones = positiveInteger(
      options.limits?.maxTombstones ?? DEFAULT_MAX_TOMBSTONES,
      "codex_rpc_max_tombstones_invalid",
    );
    this.#serverRequestTimeoutMilliseconds = positiveInteger(
      options.limits?.serverRequestTimeoutMilliseconds ??
        DEFAULT_SERVER_REQUEST_TIMEOUT_MILLISECONDS,
      "codex_rpc_server_request_timeout_invalid",
    );
    this.#sendSettleMilliseconds = positiveInteger(
      options.limits?.sendSettleMilliseconds ??
        DEFAULT_SEND_SETTLE_MILLISECONDS,
      "codex_rpc_send_settle_timeout_invalid",
    );
    let resolveClosed!: (closure: CodexRpcClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  start(): void {
    if (this.#started) throw new Error("codex_rpc_client_already_started");
    if (this.#terminated) throw new Error("codex_rpc_client_closed");
    this.#started = true;
    void this.#readFrames();
    void this.#transport.closed.then(
      (closure) => {
        this.#transportClosure = closure;
        this.#terminate(
          closure.reason,
          closure.cause ?? new Error("codex_rpc_transport_closed"),
        );
        this.#finishClosedIfSettled();
      },
      (error: unknown) => {
        const cause = errorFromUnknown(
          error,
          "codex_rpc_transport_close_failed",
        );
        this.#transportClosure = {
          reason: "codex_rpc_transport_close_failed",
          cause,
        };
        this.#terminate("codex_rpc_transport_close_failed", cause);
        this.#finishClosedIfSettled();
      },
    );
  }

  subscribeNotifications(
    listener: (notification: CodexRpcNotification) => void,
  ): () => void {
    if (this.#terminated) throw new Error("codex_rpc_client_closed");
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  request<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<Result> {
    return this.requestWithReceipt(specification, params, options).then(
      ({ result }) => result,
    );
  }

  requestWithReceipt<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<CodexRpcRequestReceipt<Result>> {
    this.#assertUsable(specification.method);
    if (
      typeof specification.method !== "string" ||
      !isCodexClientRequestMethod(specification.method)
    ) {
      return Promise.reject(
        this.#deliveryError("codex_rpc_method_unsupported", "not_sent"),
      );
    }
    if (
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds <= 0
    ) {
      return Promise.reject(
        this.#deliveryError(
          "codex_rpc_timeout_invalid",
          "not_sent",
          specification.method,
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        this.#deliveryError(
          "codex_rpc_request_aborted",
          "not_sent",
          specification.method,
        ),
      );
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(
        this.#deliveryError(
          "codex_rpc_pending_capacity_exceeded",
          "not_sent",
          specification.method,
        ),
      );
    }

    let encodedParams: unknown;
    let frame: string;
    try {
      encodedParams = specification.encodeParams(params);
      frame = this.#serializeFrame({
        method: specification.method,
        id: this.#nextRequestId(),
        ...(encodedParams === undefined ? {} : { params: encodedParams }),
      });
    } catch (error) {
      return Promise.reject(
        this.#deliveryError(
          "codex_rpc_request_encoding_failed",
          "not_sent",
          specification.method,
          error,
        ),
      );
    }
    const envelope = JSON.parse(frame) as { readonly id: string };
    const id = envelope.id;

    return new Promise<CodexRpcRequestReceipt<Result>>((resolve, reject) => {
      const sendController = new AbortController();
      const timeout = setTimeout(() => {
        this.#cancelPending(id, "codex_rpc_request_timeout");
      }, options.timeoutMilliseconds);
      timeout.unref?.();
      const onAbort = options.signal
        ? () => {
            this.#cancelPending(id, "codex_rpc_request_aborted");
          }
        : undefined;
      options.signal?.addEventListener("abort", onAbort!, { once: true });
      const pending: PendingRequest = {
        id,
        method: specification.method,
        decodeResult: specification.decodeResult,
        resolve: resolve as (value: unknown) => void,
        reject,
        sendController,
        timeout,
        signal: options.signal,
        onAbort,
        phase: "sending",
      };
      this.#pending.set(id, pending);
      void this.#sendRequestFrame(frame, pending);
    });
  }

  async notify(
    method: "initialized",
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    this.#assertUsable(method);
    const frame = this.#serializeFrame(encodeCodexClientNotification(method));
    try {
      await this.#transport.send(frame, { signal: options?.signal });
    } catch (error) {
      throw this.#normalizeWriteError(error, method);
    }
  }

  async close(reason = "codex_rpc_client_closed"): Promise<void> {
    this.#terminate(reason, new Error(reason));
    await this.#transport.close(reason);
    const closure = await this.closed;
    if (isUnsafeTransportCleanup(closure.reason)) {
      throw new Error(closure.reason, {
        ...(closure.cause ? { cause: closure.cause } : {}),
      });
    }
  }

  #assertUsable(method: string): void {
    if (!this.#started) throw new Error("codex_rpc_client_not_started");
    if (this.#terminated) {
      // The shared façade can select a ready generation immediately before
      // its transport closes. That race occurs before this request is
      // admitted, so preserve the ordinary not-sent delivery classification
      // instead of leaking an untyped internal error to backend read/load
      // reconciliation.
      throw this.#deliveryError(
        "codex_rpc_client_closed",
        "not_sent",
        method,
      );
    }
  }

  #nextRequestId(): string {
    processRequestSequence += 1n;
    return `sedes:${this.#runtimeNonce}:${this.generation}:${processRequestSequence.toString()}`;
  }

  #serializeFrame(envelope: Readonly<Record<string, unknown>>): string {
    if (hasOwn(envelope, "jsonrpc")) {
      throw new Error("codex_rpc_jsonrpc_member_forbidden");
    }
    const frame = JSON.stringify(envelope);
    if (Buffer.byteLength(frame, "utf8") > this.#maxFrameBytes) {
      throw new Error("codex_rpc_outbound_frame_too_large");
    }
    return frame;
  }

  async #sendRequestFrame(
    frame: string,
    pending: PendingRequest,
  ): Promise<void> {
    try {
      await this.#transport.send(frame, {
        signal: pending.sendController.signal,
      });
      const current = this.#pending.get(pending.id);
      if (current !== pending) return;
      pending.phase = "sent";
      if (pending.cancellationCode) {
        this.#rejectPending(
          pending,
          this.#deliveryError(
            pending.cancellationCode,
            "sent_outcome_unknown",
            pending.method,
          ),
        );
      }
    } catch (error) {
      const current = this.#pending.get(pending.id);
      if (current !== pending) return;
      this.#rejectPending(
        pending,
        this.#normalizeWriteError(
          error,
          pending.method,
          pending.cancellationCode ??
            (this.#terminated ? "codex_rpc_connection_lost" : undefined),
        ),
      );
    }
  }

  #cancelPending(
    id: string,
    code: "codex_rpc_request_aborted" | "codex_rpc_request_timeout",
  ): void {
    const pending = this.#pending.get(id);
    if (!pending || pending.cancellationCode) return;
    pending.cancellationCode = code;
    if (pending.phase === "sent") {
      this.#rejectPending(
        pending,
        this.#deliveryError(code, "sent_outcome_unknown", pending.method),
      );
      return;
    }
    pending.sendController.abort();
  }

  #normalizeWriteError(
    error: unknown,
    method: string,
    code?: string,
  ): CodexRpcDeliveryError {
    const delivery =
      error instanceof FrameWriteError
        ? error.delivery
        : "sent_outcome_unknown";
    return this.#deliveryError(
      code ?? "codex_rpc_transport_write_failed",
      delivery,
      method,
      error,
    );
  }

  #deliveryError(
    code: string,
    delivery: "not_sent" | "sent_outcome_unknown",
    method?: string,
    cause?: unknown,
  ): CodexRpcDeliveryError {
    return new CodexRpcDeliveryError({
      code,
      delivery,
      generation: this.generation,
      ...(method === undefined ? {} : { method }),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  #rejectPending(
    pending: PendingRequest,
    error: CodexRpcDeliveryError | CodexRpcRemoteError,
  ): void {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#pending.delete(pending.id);
    this.#cleanupPending(pending);
    if (
      error instanceof CodexRpcDeliveryError &&
      error.delivery === "sent_outcome_unknown"
    ) {
      this.#rememberRequestTombstone(pending.id, "late_allowed");
    } else {
      this.#rememberRequestTombstone(pending.id, "settled");
    }
    pending.reject(error);
    this.#finishTerminationIfSettled();
  }

  #resolvePending(
    pending: PendingRequest,
    value: unknown,
    inboundSequence: number,
  ): void {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#pending.delete(pending.id);
    this.#cleanupPending(pending);
    this.#rememberRequestTombstone(pending.id, "settled");
    pending.resolve(
      Object.freeze({
        result: value,
        generation: this.generation,
        inboundSequence,
      }),
    );
    this.#finishTerminationIfSettled();
  }

  #cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    if (pending.onAbort) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
  }

  #rememberRequestTombstone(id: RequestId, tombstone: RequestTombstone): void {
    const key = requestKey(id);
    this.#requestTombstones.delete(key);
    if (this.#requestTombstones.size >= this.#maxTombstones) {
      const oldestSettled = [...this.#requestTombstones].find(
        ([, disposition]) => disposition === "settled",
      );
      if (!oldestSettled) {
        this.#invalidate(
          new CodexRpcProtocolError(
            "codex_rpc_request_tombstone_capacity_exceeded",
            this.generation,
          ),
        );
        return;
      }
      this.#requestTombstones.delete(oldestSettled[0]);
    }
    this.#requestTombstones.set(key, tombstone);
  }

  async #readFrames(): Promise<void> {
    try {
      for await (const frame of this.#transport.frames) {
        if (this.#terminated) return;
        if (
          !Number.isSafeInteger(frame.byteLength) ||
          frame.byteLength < 0 ||
          frame.byteLength !== Buffer.byteLength(frame.text, "utf8") ||
          frame.byteLength > this.#maxFrameBytes
        ) {
          throw new CodexRpcProtocolError(
            "codex_rpc_inbound_frame_size_invalid",
            this.generation,
          );
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(frame.text);
        } catch (error) {
          throw new CodexRpcProtocolError(
            "codex_rpc_malformed_json",
            this.generation,
            { cause: error },
          );
        }
        this.#receiveEnvelope(envelope);
      }
      if (!this.#terminated) {
        throw new CodexRpcProtocolError(
          "codex_rpc_frame_stream_ended",
          this.generation,
        );
      }
    } catch (error) {
      this.#invalidate(
        errorFromUnknown(error, "codex_rpc_frame_reader_failed"),
      );
    }
  }

  #receiveEnvelope(value: unknown): void {
    if (!isRecord(value) || hasOwn(value, "jsonrpc")) {
      throw new CodexRpcProtocolError(
        "codex_rpc_invalid_envelope",
        this.generation,
      );
    }
    if (hasOwn(value, "method")) {
      this.#receiveMethodEnvelope(value);
      return;
    }
    this.#receiveResponse(value);
  }

  #receiveMethodEnvelope(envelope: Readonly<Record<string, unknown>>): void {
    const hasId = hasOwn(envelope, "id");
    if (
      typeof envelope.method !== "string" ||
      envelope.method.length === 0 ||
      hasOwn(envelope, "result") ||
      hasOwn(envelope, "error")
    ) {
      if (hasId && isRequestId(envelope.id)) {
        void this.#sendImmediateServerError(
          envelope.id,
          -32600,
          "Invalid Request",
        );
        return;
      }
      throw new CodexRpcProtocolError(
        "codex_rpc_invalid_method_envelope",
        this.generation,
      );
    }
    if (hasId) {
      this.#receiveServerRequest(envelope);
    } else {
      this.#receiveNotification(envelope);
    }
  }

  #receiveNotification(envelope: Readonly<Record<string, unknown>>): void {
    if (
      !hasOnlyKeys(envelope, new Set(["method", "params", "emittedAtMs"])) ||
      !hasOwn(envelope, "params") ||
      !isCodexServerNotificationMethod(envelope.method as string) ||
      (hasOwn(envelope, "emittedAtMs") &&
        (typeof envelope.emittedAtMs !== "number" ||
          !Number.isSafeInteger(envelope.emittedAtMs) ||
          envelope.emittedAtMs < 0))
    ) {
      throw new CodexRpcProtocolError(
        "codex_rpc_invalid_notification",
        this.generation,
      );
    }
    const method = envelope.method as CodexServerNotificationMethod;
    let admission;
    try {
      admission = admitCodexServerNotification(method, envelope.params);
    } catch (error) {
      throw new CodexRpcProtocolError(
        "codex_rpc_invalid_notification",
        this.generation,
        { cause: error },
      );
    }
    this.#inboundSequence += 1;
    const notification: CodexRpcNotification =
      admission.status === "decoded"
        ? Object.freeze({
            kind: "decoded_notification",
            generation: this.generation,
            sequence: this.#inboundSequence,
            method,
            params: admission.params,
            ...(typeof envelope.emittedAtMs === "number"
              ? { emittedAtMs: envelope.emittedAtMs }
              : {}),
          })
        : Object.freeze({
            kind: "undecodable_notification",
            generation: this.generation,
            sequence: this.#inboundSequence,
            method,
            nativeThreadId: admission.nativeThreadId,
            code: CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
          });
    for (const listener of [...this.#notificationListeners]) {
      try {
        listener(notification);
      } catch (error) {
        throw new CodexRpcProtocolError(
          "codex_rpc_notification_listener_failed",
          this.generation,
          { cause: error },
        );
      }
    }
  }

  #receiveServerRequest(envelope: Readonly<Record<string, unknown>>): void {
    if (!isRequestId(envelope.id)) {
      throw new CodexRpcProtocolError(
        "codex_rpc_server_request_id_invalid",
        this.generation,
      );
    }
    const id = envelope.id;
    const key = requestKey(id);
    if (this.#serverRequestTombstones.has(key)) {
      throw new CodexRpcProtocolError(
        "codex_rpc_duplicate_server_request",
        this.generation,
      );
    }
    if (!hasOnlyKeys(envelope, new Set(["method", "id", "params", "trace"]))) {
      void this.#sendImmediateServerError(id, -32600, "Invalid Request");
      return;
    }
    const method = envelope.method as string;
    if (!isCodexServerRequestMethod(method)) {
      void this.#sendImmediateServerError(id, -32601, "Method not found");
      return;
    }
    let params: unknown;
    if (hasOwn(envelope, "params")) {
      try {
        params = decodeCodexServerRequestParams(method, envelope.params);
      } catch {
        params = undefined;
      }
    }
    if (
      params === undefined ||
      (hasOwn(envelope, "trace") &&
        envelope.trace !== null &&
        !isRecord(envelope.trace))
    ) {
      void this.#sendImmediateServerError(id, -32602, "Invalid params");
      return;
    }
    const existing = this.#activeServerRequests.get(key);
    if (existing) {
      // Codex deliberately replays still-pending server requests when a
      // loaded thread is resumed. The original handler remains authoritative
      // and will produce the one response for this request ID.
      if (
        existing.method === method &&
        isDeepStrictEqual(existing.params, params)
      ) {
        return;
      }
      throw new CodexRpcProtocolError(
        "codex_rpc_duplicate_server_request",
        this.generation,
      );
    }
    if (this.#activeServerRequests.size >= this.#maxActiveServerRequests) {
      void this.#sendImmediateServerError(
        id,
        -32000,
        "Sedes client overloaded",
      );
      return;
    }

    this.#inboundSequence += 1;
    const controller = new AbortController();
    const active: ActiveServerRequest = {
      key,
      id,
      method,
      params,
      controller,
      timeout: setTimeout(() => {
        controller.abort();
        void this.#settleServerRequest(active, {
          error: {
            code: -32603,
            message: "Sedes server request timed out",
          },
        });
      }, this.#serverRequestTimeoutMilliseconds),
    };
    active.timeout.unref?.();
    this.#activeServerRequests.set(key, active);
    const handler = this.#handlers[method] as
      CodexServerRequestHandler | undefined;
    if (!handler) {
      void this.#settleServerRequest(active, {
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    const request: CodexInboundServerRequest = {
      generation: this.generation,
      sequence: this.#inboundSequence,
      id,
      method,
      params,
      ...(hasOwn(envelope, "trace") ? { trace: envelope.trace } : {}),
      signal: controller.signal,
    };
    void Promise.resolve()
      .then(() => handler(request))
      .then(
        (result) => this.#settleServerRequest(active, { result }),
        () =>
          this.#settleServerRequest(active, {
            error: {
              code: -32603,
              message: "Sedes server request failed",
            },
          }),
      );
  }

  async #sendImmediateServerError(
    id: RequestId,
    code: number,
    message: string,
  ): Promise<void> {
    const key = requestKey(id);
    if (
      this.#activeServerRequests.has(key) ||
      this.#serverRequestTombstones.has(key)
    ) {
      this.#invalidate(
        new CodexRpcProtocolError(
          "codex_rpc_duplicate_server_request",
          this.generation,
        ),
      );
      return;
    }
    let frame: string;
    try {
      frame = this.#prepareServerResponse(id, {
        error: { code, message },
      });
    } catch (error) {
      this.#invalidate(
        errorFromUnknown(error, "codex_rpc_server_response_failed"),
      );
      return;
    }
    this.#rememberServerRequestTombstone(key);
    await this.#sendServerResponseFrame(frame);
  }

  async #settleServerRequest(
    active: ActiveServerRequest,
    outcome:
      { readonly result: unknown } | { readonly error: RpcErrorEnvelope },
  ): Promise<void> {
    if (this.#activeServerRequests.get(active.key) !== active) return;
    let validatedOutcome = outcome;
    if ("result" in outcome) {
      try {
        validatedOutcome = {
          result: encodeCodexServerRequestResult(active.method, outcome.result),
        };
      } catch {
        validatedOutcome = {
          error: {
            code: -32603,
            message: "Sedes server request failed",
          },
        };
      }
    }
    let frame: string;
    try {
      frame = this.#prepareServerResponse(active.id, validatedOutcome);
    } catch (error) {
      this.#invalidate(
        errorFromUnknown(error, "codex_rpc_server_response_failed"),
      );
      return;
    }
    this.#activeServerRequests.delete(active.key);
    clearTimeout(active.timeout);
    this.#rememberServerRequestTombstone(active.key);
    await this.#sendServerResponseFrame(frame);
  }

  #rememberServerRequestTombstone(key: string): void {
    this.#serverRequestTombstones.delete(key);
    if (this.#serverRequestTombstones.size >= this.#maxTombstones) {
      this.#invalidate(
        new CodexRpcProtocolError(
          "codex_rpc_server_request_tombstone_capacity_exceeded",
          this.generation,
        ),
      );
      return;
    }
    this.#serverRequestTombstones.set(key, true);
  }

  #prepareServerResponse(
    id: RequestId,
    outcome:
      { readonly result: unknown } | { readonly error: RpcErrorEnvelope },
  ): string {
    if ("error" in outcome) {
      return this.#serializeFrame({ id, error: outcome.error });
    }
    try {
      const frame = this.#serializeFrame({ id, result: outcome.result });
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      if (!hasOwn(parsed, "result")) {
        throw new Error("codex_rpc_server_result_not_serializable");
      }
      return frame;
    } catch {
      return this.#serializeFrame({
        id,
        error: {
          code: -32603,
          message: "Sedes server request failed",
        },
      });
    }
  }

  async #sendServerResponseFrame(frame: string): Promise<void> {
    if (this.#terminated) return;
    try {
      await this.#transport.send(frame);
    } catch (error) {
      this.#invalidate(
        errorFromUnknown(error, "codex_rpc_server_response_failed"),
      );
    }
  }

  #receiveResponse(envelope: Readonly<Record<string, unknown>>): void {
    const allowed = hasOwn(envelope, "result")
      ? new Set(["id", "result"])
      : new Set(["id", "error"]);
    if (
      !hasOnlyKeys(envelope, allowed) ||
      !isRequestId(envelope.id) ||
      hasOwn(envelope, "result") === hasOwn(envelope, "error") ||
      (hasOwn(envelope, "error") && !isRpcError(envelope.error))
    ) {
      throw new CodexRpcProtocolError(
        "codex_rpc_invalid_response",
        this.generation,
      );
    }
    const key = requestKey(envelope.id);
    const pending =
      typeof envelope.id === "string"
        ? this.#pending.get(envelope.id)
        : undefined;
    if (!pending) {
      const tombstone = this.#requestTombstones.get(key);
      if (tombstone === "late_allowed") {
        this.#inboundSequence += 1;
        this.#rememberRequestTombstone(envelope.id, "settled");
        return;
      }
      throw new CodexRpcProtocolError(
        tombstone === "settled"
          ? "codex_rpc_duplicate_response"
          : "codex_rpc_unknown_response",
        this.generation,
      );
    }
    if (hasOwn(envelope, "error")) {
      this.#inboundSequence += 1;
      const error = envelope.error as RpcErrorEnvelope;
      this.#rejectPending(
        pending,
        new CodexRpcRemoteError({
          code: error.code,
          message: error.message,
          ...(hasOwn(error, "data") ? { data: error.data } : {}),
          generation: this.generation,
          method: pending.method,
        }),
      );
      return;
    }
    let result: unknown;
    const inboundSequence = this.#inboundSequence + 1;
    try {
      result = pending.decodeResult(envelope.result);
    } catch (error) {
      throw new CodexRpcProtocolError(
        "codex_rpc_response_schema_invalid",
        this.generation,
        { cause: error },
      );
    }
    this.#inboundSequence = inboundSequence;
    this.#resolvePending(pending, result, inboundSequence);
  }

  #invalidate(error: Error): void {
    if (this.#terminated) return;
    this.#terminate(error.message, error);
    void this.#transport.close(error.message).catch(() => undefined);
  }

  #terminate(reason: string, cause: Error): void {
    if (this.#terminated) return;
    this.#terminated = true;
    const timer = setTimeout(() => {
      for (const pending of [...this.#pending.values()]) {
        this.#rejectPending(
          pending,
          this.#deliveryError(
            "codex_rpc_connection_lost",
            "sent_outcome_unknown",
            pending.method,
            cause,
          ),
        );
      }
      this.#finishTerminationIfSettled();
    }, this.#sendSettleMilliseconds);
    timer.unref?.();
    this.#termination = {
      closure: {
        generation: this.generation,
        reason,
        cause,
      },
      timer,
    };
    for (const active of this.#activeServerRequests.values()) {
      clearTimeout(active.timeout);
      active.controller.abort();
    }
    this.#activeServerRequests.clear();
    this.#notificationListeners.clear();
    for (const pending of [...this.#pending.values()]) {
      if (pending.phase === "sent") {
        this.#rejectPending(
          pending,
          this.#deliveryError(
            "codex_rpc_connection_lost",
            "sent_outcome_unknown",
            pending.method,
            cause,
          ),
        );
      } else {
        pending.sendController.abort();
      }
    }
    this.#finishTerminationIfSettled();
  }

  #finishTerminationIfSettled(): void {
    const termination = this.#termination;
    if (!termination || this.#pending.size > 0) return;
    this.#termination = undefined;
    clearTimeout(termination.timer);
    this.#logicalClosure = termination.closure;
    this.#finishClosedIfSettled();
  }

  #finishClosedIfSettled(): void {
    if (
      this.#closedResolved ||
      !this.#logicalClosure ||
      !this.#transportClosure
    ) {
      return;
    }
    this.#closedResolved = true;
    const closure = isUnsafeTransportCleanup(this.#transportClosure.reason)
      ? {
          generation: this.generation,
          reason: this.#transportClosure.reason,
          ...(this.#transportClosure.cause
            ? { cause: this.#transportClosure.cause }
            : {}),
        }
      : this.#logicalClosure;
    this.#resolveClosed(closure);
  }
}

function isUnsafeTransportCleanup(reason: string): boolean {
  return (
    reason === "orphaned_process_group" ||
    reason === "process_cleanup_failed" ||
    reason === "codex_rpc_transport_close_failed"
  );
}
