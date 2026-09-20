import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SidecarProtocolDeliveryError,
  type SidecarFrameLane,
  type SidecarFrameSendOptions,
  type SidecarFrameTransport,
} from "./contracts.js";
import {
  controlHelloOperation,
  controlPingOperation,
  type SidecarCapabilityInventory,
} from "./control-v2.js";
import {
  decodeSidecarFrame,
  encodeSidecarEnvelope,
  encodeSidecarStreamDataFrame,
  SIDECAR_WIRE_VERSION,
  type SidecarEventEnvelope,
  type SidecarRequestEnvelope,
  type SidecarRequestNamespace,
  type SidecarResponseEnvelope,
  type SidecarStreamCreditEnvelope,
  type SidecarStreamChannel,
  type SidecarStreamDataFrame,
  type SidecarStreamTerminalEnvelope,
} from "./envelopes.js";
import {
  resolveSidecarProtocolLimits,
  type SidecarProtocolLimits,
} from "./limits.js";
import {
  SidecarOperationError,
  type RegisteredSidecarOperation,
  type SidecarOperationDefinition,
  type SidecarOperationRegistry,
} from "./operation-registry.js";

type PendingRequest = {
  readonly definition: SidecarOperationDefinition<unknown, unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly sendController: AbortController;
  abort?: () => void;
  cancellationCode?: string;
  settled: boolean;
  sendState: "sending" | "sent";
  readonly diagnosticStarted?: number;
};

/** Heartbeat metadata only. Request IDs correlate both ends without exposing
 * the authentication nonce or copying a request/response payload. */
export interface SidecarHeartbeatDiagnostic {
  readonly role: SidecarRequestNamespace;
  readonly requestId: string;
  readonly stage: string;
  readonly carrierGeneration: number;
  readonly transportKind: string;
  readonly durationMs?: number;
  readonly queuedWriteBytes?: number;
  readonly queuedWriteFrames?: number;
  readonly activeWriteBytes?: number;
  readonly frameBytes?: number;
  readonly outcome?: "ok" | "error";
}

type ActiveRequest = {
  readonly controller: AbortController;
  readonly deadline?: NodeJS.Timeout;
  readonly lane: SidecarFrameLane;
};

type EventRegistration = {
  readonly schema: z.ZodType<unknown>;
  readonly listener: (payload: unknown) => void;
};

type IncomingStream = {
  readonly capabilityId: string;
  readonly majorVersion: number;
  readonly terminalSchema: z.ZodType<unknown>;
  readonly onData: (record: SidecarStreamDataRecord) => void;
  readonly onTerminal: (payload: unknown) => void;
  expectedSequence: number;
  remainingCredit: number;
};

type OutgoingStream = {
  readonly capabilityId: string;
  readonly majorVersion: number;
  sequence: number;
  credit: number;
  terminalRequested: boolean;
  terminal: boolean;
  chain: Promise<void>;
  waiters: Set<() => void>;
};

export interface SidecarStreamDataRecord {
  readonly sequence: number;
  readonly channel: SidecarStreamChannel;
  readonly bytes: Uint8Array;
}

export interface SidecarOutboundStream {
  readonly streamId: string;
  send(
    channel: SidecarStreamChannel,
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  terminal<Payload>(
    payload: Payload,
    schema: z.ZodType<Payload>,
  ): Promise<void>;
}

/**
 * One full-duplex protocol endpoint. It is the sole consumer of transport
 * frames and maintains independent inbound and outbound request namespaces.
 */
export class SidecarProtocolPeer {
  readonly #role: SidecarRequestNamespace;
  readonly #remoteRole: SidecarRequestNamespace;
  readonly #transport: SidecarFrameTransport;
  readonly #sessionNonce: string;
  readonly #registry: SidecarOperationRegistry;
  readonly #limits: SidecarProtocolLimits;
  readonly #requestId: () => string;
  readonly #outbound = new Map<string, PendingRequest>();
  readonly #inbound = new Map<string, ActiveRequest>();
  readonly #receivedRequestIds = new Set<string>();
  readonly #cancelledOutbound = new Set<string>();
  readonly #events = new Map<string, Set<EventRegistration>>();
  readonly #incomingStreams = new Map<string, IncomingStream>();
  readonly #outgoingStreams = new Map<string, OutgoingStream>();
  readonly #terminalOutgoingStreams = new Set<string>();
  #localCapabilities: ReadonlySet<string> = new Set();
  #remoteCapabilities: ReadonlySet<string> = new Set();
  #localOperations: ReadonlySet<string> = new Set();
  #remoteOperations: ReadonlySet<string> = new Set();
  #lastActivityAtMilliseconds = Date.now();
  #lastInboundActivityAtMilliseconds = Date.now();
  #lastOutboundActivityAtMilliseconds = Date.now();
  #helloComplete = false;
  #helloInProgress = false;
  #started = false;
  #closed = false;
  readonly #onReady: (() => void) | undefined;
  readonly #onClosing: (() => void) | undefined;
  readonly #onDiagnostic: ((record: SidecarHeartbeatDiagnostic, error?: unknown) => void) | undefined;
  readonly #diagnosticsEnabled: () => boolean;

