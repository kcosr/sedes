import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configurationFingerprint } from "../../../../config/configuration-fingerprint.js";
import { resolveEnvironmentVariables } from "../../../../environment-variables/runtime-environment.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../../execution/environment-channel.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../../../provider-protocol/transport/framed-message-limits.js";
import { snapshotBoundedJson } from "../../../../provider-protocol/json/bounded-json-snapshot.js";
import { acquirePiSessionWriterLock, PiSessionWriterCleanupRequiredError } from "../../pi-session-writer-lock.js";
import { parsePiRpcCommand, parsePiRpcUIResponse } from "../rpc/pi-rpc-wire.js";
import { parsePiManagedCommand } from "../rpc/pi-managed-protocol.js";
import { createPiNativeSessionProcess } from "../rpc/pi-native-launch.js";
import {
  PiNativeError, type PiNativeRuntimeConfiguration, type PiNativeSessionIdentity,
  type PiNativePort, type PiNativeAttachInput, type PiNativeAttachment, type PiNativeCatalog,
  type PiNativeCommand, type PiNativeCreateInput, type PiNativeForkInput, type PiNativeHistory,
  type PiNativeOutcome, type PiNativeEvent, type PiNativeInspection, type PiNativeObservation,
  type PiNativeFailure, type PiNativeRetirement, type PiNativeDrainAttachment, type PiNativeStreamSnapshot,
} from "../port.js";
import { PiNativeDiskStore } from "./disk-store.js";
import { piNativeCommandIsControl, piNativeCommandIsReadOnly, piNativeCommandIsRecoveryControl } from "../command-policy.js";
import { piNativeAgentToolEnvironmentSchema } from "../launch-environment.js";

export interface PiNativeHostAuthority {
  assertCurrent(): void;
  assertAdmission(): void;
}
const LOCAL_AUTHORITY: PiNativeHostAuthority = { assertCurrent() {}, assertAdmission() {} };
type Process = Awaited<ReturnType<typeof createPiNativeSessionProcess>>;
export type PiNativeSessionLauncher = typeof createPiNativeSessionProcess;
type Store = Pick<PiNativeDiskStore, "resolveSessionDirectory" | "create" | "fork" | "reconcileFork" | "listSessions" | "readHistory">;
type OperationBudget = "observation" | "work" | "control";
type Operation = { fingerprint: string; outcome: PiNativeOutcome; bytes: number; budget: OperationBudget; retainOutcome: boolean; observationOnly: boolean; abandoned: boolean };
type CatalogProcess = { id: string; process?: Process; directory?: string; cleanupUnproven: boolean; closing?: Promise<void> };
type StreamContent = { text: string; encodedBytes: number; lastCodeUnit: number };
type Session = {
  identity: PiNativeSessionIdentity; handleId: string; generation: string; environmentFingerprint: string;
  process?: Process; directory?: string; writer?: { release(): Promise<void> };
  starting?: Promise<PiNativeAttachment>; closing?: Promise<void>;
  retiring?: Promise<PiNativeRetirement>;
  closed: boolean; cleanupUnproven: boolean; cleanupProven: boolean; attached: boolean; draining: boolean; controlOnly: boolean; active: boolean; activityGeneration: number;
  interactions: Set<string>; dialogs: Set<string>; operations: Map<string, Operation>; tombstones: Map<string, { fingerprint: string; observationOnly: boolean }>;
  cancelledObservationIds: Set<string>;
  events: PiNativeEvent[]; sequence: number; acknowledged: number; offered: number;
  eventBytes: number; streamBytes: number; continuityLost: boolean; wake: Set<() => void>;
  observationBytes: number;
  streamId: string; streamContent: Map<string, StreamContent>; coalesced: Map<string, PiNativeEvent>;
};
const FRAME_BYTES = MAXIMUM_PROVIDER_FRAME_BYTES;
const DEFAULT_SESSION_EVENT_BYTES = 32 * 1024 * 1024;
const SMALL_REPLY_RESERVATION = 4 * 1024;
const BULK_REPLY_RESERVATION = 64 * 1024;
const MAXIMUM_CANCELLED_OBSERVATIONS = 4096;
const SMALL_RPC_REPLIES = new Set(["abort", "abort_retry", "abort_bash", "get_state", "get_available_thinking_levels",
  "prompt", "steer", "follow_up", "set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level",
  "set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry", "set_session_name", "extension_ui_response"]);
const SMALL_COMPANION_REPLIES = new Set(["set_policy", "set_active_tools", "resolve_tool_approval", "configure_agent_tools", "resolve_agent_tool", "begin_stop", "end_stop"]);
const SNAPSHOT_LIMITS = { maximumEncodedBytes: FRAME_BYTES, maximumStringBytes: FRAME_BYTES,
  maximumArrayItems: 1_000_000, maximumTotalNodes: 2_000_000, maximumDepth: 64 };
const DISALLOWED_SESSION_COMMANDS = new Set(["new_session", "switch_session", "clone", "fork", "export_html"]);

