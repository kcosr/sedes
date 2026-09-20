import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  SidecarTransportCleanupError,
  agentToolsV3Operations,
  controlGoAwayOperation,
  controlHelloOperation,
  controlPingOperation,
  validateSidecarHelloCapabilityEvidence,
  sidecarAgentToolCliMetadataSchema,
  composerAttachmentsV1Operations,
  directoryBrowserV1Operations,
  interactiveTerminalV2Operations,
  workspaceFilesInvalidatedEventSchema,
  workspaceFilesWatchFailedEventSchema,
  workspaceFilesV7Operations,
  workspaceFilesDownloadTerminalSchema,
  workspaceToolsShellTerminalSchema,
  workspaceContextV1Operations,
  workspaceSkillsV1Operations,
  workspaceToolsV2Operations,
  workspaceToolsShellV2Operations,
  type SidecarAgentToolCliMetadata,
  type SidecarByteStream,
  type SidecarCapabilityInventory,
  type SidecarOperationDefinition,
  type SidecarStreamDataRecord,
  type WorkspaceToolsShellTerminal,
  type WorkspaceFilesDownloadTerminal,
  type SidecarTransportClosure,
} from "../../internal/sidecar-protocol/index.js";
import type { SidecarArtifactRegistration } from "./sidecar-artifact.js";
import type { SidecarArtifactInstallation } from "./sidecar-provisioner.js";
import {
  SidecarSessionCleanupError,
  type SidecarAuthorizedCapability,
  type SidecarRuntimeSession,
  type SidecarRuntimeCapability,
} from "./sidecar-runtime.js";
import { SidecarRuntimeChannel } from "./runtime-channel.js";
import { sidecarRuntimeBodyOffer } from "./runtime-body-channel.js";
import { attachmentDiagnostic } from "../diagnostics/attachment-diagnostics.js";
import { deliveryDiagnosticsEnabled } from "../diagnostics/delivery-diagnostic-output.js";

const HEARTBEAT_INTERVAL_MILLISECONDS = 10_000;
const MAXIMUM_EARLY_WATCH_EVENTS = 256;