  constructor(input: {
    readonly role: SidecarRequestNamespace;
    readonly transport: SidecarFrameTransport;
    readonly sessionNonce: string;
    readonly registry: SidecarOperationRegistry;
    readonly limits?: Partial<SidecarProtocolLimits>;
    readonly requestIdFactory?: () => string;
    readonly onReady?: () => void;
    /** Runs before connection-scoped request signals are aborted. */
    readonly onClosing?: () => void;
    readonly onDiagnostic?: (record: SidecarHeartbeatDiagnostic, error?: unknown) => void;
    /** Installation-owned opt-in; defaults to the delivery environment gate. */
    readonly diagnosticsEnabled?: () => boolean;
  }) {
    if (input.sessionNonce.length < 32 || input.sessionNonce.length > 160) {
      throw new Error("sidecar_session_nonce_invalid");
    }
    this.#role = input.role;
    this.#remoteRole = input.role === "sedes" ? "sidecar" : "sedes";
    this.#transport = input.transport;
    this.#sessionNonce = input.sessionNonce;
    this.#registry = input.registry;
    this.#limits = resolveSidecarProtocolLimits(input.limits);
    this.#requestId = input.requestIdFactory ?? randomUUID;
    this.#onReady = input.onReady;
    this.#onClosing = input.onClosing;
    this.#onDiagnostic = input.onDiagnostic;
    this.#diagnosticsEnabled = input.diagnosticsEnabled ?? (() => Boolean(process.env.SEDES_DEBUG_DELIVERY));
  }

  start(): void {
    if (this.#started) throw new Error("sidecar_protocol_peer_already_started");
    this.#started = true;
    void this.#read();
    void this.#transport.closed.then(
      (closure) =>
        this.#transportEnded(
          closure.cause ??
            new Error(`sidecar_transport_closed:${closure.reason}`),
        ),
      (error) => this.#transportEnded(asError(error)),
    );
  }

  supportsOperation(definition: { readonly capabilityId: string; readonly majorVersion: number; readonly operation: string }): boolean {
    return this.#helloComplete && !this.#closed && this.#remoteOperations.has(operationKey(definition));
  }

