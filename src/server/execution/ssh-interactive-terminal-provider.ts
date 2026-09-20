import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { createHash } from "node:crypto";
import {
  terminalPrepareOperation, terminalCreateOperation, terminalAttachOperation,
  terminalReadOperation, terminalSnapshotChunkOperation, terminalInputOperation,
  terminalProducerOperation,
  terminalResizeOperation, terminalStopOperation, terminalDetachOperation,
  terminalAcknowledgeOperation, terminalForgetOperation,
  TERMINAL_REMOTE_CHUNK_BYTES,
  type RemoteTerminalIdentity, type RemoteTerminalSnapshot,
} from "../../internal/sidecar-protocol/interactive-terminal-v2.js";
import { SidecarOperationError, type SidecarOperationDefinition } from "../../internal/sidecar-protocol/operation-registry.js";
import { SidecarProtocolDeliveryError } from "../../internal/sidecar-protocol/contracts.js";
import { InteractiveTerminalStartUncertainError } from "./interactive-terminal.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  InteractiveTerminalEnvironmentProvider, InteractiveTerminalExit,
  InteractiveTerminalProcess, InteractiveTerminalWriteResult,
} from "./interactive-terminal.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import { SidecarUnavailableError, type SidecarRuntimeOwner } from "../sidecar/sidecar-runtime.js";

export interface TerminalSidecarCaller {
  call<Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request): Promise<Response>;
  close?(): void;
}

/** SSH establishes the shared sidecar carrier; the sidecar owns the PTY. */
export class SshInteractiveTerminalProvider implements InteractiveTerminalEnvironmentProvider {
  readonly terminationEffect = "end_process" as const;
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #enabled: boolean;
  readonly #configurationRevision: number;
  readonly #activeConfigurationRevision: () => number | Promise<number>;
  readonly #runtime: SidecarRuntimeOwner<SidecarClientSession>;

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly enabled: boolean;
    readonly configurationRevision: number;
    readonly activeConfigurationRevision: () => number | Promise<number>;
    readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
  }) {
    if (!input.scope.tenantId || !input.scope.principalId || !input.environmentId || typeof input.enabled !== "boolean" ||
        !Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 0) {
      throw new Error("ssh_terminal_provider_configuration_invalid");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#enabled = input.enabled;
    this.#configurationRevision = input.configurationRevision;
    this.#activeConfigurationRevision = input.activeConfigurationRevision;
    this.#runtime = input.runtime;
  }

  availability(scope: RequestScope, environmentId: string): "available" | "unavailable" {
    return this.#enabled && this.#runtime.canAcquireCapability("interactive_terminal", 2) && scope.tenantId === this.#scope.tenantId && scope.principalId === this.#scope.principalId && environmentId === this.#environmentId
      ? "available" : "unavailable";
  }

  async openTerminal(input: {
    readonly scope: RequestScope; readonly environmentId: string;
    readonly terminalId: string; readonly incarnationId: string;
    readonly environmentVariables?: EnvironmentVariableOverrides;
    readonly initialCwd: string; readonly shellProfile?: string;
    readonly rows: number; readonly columns: number;
  }): Promise<InteractiveTerminalProcess> {
    this.#assertScope(input.scope, input.environmentId);
    if (!this.#enabled) throw new SidecarUnavailableError();
    await this.#assertRevision();
    if (input.shellProfile !== undefined) throw new Error("interactive_terminal_shell_profile_unsupported");
    const caller = this.#caller();
    const identity = { terminalId: input.terminalId, incarnationId: input.incarnationId };
    const prepared = await caller.call(terminalPrepareOperation, {
      ...identity, initialCwd: input.initialCwd, rows: input.rows, columns: input.columns,
      ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {}),
    });
    // A create response lost in transit is recovered by identity, never retried
    // with a fresh creation ticket. Failure remains uncertain at the service.
    try { await caller.call(terminalCreateOperation, prepared); }
    catch (error) {
      try { return await RemoteInteractiveTerminalProcess.attach(caller, identity); }
      catch {
        if (["terminal_creation_ticket_expired", "terminal_admission_closed", "terminal_capacity", "terminal_spawn_failed"].includes(errorCode(error) ?? "")) throw error;
        throw new InteractiveTerminalStartUncertainError({ cause: error });
      }
    }
    try { return await RemoteInteractiveTerminalProcess.attach(caller, identity); }
    catch (error) { throw new InteractiveTerminalStartUncertainError({ cause: error }); }
  }

  readonly attachTerminal = async (input: {
    readonly scope: RequestScope; readonly environmentId: string;
    readonly terminalId: string; readonly incarnationId: string;
  }): Promise<InteractiveTerminalProcess> => {
    this.#assertScope(input.scope, input.environmentId);
    if (!this.#enabled) throw new SidecarUnavailableError();
    return await RemoteInteractiveTerminalProcess.attach(this.#caller(), {
      terminalId: input.terminalId, incarnationId: input.incarnationId,
    });
  };

  readonly recoverTerminal: NonNullable<InteractiveTerminalEnvironmentProvider["recoverTerminal"]> = async (input) => {
    this.#assertScope(input.scope, input.environmentId);
    const controller = new AbortController();
    const lease = await this.#runtime.acquireRecovery(this.#scope, this.#environmentId, controller.signal,
      [{ capabilityId: "interactive_terminal", majorVersion: 2 }]);
    if (!lease.session.negotiatedCapabilities.some(capability => capability.capabilityId === "interactive_terminal" && capability.majorVersion === 2)) { lease.release(); throw new SidecarUnavailableError(); }
    const caller: TerminalSidecarCaller = {
      call: (definition, request) => lease.session.call(definition, request, { signal: controller.signal }),
      close: () => { controller.abort(); lease.release(); },
    };
    try {
      return await RemoteInteractiveTerminalProcess.attach(caller, {
        terminalId: input.terminalId, incarnationId: input.incarnationId,
      });
    } catch (error) { caller.close!(); throw error; }
  };

  #caller(): TerminalSidecarCaller {
    return {
      call: async <Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request): Promise<Response> => {
        const controller = new AbortController();
        const lease = await this.#runtime.acquireOperation(this.#scope, this.#environmentId, controller.signal);
        try {
          if (!lease.session.negotiatedCapabilities.some(capability => capability.capabilityId === definition.capabilityId && capability.majorVersion === definition.majorVersion && capability.operations.includes(definition.operation))) throw new SidecarUnavailableError();
          return await lease.session.call(definition, request, { signal: controller.signal });
        }
        finally { lease.release(); }
      },
    };
  }

  #assertScope(scope: RequestScope, environmentId: string): void {
    if (scope.tenantId !== this.#scope.tenantId || scope.principalId !== this.#scope.principalId || environmentId !== this.#environmentId) throw new SidecarUnavailableError();
  }
  async #assertRevision(): Promise<void> {
    if (await this.#activeConfigurationRevision() !== this.#configurationRevision) throw new SidecarUnavailableError();
  }
}

