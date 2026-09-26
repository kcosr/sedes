import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { RetainedRuntimeLifecycle } from "../retained-runtime-lifecycle.js";
import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { isAgentToolCliEndpoint } from "../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { randomBytes } from "node:crypto";
import type {
  EffortLevel,
  PermissionMode,
  SDKControlInterruptResponse,
} from "@anthropic-ai/claude-agent-sdk";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  controlHelloOperation,
  type SidecarByteStream,
  type SidecarCapabilityInventory,
} from "../../../internal/sidecar-protocol/index.js";
import type {
  EnvironmentChannelScope,
  ExecutionEnvironmentChannelProvider,
} from "../../execution/environment-channel.js";
import type {
  ManagedWorkerArtifactRegistration,
} from "../../managed-workers/artifact.js";
import type {
  ClaudeRuntimeClient,
  ClaudeRuntimeProbeInput,
  ClaudeRuntimeProbeResult,
  ClaudeRuntimeSession,
  ClaudeRuntimeSessionOptions,
  ClaudeRuntimeForkOptions,
  ClaudeRuntimeForkResult,
} from "./claude-runtime-client.js";
import { runClaudeForkLaunch } from "./claude-fork-launch.js";
import { ClaudeRuntimeWorkerClient } from "./claude-runtime-worker-client.js";
import type { ClaudeSafeSkill } from "./claude-skills.js";
import type { ClaudeSdkSessionInitialization } from "./claude-sdk-session.js";
import {
  CLAUDE_RUNTIME_CAPABILITY_ID,
  CLAUDE_RUNTIME_MAJOR_VERSION,
  claudeRuntimeCanUseToolOperation,
  claudeRuntimeHostOperations,
  claudeRuntimeWorkerOperations,
} from "./worker/claude-runtime-v1.js";
import { CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE } from "./worker/claude-outer-process-supervisor.js";

export interface ClaudeManagedRuntimeOwnerOptions {
  readonly scope: EnvironmentChannelScope;
  readonly environmentKind: "local";
  readonly artifact:
    | ManagedWorkerArtifactRegistration
    | Promise<ManagedWorkerArtifactRegistration>;
  readonly channels: ExecutionEnvironmentChannelProvider;
  readonly workingDirectory: string;
  readonly executablePath: string;
  readonly configDirectory?: string;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly initializationTimeoutMs: number;
  readonly onBackgroundError?: (error: unknown) => void;
}

/**
 * Owns one lazy Claude worker generation at a time. Ordinary proven carrier
 * loss permits a replacement; cleanup-proof loss permanently fences the owner.
 */