  /** Check immediately before interpreting negotiated capability absence.
   * A false supportsOperation result alone does not prove a live inventory. */
  assertReady(): void {
    if (this.#closed) throw new Error("sidecar_protocol_peer_closed");
    if (!this.#started) throw new Error("sidecar_protocol_peer_not_started");
    if (!this.#helloComplete) throw new Error("sidecar_protocol_hello_required");
  }

  async call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    options?: {
      readonly signal?: AbortSignal;
      readonly deadlineMilliseconds?: number;
    },
  ): Promise<Response> {
    if (!this.#started) throw new Error("sidecar_protocol_peer_not_started");
    if (this.#closed) throw new Error("sidecar_protocol_peer_closed");
    const isHello = isHelloDefinition(definition);
    if (!this.#helloComplete) {
      if (this.#role !== "sedes" || !isHello || this.#helloInProgress) {
        throw new Error("sidecar_protocol_hello_required");
      }
    } else if (!this.#remoteOperations.has(operationKey(definition))) {
      throw new Error("sidecar_operation_not_negotiated");
    }
    if (this.#outbound.size >= this.#limits.maximumOutboundRequests) {
      throw new Error("sidecar_protocol_outbound_request_limit");
    }
    const payload = definition.requestSchema.parse(request);
    const deadline = resolveOutboundDeadline(
      definition,
      options,
      this.#limits.maximumRequestDeadlineMilliseconds,
    );
    const requestId = this.#requestId();
    if (
      !z.uuid().safeParse(requestId).success ||
      this.#outbound.has(requestId)
    ) {
      throw new Error("sidecar_request_id_invalid");
    }
    const frame = encodeSidecarEnvelope({
      wireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce: this.#sessionNonce,
      type: "request",
      requestNamespace: this.#role,
      requestId,
      capabilityId: definition.capabilityId,
      majorVersion: definition.majorVersion,
      operation: definition.operation,
      deadline,
      payload,
    });
    if (isHello) this.#helloInProgress = true;
    const diagnosticStarted = this.#tracesHeartbeat(definition) ? performance.now() : undefined;
    return await new Promise<Response>((resolve, reject) => {
      const timer =
        deadline.mode === "finite"
          ? setTimeout(
              () => this.#cancelOutbound(requestId, "sidecar_request_timeout"),
              deadline.milliseconds,
            )
          : undefined;
      timer?.unref();
      const pending: PendingRequest = {
        definition: definition as SidecarOperationDefinition<unknown, unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        ...(options?.signal ? { signal: options.signal } : {}),
        sendController: new AbortController(),
        settled: false,
        sendState: "sending",
        ...(diagnosticStarted === undefined ? {} : { diagnosticStarted }),
      };
      if (pending.signal) {
        pending.abort = () =>
          this.#cancelOutbound(requestId, "sidecar_request_cancelled");
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#outbound.set(requestId, pending);
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(requestId, "request_queued");
      if (pending.signal?.aborted) pending.abort?.();
      void this.#transport
        .send(frame, {
          lane: definition.lane,
          signal: pending.sendController.signal,
          ...this.#heartbeatWriteOptions(requestId, "request", diagnosticStarted !== undefined),
        })
        .then(() => {
          if (pending.settled) return;
          pending.sendState = "sent";
          this.#markOutboundActivity();
          if (this.#closed) {
            this.#settleOutbound(
              requestId,
              undefined,
              new SidecarProtocolDeliveryError(
                "sidecar_protocol_peer_closed",
                "sent_outcome_unknown",
              ),
            );
          } else if (pending.cancellationCode) {
            this.#settleOutbound(
              requestId,
              undefined,
              new SidecarProtocolDeliveryError(
                pending.cancellationCode,
                "sent_outcome_unknown",
              ),
            );
            this.#sendCancel(requestId);
          }
        })
        .catch((error: unknown) => {
          if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(requestId, "request_send_failed", { durationMs: performance.now() - diagnosticStarted }, error);
          if (pending.settled) return;
          const message = pending.cancellationCode ?? asError(error).message;
          this.#settleOutbound(
            requestId,
            undefined,
            new SidecarProtocolDeliveryError(message, writeDelivery(error)),
          );
        });
      if (pending.signal?.aborted) pending.abort?.();
    });
  }

  activitySnapshot(): Readonly<{
    readonly pendingOperationRequests: number;
    readonly pendingOperationSends: number;
    readonly lastActivityAtMilliseconds: number;
    readonly lastInboundActivityAtMilliseconds: number;
    readonly lastOutboundActivityAtMilliseconds: number;
  }> {
    let pendingOperationRequests = 0;
    let pendingOperationSends = 0;
    for (const pending of this.#outbound.values()) {
      if (!pending.settled && pending.definition.lane === "operation") {
        pendingOperationRequests += 1;
        if (pending.sendState === "sending") pendingOperationSends += 1;
      }
    }
    for (const active of this.#inbound.values()) {
      if (active.lane === "operation") pendingOperationRequests += 1;
    }
    return Object.freeze({
      pendingOperationRequests,
      pendingOperationSends,
      lastActivityAtMilliseconds: this.#lastActivityAtMilliseconds,
      lastInboundActivityAtMilliseconds:
        this.#lastInboundActivityAtMilliseconds,
      lastOutboundActivityAtMilliseconds:
        this.#lastOutboundActivityAtMilliseconds,
    });
  }

  onEvent<Payload>(input: {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly event: string;
    readonly schema: z.ZodType<Payload>;
    readonly listener: (payload: Payload) => void;
  }): () => void {
    const key = eventKey(input);
    let registrations = this.#events.get(key);
    if (!registrations) {
      registrations = new Set();
      this.#events.set(key, registrations);
    }
    const registration: EventRegistration = {
      schema: input.schema as z.ZodType<unknown>,
      listener: input.listener as (payload: unknown) => void,
    };
    registrations.add(registration);
    return () => {
      registrations!.delete(registration);
      if (registrations!.size === 0) this.#events.delete(key);
    };
  }

  /** Must be called before shell.start so immediate process output has an owner. */
  registerIncomingStream<Payload>(input: {
    readonly streamId: string;
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly initialCreditBytes: number;
    readonly terminalSchema: z.ZodType<Payload>;
    readonly onData: (record: SidecarStreamDataRecord) => void;
    readonly onTerminal: (payload: Payload) => void;
  }): {
    readonly addCredit: (bytes: number) => Promise<void>;
    readonly unregister: () => void;
  } {
    validateStreamId(input.streamId);
    validateStreamCredit(input.initialCreditBytes);
    if (this.#incomingStreams.has(input.streamId)) {
      throw new Error("sidecar_stream_already_registered");
    }
    this.#incomingStreams.set(input.streamId, {
      capabilityId: input.capabilityId,
      majorVersion: input.majorVersion,
      terminalSchema: input.terminalSchema as z.ZodType<unknown>,
      onData: input.onData,
      onTerminal: input.onTerminal as (payload: unknown) => void,
      expectedSequence: 0,
      remainingCredit: input.initialCreditBytes,
    });
    return Object.freeze({
      addCredit: async (bytes: number) => {
        validateStreamCredit(bytes);
        const stream = this.#incomingStreams.get(input.streamId);
        if (!stream) throw new Error("sidecar_stream_not_registered");
        if (stream.remainingCredit + bytes > Number.MAX_SAFE_INTEGER) {
          throw new Error("sidecar_stream_credit_overflow");
        }
        await this.#transport.send(
          encodeSidecarEnvelope({
            wireVersion: SIDECAR_WIRE_VERSION,
            sessionNonce: this.#sessionNonce,
            type: "stream_credit",
            origin: this.#role,
            streamId: input.streamId,
            bytes,
          }),
          { lane: "control" },
        );
        stream.remainingCredit += bytes;
        this.#markOutboundActivity();
      },
      unregister: () => {
        this.#incomingStreams.delete(input.streamId);
      },
    });
  }

  openOutgoingStream(input: {
    readonly streamId: string;
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly initialCreditBytes: number;
  }): SidecarOutboundStream {
    validateStreamId(input.streamId);
    validateStreamCredit(input.initialCreditBytes);
    if (!this.#helloComplete || this.#closed) {
      throw new Error("sidecar_protocol_session_not_ready");
    }
    if (!this.#localCapabilities.has(capabilityPrefix(input))) {
      throw new Error("sidecar_stream_capability_unauthorized");
    }
    if (
      this.#outgoingStreams.has(input.streamId) ||
      this.#terminalOutgoingStreams.has(input.streamId)
    ) {
      throw new Error("sidecar_stream_already_registered");
    }
    const state: OutgoingStream = {
      capabilityId: input.capabilityId,
      majorVersion: input.majorVersion,
      sequence: 0,
      credit: input.initialCreditBytes,
      terminalRequested: false,
      terminal: false,
      chain: Promise.resolve(),
      waiters: new Set(),
    };
    this.#outgoingStreams.set(input.streamId, state);
    return Object.freeze({
      streamId: input.streamId,
      send: async (
        channel: SidecarStreamChannel,
        bytes: Uint8Array,
        options?: { readonly signal?: AbortSignal },
      ) => {
        if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
          throw new Error("sidecar_stream_chunk_size_invalid");
        }
        const copy = Uint8Array.from(bytes);
        const next = state.chain.then(async () => {
          if (state.terminalRequested)
            throw new Error("sidecar_stream_already_terminal");
          await waitForCredit(state, copy.byteLength, options?.signal);
          if (state.terminalRequested || this.#closed) {
            throw new Error("sidecar_stream_closed");
          }
          const sequence = state.sequence;
          state.credit -= copy.byteLength;
          await this.#transport.send(
            encodeSidecarStreamDataFrame({
              sessionNonce: this.#sessionNonce,
              origin: this.#role,
              streamId: input.streamId,
              sequence,
              channel,
              bytes: copy,
            }),
            { lane: "operation" },
          );
          state.sequence += copy.byteLength;
          this.#markOutboundActivity();
        });
        state.chain = next.catch(() => undefined);
        return await next;
      },
      terminal: async <Payload>(
        payload: Payload,
        schema: z.ZodType<Payload>,
      ) => {
        const parsed = schema.parse(payload);
        if (state.terminalRequested) {
          throw new Error("sidecar_stream_already_terminal");
        }
        state.terminalRequested = true;
        wakeStreamWaiters(state);
        const next = state.chain.then(async () => {
          state.terminal = true;
          await this.#transport.send(
            encodeSidecarEnvelope({
              wireVersion: SIDECAR_WIRE_VERSION,
              sessionNonce: this.#sessionNonce,
              type: "stream_terminal",
              origin: this.#role,
              streamId: input.streamId,
              sequence: state.sequence,
              capabilityId: input.capabilityId,
              majorVersion: input.majorVersion,
              payload: parsed,
            }),
            { lane: "operation", settlement: true },
          );
          this.#outgoingStreams.delete(input.streamId);
          this.#terminalOutgoingStreams.add(input.streamId);
          trimSet(
            this.#terminalOutgoingStreams,
            this.#limits.maximumOutboundRequests * 2,
          );
          this.#markOutboundActivity();
        });
        state.chain = next.catch(() => undefined);
        return await next;
      },
    });
  }

  async sendEvent<Payload>(input: {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly event: string;
    readonly payload: Payload;
    readonly schema: z.ZodType<Payload>;
  }): Promise<void> {
    if (!this.#helloComplete || this.#closed) {
      throw new Error("sidecar_protocol_session_not_ready");
    }
    if (!this.#localCapabilities.has(capabilityPrefix(input))) {
      throw new Error("sidecar_event_capability_unauthorized");
    }
    const payload = input.schema.parse(input.payload);
    await this.#transport.send(
      encodeSidecarEnvelope({
        wireVersion: SIDECAR_WIRE_VERSION,
        sessionNonce: this.#sessionNonce,
        type: "event",
        origin: this.#role,
        capabilityId: input.capabilityId,
        majorVersion: input.majorVersion,
        event: input.event,
        payload,
      }),
      { lane: "operation" },
    );
    this.#markOutboundActivity();
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#beginClose(new Error("sidecar_protocol_peer_closed"));
    await this.#transport.close(reason);
  }

  async #read(): Promise<void> {
    try {
      for await (const frame of this.#transport.frames) {
        const decoded = decodeSidecarFrame(frame.bytes, this.#sessionNonce);
        if (decoded.kind === "stream_data") {
          this.#receiveStreamData(decoded.frame);
          this.#markInboundActivity();
          continue;
        }
        const envelope = decoded.envelope;
        if (envelope.sessionNonce !== this.#sessionNonce) {
          throw new Error("sidecar_protocol_session_nonce_mismatch");
        }
        if (envelope.type === "request") this.#receiveRequest(envelope);
        else if (envelope.type === "response") this.#receiveResponse(envelope);
        else if (envelope.type === "cancel") {
          this.#receiveCancel(envelope.requestNamespace, envelope.requestId);
        } else if (envelope.type === "event") this.#receiveEvent(envelope);
        else if (envelope.type === "stream_credit")
          this.#receiveStreamCredit(envelope);
        else this.#receiveStreamTerminal(envelope);
        this.#markInboundActivity();
      }
    } catch (error) {
      const failure = asError(error);
      this.#beginClose(failure);
      void this.#transport.close(failure.message).catch(() => undefined);
    }
  }

  #receiveRequest(envelope: SidecarRequestEnvelope): void {
    if (envelope.requestNamespace !== this.#remoteRole) {
      throw new Error("sidecar_protocol_request_namespace_invalid");
    }
    const isHello = isHelloRequest(envelope);
    const diagnosticStarted = this.#tracesHeartbeat(envelope) ? performance.now() : undefined;
    if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "request_received");
    if (isHello && this.#role !== "sidecar") {
      throw new Error("sidecar_protocol_hello_direction_invalid");
    }
    if (this.#receivedRequestIds.has(envelope.requestId)) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_request_duplicate",
        false,
        "control",
        diagnosticStarted,
      );
      return;
    }
    this.#rememberReceived(envelope.requestId);
    if (this.#inbound.size >= this.#limits.maximumInboundRequests) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_request_capacity_exceeded",
        true,
        "control",
        diagnosticStarted,
      );
      return;
    }
    const operation = this.#registry.resolve(envelope);
    if (
      !operation ||
      (this.#helloComplete &&
        !this.#localOperations.has(operationKey(envelope)))
    ) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_operation_unsupported",
        false,
        "control",
        diagnosticStarted,
      );
      return;
    }
    if (isHello && (this.#helloComplete || this.#helloInProgress)) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_protocol_hello_already_completed",
        false,
        "control",
        diagnosticStarted,
      );
      return;
    }
    if (!this.#helloComplete && !isHello) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_protocol_hello_required",
        false,
        "control",
        diagnosticStarted,
      );
      return;
    }
    const parsed = operation.definition.requestSchema.safeParse(
      envelope.payload,
    );
    if (!parsed.success) {
      void this.#sendError(
        envelope.requestNamespace,
        envelope.requestId,
        "sidecar_request_payload_invalid",
        false,
        operation.definition.lane,
        diagnosticStarted,
      );
      return;
    }
    if (isHello) this.#helloInProgress = true;
    const deadlineMilliseconds = resolveInboundDeadline(
      operation.definition,
      envelope.deadline,
      this.#limits.maximumRequestDeadlineMilliseconds,
    );
    const controller = new AbortController();
    const deadline =
      deadlineMilliseconds === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(new Error("sidecar_request_timeout")),
            deadlineMilliseconds,
          );
    deadline?.unref();
    this.#inbound.set(envelope.requestId, {
      controller,
      deadline,
      lane: operation.definition.lane,
    });
    void this.#executeInbound(envelope, operation, parsed.data, controller, diagnosticStarted);
  }

  async #executeInbound(
    envelope: SidecarRequestEnvelope,
    operation: RegisteredSidecarOperation,
    request: unknown,
    controller: AbortController,
    diagnosticStarted?: number,
  ): Promise<void> {
    const isHello = isHelloRequest(envelope);
    let response: SidecarResponseEnvelope;
    try {
      const result = await raceAgainstAbort(
        () => {
          if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "handler_start", { durationMs: performance.now() - diagnosticStarted });
          return operation.handler(request, {
            requestId: envelope.requestId,
            signal: controller.signal,
          });
        },
        controller.signal,
      );
      const payload = operation.definition.responseSchema.parse(result);
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "handler_complete", { durationMs: performance.now() - diagnosticStarted, outcome: "ok" });
      if (isHello) this.#commitHello("sidecar", payload);
      response = {
        wireVersion: SIDECAR_WIRE_VERSION,
        sessionNonce: this.#sessionNonce,
        type: "response",
        requestNamespace: envelope.requestNamespace,
        requestId: envelope.requestId,
        outcome: "ok",
        payload,
      };
    } catch (error) {
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "handler_complete", { durationMs: performance.now() - diagnosticStarted, outcome: "error" }, error);
      const classified = classifyOperationError(error, controller.signal);
      response = {
        wireVersion: SIDECAR_WIRE_VERSION,
        sessionNonce: this.#sessionNonce,
        type: "response",
        requestNamespace: envelope.requestNamespace,
        requestId: envelope.requestId,
        outcome: "error",
        error: classified,
      };
    }
    const active = this.#inbound.get(envelope.requestId);
    if (active?.deadline) clearTimeout(active.deadline);
    this.#inbound.delete(envelope.requestId);
    if (isHello) this.#helloInProgress = false;
    try {
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "response_queued", { outcome: response.outcome });
      await this.#transport.send(encodeSidecarEnvelope(response), {
        lane: operation.definition.lane,
        ...this.#heartbeatWriteOptions(envelope.requestId, "response", diagnosticStarted !== undefined),
      });
      if (isHello && response.outcome === "ok") this.#onReady?.();
    } catch (error) {
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "response_send_failed", { durationMs: performance.now() - diagnosticStarted }, error);
      const failure = asError(error);
      this.#beginClose(failure);
      await this.#transport.close(failure.message).catch(() => undefined);
      return;
    }
  }

  #receiveResponse(envelope: SidecarResponseEnvelope): void {
    if (envelope.requestNamespace !== this.#role) {
      throw new Error("sidecar_protocol_response_namespace_invalid");
    }
    const pending = this.#outbound.get(envelope.requestId);
    if (!pending) {
      if (this.#cancelledOutbound.delete(envelope.requestId)) return;
      throw new Error("sidecar_protocol_response_unknown_request");
    }
    if (envelope.outcome === "error") {
      if (pending.diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "response_parsed", { durationMs: performance.now() - pending.diagnosticStarted, outcome: "error" }, new SidecarOperationError(envelope.error.code, envelope.error.retryable));
      this.#settleOutbound(
        envelope.requestId,
        undefined,
        new SidecarOperationError(
          envelope.error.code,
          envelope.error.retryable,
        ),
      );
      return;
    }
    const parsed = pending.definition.responseSchema.safeParse(
      envelope.payload,
    );
    if (!parsed.success) {
      if (pending.diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "response_invalid", { durationMs: performance.now() - pending.diagnosticStarted }, parsed.error);
      throw new Error("sidecar_protocol_response_payload_invalid", {
        cause: parsed.error,
      });
    }
    if (isHelloDefinition(pending.definition)) {
      this.#commitHello("sedes", parsed.data);
      this.#onReady?.();
    }
    if (pending.diagnosticStarted !== undefined) this.#diagnoseHeartbeat(envelope.requestId, "response_parsed", { durationMs: performance.now() - pending.diagnosticStarted, outcome: "ok" });
    this.#settleOutbound(envelope.requestId, parsed.data);
  }

  #receiveCancel(
    requestNamespace: SidecarRequestNamespace,
    requestId: string,
  ): void {
    if (requestNamespace !== this.#remoteRole) {
      throw new Error("sidecar_protocol_cancel_namespace_invalid");
    }
    const active = this.#inbound.get(requestId);
    if (active) {
      active.controller.abort(new Error("sidecar_request_cancelled"));
      return;
    }
    if (!this.#receivedRequestIds.has(requestId)) {
      throw new Error("sidecar_protocol_cancel_unknown_request");
    }
  }

  #receiveEvent(envelope: SidecarEventEnvelope): void {
    if (envelope.origin !== this.#remoteRole) {
      throw new Error("sidecar_protocol_event_origin_invalid");
    }
    if (!this.#remoteCapabilities.has(capabilityPrefix(envelope))) {
      throw new Error("sidecar_protocol_event_capability_unauthorized");
    }
    const registrations = this.#events.get(eventKey(envelope));
    if (!registrations || registrations.size === 0) {
      throw new Error("sidecar_protocol_event_unregistered");
    }
    for (const registration of registrations) {
      const parsed = registration.schema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new Error("sidecar_protocol_event_payload_invalid", {
          cause: parsed.error,
        });
      }
      registration.listener(parsed.data);
    }
  }

  #receiveStreamData(frame: SidecarStreamDataFrame): void {
    if (frame.origin !== this.#remoteRole) {
      throw new Error("sidecar_protocol_stream_origin_invalid");
    }
    const stream = this.#incomingStreams.get(frame.streamId);
    if (!stream) throw new Error("sidecar_protocol_stream_unknown");
    if (
      frame.sequence !== stream.expectedSequence ||
      frame.bytes.byteLength > stream.remainingCredit
    ) {
      throw new Error("sidecar_protocol_stream_data_invalid");
    }
    stream.expectedSequence += frame.bytes.byteLength;
    stream.remainingCredit -= frame.bytes.byteLength;
    stream.onData({
      sequence: frame.sequence,
      channel: frame.channel,
      bytes: Uint8Array.from(frame.bytes),
    });
  }

  #receiveStreamCredit(envelope: SidecarStreamCreditEnvelope): void {
    if (envelope.origin !== this.#remoteRole) {
      throw new Error("sidecar_protocol_stream_origin_invalid");
    }
    const stream = this.#outgoingStreams.get(envelope.streamId);
    if (!stream) {
      // A consumer replenishes credit after it receives a data frame. The
      // producer can concurrently send terminal and retire the stream before
      // that credit crosses the transport. The late credit has no authority or
      // effect, but it is valid for this recently terminal stream. Credits for
      // stream ids that were never owned by this peer remain protocol-fatal.
      if (this.#terminalOutgoingStreams.has(envelope.streamId)) return;
      throw new Error("sidecar_protocol_stream_unknown");
    }
    if (stream.credit + envelope.bytes > Number.MAX_SAFE_INTEGER) {
      throw new Error("sidecar_protocol_stream_credit_overflow");
    }
    stream.credit += envelope.bytes;
    wakeStreamWaiters(stream);
  }

  #receiveStreamTerminal(envelope: SidecarStreamTerminalEnvelope): void {
    if (envelope.origin !== this.#remoteRole) {
      throw new Error("sidecar_protocol_stream_origin_invalid");
    }
    const stream = this.#incomingStreams.get(envelope.streamId);
    if (!stream) throw new Error("sidecar_protocol_stream_unknown");
    if (
      envelope.sequence !== stream.expectedSequence ||
      envelope.capabilityId !== stream.capabilityId ||
      envelope.majorVersion !== stream.majorVersion
    ) {
      throw new Error("sidecar_protocol_stream_terminal_invalid");
    }
    const parsed = stream.terminalSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error("sidecar_protocol_stream_terminal_payload_invalid", {
        cause: parsed.error,
      });
    }
    this.#incomingStreams.delete(envelope.streamId);
    stream.onTerminal(parsed.data);
  }

  #cancelOutbound(requestId: string, code: string): void {
    const pending = this.#outbound.get(requestId);
    if (!pending || pending.settled || pending.cancellationCode) return;
    if (pending.diagnosticStarted !== undefined) this.#diagnoseHeartbeat(requestId, "request_cancelled", { durationMs: performance.now() - pending.diagnosticStarted }, new Error(code));
    pending.cancellationCode = code;
    this.#rememberCancelled(requestId);
    if (pending.sendState === "sent") {
      this.#settleOutbound(
        requestId,
        undefined,
        new SidecarProtocolDeliveryError(code, "sent_outcome_unknown"),
      );
      this.#sendCancel(requestId);
      return;
    }
    pending.sendController.abort(new Error(code));
  }

  #sendCancel(requestId: string): void {
    void this.#transport
      .send(
        encodeSidecarEnvelope({
          wireVersion: SIDECAR_WIRE_VERSION,
          sessionNonce: this.#sessionNonce,
          type: "cancel",
          requestNamespace: this.#role,
          requestId,
        }),
        { lane: "control" },
      )
      .then(() => this.#markOutboundActivity())
      .catch(() => undefined);
  }

  async #sendError(
    requestNamespace: SidecarRequestNamespace,
    requestId: string,
    code: string,
    retryable: boolean,
    lane: SidecarFrameLane = "control",
    diagnosticStarted?: number,
  ): Promise<void> {
    try {
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(requestId, "response_queued", { outcome: "error" }, new SidecarOperationError(code, retryable));
      await this.#transport.send(
        encodeSidecarEnvelope({
          wireVersion: SIDECAR_WIRE_VERSION,
          sessionNonce: this.#sessionNonce,
          type: "response",
          requestNamespace,
          requestId,
          outcome: "error",
          error: { code, retryable },
        }),
        { lane, ...this.#heartbeatWriteOptions(requestId, "response", diagnosticStarted !== undefined) },
      );
    } catch (error) {
      if (diagnosticStarted !== undefined) this.#diagnoseHeartbeat(requestId, "response_send_failed", { durationMs: performance.now() - diagnosticStarted }, error);
      const failure = asError(error);
      this.#beginClose(failure);
      await this.#transport.close(failure.message).catch(() => undefined);
    }
  }

  #tracesHeartbeat(definition: { capabilityId: string; majorVersion: number; operation: string }): boolean {
    try {
      return Boolean(this.#onDiagnostic && this.#diagnosticsEnabled() &&
        definition.capabilityId === controlPingOperation.capabilityId && definition.majorVersion === controlPingOperation.majorVersion &&
        definition.operation === controlPingOperation.operation);
    } catch { return false; }
  }

  #heartbeatWriteOptions(requestId: string, direction: "request" | "response", enabled: boolean): Pick<SidecarFrameSendOptions, "onWriteDiagnostic"> {
    return enabled ? { onWriteDiagnostic: record => this.#diagnoseHeartbeat(requestId, `${direction}_frame_${record.stage}`, record) } : {};
  }

  #diagnoseHeartbeat(requestId: string, stage: string, fields: Partial<SidecarHeartbeatDiagnostic> = {}, error?: unknown): void {
    try {
      if (!this.#onDiagnostic || !this.#diagnosticsEnabled()) return;
      this.#onDiagnostic({ ...this.#transport.diagnosticSnapshot?.(), ...fields, role: this.#role, requestId, stage,
        carrierGeneration: this.#transport.assurance.carrierGeneration, transportKind: this.#transport.assurance.kind }, error);
    } catch { /* Observations cannot affect protocol admission or delivery. */ }
  }

  #commitHello(role: SidecarRequestNamespace, payload: unknown): void {
    if (this.#role !== role || this.#helloComplete) {
      throw new Error("sidecar_protocol_hello_state_invalid");
    }
    const hello = controlHelloOperation.responseSchema.parse(payload);
    const agentToolCliAccepted = hello.sedesCapabilities.some(
      (capability) =>
        capability.capabilityId === "agent_tools_cli" &&
        capability.majorVersion === 3,
    );
    if (agentToolCliAccepted !== Boolean(hello.agentToolCli)) {
      throw new Error("sidecar_protocol_agent_tool_cli_metadata_mismatch");
    }
    const sidecar = negotiatedInventory(hello.sidecarCapabilities);
    const sedes = negotiatedInventory(hello.sedesCapabilities);
    const local = role === "sidecar" ? sidecar : sedes;
    const remote = role === "sidecar" ? sedes : sidecar;
    for (const key of local.operations) {
      const [capabilityId, majorVersion, operation] = key.split("\0");
      if (
        !capabilityId ||
        !majorVersion ||
        !operation ||
        !this.#registry.resolve({
          capabilityId,
          majorVersion: Number(majorVersion),
          operation,
        })
      ) {
        throw new Error("sidecar_protocol_local_capability_mismatch");
      }
    }
    this.#localCapabilities = local.capabilities;
    this.#remoteCapabilities = remote.capabilities;
    this.#localOperations = local.operations;
    this.#remoteOperations = remote.operations;
    this.#helloComplete = true;
  }

  #settleOutbound(requestId: string, value?: unknown, error?: Error): void {
    const pending = this.#outbound.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#outbound.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) {
      pending.signal!.removeEventListener("abort", pending.abort);
    }
    if (isHelloDefinition(pending.definition)) this.#helloInProgress = false;
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  #beginClose(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    // Persistent owners must detach their resource callbacks before an EOF is
    // translated into request cancellation. This callback never extends peer life.
    try { this.#onClosing?.(); } catch { /* Peer closure must still settle. */ }
    for (const active of this.#inbound.values()) {
      if (active.deadline) clearTimeout(active.deadline);
      active.controller.abort(new Error("sidecar_protocol_peer_closed"));
    }
    this.#inbound.clear();
    this.#incomingStreams.clear();
    for (const stream of this.#outgoingStreams.values()) {
      stream.terminalRequested = true;
      stream.terminal = true;
      wakeStreamWaiters(stream);
    }
    this.#outgoingStreams.clear();
    this.#terminalOutgoingStreams.clear();
    for (const [requestId, pending] of this.#outbound) {
      if (pending.sendState === "sent") {
        this.#settleOutbound(
          requestId,
          undefined,
          new SidecarProtocolDeliveryError(
            error.message,
            "sent_outcome_unknown",
          ),
        );
      }
      // An unresolved send owns the authoritative delivery classification and
      // will be rejected by transport close.
    }
  }

  #transportEnded(error: Error): void {
    this.#beginClose(error);
  }

  #rememberReceived(requestId: string): void {
    this.#receivedRequestIds.add(requestId);
    trimSet(this.#receivedRequestIds, this.#limits.maximumInboundRequests * 2);
  }

  #rememberCancelled(requestId: string): void {
    this.#cancelledOutbound.add(requestId);
    trimSet(this.#cancelledOutbound, this.#limits.maximumOutboundRequests * 2);
  }

  #markInboundActivity(): void {
    const now = Date.now();
    this.#lastActivityAtMilliseconds = now;
    this.#lastInboundActivityAtMilliseconds = now;
  }

  #markOutboundActivity(): void {
    const now = Date.now();
    this.#lastActivityAtMilliseconds = now;
    this.#lastOutboundActivityAtMilliseconds = now;
  }
}