export class SidecarClientSession implements SidecarRuntimeSession {
  /** Remote account identity established by the admitted artifact installation. */
  readonly accountHome: string;
  readonly closed: Promise<SidecarTransportClosure>;
  readonly agentToolCli: SidecarAgentToolCliMetadata | undefined;
  readonly runtimeChannel: SidecarRuntimeChannel;
  readonly negotiatedCapabilities: readonly SidecarCapabilityInventory[];
  readonly #peer: SidecarProtocolPeer;
  readonly #transport: LengthPrefixedSidecarFrameTransport;
  readonly #invalidationListeners = new Map<string, () => void>();
  readonly #watchFailureListeners = new Map<
    string,
    (event: { readonly subscriptionHandle: string }) => void
  >();
  readonly #earlyInvalidations = new Set<string>();
  readonly #earlyWatchFailures = new Set<string>();
  readonly #removeEventListeners: readonly (() => void)[];
  readonly #heartbeatIntervalMilliseconds: number;
  readonly #diagnosticContext: { attachmentId: string; executionEnvironmentId?: string; transportKind: string; carrierGeneration: number };
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #heartbeatRunning = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(input: {
    readonly accountHome: string;
    readonly peer: SidecarProtocolPeer;
    readonly transport: LengthPrefixedSidecarFrameTransport;
    readonly heartbeatIntervalMilliseconds: number;
    readonly agentToolCli?: SidecarAgentToolCliMetadata;
    readonly runtimeChannel: SidecarRuntimeChannel;
    readonly negotiatedCapabilities: readonly SidecarCapabilityInventory[];
    readonly diagnosticContext: { attachmentId: string; executionEnvironmentId?: string; transportKind: string; carrierGeneration: number };
    }) {
    this.#peer = input.peer;
    this.#diagnosticContext = input.diagnosticContext;
    this.accountHome = input.accountHome;
    this.#transport = input.transport;
    this.agentToolCli = input.agentToolCli;
    this.runtimeChannel = input.runtimeChannel;
    this.negotiatedCapabilities = Object.freeze(input.negotiatedCapabilities.map(capability => Object.freeze({ ...capability, operations: Object.freeze([...capability.operations]) })));
    this.#heartbeatIntervalMilliseconds = input.heartbeatIntervalMilliseconds;
    this.closed = input.transport.closed.catch((error: unknown) => {
      if (error instanceof SidecarTransportCleanupError) {
        throw new SidecarSessionCleanupError({ cause: error });
      }
      throw error;
    });
    this.#removeEventListeners = Object.freeze([
      input.peer.onEvent({
        capabilityId: "workspace_files",
        majorVersion: 7,
        event: "files.invalidated",
        schema: workspaceFilesInvalidatedEventSchema,
        listener: ({ subscriptionHandle }) => {
          const listener = this.#invalidationListeners.get(subscriptionHandle);
          if (listener) listener();
          else
            this.#retainEarlyWatchEvent(
              this.#earlyInvalidations,
              subscriptionHandle,
            );
        },
      }),
      input.peer.onEvent({
        capabilityId: "workspace_files",
        majorVersion: 7,
        event: "files.watch_failed",
        schema: workspaceFilesWatchFailedEventSchema,
        listener: (event) => {
          const listener = this.#watchFailureListeners.get(
            event.subscriptionHandle,
          );
          if (listener) {
            this.#watchFailureListeners.delete(event.subscriptionHandle);
            listener(event);
          } else {
            this.#retainEarlyWatchEvent(
              this.#earlyWatchFailures,
              event.subscriptionHandle,
            );
          }
        },
      }),
    ]);
    void this.closed.then(
      closure => { this.#diagnose("sidecar_frame_closed", closure.reason, closure.cause); this.#settled(); },
      error => { this.#diagnose("sidecar_frame_close_failed", undefined, error); this.#settled(); },
    );
    this.#scheduleHeartbeat();
  }

  static async start(input: {
    readonly stream: SidecarByteStream;
    readonly transportKind: string;
    readonly carrierGeneration: number;
    readonly executionEnvironmentId?: string;
    readonly sessionNonce: string;
    readonly artifact: Pick<SidecarArtifactRegistration, "buildId" | "artifactSha256">;
    readonly installation: SidecarArtifactInstallation;
    readonly signal: AbortSignal;
    readonly authorizedCapabilities: readonly SidecarAuthorizedCapability[];
    readonly authorizedRuntimeCapabilities: readonly SidecarRuntimeCapability[];
      readonly sedesOperations: SidecarOperationRegistry;
    readonly heartbeatIntervalMilliseconds?: number;
  }): Promise<SidecarClientSession> {
    // A local observation ID, never the authenticated wire session nonce.
    const diagnosticContext = { attachmentId: randomUUID(), executionEnvironmentId: input.executionEnvironmentId,
      transportKind: input.transportKind, carrierGeneration: input.carrierGeneration };
    void input.stream.closed.then(
      closure => attachmentDiagnostic("sidecar_byte_stream_closed", { ...diagnosticContext, reason: closure.reason,
        exitCode: closure.exitCode, signal: closure.signal }, closure.cause),
      error => attachmentDiagnostic("sidecar_byte_stream_close_failed", diagnosticContext, error),
    );
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: {
        kind: input.transportKind,
        carrierGeneration: input.carrierGeneration,
      },
      stream: input.stream,
    });
    const registry = input.sedesOperations.fork();
    const peer = new SidecarProtocolPeer({
      role: "sedes",
      transport,
      sessionNonce: input.sessionNonce,
      registry,
      diagnosticsEnabled: deliveryDiagnosticsEnabled,
      onDiagnostic: (record, error) => attachmentDiagnostic("sidecar_heartbeat_trace", {
        ...diagnosticContext, ...record,
      }, error),
    });
    const runtimeChannel = new SidecarRuntimeChannel(peer, registry);
    void transport.closed.then(() => runtimeChannel.close(), () => runtimeChannel.close());
    peer.start();
    try {
      const authorizedCapabilities = validateAuthorizedCapabilities(
        input.authorizedCapabilities,
      );
      const agentToolCliAuthorized = authorizedCapabilities.some(
        ({ capabilityId }) => capabilityId === "agent_tools_cli",
      );
      const offeredSedesCapabilities = validateSedesCapabilities(
        registry.capabilities(),
        agentToolCliAuthorized,
        input.authorizedRuntimeCapabilities.length > 0,
      );
      const runtimeCapabilities: readonly SidecarCapabilityInventory[] = input.authorizedRuntimeCapabilities.length === 0 ? [] : [
        ...input.authorizedRuntimeCapabilities,
        { capabilityId: sidecarRuntimeBodyOffer.capabilityId, majorVersion: sidecarRuntimeBodyOffer.majorVersion, operations: [sidecarRuntimeBodyOffer.operation] },
      ];
      const hello = await peer.call(
        controlHelloOperation,
        {
          expectedBuildId: input.artifact.buildId,
          expectedArtifactSha256: input.artifact.artifactSha256,
          authorizedSidecarCapabilities: [...authorizedCapabilities.filter(
            ({ capabilityId }) => capabilityId !== "agent_tools_cli",
          ), ...runtimeCapabilities.map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }))],
          offeredSedesCapabilities: [...offeredSedesCapabilities],
        },
        { signal: input.signal },
      );
      if (
        hello.buildId !== input.artifact.buildId ||
        hello.artifactSha256 !== input.artifact.artifactSha256
      ) {
        throw new Error("sidecar_capability_mismatch");
      }
      validateSidecarHelloCapabilityEvidence(
        hello,
        authorizedCapabilities.filter(
          ({ capabilityId }) => capabilityId !== "agent_tools_cli",
        ),
      );
      for (const authorized of authorizedCapabilities) {
        if (authorized.capabilityId === "agent_tools_cli") continue;
        const actual = hello.sidecarCapabilities.find(
          (capability) =>
            capability.capabilityId === authorized.capabilityId &&
            capability.majorVersion === authorized.majorVersion,
        );
        // A grant is a ceiling. Native PTY support can be unavailable on an
        // otherwise useful host; every advertised inventory remains exact.
        if (!actual && authorized.capabilityId === "interactive_terminal") continue;
        const definitions =
          authorized.capabilityId === "directory_browser"
            ? directoryBrowserV1Operations
            : authorized.capabilityId === "interactive_terminal"
              ? interactiveTerminalV2Operations
              : authorized.capabilityId === "workspace_files"
                ? workspaceFilesV7Operations
                : authorized.capabilityId === "workspace_tools"
                  ? [
                      ...workspaceToolsV2Operations,
                      ...workspaceToolsShellV2Operations,
                    ]
                  : authorized.capabilityId === "workspace_context"
                    ? workspaceContextV1Operations
                    : authorized.capabilityId === "workspace_skills"
                      ? workspaceSkillsV1Operations
                      : composerAttachmentsV1Operations;
        const expected = definitions.map(({ operation }) => operation).sort();
        if (
          !actual ||
          JSON.stringify([...actual.operations].sort()) !==
            JSON.stringify(expected)
        ) {
          throw new Error("sidecar_capability_mismatch");
        }
      }
      const unexpected = hello.sidecarCapabilities.filter(
        (capability) =>
          capability.capabilityId !== "control" &&
          ![...authorizedCapabilities, ...runtimeCapabilities].some(
            (authorized) =>
              authorized.capabilityId === capability.capabilityId &&
              authorized.majorVersion === capability.majorVersion,
          ),
      );
      if (unexpected.length > 0) {
        throw new Error("sidecar_capability_mismatch");
      }
      for (const expected of runtimeCapabilities) {
        const actual = hello.sidecarCapabilities.find((capability) => capability.capabilityId === expected.capabilityId && capability.majorVersion === expected.majorVersion);
        if (!actual && (expected.capabilityId === "codex_managed_tui" || expected.capabilityId === "claude_persistent_runtime")) continue;
        if (!actual || JSON.stringify([...actual.operations].sort()) !== JSON.stringify([...expected.operations].sort())) throw new Error("sidecar_runtime_capability_mismatch");
      }
      if (
        JSON.stringify(hello.sedesCapabilities) !==
        JSON.stringify(offeredSedesCapabilities)
      ) {
        throw new Error("sidecar_capability_mismatch");
      }
      const agentToolCli = validateAgentToolCliMetadata(
        hello.agentToolCli,
        agentToolCliAuthorized,
        input.installation,
      );
      const heartbeatIntervalMilliseconds =
        input.heartbeatIntervalMilliseconds ?? HEARTBEAT_INTERVAL_MILLISECONDS;
      if (
        !Number.isSafeInteger(heartbeatIntervalMilliseconds) ||
        heartbeatIntervalMilliseconds <= 0
      ) {
        throw new Error("sidecar_heartbeat_interval_invalid");
      }
      return new SidecarClientSession({
        diagnosticContext,
        accountHome: input.installation.accountHome,
        peer,
        transport,
        runtimeChannel,
        negotiatedCapabilities: hello.sidecarCapabilities,
        heartbeatIntervalMilliseconds,
        ...(agentToolCli ? { agentToolCli } : {}),
      });
    } catch (error) {
      attachmentDiagnostic("sidecar_handshake_failed", diagnosticContext, error);
      await peer.close("sidecar_hello_failed").catch(() => undefined);
      throw error;
    }
  }

  call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    options?: {
      readonly signal?: AbortSignal;
      readonly deadlineMilliseconds?: number;
    },
  ): Promise<Response> {
    return this.#peer.call(definition, request, options);
  }

  registerIncomingShellStream(input: {
    readonly streamId: string;
    readonly initialCreditBytes: number;
    readonly onData: (record: SidecarStreamDataRecord) => void;
    readonly onTerminal: (terminal: WorkspaceToolsShellTerminal) => void;
  }) {
    return this.#peer.registerIncomingStream({
      streamId: input.streamId,
      capabilityId: "workspace_tools",
      majorVersion: 2,
      initialCreditBytes: input.initialCreditBytes,
      terminalSchema: workspaceToolsShellTerminalSchema,
      onData: input.onData,
      onTerminal: input.onTerminal,
    });
  }

  registerIncomingWorkspaceFileDownload(input: {
    readonly streamId: string;
    readonly initialCreditBytes: number;
    readonly onData: (record: SidecarStreamDataRecord) => void;
    readonly onTerminal: (terminal: WorkspaceFilesDownloadTerminal) => void;
  }) {
    return this.#peer.registerIncomingStream({
      streamId: input.streamId,
      capabilityId: "workspace_files",
      majorVersion: 7,
      initialCreditBytes: input.initialCreditBytes,
      terminalSchema: workspaceFilesDownloadTerminalSchema,
      onData: input.onData,
      onTerminal: input.onTerminal,
    });
  }

  registerInvalidation(
    subscriptionHandle: string,
    listener: () => void,
  ): () => void {
    if (this.#invalidationListeners.has(subscriptionHandle)) {
      throw new Error("sidecar_watch_registration_duplicate");
    }
    this.#invalidationListeners.set(subscriptionHandle, listener);
    if (this.#earlyInvalidations.delete(subscriptionHandle)) {
      queueMicrotask(() => {
        if (this.#invalidationListeners.get(subscriptionHandle) === listener) {
          listener();
        }
      });
    }
    return () => this.#invalidationListeners.delete(subscriptionHandle);
  }

  registerWatchFailure(
    subscriptionHandle: string,
    listener: (event: { readonly subscriptionHandle: string }) => void,
  ): () => void {
    if (this.#watchFailureListeners.has(subscriptionHandle)) {
      throw new Error("sidecar_watch_failure_registration_duplicate");
    }
    if (this.#earlyWatchFailures.delete(subscriptionHandle)) {
      queueMicrotask(() => listener(Object.freeze({ subscriptionHandle })));
      return () => undefined;
    }
    this.#watchFailureListeners.set(subscriptionHandle, listener);
    return () => this.#watchFailureListeners.delete(subscriptionHandle);
  }

  close(reason: string): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#diagnose("sidecar_close_requested", reason);
    this.#closed = true;
    this.#clearHeartbeat();
    this.#closePromise = this.#performClose(reason);
    return this.#closePromise;
  }

  async #performClose(reason: string): Promise<void> {
    await this.#peer
      .call(controlGoAwayOperation, { reason: boundedReason(reason) })
      .catch(() => undefined);
    try {
      await this.#peer.close(reason);
    } catch (error) {
      if (error instanceof SidecarTransportCleanupError) {
        throw new SidecarSessionCleanupError({ cause: error });
      }
      throw error;
    }
  }

  #scheduleHeartbeat(): void {
    if (this.#closed || this.#heartbeatTimer) return;
    const timer = setTimeout(() => {
      if (this.#heartbeatTimer !== timer) return;
      this.#heartbeatTimer = undefined;
      void this.#heartbeat();
    }, this.#heartbeatIntervalMilliseconds);
    timer.unref();
    this.#heartbeatTimer = timer;
  }

  async #heartbeat(): Promise<void> {
    if (this.#closed || this.#heartbeatRunning) return;
    const activity = this.#peer.activitySnapshot();
    if (
      activity.pendingOperationSends > 0 ||
      Date.now() - activity.lastOutboundActivityAtMilliseconds <
        this.#heartbeatIntervalMilliseconds
    ) {
      this.#scheduleHeartbeat();
      return;
    }
    this.#heartbeatRunning = true;
    const started = performance.now();
    try {
      const pingId = randomUUID();
      const response = await this.#peer.call(controlPingOperation, {
        pingId,
      });
      if (response.pingId !== pingId) {
        throw new Error("sidecar_heartbeat_mismatch");
      }
      if (performance.now() - started >= 1000) this.#diagnose("sidecar_heartbeat_slow", undefined, undefined, performance.now() - started);
      this.#scheduleHeartbeat();
    } catch (error) {
      this.#diagnose("sidecar_heartbeat_failed", undefined, error, performance.now() - started);
      await this.close("sidecar_heartbeat_failed").catch(() => undefined);
    } finally {
      this.#heartbeatRunning = false;
    }
  }

  #settled(): void {
    this.#closed = true;
    this.#clearHeartbeat();
    for (const remove of this.#removeEventListeners) remove();
    this.#invalidationListeners.clear();
    this.#watchFailureListeners.clear();
    this.#earlyInvalidations.clear();
    this.#earlyWatchFailures.clear();
  }

  #diagnose(event: string, reason?: string, error?: unknown, durationMs?: number): void {
    if (!process.env.SEDES_DEBUG_DELIVERY) return;
    try {
      const activity = this.#peer.activitySnapshot();
      attachmentDiagnostic(event, { ...this.#diagnosticContext, reason, durationMs,
        requestedClose: this.#closed, pendingOperationRequests: activity.pendingOperationRequests,
        pendingOperationSends: activity.pendingOperationSends,
        inboundIdleMs: Math.max(0, Date.now() - activity.lastInboundActivityAtMilliseconds),
        outboundIdleMs: Math.max(0, Date.now() - activity.lastOutboundActivityAtMilliseconds),
      }, error);
    } catch { /* Observations cannot change transport cleanup or heartbeat behavior. */ }
  }

  #retainEarlyWatchEvent(
    handles: Set<string>,
    subscriptionHandle: string,
  ): void {
    handles.add(subscriptionHandle);
    if (handles.size <= MAXIMUM_EARLY_WATCH_EVENTS) return;
    void this.close("sidecar_early_watch_event_limit").catch(() => undefined);
  }

  #clearHeartbeat(): void {
    if (!this.#heartbeatTimer) return;
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return normalized.length > 0
    ? normalized.slice(0, 120)
    : "sidecar_client_closed";
}