export class ClaudeManagedRuntimeOwner implements ClaudeRuntimeClient {
  readonly #scope: EnvironmentChannelScope;
  readonly #artifact: Promise<ManagedWorkerArtifactRegistration>;
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #workingDirectory: string;
  readonly #executablePath: string;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #configDirectory: string | undefined;
  readonly #initializationTimeoutMs: number;
  readonly #onBackgroundError: (error: unknown) => void;
  readonly #closeController = new AbortController();
  readonly #residency = new RetainedRuntimeLifecycle({
    wake: () => { this.#assertOpen(); },
    onRetirementError: error => { this.#reportUnavailable(error); this.#onBackgroundError(error); },
    retire: async () => {
      if (this.#closed) return;
      const current = this.#current;
      this.#current = undefined;
      if (current) {
        this.#retiring = this.#retire(current, "claude_last_conversation_evicted");
        await this.#retiring;
      }
      this.#releaseDirectory();
    },
  });
  #generation = 0;
  #starting: Promise<OwnedGeneration> | undefined;
  #current: OwnedGeneration | undefined;
  #retiring: Promise<void> | undefined;
  #retirementFailure: unknown;
  #availableGeneration = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #releaseDirectoryReservation: (() => void) | undefined;

  constructor(options: ClaudeManagedRuntimeOwnerOptions) {
    if (options.environmentKind !== "local") {
      throw new Error("claude_remote_execution_unsupported");
    }
    if (
      !options.scope.tenantId ||
      !options.scope.principalId ||
      !options.scope.backendInstanceId ||
      !options.scope.executionEnvironmentId ||
      options.channels.scope.tenantId !== options.scope.tenantId ||
      options.channels.scope.principalId !== options.scope.principalId ||
      options.channels.executionEnvironmentId !==
        options.scope.executionEnvironmentId ||
      !options.channels.openInstallationManagedWorker ||
      !normalizedAbsolutePath(options.workingDirectory) ||
      (options.executablePath !== "claude" &&
        !normalizedAbsolutePath(options.executablePath)) ||
      (options.configDirectory !== undefined && !normalizedAbsolutePath(options.configDirectory)) ||
      !Number.isSafeInteger(options.initializationTimeoutMs) ||
      options.initializationTimeoutMs <= 0 ||
      options.initializationTimeoutMs > 600_000
    ) {
      throw new Error("claude_managed_runtime_configuration_invalid");
    }
    this.#scope = Object.freeze({ ...options.scope });
    this.#artifact = Promise.resolve(options.artifact);
    this.#channels = options.channels;
    this.#workingDirectory = options.workingDirectory;
    this.#executablePath = options.executablePath;
    this.#configDirectory = options.configDirectory;
    this.#startupEnvironmentVariables = options.startupEnvironmentVariables ?? {};
    this.#initializationTimeoutMs = options.initializationTimeoutMs;
    this.#onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    return this.#generation === 0 && !this.#starting ? "not_started" : "started";
  }

  async probe(input: ClaudeRuntimeProbeInput): Promise<ClaudeRuntimeProbeResult> {
    this.#assertRuntimeIdentity(input);
    assertEmptyEnvironment(input.environment);
    return await this.#observe(async () => await (await this.#client()).probe(input));
  }

  createSession(options: ClaudeRuntimeSessionOptions): ClaudeRuntimeSession {
    this.#assertRuntimeIdentity(options);
    assertQueryEnvironment(options.environment);
    const lease = this.#residency.retain();
    return new DeferredManagedClaudeSession(
      async () => this.#residency.run(async () => (await this.#client()).createSession(options)),
      () => this.#reportAvailable(),
      (error) => this.#reportUnavailable(error),
      () => lease.release(true),
    );
  }

  forkSession(options: ClaudeRuntimeForkOptions): Promise<ClaudeRuntimeForkResult> {
    return runClaudeForkLaunch((session) => this.createSession(session), options);
  }

  async listSessions(
    options: Parameters<ClaudeRuntimeClient["listSessions"]>[0],
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    assertEmptyEnvironment(environment);
    return await this.#observe(
      async () => await (await this.#client()).listSessions(options),
    );
  }

  async getSessionInfo(
    sessionId: string,
    options: Parameters<ClaudeRuntimeClient["getSessionInfo"]>[1],
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    assertEmptyEnvironment(environment);
    return await this.#observe(
      async () => await (await this.#client()).getSessionInfo(sessionId, options),
    );
  }

  async getSessionMessages(
    sessionId: string,
    options: Parameters<ClaudeRuntimeClient["getSessionMessages"]>[1],
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    assertEmptyEnvironment(environment);
    return await this.#observe(
      async () =>
        await (await this.#client()).getSessionMessages(sessionId, options),
    );
  }

  async getSessionMessagesPage(
    sessionId: string,
    options: Parameters<ClaudeRuntimeClient["getSessionMessagesPage"]>[1],
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    assertEmptyEnvironment(environment);
    return await this.#observe(async () => await (await this.#client()).getSessionMessagesPage(sessionId, options));
  }

  async hasSessionTranscript(
    sessionId: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    assertEmptyEnvironment(environment);
    return await this.#observe(async () => await (await this.#client()).hasSessionTranscript(sessionId, options));
  }

  async renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    assertEmptyEnvironment(environment);
    await this.#observe(
      async () => await (await this.#client()).renameSession(sessionId, title, options),
    );
  }