function isHelloDefinition(
  definition: SidecarOperationDefinition<unknown, unknown>,
): boolean {
  return operationKey(definition) === operationKey(controlHelloOperation);
}

function isHelloRequest(envelope: SidecarRequestEnvelope): boolean {
  return operationKey(envelope) === operationKey(controlHelloOperation);
}

function negotiatedInventory(
  capabilities: readonly SidecarCapabilityInventory[],
): {
  readonly capabilities: ReadonlySet<string>;
  readonly operations: ReadonlySet<string>;
} {
  const operations = new Set<string>();
  const capabilityKeys = new Set<string>();
  for (const capability of capabilities) {
    const prefix = capabilityPrefix(capability);
    if (capabilityKeys.has(prefix)) {
      throw new Error("sidecar_protocol_capability_duplicate");
    }
    capabilityKeys.add(prefix);
    for (const operation of capability.operations) {
      const key = `${prefix}\0${operation}`;
      if (operations.has(key)) {
        throw new Error("sidecar_protocol_operation_duplicate");
      }
      operations.add(key);
    }
  }
  return { capabilities: capabilityKeys, operations };
}

function operationKey(input: {
  readonly capabilityId: string;
  readonly majorVersion: number;
  readonly operation: string;
}): string {
  return `${capabilityPrefix(input)}\0${input.operation}`;
}

