import { createAgentToolCliNamedPipeEndpoint } from "../../src/internal/agent-tool-cli-protocol/local-endpoint.js";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  LengthPrefixedSidecarFrameTransport,
  INTERACTIVE_TERMINAL_V2_EVIDENCE,
  SIDECAR_WIRE_VERSION,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  agentToolsCatalogOperation,
  agentToolsV3Operations,
  controlHelloOperation,
  terminalPrepareOperation,
  interactiveTerminalV2Operations,
  registerControlV2Operations,
  workspaceFilesListOperation,
  workspaceFilesWatchFailedEventSchema,
  workspaceFilesV7Operations,
  workspaceContextV1Operations,
  workspaceToolsShellV2Operations,
  workspaceToolsV2Operations,
  WORKSPACE_CONTEXT_V1_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_TOOLS_V2_LIMITS,
  type SidecarByteStream,
  type SidecarByteStreamClosure,
} from "../../src/internal/sidecar-protocol/index.js";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  SIDECAR_MINIMUM_NODE_VERSION,
} from "../../src/server/sidecar/sidecar-artifact.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { SidecarSessionCleanupError } from "../../src/server/sidecar/sidecar-runtime.js";

const sessionNonce = "n".repeat(48);
const artifact = Object.freeze({
  artifactId: SIDECAR_ARTIFACT_ID,
  modes: SIDECAR_ARTIFACT_MODES,
  executableDirectory: "/fixture",
  executablePath: "/fixture/sedes",
  artifactSha256: "a".repeat(64),
  artifactBytes: 1,
  buildId: "fixture-build",
  minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
  nativeAssets: [],
});
const installation = Object.freeze({
  accountHome: "/home/remote",
  nodeExecutable: "/usr/bin/node",
  envExecutable: "/usr/bin/env",
  stateRoot: "/home/remote/.local/state/sedes/sidecar",
  environment: Object.freeze({ HOME: "/home/remote", PATH: "/usr/bin:/bin" }),
  executableDirectory: "/home/remote/.local/state/sedes/bin",
  executablePath: "/home/remote/.local/state/sedes/bin/sedes",
});
const workspaceCapability = Object.freeze({
  capabilityId: "workspace_files",
  majorVersion: 7,
});
const agentToolsCapability = Object.freeze({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
});
const agentToolsInventory = Object.freeze({
  ...agentToolsCapability,
  operations: Object.freeze([
    "catalog.describe",
    "catalog.list",
    "tool.invoke",
  ]),
});
const workspaceToolsCapability = Object.freeze({
  capabilityId: "workspace_tools",
  majorVersion: 2,
});
const workspaceContextCapability = Object.freeze({
  capabilityId: "workspace_context",
  majorVersion: 1,
});
const interactiveTerminalCapability = Object.freeze({
  capabilityId: "interactive_terminal",
  majorVersion: 2,
});
const workspaceToolsEvidence = Object.freeze({
  ...workspaceToolsCapability,
  limits: WORKSPACE_TOOLS_V2_LIMITS,
  ...WORKSPACE_TOOLS_SHELL_V2_LIMITS,
});
const workspaceContextEvidence = Object.freeze({
  ...workspaceContextCapability,
  limits: WORKSPACE_CONTEXT_V1_LIMITS,
});

