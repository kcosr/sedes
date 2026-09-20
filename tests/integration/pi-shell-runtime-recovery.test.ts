import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidecarOperationRegistry,
  type SidecarOperationDefinition,
} from "../../src/internal/sidecar-protocol/index.js";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  SIDECAR_MINIMUM_NODE_VERSION,
} from "../../src/server/sidecar/sidecar-artifact.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import { SidecarWorkspaceToolExecutor } from "../../src/server/workspace-tools/sidecar-workspace-tool-executor.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

describe("Pi shell executor production runtime recovery wiring", () => {
  it("recovers two lost carriers, including a peer closed between polls, without starting the command again", async () => {
    const fixture = runtimeFixture();
    const chunks: string[] = [];
    const shell = await fixture.executor.startShell({
      command: "printf done", initialCreditBytes: 1024,
      timeoutMilliseconds: 10_000,
      onData: (record) => { chunks.push(Buffer.from(record.bytes).toString()); },
    });
    const settled = vi.fn();
    void shell.terminal.then(settled, settled);

    await fixture.sessions[0]!.close("connection_lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.attachExisting).toHaveBeenCalledTimes(1);
    expect(fixture.inspect).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();

    // Close after a successful running inspection. The next call reaches an
    // already closed peer, whose real call contract throws this plain Error.
    await fixture.sessions[1]!.close("connection_lost_between_polls");
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.closedPeerCalls).toHaveBeenCalledOnce();
    expect(fixture.closedPeerCalls).toHaveBeenCalledWith("shell.inspect");
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.attachExisting).toHaveBeenCalledTimes(2);
    expect(fixture.inspect).toHaveBeenCalledTimes(2);

    fixture.complete();
    await vi.advanceTimersByTimeAsync(250);
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "exited", exitCode: 0, truncated: false,
    });
    expect(chunks).toEqual(["before", "after"]);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.launch).toHaveBeenCalledOnce();
    expect(new Set(fixture.inspect.mock.calls.map(([request]) => request.streamId)))
      .toEqual(new Set([shell.streamId]));

    // The production runtime must retain the final controller until receipt
    // consumption, avoiding an extra SSH recovery attachment just to ack.
    const finalSession = fixture.sessions[2]!;
    expect(finalSession.close).not.toHaveBeenCalled();
    await shell.acknowledge();
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
    expect(fixture.attachExisting).toHaveBeenCalledTimes(2);
    expect(finalSession.close).toHaveBeenCalledWith("sidecar_recovery_detached");
    expect(fixture.owner.activeOperationLeaseCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences an active recovery poll on explicit disconnect without reconnecting or claiming command completion", async () => {
    const fixture = runtimeFixture();
    const shell = await fixture.executor.startShell({
      command: "sleep 30", initialCreditBytes: 1024,
      timeoutMilliseconds: 10_000, onData: () => undefined,
    });
    const failure = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    await fixture.sessions[0]!.close("connection_lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.inspect).toHaveBeenCalledOnce();
    await fixture.owner.disconnect();
    await vi.advanceTimersByTimeAsync(250);
    await failure;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.sessions[1]!.close)
      .toHaveBeenCalledWith("sidecar_intentionally_disconnected");
    expect(fixture.inspect).toHaveBeenCalledOnce();
    expect(fixture.attachExisting).toHaveBeenCalledOnce();
    expect(fixture.launch).toHaveBeenCalledOnce();
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    expect(fixture.owner.activeOperationLeaseCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Exercise real executor admission, automatic recovery acquisition, controller
 * ownership and explicit-disconnect fencing. Only installer transport/session
 * boundaries and retained command responses are fixtures; no SSH/provider.
 */
function runtimeFixture() {
  const registry = new PersistentSidecarServiceRegistry({
    scope: { ...scope, installationId: "installation", executionEnvironmentId: "remote" },
    configuration, buildId: "fixture", artifactSha256: "a".repeat(64), runtimeWireVersion: 7,
  });
  const installation = {
    accountHome: "/home/remote", nodeExecutable: "/usr/bin/node", envExecutable: "/usr/bin/env",
    stateRoot: "/home/remote/.local/state/sedes/sidecar", environment: { HOME: "/home/remote" },
    executableDirectory: "/fixture", executablePath: "/fixture/sedes",
  };
  let completed = false;
  const start = vi.fn(async (request: { streamId: string }) => ({
    admitted: true, streamId: request.streamId,
  }));
  const acknowledge = vi.fn(async () => ({ acknowledged: true }));
  const closedPeerCalls = vi.fn<(operation: string) => void>();
  const inspect = vi.fn(async (_request: { streamId: string }) => ({
    state: completed ? "completed" : "running",
    terminal: completed ? {
      outcome: "exited", exitCode: 0, signal: null, stdoutBytes: 11,
      stderrBytes: 0, emittedBytes: 0, omittedBytes: 0, truncated: false,
    } : null,
    stdoutBase64: Buffer.from(completed ? "beforeafter" : "before").toString("base64"),
    stderrBase64: "", previewOmittedBytes: 0,
  }));
  const sessions: ReturnType<typeof makeSession>[] = [];
  function makeSession() {
    const epoch = registry.controllerEpoch;
    let isClosed = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    return {
      accountHome: installation.accountHome, closed,
      close: vi.fn(async (_reason: string) => {
        isClosed = true;
        registry.detach(epoch);
        resolveClosed();
      }),
      registerIncomingShellStream: () => ({
        addCredit: async () => undefined, unregister: () => undefined,
      }),
      call: async (definition: SidecarOperationDefinition<unknown, unknown>, request: unknown) => {
        if (isClosed) {
          closedPeerCalls(definition.operation);
          throw new Error("sidecar_protocol_peer_closed");
        }
        definition.requestSchema.parse(request);
        let response: unknown;
        switch (definition.operation) {
          case "workspace.open":
            response = { workspaceHandle: "00000000-0000-4000-8000-000000000001" };
            break;
          case "shell.start": response = await start(request as { streamId: string }); break;
          case "shell.inspect": response = await inspect(request as { streamId: string }); break;
          case "shell.acknowledge": response = await acknowledge(); break;
          default: throw new Error(`unexpected_operation:${definition.operation}`);
        }
        return definition.responseSchema.parse(response);
      },
    };
  }
  const stream = async (mode: "normal" | "recovery") => {
    registry.attach(configuration, mode);
    for (const session of sessions) await session.close("replaced");
    return {
      installation, serviceStatus: registry.status(), bytes: { async *[Symbol.asyncIterator]() {} },
      closed: new Promise<{ reason: string }>(() => undefined),
      write: async () => undefined, close: async () => undefined,
    };
  };
  const launch = vi.fn(async () => stream("normal"));
  const attachExisting = vi.fn(async () => stream("recovery"));
  const owner = new SidecarRuntimeOwner<SidecarClientSession>({
    scope, executionEnvironmentId: "remote", environmentConfigurationRevision: 1,
    operationsConfigurationRevision: 1,
    authorizedCapabilities: [
      { capabilityId: "workspace_files", majorVersion: 7 },
      { capabilityId: "workspace_tools", majorVersion: 2 },
      { capabilityId: "workspace_context", majorVersion: 1 },
    ],
    authorizedRuntimeCapabilities: [],
    activeEnvironmentConfigurationRevision: () => 1,
    activeOperationsConfigurationRevision: () => 1,
    isAutomaticConnectionEnabled: () => true,
    artifact: {
      artifactId: SIDECAR_ARTIFACT_ID, modes: SIDECAR_ARTIFACT_MODES,
      executableDirectory: "/fixture", executablePath: "/fixture/sedes",
      artifactSha256: "a".repeat(64), artifactBytes: 1, buildId: "fixture",
      minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: [],
    },
    provisioner: { transportKind: "ssh_stdio",
      install: async () => installation, launch, attachExisting,
      inspect: async () => registry.status(), inspectReceipt: async () => undefined,
      withdrawReceipt: async () => undefined, control: async () => undefined,
    },
    sedesOperations: new SidecarOperationRegistry(), idleMilliseconds: 20,
    startSession: async () => {
      const session = makeSession();
      sessions.push(session);
      return session as unknown as SidecarClientSession;
    },
  });
  cleanups.push(() => owner.close());
  const executor = new SidecarWorkspaceToolExecutor({
    runtime: owner, scope, environmentId: "remote",
    declaredPath: "/home/remote/workspace", policyRootPath: "/home/remote",
  });
  return { owner, executor, sessions, start, inspect, acknowledge, closedPeerCalls,
    launch, attachExisting, complete: () => { completed = true; } };
}
