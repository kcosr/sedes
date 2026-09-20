import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  WORKSPACE_CONTEXT_V1_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_TOOLS_V2_LIMITS,
  registerControlV2Operations,
  registerWorkspaceToolsShellV2Operations,
  workspaceContextV1Operations,
  workspaceToolsV2Operations,
} from "../../src/internal/sidecar-protocol/index.js";
import { createPiRemoteWorkspaceToolDefinitions } from "../../src/server/backends/pi/pi-remote-workspace.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { WorkspaceToolsShellHost } from "../../src/server/sidecar/workspace-tools-shell-host.js";
import { SidecarWorkspaceShellExecutor } from "../../src/server/workspace-tools/sidecar-workspace-shell-executor.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Pi remote Bash connection recovery", () => {
  it("waits for the same running command and recovers its output without repeating a mutation", async () => {
    const fixture = await shellFixture();
    const updates: string[] = [];
    let settled = false;
    const result = fixture.bash.execute(
      randomUUID(),
      {
        command: "printf 'once\\n' >> effect; printf 'before\\n'; while [ ! -f finish ]; do sleep 0.02; done; printf 'after\\n'",
        timeout: 10,
      },
      undefined,
      (update) => updates.push(update.content.map((part) => part.type === "text" ? part.text : "").join("")),
      {} as never,
    );
    void result.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(updates).toContain("before\n"));
    await fixture.disconnect();
    fixture.resumeRecovery();
    // Two inspections prove this is an ongoing recovery wait, not merely a
    // completed receipt lookup after a command happened to finish offline.
    await vi.waitFor(() => expect(fixture.inspect.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(fixture.host.activeProcessCount()).toBe(1);
    expect(settled).toBe(false);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    await writeFile(path.join(fixture.directory, "finish"), "");
    await expect(result).resolves.toMatchObject({
      content: [{ type: "text", text: "before\nafter\n" }],
    });
    expect(updates.at(-1)).toBe("before\nafter\n");
    expect(await readFile(path.join(fixture.directory, "effect"), "utf8")).toBe("once\n");
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.host.activeProcessCount()).toBe(0);
    // Pi acknowledges only output it fully consumed, clearing recovery state.
    expect(fixture.host.unsettledReceiptCount()).toBe(0);
  });

  it("delivers cancellation requested while reconnecting to the original command", async () => {
    const fixture = await shellFixture();
    const controller = new AbortController();
    const result = fixture.bash.execute(
      randomUUID(),
      { command: "printf 'once\\n' >> effect; printf 'started\\n'; sleep 30", timeout: 10 },
      controller.signal,
      undefined,
      {} as never,
    );
    const cancelled = expect(result).rejects.toThrow("Remote command cancelled");
    await vi.waitFor(async () => expect(await readFile(path.join(fixture.directory, "effect"), "utf8")).toBe("once\n"));
    await fixture.disconnect();
    await vi.waitFor(() => expect(fixture.acquireRecovery).toHaveBeenCalled());
    controller.abort();
    fixture.resumeRecovery();
    await cancelled;
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.host.activeProcessCount()).toBe(0);
    expect(fixture.host.unsettledReceiptCount()).toBe(0);
    expect(await readFile(path.join(fixture.directory, "effect"), "utf8")).toBe("once\n");
  });
});

/**
 * Keep the production shell host alive while replacing the framed socket
 * attachment and real client session. Workspace admission and the recovery
 * lease are controlled here; no SSH account or model provider is involved.
 */