function validateAuthorizedCapabilities(
  capabilities: readonly SidecarAuthorizedCapability[],
) {
  const order = [
    "directory_browser",
    "workspace_files",
    "workspace_tools",
    "workspace_context",
    "workspace_skills",
    "composer_attachments",
    "agent_tools_cli",
    "interactive_terminal",
  ] as const;
  if (
    capabilities.length > order.length ||
    capabilities.some(
      (capability, index) =>
        capability.majorVersion !==
          (capability.capabilityId === "workspace_files"
            ? 7
            : capability.capabilityId === "workspace_tools"
              ? 2
            : capability.capabilityId === "agent_tools_cli"
              ? 3
              : capability.capabilityId === "interactive_terminal" ? 2 : 1) ||
        capability.capabilityId !==
          order.filter((id) =>
            capabilities.some((candidate) => candidate.capabilityId === id),
          )[index],
    ) ||
    capabilities.some(
      ({ capabilityId }) => capabilityId === "workspace_tools",
    ) !==
      capabilities.some(
        ({ capabilityId }) => capabilityId === "workspace_context",
      )
  ) {
    throw new Error("sidecar_authorized_capabilities_invalid");
  }
  return Object.freeze(
    capabilities.map((capability) => Object.freeze({ ...capability })),
  );
}