  close(reason = "claude_managed_runtime_closed"): Promise<void> {
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  async #client(): Promise<ClaudeRuntimeWorkerClient> {
    this.#assertOpen();
    if (this.#current) return this.#current.client;
    await this.#retiring;
    this.#assertOpen();
    let starting = this.#starting;
    if (!starting) {
      starting = this.#startGeneration();
      this.#starting = starting;
      void starting.finally(() => {
        if (this.#starting === starting) this.#starting = undefined;
      }).catch(() => undefined);
    }
    return (await starting).client;
  }

  async #startGeneration(): Promise<OwnedGeneration> {
    let stream: SidecarByteStream | undefined;
    let peer: SidecarProtocolPeer | undefined;
    let client: ClaudeRuntimeWorkerClient | undefined;
    try {
      const artifact = await this.#artifact;
      this.#assertOpen();
      this.#releaseDirectoryReservation ??= reserveNativeDirectorySelector(this.#scope, this.#configDirectory);
      const carrierGeneration = ++this.#generation;
      const sessionNonce = randomBytes(32).toString("base64url");
      stream = await this.#channels.openInstallationManagedWorker!({
        ...this.#scope,
      }, {
        artifact,
        workingDirectory: this.#workingDirectory,
        identity: { carrierGeneration, sessionNonce },
      }, this.#closeController.signal);
      this.#assertOpen();
      const transport = new LengthPrefixedSidecarFrameTransport({
        assurance: {
          kind: "local_managed_worker_stdio",
          carrierGeneration,
        },
        stream,
      });
      const registry = new SidecarOperationRegistry();
      peer = new SidecarProtocolPeer({
        role: "sedes",
        transport,
        sessionNonce,
        registry,
      });
      client = new ClaudeRuntimeWorkerClient({
        peer,
        hostRegistry: registry,
        executablePath: this.#executablePath,
        configDirectory: this.#configDirectory,
        startupEnvironmentVariables: this.#startupEnvironmentVariables,
        initializationTimeoutMs: this.#initializationTimeoutMs,
        closed: transport.closed,
      });
      peer.start();
      const hello = await peer.call(controlHelloOperation, {
        expectedBuildId: artifact.buildId,
        expectedArtifactSha256: artifact.artifactSha256,
        authorizedSidecarCapabilities: [{
          capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
          majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
        }],
        offeredSedesCapabilities: [hostInventory()],
      }, { signal: this.#closeController.signal });
      assertExactHello(hello, artifact);
      this.#assertOpen();
      const owned: OwnedGeneration = Object.freeze({
        carrierGeneration, stream, transport, peer, client,
      });
      this.#current = owned;
      void stream.closed.then(
        (closure) =>
          this.#generationEnded(
            owned,
            managedWorkerClosureError(closure),
          ),
        (error) => this.#generationEnded(owned, error),
      );
      return owned;
    } catch (error) {
      if (isCleanupProofFailure(error)) this.#retirementFailure ??= error;
      client?.close(error);
      try { await peer?.close("claude_managed_runtime_start_failed"); }
      catch (cleanupError) {
        this.#retirementFailure ??= cleanupError;
        throw cleanupError;
      }
      try { await stream?.close("claude_managed_runtime_start_failed"); }
      catch (cleanupError) {
        this.#retirementFailure ??= cleanupError;
        throw cleanupError;
      }
      if (this.#retirementFailure === undefined) this.#releaseDirectory();
      throw error;
    }
  }

  #generationEnded(owned: OwnedGeneration, error?: unknown): void {
    if (this.#current !== owned) return;
    this.#current = undefined;
    owned.client.close(error ?? new Error("claude_managed_runtime_generation_ended"));
    if (isCleanupProofFailure(error)) this.#retirementFailure ??= error;
    if (this.#retirementFailure === undefined) this.#releaseDirectory();
    this.#reportUnavailable(error);
    if (error !== undefined) this.#onBackgroundError(error);
  }

  async #retire(owned: OwnedGeneration, reason: string): Promise<void> {
    owned.client.close(new Error(reason));
    try {
      await owned.peer.close(reason);
    } catch (error) {
      this.#retirementFailure ??= error;
      throw error;
    }
  }

  async #performClose(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error(reason));
    const current = this.#current;
    this.#current = undefined;
    if (current) this.#retiring = this.#retire(current, reason);
    const failures: unknown[] = [];
    if (this.#starting) {
      try { await this.#starting; } catch (error) {
        if (!this.#closeController.signal.aborted) failures.push(error);
      }
    }
    try { await this.#retiring; } catch (error) { failures.push(error); }
    if (this.#retirementFailure !== undefined) failures.push(this.#retirementFailure);
    if (failures.length) throw failures[0];
    this.#releaseDirectory();
  }

  #releaseDirectory(): void {
    this.#releaseDirectoryReservation?.();
    this.#releaseDirectoryReservation = undefined;
  }

  #assertRuntimeIdentity(input: {
    readonly executablePath: string;
    readonly initializationTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }): void {
    const timeout = input.initializationTimeoutMs ?? input.timeoutMs;
    if (input.executablePath !== this.#executablePath ||
        timeout !== this.#initializationTimeoutMs) {
      throw new Error("claude_managed_runtime_identity_mismatch");
    }
  }

  #assertOpen(): void {
    if (this.#retirementFailure !== undefined) {
      throw new Error("claude_managed_runtime_cleanup_unproven", {
        cause: this.#retirementFailure,
      });
    }
    if (this.#closed || this.#closeController.signal.aborted) {
      throw new Error("claude_managed_runtime_closed");
    }
  }