async function shellFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-pi-shell-"));
  const workspaceHandle = randomUUID();
  const artifact = { buildId: "shell-recovery-fixture", artifactSha256: "a".repeat(64) };
  const capabilities = [
    { capabilityId: "workspace_tools", majorVersion: 2 },
    { capabilityId: "workspace_context", majorVersion: 1 },
  ] as const;
  const peers: SidecarProtocolPeer[] = [];
  const sessions: SidecarClientSession[] = [];
  const sockets: Socket[] = [];
  let currentPeer: SidecarProtocolPeer;
  const host = new WorkspaceToolsShellHost({
    resolveWorkspace: (handle) => {
      if (handle !== workspaceHandle) throw new Error("unexpected_workspace_handle");
      return directory;
    },
    openStream: (input) => currentPeer.openOutgoingStream({
      ...input, capabilityId: "workspace_tools", majorVersion: 2,
    }),
    admitOperation: async (_workspace, _operation, _payload, operation) => await operation(),
  });
  const start = vi.fn(host.handlers.start);
  const inspect = vi.fn(host.handlers.inspect);
  const cancel = vi.fn(host.handlers.cancel);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    await host.close();
    for (const session of sessions) await session.close("test_complete");
    for (const peer of peers) await peer.close("test_complete");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const attach = async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_server_not_listening");
    const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
    const clientSocket = connect(address.port, "127.0.0.1");
    const serverSocket = await accepted;
    sockets.push(clientSocket, serverSocket);
    const sessionNonce = randomUUID().replaceAll("-", "").repeat(2);
    const registry = new SidecarOperationRegistry();
    for (const definition of [...workspaceToolsV2Operations, ...workspaceContextV1Operations]) {
      registry.register(definition as never, () => { throw new Error("unexpected_non_shell_operation"); });
    }
    registerWorkspaceToolsShellV2Operations(registry, { ...host.handlers, start, inspect, cancel });
    registerControlV2Operations(registry, {
      ...artifact,
      enabledSidecarCapabilities: capabilities,
      enabledSedesCapabilities: [],
      capabilityEvidence: [
        { ...capabilities[0], limits: WORKSPACE_TOOLS_V2_LIMITS, ...WORKSPACE_TOOLS_SHELL_V2_LIMITS },
        { ...capabilities[1], limits: WORKSPACE_CONTEXT_V1_LIMITS },
      ],
    });
    currentPeer = new SidecarProtocolPeer({
      role: "sidecar", sessionNonce, registry,
      transport: new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "fixture_socket", carrierGeneration: sessions.length + 1 },
        stream: sidecarSocketByteStream(serverSocket),
      }),
    });
    peers.push(currentPeer);
    currentPeer.start();
    const session = await SidecarClientSession.start({ transportKind: "ssh_stdio",
      stream: sidecarSocketByteStream(clientSocket),
      sessionNonce,
      carrierGeneration: sessions.length + 1,
      artifact,
      installation: {
        accountHome: directory, stateRoot: directory,
        nodeExecutable: process.execPath,
        environment: { HOME: directory },
        executableDirectory: directory, executablePath: path.join(directory, "sedes"),
      },
      authorizedCapabilities: capabilities,
      authorizedRuntimeCapabilities: [],
      sedesOperations: new SidecarOperationRegistry(),
      signal: AbortSignal.timeout(5_000),
    });
    sessions.push(session);
    return session;
  };
  const original = await attach();
  let resumeRecovery!: () => void;
  const recoveryReady = new Promise<void>((resolve) => { resumeRecovery = resolve; });
  let recovered: Promise<SidecarClientSession> | undefined;
  const acquireRecovery = vi.fn(async () => {
    await recoveryReady;
    recovered ??= attach();
    return { session: await recovered, assertActive: () => undefined, release: () => undefined };
  });
  const executor = new SidecarWorkspaceShellExecutor({
    acquireWorkspaceLease: async () => ({
      session: original, workspaceHandle, carrierGeneration: 1, release: () => undefined,
    }),
    acquireRecoveryLease: acquireRecovery,
  });
  const unsupported = async (): Promise<never> => { throw new Error("unexpected_non_shell_tool"); };
  const [bash] = createPiRemoteWorkspaceToolDefinitions({
    semanticCwd: directory, serviceCwd: directory, environmentLabel: "Recovery fixture",
    contextReader: { read: async () => ({ files: [], fingerprint: "empty" }) },
    executor: {
      read: unsupported, write: unsupported, edit: unsupported, list: unsupported,
      grep: unsupported, find: unsupported,
      startShell: (input) => executor.start(input),
    },
  });
  return {
    directory, host, bash, start, inspect, cancel, acquireRecovery, resumeRecovery,
    disconnect: async () => {
      // Persistent service teardown detaches process delivery before closing
      // the peer, so transport request abortion cannot kill the remote child.
      host.detach();
      sockets[0]!.destroy();
      await original.closed;
    },
  };
}