type PersistentHandlers = Parameters<NonNullable<InteractiveTerminalProcess["persistent"]>["start"]>[0];

/** Bounded pull subscription; a failed carrier never generates a fake PTY exit. */
export class RemoteInteractiveTerminalProcess implements InteractiveTerminalProcess {
  readonly #caller: TerminalSidecarCaller;
  readonly #identity: RemoteTerminalIdentity;
  readonly #outputs = new Set<(bytes: Uint8Array) => void>();
  readonly #exits = new Set<(exit: InteractiveTerminalExit) => void>();
  #controllerToken: string;
  #snapshot: RemoteTerminalSnapshot | undefined;
  #cursor = 0;
  #controlSeq = 0;
  #paused = false;
  #detached = false;
  #connected = true;
  #exit: InteractiveTerminalExit | undefined;
  #finalSeq: number | undefined;
  #acknowledgmentRequested = false;
  #acknowledged = false;
  #handlers: PersistentHandlers | undefined;
  #timer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #controlTail = Promise.resolve();
  #loop: Promise<void> | undefined;

  readonly persistent: NonNullable<InteractiveTerminalProcess["persistent"]> = {
    ownsDeviceReplies: true,
    inputHighWater: async (producerId) => (await this.#caller.call(terminalProducerOperation, { ...this.#control(), producerId })).highWater,
    start: (handlers) => this.#start(handlers),
    detach: () => this.#detach(),
    acknowledgeFinal: async () => {
      if (this.#finalSeq === undefined) throw new Error("terminal_final_status_not_observed");
      this.#acknowledgmentRequested = true;
      await this.#acknowledge();
    },
    forget: async () => {
      if (!this.#acknowledged) throw new Error("terminal_final_history_not_acknowledged");
      try { await this.#caller.call(terminalForgetOperation, this.#identity); }
      catch (error) { if (errorCode(error) !== "terminal_incarnation_unknown") throw error; }
      await this.#detach();
    },
  };

  private constructor(caller: TerminalSidecarCaller, identity: RemoteTerminalIdentity,
    attached: { readonly controllerToken: string; readonly snapshot: RemoteTerminalSnapshot }) {
    this.#caller = caller; this.#identity = identity;
    this.#controllerToken = attached.controllerToken; this.#snapshot = attached.snapshot;
  }

  static async attach(caller: TerminalSidecarCaller, identity: RemoteTerminalIdentity): Promise<RemoteInteractiveTerminalProcess> {
    return new RemoteInteractiveTerminalProcess(caller, identity, await caller.call(terminalAttachOperation, identity));
  }

  pauseOutput(): void { this.#paused = true; }
  resumeOutput(): void { this.#paused = false; this.#wake?.(); }
  onOutput(listener: (bytes: Uint8Array) => void): () => void { this.#outputs.add(listener); return () => this.#outputs.delete(listener); }
  onExit(listener: (exit: InteractiveTerminalExit) => void): () => void {
    if (this.#exit) listener(this.#exit);
    else this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  write(bytes: Uint8Array, producer?: { readonly producerId: string; readonly inputSeq: number }): Promise<InteractiveTerminalWriteResult> {
    return this.#serializeControl(async () => {
      if (this.#detached || !this.#connected || this.#exit || bytes.byteLength > 64 * 1024) {
        return { outcome: "not_sent", diagnosticCode: "terminal_unavailable" };
      }
      try {
        return await this.#caller.call(terminalInputOperation, {
          ...this.#control(), controlSeq: ++this.#controlSeq, data: Buffer.from(bytes).toString("base64url"),
          ...(producer ? { producer } : {}),
        });
      } catch (error) {
        if (error instanceof SidecarOperationError && !["terminal_control_outcome_expired", "terminal_control_outcome_unknown"].includes(error.code)) {
          // Rejected before admission. A gap requires a fresh attachment and
          // sequence baseline; ordinary admission rejection can reuse this one.
          this.#controlSeq -= 1;
          if (["terminal_stale_controller", "terminal_incarnation_unknown", "terminal_control_sequence_gap"].includes(error.code)) this.#lostConnection();
          return { outcome: "not_sent", diagnosticCode: error.code };
        }
        this.#lostConnection();
        return error instanceof SidecarProtocolDeliveryError && error.delivery === "not_sent"
          ? { outcome: "not_sent", diagnosticCode: "terminal_unavailable" }
          : { outcome: "sent_outcome_unknown", diagnosticCode: "terminal_input_outcome_unknown" };
      }
    });
  }

  resize(input: { readonly rows: number; readonly columns: number }): Promise<void> {
    return this.#serializeControl(async () => {
      if (this.#detached || !this.#connected || this.#exit) throw new Error("terminal_unavailable");
      try { await this.#caller.call(terminalResizeOperation, { ...this.#control(), ...input, controlSeq: ++this.#controlSeq }); }
      catch (error) {
        if (error instanceof SidecarOperationError && !["terminal_control_outcome_expired", "terminal_control_outcome_unknown"].includes(error.code)) {
          this.#controlSeq -= 1;
          if (["terminal_stale_controller", "terminal_incarnation_unknown", "terminal_control_sequence_gap"].includes(error.code)) this.#lostConnection();
        } else this.#lostConnection();
        throw error;
      }
    });
  }

  async terminate(signal: "hangup" | "terminate" | "kill"): Promise<void> {
    if (this.#detached || !this.#connected) throw new Error("terminal_unavailable");
    if (!this.#exit) await this.#caller.call(terminalStopOperation, { ...this.#control(), signal });
  }

  async #start(handlers: PersistentHandlers): Promise<void> {
    if (this.#handlers) throw new Error("terminal_subscription_already_started");
    this.#handlers = handlers;
    await this.#restore(this.#snapshot!);
    this.#snapshot = undefined;
    this.#loop = this.#poll();
    void this.#loop.catch(() => this.#lostConnection());
  }

  async #poll(): Promise<void> {
    while (!this.#detached) {
      try {
        if (!this.#connected) {
          const attached = await this.#caller.call(terminalAttachOperation, this.#identity);
          this.#controllerToken = attached.controllerToken; this.#controlSeq = 0;
          await this.#restore(attached.snapshot);
          this.#connected = true;
        }
        if (this.#acknowledgmentRequested && !this.#acknowledged) await this.#acknowledge();
        if (this.#acknowledged) return;
        if (this.#paused || this.#exit) { await this.#delay(100); continue; }
        const page = await this.#caller.call(terminalReadOperation, { ...this.#control(), afterSeq: this.#cursor });
        if (page.kind === "snapshot") { await this.#restore(page.snapshot); continue; }
        for (const record of page.records) {
          if (record.seq !== this.#cursor + 1) throw new Error("terminal_remote_output_gap");
          if (record.kind === "output") for (const listener of this.#outputs) listener(Buffer.from(record.data, "base64url"));
          else if (record.kind === "resize") await this.#handlers!.resize(record);
          else this.#publishExit(record.exit, record.seq);
          this.#cursor = record.seq;
        }
        if (this.#cursor >= page.headSeq) await this.#delay(75);
      } catch (error) {
        if (this.#acknowledgmentRequested && errorCode(error) === "terminal_history_transferred") {
          this.#acknowledged = true;
          return;
        }
        if (error instanceof SidecarOperationError && error.code === "terminal_incarnation_unknown") {
          // A reachable host has definitively lost this incarnation. This says
          // nothing about descendant cleanup and supplies no fabricated exit code.
          this.#exit = { disposition: "interrupted", exitCode: null, signal: null,
            diagnosticCode: "execution_host_continuity_lost", cleanupConfirmed: false };
          for (const listener of this.#exits) listener(this.#exit);
          return;
        }
        this.#lostConnection();
        await this.#delay(500);
      }
    }
  }

  async #restore(snapshot: RemoteTerminalSnapshot): Promise<void> {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < snapshot.byteLength; offset += TERMINAL_REMOTE_CHUNK_BYTES) {
      const result = await this.#caller.call(terminalSnapshotChunkOperation, { ...this.#control(), snapshotId: snapshot.snapshotId, offset });
      const bytes = Buffer.from(result.data, "base64url");
      if (bytes.byteLength !== Math.min(TERMINAL_REMOTE_CHUNK_BYTES, snapshot.byteLength - offset)) throw new Error("terminal_snapshot_chunk_invalid");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) throw new Error("terminal_snapshot_digest_invalid");
    if (this.#detached) throw new Error("terminal_detached");
    await this.#handlers!.restore({ bytes, rows: snapshot.rows, columns: snapshot.columns });
    this.#cursor = snapshot.seq;
    if (snapshot.exit) this.#publishExit(snapshot.exit, snapshot.seq);
  }

  #publishExit(exit: InteractiveTerminalExit, seq: number): void {
    this.#finalSeq = seq;
    if (this.#exit) return;
    this.#exit = exit;
    for (const listener of this.#exits) listener(exit);
  }

  async #acknowledge(): Promise<void> {
    if (this.#acknowledged) return;
    if (!this.#connected || this.#finalSeq === undefined) throw new Error("terminal_handoff_unavailable");
    try {
      await this.#caller.call(terminalAcknowledgeOperation, { ...this.#control(), finalSeq: this.#finalSeq });
      this.#acknowledged = true;
    } catch (error) { this.#lostConnection(); throw error; }
  }

  async #detach(): Promise<void> {
    if (this.#detached) return;
    this.#detached = true; this.#wake?.();
    if (this.#timer) clearTimeout(this.#timer);
    try { if (this.#connected) await this.#caller.call(terminalDetachOperation, this.#control()); }
    catch { /* Dropping an attachment never supplies process-exit evidence. */ }
    finally { this.#caller.close?.(); }
    this.#outputs.clear(); this.#exits.clear();
  }

  #lostConnection(): void {
    if (this.#connected) this.#handlers?.unavailable();
    this.#connected = false;
  }
  #control(): RemoteTerminalIdentity & { controllerToken: string } { return { ...this.#identity, controllerToken: this.#controllerToken }; }
  #serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#controlTail.then(operation);
    this.#controlTail = result.then(() => undefined, () => undefined);
    return result;
  }
  #delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#wake = undefined; resolve(); };
      this.#wake = finish; this.#timer = setTimeout(finish, milliseconds); this.#timer.unref();
    });
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