  async #observe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await this.#residency.run(operation);
      await this.#reportAvailable();
      return result;
    } catch (error) {
      this.#reportUnavailable(error);
      throw error;
    }
  }

  async #reportAvailable(): Promise<void> {
    if (this.#availableGeneration === this.#generation) return;
    await this.#channels.reportRuntimeAvailability(this.#scope, {
      availability: "available",
    });
    this.#availableGeneration = this.#generation;
  }

  #reportUnavailable(error: unknown): void {
    if (this.#closed) return;
    this.#availableGeneration = 0;
    void this.#channels
      .reportRuntimeAvailability(this.#scope, {
        availability: "unavailable",
        diagnosticCode: isCleanupProofFailure(error)
          ? "claude_runtime_cleanup_unproven"
          : "claude_runtime_unavailable",
      })
      .catch(this.#onBackgroundError);
  }
}

// Native default authority is resolved inside the worker. Until that path is
// known, another backend's explicit path could alias it. Keep this reservation
// on the execution host through all worker cleanup uncertainty, including main
// attachment loss for a persistent sidecar owner. All-explicit configurations
// continue to use the existing namespace admission rules.
const nativeDirectorySelectors = new Map<string, Map<symbol, boolean>>();
function reserveNativeDirectorySelector(scope: EnvironmentChannelScope, directory: string | undefined): () => void {
  const key = JSON.stringify([scope.tenantId, scope.principalId, scope.executionEnvironmentId]);
  const existing = nativeDirectorySelectors.get(key);
  const selectsDefault = directory === undefined;
  if (existing?.size && (selectsDefault || [...existing.values()].some(Boolean))) {
    throw new Error("claude_default_config_directory_conflict");
  }
  const reservations = existing ?? new Map<symbol, boolean>();
  const token = Symbol(scope.backendInstanceId);
  reservations.set(token, selectsDefault);
  nativeDirectorySelectors.set(key, reservations);
  return () => {
    reservations.delete(token);
    if (!reservations.size && nativeDirectorySelectors.get(key) === reservations) nativeDirectorySelectors.delete(key);
  };
}

interface OwnedGeneration {
  readonly carrierGeneration: number;
  readonly stream: SidecarByteStream;
  readonly transport: LengthPrefixedSidecarFrameTransport;
  readonly peer: SidecarProtocolPeer;
  readonly client: ClaudeRuntimeWorkerClient;
}

function hostInventory(): SidecarCapabilityInventory {
  return Object.freeze({
    capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
    majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
    operations: Object.freeze(claudeRuntimeHostOperations.map(({ operation }) => operation).sort()),
  });
}

function assertExactHello(
  hello: Awaited<ReturnType<SidecarProtocolPeer["call"]>>,
  artifact: ManagedWorkerArtifactRegistration,
): void {
  const value = hello as {
    readonly buildId: string;
    readonly artifactSha256: string;
    readonly sidecarCapabilities: readonly SidecarCapabilityInventory[];
    readonly sedesCapabilities: readonly SidecarCapabilityInventory[];
    readonly agentToolCli?: unknown;
  };
  const expectedWorker = claudeRuntimeWorkerOperations
    .map(({ operation }) => operation).sort();
  const worker = value.sidecarCapabilities.find((item) =>
    item.capabilityId === CLAUDE_RUNTIME_CAPABILITY_ID &&
    item.majorVersion === CLAUDE_RUNTIME_MAJOR_VERSION);
  const unexpected = value.sidecarCapabilities.filter((item) =>
    item.capabilityId !== "control" && item !== worker);
  if (value.buildId !== artifact.buildId ||
      value.artifactSha256 !== artifact.artifactSha256 ||
      value.agentToolCli !== undefined || !worker || unexpected.length ||
      JSON.stringify([...worker.operations].sort()) !== JSON.stringify(expectedWorker) ||
      JSON.stringify(value.sedesCapabilities) !== JSON.stringify([hostInventory()])) {
    throw new Error("claude_managed_runtime_capability_mismatch");
  }
}

