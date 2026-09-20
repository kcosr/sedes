import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  terminalPrepareOperation, terminalCreateOperation, terminalAttachOperation,
  terminalReadOperation, terminalSnapshotChunkOperation, terminalInputOperation,
  terminalProducerOperation,
  terminalResizeOperation, terminalStopOperation, terminalDetachOperation,
  terminalAcknowledgeOperation, terminalForgetOperation,
  TERMINAL_REMOTE_CHUNK_BYTES, TERMINAL_REMOTE_PAGE_BYTES,
  type RemoteTerminalIdentity, type RemoteTerminalPrepare,
  type RemoteTerminalRecord, type RemoteTerminalSnapshot,
} from "../../internal/sidecar-protocol/interactive-terminal-v2.js";
import { SidecarOperationError, type SidecarOperationRegistry } from "../../internal/sidecar-protocol/operation-registry.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { InteractiveTerminalExit, InteractiveTerminalProcess, InteractiveTerminalWriteResult } from "../execution/interactive-terminal.js";
import { LocalInteractiveTerminalProvider } from "../execution/local-interactive-terminal-provider.js";
import { TerminalHeadlessEmulator } from "../terminals/terminal-emulator.js";
import { SidecarResourceHandoffPendingError } from "./persistent-sidecar-service-registry.js";
import type { SidecarResourceStopContext } from "./persistent-sidecar-service-registry.js";
import type { SidecarAbandonmentRecord } from "./sidecar-abandonment-archive.js";

type UpgradeBlocker = "live_terminal" | "unsettled_outcome" | "cleanup_unproven";
export interface TerminalResourceParticipant {
  readonly resourceId: string;
  readonly kind: "terminal";
  snapshot(): { readonly state: "idle" | "active" | "unknown"; readonly blockers: readonly UpgradeBlocker[]; readonly revision: string };
  stop(reason: string, context: SidecarResourceStopContext): Promise<void>;
  onDetach(): void;
}
type OpenTerminal = (input: RemoteTerminalPrepare & { readonly scope: RequestScope; readonly environmentId: string }) => Promise<InteractiveTerminalProcess>;
type FrozenSnapshot = { readonly metadata: RemoteTerminalSnapshot; readonly bytes: Uint8Array };
type ProducerState = { highWater: number; readonly receipts: Map<number, { readonly fingerprint: string; readonly result: InteractiveTerminalWriteResult }> };
type Terminal = {
  readonly input: RemoteTerminalPrepare;
  readonly process: InteractiveTerminalProcess;
  readonly emulator: TerminalHeadlessEmulator;
  readonly unregister: () => void;
  unsubscribeOutput: () => void;
  unsubscribeExit: () => void;
  records: RemoteTerminalRecord[];
  recordBytes: number;
  pendingBytes: number;
  outputPaused: boolean;
  headSeq: number;
  floorSeq: number;
  rows: number;
  columns: number;
  controllerToken: string | undefined;
  controlSeq: number;
  receipts: Map<number, { fingerprint: string; result: unknown }>;
  producers: Map<string, ProducerState>;
  snapshot: FrozenSnapshot | undefined;
  exit: InteractiveTerminalExit | undefined;
  finalAcknowledged: boolean;
  cleanupUnproven: boolean;
  stopReason?: string;
};
type Ticket = { readonly input: RemoteTerminalPrepare; readonly expiresAt: number; created: boolean };

/**
 * One authenticated installation/principal/environment's persistent PTYs.
 * No transport, request AbortSignal, main database, or viewer owns these children.
 * The only output authority is the bounded remote emulator plus ordered suffix.
 */
