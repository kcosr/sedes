import { createHash, randomInt } from "node:crypto";
import type {
  TerminalClientFrame,
  TerminalResource,
  TerminalServerFrame,
} from "../../shared/protocol/terminals.js";
import { TERMINAL_PROTOCOL_VERSION } from "../../shared/protocol/terminals.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
} from "../execution/interactive-terminal.js";
import type { TerminalJournalRecord, TerminalJournalState } from "./terminal-journal.js";
import { TerminalJournalStore } from "./terminal-journal.js";
import { TerminalRepository } from "./terminal-repository.js";
import { TerminalHeadlessEmulator } from "./terminal-emulator.js";

export interface TerminalViewerSession {
  dispatch(frame: TerminalClientFrame): Promise<void>;
  close(): void;
}

type Viewer = {
  readonly attachmentId: string;
  readonly producerId: string;
  role: "controller" | "observer";
  caughtUp: boolean;
  readonly emit: (frame: TerminalServerFrame) => void;
  closed: boolean;
  readonly liveQueue: TerminalJournalRecord[];
  liveQueueBytes: number;
  lastAckSeq: number;
  lastSentSeq: number;
  readonly outstanding: { readonly seq: number; readonly bytes: number }[];
  outstandingBytes: number;
  snapshotSeq: number | undefined;
  snapshotSentChunkIndex: number;
  snapshotAckChunkIndex: number;
  wake: (() => void) | undefined;
};

type TerminalServerFramePayload = TerminalServerFrame extends infer Frame
  ? Frame extends TerminalServerFrame
    ? Omit<Frame, "v" | "terminalId" | "incarnationId">
    : never
  : never;

const VIEWER_LIVE_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const VIEWER_LIVE_QUEUE_MAX_RECORDS = 2_048;
const VIEWER_ACK_WINDOW_BYTES = 256 * 1024;
const VIEWER_ACK_WINDOW_RECORDS = 64;
const VIEWER_ACK_TIMEOUT_MS = 15_000;
const PROVIDER_PAUSE_HIGH_BYTES = 512 * 1024;
const PROVIDER_RESUME_LOW_BYTES = 128 * 1024;
const PROVIDER_PENDING_MAX_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_AFTER_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_AFTER_RECORDS = 2_048;
const SNAPSHOT_CHUNK_BYTES = 48 * 1024;
const SNAPSHOT_CHUNK_WINDOW = 4;

export class TerminalActor {
  readonly #scope: RequestScope;
  readonly #repository: TerminalRepository;
  readonly #journal: TerminalJournalStore;
  readonly #process: InteractiveTerminalProcess;
  readonly #onTerminalSummaryChanged: () => void;
  readonly #onFinalized: () => void;
  readonly #emulator: TerminalHeadlessEmulator;
  readonly #unsubscribeOutput: () => void;
  readonly #unsubscribeExit: () => void;
  readonly #terminalId: string;
  readonly #incarnationId: string;
  readonly #viewers = new Map<string, Viewer>();
  readonly #producerHighWater = new Map<string, number>();
  readonly #producerInputHashes = new Map<string, Map<number, string>>();
  #terminal: TerminalResource;
  #controllerAttachmentId: string | undefined;
  #controllerProducerId: string | undefined;
  #controllerGraceTimer: NodeJS.Timeout | undefined;
  #controllerEpoch = 0;
  #mailbox = Promise.resolve();
  #finalized = false;
  readonly #finalizedPromise: Promise<TerminalResource>;
  #resolveFinalized!: (terminal: TerminalResource) => void;
  #rejectFinalized!: (error: unknown) => void;
  #endRequested = false;
  #pendingOutputBytes = 0;
  #providerOutputPaused = false;
  #stopTimers: NodeJS.Timeout[] = [];
  #bytesSinceCheckpoint = 0;
  #recordsSinceCheckpoint = 0;
  readonly #ready: Promise<void>;
  #detached = false;
  #remoteAvailable = true;