class DeferredManagedClaudeSession implements ClaudeRuntimeSession {
  readonly #create: () => Promise<ClaudeRuntimeSession>;
  readonly #onReady: () => void | Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  #delegate: ClaudeRuntimeSession | undefined;
  #starting: Promise<ClaudeRuntimeSession> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #release: () => Promise<void>;
  constructor(
    create: () => Promise<ClaudeRuntimeSession>,
    onReady: () => void | Promise<void>,
    onFailure: (error: unknown) => void,
    release: () => Promise<void>,
  ) {
    this.#create = create;
    this.#onReady = onReady;
    this.#onFailure = onFailure;
    this.#release = release;
  }
  get closed(): boolean { return this.#closed || this.#delegate?.closed === true; }
  get initialization(): ClaudeSdkSessionInitialization | undefined { return this.#delegate?.initialization; }
  get startupProbeUuid(): string | undefined { return this.#delegate?.startupProbeUuid; }
  get safeSkills(): readonly ClaudeSafeSkill[] { return this.#delegate?.safeSkills ?? []; }
  async start(): Promise<ClaudeSdkSessionInitialization> {
    if (this.#closed) throw new Error("claude_runtime_session_closed");
    this.#starting ??= this.#create().then((session) => {
      this.#delegate = session;
      if (this.#closed) throw new Error("claude_runtime_session_closed");
      return session;
    });
    try {
      const initialization = await (await this.#starting).start();
      await this.#onReady();
      return initialization;
    } catch (error) {
      this.#onFailure(error);
      throw error;
    }
  }
  send(input: Parameters<ClaudeRuntimeSession["send"]>[0]): void | Promise<void> { return this.#ready().send(input); }
  interrupt(): Promise<SDKControlInterruptResponse | undefined> { return this.#ready().interrupt(); }
  cancelQueuedInput(operationId: string): Promise<boolean> { return this.#ready().cancelQueuedInput(operationId); }
  setModel(model?: string): Promise<void> { return this.#ready().setModel(model); }
  setEffort(effort?: EffortLevel): Promise<void> { return this.#ready().setEffort(effort); }
  setPermissionMode(mode: PermissionMode): Promise<void> { return this.#ready().setPermissionMode(mode); }
  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }
  async #performClose(): Promise<void> {
    this.#closed = true;
    await this.#starting?.catch(() => undefined);
    await this.#delegate?.close();
    await this.#release();
  }
  #ready(): ClaudeRuntimeSession {
    if (this.#closed || !this.#delegate?.initialization) {
      throw new Error("claude_runtime_session_not_ready");
    }
    return this.#delegate;
  }
}

function assertEmptyEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): void {
  if (Object.entries(input).some(([, value]) => value !== undefined)) {
    throw new Error("claude_managed_runtime_environment_invalid");
  }
}

function assertQueryEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): void {
  const value = Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] =>
      entry[1] !== undefined),
  );
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return;
  let endpointValid = false;
  try {
    const endpoint = new URL(value.SEDES_AGENT_TOOL_ENDPOINT ?? "");
    const loopbackHttp = endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" && endpoint.port.length > 0 &&
      endpoint.pathname === "/" && !endpoint.search && !endpoint.hash &&
      !endpoint.username && !endpoint.password &&
      endpoint.origin === value.SEDES_AGENT_TOOL_ENDPOINT;
    endpointValid = loopbackHttp || isAgentToolCliEndpoint(value.SEDES_AGENT_TOOL_ENDPOINT!);
  } catch {
    endpointValid = false;
  }
  if (JSON.stringify(keys) !== JSON.stringify([
    "PATH", "SEDES_AGENT_TOOL_CLI_MODE", "SEDES_AGENT_TOOL_ENDPOINT",
    "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
  ]) || !endpointValid ||
      (value.SEDES_AGENT_TOOL_CLI_MODE !== "progressive" &&
        value.SEDES_AGENT_TOOL_CLI_MODE !== "individual") ||
      !/^[A-Za-z0-9_-]{32,256}$/u.test(value.SEDES_AGENT_TOOL_SOURCE_CAPABILITY!) ||
      value.PATH!.length > 16_384 || /[\u0000\r\n]/u.test(value.PATH!)) {
    throw new Error("claude_managed_runtime_environment_invalid");
  }
}

function isCleanupProofFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const diagnostic = "diagnosticCode" in error ? error.diagnosticCode : undefined;
  return diagnostic === "managed_worker_cleanup_failed" ||
    diagnostic === "sidecar_transport_cleanup_failed";
}

function managedWorkerClosureError(
  closure: Awaited<SidecarByteStream["closed"]>,
): Error | undefined {
  if (
    closure.reason === "exit" &&
    closure.exitCode === 0 &&
    closure.signal === null &&
    closure.cause === undefined
  ) {
    return undefined;
  }
  if (
    closure.reason === "exit" &&
    closure.exitCode === CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE &&
    closure.signal === null &&
    closure.cause === undefined
  ) {
    return new Error("claude_managed_runtime_generation_failed_cleanup_proven");
  }
  const error = new Error(
    "managed_worker_local_cleanup_unproven",
    { cause: closure.cause },
  ) as Error & { diagnosticCode: string };
  error.diagnosticCode = "managed_worker_cleanup_failed";
  return error;
}