describe("SidecarClientSession", () => {
  it.each([false, true])("observes carrier closure without leaking wire secrets (diagnostics=%s)", async enabled => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", enabled ? "1" : "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const streams = byteStreamPair();
    const registry = new SidecarOperationRegistry();
    registerControlV2Operations(registry, { buildId: artifact.buildId, artifactSha256: artifact.artifactSha256,
      enabledSidecarCapabilities: [], enabledSedesCapabilities: [] });
    const transport = new LengthPrefixedSidecarFrameTransport({ assurance: { kind: "test_server", carrierGeneration: 1 }, stream: streams.right });
    const host = new SidecarProtocolPeer({ role: "sidecar", transport, sessionNonce, registry });
    host.start();
    try {
      const session = await SidecarClientSession.start({ stream: streams.left, transportKind: "ssh_stdio", carrierGeneration: 7,
        executionEnvironmentId: "add8e8af-7bca-4273-9274-2bb9d3a320bb", sessionNonce, artifact, installation,
        signal: new AbortController().signal, authorizedCapabilities: [], authorizedRuntimeCapabilities: [], sedesOperations: new SidecarOperationRegistry() });
      await streams.right.close("/private/secret-provider-response");
      await session.closed;
      await Promise.resolve();
      const lines = log.mock.calls.flat().map(String).filter(line => line.startsWith("[delivery-attachment] "));
      expect(lines.length > 0).toBe(enabled);
      if (enabled) {
        const records = lines.map(line => JSON.parse(line.slice("[delivery-attachment] ".length)));
        expect(records).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: "sidecar_byte_stream_closed", carrierGeneration: 7, reason: "redacted" }),
          expect.objectContaining({ event: "sidecar_frame_closed", requestedClose: false, pendingOperationRequests: 0 }),
        ]));
        expect(new Set(records.map(record => record.attachmentId)).size).toBe(1);
        expect(lines.join("\n")).not.toContain(sessionNonce);
        expect(lines.join("\n")).not.toContain("secret-provider-response");
        expect(lines.join("\n")).not.toContain(installation.accountHome);
      }
    } finally {
      await host.close("test_complete");
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("records heartbeat failure before requesting closure and isolates logger failure", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const records: Record<string, unknown>[] = [];
    const log = vi.spyOn(console, "error").mockImplementation((line: string) => {
      records.push(JSON.parse(line.slice("[delivery-attachment] ".length)));
      throw new Error("logger_failed");
    });
    const streams = byteStreamPair();
    const registry = new SidecarOperationRegistry();
    registerControlV2Operations(registry, { buildId: artifact.buildId, artifactSha256: artifact.artifactSha256,
      enabledSidecarCapabilities: [], enabledSedesCapabilities: [] });
    const transport = new LengthPrefixedSidecarFrameTransport({ assurance: { kind: "test_server", carrierGeneration: 1 }, stream: streams.right });
    const host = new SidecarProtocolPeer({ role: "sidecar", transport, sessionNonce, registry });
    host.start();
    try {
      const session = await SidecarClientSession.start({ stream: streams.left, transportKind: "ssh_stdio", carrierGeneration: 1,
        sessionNonce, artifact, installation, signal: new AbortController().signal, authorizedCapabilities: [],
        authorizedRuntimeCapabilities: [], sedesOperations: new SidecarOperationRegistry(), heartbeatIntervalMilliseconds: 10 });
      streams.right.blockWrites();
      await vi.advanceTimersByTimeAsync(10_100);
      streams.right.releaseWrite();
      await session.closed;
      const failureIndex = records.findIndex(record => record.event === "sidecar_heartbeat_failed");
      const closeIndex = records.findIndex(record => record.event === "sidecar_close_requested");
      expect(failureIndex).toBeGreaterThanOrEqual(0);
      expect(closeIndex).toBeGreaterThan(failureIndex);
      expect(records[failureIndex]).toMatchObject({ requestedClose: false });
      expect(records[closeIndex]).toMatchObject({ reason: "sidecar_heartbeat_failed" });
    } finally {
      streams.right.releaseWrite();
      await host.close("test_complete");
      log.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("negotiates exact persistent-terminal evidence and prepares a sidecar-owned PTY", async () => {
    const streams = byteStreamPair();
    const serverTransport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_server", carrierGeneration: 1 },
      stream: streams.right,
    });
    const registry = new SidecarOperationRegistry();
    const ticket = randomUUID();
    for (const definition of interactiveTerminalV2Operations) {
      registry.register(
        definition as never,
        ((request: unknown) => {
          if (definition !== terminalPrepareOperation)
            throw new Error("unexpected_terminal_operation");
          terminalPrepareOperation.requestSchema.parse(request);
          return { ticket };
        }) as never,
      );
    }
    registerControlV2Operations(registry, {
      buildId: artifact.buildId,
      artifactSha256: artifact.artifactSha256,
      enabledSidecarCapabilities: [interactiveTerminalCapability],
      enabledSedesCapabilities: [],
      capabilityEvidence: [
        {
          ...interactiveTerminalCapability,
          ...INTERACTIVE_TERMINAL_V2_EVIDENCE,
        },
      ],
    });
    const sidecar = new SidecarProtocolPeer({
      role: "sidecar",
      transport: serverTransport,
      sessionNonce,
      registry,
    });
    sidecar.start();
    const session = await SidecarClientSession.start({
      transportKind: "ssh_stdio",
      stream: streams.left,
      carrierGeneration: 1,
      sessionNonce,
      artifact,
      installation,
      signal: new AbortController().signal,
      authorizedRuntimeCapabilities: [],
      authorizedCapabilities: [interactiveTerminalCapability],
      sedesOperations: new SidecarOperationRegistry(),
    });
    expect(session.accountHome).toBe(installation.accountHome);
    await expect(
      session.call(terminalPrepareOperation, {
        terminalId: randomUUID(),
        incarnationId: randomUUID(),
        initialCwd: "/workspace",
        rows: 24,
        columns: 80,
      }),
    ).resolves.toEqual({ ticket });
    await session.close("test_complete");
    await sidecar.close("test_complete");
  });

  it.each([
    "absent_native",
    "partial_terminal",
    "partial_tui",
    "partial_claude",
    "missing_files",
    "missing_provider",
  ] as const)(
    "negotiates optional host runtimes while retaining exact required contracts: %s",
    async (variant) => {
      const streams = byteStreamPair();
      const registry = new SidecarOperationRegistry();
      for (const definition of workspaceFilesV7Operations)
        registry.register(
          definition as never,
          (() => ({ entries: [], scanTruncated: false })) as never,
        );
      const provider = {
        capabilityId: "codex_runtime",
        majorVersion: 1,
        operations: ["runtime.open"],
      };
      const tui = {
        capabilityId: "codex_managed_tui",
        majorVersion: 1,
        operations: ["tui.open"],
      };
      const claude = {
        capabilityId: "claude_persistent_runtime",
        majorVersion: 1,
        operations: ["claude.open"],
      };
      for (const capability of [
        provider,
        tui,
        claude,
        { ...claude, operations: ["claude.wrong"] },
        {
          capabilityId: "runtime_bodies",
          majorVersion: 1,
          operations: ["body.offer"],
        },
        { ...tui, operations: ["tui.wrong"] },
      ]) {
        for (const operation of capability.operations)
          registry.register(
            {
              ...workspaceFilesListOperation,
              capabilityId: capability.capabilityId,
              majorVersion: capability.majorVersion,
              operation,
            },
            () => ({ entries: [], scanTruncated: false }),
          );
      }
      registry.register(terminalPrepareOperation, () => ({
        ticket: randomUUID(),
      }));
      registry.register(controlHelloOperation, (request) => ({
        wireVersion: SIDECAR_WIRE_VERSION,
        buildId: artifact.buildId,
        artifactSha256: artifact.artifactSha256,
        runtime: { os: "linux" as const, architecture: "x64" as const },
        sidecarCapabilities: [
          ...(variant === "missing_files"
            ? []
            : [
                {
                  ...workspaceCapability,
                  operations: workspaceFilesV7Operations.map(
                    (definition) => definition.operation,
                  ),
                },
              ]),
          ...(variant === "missing_provider" ? [] : [provider]),
          {
            capabilityId: "runtime_bodies",
            majorVersion: 1,
            operations: ["body.offer"],
          },
          ...(variant === "partial_terminal"
            ? [
                {
                  ...interactiveTerminalCapability,
                  operations: [terminalPrepareOperation.operation],
                },
              ]
            : []),
          ...(variant === "partial_tui"
            ? [{ ...tui, operations: ["tui.wrong"] }]
            : []),
          ...(variant === "partial_claude"
            ? [{ ...claude, operations: ["claude.wrong"] }]
            : []),
        ],
        capabilityEvidence:
          variant === "partial_terminal"
            ? [
                {
                  ...interactiveTerminalCapability,
                  ...INTERACTIVE_TERMINAL_V2_EVIDENCE,
                },
              ]
            : [],
        sedesCapabilities: request.offeredSedesCapabilities,
      }));
      const host = new SidecarProtocolPeer({
        role: "sidecar",
        sessionNonce,
        registry,
        transport: new LengthPrefixedSidecarFrameTransport({
          assurance: { kind: "test_server", carrierGeneration: 1 },
          stream: streams.right,
        }),
      });
      host.start();
      const started = SidecarClientSession.start({
        transportKind: "outbound",
        stream: streams.left,
        carrierGeneration: 1,
        sessionNonce,
        artifact,
        installation,
        signal: new AbortController().signal,
        authorizedCapabilities: [
          workspaceCapability,
          interactiveTerminalCapability,
        ],
        authorizedRuntimeCapabilities: [provider, tui, claude],
        sedesOperations: new SidecarOperationRegistry(),
      });
      if (variant !== "absent_native") {
        await expect(started).rejects.toThrow(
          /sidecar_(?:runtime_)?capability_mismatch/u,
        );
      } else {
        const session = await started;
        expect(
          session.negotiatedCapabilities.map(
            (capability) => capability.capabilityId,
          ),
        ).toEqual(["workspace_files", "codex_runtime", "runtime_bodies"]);
        await expect(
          session.call(workspaceFilesListOperation, {
            rootHandle: randomUUID(),
            pageSize: 100,
          }),
        ).resolves.toEqual({ entries: [], scanTruncated: false });
        await session.close("test_complete");
      }
      await host.close("test_complete");
    },
  );

  it.each(["missing", "duplicate"] as const)(
    "rejects %s exact capability evidence in the hello response",
    async (variant) => {
      const streams = byteStreamPair();
      const serverTransport = new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "test_server", carrierGeneration: 1 },
        stream: streams.right,
      });
      const sidecarOperations = new SidecarOperationRegistry();
      for (const definition of [
        ...workspaceToolsV2Operations,
        ...workspaceToolsShellV2Operations,
        ...workspaceContextV1Operations,
      ]) {
        sidecarOperations.register(
          definition as never,
          (() => {
            throw new Error("unexpected_workspace_operation");
          }) as never,
        );
      }
      sidecarOperations.register(controlHelloOperation, () => ({
        wireVersion: SIDECAR_WIRE_VERSION,
        buildId: artifact.buildId,
        artifactSha256: artifact.artifactSha256,
        runtime: { os: "linux" as const, architecture: "x64" as const },
        sidecarCapabilities: sidecarOperations.capabilities(),
        capabilityEvidence:
          variant === "missing"
            ? [workspaceContextEvidence]
            : [
                workspaceToolsEvidence,
                workspaceToolsEvidence,
                workspaceContextEvidence,
              ],
        sedesCapabilities: [],
      }));
      const sidecar = new SidecarProtocolPeer({
        role: "sidecar",
        transport: serverTransport,
        sessionNonce,
        registry: sidecarOperations,
      });
      sidecar.start();

      await expect(
        SidecarClientSession.start({
          transportKind: "ssh_stdio",
          stream: streams.left,
          carrierGeneration: 1,
          sessionNonce,
          artifact,
          installation,
          signal: new AbortController().signal,
          authorizedRuntimeCapabilities: [],
          authorizedCapabilities: [
            workspaceToolsCapability,
            workspaceContextCapability,
          ],
          sedesOperations: new SidecarOperationRegistry(),
        }),
      ).rejects.toThrow("sidecar_capability_mismatch");
      await sidecar.close("test_complete");
    },
  );

  it.each(["posix", "windows", "windows_wrong_artifact"] as const)(
    "negotiates reverse agent-tool metadata for %s with exact artifact authority",
    async (variant) => {
      const windows = variant.startsWith("windows");
      const metadata = {
        endpoint: windows
          ? createAgentToolCliNamedPipeEndpoint()
          : "unix:///run/user/1000/sedes/agent-tools.sock",
        executableDirectory: windows
          ? "C:\\Sedes\\artifacts\\serving"
          : installation.executableDirectory,
        inheritedPath: windows
          ? "C:\\Windows;C:\\Tools"
          : "/usr/local/bin:/usr/bin",
      };
      const admittedInstallation = windows
        ? {
            ...installation,
            executableDirectory:
              variant === "windows_wrong_artifact"
                ? "C:\\Sedes\\artifacts\\another"
                : metadata.executableDirectory,
            executablePath: metadata.executableDirectory + "\\sedes",
          }
        : installation;
      const streams = byteStreamPair();
      const serverTransport = new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "test_server", carrierGeneration: 1 },
        stream: streams.right,
      });
      const sidecarOperations = new SidecarOperationRegistry();
      for (const definition of workspaceFilesV7Operations) {
        sidecarOperations.register(
          definition as never,
          (() => {
            throw new Error("unexpected_workspace_operation");
          }) as never,
        );
      }
      registerControlV2Operations(sidecarOperations, {
        buildId: artifact.buildId,
        artifactSha256: artifact.artifactSha256,
        enabledSidecarCapabilities: [workspaceCapability],
        enabledSedesCapabilities: [agentToolsInventory],
        prepareSedesCapabilities: () => metadata,
      });
      const sidecar = new SidecarProtocolPeer({
        role: "sidecar",
        transport: serverTransport,
        sessionNonce,
        registry: sidecarOperations,
      });
      sidecar.start();
      const sedesOperations = new SidecarOperationRegistry();
      for (const definition of agentToolsV3Operations) {
        sedesOperations.register(
          definition as never,
          ((request: unknown) => {
            if (definition === agentToolsCatalogOperation) {
              return { outcome: "ok" as const, tools: [] };
            }
            throw new Error(
              `unexpected_agent_tool_operation:${String(request)}`,
            );
          }) as never,
        );
      }

      const started = SidecarClientSession.start({
        transportKind: windows ? "outbound_websocket" : "ssh_stdio",
        stream: streams.left,
        carrierGeneration: 1,
        sessionNonce,
        artifact,
        installation: admittedInstallation,
        signal: new AbortController().signal,
        authorizedRuntimeCapabilities: [],
        authorizedCapabilities: [workspaceCapability, agentToolsCapability],
        sedesOperations,
      });

      if (variant === "windows_wrong_artifact") {
        await expect(started).rejects.toThrow(
          "sidecar_agent_tool_cli_metadata_invalid",
        );
        await sidecar.close("test_complete");
        return;
      }
      const session = await started;
      expect(session.agentToolCli).toEqual(metadata);
      await expect(
        sidecar.call(agentToolsCatalogOperation, {
          sourceCapability: "c".repeat(48),
        }),
      ).resolves.toEqual({ outcome: "ok", tools: [] });

      await session.close("test_complete");
      await sidecar.close("test_complete");
    },
  );

  it.each(["missing", "extra"] as const)(
    "rejects %s reverse agent-tool operation inventory before hello",
    async (variant) => {
      const streams = byteStreamPair();
      const sedesOperations = new SidecarOperationRegistry();
      const selected =
        variant === "missing"
          ? agentToolsV3Operations.slice(0, -1)
          : [
              ...agentToolsV3Operations,
              { ...agentToolsCatalogOperation, operation: "catalog.extra" },
            ];
      for (const definition of selected) {
        sedesOperations.register(
          definition as never,
          (() => {
            throw new Error("unexpected_reverse_operation");
          }) as never,
        );
      }

      await expect(
        SidecarClientSession.start({
          transportKind: "ssh_stdio",
          stream: streams.left,
          carrierGeneration: 1,
          sessionNonce,
          artifact,
          installation,
          signal: new AbortController().signal,
          authorizedRuntimeCapabilities: [],
          authorizedCapabilities: [workspaceCapability, agentToolsCapability],
          sedesOperations,
        }),
      ).rejects.toThrow("sidecar_sedes_capabilities_invalid");
    },
  );

  it("does not let heartbeat timeouts kill a slow in-flight operation frame", async () => {
    vi.useFakeTimers();
    try {
      const streams = byteStreamPair();
      const serverTransport = new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "test_server", carrierGeneration: 1 },
        stream: streams.right,
      });
      const registry = new SidecarOperationRegistry();
      for (const definition of workspaceFilesV7Operations) {
        registry.register(
          definition as never,
          (() => {
            if (definition.operation === "files.list") {
              return { entries: [], scanTruncated: false };
            }
            throw new Error("unexpected_workspace_operation");
          }) as never,
        );
      }
      registerControlV2Operations(registry, {
        buildId: artifact.buildId,
        artifactSha256: artifact.artifactSha256,
        enabledSidecarCapabilities: [workspaceCapability],
        enabledSedesCapabilities: [],
      });
      const host = new SidecarProtocolPeer({
        role: "sidecar",
        transport: serverTransport,
        sessionNonce,
        registry,
      });
      host.start();
      const session = await SidecarClientSession.start({
        transportKind: "ssh_stdio",
        stream: streams.left,
        carrierGeneration: 1,
        sessionNonce,
        artifact,
        installation,
        signal: new AbortController().signal,
        authorizedRuntimeCapabilities: [],
        authorizedCapabilities: [workspaceCapability],
        sedesOperations: new SidecarOperationRegistry(),
        heartbeatIntervalMilliseconds: 10,
      });
      let closed = false;
      void session.closed.then(() => {
        closed = true;
      });

      const earlyFailureHandle = randomUUID();
      await host.sendEvent({
        capabilityId: "workspace_files",
        majorVersion: 7,
        event: "files.watch_failed",
        schema: workspaceFilesWatchFailedEventSchema,
        payload: { subscriptionHandle: earlyFailureHandle },
      });
      await Promise.resolve();
      const earlyFailure = vi.fn();
      session.registerWatchFailure(earlyFailureHandle, earlyFailure);
      await Promise.resolve();
      expect(earlyFailure).toHaveBeenCalledWith({
        subscriptionHandle: earlyFailureHandle,
      });

      streams.left.blockWrites();
      const pending = session.call(workspaceFilesListOperation, {
        rootHandle: "de8e220b-0000-4000-8000-000000000001",
        pageSize: 1,
      });
      await streams.left.waitForBlockedWrite();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(closed).toBe(false);

      streams.left.releaseWrite();
      await expect(pending).resolves.toEqual({
        entries: [],
        scanTruncated: false,
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(closed).toBe(false);
      await session.close("test_complete");
      await host.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues outbound heartbeats while a sent operation is still running", async () => {
    vi.useFakeTimers();
    try {
      let finishList!: () => void;
      const listBlocked = new Promise<void>((resolve) => {
        finishList = resolve;
      });
      const streams = byteStreamPair();
      const serverTransport = new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "test_server", carrierGeneration: 1 },
        stream: streams.right,
      });
      const registry = new SidecarOperationRegistry();
      for (const definition of workspaceFilesV7Operations) {
        registry.register(
          definition as never,
          (async () => {
            if (definition.operation === "files.list") {
              await listBlocked;
              return { entries: [], scanTruncated: false };
            }
            throw new Error("unexpected_workspace_operation");
          }) as never,
        );
      }
      registerControlV2Operations(registry, {
        buildId: artifact.buildId,
        artifactSha256: artifact.artifactSha256,
        enabledSidecarCapabilities: [workspaceCapability],
        enabledSedesCapabilities: [],
      });
      const host = new SidecarProtocolPeer({
        role: "sidecar",
        transport: serverTransport,
        sessionNonce,
        registry,
      });
      host.start();
      const session = await SidecarClientSession.start({
        transportKind: "ssh_stdio",
        stream: streams.left,
        carrierGeneration: 1,
        sessionNonce,
        artifact,
        installation,
        signal: new AbortController().signal,
        authorizedRuntimeCapabilities: [],
        authorizedCapabilities: [workspaceCapability],
        sedesOperations: new SidecarOperationRegistry(),
        heartbeatIntervalMilliseconds: 10,
      });
      const pending = session.call(workspaceFilesListOperation, {
        rootHandle: "de8e220b-0000-4000-8000-000000000001",
        pageSize: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      const afterRequest =
        host.activitySnapshot().lastInboundActivityAtMilliseconds;
      await vi.advanceTimersByTimeAsync(30);
      expect(
        host.activitySnapshot().lastInboundActivityAtMilliseconds,
      ).toBeGreaterThan(afterRequest);
      finishList();
      await expect(pending).resolves.toEqual({
        entries: [],
        scanTruncated: false,
      });
      await session.close("test_complete");
      await host.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns one joinable close promise and preserves cleanup failure", async () => {
    const streams = byteStreamPair();
    const serverTransport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_server", carrierGeneration: 1 },
      stream: streams.right,
    });
    const registry = new SidecarOperationRegistry();
    for (const definition of workspaceFilesV7Operations) {
      registry.register(
        definition as never,
        (() => {
          throw new Error("unexpected_workspace_operation");
        }) as never,
      );
    }
    registerControlV2Operations(registry, {
      buildId: artifact.buildId,
      artifactSha256: artifact.artifactSha256,
      enabledSidecarCapabilities: [workspaceCapability],
      enabledSedesCapabilities: [],
    });
    const host = new SidecarProtocolPeer({
      role: "sidecar",
      transport: serverTransport,
      sessionNonce,
      registry,
    });
    host.start();
    const session = await SidecarClientSession.start({
      transportKind: "ssh_stdio",
      stream: streams.left,
      carrierGeneration: 1,
      sessionNonce,
      artifact,
      installation,
      signal: new AbortController().signal,
      authorizedRuntimeCapabilities: [],
      authorizedCapabilities: [workspaceCapability],
      sedesOperations: new SidecarOperationRegistry(),
    });
    const cleanupFailure = new Error("stream_cleanup_failed");
    const closeGate = deferred<void>();
    vi.spyOn(streams.left, "close").mockImplementation(async () => {
      await closeGate.promise;
      throw cleanupFailure;
    });

    const first = session.close("application_shutdown");
    const second = session.close("duplicate_shutdown");
    expect(second).toBe(first);
    closeGate.resolve();
    await expect(first).rejects.toMatchObject({
      name: SidecarSessionCleanupError.name,
      cause: { cause: cleanupFailure },
    });
    await expect(second).rejects.toMatchObject({
      name: SidecarSessionCleanupError.name,
      cause: { cause: cleanupFailure },
    });
    await host.close("test_complete");
  });

  it("rejects session closure when autonomous protocol cleanup loses proof", async () => {
    const streams = byteStreamPair();
    const serverTransport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_server", carrierGeneration: 1 },
      stream: streams.right,
    });
    const registry = new SidecarOperationRegistry();
    for (const definition of workspaceFilesV7Operations) {
      registry.register(
        definition as never,
        (() => {
          throw new Error("unexpected_workspace_operation");
        }) as never,
      );
    }
    registerControlV2Operations(registry, {
      buildId: artifact.buildId,
      artifactSha256: artifact.artifactSha256,
      enabledSidecarCapabilities: [workspaceCapability],
      enabledSedesCapabilities: [],
    });
    const host = new SidecarProtocolPeer({
      role: "sidecar",
      transport: serverTransport,
      sessionNonce,
      registry,
    });
    host.start();
    const session = await SidecarClientSession.start({
      transportKind: "ssh_stdio",
      stream: streams.left,
      carrierGeneration: 1,
      sessionNonce,
      artifact,
      installation,
      signal: new AbortController().signal,
      authorizedRuntimeCapabilities: [],
      authorizedCapabilities: [workspaceCapability],
      sedesOperations: new SidecarOperationRegistry(),
    });
    const cleanupFailure = new Error("autonomous_cleanup_failed");
    const close = vi
      .spyOn(streams.left, "close")
      .mockRejectedValue(cleanupFailure);

    await streams.right.write(
      Buffer.from([0x42, 0x41, 0x44, 0x21, 0, 0, 0, 1, 0x78]),
    );
    await expect(session.closed).rejects.toMatchObject({
      name: SidecarSessionCleanupError.name,
      cause: { cause: cleanupFailure },
    });
    close.mockRestore();
    await host.close("test_complete");
  });
});

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  push(value: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class MemoryByteStream implements SidecarByteStream {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<SidecarByteStreamClosure>;
  peer?: MemoryByteStream;
  readonly #queue = new AsyncByteQueue();
  readonly #resolveClosed: (closure: SidecarByteStreamClosure) => void;
  #closed = false;
  #block = false;
  #blockedResolve: (() => void) | undefined;
  #blocked: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  constructor() {
    this.bytes = this.#queue;
    let resolveClosed!: (closure: SidecarByteStreamClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  blockWrites(): void {
    this.#block = true;
    this.#blocked = new Promise((resolve) => {
      this.#blockedResolve = resolve;
    });
  }

  waitForBlockedWrite(): Promise<void> {
    return this.#blocked;
  }

  releaseWrite(): void {
    this.#block = false;
    this.#release?.();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed || !this.peer) throw new Error("memory_stream_closed");
    if (this.#block) {
      this.#blockedResolve?.();
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    this.peer.#queue.push(Uint8Array.from(bytes));
  }

  async close(reason: string): Promise<void> {
    this.#finish(reason);
    if (this.peer) this.peer.#finish(reason);
  }

  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#release?.();
    this.#queue.end();
    this.#resolveClosed({ reason });
  }
}

function byteStreamPair(): {
  readonly left: MemoryByteStream;
  readonly right: MemoryByteStream;
} {
  const left = new MemoryByteStream();
  const right = new MemoryByteStream();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
