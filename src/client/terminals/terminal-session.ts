import {
  TERMINAL_WEBSOCKET_PROTOCOL,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  terminalServerFrameSchema,
  type TerminalClientFrame,
  type TerminalResource,
  type TerminalServerFrame,
} from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  TerminalInputSequencer,
  type SequencedTerminalInput,
} from "./input-sequencer.js";

export type TerminalConnectionState =
  | "idle"
  | "authorizing"
  | "connecting"
  | "restoring"
  | "ready"
  | "reconnecting"
  | "closed"
  | "failed";

export type TerminalLifecycle = TerminalResource["lifecycle"];
export type TerminalRole = "controller" | "observer";

export interface TerminalSessionSnapshot {
  readonly connection: TerminalConnectionState;
  readonly role: TerminalRole;
  readonly controlRequestPending: boolean;
  readonly controllerEpoch: number;
  readonly lifecycle: TerminalLifecycle;
  readonly lifecycleRevision: number;
  readonly rows: number;
  readonly columns: number;
  readonly appliedSeq?: number;
  readonly caughtUp: boolean;
  readonly inputAvailable: boolean;
  readonly retryInputAvailable: boolean;
  readonly uncertainInputSeq?: number;
  readonly queuedInputCount: number;
  readonly queuedInputBytes: number;
  readonly inputQueueOverflowed: boolean;
  readonly message?: string;
}

export interface TerminalEmulatorSink {
  reset(): void | Promise<void>;
  write(bytes: Uint8Array): void | Promise<void>;
  resize(columns: number, rows: number): void | Promise<void>;
}

export interface TerminalSessionOptions {
  readonly api: Pick<ApiClient, "createTerminalAdmission" | "terminalWebSocketUrl">;
  readonly terminal: TerminalResource;
  readonly producerId: string;
  readonly requestedRole: TerminalRole;
  readonly sink: TerminalEmulatorSink;
  readonly onRemoved?: () => void;
  readonly webSocketFactory?: (url: string, protocols: string[]) => TerminalSessionSocket;
  readonly reconnectDelayMilliseconds?: number;
}

export interface TerminalSessionSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
}

type SessionSocket = ReturnType<NonNullable<TerminalSessionOptions["webSocketFactory"]>>;

const MAX_RECONNECT_DELAY_MILLISECONDS = 8_000;
const OUTPUT_ACK_DELAY_MILLISECONDS = 0;
const OPEN = 1;
const MAX_INPUT_BYTES = 64 * 1_024;
export const MAX_QUEUED_INPUT_BYTES = 256 * 1_024;
export const MAX_QUEUED_INPUT_ENTRIES = 256;

/** Browser-valid private close codes for client-requested detach/restart paths. */
export const TERMINAL_CLIENT_CLOSE_CODES = Object.freeze({
  reconcileInput: 4001,
  resyncRequired: 4002,
  applyFailed: 4003,
  terminalError: 4400,
  invalidServerFrame: 4401,
});