export class PersistentTerminalHost {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #open: OpenTerminal;
  readonly #registerResource: (resource: TerminalResourceParticipant) => () => void;
  readonly #recordAbandonment: (record: SidecarAbandonmentRecord) => Promise<void>;
  readonly #assertAdmission: () => void;
  readonly #maximumTerminals: number;
  readonly #maximumSuffixBytes: number;
  readonly #terminals = new Map<string, Terminal>();
  readonly #tickets = new Map<string, Ticket>();
  #mailbox = Promise.resolve();
  #stopping = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly openTerminal?: OpenTerminal;
    readonly registerResource?: (resource: TerminalResourceParticipant) => () => void;
    readonly recordAbandonment?: (record: SidecarAbandonmentRecord) => Promise<void>;
    readonly assertAdmission?: () => void;
    readonly maximumTerminals?: number;
    readonly maximumSuffixBytes?: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) {
    if (!input.scope.tenantId || !input.scope.principalId || !input.environmentId) throw new Error("terminal_host_scope_required");
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    const provider = input.openTerminal ? undefined : new LocalInteractiveTerminalProvider({
      scope: this.#scope, environmentId: input.environmentId,
      cleanupOnNaturalExit: true,
      ...(input.environment ? { environment: input.environment } : {}),
    });
    this.#open = input.openTerminal ?? ((request) => provider!.openTerminal(request));
    this.#registerResource = input.registerResource ?? (() => () => undefined);
    this.#recordAbandonment = input.recordAbandonment ?? (async () => {});
    this.#assertAdmission = input.assertAdmission ?? (() => undefined);
    this.#maximumTerminals = input.maximumTerminals ?? 128;
    this.#maximumSuffixBytes = input.maximumSuffixBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maximumTerminals) || this.#maximumTerminals < 1 || this.#maximumTerminals > 256 ||
        !Number.isSafeInteger(this.#maximumSuffixBytes) || this.#maximumSuffixBytes < 1 || this.#maximumSuffixBytes > 8 * 1024 * 1024) {
      throw new Error("terminal_host_limits_invalid");
    }
  }

  /** Each registrar captures its authenticated attachment's admission fence. */
  registerOperations(registry: SidecarOperationRegistry, attachment: {
    readonly assertAdmission: () => void;
    readonly assertController: () => void;
  }): void {
    const admit = () => { attachment.assertAdmission(); this.#assertAdmission(); };
    const run = <T>(operation: () => T | Promise<T>) => this.#enqueue(() => { admit(); return operation(); });
    const inspect = <T>(operation: () => T | Promise<T>) => this.#enqueue(() => { attachment.assertController(); return operation(); });
    registry.register(terminalPrepareOperation, (request) => run(() => this.#prepare(request)));
    registry.register(terminalCreateOperation, ({ ticket }) => run(() => this.#create(ticket, admit)));
    registry.register(terminalAttachOperation, (request) => inspect(() => {
      const terminal = this.#get(request);
      if (terminal.finalAcknowledged) throw failure("terminal_history_transferred");
      terminal.controllerToken = randomUUID();
      terminal.controlSeq = 0;
      terminal.receipts.clear();
      // A new controller starts from the current screen, never from another
      // controller's pending delivery (which may precede a scrollback erase).
      this.#discardRecordsThrough(terminal, terminal.headSeq);
      return { controllerToken: terminal.controllerToken, snapshot: this.#snapshot(terminal) };
    }));
    registry.register(terminalReadOperation, (request) => inspect(() => {
      const terminal = this.#controlled(request);
      if (request.afterSeq < terminal.floorSeq || request.afterSeq > terminal.headSeq) {
        return { kind: "snapshot" as const, snapshot: this.#snapshot(terminal) };
      }
      this.#discardRecordsThrough(terminal, request.afterSeq);
      const records: RemoteTerminalRecord[] = [];
      let size = 0;
      for (const record of terminal.records) {
        if (record.seq <= request.afterSeq) continue;
        const next = recordSize(record);
        if (records.length === 64 || size + next > TERMINAL_REMOTE_PAGE_BYTES) break;
        records.push(record); size += next;
      }
      return { kind: "records" as const, records, headSeq: terminal.headSeq };
    }));
    registry.register(terminalSnapshotChunkOperation, (request) => inspect(() => {
      const snapshot = this.#controlled(request).snapshot;
      if (!snapshot || snapshot.metadata.snapshotId !== request.snapshotId) throw failure("terminal_snapshot_expired", true);
      if (request.offset > snapshot.bytes.byteLength || request.offset % TERMINAL_REMOTE_CHUNK_BYTES !== 0) throw failure("terminal_snapshot_offset_invalid");
      return { data: Buffer.from(snapshot.bytes.subarray(request.offset, request.offset + TERMINAL_REMOTE_CHUNK_BYTES)).toString("base64url") };
    }));
    registry.register(terminalInputOperation, (request) => run(async () => {
      const terminal = this.#controlled(request);
      return await this.#control(terminal, request.controlSeq, { kind: "input", data: request.data, producer: request.producer }, async () => {
        if (terminal.exit) return { outcome: "not_sent" as const, diagnosticCode: "terminal_exited" };
        return await this.#write(terminal, Buffer.from(request.data, "base64url"), request.producer);
      });
    }));
    registry.register(terminalProducerOperation, (request) => inspect(() => ({ highWater: this.#controlled(request).producers.get(request.producerId)?.highWater ?? 0 })));
    registry.register(terminalResizeOperation, (request) => run(async () => {
      const terminal = this.#controlled(request);
      return await this.#control(terminal, request.controlSeq, { kind: "resize", rows: request.rows, columns: request.columns }, async () => {
        if (terminal.exit) throw failure("terminal_exited");
        await terminal.process.resize(request);
        terminal.emulator.resize(request.rows, request.columns);
        terminal.rows = request.rows; terminal.columns = request.columns;
        this.#append(terminal, { kind: "resize", seq: terminal.headSeq + 1, rows: request.rows, columns: request.columns });
        return { resized: true as const };
      });
    }));
    registry.register(terminalStopOperation, (request) => inspect(async () => {
      const terminal = this.#controlled(request);
      if (!terminal.exit) await terminal.process.terminate(request.signal);
      return { accepted: true as const };
    }));
    registry.register(terminalDetachOperation, (request) => inspect(() => {
      this.#detach(this.#controlled(request));
      return { detached: true as const };
    }));
    registry.register(terminalAcknowledgeOperation, (request) => inspect(() => {
      const terminal = this.#controlled(request);
      if (!terminal.exit || terminal.headSeq !== request.finalSeq) throw failure("terminal_final_handoff_mismatch");
      if (!terminal.finalAcknowledged) {
        terminal.finalAcknowledged = true;
        // Main now durably owns retained history. Keep only a bounded receipt,
        // not another copy that would survive an application-side history erase.
        terminal.snapshot = undefined; terminal.records = []; terminal.recordBytes = 0;
        terminal.emulator.dispose();
      }
      return { acknowledged: true as const };
    }));
    registry.register(terminalForgetOperation, (request) => inspect(() => {
      // The authenticated service controller may erase an acknowledged receipt
      // after reconnect, when the old terminal controller token is fenced.
      const terminal = this.#get(request);
      if (!terminal.exit || !terminal.finalAcknowledged || terminal.cleanupUnproven) throw failure("terminal_history_handoff_required");
      this.#forget(terminal);
      return { forgotten: true as const };
    }));
  }

  onDetach(): void {
    // Synchronous fencing also invalidates queued calls from the old peer.
    for (const terminal of this.#terminals.values()) this.#detach(terminal);
  }

  snapshot(): ReturnType<TerminalResourceParticipant["snapshot"]> {
    const blockers = new Set<UpgradeBlocker>();
    for (const terminal of this.#terminals.values()) for (const blocker of resourceSnapshot(terminal).blockers) blockers.add(blocker);
    const revision = createHash("sha256").update(JSON.stringify([...this.#terminals.values()].map((terminal) => resourceSnapshot(terminal).revision))).digest("hex");
    return { state: blockers.has("cleanup_unproven") ? "unknown" : blockers.size ? "active" : "idle", blockers: [...blockers], revision };
  }

  async stop(reason: string, force = false): Promise<void> {
    this.#stopping = true;
    await Promise.all([...this.#terminals.values()].map((terminal) => this.#stopTerminal(terminal, reason, force)));
  }

  #prepare(input: RemoteTerminalPrepare): { ticket: string } {
    if (this.#stopping) throw failure("terminal_admission_closed");
    if (!isAbsolute(input.initialCwd) || input.initialCwd.includes("\0")) throw failure("terminal_cwd_invalid");
    if (this.#terminals.has(key(input))) throw failure("terminal_already_exists");
    const now = Date.now();
    for (const [ticket, prepared] of this.#tickets) {
      if (prepared.expiresAt < now) { this.#tickets.delete(ticket); continue; }
      if (key(prepared.input) === key(input)) {
        if (JSON.stringify(prepared.input) !== JSON.stringify(input)) throw failure("terminal_creation_identity_reused");
        return { ticket };
      }
    }
    if (this.#tickets.size >= this.#maximumTerminals) throw failure("terminal_admission_capacity", true);
    const ticket = randomUUID();
    this.#tickets.set(ticket, { input, expiresAt: now + 60_000, created: false });
    return { ticket };
  }

  async #create(ticket: string, admit: () => void): Promise<{ created: true }> {
    if (this.#stopping) throw failure("terminal_admission_closed");
    const prepared = this.#tickets.get(ticket);
    if (!prepared || prepared.expiresAt < Date.now()) throw failure("terminal_creation_ticket_expired");
    if (prepared.created) return { created: true };
    for (const terminal of this.#terminals.values()) {
      if (this.#terminals.size < this.#maximumTerminals) break;
      if (terminal.exit && terminal.finalAcknowledged && !terminal.cleanupUnproven) this.#forget(terminal);
    }
    if (this.#terminals.size >= this.#maximumTerminals) throw failure("terminal_capacity", true);
    admit();
    const input = prepared.input;
    let terminal!: Terminal;
    let settleLaunch!: () => void;
    const launchSettled = new Promise<void>((resolve) => { settleLaunch = resolve; });
    // Publish the admission blocker before the first asynchronous launch step.
    const unregister = this.#registerResource({
      resourceId: `terminal:${input.terminalId}:${input.incarnationId}`, kind: "terminal",
      snapshot: () => terminal ? resourceSnapshot(terminal) : { state: "active", blockers: ["live_terminal"], revision: `${input.incarnationId}:launching` },
      stop: async (reason, { force }) => { await launchSettled; if (terminal) await this.#stopTerminal(terminal, reason, force); },
      onDetach: () => { if (terminal) this.#detach(terminal); },
    });
    let process: InteractiveTerminalProcess;
    let emulator: TerminalHeadlessEmulator | undefined;
    try {
      emulator = new TerminalHeadlessEmulator({ rows: input.rows, columns: input.columns,
        onData: (bytes) => { void process.write(bytes).catch(() => undefined); },
      });
      process = await this.#open({ ...input, scope: this.#scope, environmentId: this.#environmentId });
    } catch (error) {
      emulator?.dispose();
      unregister(); settleLaunch();
      throw new SidecarOperationError("terminal_spawn_failed", false, { cause: error });
    }
    // Once spawned, retain ownership even if the RPC's controller disconnects.
    terminal = {
      input, process, emulator, unregister,
      unsubscribeOutput: () => undefined, unsubscribeExit: () => undefined,
      records: [], recordBytes: 0, pendingBytes: 0, outputPaused: false,
      headSeq: 0, floorSeq: 0, rows: input.rows, columns: input.columns,
      controllerToken: undefined, controlSeq: 0, receipts: new Map(), producers: new Map(), snapshot: undefined,
      exit: undefined, finalAcknowledged: false, cleanupUnproven: false,
    };
    this.#terminals.set(key(input), terminal);
    settleLaunch();
    prepared.created = true;
    terminal.unsubscribeOutput = process.onOutput((bytes) => this.#output(terminal, bytes));
    terminal.unsubscribeExit = process.onExit((exit) => {
      void this.#enqueue(() => {
        if (terminal.exit) return;
        terminal.exit = terminal.stopReason
          ? { ...exit, disposition: "interrupted", diagnosticCode: exit.diagnosticCode ?? terminal.stopReason }
          : exit;
        terminal.cleanupUnproven = exit.cleanupConfirmed !== true;
        this.#append(terminal, { kind: "exit", seq: terminal.headSeq + 1, exit: terminal.exit });
      });
    });
    return { created: true };
  }

  #output(terminal: Terminal, bytes: Uint8Array): void {
    const owned = Uint8Array.from(bytes);
    terminal.pendingBytes += owned.byteLength;
    if (terminal.pendingBytes > 512 * 1024 && !terminal.outputPaused) {
      terminal.outputPaused = true; terminal.process.pauseOutput();
    }
    if (terminal.pendingBytes > 2 * 1024 * 1024) {
      terminal.pendingBytes -= owned.byteLength;
      terminal.cleanupUnproven = true;
      terminal.stopReason ??= "provider_output_overflow";
      void terminal.process.terminate("kill").catch(() => undefined);
      return;
    }
    void this.#enqueue(async () => {
      try {
        if (terminal.exit) return;
        for (let offset = 0; offset < owned.byteLength; offset += TERMINAL_REMOTE_CHUNK_BYTES) {
          const bytes = owned.subarray(offset, offset + TERMINAL_REMOTE_CHUNK_BYTES);
          const { erasedScrollback } = await terminal.emulator.write(bytes);
          this.#append(terminal, { kind: "output", seq: terminal.headSeq + 1, data: Buffer.from(bytes).toString("base64url") });
          if (erasedScrollback) {
            // Revoke old snapshots, but let the attached controller consume
            // its bounded, ordered delivery queue, including the erase itself.
            // Dropping unread output here turns ordinary TUI redraws into a
            // history gap and disconnects every browser viewer.
            terminal.snapshot = undefined;
            if (!terminal.controllerToken) this.#discardRecordsThrough(terminal, terminal.headSeq);
          }
        }
      } finally {
        terminal.pendingBytes -= owned.byteLength;
        if (terminal.outputPaused && terminal.pendingBytes < 128 * 1024 && !terminal.exit) {
          terminal.outputPaused = false; terminal.process.resumeOutput();
        }
      }
    }).catch(() => { terminal.cleanupUnproven = true; terminal.stopReason ??= "history_write_failed"; void terminal.process.terminate("kill").catch(() => undefined); });
  }

  #append(terminal: Terminal, record: RemoteTerminalRecord): void {
    terminal.headSeq = record.seq; terminal.records.push(record); terminal.recordBytes += recordSize(record);
    while (terminal.records.length > 2048 || terminal.recordBytes > this.#maximumSuffixBytes) {
      const removed = terminal.records.shift()!;
      terminal.recordBytes -= recordSize(removed); terminal.floorSeq = removed.seq;
    }
  }

  #discardRecordsThrough(terminal: Terminal, seq: number): void {
    while (terminal.records.length > 0 && terminal.records[0]!.seq <= seq) {
      terminal.recordBytes -= recordSize(terminal.records.shift()!);
    }
    terminal.floorSeq = Math.max(terminal.floorSeq, seq);
  }

  #snapshot(terminal: Terminal): RemoteTerminalSnapshot {
    const bytes = terminal.emulator.checkpoint();
    const metadata: RemoteTerminalSnapshot = {
      snapshotId: randomUUID(), seq: terminal.headSeq, rows: terminal.rows, columns: terminal.columns,
      byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(terminal.exit ? { exit: terminal.exit } : {}),
    };
    terminal.snapshot = { metadata, bytes };
    return metadata;
  }

  async #control<T>(terminal: Terminal, seq: number, payload: unknown, perform: () => Promise<T>): Promise<T> {
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (seq <= terminal.controlSeq) {
      const receipt = terminal.receipts.get(seq);
      if (!receipt) throw failure("terminal_control_outcome_expired");
      if (receipt.fingerprint !== fingerprint) throw failure("terminal_control_sequence_reused");
      return receipt.result as T;
    }
    if (seq !== terminal.controlSeq + 1) throw failure("terminal_control_sequence_gap");
    // Admission advances first. A thrown write/resize may already have taken effect.
    terminal.controlSeq = seq;
    let result: T;
    try { result = await perform(); }
    catch (error) { throw new SidecarOperationError("terminal_control_outcome_unknown", false, { cause: error }); }
    terminal.receipts.set(seq, { fingerprint, result });
    while (terminal.receipts.size > 256) terminal.receipts.delete(terminal.receipts.keys().next().value!);
    return result;
  }

  async #write(terminal: Terminal, bytes: Uint8Array, producer?: { readonly producerId: string; readonly inputSeq: number }): Promise<InteractiveTerminalWriteResult> {
    if (!producer) return await terminal.process.write(bytes);
    let state = terminal.producers.get(producer.producerId);
    if (!state) {
      if (terminal.producers.size >= 64) return { outcome: "not_sent", diagnosticCode: "terminal_producer_capacity" };
      state = { highWater: 0, receipts: new Map() }; terminal.producers.set(producer.producerId, state);
    }
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    if (producer.inputSeq <= state.highWater) {
      const receipt = state.receipts.get(producer.inputSeq);
      if (!receipt) return { outcome: "sent_outcome_unknown", diagnosticCode: "terminal_input_receipt_expired" };
      if (receipt.fingerprint !== fingerprint) return { outcome: "not_sent", diagnosticCode: "terminal_input_sequence_conflict" };
      return receipt.result;
    }
    if (producer.inputSeq !== state.highWater + 1) return { outcome: "not_sent", diagnosticCode: "terminal_input_sequence_gap" };
    state.highWater = producer.inputSeq;
    let result: InteractiveTerminalWriteResult;
    try { result = await terminal.process.write(bytes); }
    catch { result = { outcome: "sent_outcome_unknown", diagnosticCode: "terminal_input_outcome_unknown" }; }
    if (result.outcome === "not_sent") state.highWater -= 1;
    else {
      state.receipts.set(producer.inputSeq, { fingerprint, result });
      while (state.receipts.size > 64) state.receipts.delete(state.receipts.keys().next().value!);
    }
    return result;
  }

  #get(identity: RemoteTerminalIdentity): Terminal {
    const terminal = this.#terminals.get(key(identity));
    if (!terminal) throw failure("terminal_incarnation_unknown");
    return terminal;
  }

  #controlled(identity: RemoteTerminalIdentity & { readonly controllerToken: string }): Terminal {
    const terminal = this.#get(identity);
    if (terminal.controllerToken !== identity.controllerToken) throw failure("terminal_stale_controller");
    return terminal;
  }

  #detach(terminal: Terminal): void {
    terminal.controllerToken = undefined; terminal.snapshot = undefined; terminal.receipts.clear();
    this.#discardRecordsThrough(terminal, terminal.headSeq);
  }

  #forget(terminal: Terminal): void {
    terminal.unsubscribeOutput(); terminal.unsubscribeExit();
    if (!terminal.finalAcknowledged) terminal.emulator.dispose();
    terminal.unregister();
    this.#terminals.delete(key(terminal.input));
  }

  async #stopTerminal(terminal: Terminal, reason: string, force = false): Promise<void> {
    if (force) await this.#recordAbandonment({ resourceId: key(terminal.input), kind: "terminal", reason,
      evidence: { ...resourceSnapshot(terminal), headSequence: terminal.headSeq, floorSequence: terminal.floorSeq, finalAcknowledged: terminal.finalAcknowledged } });
    if (!terminal.exit) {
      terminal.stopReason ??= reason;
      await terminal.process.terminate("kill");
      const deadline = Date.now() + 5_000;
      while (!terminal.exit && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!terminal.exit || terminal.cleanupUnproven) throw failure("terminal_cleanup_unproven");
    if (!force && !terminal.finalAcknowledged) throw new SidecarResourceHandoffPendingError();
    if (force) {
      await this.#recordAbandonment({ resourceId: key(terminal.input), kind: "terminal", reason,
        evidence: { ...resourceSnapshot(terminal), headSequence: terminal.headSeq, floorSequence: terminal.floorSeq, finalAcknowledged: terminal.finalAcknowledged,
          exit: terminal.exit } });
      this.#forget(terminal);
    }
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#mailbox.then(operation);
    this.#mailbox = next.then(() => undefined, () => undefined);
    return next;
  }
}

function resourceSnapshot(terminal: Terminal): ReturnType<TerminalResourceParticipant["snapshot"]> {
  const blockers: UpgradeBlocker[] = [];
  if (!terminal.exit) blockers.push("live_terminal");
  if (terminal.exit && !terminal.finalAcknowledged) blockers.push("unsettled_outcome");
  if (terminal.cleanupUnproven) blockers.push("cleanup_unproven");
  return {
    state: terminal.cleanupUnproven ? "unknown" : blockers.length ? "active" : "idle", blockers,
    revision: `${terminal.input.incarnationId}:${terminal.exit ? `exit-${terminal.headSeq}` : "live"}:${terminal.finalAcknowledged}:${terminal.cleanupUnproven}`,
  };
}
function key(identity: RemoteTerminalIdentity): string { return `${identity.terminalId}\0${identity.incarnationId}`; }
function failure(code: string, retryable = false): SidecarOperationError { return new SidecarOperationError(code, retryable); }
function recordSize(record: RemoteTerminalRecord): number { return record.kind === "output" ? record.data.length + 64 : 256; }