  constructor(input: {
    readonly scope: RequestScope;
    readonly terminal: TerminalResource;
    readonly repository: TerminalRepository;
    readonly journal: TerminalJournalStore;
    readonly process: InteractiveTerminalProcess;
    readonly onTerminalSummaryChanged: () => void;
    readonly onFinalized: () => void;
  }) {
    if (!input.terminal.incarnationId) {
      throw new Error("terminal_actor_incarnation_required");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#terminal = input.terminal;
    this.#terminalId = input.terminal.terminalId;
    this.#incarnationId = input.terminal.incarnationId;
    this.#repository = input.repository;
    this.#journal = input.journal;
    this.#process = input.process;
    if (input.process.persistent) this.#controllerEpoch = randomInt(1, 2 ** 48 - 1);
    this.#onTerminalSummaryChanged = input.onTerminalSummaryChanged;
    this.#onFinalized = input.onFinalized;
    this.#finalizedPromise = new Promise<TerminalResource>((resolve, reject) => {
      this.#resolveFinalized = resolve;
      this.#rejectFinalized = reject;
    });
    void this.#finalizedPromise.catch(() => undefined);
    this.#emulator = new TerminalHeadlessEmulator({
      rows: input.terminal.rows,
      columns: input.terminal.columns,
      onData: (bytes) => {
        if (this.#process.persistent?.ownsDeviceReplies) return;
        void this.#enqueue(async () => {
          if (!this.#finalized) await this.#process.write(bytes);
        });
      },
    });
    this.#unsubscribeOutput = input.process.onOutput((bytes) => {
      if (this.#detached) return;
      const owned = Uint8Array.from(bytes);
      this.#pendingOutputBytes += owned.byteLength;
      if (
        !this.#providerOutputPaused &&
        this.#pendingOutputBytes >= PROVIDER_PAUSE_HIGH_BYTES
      ) {
        this.#providerOutputPaused = true;
        this.#process.pauseOutput();
      }
      if (this.#pendingOutputBytes > PROVIDER_PENDING_MAX_BYTES) {
        void this.#process.terminate("kill").catch(() => undefined);
        this.#pendingOutputBytes -= owned.byteLength;
        void this.#enqueue(() => this.#finalize({
          lifecycle: "failed",
          exitCode: null,
          exitSignal: null,
          publicReason: "provider_output_overflow",
          cleanupConfirmed: false,
        }));
        return;
      }
      void this.#enqueue(() => this.#recordOutput(owned)).finally(() => {
        this.#pendingOutputBytes -= owned.byteLength;
        if (
          this.#providerOutputPaused &&
          this.#pendingOutputBytes <= PROVIDER_RESUME_LOW_BYTES &&
          !this.#finalized
        ) {
          this.#providerOutputPaused = false;
          this.#process.resumeOutput();
        }
      });
    });
    this.#unsubscribeExit = input.process.onExit((exit) => {
      if (this.#detached) return;
      void this.#enqueue(() => this.#recordExit(exit));
    });
    this.#ready = input.process.persistent?.start({
      restore: (snapshot) => this.#enqueue(() => this.#restoreRemote(snapshot)),
      resize: (size) => this.#enqueue(() => this.#recordResize(size)),
      unavailable: () => {
        this.#remoteAvailable = false;
        void this.#enqueue(() => {
          if (this.#finalized || this.#detached) return;
          this.#revokeController();
          for (const viewer of [...this.#viewers.values()]) {
            this.#emitError(viewer, "terminal_unavailable", "The execution host is disconnected; its terminal may still be running.", true);
            this.#detach(viewer);
          }
        });
      },
    }) ?? Promise.resolve();
    void this.#ready.catch(() => undefined);
  }

  async ready(): Promise<void> { await this.#ready; await this.#mailbox; }
  get available(): boolean { return !this.#detached && this.#remoteAvailable; }

  get terminal(): TerminalResource {
    return this.#terminal;
  }

  async attach(input: {
    readonly attachmentId: string;
    readonly producerId: string;
    readonly requestedRole: "controller" | "observer";
    readonly restore:
      | { readonly kind: "checkpoint" }
      | { readonly kind: "resume"; readonly appliedSeq: number };
    readonly emit: (frame: TerminalServerFrame) => void;
  }): Promise<TerminalViewerSession> {
    await this.#ready;
    const recoveredInputHighWater = this.#process.persistent
      ? await this.#process.persistent.inputHighWater(input.producerId) : undefined;
    const prepared = await this.#enqueue(() => {
      if (this.#finalized) throw new Error("terminal_actor_finalized");
      if (recoveredInputHighWater !== undefined) this.#producerHighWater.set(input.producerId, recoveredInputHighWater);
      if (this.#viewers.size >= 16) {
        throw new Error("terminal_viewer_limit_reached");
      }
      const replayHead = this.#terminal.headSeq;
      const journalState = this.#journal.read(this.#scope, this.#terminalId);
      if (
        journalState.headSeq !== replayHead ||
        journalState.checkpoint.seq !== this.#terminal.historyFloorSeq
      ) {
        throw new Error("terminal_journal_metadata_mismatch");
      }
      const canResume =
        input.restore.kind === "resume" &&
        input.restore.appliedSeq >= this.#terminal.historyFloorSeq &&
        input.restore.appliedSeq <= replayHead;
      const restoreKind = canResume ? "resume" as const : "checkpoint" as const;
      const replayAfter = canResume
        ? input.restore.appliedSeq
        : journalState.checkpoint.seq;
      const existingController = this.#controllerAttachmentId
        ? this.#viewers.get(this.#controllerAttachmentId)
        : undefined;
      const sameProducerReplacement =
        existingController?.producerId === input.producerId;
      const canTakeUnheldControl =
        this.#terminal.lifecycle === "running" &&
        (sameProducerReplacement ||
          (this.#controllerAttachmentId === undefined &&
            (this.#controllerProducerId === undefined ||
              this.#controllerProducerId === input.producerId)));
      const role =
        input.requestedRole === "controller" && canTakeUnheldControl
          ? "controller"
          : "observer";
      if (role === "controller") {
        if (sameProducerReplacement && existingController) {
          existingController.role = "observer";
          this.#emitControl(existingController);
        }
        const reclaim = this.#controllerProducerId === input.producerId;
        if (!reclaim) this.#controllerEpoch += 1;
        if (this.#controllerGraceTimer) {
          clearTimeout(this.#controllerGraceTimer);
          this.#controllerGraceTimer = undefined;
        }
        this.#controllerAttachmentId = input.attachmentId;
        this.#controllerProducerId = input.producerId;
      }
      const viewer: Viewer = {
        attachmentId: input.attachmentId,
        producerId: input.producerId,
        role,
        caughtUp: false,
        emit: input.emit,
        closed: false,
        liveQueue: [],
        liveQueueBytes: 0,
        lastAckSeq: 0,
        lastSentSeq: 0,
        outstanding: [],
        outstandingBytes: 0,
        snapshotSeq: undefined,
        snapshotSentChunkIndex: -1,
        snapshotAckChunkIndex: -1,
        wake: undefined,
      };
      this.#viewers.set(input.attachmentId, viewer);
      this.#send(viewer, this.#frame({
        type: "attached",
        attachmentId: input.attachmentId,
        role,
        controllerEpoch: this.#controllerEpoch,
        lastAcceptedInputSeq:
          this.#producerHighWater.get(input.producerId) ?? 0,
        lifecycle: this.#terminal.lifecycle,
        lifecycleRevision: this.#terminal.lifecycleRevision,
        rows: this.#terminal.rows,
        columns: this.#terminal.columns,
        historyFloorSeq: this.#terminal.historyFloorSeq,
        headSeq: this.#terminal.headSeq,
        restoreKind,
      }), true);
      return { viewer, replayAfter, replayHead, journalState, restoreKind };
    });
    void this.#runViewerPump(
      prepared.viewer,
      prepared.replayAfter,
      prepared.replayHead,
      prepared.journalState,
      prepared.restoreKind,
    );
    return {
      dispatch: (frame) =>
        this.#enqueue(() => this.#dispatch(prepared.viewer, frame)),
      close: () => {
        void this.#enqueue(() => this.#detach(prepared.viewer));
      },
    };
  }

  terminate(expectedRevision: number): Promise<TerminalResource> {
    return this.#beginTermination(expectedRevision, false);
  }

  #beginTermination(
    expectedRevision: number,
    requestedByEnd: boolean,
  ): Promise<TerminalResource> {
    return this.#enqueue(async () => {
      if (this.#terminal.lifecycle === "stopping") {
        this.#endRequested ||= requestedByEnd;
        if (!this.#process.persistent) return this.#terminal;
      } else this.#terminal = this.#repository.markStopping(
        this.#scope,
        this.#terminalId,
        expectedRevision,
        Date.now(),
      );
      this.#endRequested ||= requestedByEnd;
      this.#clearTimers();
      this.#revokeController();
      this.#broadcastStatus();
      try {
        await this.#process.terminate("hangup");
      } finally {
        this.#scheduleEscalation("terminate", 2_000);
        this.#scheduleEscalation("kill", 7_000);
        // A remote carrier cannot prove that the owned PTY exited.
        if (!this.#process.persistent) this.#scheduleUnconfirmedFailure(9_000);
      }
      return this.#terminal;
    });
  }

  async end(expectedRevision: number): Promise<TerminalResource> {
    await this.#beginTermination(expectedRevision, true);
    return this.#finalizedPromise;
  }

  interrupt(publicReason: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#finalized) return;
      await this.#process.terminate("kill").catch(() => undefined);
      await this.#finalize({
        lifecycle: "interrupted",
        exitCode: null,
        exitSignal: null,
        publicReason,
        cleanupConfirmed: false,
      });
    });
  }

  /** Application shutdown detaches remote ownership, retaining durable metadata. */
  async close(): Promise<void> {
    if (!this.#process.persistent) return await this.interrupt("server_shutdown");
    await this.#enqueue(async () => {
      if (this.#detached) return;
      this.#detached = true;
      this.#unsubscribeOutput(); this.#unsubscribeExit();
      this.#clearTimers(); this.#revokeController();
      for (const viewer of [...this.#viewers.values()]) {
        this.#emitError(viewer, "terminal_unavailable", "The terminal attachment closed; the remote terminal remains available for reconnection.", true);
        this.#detach(viewer);
      }
      if (!this.#finalized) this.#emulator.dispose();
      await this.#process.persistent!.detach();
    });
  }

  discardAfterEnd(): Promise<void> {
    return this.#enqueue(async () => {
      for (const viewer of [...this.#viewers.values()]) {
        this.#send(viewer, this.#frame({
          type: "terminal_removed",
        }));
        this.#detach(viewer);
      }
    });
  }

  async prepareDiscard(): Promise<void> {
    if (this.#process.persistent) {
      await this.#process.persistent.acknowledgeFinal();
      await this.#process.persistent.forget();
    }
  }

  #dispatch(viewer: Viewer, frame: TerminalClientFrame): Promise<void> | void {
    if (
      frame.terminalId !== this.#terminalId ||
      frame.incarnationId !== this.#incarnationId
    ) {
      this.#emitError(viewer, "stale_incarnation", "The terminal process changed.", true);
      return;
    }
    switch (frame.type) {
      case "ack_output":
        this.#ack(viewer, frame.appliedSeq);
        return;
      case "ack_snapshot":
        this.#ackSnapshot(viewer, frame.checkpointSeq, frame.chunkIndex);
        return;
      case "claim_control":
        this.#claimControl(viewer);
        return;
      case "release_control":
        this.#releaseControl(viewer);
        return;
      case "resize":
        return this.#resize(viewer, frame);
      case "input":
        return this.#input(viewer, frame);
    }
  }

  async #input(
    viewer: Viewer,
    frame: Extract<TerminalClientFrame, { type: "input" }>,
  ): Promise<void> {
    const highWater = this.#producerHighWater.get(viewer.producerId) ?? 0;
    if (
      viewer.role !== "controller" ||
      this.#terminal.lifecycle !== "running" ||
      this.#controllerAttachmentId !== viewer.attachmentId ||
      frame.controllerEpoch !== this.#controllerEpoch ||
      frame.producerId !== viewer.producerId ||
      !viewer.caughtUp
    ) {
      this.#emitInputResult(viewer, frame.inputSeq, "rejected", highWater, "stale_controller");
      return;
    }
    const bytes = Buffer.from(frame.data, "base64url");
    if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
      this.#emitInputResult(viewer, frame.inputSeq, "rejected", highWater, "invalid_input");
      return;
    }
    const inputHash = createHash("sha256").update(bytes).digest("base64url");
    if (frame.inputSeq <= highWater) {
      const acceptedHash = this.#producerInputHashes
        .get(viewer.producerId)
        ?.get(frame.inputSeq);
      if (acceptedHash === undefined && this.#process.persistent) {
        const result = await this.#process.write(bytes, { producerId: frame.producerId, inputSeq: frame.inputSeq });
        this.#emitInputResult(viewer, frame.inputSeq, result.outcome === "sent" ? "duplicate" : result.outcome, highWater,
          result.outcome === "sent" ? undefined : result.diagnosticCode);
        return;
      }
      this.#emitInputResult(
        viewer,
        frame.inputSeq,
        acceptedHash !== undefined && acceptedHash !== inputHash
          ? "rejected"
          : "duplicate",
        highWater,
        acceptedHash !== undefined && acceptedHash !== inputHash
          ? "input_sequence_conflict"
          : undefined,
      );
      return;
    }
    if (frame.inputSeq !== highWater + 1) {
      this.#emitInputResult(viewer, frame.inputSeq, "rejected", highWater, "input_gap");
      return;
    }
    if (
      !this.#producerHighWater.has(viewer.producerId) &&
      this.#producerHighWater.size >= 64
    ) {
      this.#emitInputResult(
        viewer,
        frame.inputSeq,
        "rejected",
        highWater,
        "producer_limit_reached",
      );
      return;
    }
    const result = this.#process.persistent
      ? await this.#process.write(bytes, { producerId: frame.producerId, inputSeq: frame.inputSeq })
      : await this.#process.write(bytes);
    if (result.outcome === "sent") {
      this.#producerHighWater.set(viewer.producerId, frame.inputSeq);
      let hashes = this.#producerInputHashes.get(viewer.producerId);
      if (!hashes) {
        hashes = new Map();
        this.#producerInputHashes.set(viewer.producerId, hashes);
      }
      hashes.set(frame.inputSeq, inputHash);
      while (hashes.size > 64) hashes.delete(hashes.keys().next().value!);
      this.#emitInputResult(viewer, frame.inputSeq, "accepted", frame.inputSeq);
    } else {
      this.#emitInputResult(
        viewer,
        frame.inputSeq,
        result.outcome,
        highWater,
        result.diagnosticCode,
      );
    }
  }

  async #resize(
    viewer: Viewer,
    frame: Extract<TerminalClientFrame, { type: "resize" }>,
  ): Promise<void> {
    // A viewport change can already be in flight when the PTY exits (most
    // visibly when a mobile keyboard closes after submitting `exit`). The
    // finalized terminal cannot be resized, and this late layout event is not
    // evidence that the viewer lost controller authority.
    if (
      this.#terminal.lifecycle === "exited" ||
      this.#terminal.lifecycle === "failed" ||
      this.#terminal.lifecycle === "interrupted"
    ) return;
    if (
      viewer.role !== "controller" ||
      frame.controllerEpoch !== this.#controllerEpoch ||
      this.#controllerAttachmentId !== viewer.attachmentId
    ) {
      this.#emitError(viewer, "stale_controller", "Only the current controller can resize.", false);
      return;
    }
    await this.#process.resize({ rows: frame.rows, columns: frame.columns });
    // The remote suffix establishes ordering relative to concurrent PTY output.
    if (this.#process.persistent) return;
    this.#recordResize(frame);
  }

  #recordResize(frame: { readonly rows: number; readonly columns: number }): void {
    if (this.#finalized || this.#detached) return;
    this.#emulator.resize(frame.rows, frame.columns);
    const seq = this.#terminal.headSeq + 1;
    const record: TerminalJournalRecord = {
      seq,
      kind: "resize",
      rows: frame.rows,
      columns: frame.columns,
    };
    try {
      this.#journal.append(this.#scope, this.#terminalId, record);
      this.#terminal = {
        ...this.#terminal,
        rows: frame.rows,
        columns: frame.columns,
        headSeq: seq,
      };
      this.#terminal = this.#repository.resize(
        this.#scope,
        this.#terminalId,
        frame.rows,
        frame.columns,
        seq,
        Date.now(),
      );
      this.#recordsSinceCheckpoint += 1;
      if (this.#recordsSinceCheckpoint >= CHECKPOINT_AFTER_RECORDS) {
        this.#writeCheckpoint();
      }
      this.#broadcastRecord(record);
    } catch {
      this.#failHistoryWrite();
    }
  }

  async #recordOutput(bytes: Uint8Array): Promise<void> {
    if (this.#finalized || this.#detached || bytes.byteLength === 0) return;
    const parsed = await this.#emulator.write(bytes);
    const record: TerminalJournalRecord = {
      seq: this.#terminal.headSeq + 1,
      kind: "output",
      bytes: Uint8Array.from(bytes),
    };
    try {
      this.#journal.append(this.#scope, this.#terminalId, record);
      this.#terminal = { ...this.#terminal, headSeq: record.seq };
      this.#repository.updateHead(
        this.#scope,
        this.#terminalId,
        record.seq,
        Date.now(),
      );
      this.#bytesSinceCheckpoint += bytes.byteLength;
      this.#recordsSinceCheckpoint += 1;
      if (
        parsed.erasedScrollback ||
        this.#bytesSinceCheckpoint >= CHECKPOINT_AFTER_BYTES ||
        this.#recordsSinceCheckpoint >= CHECKPOINT_AFTER_RECORDS
      ) {
        this.#writeCheckpoint();
      }
      this.#broadcastRecord(record);
    } catch {
      this.#failHistoryWrite();
    }
  }

  async #restoreRemote(snapshot: { readonly bytes: Uint8Array; readonly rows: number; readonly columns: number }): Promise<void> {
    if (this.#finalized || this.#detached) return;
    this.#remoteAvailable = true;
    // A durable final handoff is authoritative across repeated recovery attaches.
    if (["exited", "failed", "interrupted"].includes(this.#terminal.lifecycle) && this.#hasDurableFinalStatus()) return;
    this.#controllerEpoch = randomInt(1, 2 ** 48 - 1);
    this.#emulator.resize(snapshot.rows, snapshot.columns);
    await this.#emulator.write(Buffer.from("\u001bc\u001b[3J", "utf8"));
    await this.#emulator.write(snapshot.bytes);
    const seq = this.#terminal.headSeq + 1;
    // Commit a replacement checkpoint before advancing its durable pointer.
    // Main's sequence is independent of the remote delivery cursor.
    this.#journal.compact(this.#scope, this.#terminalId, { ...snapshot, seq }, []);
    const finalStatus: TerminalJournalRecord | undefined =
      this.#terminal.lifecycle === "exited" || this.#terminal.lifecycle === "failed" || this.#terminal.lifecycle === "interrupted"
        ? { kind: "final_status", seq: seq + 1, lifecycle: this.#terminal.lifecycle,
            exitCode: this.#terminal.exitCode, exitSignal: this.#terminal.exitSignal, publicReason: this.#terminal.publicReason }
        : undefined;
    if (finalStatus) this.#journal.append(this.#scope, this.#terminalId, finalStatus);
    this.#terminal = this.#repository.reconcileJournal(this.#scope, this.#terminalId, {
      headSeq: finalStatus?.seq ?? seq, historyFloorSeq: seq, rows: snapshot.rows, columns: snapshot.columns,
      ...(finalStatus ? { finalStatus } : {}), now: Date.now(),
    });
    this.#bytesSinceCheckpoint = 0; this.#recordsSinceCheckpoint = 0;
    this.#revokeController();
    for (const viewer of [...this.#viewers.values()]) {
      this.#send(viewer, this.#frame({ type: "resync_required", historyFloorSeq: seq }));
      this.#detach(viewer);
    }
    this.#onTerminalSummaryChanged();
  }

  #hasDurableFinalStatus(): boolean {
    try {
      const journal = this.#journal.read(this.#scope, this.#terminalId);
      const final = journal.records.at(-1);
      return journal.headSeq === this.#terminal.headSeq && final?.kind === "final_status"
        && final.lifecycle === this.#terminal.lifecycle && final.exitCode === this.#terminal.exitCode
        && final.exitSignal === this.#terminal.exitSignal && final.publicReason === this.#terminal.publicReason;
    } catch { return false; }
  }

  #failHistoryWrite(): void {
    void this.#process.terminate("kill").catch(() => undefined);
    void this.#finalize({
      lifecycle: "failed",
      exitCode: null,
      exitSignal: null,
      publicReason: "history_write_failed",
      cleanupConfirmed: false,
    });
  }

  #writeCheckpoint(): void {
    const checkpointSeq = this.#terminal.headSeq;
    if (checkpointSeq <= this.#terminal.historyFloorSeq) return;
    const bytes = this.#emulator.checkpoint();
    this.#journal.compact(
      this.#scope,
      this.#terminalId,
      {
        seq: checkpointSeq,
        rows: this.#terminal.rows,
        columns: this.#terminal.columns,
        bytes,
      },
      [],
    );
    this.#terminal = this.#repository.advanceHistoryFloor(
      this.#scope,
      this.#terminalId,
      checkpointSeq,
      Date.now(),
    );
    this.#bytesSinceCheckpoint = 0;
    this.#recordsSinceCheckpoint = 0;
  }

  #recordExit(exit: InteractiveTerminalExit): Promise<void> {
    return this.#finalize({
      lifecycle:
        exit.disposition === "exited" ? "exited" : "interrupted",
      exitCode: exit.exitCode,
      exitSignal: exit.signal,
      publicReason:
        exit.disposition === "interrupted"
          ? (exit.diagnosticCode ?? "provider_connection_lost")
          : null,
      cleanupConfirmed: exit.cleanupConfirmed === true,
      transportClosed: exit.transportClosed === true,
    });
  }

  async #finalize(input: {
    readonly lifecycle: "exited" | "failed" | "interrupted";
    readonly exitCode: number | null;
    readonly exitSignal: string | null;
    readonly publicReason: string | null;
    readonly cleanupConfirmed: boolean;
    readonly transportClosed?: boolean;
  }): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    this.#unsubscribeOutput();
    this.#unsubscribeExit();
    this.#emulator.dispose();
    this.#clearTimers();
    if (["exited", "failed", "interrupted"].includes(this.#terminal.lifecycle)) {
      if (this.#hasDurableFinalStatus()) await this.#process.persistent?.acknowledgeFinal().catch(() => undefined);
      this.#resolveFinalized(this.#terminal);
      this.#onFinalized();
      this.#broadcastStatus();
      return;
    }
    const record: TerminalJournalRecord = {
      seq: this.#terminal.headSeq + 1,
      kind: "final_status",
      lifecycle: input.lifecycle,
      exitCode: input.exitCode,
      exitSignal: input.exitSignal,
      publicReason: input.publicReason,
    };
    let appended = false;
    try {
      this.#journal.append(this.#scope, this.#terminalId, record);
      appended = true;
    } catch {
      // Metadata still truthfully records failure when storage is unavailable.
    }
    const finalInput = appended
      ? input
      : {
          lifecycle: "failed" as const,
          exitCode: null,
          exitSignal: null,
          publicReason: "history_write_failed",
          cleanupConfirmed: false,
          transportClosed: false,
        };
    try {
      this.#terminal = this.#repository.finalize(this.#scope, this.#terminalId, {
        lifecycle: finalInput.lifecycle,
        exitCode: finalInput.exitCode,
        exitSignal: finalInput.exitSignal,
        publicReason: finalInput.publicReason,
        confirmPendingEndCleanup:
          this.#endRequested && finalInput.cleanupConfirmed,
        confirmPendingTransportClosed:
          this.#endRequested && finalInput.transportClosed === true,
        headSeq: appended ? record.seq : this.#terminal.headSeq,
        now: Date.now(),
      });
    } catch (error) {
      this.#onFinalized();
      this.#rejectFinalized(error);
      throw error;
    }
    if (appended) {
      // Acknowledgment is retryable upstream delivery after durable handoff;
      // failure must not erase local history or fabricate a second exit.
      await this.#process.persistent?.acknowledgeFinal().catch(() => undefined);
    }
    this.#resolveFinalized(this.#terminal);
    this.#onTerminalSummaryChanged();
    this.#onFinalized();
    if (appended) this.#broadcastRecord(record);
    else this.#broadcastStatus();
  }

  #claimControl(viewer: Viewer): void {
    if (this.#terminal.lifecycle !== "running") {
      this.#emitError(viewer, "stale_controller", "The terminal is not running.", false);
      return;
    }
    const previous = this.#controllerAttachmentId
      ? this.#viewers.get(this.#controllerAttachmentId)
      : undefined;
    if (previous?.attachmentId === viewer.attachmentId) return;
    if (previous) previous.role = "observer";
    viewer.role = "controller";
    this.#controllerAttachmentId = viewer.attachmentId;
    this.#controllerProducerId = viewer.producerId;
    if (this.#controllerGraceTimer) {
      clearTimeout(this.#controllerGraceTimer);
      this.#controllerGraceTimer = undefined;
    }
    this.#controllerEpoch += 1;
    if (previous) this.#emitControl(previous);
    this.#emitControl(viewer);
  }

  #releaseControl(viewer: Viewer): void {
    if (this.#controllerAttachmentId !== viewer.attachmentId) return;
    viewer.role = "observer";
    this.#controllerAttachmentId = undefined;
    this.#controllerProducerId = undefined;
    if (this.#controllerGraceTimer) {
      clearTimeout(this.#controllerGraceTimer);
      this.#controllerGraceTimer = undefined;
    }
    this.#controllerEpoch += 1;
    this.#emitControl(viewer);
  }

  #revokeController(): void {
    const controller = this.#controllerAttachmentId
      ? this.#viewers.get(this.#controllerAttachmentId)
      : undefined;
    if (!controller) return;
    controller.role = "observer";
    this.#controllerAttachmentId = undefined;
    this.#controllerProducerId = undefined;
    this.#controllerEpoch += 1;
    this.#emitControl(controller);
  }

  #detach(viewer: Viewer): void {
    if (!this.#viewers.delete(viewer.attachmentId)) return;
    viewer.closed = true;
    viewer.wake?.();
    viewer.wake = undefined;
    if (this.#controllerAttachmentId === viewer.attachmentId) {
      this.#controllerAttachmentId = undefined;
      this.#controllerProducerId = viewer.producerId;
      if (this.#controllerGraceTimer) clearTimeout(this.#controllerGraceTimer);
      this.#controllerGraceTimer = setTimeout(() => {
        void this.#enqueue(() => {
          if (
            this.#controllerAttachmentId === undefined &&
            this.#controllerProducerId === viewer.producerId
          ) {
            this.#controllerProducerId = undefined;
            this.#controllerEpoch += 1;
          }
          this.#controllerGraceTimer = undefined;
        });
      }, 5_000);
      this.#controllerGraceTimer.unref();
    }
  }

  #broadcastRecord(record: TerminalJournalRecord): void {
    for (const viewer of this.#viewers.values()) {
      if (viewer.closed) continue;
      const bytes = this.#recordBytes(record);
      if (
        viewer.liveQueue.length >= VIEWER_LIVE_QUEUE_MAX_RECORDS ||
        viewer.liveQueueBytes + bytes > VIEWER_LIVE_QUEUE_MAX_BYTES
      ) {
        this.#send(viewer, this.#frame({
          type: "error",
          code: "viewer_too_slow",
          message: "Terminal output exceeded this viewer's replay buffer.",
          retryable: true,
        }));
        this.#send(viewer, this.#frame({
          type: "resync_required",
          historyFloorSeq: this.#terminal.historyFloorSeq,
        }));
        this.#detach(viewer);
        continue;
      }
      viewer.liveQueue.push(record);
      viewer.liveQueueBytes += bytes;
      viewer.wake?.();
      viewer.wake = undefined;
    }
  }

  #emitJournal(viewer: Viewer, record: TerminalJournalRecord): void {
    if (record.kind === "output") {
      this.#send(viewer, this.#frame({
        type: "output",
        seq: record.seq,
        data: Buffer.from(record.bytes).toString("base64url"),
      }));
    } else if (record.kind === "resize") {
      this.#send(viewer, this.#frame({
        type: "resize_committed",
        seq: record.seq,
        rows: record.rows,
        columns: record.columns,
      }));
    } else {
      this.#send(viewer, this.#frame({
        type: "terminal_status",
        seq: record.seq,
        lifecycle: record.lifecycle,
        lifecycleRevision: this.#terminal.lifecycleRevision,
        exitCode: record.exitCode,
        exitSignal: record.exitSignal,
        publicReason: record.publicReason,
      }));
    }
  }

  #broadcastStatus(): void {
    const frame = this.#frame({
      type: "lifecycle_state",
      lifecycle: this.#terminal.lifecycle,
      lifecycleRevision: this.#terminal.lifecycleRevision,
      headSeq: this.#terminal.headSeq,
      exitCode: this.#terminal.exitCode,
      exitSignal: this.#terminal.exitSignal,
      publicReason: this.#terminal.publicReason,
    });
    for (const viewer of [...this.#viewers.values()]) this.#send(viewer, frame);
  }

  #ack(viewer: Viewer, appliedSeq: number): void {
    if (appliedSeq < viewer.lastAckSeq || appliedSeq > viewer.lastSentSeq) {
      this.#send(viewer, this.#frame({
        type: "resync_required",
        historyFloorSeq: this.#terminal.historyFloorSeq,
      }));
      this.#detach(viewer);
      return;
    }
    viewer.lastAckSeq = appliedSeq;
    while (
      viewer.outstanding.length > 0 &&
      viewer.outstanding[0]!.seq <= appliedSeq
    ) {
      viewer.outstandingBytes -= viewer.outstanding.shift()!.bytes;
    }
    viewer.wake?.();
    viewer.wake = undefined;
  }

  #ackSnapshot(viewer: Viewer, checkpointSeq: number, chunkIndex: number): void {
    if (
      viewer.snapshotSeq !== checkpointSeq ||
      chunkIndex > viewer.snapshotSentChunkIndex ||
      chunkIndex < viewer.snapshotAckChunkIndex
    ) {
      this.#send(viewer, this.#frame({
        type: "resync_required",
        historyFloorSeq: this.#terminal.historyFloorSeq,
      }));
      this.#detach(viewer);
      return;
    }
    viewer.snapshotAckChunkIndex = chunkIndex;
    viewer.wake?.();
    viewer.wake = undefined;
  }

  async #runViewerPump(
    viewer: Viewer,
    replayAfter: number,
    replayHead: number,
    journalState: TerminalJournalState,
    restoreKind: "checkpoint" | "resume",
  ): Promise<void> {
    try {
      if (restoreKind === "checkpoint") {
        const checkpoint = journalState.checkpoint;
        const rows = checkpoint.seq === 0 ? this.#terminal.initialRows : checkpoint.rows;
        const columns = checkpoint.seq === 0 ? this.#terminal.initialColumns : checkpoint.columns;
        const chunks = chunkBytes(checkpoint.bytes, SNAPSHOT_CHUNK_BYTES);
        viewer.snapshotSeq = checkpoint.seq;
        this.#send(viewer, this.#frame({
          type: "snapshot_begin",
          checkpointSeq: checkpoint.seq,
          rows,
          columns,
          format: "ansi-checkpoint-v1",
          byteLength: checkpoint.bytes.byteLength,
          chunkCount: chunks.length,
        }), true);
        for (let offset = 0; offset < chunks.length; offset += SNAPSHOT_CHUNK_WINDOW) {
          const windowEnd = Math.min(
            chunks.length - 1,
            offset + SNAPSHOT_CHUNK_WINDOW - 1,
          );
          for (let index = offset; index <= windowEnd; index += 1) {
            viewer.snapshotSentChunkIndex = index;
            this.#send(viewer, this.#frame({
              type: "snapshot_chunk",
              checkpointSeq: checkpoint.seq,
              chunkIndex: index,
              data: Buffer.from(chunks[index]!).toString("base64url"),
            }), true);
          }
          while (!viewer.closed && viewer.snapshotAckChunkIndex < windowEnd) {
            await this.#waitForViewer(viewer, true);
          }
        }
        this.#send(viewer, this.#frame({
          type: "snapshot_end",
          checkpointSeq: checkpoint.seq,
          sha256: checkpoint.sha256,
        }), true);
        viewer.snapshotSeq = undefined;
      }
      for (const record of journalState.records) {
        if (record.seq <= replayAfter || record.seq > replayHead) continue;
        await this.#emitJournalPaced(viewer, record);
      }
      while (!viewer.closed) {
        const record = viewer.liveQueue.shift();
        if (record) {
          viewer.liveQueueBytes -= this.#recordBytes(record);
          // Records through replayHead came from the live queue while the
          // durable replay independently covered the same atomic head.
          if (record.seq > replayHead) await this.#emitJournalPaced(viewer, record);
          continue;
        }
        if (!viewer.caughtUp) {
          const transitioned = await this.#enqueue(() => {
            if (viewer.closed || viewer.liveQueue.length > 0) return false;
            viewer.caughtUp = true;
            this.#send(viewer, this.#frame({
              type: "caught_up",
              headSeq: this.#terminal.headSeq,
            }));
            return true;
          });
          if (!transitioned) continue;
        }
        await this.#waitForViewer(viewer, false);
      }
    } catch {
      if (!viewer.closed) {
        this.#send(viewer, this.#frame({
          type: "resync_required",
          historyFloorSeq: this.#terminal.historyFloorSeq,
        }));
        await this.#enqueue(() => this.#detach(viewer));
      }
    }
  }

  async #emitJournalPaced(
    viewer: Viewer,
    record: TerminalJournalRecord,
  ): Promise<void> {
    const bytes = this.#recordBytes(record);
    while (
      !viewer.closed &&
      (viewer.outstanding.length >= VIEWER_ACK_WINDOW_RECORDS ||
        (viewer.outstanding.length > 0 &&
          viewer.outstandingBytes + bytes > VIEWER_ACK_WINDOW_BYTES))
    ) {
      await this.#waitForViewer(viewer, true);
    }
    if (viewer.closed) throw new Error("terminal_viewer_closed");
    this.#emitJournal(viewer, record);
    viewer.lastSentSeq = Math.max(viewer.lastSentSeq, record.seq);
    viewer.outstanding.push({ seq: record.seq, bytes });
    viewer.outstandingBytes += bytes;
  }

  #waitForViewer(viewer: Viewer, ackRequired: boolean): Promise<void> {
    if (viewer.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = ackRequired
        ? setTimeout(() => {
            if (viewer.wake === wake) viewer.wake = undefined;
            reject(new Error("terminal_viewer_ack_timeout"));
          }, VIEWER_ACK_TIMEOUT_MS)
        : undefined;
      timeout?.unref();
      const wake = () => {
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      viewer.wake = wake;
    });
  }

  #recordBytes(record: TerminalJournalRecord): number {
    return record.kind === "output" ? record.bytes.byteLength : 64;
  }

  #emitControl(viewer: Viewer): void {
    this.#send(viewer, this.#frame({
      type: "control_changed",
      role: viewer.role,
      controllerEpoch: this.#controllerEpoch,
      lastAcceptedInputSeq: this.#producerHighWater.get(viewer.producerId) ?? 0,
    }));
  }

  #emitInputResult(
    viewer: Viewer,
    inputSeq: number,
    outcome: "accepted" | "duplicate" | "not_sent" | "sent_outcome_unknown" | "rejected",
    lastAcceptedInputSeq: number,
    message?: string,
  ): void {
    this.#send(viewer, this.#frame({
      type: "input_result",
      inputSeq,
      outcome,
      lastAcceptedInputSeq,
      ...(message ? { message: message.slice(0, 240) } : {}),
    }));
  }

  #emitError(
    viewer: Viewer,
    code: "stale_incarnation" | "stale_controller" | "terminal_unavailable",
    message: string,
    retryable: boolean,
  ): void {
    this.#send(viewer, this.#frame({ type: "error", code, message, retryable }));
  }

  #send(
    viewer: Viewer,
    frame: TerminalServerFrame,
    throwOnFailure = false,
  ): void {
    try {
      viewer.emit(frame);
    } catch (error) {
      this.#detach(viewer);
      if (throwOnFailure) throw error;
    }
  }

  #frame<T extends TerminalServerFramePayload>(
    frame: T,
  ): TerminalServerFrame {
    return {
      v: TERMINAL_PROTOCOL_VERSION,
      terminalId: this.#terminalId,
      incarnationId: this.#incarnationId,
      ...frame,
    } as unknown as TerminalServerFrame;
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mailbox.then(operation, operation);
    this.#mailbox = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #scheduleEscalation(signal: "terminate" | "kill", delay: number): void {
    const timer = setTimeout(() => {
      if (!this.#finalized) void this.#process.terminate(signal).catch(() => undefined);
    }, delay);
    timer.unref();
    this.#stopTimers.push(timer);
  }

  #scheduleUnconfirmedFailure(delay: number): void {
    const timer = setTimeout(() => {
      void this.#enqueue(() =>
        this.#finalize({
          lifecycle: "failed",
          exitCode: null,
          exitSignal: null,
          publicReason: "cleanup_unconfirmed",
          cleanupConfirmed: false,
        }),
      );
    }, delay);
    timer.unref();
    this.#stopTimers.push(timer);
  }

  #clearTimers(): void {
    if (this.#controllerGraceTimer) {
      clearTimeout(this.#controllerGraceTimer);
      this.#controllerGraceTimer = undefined;
    }
    for (const timer of this.#stopTimers) clearTimeout(timer);
    this.#stopTimers = [];
  }
}

function chunkBytes(bytes: Uint8Array, maximumBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximumBytes) {
    chunks.push(bytes.slice(offset, offset + maximumBytes));
  }
  return chunks;
}