/** One visible panel attachment. Closing it never terminates the PTY. */
export class TerminalSession {
  readonly #api: TerminalSessionOptions["api"];
  readonly #terminal: TerminalResource;
  readonly #producerId: string;
  #desiredRole: TerminalRole;
  readonly #sink: TerminalEmulatorSink;
  readonly #onRemoved?: () => void;
  readonly #webSocketFactory: NonNullable<TerminalSessionOptions["webSocketFactory"]>;
  readonly #baseReconnectDelay: number;
  readonly #sequencer: TerminalInputSequencer;
  readonly #listeners = new Set<(snapshot: TerminalSessionSnapshot) => void>();
  #snapshot: TerminalSessionSnapshot;
  #socket?: SessionSocket;
  #closed = false;
  #admissionPending = false;
  #onlineListenerInstalled = false;
  #connectEpoch = 0;
  #reconnectAttempts = 0;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #pendingOutputAckSeq?: number;
  #outputAckTimer?: ReturnType<typeof setTimeout>;
  #applyQueue = Promise.resolve();
  #restoreOnNextAttach = true;
  #attachRestoreKind: "checkpoint" | "resume" = "checkpoint";
  #activeSnapshotSeq?: number;
  #activeSnapshot?: {
    readonly seq: number;
    readonly rows: number;
    readonly columns: number;
    readonly byteLength: number;
    readonly chunkCount: number;
    readonly chunks: Uint8Array[];
    receivedBytes: number;
  };
  #queuedInput: Uint8Array[] = [];
  #queuedInputBytes = 0;

  constructor(options: TerminalSessionOptions) {
    this.#api = options.api;
    this.#terminal = options.terminal;
    this.#producerId = options.producerId;
    this.#desiredRole = options.requestedRole;
    this.#sink = options.sink;
    this.#onRemoved = options.onRemoved;
    this.#webSocketFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
    this.#baseReconnectDelay = options.reconnectDelayMilliseconds ?? 500;
    this.#sequencer = new TerminalInputSequencer(options.producerId);
    this.#snapshot = Object.freeze({
      connection: "idle",
      role: "observer",
      controlRequestPending: false,
      controllerEpoch: 0,
      lifecycle: options.terminal.lifecycle,
      lifecycleRevision: options.terminal.lifecycleRevision,
      rows: options.terminal.rows,
      columns: options.terminal.columns,
      caughtUp: false,
      inputAvailable: false,
      retryInputAvailable: false,
      queuedInputCount: 0,
      queuedInputBytes: 0,
      inputQueueOverflowed: false,
    });
  }

  get snapshot(): TerminalSessionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: TerminalSessionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    if (this.#closed || this.#socket || this.#admissionPending) return;
    this.#installOnlineListener();
    this.#admissionPending = true;
    const connectEpoch = ++this.#connectEpoch;
    this.#setSnapshot({
      connection: this.#reconnectAttempts === 0 ? "authorizing" : "reconnecting",
      caughtUp: false,
      inputAvailable: false,
      message: this.#sequencer.uncertainInputSeq === undefined
        ? undefined
        : this.#snapshot.message,
    });
    const restore = !this.#restoreOnNextAttach && this.#snapshot.appliedSeq !== undefined
      ? { kind: "resume" as const, appliedSeq: this.#snapshot.appliedSeq }
      : { kind: "checkpoint" as const };
    this.#attachRestoreKind = restore.kind;
    void this.#api.createTerminalAdmission(this.#terminal.terminalId, {
      producerId: this.#producerId,
      requestedRole: this.#desiredRole,
      emulator: {
        family: "ghostty-web",
        version: "0.4.0",
        unicodeVersion: "11",
        restoreFormat: "ansi-checkpoint-v1",
      },
      restore,
    }).then((admission) => {
      if (this.#closed || connectEpoch !== this.#connectEpoch) return;
      this.#admissionPending = false;
      if (
        admission.terminalId !== this.#terminal.terminalId ||
        admission.incarnationId !== this.#terminal.incarnationId
      ) throw new Error("The terminal changed before it could be opened.");
      if (Date.parse(admission.expiresAt) <= Date.now()) {
        throw new Error("The terminal admission expired before connection.");
      }
      const socket = this.#webSocketFactory(this.#api.terminalWebSocketUrl(), [
        TERMINAL_WEBSOCKET_PROTOCOL,
        admission.token,
      ]);
      socket.binaryType = "arraybuffer";
      this.#socket = socket;
      this.#setSnapshot({ connection: "connecting" });
      socket.onopen = () => {
        if (socket === this.#socket) this.#setSnapshot({ connection: "restoring" });
      };
      socket.onmessage = (event) => { void this.#receive(event.data, socket); };
      socket.onerror = () => {
        if (socket === this.#socket) this.#setSnapshot({ message: "The terminal connection failed." });
      };
      socket.onclose = (event) => {
        if (socket !== this.#socket) return;
        this.#socket = undefined;
        this.#clearPendingOutputAck();
        this.#activeSnapshotSeq = undefined;
        const closeMessage = terminalCloseMessage(event);
        this.#setSnapshot({
          role: "observer",
          caughtUp: false,
          inputAvailable: false,
          ...(closeMessage ? { message: closeMessage } : {}),
        });
        if (!this.#closed) this.#scheduleReconnect();
      };
    }).catch((error: unknown) => {
      if (this.#closed || connectEpoch !== this.#connectEpoch) return;
      this.#admissionPending = false;
      this.#setSnapshot({ message: messageFrom(error) });
      this.#scheduleReconnect();
    });
  }

  /** Immediately retries a visible attachment without terminating its PTY. */
  retryConnection(): boolean {
    if (this.#closed || this.#socket) return false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    // Supersede an admission request which may be stalled behind a restored
    // network connection. Its eventual result is ignored by connectEpoch.
    this.#connectEpoch += 1;
    this.#admissionPending = false;
    this.connect();
    return true;
  }

  sendInput(data: string | Uint8Array): boolean {
    if (
      this.#snapshot.connection !== "ready" ||
      !this.#snapshot.caughtUp ||
      this.#snapshot.role !== "controller" ||
      this.#snapshot.lifecycle !== "running" ||
      !this.#sequencer.queueingAvailable
    ) return false;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) return false;
    if (this.#queuedInput.length > 0) {
      return this.#enqueueInput(bytes);
    }
    const result = this.#sequencer.sequence(bytes);
    if (!result.accepted) {
      return result.reason === "window_full"
        ? this.#enqueueInput(bytes)
        : false;
    }
    if (!this.#sendInputFrame(result.input)) {
      this.#sequencer.markNotSent(result.input.inputSeq);
      this.#publishInputAvailability();
      return false;
    }
    this.#publishInputAvailability();
    return true;
  }

  retryNotSentInput(): boolean {
    if (
      this.#snapshot.connection !== "ready" ||
      this.#snapshot.role !== "controller" ||
      this.#snapshot.lifecycle !== "running"
    ) return false;
    const input = this.#sequencer.retryNotSent();
    if (!input) return false;
    const sent = this.#sendInputFrame(input);
    if (!sent) this.#sequencer.markNotSent(input.inputSeq);
    this.#publishInputAvailability();
    return sent;
  }

  /** Explicitly abandons ambiguous bytes after reattach could not confirm them. */
  discardUnconfirmedInput(): boolean {
    if (
      this.#snapshot.connection !== "ready" ||
      !this.#snapshot.caughtUp ||
      this.#snapshot.role !== "controller" ||
      this.#snapshot.lifecycle !== "running" ||
      !this.#socket ||
      this.#socket.readyState !== OPEN ||
      !this.#sequencer.discardUncertain()
    ) return false;
    this.#queuedInput = [];
    this.#queuedInputBytes = 0;
    this.#setSnapshot({
      inputQueueOverflowed: false,
      message:
        "Unconfirmed input was discarded. It may already have reached the terminal.",
    });
    this.#publishInputAvailability();
    return true;
  }

  resize(columns: number, rows: number): boolean {
    if (!this.#snapshot.inputAvailable) return false;
    return this.#send({
      v: TERMINAL_PROTOCOL_VERSION,
      type: "resize",
      terminalId: this.#terminal.terminalId,
      incarnationId: this.#requiredIncarnationId(),
      controllerEpoch: this.#snapshot.controllerEpoch,
      columns,
      rows,
    });
  }

  claimControl(): boolean {
    if (
      this.#snapshot.lifecycle !== "running" ||
      this.#snapshot.controlRequestPending
    )
      return false;
    const sent = this.#sendIdentityFrame("claim_control");
    if (sent) {
      this.#desiredRole = "controller";
      this.#setSnapshot({ controlRequestPending: true });
    }
    return sent;
  }

  releaseControl(): boolean {
    const sent = this.#sendIdentityFrame("release_control");
    if (sent) this.#desiredRole = "observer";
    return sent;
  }

  close(): void {
    this.#closed = true;
    this.#admissionPending = false;
    this.#connectEpoch += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#clearPendingOutputAck();
    this.#removeOnlineListener();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "viewer_detached");
    this.#sequencer.loseControl();
    this.#setSnapshot({
      connection: "closed",
      role: "observer",
      caughtUp: false,
      inputAvailable: false,
      retryInputAvailable: false,
    });
  }

  async #receive(raw: unknown, source: SessionSocket): Promise<void> {
    if (source !== this.#socket) return;
    if (raw instanceof Blob) raw = await raw.arrayBuffer();
    if (source !== this.#socket) return;
    if (raw instanceof ArrayBuffer) {
      let decoded: ReturnType<typeof decodeTerminalBinaryFrame>;
      try { decoded = decodeTerminalBinaryFrame(new Uint8Array(raw)); }
      catch { return this.#failProtocol("The terminal server sent an invalid binary frame."); }
      if (decoded.kind !== "output") return this.#failProtocol("The terminal server sent an invalid binary frame kind.");
      this.#parseFrame({
        ...(isRecord(decoded.header) ? decoded.header : {}),
        data: encodeBase64Url(decoded.payload),
      }, source);
      return;
    }
    if (typeof raw !== "string") return this.#failProtocol("The terminal server sent an unsupported frame.");
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { return this.#failProtocol("The terminal server sent malformed JSON."); }
    this.#parseFrame(value, source);
  }

  #parseFrame(value: unknown, source: SessionSocket): void {
    const result = terminalServerFrameSchema.safeParse(value);
    if (!result.success) return this.#failProtocol("The terminal server sent an invalid frame.");
    const frame = result.data;
    if (
      frame.terminalId !== this.#terminal.terminalId ||
      frame.incarnationId !== this.#terminal.incarnationId
    ) return this.#failProtocol("The terminal server addressed a stale incarnation.");
    this.#handleFrame(frame, source);
  }

  #handleFrame(frame: TerminalServerFrame, source: SessionSocket): void {
    switch (frame.type) {
      case "attached":
        this.#attachRestoreKind = frame.restoreKind;
        this.#applyQueue = this.#applyQueue.then(async () => {
          if (source !== this.#socket) return;
          await this.#sink.resize(frame.columns, frame.rows);
          if (frame.restoreKind === "resume") this.#restoreOnNextAttach = false;
          this.#setSnapshot({
            connection: "restoring",
            lifecycle: frame.lifecycle,
            lifecycleRevision: frame.lifecycleRevision,
            rows: frame.rows,
            columns: frame.columns,
            caughtUp: false,
          });
          if (frame.lifecycle === "running") this.#adoptRole(frame);
          else {
            this.#sequencer.loseControl(frame.lastAcceptedInputSeq);
            this.#setSnapshot({
              role: "observer",
              controllerEpoch: frame.controllerEpoch,
              uncertainInputSeq: this.#sequencer.uncertainInputSeq,
            });
          }
        }).catch((error: unknown) => this.#failApply(error));
        return;
      case "snapshot_begin":
        if (this.#attachRestoreKind !== "checkpoint" || this.#activeSnapshotSeq !== undefined) {
          this.#failProtocol("The terminal server sent an unexpected snapshot.");
          return;
        }
        this.#activeSnapshotSeq = frame.checkpointSeq;
        this.#activeSnapshot = {
          seq: frame.checkpointSeq,
          rows: frame.rows,
          columns: frame.columns,
          byteLength: frame.byteLength,
          chunkCount: frame.chunkCount,
          chunks: [],
          receivedBytes: 0,
        };
        return;
      case "snapshot_chunk": {
        const snapshot = this.#activeSnapshot;
        if (
          !snapshot ||
          frame.checkpointSeq !== snapshot.seq ||
          frame.chunkIndex !== snapshot.chunks.length ||
          frame.chunkIndex >= snapshot.chunkCount
        ) {
          this.#failProtocol("The terminal snapshot chunk was invalid.");
          return;
        }
        const bytes = decodeBase64Url(frame.data);
        snapshot.receivedBytes += bytes.byteLength;
        if (snapshot.receivedBytes > snapshot.byteLength) {
          this.#failProtocol("The terminal snapshot length was invalid.");
          return;
        }
        snapshot.chunks.push(bytes);
        this.#send({
          v: TERMINAL_PROTOCOL_VERSION,
          type: "ack_snapshot",
          terminalId: this.#terminal.terminalId,
          incarnationId: this.#requiredIncarnationId(),
          checkpointSeq: snapshot.seq,
          chunkIndex: frame.chunkIndex,
        });
        return;
      }
      case "snapshot_end":
        if (this.#activeSnapshotSeq !== frame.checkpointSeq) {
          this.#failProtocol("The terminal snapshot boundary was invalid.");
          return;
        }
        const activeSnapshot = this.#activeSnapshot;
        this.#activeSnapshotSeq = undefined;
        this.#activeSnapshot = undefined;
        this.#applyQueue = this.#applyQueue.then(async () => {
          if (source !== this.#socket) return;
          if (
            !activeSnapshot ||
            activeSnapshot.chunks.length !== activeSnapshot.chunkCount ||
            activeSnapshot.receivedBytes !== activeSnapshot.byteLength
          ) {
            throw new Error("The terminal snapshot was incomplete.");
          }
          const snapshotBytes = concatenate(activeSnapshot.chunks, activeSnapshot.byteLength);
          if (sha256Hex(snapshotBytes) !== frame.sha256) {
            throw new Error("The terminal snapshot checksum was invalid.");
          }
          await this.#sink.reset();
          await this.#sink.resize(activeSnapshot.columns, activeSnapshot.rows);
          if (snapshotBytes.byteLength > 0) await this.#sink.write(snapshotBytes);
          this.#setSnapshot({ appliedSeq: frame.checkpointSeq });
          this.#restoreOnNextAttach = false;
        }).catch((error: unknown) => this.#failApply(error));
        return;
      case "output":
        this.#enqueueSequenced(frame.seq, source, () => this.#sink.write(decodeBase64Url(frame.data)));
        return;
      case "resize_committed":
        this.#enqueueSequenced(frame.seq, source, () => this.#sink.resize(frame.columns, frame.rows));
        this.#setSnapshot({ rows: frame.rows, columns: frame.columns });
        return;
      case "caught_up":
        this.#applyQueue = this.#applyQueue.then(() => {
          if (source !== this.#socket) return;
          if ((this.#snapshot.appliedSeq ?? 0) < frame.headSeq) throw new Error("Terminal replay ended before its advertised head.");
          this.#flushOutputAck(source);
          this.#reconnectAttempts = 0;
          this.#setSnapshot({ connection: "ready", caughtUp: true });
          this.#drainInputQueue();
          this.#publishInputAvailability();
        }).catch((error: unknown) => this.#failApply(error));
        return;
      case "input_result":
        this.#sequencer.resolve(
          frame.inputSeq,
          frame.outcome,
          frame.lastAcceptedInputSeq,
          frame.message,
        );
        this.#setSnapshot({
          uncertainInputSeq: this.#sequencer.uncertainInputSeq,
          message: frame.outcome === "sent_outcome_unknown"
            ? frame.message ?? "Input delivery could not be confirmed."
            : frame.outcome === "rejected"
              ? frame.message ?? "Terminal input was rejected."
              : frame.outcome === "not_sent"
                ? frame.message ?? "Terminal input was not sent; it is safe to retry."
              : undefined,
        });
        if (
          frame.outcome === "accepted" ||
          frame.outcome === "duplicate" ||
          (frame.outcome === "rejected" && frame.message === "input_gap")
        ) {
          this.#drainInputQueue();
        }
        this.#publishInputAvailability();
        if (frame.outcome === "sent_outcome_unknown") {
          this.#socket?.close(TERMINAL_CLIENT_CLOSE_CODES.reconcileInput, "reconcile_input");
        }
        return;
      case "control_changed": this.#adoptRole(frame); return;
      case "terminal_status":
        this.#enqueueSequenced(frame.seq, source, () => {
          if (frame.lifecycleRevision <= this.#snapshot.lifecycleRevision) return;
          if (frame.lifecycle !== "running") this.#sequencer.loseControl();
          this.#setSnapshot({
            lifecycle: frame.lifecycle,
            lifecycleRevision: frame.lifecycleRevision,
            ...(frame.lifecycle === "running"
              ? {}
              : {
                  role: "observer" as const,
                  controlRequestPending: false,
                }),
            message: frame.publicReason ?? undefined,
          });
          this.#publishInputAvailability();
        });
        return;
      case "lifecycle_state":
        // This state is intentionally outside the raw journal: apply the
        // monotonic lifecycle revision immediately without claiming headSeq
        // was rendered or moving the replay acknowledgement cursor.
        if (frame.lifecycleRevision <= this.#snapshot.lifecycleRevision) return;
        if (frame.lifecycle !== "running") this.#sequencer.loseControl();
        this.#setSnapshot({
          lifecycle: frame.lifecycle,
          lifecycleRevision: frame.lifecycleRevision,
          ...(frame.lifecycle === "running"
            ? {}
            : {
                role: "observer" as const,
                controlRequestPending: false,
              }),
          message: frame.publicReason ?? undefined,
        });
        this.#publishInputAvailability();
        return;
      case "resync_required":
        this.#restoreOnNextAttach = true;
        this.#setSnapshot({
          connection: "restoring",
          caughtUp: false,
          inputAvailable: false,
          message: "Terminal history changed; restoring the latest screen.",
        });
        this.#socket?.close(TERMINAL_CLIENT_CLOSE_CODES.resyncRequired, "resync_required");
        return;
      case "terminal_removed":
        this.#handleRemoved(source);
        return;
      case "error":
        this.#setSnapshot({
          controlRequestPending: false,
          message: frame.message,
        });
        if (!frame.retryable) {
          this.#closed = true;
          this.#setSnapshot({ connection: "failed", inputAvailable: false });
          this.#socket?.close(TERMINAL_CLIENT_CLOSE_CODES.terminalError, "terminal_error");
        }
    }
  }

  #handleRemoved(source: SessionSocket): void {
    if (source !== this.#socket || this.#closed) return;
    this.#closed = true;
    this.#admissionPending = false;
    this.#connectEpoch += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#removeOnlineListener();
    this.#socket = undefined;
    this.#clearPendingOutputAck();
    this.#activeSnapshotSeq = undefined;
    this.#activeSnapshot = undefined;
    this.#queuedInput = [];
    this.#queuedInputBytes = 0;
    this.#sequencer.loseControl();
    this.#setSnapshot({
      connection: "closed",
      role: "observer",
      controlRequestPending: false,
      caughtUp: false,
      inputAvailable: false,
      retryInputAvailable: false,
      uncertainInputSeq: undefined,
      queuedInputCount: 0,
      queuedInputBytes: 0,
      inputQueueOverflowed: false,
      message: undefined,
    });
    source.close(1_000, "terminal_removed");
    // Invalidate all already-queued output by clearing #socket above, then
    // erase the renderer before telling React to remove the local tab. The
    // callback still runs if renderer cleanup itself fails: an explicitly
    // removed resource must never remain available through stale UI.
    this.#applyQueue = this.#applyQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.#sink.reset();
        } finally {
          this.#onRemoved?.();
        }
      });
  }

  #adoptRole(frame: {
    readonly role: TerminalRole;
    readonly controllerEpoch: number;
    readonly lastAcceptedInputSeq: number;
    readonly incarnationId: string;
  }): void {
    const role = this.#snapshot.lifecycle === "running" ? frame.role : "observer";
    if (role === "controller") {
      this.#sequencer.adoptController({
        incarnationId: frame.incarnationId,
        controllerEpoch: frame.controllerEpoch,
        lastAcceptedInputSeq: frame.lastAcceptedInputSeq,
      });
    } else this.#sequencer.loseControl(frame.lastAcceptedInputSeq);
    this.#setSnapshot({
      role,
      controlRequestPending: false,
      controllerEpoch: frame.controllerEpoch,
      uncertainInputSeq: this.#sequencer.uncertainInputSeq,
      ...(this.#sequencer.uncertainInputSeq === undefined && this.#snapshot.uncertainInputSeq !== undefined
        ? { message: undefined }
        : this.#sequencer.uncertainInputSeq !== undefined
          ? {
              message:
                "Input delivery could not be confirmed. It may already have reached the terminal.",
            }
          : {}),
    });
    if (role === "controller") this.#drainInputQueue();
    this.#publishInputAvailability();
  }

  #enqueueSequenced(
    seq: number,
    source: SessionSocket,
    apply: () => void | Promise<void>,
  ): void {
    this.#applyQueue = this.#applyQueue.then(async () => {
      if (source !== this.#socket) return;
      const applied = this.#snapshot.appliedSeq;
      if (applied !== undefined && seq <= applied) {
        this.#queueOutputAck(applied, source);
        return;
      }
      if (applied !== undefined && seq !== applied + 1) throw new Error("Terminal history contains a sequence gap.");
      await apply();
      this.#setSnapshotWithoutNotify({ appliedSeq: seq });
      if (source === this.#socket) this.#queueOutputAck(seq, source);
    }).catch((error: unknown) => this.#failApply(error));
  }

  #queueOutputAck(appliedSeq: number, source: SessionSocket): void {
    this.#pendingOutputAckSeq = Math.max(
      this.#pendingOutputAckSeq ?? appliedSeq,
      appliedSeq,
    );
    if (this.#outputAckTimer) return;
    this.#outputAckTimer = setTimeout(() => {
      this.#outputAckTimer = undefined;
      this.#flushOutputAck(source);
    }, OUTPUT_ACK_DELAY_MILLISECONDS);
  }

  #flushOutputAck(source: SessionSocket): void {
    if (source !== this.#socket) return;
    const appliedSeq = this.#pendingOutputAckSeq;
    if (appliedSeq === undefined) return;
    this.#pendingOutputAckSeq = undefined;
    if (this.#outputAckTimer) clearTimeout(this.#outputAckTimer);
    this.#outputAckTimer = undefined;
    this.#send({
      v: TERMINAL_PROTOCOL_VERSION, type: "ack_output", terminalId: this.#terminal.terminalId,
      incarnationId: this.#requiredIncarnationId(), appliedSeq,
    });
  }

  #clearPendingOutputAck(): void {
    if (this.#outputAckTimer) clearTimeout(this.#outputAckTimer);
    this.#outputAckTimer = undefined;
    this.#pendingOutputAckSeq = undefined;
  }

  #sendInputFrame(input: SequencedTerminalInput): boolean {
    const frame: TerminalClientFrame = {
      v: TERMINAL_PROTOCOL_VERSION, type: "input", terminalId: this.#terminal.terminalId,
      incarnationId: input.incarnationId, controllerEpoch: input.controllerEpoch,
      producerId: input.producerId, inputSeq: input.inputSeq,
      data: encodeBase64Url(input.bytes),
    };
    const { data: _data, ...header } = frame;
    return this.#sendRaw(encodeTerminalBinaryFrame("input", header, input.bytes));
  }

  #enqueueInput(bytes: Uint8Array): boolean {
    if (
      this.#queuedInput.length + this.#sequencer.pendingInputCount >=
        MAX_QUEUED_INPUT_ENTRIES ||
      this.#queuedInputBytes + this.#sequencer.pendingInputBytes + bytes.byteLength >
        MAX_QUEUED_INPUT_BYTES
    ) {
      this.#setSnapshot({
        inputQueueOverflowed: true,
        message: "Terminal input queue is full; some input was not sent.",
      });
      this.#publishInputAvailability();
      return false;
    }
    const copy = bytes.slice();
    this.#queuedInput.push(copy);
    this.#queuedInputBytes += copy.byteLength;
    this.#publishInputAvailability();
    return true;
  }

  #drainInputQueue(): void {
    if (
      this.#snapshot.connection !== "ready" ||
      !this.#snapshot.caughtUp ||
      this.#snapshot.role !== "controller" ||
      this.#snapshot.lifecycle !== "running"
    ) return;
    while (true) {
      // Replays already occupy the retained ledger. They must run before the
      // new-input capacity check or a full reattach suffix can deadlock.
      const replay = this.#sequencer.nextReplay();
      if (replay) {
        if (!this.#sendInputFrame(replay)) {
          this.#sequencer.markNotSent(replay.inputSeq);
          return;
        }
        continue;
      }
      if (!this.#sequencer.inputAvailable) return;
      const bytes = this.#queuedInput.shift();
      if (!bytes) return;
      this.#queuedInputBytes -= bytes.byteLength;
      const result = this.#sequencer.sequence(bytes);
      if (!result.accepted) {
        this.#queuedInput.unshift(bytes);
        this.#queuedInputBytes += bytes.byteLength;
        return;
      }
      if (!this.#sendInputFrame(result.input)) {
        this.#sequencer.markNotSent(result.input.inputSeq);
        return;
      }
    }
  }

  #sendIdentityFrame(type: "claim_control" | "release_control"): boolean {
    return this.#send({
      v: TERMINAL_PROTOCOL_VERSION, type, terminalId: this.#terminal.terminalId,
      incarnationId: this.#requiredIncarnationId(),
    });
  }

  #send(frame: TerminalClientFrame): boolean {
    return this.#sendRaw(JSON.stringify(frame));
  }

  #sendRaw(frame: string | Uint8Array): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(typeof frame === "string" ? frame : Uint8Array.from(frame).buffer);
      return true;
    } catch {
      return false;
    }
  }

  #requiredIncarnationId(): string {
    const incarnationId = this.#terminal.incarnationId;
    if (!incarnationId) throw new Error("terminal_incarnation_unavailable");
    return incarnationId;
  }

  #publishInputAvailability(): void {
    this.#setSnapshot({
      inputAvailable: this.#snapshot.connection === "ready" && this.#snapshot.caughtUp &&
        this.#snapshot.role === "controller" && this.#snapshot.lifecycle === "running" &&
        this.#sequencer.queueingAvailable &&
        this.#queuedInput.length + this.#sequencer.pendingInputCount <
          MAX_QUEUED_INPUT_ENTRIES &&
        this.#queuedInputBytes + this.#sequencer.pendingInputBytes <
          MAX_QUEUED_INPUT_BYTES,
      uncertainInputSeq: this.#sequencer.uncertainInputSeq,
      retryInputAvailable: this.#sequencer.retryAvailable,
      queuedInputCount: this.#queuedInput.length,
      queuedInputBytes: this.#queuedInputBytes,
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectAttempts += 1;
    this.#setSnapshot({ connection: "reconnecting" });
    const delay = Math.min(this.#baseReconnectDelay * 2 ** (this.#reconnectAttempts - 1), MAX_RECONNECT_DELAY_MILLISECONDS);
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; this.connect(); }, delay);
  }

  #installOnlineListener(): void {
    if (this.#onlineListenerInstalled || typeof window === "undefined") return;
    window.addEventListener("online", this.#handleOnline);
    this.#onlineListenerInstalled = true;
  }

  #removeOnlineListener(): void {
    if (!this.#onlineListenerInstalled || typeof window === "undefined") return;
    window.removeEventListener("online", this.#handleOnline);
    this.#onlineListenerInstalled = false;
  }

  readonly #handleOnline = (): void => {
    this.retryConnection();
  };

  #failProtocol(message: string): void {
    this.#closed = true;
    this.#removeOnlineListener();
    this.#setSnapshot({ connection: "failed", message, inputAvailable: false });
    this.#socket?.close(TERMINAL_CLIENT_CLOSE_CODES.invalidServerFrame, "invalid_terminal_frame");
  }

  #failApply(error: unknown): void {
    this.#restoreOnNextAttach = true;
    this.#setSnapshot({ caughtUp: false, inputAvailable: false, message: messageFrom(error) });
    this.#socket?.close(TERMINAL_CLIENT_CLOSE_CODES.applyFailed, "terminal_apply_failed");
  }

  #setSnapshot(patch: Partial<TerminalSessionSnapshot>): void {
    this.#setSnapshotWithoutNotify(patch);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #setSnapshotWithoutNotify(patch: Partial<TerminalSessionSnapshot>): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...patch });
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(encoded: string): Uint8Array {
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The terminal operation failed.";
}

function terminalCloseMessage(event: CloseEvent): string | undefined {
  switch (event.reason) {
    case "viewer_too_slow":
      return "Terminal output outpaced this viewer; restoring the latest screen.";
    case "server_shutdown":
      return "The terminal server closed the connection; reconnecting.";
    case "terminal_unavailable":
      return "The terminal is temporarily unavailable; reconnecting.";
    case "protocol_error":
      return "The terminal connection encountered a protocol error; reconnecting.";
  }
  if (event.code === 1_013) {
    return "Terminal output outpaced this viewer; restoring the latest screen.";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