function resolveOutboundDeadline(
  definition: SidecarOperationDefinition<unknown, unknown>,
  options:
    | {
        readonly signal?: AbortSignal;
        readonly deadlineMilliseconds?: number;
      }
    | undefined,
  maximumProtocolDeadlineMilliseconds: number,
): SidecarRequestEnvelope["deadline"] {
  if (definition.maximumDeadlineMilliseconds === "caller_abort") {
    if (!options?.signal || options.deadlineMilliseconds !== undefined) {
      throw new Error("sidecar_caller_abort_signal_required");
    }
    return { mode: "caller_abort" };
  }
  const requestedDeadline =
    options?.deadlineMilliseconds ?? definition.maximumDeadlineMilliseconds;
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= 0) {
    throw new Error("sidecar_request_deadline_invalid");
  }
  return {
    mode: "finite",
    milliseconds: Math.min(
      requestedDeadline,
      definition.maximumDeadlineMilliseconds,
      maximumProtocolDeadlineMilliseconds,
    ),
  };
}

function resolveInboundDeadline(
  definition: SidecarOperationDefinition<unknown, unknown>,
  deadline: SidecarRequestEnvelope["deadline"],
  maximumProtocolDeadlineMilliseconds: number,
): number | undefined {
  if (definition.maximumDeadlineMilliseconds === "caller_abort") {
    if (deadline.mode !== "caller_abort") {
      throw new Error("sidecar_request_deadline_mode_invalid");
    }
    return undefined;
  }
  if (deadline.mode !== "finite") {
    throw new Error("sidecar_request_deadline_mode_invalid");
  }
  return Math.min(
    deadline.milliseconds,
    definition.maximumDeadlineMilliseconds,
    maximumProtocolDeadlineMilliseconds,
  );
}