/** Owns native processes and retained evidence. Carrier attachments own neither. */
export class PiNativeHost implements PiNativePort {
  readonly runtimeId = randomUUID();
  readonly #sessions = new Map<string, Session>();
  readonly #byFile = new Map<string, Session>();
  readonly #releasedHandles = new Set<string>();
  readonly #catalogs = new Set<CatalogProcess>();
  readonly #catalogReads = new WeakMap<PiNativeHostAuthority, Map<string, Promise<PiNativeCatalog>>>();
  #catalogTail: Promise<void> = Promise.resolve();
  #catalogPending = 0;
  readonly #inflight = new Map<Promise<unknown>, string>();
  readonly #eventSizes = new WeakMap<PiNativeEvent, number>();
  readonly #bashKeys = new WeakMap<PiNativeEvent, string>();
  readonly #bashContent = new WeakMap<PiNativeEvent, StreamContent>();
  readonly #store: Store;
  readonly #runtime: PiNativeRuntimeConfiguration;
  readonly #launch: PiNativeSessionLauncher;
  #closed = false;
  #frozen = false;
  #operationBytes = 0;
  #observationBytes = 0;
  #controlBytes = 0;
  #closePromise?: Promise<void>;
  constructor(readonly input: {
    readonly configuration: PiNativeRuntimeConfiguration;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly authenticationKey: Uint8Array;
    readonly store?: Store;
    readonly launch?: PiNativeSessionLauncher;
    readonly acquireWriter?: typeof acquirePiSessionWriterLock;
    readonly maximumSessions?: number;
    /** Per-session retained event and unfinished-message budget. */
    readonly maximumEventBytes?: number;
    /** Ordinary pending-command and retained-outcome bytes, excluding the reserved control pool. */
    readonly maximumOperationBytes?: number;
    readonly maximumOperations?: number;
    readonly observationWaitMs?: number;
  }) {
    if (input.authenticationKey.byteLength < 32) throw new PiNativeError("pi_native_authentication_key_invalid");
    this.#launch = input.launch ?? createPiNativeSessionProcess;
    // HOME and PI_CODING_AGENT_DIR are protected from user startup/execution
    // overrides. Pin their effective process-baseline value for both storage
    // and every native child, including catalogs.
    const environment = input.environment;
    const home = (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir();
    let agentDirectory = this.input.configuration.agentDirectory || environment.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    if (agentDirectory === "~") agentDirectory = home;
    else if (agentDirectory.startsWith("~/") || (process.platform === "win32" && agentDirectory.startsWith("~\\"))) agentDirectory = path.join(home, agentDirectory.slice(2));
    else if (agentDirectory.startsWith("file://")) {
      try { agentDirectory = fileURLToPath(agentDirectory); }
      catch { throw new PiNativeError("pi_native_agent_directory_invalid"); }
    }
    if (!path.isAbsolute(agentDirectory) || agentDirectory.includes("\0")) throw new PiNativeError("pi_native_agent_directory_invalid");
    agentDirectory = path.normalize(agentDirectory);
    this.#runtime = { ...input.configuration, agentDirectory };
    this.#store = input.store ?? new PiNativeDiskStore({ agentDirectory,
      ...(input.configuration.sessionDirectory ? { sessionDirectory: input.configuration.sessionDirectory } : {}), authenticationKey: input.authenticationKey });
  }

  async catalog(input: { readonly cwd: string }, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeCatalog> {
    this.#admit(authority, signal);
    let reads = this.#catalogReads.get(authority);
    if (!reads) { reads = new Map(); this.#catalogReads.set(authority, reads); }
    let pending = reads.get(input.cwd);
    if (!pending) {
      if (this.#catalogPending >= 32) throw new PiNativeError("pi_native_catalog_capacity");
      this.#catalogPending++;
      // A probe owns its process independently of any individual reader's
      // cancellation. Serialize workspaces so resource discovery stays bounded.
      pending = this.#track(this.#catalogTail.then(async () => {
        this.#admit(authority);
        if (this.#catalogs.size) throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown");
        return this.#catalog(input, undefined, authority);
      })).finally(() => { reads.delete(input.cwd); this.#catalogPending--; });
      reads.set(input.cwd, pending);
      this.#catalogTail = pending.then(() => undefined, () => undefined);
    }
    const result = await waitForCatalog(pending, signal);
    this.#current(authority, signal);
    return result;
  }
  async #catalog(input: { readonly cwd: string }, signal: AbortSignal | undefined, authority: PiNativeHostAuthority): Promise<PiNativeCatalog> {
    const owner: CatalogProcess = { id: randomUUID(), cleanupUnproven: false };
    this.#catalogs.add(owner);
    try {
      owner.directory = await mkdtemp(path.join(tmpdir(), "sedes-pi-"));
      this.#admit(authority, signal);
      owner.process = await this.#launch({ runtime: this.#runtime, cwd: input.cwd,
        diagnostic: { runtimeId: this.runtimeId, handleId: owner.id },
        channels: this.input.channels, environment: this.input.environment, bridgeDirectory: owner.directory,
        authenticationKey: this.input.authenticationKey, ...(signal ? { signal } : {}) });
      const [models, commands, state] = await Promise.all([
        owner.process.rpc.request({ type: "get_available_models" }, { signal }),
        owner.process.rpc.request({ type: "get_commands" }, { signal }),
        owner.process.rpc.request({ type: "get_state" }, { signal }),
      ]);
      authority.assertCurrent();
      const selection = defaultSelection(state);
      return { models: objectArray(models, "models"), commands: objectArray(commands, "commands"), ...(selection ? { defaultSelection: selection } : {}) };
    } catch (error) {
      if (cleanupUnproven(error)) owner.cleanupUnproven = true;
      throw error;
    } finally {
      await this.#closeCatalog(owner);
    }
  }

  async resolveSessionDirectory(input: { readonly cwd: string }, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<string> {
    this.#current(authority, signal);
    const directory = await this.#store.resolveSessionDirectory(input.cwd, signal);
    this.#current(authority, signal);
    return directory;
  }
  async create(input: PiNativeCreateInput, signal?: AbortSignal, authority = LOCAL_AUTHORITY) {
    this.#admit(authority, signal);
    return this.#track(this.#store.create(input, signal));
  }
  async fork(input: PiNativeForkInput, signal?: AbortSignal, authority = LOCAL_AUTHORITY) {
    this.#admit(authority, signal);
    return this.#track(this.#store.fork(input, signal));
  }
  async reconcileFork(input: PiNativeForkInput, signal?: AbortSignal, authority = LOCAL_AUTHORITY) {
    this.#current(authority, signal);
    const result = await this.#store.reconcileFork(input, signal);
    this.#current(authority, signal);
    return result;
  }
  async listSessions(input: Parameters<PiNativePort["listSessions"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY) {
    this.#current(authority, signal);
    const result = await this.#store.listSessions(input, signal);
    this.#current(authority, signal);
    return result;
  }
  async readHistory(input: PiNativeSessionIdentity, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeHistory> {
    this.#current(authority, signal);
    const result = await this.#store.readHistory(input, signal);
    this.#current(authority, signal);
    return result;
  }

  async attach(input: PiNativeAttachInput, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeAttachment> {
    this.#current(authority, signal);
    if (Object.hasOwn(input.executionEnvironment ?? {}, "PI_CODING_AGENT_DIR")) throw new PiNativeError("pi_native_agent_directory_scope_invalid");
    const agentToolEnvironment = piNativeAgentToolEnvironmentSchema.parse(input.agentToolEnvironment ?? {});
    const environmentFingerprint = configurationFingerprint({ execution: input.executionEnvironment ?? {}, agentTools: agentToolEnvironment });
    const existing = this.#byFile.get(input.sessionFile);
    if (existing) {
      if (existing.retiring) {
        await existing.retiring;
        this.#current(authority, signal);
        return this.attach(input, signal, authority);
      }
      if (!sameSession(existing.identity, input) || existing.environmentFingerprint !== environmentFingerprint) throw new PiNativeError("pi_native_session_configuration_conflict");
      if (existing.cleanupUnproven) throw new PiNativeError("pi_native_cleanup_unproven");
      if (existing.continuityLost) throw new PiNativeError("pi_native_observation_continuity_lost");
      if (existing.closed) throw new PiNativeError("pi_native_session_ended", "sent_outcome_unknown");
      if (existing.draining) throw new PiNativeError("pi_native_session_draining");
      existing.attached = true;
      const result = existing.starting ? await existing.starting : attachment(existing);
      this.#current(authority, signal);
      return result;
    }
    this.#admit(authority, signal);
    if (this.#sessions.size >= (this.input.maximumSessions ?? 32)) throw new PiNativeError("pi_native_session_capacity");
    const identity = { sessionId: input.sessionId, sessionFile: input.sessionFile, cwd: input.cwd };
    const session: Session = { identity, handleId: randomUUID(), generation: randomUUID(), environmentFingerprint,
      closed: false, cleanupUnproven: false, cleanupProven: false, attached: true, draining: false, controlOnly: false, active: false, activityGeneration: 0, interactions: new Set(), dialogs: new Set(),
      operations: new Map(), tombstones: new Map(), cancelledObservationIds: new Set(), events: [], sequence: 0, acknowledged: 0, offered: 0,
      eventBytes: 0, streamBytes: 0, observationBytes: 0, continuityLost: false, wake: new Set(), streamId: randomUUID(), streamContent: new Map(), coalesced: new Map() };
    this.#sessions.set(session.handleId, session); this.#byFile.set(identity.sessionFile, session);
    const start = this.#start(session, input, signal, authority);
    session.starting = start;
    try { return await start; }
    finally { session.starting = undefined; }
  }

  async attachForDrain(input: PiNativeSessionIdentity, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeDrainAttachment | null> {
    this.#current(authority, signal);
    const session = this.#byFile.get(input.sessionFile);
    if (!session) {
      if ([...this.#sessions.values()].some(candidate => candidate.identity.sessionId === input.sessionId)) throw new PiNativeError("pi_native_session_identity_mismatch");
      return null;
    }
    if (!sameSession(session.identity, input)) throw new PiNativeError("pi_native_session_identity_mismatch");
    if (session.starting) throw new PiNativeError("pi_native_session_starting");
    if (session.retiring) {
      await session.retiring;
      return this.attachForDrain(input, signal, authority);
    }
    if (session.attached && !session.draining) throw new PiNativeError("pi_native_session_attached");
    const prior = { attached: session.attached, draining: session.draining };
    session.attached = true; session.draining = true;
    try {
      if (session.continuityLost && !session.closed) {
        const busy = () => session.active || session.interactions.size > 0 ||
          [...session.operations.values()].some(operation => operation.outcome.status === "pending" && !operation.observationOnly);
        if (busy() || !await this.#nativeIdle(session, authority, signal) || busy()) throw new PiNativeError("pi_native_observation_recovery_busy");
        // A gap is recoverable only against stable disk state. Retire this idle
        // process before offering its incomplete prefix for explicit recovery.
        await this.#closeSession(session);
      }
      if (session.closed) await this.#closeSession(session);
      this.#current(authority, signal);
      return { ...attachment(session), closed: session.cleanupProven, observationGap: session.continuityLost };
    } catch (error) {
      session.attached = prior.attached; session.draining = prior.draining;
      throw error;
    }
  }

  async attachForControl(input: PiNativeSessionIdentity, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeAttachment | null> {
    this.#current(authority, signal);
    const session = this.#byFile.get(input.sessionFile);
    if (!session) {
      if ([...this.#sessions.values()].some(candidate => candidate.identity.sessionId === input.sessionId)) throw new PiNativeError("pi_native_session_identity_mismatch");
      return null;
    }
    if (!sameSession(session.identity, input)) throw new PiNativeError("pi_native_session_identity_mismatch");
    if (session.retiring) { await session.retiring; return this.attachForControl(input, signal, authority); }
    if (session.starting) throw new PiNativeError("pi_native_session_starting");
    if (session.cleanupUnproven) throw new PiNativeError("pi_native_cleanup_unproven");
    if (session.closed) throw new PiNativeError("pi_native_session_ended");
    if (!session.continuityLost) throw new PiNativeError("pi_native_observation_recovery_not_required");
    if (session.draining) throw new PiNativeError("pi_native_session_draining");
    session.attached = true; session.controlOnly = true;
    return attachment(session);
  }

  async #start(session: Session, input: PiNativeAttachInput, signal: AbortSignal | undefined, authority: PiNativeHostAuthority): Promise<PiNativeAttachment> {
    try {
      await this.#store.readHistory(session.identity, signal);
      this.#admit(authority, signal);
      session.writer = await (this.input.acquireWriter ?? acquirePiSessionWriterLock)(session.identity.sessionFile, { detachedWriter: true });
      this.#admit(authority, signal);
      session.directory = await mkdtemp(path.join(tmpdir(), "sedes-pi-"));
      const executionEnvironment: Record<string, string | null> = { ...await resolveEnvironmentVariables(input.executionEnvironment ?? {}, this.input.environment) };
      for (const [name, value] of Object.entries(piNativeAgentToolEnvironmentSchema.parse(input.agentToolEnvironment ?? {}))) {
        if (value !== undefined) executionEnvironment[name] = value;
      }
      this.#admit(authority, signal);
      session.process = await this.#launch({ runtime: this.#runtime, session: session.identity,
        diagnostic: { runtimeId: this.runtimeId, handleId: session.handleId, handleGeneration: session.generation },
        cwd: session.identity.cwd, channels: this.input.channels, environment: this.input.environment,
        executionEnvironment, bridgeDirectory: session.directory,
        authenticationKey: this.input.authenticationKey, ...(signal ? { signal } : {}),
        onEvent: event => this.#event(session, event.kind, event.payload) });
      void session.process.rpc.closed.then(() => this.#nativeEnded(session), () => this.#nativeEnded(session));
      void session.process.bridge.closed.then(() => this.#nativeEnded(session), () => this.#nativeEnded(session));
      // A crossed launch remains owned even if its controller disappeared.
      authority.assertCurrent();
      return attachment(session);
    } catch (error) {
      if (session.process) {
        // Losing only the controller never terminates an admitted native owner.
        if (!signal?.aborted) throw error;
      }
      session.closed = true;
      if (cleanupUnproven(error)) session.cleanupUnproven = true;
      else {
        try {
          if (session.process) await session.process.close("pi_native_start_failed");
          await session.writer?.release(); session.writer = undefined;
          if (session.directory) await rm(session.directory, { recursive: true, force: true });
          this.#sessions.delete(session.handleId); this.#byFile.delete(session.identity.sessionFile);
        } catch { session.cleanupUnproven = true; }
      }
      throw error instanceof PiSessionWriterCleanupRequiredError ? new PiNativeError(error.code, "not_sent", { cause: error }) : error;
    }
  }

  async request(input: Parameters<PiNativePort["request"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeOutcome> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId);
    if (session.cancelledObservationIds.has(input.operationId))
      throw new PiNativeError("pi_native_operation_abandoned", "sent_outcome_unknown");
    let command: PiNativeCommand;
    try { command = validateCommand(input.command); }
    catch (cause) {
      if (cause instanceof PiNativeError) throw cause;
      throw new PiNativeError("pi_native_command_invalid", "not_sent", { cause });
    }
    if (typeof input.retainOutcome !== "boolean") throw new PiNativeError("pi_native_retention_policy_invalid");
    const fingerprint = configurationFingerprint({ command, retainOutcome: input.retainOutcome });
    const previous = session.operations.get(input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PiNativeError("pi_native_operation_identity_conflict");
      return copy(previous.outcome);
    }
    const acknowledged = session.tombstones.get(input.operationId);
    if (acknowledged !== undefined) {
      if (acknowledged.fingerprint !== fingerprint) throw new PiNativeError("pi_native_operation_identity_conflict");
      throw new PiNativeError("pi_native_operation_acknowledged", "sent_outcome_unknown");
    }
    if (session.retiring) throw new PiNativeError("pi_native_session_retiring");
    if (session.draining && !piNativeCommandIsReadOnly(command))
      throw new PiNativeError("pi_native_drain_read_only");
    if (session.controlOnly && !piNativeCommandIsRecoveryControl(command))
      throw new PiNativeError("pi_native_recovery_control_only");
    const control = piNativeCommandIsControl(command);
    if (!control) this.#admit(authority, signal);
    if (session.closed || !session.process) throw new PiNativeError("pi_native_session_ended", "not_sent");
    if (!control && session.continuityLost) throw new PiNativeError("pi_native_observation_continuity_lost", "not_sent");
    if (!validId(input.operationId)) throw new PiNativeError("pi_native_operation_identity_invalid");
    const readOnly = piNativeCommandIsReadOnly(command);
    const budget: OperationBudget = readOnly ? "observation" : control ? "control" : "work";
    const smallReply = (command.channel === "rpc" ? SMALL_RPC_REPLIES : SMALL_COMPANION_REPLIES).has(String(command.command.type));
    const reservation = bytes(command) + (smallReply ? SMALL_REPLY_RESERVATION : BULK_REPLY_RESERVATION);
    if (session.operations.size >= (this.input.maximumOperations ?? 256) ||
      !this.#hasOperationCapacity(session, budget, reservation)) {
      throw new PiNativeError("pi_native_operation_capacity");
    }
    const operation: Operation = { fingerprint, outcome: { status: "pending" }, bytes: reservation, budget,
      retainOutcome: input.retainOutcome, observationOnly: !input.retainOutcome && readOnly, abandoned: false };
    const operationId = input.operationId;
    session.operations.set(input.operationId, operation); this.#accountOperation(session, budget, reservation);
    // Never pass the carrier cancellation into an admitted native mutation.
    const process = session.process;
    void Promise.resolve().then(async () => {
      if (command.channel === "companion") {
        const parsed = parsePiManagedCommand(command.command);
        const result = await process.bridge.request(parsed);
        if (parsed.type === "begin_stop") {
          // Only an explicitly requested Stop cancels native dialogs. Companion
          // begin_stop already denies approvals and cancels Sedes tool calls.
          for (const id of session.dialogs) {
            await process.rpc.respondUI({ type: "extension_ui_response", id, cancelled: true });
            session.dialogs.delete(id); session.interactions.delete(id);
          }
        }
        if (parsed.type === "resolve_agent_tool") session.interactions.delete(parsed.id);
        return result;
      }
      if (command.command.type === "extension_ui_response") {
        await process.rpc.respondUI(parsePiRpcUIResponse(command.command));
        session.dialogs.delete(String(command.command.id)); session.interactions.delete(String(command.command.id));
        return { ok: true };
      }
      const parsed = parsePiRpcCommand(command.command);
      return process.rpc.request(parsed, ["prompt", "steer", "follow_up", "compact", "bash"].includes(parsed.type) ? { deadlineAt: null } : {});
    }).then(result => this.#settle(session, operationId, operation, { status: "completed", result: result ?? null }),
      error => this.#settle(session, operationId, operation, { status: "failed", failure: failure(error, "sent_outcome_unknown") }));
    return { status: "pending" };
  }

  async outcome(input: Parameters<PiNativePort["outcome"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeOutcome> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId), operation = session.operations.get(input.operationId);
    if (!operation) throw new PiNativeError("pi_native_operation_unknown", "sent_outcome_unknown");
    const outcome = copy(operation.outcome);
    if (!operation.retainOutcome && outcome.status !== "pending") this.#forgetOperation(session, input.operationId, operation);
    return outcome;
  }
  async acknowledgeOperation(input: Parameters<PiNativePort["acknowledgeOperation"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<void> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId), operation = session.operations.get(input.operationId);
    if (!operation) {
      if (session.tombstones.has(input.operationId)) return;
      throw new PiNativeError("pi_native_operation_unknown", "sent_outcome_unknown");
    }
    if (operation.outcome.status === "pending") throw new PiNativeError("pi_native_operation_pending", "sent_outcome_unknown");
    this.#forgetOperation(session, input.operationId, operation);
  }
  async abandonObservation(input: Parameters<PiNativePort["abandonObservation"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<"pending" | "released"> {
    this.#current(authority, signal);
    if (!validId(input.operationId)) throw new PiNativeError("pi_native_operation_identity_invalid");
    const session = this.#session(input.handleId), operation = session.operations.get(input.operationId);
    if (!operation) {
      const known = session.tombstones.get(input.operationId);
      if (known) {
        if (!known.observationOnly) throw new PiNativeError("pi_native_observation_abandon_denied");
        return "released";
      }
      if (session.cancelledObservationIds.has(input.operationId)) return "released";
      // A carrier can lose a request before admission. Fence its ID before
      // releasing the reader so a late frame cannot allocate the old read.
      // These markers never evict while this session generation exists.
      if (session.cancelledObservationIds.size >= MAXIMUM_CANCELLED_OBSERVATIONS)
        throw new PiNativeError("pi_native_observation_abandon_capacity", "sent_outcome_unknown");
      session.cancelledObservationIds.add(input.operationId);
      return "released";
    }
    if (!operation.observationOnly) throw new PiNativeError("pi_native_observation_abandon_denied");
    operation.abandoned = true;
    if (operation.outcome.status === "pending") return "pending";
    this.#forgetOperation(session, input.operationId, operation);
    return "released";
  }
  async observe(input: Parameters<PiNativePort["observe"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeObservation> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId);
    this.#checkCursor(session, input.afterSequence);
    if (session.sequence <= input.afterSequence && !session.closed) {
      await waitForEvent(session, signal, this.input.observationWaitMs ?? 1000);
      this.#current(authority, signal); this.#checkCursor(session, input.afterSequence);
    }
    const events: PiNativeEvent[] = [];
    let size = 0;
    for (const event of session.events) {
      if (event.sequence <= input.afterSequence) continue;
      const next = this.#eventSize(event);
      if (events.length && (size + next > FRAME_BYTES || events.length >= 256)) break;
      events.push(event); size += next;
    }
    const throughSequence = events.at(-1)?.sequence ?? input.afterSequence;
    session.offered = Math.max(session.offered, throughSequence);
    return { events: copy(events), throughSequence, retainedAfterSequence: session.acknowledged, closed: session.closed };
  }
  async acknowledge(input: Parameters<PiNativePort["acknowledge"]>[0], signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<void> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId);
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0 || input.throughSequence > session.offered) throw new PiNativeError("pi_native_acknowledgement_invalid");
    if (input.throughSequence <= session.acknowledged) return;
    while (session.events[0] && session.events[0].sequence <= input.throughSequence) {
      const event = session.events.shift()!;
      const size = this.#eventSize(event); session.eventBytes -= size;
      const key = this.#coalescingKey(event);
      if (key && session.coalesced.get(key) === event) session.coalesced.delete(key);
    }
    session.acknowledged = input.throughSequence; this.#retireReleased(session);
  }
  async release(input: { readonly handleId: string }, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<void> {
    signal?.throwIfAborted(); authority.assertCurrent();
    if (this.#releasedHandles.has(input.handleId)) return;
    const session = this.#session(input.handleId);
    // A confirmed host stop precedes conversation cleanup. Its exact known
    // handles are already released; retirement never admits another operation.
    if (this.#closed) return;
    session.attached = false; session.draining = false; session.controlOnly = false; this.#abandonTransientOperations(session); this.#retireReleased(session);
  }
  async acknowledgeObservationGap(input: { readonly handleId: string; readonly generation: string; readonly throughSequence: number }, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<void> {
    this.#current(authority, signal);
    const session = this.#session(input.handleId);
    if (input.generation !== session.generation) throw new PiNativeError("pi_native_session_identity_mismatch");
    if (!session.draining || !session.closed || !session.cleanupProven || session.cleanupUnproven) throw new PiNativeError("pi_native_observation_recovery_not_ready");
    if (input.throughSequence !== session.sequence || session.acknowledged !== session.sequence || session.events.length)
      throw new PiNativeError("pi_native_observation_recovery_unapplied");
    // Operation receipts are separate obligations. This only confirms that
    // the caller applied stable history, retained output, and a visible gap.
    session.continuityLost = false;
  }
  async retireSession(input: PiNativeSessionIdentity, signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeRetirement> {
    this.#current(authority, signal);
    const session = this.#byFile.get(input.sessionFile);
    if (!session) {
      if ([...this.#sessions.values()].some(candidate => candidate.identity.sessionId === input.sessionId)) throw new PiNativeError("pi_native_session_identity_mismatch");
      return "absent";
    }
    if (!sameSession(session.identity, input)) throw new PiNativeError("pi_native_session_identity_mismatch");
    const result = await this.#retire(session, authority, signal);
    this.#current(authority, signal);
    return result;
  }
  retiredHandleIds(): readonly string[] {
    if (!this.#closed) throw new PiNativeError("pi_native_runtime_not_retired");
    return [...this.#releasedHandles, ...this.#sessions.keys()];
  }
  detach(): void {
    for (const session of this.#sessions.values()) { session.attached = false; session.draining = false; session.controlOnly = false; this.#abandonTransientOperations(session); this.#wake(session); this.#retireReleased(session); }
  }
  async inspect(signal?: AbortSignal, authority = LOCAL_AUTHORITY): Promise<PiNativeInspection> {
    this.#current(authority, signal);
    return this.snapshot();
  }
  snapshot(): PiNativeInspection {
    const sessions = [...this.#sessions.values()];
    const blockers: PiNativeInspection["blockers"][number][] = [];
    if (this.#inflight.size || sessions.some(session => session.starting || session.retiring || session.active)) blockers.push("active_work");
    if (sessions.some(session => session.interactions.size)) blockers.push("pending_interaction");
    if (sessions.some(session => [...session.operations.values()].some(operation => !operation.observationOnly) || session.events.length)) blockers.push("unsettled_outcome");
    if ([...this.#catalogs].some(owner => owner.cleanupUnproven) || sessions.some(session => session.cleanupUnproven)) blockers.push("cleanup_unproven");
    if (sessions.some(session => session.continuityLost)) blockers.push("unknown_state");
    // Confirmation describes native ownership and outstanding obligations.
    // Token output and its observation cursor must not invalidate a decision
    // to stop the same run; a different run or newly admitted work must.
    const revision = configurationFingerprint({ runtimeId: this.runtimeId, blockers,
      inflight: [...this.#inflight.values()].sort(),
      catalogs: [...this.#catalogs].map(owner => ({ id: owner.id, cleanupUnproven: owner.cleanupUnproven })).sort((left, right) => left.id.localeCompare(right.id)),
      sessions: sessions.map(session => ({ ...session.identity, handleId: session.handleId, generation: session.generation,
        active: session.active, activityGeneration: session.activityGeneration, starting: Boolean(session.starting), retiring: Boolean(session.retiring),
        closed: session.closed, cleanupProven: session.cleanupProven, cleanupUnproven: session.cleanupUnproven, continuityLost: session.continuityLost,
        interactions: [...session.interactions].sort(), retainedEvents: session.events.length > 0,
        operations: [...session.operations].filter(([, operation]) => !operation.observationOnly).map(([id, operation]) => ({ id, status: operation.outcome.status })).sort((left, right) => left.id.localeCompare(right.id)),
      })).sort((left, right) => left.handleId.localeCompare(right.handleId)) });
    return { runtimeId: this.runtimeId, state: blockers.includes("cleanup_unproven") || blockers.includes("unknown_state") ? "unknown" : blockers.length ? "active" : "idle",
      revision, blockers, retainedSessions: sessions.map(attachment) };
  }
  freezeAdmission(): void { this.#frozen = true; }
  restoreAdmission(): void { if (!this.#closed) this.#frozen = false; }
  async stop(input: { readonly expectedRevision: string; readonly force: boolean }, signal?: AbortSignal, authority = LOCAL_AUTHORITY,
    beforeClose?: (evidence: PiNativeInspection) => Promise<void>): Promise<void> {
    this.#current(authority, signal);
    const wasFrozen = this.#frozen; this.#frozen = true;
    try {
      const evidence = this.snapshot();
      if (input.expectedRevision !== evidence.revision) throw new PiNativeError("pi_native_confirmation_stale");
      if (!input.force && evidence.blockers.length) throw new PiNativeError("pi_native_restart_blocked");
      if (input.force && beforeClose) await beforeClose(evidence);
      this.#current(authority, signal);
      await this.close();
    } catch (error) { if (!this.#closed && !wasFrozen) this.#frozen = false; throw error; }
  }
  close(): Promise<void> {
    return this.#closePromise ??= this.#close().catch(error => { this.#closePromise = undefined; throw error; });
  }
  async #close(): Promise<void> {
    this.#frozen = true;
    await Promise.allSettled(this.#inflight.keys());
    await Promise.allSettled([...this.#sessions.values()].map(session => session.starting));
    const outcomes = await Promise.allSettled([
      ...[...this.#sessions.values()].map(session => this.#closeSession(session)),
      ...[...this.#catalogs].map(owner => this.#closeCatalog(owner)),
    ]);
    if (outcomes.some(outcome => outcome.status === "rejected")) throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown");
    this.#closed = true;
  }
  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#inflight.set(operation, randomUUID());
    try { return await operation; }
    finally { this.#inflight.delete(operation); }
  }
  #closeCatalog(owner: CatalogProcess): Promise<void> {
    return owner.closing ??= (async () => {
      try {
        if (!owner.process && owner.cleanupUnproven) throw new Error("pi_native_cleanup_unproven");
        await owner.process?.close("pi_native_catalog_complete");
        if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
        this.#catalogs.delete(owner);
      } catch (cause) {
        owner.cleanupUnproven = true;
        throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown", { cause });
      }
    })().catch(error => { owner.closing = undefined; throw error; });
  }
  #current(authority: PiNativeHostAuthority, signal?: AbortSignal): void {
    signal?.throwIfAborted(); authority.assertCurrent();
    if (this.#closed) throw new PiNativeError("pi_native_runtime_closed");
  }
  #admit(authority: PiNativeHostAuthority, signal?: AbortSignal): void {
    this.#current(authority, signal); authority.assertAdmission();
    if (this.#frozen) throw new PiNativeError("pi_native_admission_frozen");
  }
  #session(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new PiNativeError("pi_native_session_unknown", "sent_outcome_unknown");
    return session;
  }
  #hasOperationCapacity(session: Session, budget: OperationBudget, delta: number): boolean {
    const ordinaryLimit = this.input.maximumOperationBytes ?? 4 * FRAME_BYTES;
    const observationLimit = ordinaryLimit - Math.min(FRAME_BYTES, ordinaryLimit / 4);
    const ordinary = this.#operationBytes - this.#controlBytes + (budget === "control" ? 0 : delta);
    const observation = this.#observationBytes + (budget === "observation" ? delta : 0);
    const sessionObservation = session.observationBytes + (budget === "observation" ? delta : 0);
    const control = this.#controlBytes + (budget === "control" ? delta : 0);
    return ordinary <= ordinaryLimit && observation <= observationLimit &&
      sessionObservation <= Math.min(FRAME_BYTES, ordinaryLimit / 4) && control <= FRAME_BYTES;
  }
  #accountOperation(session: Session, budget: OperationBudget, delta: number): void {
    this.#operationBytes += delta;
    if (budget === "control") this.#controlBytes += delta;
    if (budget === "observation") { this.#observationBytes += delta; session.observationBytes += delta; }
  }
  #settle(session: Session, operationId: string, operation: Operation, outcome: PiNativeOutcome): void {
    if (session.operations.get(operationId) !== operation || operation.outcome.status !== "pending") return;
    try { operation.outcome = copy(outcome); }
    catch { operation.outcome = { status: "failed", failure: { code: "pi_native_outcome_invalid", delivery: "sent_outcome_unknown" } }; }
    let size = bytes(operation.outcome);
    if (!this.#hasOperationCapacity(session, operation.budget, size - operation.bytes)) {
      // A completed native mutation may already have taken effect. Preserve a
      // bounded unknown-outcome receipt rather than declaring it unsent or
      // allowing concurrent large responses to overrun retained-data limits.
      operation.outcome = { status: "failed", failure: { code: "pi_native_outcome_capacity", delivery: "sent_outcome_unknown" } };
      size = bytes(operation.outcome);
    }
    this.#accountOperation(session, operation.budget, size - operation.bytes); operation.bytes = size;
    if (!operation.retainOutcome && operation.abandoned) this.#forgetOperation(session, operationId, operation);
    this.#wake(session); this.#retireReleased(session);
  }
  #forgetOperation(session: Session, operationId: string, operation: Operation): void {
    if (session.operations.get(operationId) !== operation) return;
    session.operations.delete(operationId); this.#accountOperation(session, operation.budget, -operation.bytes);
    session.tombstones.set(operationId, { fingerprint: operation.fingerprint, observationOnly: operation.observationOnly });
    while (session.tombstones.size > 4096) session.tombstones.delete(session.tombstones.keys().next().value!);
    this.#retireReleased(session);
  }
  #abandonTransientOperations(session: Session): void {
    for (const [id, operation] of session.operations) {
      if (operation.retainOutcome) continue;
      operation.abandoned = true;
      if (operation.outcome.status !== "pending") this.#forgetOperation(session, id, operation);
    }
  }
  #event(session: Session, kind: PiNativeEvent["kind"], payload: Readonly<Record<string, unknown>>): void {
    const type = payload.type;
    if (kind === "rpc") {
      if (type === "agent_start") { session.active = true; session.activityGeneration++; }
      if (type === "agent_end") session.active = false;
      if (type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(payload.method))) {
        session.interactions.add(String(payload.id)); session.dialogs.add(String(payload.id));
      }
    } else if (kind === "companion") {
      if (type === "tool_approval_requested") session.interactions.add(String(payload.id));
      if (type === "tool_approval_closed") session.interactions.delete(String(payload.id));
      if (type === "agent_tool_call") session.interactions.add(String(payload.id));
      if (type === "agent_tool_cancelled") session.interactions.delete(String(payload.id));
    }
    if (!session.continuityLost) {
      try {
        const event = this.#snapshotEvent(session, kind, payload);
        const size = this.#eventSize(event), key = this.#coalescingKey(event);
        const previous = key ? session.coalesced.get(key) : undefined;
        const reclaimed = previous ? this.#eventSize(previous) : 0;
        if (size > FRAME_BYTES || session.eventBytes + session.streamBytes + size - reclaimed > (this.input.maximumEventBytes ?? DEFAULT_SESSION_EVENT_BYTES) ||
          session.events.length - (previous ? 1 : 0) >= 16384) throw new Error("capacity");
        if (previous) {
          session.events.splice(session.events.indexOf(previous), 1);
          session.eventBytes -= reclaimed;
        }
        session.events.push(event); session.sequence++; session.eventBytes += size;
        if (key) session.coalesced.set(key, event);
      } catch { session.continuityLost = true; this.#clearStreams(session); }
    }
    this.#wake(session);
  }
  #eventSize(event: PiNativeEvent): number { return this.#eventSizes.get(event) ?? bytes(event); }
  #coalescingKey(event: PiNativeEvent): string | undefined {
    if (event.kind === "stream") {
      if (event.payload.type === "bash_snapshot") return this.#bashKeys.get(event);
      return `message:${String(event.payload.streamId)}:${String(event.payload.contentIndex)}`;
    }
    if (event.kind === "rpc" && event.payload.type === "tool_execution_update") return `tool:${String(event.payload.toolCallId)}`;
    return undefined;
  }
  #clearStreams(session: Session): void {
    session.streamBytes = 0;
    session.streamContent.clear();
  }
  #snapshotEvent(session: Session, kind: PiNativeEvent["kind"], payload: Readonly<Record<string, unknown>>): PiNativeEvent {
    const sequence = session.sequence + 1;
    // Native RPC sends incremental strings, not cumulative partial messages.
    // Keep one absolute snapshot per content block so detached observation is
    // bounded by meaningful output size, not the number of provider tokens.
    if (kind === "rpc" && ["message_start", "message_end"].includes(String(payload.type)) &&
      (payload.message as { role?: unknown } | undefined)?.role === "assistant") {
      this.#clearStreams(session); session.streamId = randomUUID();
    }
    const update = kind === "rpc" && payload.type === "message_update"
      ? payload.assistantMessageEvent as { type?: unknown; contentIndex?: unknown; delta?: unknown } | undefined : undefined;
    if (update && ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(update.type))) {
      if (typeof update.delta !== "string" || !Number.isSafeInteger(update.contentIndex) || Number(update.contentIndex) < 0) throw new Error("invalid_stream");
      const contentIndex = Number(update.contentIndex), key = `${session.streamId}:${contentIndex}`;
      const previous = session.streamContent.get(key) ?? { text: "", encodedBytes: 0, lastCodeUnit: -1 };
      const next = appendContent(previous, update.delta);
      session.streamBytes += next.encodedBytes - previous.encodedBytes; session.streamContent.set(key, next);
      const body: PiNativeStreamSnapshot = update.type === "toolcall_delta"
        ? { type: "toolcall_snapshot", streamId: session.streamId, contentIndex, text: next.text }
        : { type: "message_snapshot", streamId: session.streamId, contentIndex,
          semanticKind: update.type === "thinking_delta" ? "reasoning" : "assistant_message", text: next.text };
      const event: PiNativeEvent = Object.freeze({ sequence, kind: "stream", payload: Object.freeze(body) });
      this.#eventSizes.set(event, bytes({ ...event, payload: { ...body, text: "" } }) + next.encodedBytes);
      return event;
    }
    if (kind === "rpc" && payload.type === "bash_execution_update") {
      if (typeof payload.delta !== "string") throw new Error("invalid_stream");
      const key = `bash:${typeof payload.id === "string" ? payload.id : "unidentified"}`;
      const previous = session.coalesced.get(key);
      const next = appendContent(previous ? this.#bashContent.get(previous)! : { text: "", encodedBytes: 0, lastCodeUnit: -1 }, payload.delta);
      // After acknowledgement a fresh segment keeps prior delivered output
      // separate without retaining the entire lifetime of a shell command.
      const body = Object.freeze({ type: "bash_snapshot", streamId: typeof previous?.payload.streamId === "string" ? previous.payload.streamId : randomUUID(), text: next.text });
      const event: PiNativeEvent = Object.freeze({ sequence, kind: "stream", payload: body });
      this.#eventSizes.set(event, bytes({ ...event, payload: { ...body, text: "" } }) + next.encodedBytes);
      this.#bashKeys.set(event, key);
      this.#bashContent.set(event, next);
      return event;
    }
    const event = copy({ sequence, kind, payload });
    this.#eventSizes.set(event, bytes(event));
    return event;
  }
  #checkCursor(session: Session, cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < session.acknowledged || cursor > session.sequence ||
      (session.continuityLost && !(session.draining && session.cleanupProven))) {
      throw new PiNativeError("pi_native_observation_continuity_lost", "sent_outcome_unknown");
    }
  }
  #wake(session: Session): void { for (const wake of [...session.wake]) wake(); }
  #retireReleased(session: Session): void {
    if (this.#retirementBlocker(session)) return;
    void this.#retire(session, LOCAL_AUTHORITY).catch(() => undefined);
  }
  #retirementBlocker(session: Session): "busy" | "undelivered" | undefined {
    if (session.attached || session.starting || session.active || session.interactions.size ||
      [...session.operations.values()].some(operation => operation.outcome.status === "pending")) return "busy";
    if (session.operations.size || session.events.length || session.continuityLost) return "undelivered";
    return undefined;
  }
  #retire(session: Session, authority: PiNativeHostAuthority, signal?: AbortSignal): Promise<PiNativeRetirement> {
    if (session.retiring) return session.retiring;
    session.retiring = Promise.resolve().then(async (): Promise<PiNativeRetirement> => {
      const before = this.#retirementBlocker(session);
      if (before) return before;
      if (!session.closed && !await this.#nativeIdle(session, authority, signal)) return "busy";
      this.#current(authority, signal);
      const after = this.#retirementBlocker(session);
      if (after) return after;
      await this.#closeSession(session);
      // Draining the native streams may expose a final event. Keep that exact
      // evidence even though process cleanup itself is now proven.
      if (session.events.length || session.operations.size || session.continuityLost) return "undelivered";
      this.#releasedHandles.add(session.handleId);
      while (this.#releasedHandles.size > 256) this.#releasedHandles.delete(this.#releasedHandles.values().next().value!);
      this.#sessions.delete(session.handleId); this.#byFile.delete(session.identity.sessionFile);
      return "retired";
    }).finally(() => { session.retiring = undefined; });
    return session.retiring;
  }
  #nativeEnded(session: Session): void {
    if (session.closed) return;
    this.#event(session, "failure", { type: "failure", code: "pi_native_session_ended" });
    void this.#closeSession(session).catch(() => undefined);
  }
  async #nativeIdle(session: Session, authority: PiNativeHostAuthority, signal?: AbortSignal): Promise<boolean> {
    if (!session.process) throw new PiNativeError("pi_native_session_state_unknown", "sent_outcome_unknown");
    const [native, companion] = await Promise.all([
      session.process.rpc.request({ type: "get_state" }, { signal }),
      session.process.bridge.request({ type: "snapshot" }, { signal }),
    ]);
    this.#current(authority, signal);
    if (!native || typeof native !== "object" || !companion || typeof companion !== "object") throw new PiNativeError("pi_native_session_state_unknown", "sent_outcome_unknown");
    const state = native as Record<string, unknown>, managed = companion as Record<string, unknown>;
    if (state.sessionId !== session.identity.sessionId || state.sessionFile !== session.identity.sessionFile ||
      managed.sessionId !== session.identity.sessionId || managed.sessionFile !== session.identity.sessionFile) throw new PiNativeError("pi_native_session_identity_mismatch");
    return state.isStreaming === false && state.isCompacting === false && state.pendingMessageCount === 0 && managed.isIdle === true;
  }
  #closeSession(session: Session): Promise<void> {
    return session.closing ??= (async () => {
      session.closed = true; session.cleanupProven = false; session.active = false; this.#wake(session);
      try {
        // A failed launcher can report a surviving child before returning its
        // process handle. Absence of a handle is not proof the writer exited.
        if (session.cleanupUnproven && !session.process) throw new Error("pi_native_cleanup_unproven");
        await session.process?.close("pi_native_session_closed");
        await session.writer?.release(); session.writer = undefined;
        if (session.directory) await rm(session.directory, { recursive: true, force: true });
        session.cleanupUnproven = false; session.cleanupProven = true;
        session.interactions.clear(); session.dialogs.clear(); this.#clearStreams(session);
        for (const [operationId, operation] of session.operations) if (operation.outcome.status === "pending") {
          this.#settle(session, operationId, operation, { status: "failed", failure: { code: "pi_native_session_ended", delivery: "sent_outcome_unknown" } });
        }
      } catch (cause) {
        session.cleanupUnproven = true;
        throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown", { cause });
      }
    })().catch(error => { session.closing = undefined; throw error; });
  }
}

function validateCommand(value: PiNativeCommand): PiNativeCommand {
  if (value.channel === "companion") return { channel: "companion", command: parsePiManagedCommand(value.command) };
  if (value.channel !== "rpc") throw new PiNativeError("pi_native_command_invalid");
  if (value.command.type === "extension_ui_response") return { channel: "rpc", command: parsePiRpcUIResponse(value.command) };
  const command = parsePiRpcCommand(value.command);
  if (DISALLOWED_SESSION_COMMANDS.has(command.type)) throw new PiNativeError("pi_native_session_command_denied");
  return { channel: "rpc", command };
}
function sameSession(left: PiNativeSessionIdentity, right: PiNativeSessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.cwd === right.cwd;
}
function attachment(session: Session): PiNativeAttachment {
  return { ...session.identity, handleId: session.handleId, generation: session.generation, throughSequence: session.sequence, retainedAfterSequence: session.acknowledged,
    retainedOperationIds: [...session.operations.keys()] };
}
function validId(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function appendContent(previous: StreamContent, delta: string): StreamContent {
  const last = previous.lastCodeUnit, first = delta.charCodeAt(0);
  // JSON encodes isolated surrogates as six bytes, and a joined pair as four.
  const joinedPair = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  return { text: previous.text + delta,
    encodedBytes: previous.encodedBytes + Buffer.byteLength(JSON.stringify(delta)) - 2 - (joinedPair ? 8 : 0),
    lastCodeUnit: delta.length ? delta.charCodeAt(delta.length - 1) : last };
}
function copy<T>(value: T): T { return snapshotBoundedJson(value, SNAPSHOT_LIMITS) as T; }
function cleanupUnproven(error: unknown): boolean {
  return error instanceof Error && /cleanup_(?:unproven|unproved|unconfirmed)|process_group_survived/u.test(error.message);
}
function failure(error: unknown, fallback: PiNativeFailure["delivery"]): PiNativeFailure {
  const candidate = error as { code?: unknown; delivery?: unknown } | null;
  return { code: typeof candidate?.code === "string" && /^pi_[a-z0-9_]{1,100}$/u.test(candidate.code) ? candidate.code : "pi_native_request_failed",
    delivery: candidate?.delivery === "not_sent" || candidate?.delivery === "sent_outcome_unknown" || candidate?.delivery === "rejected" ? candidate.delivery : fallback };
}
function objectArray(value: unknown, key: string): readonly Readonly<Record<string, unknown>>[] {
  const array = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(array) || array.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new PiNativeError("pi_native_catalog_invalid");
  return copy(array);
}
function defaultSelection(value: unknown): PiNativeCatalog["defaultSelection"] {
  if (!value || typeof value !== "object") return undefined;
  const state = value as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
  if (!state.model || !validId(state.model.provider as string) || !validId(state.model.id as string) || !validId(state.thinkingLevel as string)) return undefined;
  return { provider: state.model.provider as string, modelId: state.model.id as string, thinkingLevel: state.thinkingLevel as string };
}
function waitForCatalog<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function waitForEvent(session: Session, signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    const timer = setTimeout(done, milliseconds);
    const cleanup = () => { clearTimeout(timer); session.wake.delete(done); signal?.removeEventListener("abort", abort); };
    session.wake.add(done); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
