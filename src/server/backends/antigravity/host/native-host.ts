import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import { mergeResolvedEnvironment, resolveEnvironmentVariables } from "../../../environment-variables/runtime-environment.js";
import { OwnedNdjsonStdioTransportFactory } from "../../../provider-protocol/transport/owned-ndjson-stdio-transport.js";
import { AcpDeliveryError, AcpRemoteError } from "../../../provider-protocol/bindings/acp-v1/index.js";
import { AntigravityAcpConnection } from "../acp-connection.js";
import { antigravityNativeActivity } from "./native-activity.js";
import { antigravityNativeTerminalOutcome } from "../native-execution.js";
import { antigravityCommandSchema, antigravityAgentToolsSchema } from "../sidecar/wire.js";
import { AntigravityError, type AntigravityPort, type AntigravityRuntimeConfiguration, type AntigravityIdentity,
  type AntigravitySetup, type AntigravityAttachment, type AntigravityEvent, type AntigravityOutcome,
  type AntigravityHistory, type AntigravityInspection, type AntigravityFailure } from "../port.js";

export interface AntigravityHostAuthority { assertCurrent(): void; assertAdmission(): void; }
const localAuthority: AntigravityHostAuthority = { assertCurrent() {}, assertAdmission() {} };
type Permission = { request: RequestPermissionRequest; openedAt: string; resolve(value: RequestPermissionResponse): void };
type SetterPostcondition = { kind: "config"; id: string; valueFingerprint: string; after: number } | { kind: "mode"; valueFingerprint: string; after: number };
type Operation = { fingerprint: string; outcome: AntigravityOutcome; postcondition?: SetterPostcondition };
type CancellationResult = { settledOperationIds: readonly string[]; nativeRevision: string };
type Cancellation = { captured: Set<string>; operations: Set<string>; result?: CancellationResult };
type Creation = { fingerprint: string; result: Promise<AntigravityIdentity>; identity?: AntigravityIdentity; crossed: boolean };
type OpenHandlers = { authorizeSession(id: string): boolean; update(notification: SessionNotification): void; permission(request: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse> };
type Session = {
  identity: AntigravityIdentity; handleId: string; generation: string; setup: AntigravitySetup;
  peer: AntigravityAcpConnection; events: AntigravityEvent[]; sequence: number; offered: number; acknowledged: number;
  retainedAfter: number; eventBytes: number; attached: boolean; closed: boolean; cleanupUnproven: boolean;
  activePrompts: Set<string>; tools: Set<string>; permissions: Map<string, Permission>;
  nativeActive: boolean; nativeUnknown: boolean; nativeRevision?: string;
  nativeForegroundActive: boolean;
  nativeReadable: boolean;
  nativeHeadIndex: number; reconcileToolsAfterIndex?: number;
  promptSettlementEpoch: number;
  configurationObservation: number; modeObservation: number;
  uncertainSetters: Map<string, Operation>;
  canceling: boolean; cancellationFailed: boolean; cancellation?: Cancellation; cancelDrain?: Promise<CancellationResult>;
  nativeCounts: { agents: number; commands: number; other: number };
  environmentFingerprint: string;
  operations: Map<string, Operation>; tombstones: Map<string, Operation>; wake: Set<() => void>; receiptBytes: number;
};
const EVENT_BYTES = 32 * 1024 * 1024;
const EVENT_COUNT = 16_384;
const MAX_SESSIONS = 32;

/** Native processes and outcomes belong to this host, independently of a carrier. */
export class AntigravityHost implements AntigravityPort {
  readonly runtimeId = randomUUID();
  runtimeVersion: string | null = null;
  readonly #sessions = new Map<string, Session>();
  readonly #creating = new Map<string, Creation>();
  readonly #creationReceipts = new Map<string, { fingerprint: string; identity: AntigravityIdentity }>();
  readonly #creationOrigins = new Map<string, string>();
  readonly #attaching = new Map<string, Promise<AntigravityAttachment>>();
  readonly #ephemeral = new Set<AntigravityAcpConnection>();
  readonly #failedEphemeral = new Set<AntigravityAcpConnection>();
  readonly #released = new Set<string>();
  readonly #pendingWork = new Set<Promise<void>>();
  readonly #orphanedTransports = new Set<Awaited<ReturnType<OwnedNdjsonStdioTransportFactory["open"]>>>();
  readonly #launchControllers = new Set<AbortController>();
  #establishing = 0;
  #launchCleanupUnproven = false;
  #generation = 0;
  #revision = 0;
  #closed = false;
  #frozen = false;
  constructor(readonly input: {
    readonly configuration: AntigravityRuntimeConfiguration;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly readHistory: (identity: AntigravityIdentity, signal?: AbortSignal) => Promise<AntigravityHistory>;
    readonly removeProbe?: (identity: AntigravityIdentity) => Promise<void>;
    readonly launch?: (input: Parameters<typeof AntigravityAcpConnection.open>[0]) => Promise<AntigravityAcpConnection>;
    readonly observationWaitMs?: number;
    readonly cancellationDrainTimeoutMs?: number;
    readonly cancellationPollIntervalMs?: number;
  }) {
    const { configuration, channels } = input;
    if (configuration.executionEnvironmentId !== channels.executionEnvironmentId || configuration.tenantId !== channels.scope.tenantId ||
        configuration.principalId !== channels.scope.principalId) throw new AntigravityError("antigravity_runtime_scope_denied");
  }
  #admit(authority: AntigravityHostAuthority, signal?: AbortSignal) {
    authority.assertAdmission(); signal?.throwIfAborted();
    if (this.#closed || this.#frozen) throw new AntigravityError("antigravity_runtime_closed");
    if (this.#launchCleanupUnproven || this.#orphanedTransports.size || [...this.#sessions.values()].some(session => session.cleanupUnproven))
      throw new AntigravityError("antigravity_cleanup_unproven", "not_sent");
  }
  #current(authority: AntigravityHostAuthority, signal?: AbortSignal) { authority.assertCurrent(); signal?.throwIfAborted(); }
  #get(handleId: string): Session {
    const session = this.#sessions.get(handleId);
    if (!session) throw new AntigravityError("antigravity_session_unknown", "sent_outcome_unknown");
    return session;
  }
  #find(identity: AntigravityIdentity) { return [...this.#sessions.values()].find(session => session.identity.sessionId === identity.sessionId && session.identity.cwd === identity.cwd); }
  #beginWork() {
    let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); this.#pendingWork.add(promise);
    return () => { this.#pendingWork.delete(promise); resolve(); };
  }
  async #open(cwd: string, handlers: OpenHandlers, executionEnvironment?: Parameters<AntigravityPort["attach"]>[0]["executionEnvironment"], agentTools?: Parameters<AntigravityPort["attach"]>[0]["agentTools"]): Promise<AntigravityAcpConnection> {
    if (this.#closed || this.#frozen) throw new AntigravityError("antigravity_runtime_closed");
    const finish = this.#beginWork();
    try { return await this.#openPeer(cwd, handlers, executionEnvironment, agentTools); }
    finally { finish(); }
  }
  async #openPeer(cwd: string, handlers: OpenHandlers, executionEnvironment?: Parameters<AntigravityPort["attach"]>[0]["executionEnvironment"], agentTools?: Parameters<AntigravityPort["attach"]>[0]["agentTools"]): Promise<AntigravityAcpConnection> {
    const config = this.input.configuration;
    const baseline: Record<string, string> = {};
    for (const name of ["HOME", "USERPROFILE", "PATH", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      const value = this.input.environment[name]; if (value !== undefined) baseline[name] = value;
    }
    baseline.HOME ??= homedir(); baseline.NO_COLOR = "1"; baseline.TERM = "dumb";
    const environment = { ...mergeResolvedEnvironment(mergeResolvedEnvironment(baseline,
      await resolveEnvironmentVariables(config.startupEnvironmentVariables ?? {}, this.input.environment)),
      await resolveEnvironmentVariables(executionEnvironment ?? {}, this.input.environment)), AGY_CLI_DISABLE_AUTO_UPDATE: "1" };
    if (agentTools?.surface === "cli") {
      const tools = antigravityAgentToolsSchema.parse(agentTools);
      if (!path.isAbsolute(tools.executableDirectory)) throw new AntigravityError("antigravity_agent_tool_directory_invalid");
      Object.assign(environment, { SEDES_AGENT_TOOL_ENDPOINT: tools.endpoint, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: tools.sourceCapability,
        SEDES_AGENT_TOOL_CLI_MODE: tools.mode, PATH: [tools.executableDirectory, tools.inheritedPath].filter(Boolean).join(path.delimiter) });
    }
    const resolver = this.input.channels.resolveOwnedProcessExecutable;
    if (!resolver) throw new AntigravityError("antigravity_executable_resolution_unsupported");
    const executable = await resolver.call(this.input.channels, config, { commandName: "agy", ...(config.executablePath ? { configuredPath: config.executablePath } : {}) });
    const prepared = await this.input.channels.prepareOwnedProcess(config, { executablePath: executable.canonicalPath, workingDirectory: cwd });
    const factory = new OwnedNdjsonStdioTransportFactory({ scope: config, channels: this.input.channels,
      process: prepared, environment, commandArguments: ["acp", "--disable-telemetry", ...(config.geminiDirectory ? ["--gemini-dir", config.geminiDirectory] : [])],
      retainStderr: false, assuranceDiagnosticPrefix: "antigravity", transportDiagnosticPrefix: "antigravity_stdio" });
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#launchControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), config.initializationTimeoutMs);
    let transport: Awaited<ReturnType<typeof factory.open>> | undefined;
    try {
      if (this.#closed || this.#frozen) throw new AntigravityError("antigravity_runtime_closed");
      transport = await factory.open(config, generation, controller.signal, { launchStarted() {}, cleanupProven() {}, cleanupFailed: () => { this.#launchCleanupUnproven = true; } });
      const peer = await (this.input.launch ?? AntigravityAcpConnection.open)({ transport, scope: config, generation,
        initializationTimeoutMs: config.initializationTimeoutMs, signal: controller.signal, ...handlers });
      this.runtimeVersion = peer.initialize.agentInfo?.version ?? null;
      this.#ephemeral.add(peer);
      if (this.#closed || this.#frozen) { await this.#closeEphemeral(peer); throw new AntigravityError("antigravity_runtime_closed"); }
      return peer;
    } catch (error) {
      if (transport) try { await transport.close("antigravity_launch_failed"); }
      catch (cleanupError) { this.#orphanedTransports.add(transport); throw new AntigravityError("antigravity_cleanup_unproven", "sent_outcome_unknown", { cause: cleanupError }); }
      throw error;
    }
    finally { clearTimeout(timer); this.#launchControllers.delete(controller); }
  }
  async catalog(input: Parameters<AntigravityPort["catalog"]>[0], signal?: AbortSignal, authority = localAuthority): Promise<AntigravitySetup> {
    this.#admit(authority, signal);
    if (this.#ephemeral.size >= 4) throw new AntigravityError("antigravity_probe_capacity");
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-antigravity-catalog-"));
    let peer: AntigravityAcpConnection | undefined; let identity: AntigravityIdentity | undefined;
    try {
      peer = await this.#open(directory, { authorizeSession: () => true, update() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
      this.#ephemeral.add(peer); this.#admit(authority, signal);
      const response = await peer.create(directory); identity = { sessionId: response.sessionId, cwd: directory };
      const modelOptions: NonNullable<AntigravitySetup["modelOptions"]>[number][] = [];
      const modelSelector = categoryOption(response.configOptions, "model");
      const pristineThinking = categoryOption(response.configOptions, "thought_level");
      if (modelSelector?.type !== "select" || selectOptions(response.configOptions, "model").length === 0)
        throw new AntigravityError("antigravity_model_catalog_unavailable", "rejected");
      for (const model of selectOptions(response.configOptions, "model")) {
        this.#admit(authority, signal);
        const selected = await peer.setConfig(response.sessionId, modelSelector.id, model.value);
        const effective = categoryOption(selected.configOptions, "model");
        if (!effective || effective.type !== "select" || effective.currentValue !== model.value) throw new AntigravityError("antigravity_model_selection_unconfirmed", "rejected");
        const thinkingLevels = selectOptions(selected.configOptions, "thought_level").map(option => option.value);
        // Selecting another model may carry over the previous reasoning value.
        // Only the pristine session establishes a provider-advertised default.
        const defaultThinkingLevel = model.value === modelSelector.currentValue && pristineThinking?.type === "select" &&
          thinkingLevels.includes(pristineThinking.currentValue) ? pristineThinking.currentValue : undefined;
        modelOptions.push({ modelId: model.value, thinkingLevels, ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}) });
      }
      return { initialize: peer.initialize, session: response, modelOptions };
    } finally {
      const errors: unknown[] = [];
      let released = peer === undefined;
      if (peer) try { await this.#closeEphemeral(peer); released = true; } catch (error) { errors.push(error); }
      // A failed process close retains its workspace and ownership for Stop.
      if (released) {
        if (identity) try { await this.input.removeProbe?.(identity); } catch (error) { errors.push(error); }
        try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Antigravity catalog cleanup is incomplete.");
    }
  }
  async connect(signal?: AbortSignal, authority = localAuthority) {
    this.#admit(authority, signal);
    const cwd = await realpath(this.input.environment.HOME ?? homedir());
    const peer = await this.#open(cwd, { authorizeSession: () => false, update() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
    this.#ephemeral.add(peer);
    try { this.#current(authority, signal); return { runtimeId: this.runtimeId, version: peer.initialize.agentInfo!.version }; }
    finally { await this.#closeEphemeral(peer); }
  }
  async create(input: Parameters<AntigravityPort["create"]>[0], signal?: AbortSignal, authority = localAuthority): Promise<AntigravityIdentity> {
    this.#current(authority, signal);
    const fingerprint = digest(input);
    const acknowledged = this.#creationReceipts.get(input.operationId);
    if (acknowledged) { if (acknowledged.fingerprint !== fingerprint) throw new AntigravityError("antigravity_operation_conflict"); return acknowledged.identity; }
    const retained = this.#creating.get(input.operationId);
    if (retained) { if (retained.fingerprint !== fingerprint) throw new AntigravityError("antigravity_operation_conflict"); return retained.identity ?? retained.result; }
    this.#admit(authority, signal);
    if (this.#creating.size >= 256) throw new AntigravityError("antigravity_creation_capacity");
    if (this.#creationReceipts.size + this.#creating.size >= 4096) throw new AntigravityError("antigravity_creation_receipt_capacity");
    let resolve!: (identity: AntigravityIdentity) => void, reject!: (error: unknown) => void;
    const result = new Promise<AntigravityIdentity>((yes, no) => { resolve = yes; reject = no; });
    const receipt: Creation = { fingerprint, result, crossed: false }; this.#creating.set(input.operationId, receipt);
    void this.#establish({ cwd: input.cwd, executionEnvironment: input.executionEnvironment, agentTools: input.agentTools }, authority,
      { requested: () => { receipt.crossed = true; }, created: identity => {
        receipt.identity = identity; this.#creationOrigins.set(JSON.stringify([identity.sessionId, identity.cwd]), input.operationId);
      } })
      .then(value => resolve({ sessionId: value.sessionId, cwd: value.cwd }), error => {
        if (!receipt.crossed || (error instanceof AcpDeliveryError && error.delivery === "not_sent")) {
          this.#creating.delete(input.operationId); reject(new AntigravityError("antigravity_create_unavailable", "not_sent", { cause: error }));
        } else reject(new AntigravityError("antigravity_create_unavailable", "sent_outcome_unknown", { cause: error }));
      });
    return result;
  }
  async acknowledgeCreation(input: Parameters<AntigravityPort["acknowledgeCreation"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal);
    const receipt = this.#creating.get(input.operationId);
    const identity = receipt?.identity ?? this.#creationReceipts.get(input.operationId)?.identity;
    if (!identity || identity.sessionId !== input.sessionId || identity.cwd !== input.cwd) throw new AntigravityError("antigravity_creation_identity_mismatch");
    if (receipt) { this.#creating.delete(input.operationId); this.#creationReceipts.set(input.operationId, { fingerprint: receipt.fingerprint, identity }); }
  }
  async #establish(input: Parameters<AntigravityPort["attach"]>[0] | Omit<Parameters<AntigravityPort["attach"]>[0], "sessionId">, authority: AntigravityHostAuthority,
    creation?: { requested(): void; created(identity: AntigravityIdentity): void }): Promise<AntigravityAttachment> {
    if (this.#sessions.size + this.#establishing >= MAX_SESSIONS) throw new AntigravityError("antigravity_session_capacity");
    this.#establishing++; const finish = this.#beginWork();
    try { return await this.#establishSession(input, authority, creation); }
    finally { this.#establishing--; finish(); }
  }
  async #establishSession(input: { cwd: string; sessionId?: string; executionEnvironment?: Parameters<AntigravityPort["attach"]>[0]["executionEnvironment"]; agentTools?: Parameters<AntigravityPort["attach"]>[0]["agentTools"] }, authority: AntigravityHostAuthority,
    creation?: { requested(): void; created(identity: AntigravityIdentity): void }): Promise<AntigravityAttachment> {
    const cwd = await realpath(input.cwd);
    if (cwd !== input.cwd) throw new AntigravityError("antigravity_workspace_not_canonical");
    let session: Session | undefined;
    const early: SessionNotification[] = [];
    let earlyBytes = 0;
    const peer = await this.#open(cwd, {
      authorizeSession: id => input.sessionId ? id === input.sessionId : !session || id === session.identity.sessionId,
      update: notification => {
        if (session) this.#update(session, notification);
        else {
          earlyBytes += Buffer.byteLength(JSON.stringify(notification));
          if (early.length >= EVENT_COUNT || earlyBytes > EVENT_BYTES) throw new AntigravityError("antigravity_history_capacity");
          early.push(notification);
        }
      },
      permission: (request, signal) => session ? this.#permission(session, request, signal) : Promise.resolve({ outcome: { outcome: "cancelled" } }),
    }, input.executionEnvironment, input.agentTools);
    try {
      this.#admit(authority);
      const tools = input.agentTools ? antigravityAgentToolsSchema.parse(input.agentTools) : undefined;
      if (tools && !path.isAbsolute(tools.executableDirectory)) throw new AntigravityError("antigravity_agent_tool_directory_invalid");
      const mcpServers = tools?.surface === "native" ? [{ name: "sedes", command: path.join(tools.executableDirectory, "sedes"), args: ["mcp", "--mode", tools.mode],
        env: [{ name: "SEDES_AGENT_TOOL_ENDPOINT", value: tools.endpoint }, { name: "SEDES_AGENT_TOOL_SOURCE_CAPABILITY", value: tools.sourceCapability },
          { name: "PATH", value: tools.inheritedPath }] }] : [];
      if (!input.sessionId) creation?.requested();
      const response = input.sessionId ? await peer.load(input.sessionId, cwd, mcpServers) : await peer.create(cwd, mcpServers);
      const sessionId = input.sessionId ?? (response as { sessionId: string }).sessionId;
      if (!input.sessionId) creation?.created({ sessionId, cwd });
      this.#admit(authority);
      if (early.some(notification => notification.sessionId !== sessionId)) throw new AntigravityError("antigravity_session_mismatch");
      session = { identity: { sessionId, cwd }, handleId: randomUUID(), generation: randomUUID(),
        setup: { initialize: peer.initialize, session: response }, peer, events: [], sequence: 0, offered: 0, acknowledged: 0,
        retainedAfter: 0, eventBytes: 0, attached: true, closed: false, cleanupUnproven: false,
        activePrompts: new Set(), tools: new Set(), permissions: new Map(), operations: new Map(), tombstones: new Map(), wake: new Set(), receiptBytes: 0, nativeActive: false, nativeUnknown: true, nativeForegroundActive: false, nativeReadable: false, nativeHeadIndex: -1, promptSettlementEpoch: 0, configurationObservation: 0, modeObservation: 0, uncertainSetters: new Map(), canceling: false, cancellationFailed: false, nativeCounts: { agents: 0, commands: 0, other: 0 },
        environmentFingerprint: digest([input.executionEnvironment ?? {}, input.agentTools ?? null]) };
      this.#sessions.set(session.handleId, session); this.#revision++;
      this.#ephemeral.delete(peer);
      // Replay updates belong to the attach baseline, never to an accepted new input.
      for (const notification of early) this.#update(session, notification);
      await this.#refreshNative(session);
      const owned = session;
      void peer.binding.closed.then(closure => {
        owned.cleanupUnproven = closure.transportCleanup === "failed" || closure.continuations === "unsettled";
        for (const permission of owned.permissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } }); owned.permissions.clear();
        if (!owned.closed) { owned.closed = true; this.#event(owned, { kind: "failure", failure: { code: "antigravity_process_closed", delivery: "sent_outcome_unknown" } }); }
      });
      return this.#attachment(session);
    } catch (error) { await this.#closeEphemeral(peer); throw error; }
  }
  async listSessions(input: Parameters<AntigravityPort["listSessions"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#admit(authority, signal);
    const peer = await this.#open(input.cwd, { authorizeSession: () => false, update() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
    this.#ephemeral.add(peer);
    try { const response = await peer.list(input.cwd, input.cursor); this.#current(authority, signal);
      return { sessions: response.sessions.map(session => ({ sessionId: session.sessionId, cwd: session.cwd,
        ...(session.title ? { title: session.title } : {}), ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}) })),
        ...(response.nextCursor ? { cursor: response.nextCursor } : {}) };
    } finally { await this.#closeEphemeral(peer); }
  }
  async readHistory(input: AntigravityIdentity, signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal);
    const session = this.#find(input), cancellationEpoch = session && !session.cancelDrain ? this.#cancellationReadEpoch(session) : undefined;
    const history = await this.input.readHistory(input, signal); this.#current(authority, signal);
    if (session) this.#applyNative(session, history, cancellationEpoch); return history;
  }
  async attach(input: Parameters<AntigravityPort["attach"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#admit(authority, signal);
    const existing = this.#find(input);
    if (existing) {
      if (existing.closed) throw new AntigravityError("antigravity_session_closed", "sent_outcome_unknown");
      if (existing.environmentFingerprint !== digest([input.executionEnvironment ?? {}, input.agentTools ?? null])) throw new AntigravityError("antigravity_execution_environment_restart_required");
      existing.attached = true; return this.#attachment(existing);
    }
    const key = JSON.stringify([input.cwd, input.sessionId]);
    let pending = this.#attaching.get(key);
    if (!pending) { pending = this.#establish(input, authority).finally(() => this.#attaching.delete(key)); this.#attaching.set(key, pending); }
    const result = await pending; this.#current(authority, signal); return result;
  }
  async attachExisting(input: AntigravityIdentity, signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#find(input); if (!session) return null;
    session.attached = true; return this.#attachment(session);
  }
  #attachment(session: Session): AntigravityAttachment {
    const createdByOperationId = this.#creationOrigins.get(JSON.stringify([session.identity.sessionId, session.identity.cwd]));
    return { ...session.identity, handleId: session.handleId, generation: session.generation, setup: session.setup,
      ...(createdByOperationId ? { createdByOperationId } : {}),
      throughSequence: session.sequence, retainedAfterSequence: session.retainedAfter, retainedOperationIds: [...session.operations.keys()],
      pendingPermissions: [...session.permissions].map(([requestId, permission]) => ({ requestId, openedAt: permission.openedAt, request: permission.request })) };
  }
  async request(input: Parameters<AntigravityPort["request"]>[0], signal?: AbortSignal, authority = localAuthority): Promise<AntigravityOutcome> {
    this.#current(authority, signal);
    const session = this.#get(input.handleId);
    const command = antigravityCommandSchema.parse(input.command); const fingerprint = digest(command);
    const existing = session.operations.get(input.operationId) ?? session.tombstones.get(input.operationId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new AntigravityError("antigravity_operation_conflict"); return existing.outcome; }
    if (command.type !== "cancel" && command.type !== "permission") this.#admit(authority, signal);
    if (command.type === "permission" && command.response.outcome.outcome === "selected") {
      const optionId = command.response.outcome.optionId;
      const option = session.permissions.get(command.requestId)?.request.options.find(option => option.optionId === optionId);
      if (option?.kind === "allow_once" || option?.kind === "allow_always") this.#admit(authority, signal);
    }
    if (session.closed) throw new AntigravityError("antigravity_session_closed", "not_sent");
    if (command.type === "prompt" || command.type === "steer") { await this.#refreshNative(session); this.#admit(authority, signal); }
    const control = command.type === "cancel" || command.type === "permission";
    if (session.operations.size >= 512 + (control ? 128 : 0)) throw new AntigravityError("antigravity_operation_capacity");
    if (session.operations.size + session.tombstones.size >= 4096 + (control ? 128 : 0)) throw new AntigravityError("antigravity_operation_receipt_capacity");
    if (session.receiptBytes >= 32 * 1024 * 1024 && command.type !== "cancel" && command.type !== "permission") throw new AntigravityError("antigravity_operation_receipt_capacity");
    if ((command.type === "prompt" || command.type === "steer") && !session.nativeReadable) throw new AntigravityError("antigravity_native_state_unavailable");
    if ((command.type === "prompt" || command.type === "steer" || command.type === "set_config" || command.type === "set_mode") && session.canceling) throw new AntigravityError("antigravity_cancel_in_progress");
    if (command.type === "prompt" && (session.activePrompts.size || session.permissions.size || session.nativeForegroundActive)) throw new AntigravityError("antigravity_session_busy");
    if (command.type === "steer" && ((!session.activePrompts.size && !session.nativeForegroundActive) || session.permissions.size)) throw new AntigravityError("antigravity_steering_target_unavailable");
    if (command.type === "steer" && session.activePrompts.size >= 32) throw new AntigravityError("antigravity_steering_capacity");
    if ((command.type === "set_config" || command.type === "set_mode") && (session.activePrompts.size || session.nativeForegroundActive || session.permissions.size)) throw new AntigravityError("antigravity_session_busy");
    const nativeFrontier = session.nativeHeadIndex;
    const operation: Operation = { fingerprint, outcome: { status: "pending" },
      ...(command.type === "set_config" ? { postcondition: { kind: "config" as const, id: command.configId, valueFingerprint: digest(command.value), after: session.configurationObservation } } : {}),
      ...(command.type === "set_mode" ? { postcondition: { kind: "mode" as const, valueFingerprint: digest(command.modeId), after: session.modeObservation } } : {}) };
    session.operations.set(input.operationId, operation); this.#revision++;
    if (command.type === "prompt" || command.type === "steer") session.activePrompts.add(input.operationId);
    const settle = (outcome: AntigravityOutcome) => {
      if (operation.outcome.status !== "pending") return;
      const proven = outcome.status === "failed" && outcome.failure.delivery === "sent_outcome_unknown" ? this.#setterProof(session, operation) : undefined;
      if (proven) outcome = proven;
      const encodedBytes = Buffer.byteLength(JSON.stringify(outcome));
      if (encodedBytes > 4 * 1024 * 1024 || session.receiptBytes + encodedBytes > 34 * 1024 * 1024)
        outcome = { status: "failed", failure: { code: "antigravity_operation_result_capacity", delivery: "sent_outcome_unknown" } };
      session.receiptBytes += Buffer.byteLength(JSON.stringify(outcome));
      operation.outcome = outcome;
      if (operation.postcondition && outcome.status === "failed" && outcome.failure.delivery === "sent_outcome_unknown") session.uncertainSetters.set(input.operationId, operation);
      session.activePrompts.delete(input.operationId);
      if (command.type === "prompt" || command.type === "steer") {
        session.promptSettlementEpoch++;
        session.reconcileToolsAfterIndex = Math.max(session.reconcileToolsAfterIndex ?? -1, nativeFrontier);
        void this.#refreshNative(session);
      }
      this.#event(session, { kind: "operation", operationId: input.operationId, outcome });
    };
    void (async () => {
      try {
        let result: unknown = {};
        switch (command.type) {
          case "prompt": case "steer": await session.peer.prompt(session.identity.sessionId, command.prompt, result => settle({ status: "completed", result })); return;
          case "cancel": result = await this.#cancelSession(session, input.operationId); break;
          case "set_config": {
            const response = await session.peer.setConfig(session.identity.sessionId, command.configId, command.value);
            session.setup = { ...session.setup, session: { ...session.setup.session, configOptions: response.configOptions } }; session.configurationObservation++;
            result = response; this.#reconcileSetters(session); break;
          }
          case "set_mode": {
            result = await session.peer.setMode(session.identity.sessionId, command.modeId);
            if (session.setup.session.modes) session.setup = { ...session.setup, session: { ...session.setup.session, modes: { ...session.setup.session.modes, currentModeId: command.modeId } } };
            session.modeObservation++; this.#reconcileSetters(session); break;
          }
          case "permission": {
            const permission = session.permissions.get(command.requestId);
            if (!permission) throw new AntigravityError("antigravity_permission_unknown", "rejected");
            const outcome = command.response.outcome;
            if (outcome.outcome === "selected" && !permission.request.options.some(option => option.optionId === outcome.optionId))
              throw new AntigravityError("antigravity_permission_option_invalid", "rejected");
            permission.resolve(command.response); break;
          }
        }
        settle({ status: "completed", result });
      } catch (error) { settle({ status: "failed", failure: failure(error) }); }
    })();
    return operation.outcome;
  }
  async outcome(input: Parameters<AntigravityPort["outcome"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#get(input.handleId);
    const value = session.operations.get(input.operationId) ?? session.tombstones.get(input.operationId);
    if (!value) throw new AntigravityError("antigravity_operation_unknown", "sent_outcome_unknown"); return value.outcome;
  }
  async acknowledgeOperation(input: Parameters<AntigravityPort["acknowledgeOperation"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#get(input.handleId); const operation = session.operations.get(input.operationId);
    if (!operation) { if (session.tombstones.has(input.operationId)) return; throw new AntigravityError("antigravity_operation_unknown"); }
    if (operation.outcome.status === "pending") throw new AntigravityError("antigravity_operation_pending");
    session.operations.delete(input.operationId); session.tombstones.set(input.operationId, operation);
    this.#revision++;
  }
  #update(session: Session, notification: SessionNotification) {
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      session.setup = { ...session.setup, session: { ...session.setup.session, configOptions: update.configOptions } }; session.configurationObservation++;
      this.#reconcileSetters(session);
    }
    if (update.sessionUpdate === "current_mode_update") {
      if (session.setup.session.modes) session.setup = { ...session.setup, session: { ...session.setup.session, modes: { ...session.setup.session.modes, currentModeId: update.currentModeId } } };
      session.modeObservation++; this.#reconcileSetters(session);
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (update.status === "pending" || update.status === "in_progress" || (update.sessionUpdate === "tool_call" && update.status == null)) session.tools.add(update.toolCallId);
      else if (update.status === "completed" || update.status === "failed") session.tools.delete(update.toolCallId);
    }
    this.#event(session, { kind: "update", notification });
  }
  #setterProof(session: Session, operation: Operation): AntigravityOutcome | undefined {
    const postcondition = operation.postcondition;
    if (postcondition?.kind === "config" && session.configurationObservation > postcondition.after) {
      const values = session.setup.session.configOptions?.filter(option => option.id === postcondition.id) ?? [];
      if (values.length === 1 && values[0]!.type === "select" && digest(values[0]!.currentValue) === postcondition.valueFingerprint)
        return { status: "completed", result: { configOptions: session.setup.session.configOptions } };
    }
    if (postcondition?.kind === "mode" && session.modeObservation > postcondition.after && session.setup.session.modes &&
        digest(session.setup.session.modes.currentModeId) === postcondition.valueFingerprint) return { status: "completed", result: {} };
    return undefined;
  }
  #reconcileSetters(session: Session) {
    if (session.closed) return;
    for (const [operationId, operation] of session.uncertainSetters) {
      if (operation.outcome.status !== "failed" || operation.outcome.failure.delivery !== "sent_outcome_unknown") continue;
      const outcome = this.#setterProof(session, operation); if (!outcome) continue;
      const bytes = Buffer.byteLength(JSON.stringify(outcome)), delta = bytes - Buffer.byteLength(JSON.stringify(operation.outcome));
      if (bytes > 4 * 1024 * 1024 || session.receiptBytes + delta > 34 * 1024 * 1024) continue;
      session.receiptBytes += delta; operation.outcome = outcome; session.uncertainSetters.delete(operationId); this.#event(session, { kind: "operation", operationId, outcome });
    }
  }
  #permission(session: Session, request: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse> {
    if (session.permissions.size >= 64) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = randomUUID(), openedAt = new Date().toISOString();
    return new Promise(resolve => {
      const finish = (value: RequestPermissionResponse) => {
        if (session.permissions.get(requestId)?.resolve !== finish) return;
        session.permissions.delete(requestId); signal?.removeEventListener("abort", abort);
        this.#event(session, { kind: "permission_resolved", requestId }); resolve(value);
      };
      const abort = () => finish({ outcome: { outcome: "cancelled" } });
      session.permissions.set(requestId, { request, openedAt, resolve: finish }); this.#event(session, { kind: "permission", requestId, openedAt, request });
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
  }
  #event(session: Session, payload: AntigravityEvent extends infer Event ? Event extends AntigravityEvent ? Omit<Event, "sequence"> : never : never) {
    const event = { ...payload, sequence: ++session.sequence } as AntigravityEvent;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > EVENT_BYTES) {
      // The native store remains authoritative; a gap requires a fresh baseline.
      session.events = []; session.eventBytes = 0; session.retainedAfter = event.sequence;
    } else {
      session.events.push(event); session.eventBytes += bytes;
      while (session.events.length > EVENT_COUNT || session.eventBytes > EVENT_BYTES) {
        const removed = session.events.shift()!; session.eventBytes -= Buffer.byteLength(JSON.stringify(removed)); session.retainedAfter = removed.sequence;
      }
    }
    this.#revision++; for (const wake of session.wake) wake(); session.wake.clear();
  }
  async observe(input: Parameters<AntigravityPort["observe"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#get(input.handleId);
    if (input.afterSequence > session.sequence || input.afterSequence < session.acknowledged) throw new AntigravityError("antigravity_observation_position_invalid");
    if (session.sequence === input.afterSequence && !session.closed) await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); session.wake.delete(finish); signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { finish(); reject(signal?.reason); };
      const timer = setTimeout(finish, this.input.observationWaitMs ?? 1000); session.wake.add(finish); signal?.addEventListener("abort", abort, { once: true });
    });
    this.#current(authority, signal);
    const events = session.events.filter(event => event.sequence > input.afterSequence).slice(0, 256);
    const throughSequence = events.at(-1)?.sequence ?? Math.max(input.afterSequence, session.retainedAfter);
    session.offered = Math.max(session.offered, throughSequence);
    return { events, throughSequence, retainedAfterSequence: session.retainedAfter, closed: session.closed };
  }
  async acknowledge(input: Parameters<AntigravityPort["acknowledge"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#get(input.handleId);
    if (input.throughSequence > session.offered || input.throughSequence < session.acknowledged) throw new AntigravityError("antigravity_acknowledgement_invalid");
    session.acknowledged = input.throughSequence;
    while (session.events[0] && session.events[0].sequence <= input.throughSequence) { const event = session.events.shift()!; session.eventBytes -= Buffer.byteLength(JSON.stringify(event)); }
    session.retainedAfter = Math.max(session.retainedAfter, input.throughSequence); this.#revision++;
  }
  async release(input: Parameters<AntigravityPort["release"]>[0], signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); if (this.#released.has(input.handleId)) return;
    const session = this.#get(input.handleId); session.attached = false;
    await this.#refreshNative(session);
    if (!this.#busy(session) && !session.operations.size && session.sequence === session.acknowledged) await this.#retire(session);
  }
  async retireSession(input: AntigravityIdentity, signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); const session = this.#find(input); if (!session) return "absent" as const;
    await this.#refreshNative(session);
    if (this.#busy(session)) return "busy" as const;
    if (session.sequence > session.acknowledged || session.operations.size) return "undelivered" as const;
    await this.#retire(session); return "retired" as const;
  }
  #busy(session: Session) { return Boolean(session.canceling || session.activePrompts.size || session.tools.size || session.permissions.size || session.nativeActive || session.nativeUnknown || [...session.operations.values()].some(value => value.outcome.status === "pending")); }
  #cancelSession(session: Session, operationId: string): Promise<CancellationResult> {
    const attempt = session.cancellation ??= { captured: new Set(), operations: new Set() };
    attempt.operations.add(operationId); for (const id of session.activePrompts) attempt.captured.add(id);
    if (session.cancelDrain) return session.cancelDrain;
    session.canceling = true; session.cancellationFailed = false;
    const draining = (async () => {
      const deadline = performance.now() + (this.input.cancellationDrainTimeoutMs ?? 10_000);
      let firstObservation = true;
      do {
        for (const permission of session.permissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } }); session.permissions.clear();
        // agy can start an already-admitted queued prompt after its first
        // cancellation. Keep admission fenced while cancelling the captured set.
        await session.peer.cancel(session.identity.sessionId);
        // Poll cadence bounds recursive SQLite work; elapsed quiet time never
        // supplies completion proof. No observer may unfence while this loop
        // still owns a cancel notification which could affect later input.
        const interval = this.input.cancellationPollIntervalMs ?? 500;
        await new Promise(resolve => setTimeout(resolve, firstObservation ? Math.min(100, interval) : interval)); firstObservation = false;
        await this.#refreshNative(session, true);
        if (attempt.result) return attempt.result;
      } while (performance.now() < deadline && !session.closed);
      throw new AntigravityError("antigravity_cancel_unproven", "sent_outcome_unknown");
    })().catch(error => { session.cancellationFailed = true; throw error; }).finally(() => { session.cancelDrain = undefined; });
    session.cancelDrain = draining; return draining;
  }
  #cancellationReadEpoch(session: Session): number | undefined {
    return session.cancellation && [...session.cancellation.captured].every(id => !session.activePrompts.has(id)) ? session.promptSettlementEpoch : undefined;
  }
  #completeCancellation(session: Session, epoch: number | undefined) {
    const attempt = session.cancellation;
    if (!attempt || session.closed || epoch === undefined || epoch !== session.promptSettlementEpoch ||
        [...attempt.captured].some(id => session.activePrompts.has(id)) || session.tools.size || session.permissions.size ||
        !session.nativeReadable || session.nativeActive || session.nativeUnknown || !session.nativeRevision) return;
    const result = { settledOperationIds: [...attempt.captured], nativeRevision: session.nativeRevision };
    const updates: { operationId: string; operation: Operation; outcome: AntigravityOutcome }[] = [];
    for (const operationId of attempt.captured) {
      const operation = session.operations.get(operationId) ?? session.tombstones.get(operationId);
      if (operation?.outcome.status === "completed" && (operation.outcome.result as { stopReason?: unknown } | null)?.stopReason === "cancelled")
        updates.push({ operationId, operation, outcome: { ...operation.outcome, cancelledAtNativeRevision: result.nativeRevision } });
    }
    for (const operationId of attempt.operations) {
      const operation = session.operations.get(operationId) ?? session.tombstones.get(operationId);
      if (operation && (operation.outcome.status === "pending" || operation.outcome.status === "failed" && operation.outcome.failure.delivery === "sent_outcome_unknown"))
        updates.push({ operationId, operation, outcome: { status: "completed", result } });
    }
    const delta = updates.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value.outcome)) -
      (value.operation.outcome.status === "pending" ? 0 : Buffer.byteLength(JSON.stringify(value.operation.outcome))), 0);
    if (session.receiptBytes + delta > 34 * 1024 * 1024) return;
    session.receiptBytes += delta;
    for (const update of updates) { update.operation.outcome = update.outcome; this.#event(session, { kind: "operation", operationId: update.operationId, outcome: update.outcome }); }
    attempt.result = result; session.cancellation = undefined; session.canceling = false; session.cancellationFailed = false; this.#revision++;
  }
  #applyNative(session: Session, history: AntigravityHistory, cancellationEpoch?: number) {
    const state = antigravityNativeActivity(history.native);
    if (session.nativeRevision !== history.native.revision || session.nativeUnknown !== state.unknown || session.nativeActive !== state.active) this.#revision++;
    session.nativeRevision = history.native.revision; session.nativeActive = state.active; session.nativeUnknown = state.unknown;
    session.nativeForegroundActive = state.foregroundActive; session.nativeReadable = true;
    session.nativeCounts = { agents: state.agents, commands: state.commands, other: state.other };
    session.nativeHeadIndex = history.native.steps.at(-1)?.index ?? -1;
    for (const step of history.native.steps) if (step.tool && [3, 4, 5, 6, 7, 12].includes(step.status)) session.tools.delete(step.tool.id);
    if (!session.activePrompts.size && !state.active && !state.unknown && session.reconcileToolsAfterIndex !== undefined &&
        history.native.steps.some(step => step.index > session.reconcileToolsAfterIndex! && step.response && antigravityNativeTerminalOutcome(step) !== undefined)) {
      session.tools.clear(); session.reconcileToolsAfterIndex = undefined;
    }
    this.#completeCancellation(session, cancellationEpoch);
  }
  async #refreshNative(session: Session, completeDrain = false) {
    const epoch = !session.cancelDrain || completeDrain ? this.#cancellationReadEpoch(session) : undefined;
    try { this.#applyNative(session, await this.input.readHistory(session.identity), epoch); }
    catch { if (!session.nativeUnknown) this.#revision++; session.nativeUnknown = true; session.nativeReadable = false; }
  }
  async #retire(session: Session) {
    try { await session.peer.close(); session.closed = true; session.cleanupUnproven = false; this.#sessions.delete(session.handleId);
      this.#released.add(session.handleId); while (this.#released.size > 4096) this.#released.delete(this.#released.values().next().value!); this.#revision++; }
    catch (error) { session.cleanupUnproven = true; throw error; }
  }
  async #closeEphemeral(peer: AntigravityAcpConnection) {
    try { await peer.close(); this.#ephemeral.delete(peer); this.#failedEphemeral.delete(peer); }
    catch (error) { this.#ephemeral.add(peer); this.#failedEphemeral.add(peer); throw error; }
  }
  detach() { for (const session of this.#sessions.values()) session.attached = false; }
  snapshot(): AntigravityInspection {
    const blockers = new Set<AntigravityInspection["blockers"][number]>();
    for (const session of this.#sessions.values()) {
      if (session.canceling || session.activePrompts.size || session.tools.size || session.nativeActive) blockers.add("active_work");
      if (session.nativeUnknown || session.cancellationFailed) blockers.add("unknown_state");
      if (session.permissions.size) blockers.add("pending_interaction");
      if (session.operations.size || session.sequence > session.acknowledged) blockers.add("unsettled_outcome");
      if (session.cleanupUnproven) blockers.add("cleanup_unproven");
    }
    if (this.#pendingWork.size || this.#ephemeral.size) blockers.add("active_work");
    if (this.#creating.size) blockers.add("unsettled_outcome");
    if (this.#failedEphemeral.size || this.#orphanedTransports.size || this.#launchCleanupUnproven) blockers.add("cleanup_unproven");
    const ownership = [...this.#sessions.values()].map(session => ({ identity: session.identity, handleId: session.handleId,
      generation: session.generation, closed: session.closed, cleanupUnproven: session.cleanupUnproven,
      activePrompts: [...session.activePrompts].sort(), nativeActive: session.nativeActive, nativeUnknown: session.nativeUnknown,
      canceling: session.canceling, cancellationFailed: session.cancellationFailed,
      permissions: [...session.permissions.keys()].sort(), pendingOutput: session.sequence > session.acknowledged,
      operations: [...session.operations].map(([id, operation]) => [id, operation.outcome.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));
    return { runtimeId: this.runtimeId, state: blockers.has("cleanup_unproven") || blockers.has("unknown_state") ? "unknown" : blockers.size ? "active" : "idle",
      revision: digest({ runtimeId: this.runtimeId, blockers: [...blockers].sort(), ownership,
        pendingWork: this.#pendingWork.size > 0, creating: [...this.#creating.keys()].sort() }), blockers: [...blockers],
      retainedSessions: [...this.#sessions.values()].map(session => ({ ...session.identity, handleId: session.handleId, generation: session.generation, closed: session.closed })) };
  }
  async inspect(signal?: AbortSignal, authority = localAuthority) {
    this.#current(authority, signal); await Promise.all([...this.#sessions.values()].map(session => this.#refreshNative(session)));
    this.#current(authority, signal); return this.snapshot();
  }
  async stop(input: Parameters<AntigravityPort["stop"]>[0], signal?: AbortSignal, authority = localAuthority,
    recordAbandonment?: (evidence: unknown) => Promise<void>) {
    this.#current(authority, signal); const before = this.snapshot();
    if (input.expectedRevision !== before.revision) throw new AntigravityError("antigravity_runtime_revision_changed");
    const wasFrozen = this.#frozen; this.#frozen = true;
    try {
      if (!input.force) {
        // Compare the operator's stable ownership revision before any refresh.
        // Fence admission while checking native work which may have started
        // independently since the last inspection, then refuse every blocker.
        await Promise.all([...this.#sessions.values()].map(session => this.#refreshNative(session)));
        this.#current(authority, signal);
        if (this.snapshot().blockers.length) throw new AntigravityError("antigravity_runtime_busy");
      }
      const record = async (phase: "before_shutdown" | "after_shutdown") => {
        try { await recordAbandonment?.({ phase, state: before.state, blockers: before.blockers,
          creationCount: this.#creating.size, creationOperationIds: [...this.#creating.keys()].slice(0, 128),
          sessions: [...this.#sessions.values()].map(session => ({ sessionId: session.identity.sessionId,
            providerState: this.#busy(session) ? "active" : "idle", liveWork: this.#busy(session),
            background: { state: session.nativeUnknown ? "unknown" : "known", ...session.nativeCounts },
            activeOperationIds: [...session.activePrompts], operationCount: session.operations.size,
            retainedOperationIds: [...session.operations.keys()].slice(0, 32), pendingInputIds: [], retainedEventCount: session.events.length })) }); }
        catch { /* Diagnostic retention cannot prevent authorized cleanup. */ }
      };
      if (input.force && before.blockers.length) await record("before_shutdown");
      for (const controller of this.#launchControllers) controller.abort(new AntigravityError("antigravity_runtime_stopping"));
      await Promise.allSettled([...this.#pendingWork, ...[...this.#ephemeral].map(peer => this.#closeEphemeral(peer))]);
      for (const session of this.#sessions.values()) {
        for (const permission of session.permissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } }); session.permissions.clear();
      }
      const cancellations = [...this.#sessions.values()].flatMap(session => session.cancelDrain ? [session.cancelDrain] : []);
      const outcomes = await Promise.allSettled([
        ...[...this.#sessions.values()].map(session => this.#retire(session)),
        ...[...this.#ephemeral].map(peer => this.#closeEphemeral(peer)),
        ...[...this.#orphanedTransports].map(async transport => { await transport.close("antigravity_stop"); this.#orphanedTransports.delete(transport); }),
      ]);
      await Promise.allSettled(cancellations);
      if (outcomes.some(outcome => outcome.status === "rejected") || this.#launchCleanupUnproven) throw new AntigravityError("antigravity_cleanup_unproven", "sent_outcome_unknown");
      if (input.force && before.blockers.length) await record("after_shutdown");
      // Unidentified crossed creations are never adopted or replayed. Explicit
      // forced retirement clears their uncertainty only after every owned
      // process has positively closed and abandonment evidence was attempted.
      this.#creating.clear(); this.#creationReceipts.clear(); this.#creationOrigins.clear();
      this.#closed = true; this.runtimeVersion = null;
    } finally { if (!this.#closed) this.#frozen = wasFrozen; }
  }
  async close() { await this.stop({ expectedRevision: this.snapshot().revision, force: true }); }
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function categoryOption(options: AntigravitySetup["session"]["configOptions"], category: string) {
  const found = options?.filter(option => option.category === category) ?? [];
  if (found.length > 1) throw new AntigravityError("antigravity_config_category_ambiguous", "rejected");
  return found[0];
}
function selectOptions(options: AntigravitySetup["session"]["configOptions"], category: string) {
  const option = categoryOption(options, category);
  return option?.type === "select" ? option.options.flatMap(entry => "value" in entry ? [entry] : entry.options) : [];
}
function failure(error: unknown): AntigravityFailure {
  if (error instanceof AntigravityError) return { code: error.code, delivery: error.delivery };
  if (error instanceof AcpDeliveryError) return { code: "antigravity_request_unavailable", delivery: error.delivery };
  if (error instanceof AcpRemoteError) return { code: "antigravity_request_rejected", delivery: "rejected" };
  return { code: "antigravity_request_unavailable", delivery: "sent_outcome_unknown" };
}