function capabilityPrefix(input: {
  readonly capabilityId: string;
  readonly majorVersion: number;
}): string {
  return `${input.capabilityId}\0${input.majorVersion}`;
}

function eventKey(input: {
  readonly capabilityId: string;
  readonly majorVersion: number;
  readonly event: string;
}): string {
  return `${capabilityPrefix(input)}\0${input.event}`;
}

function trimSet(values: Set<string>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function validateStreamId(streamId: string): void {
  if (!z.uuid().safeParse(streamId).success) {
    throw new Error("sidecar_stream_id_invalid");
  }
}

function validateStreamCredit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 16 * 1024 * 1024) {
    throw new Error("sidecar_stream_credit_invalid");
  }
}

async function waitForCredit(
  stream: OutgoingStream,
  bytes: number,
  signal?: AbortSignal,
): Promise<void> {
  while (stream.credit < bytes && !stream.terminalRequested) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        stream.waiters.delete(wake);
        reject(signal?.reason);
      };
      stream.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  signal?.throwIfAborted();
  if (stream.terminalRequested) throw new Error("sidecar_stream_closed");
}

function wakeStreamWaiters(stream: OutgoingStream): void {
  const waiters = [...stream.waiters];
  stream.waiters.clear();
  for (const waiter of waiters) waiter();
}

async function raceAgainstAbort<T>(
  operation: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (succeeded: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      if (succeeded) resolve(value as T);
      else reject(value);
    };
    const aborted = () => finish(false, signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    let result: T | Promise<T>;
    try {
      result = operation();
    } catch (error) {
      finish(false, error);
      return;
    }
    void Promise.resolve(result).then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
    if (signal.aborted) aborted();
  });
}

function classifyOperationError(
  error: unknown,
  signal: AbortSignal,
): { readonly code: string; readonly retryable: boolean } {
  if (signal.aborted) {
    const reason = signal.reason;
    return {
      code:
        reason instanceof Error && reason.message === "sidecar_request_timeout"
          ? "sidecar_request_timeout"
          : "sidecar_request_cancelled",
      retryable: false,
    };
  }
  if (error instanceof SidecarOperationError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "sidecar_operation_failed", retryable: false };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("sidecar_protocol_error");
}

function writeDelivery(error: unknown): "not_sent" | "sent_outcome_unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "delivery" in error &&
    (error.delivery === "not_sent" || error.delivery === "sent_outcome_unknown")
  ) {
    return error.delivery;
  }
  return "sent_outcome_unknown";
}