function validateSedesCapabilities(
  capabilities: readonly SidecarCapabilityInventory[],
  agentToolCliAuthorized: boolean,
  runtimeAuthorized: boolean,
): readonly SidecarCapabilityInventory[] {
  const expectedOperations = agentToolsV3Operations
    .map(({ operation }) => operation)
    .sort();
  const selected = capabilities.filter((capability) => capability.capabilityId !== "runtime_bodies" || runtimeAuthorized);
  const valid =
    selected.length === (agentToolCliAuthorized ? 1 : 0) + (runtimeAuthorized ? 1 : 0) &&
    selected.every(
      ({ capabilityId, majorVersion, operations }) =>
        capabilityId === "runtime_bodies" ? runtimeAuthorized && majorVersion === 1 && JSON.stringify(operations) === JSON.stringify([sidecarRuntimeBodyOffer.operation]) :
        capabilityId === "agent_tools_cli" && agentToolCliAuthorized &&
        majorVersion === 3 &&
        JSON.stringify([...operations].sort()) ===
          JSON.stringify(expectedOperations),
    );
  if (!valid) throw new Error("sidecar_sedes_capabilities_invalid");
  return Object.freeze(
    selected.map((capability) =>
      Object.freeze({
        capabilityId: capability.capabilityId,
        majorVersion: capability.majorVersion,
        operations: Object.freeze([...capability.operations]),
      }),
    ),
  );
}

function validateAgentToolCliMetadata(
  metadata: SidecarAgentToolCliMetadata | undefined,
  authorized: boolean,
  installation: SidecarArtifactInstallation,
): SidecarAgentToolCliMetadata | undefined {
  if (authorized !== Boolean(metadata)) {
    throw new Error("sidecar_agent_tool_cli_metadata_invalid");
  }
  if (!metadata) return undefined;
  const parsed = sidecarAgentToolCliMetadataSchema.safeParse(metadata);
  const targetPath = metadata.endpoint.startsWith("npipe:") ? path.win32 : path.posix;
  const directory = metadata.executableDirectory;
  if (
    !parsed.success ||
    !targetPath.isAbsolute(directory) ||
    targetPath.normalize(directory) !== directory ||
    targetPath.parse(directory).root === directory ||
    directory.endsWith(targetPath.sep) ||
    (targetPath === path.win32 && !/^[A-Za-z]:\\/u.test(directory)) ||
    (targetPath === path.posix && directory.includes("\\")) ||
    directory !== installation.executableDirectory ||
    installation.executablePath !== targetPath.join(directory, "sedes")
  ) {
    throw new Error("sidecar_agent_tool_cli_metadata_invalid");
  }
  return Object.freeze({ ...metadata });
}
