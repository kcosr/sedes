import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  controlHelloOperation,
  registerControlV2Operations,
} from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import type {
  ClaudeRuntimeClient,
  ClaudeRuntimeSession,
  ClaudeRuntimeSessionOptions,
} from "../../src/server/backends/claude/claude-runtime-client.js";
import type { ClaudeSdkSessionInitialization } from "../../src/server/backends/claude/claude-sdk-session.js";

/** Both sides exchange production length-prefixed protocol bytes over a fresh
 * local socket standing in for the SSH stdio carrier. Provider-independent. */
export async function createClaudeFramedCarrier() {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => { accept = resolve; });
  const server = createServer(accept);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_socket_missing");
  const clientSocket = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    clientSocket.once("connect", resolve);
    clientSocket.once("error", reject);
  });
  const serverSocket = await accepted;
  clientSocket.setNoDelay(true);
  serverSocket.setNoDelay(true);
  const sessionNonce = randomUUID().replaceAll("-", "").repeat(2);
  const mainRegistry = new SidecarOperationRegistry();
  const hostRegistry = new SidecarOperationRegistry();
  const makeTransport = (socket: Socket) => new LengthPrefixedSidecarFrameTransport({
    stream: sidecarSocketByteStream(socket),
    assurance: { kind: "test-ssh-byte-carrier", carrierGeneration: 1 },
  });
  const mainPeer = new SidecarProtocolPeer({ role: "sedes", transport: makeTransport(clientSocket), sessionNonce, registry: mainRegistry });
  const hostPeer = new SidecarProtocolPeer({ role: "sidecar", transport: makeTransport(serverSocket), sessionNonce, registry: hostRegistry });
  const mainChannel = new SidecarRuntimeChannel(mainPeer, mainRegistry);
  const hostChannel = new SidecarRuntimeChannel(hostPeer, hostRegistry);
  let closePromise: Promise<void> | undefined;
  return {
    mainPeer, hostPeer, mainChannel, hostChannel, mainRegistry, hostRegistry,
    async start() {
      const capabilities = hostRegistry.capabilities().map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }));
      registerControlV2Operations(hostRegistry, {
        buildId: "claude-persistent-test", artifactSha256: "a".repeat(64),
        enabledSidecarCapabilities: capabilities, enabledSedesCapabilities: mainRegistry.capabilities(),
      });
      mainPeer.start(); hostPeer.start();
      await mainPeer.call(controlHelloOperation, {
        expectedBuildId: "claude-persistent-test", expectedArtifactSha256: "a".repeat(64),
        authorizedSidecarCapabilities: capabilities, offeredSedesCapabilities: mainRegistry.capabilities(),
      });
    },
    close() {
      return closePromise ??= (async () => {
        mainChannel.close(); hostChannel.close();
        await Promise.all([mainPeer.close("test_carrier_replaced"), hostPeer.close("test_carrier_replaced")]);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })();
    },
  };
}

export class FakePersistentClaudeSession implements ClaudeRuntimeSession {
  closed = false;
  readonly initialization: ClaudeSdkSessionInitialization = {
    models: [], commands: [], skillNames: [], terminalCommandNames: [], account: {},
    actualModel: "claude-sonnet-4-6", actualPermissionMode: "default", cliRelease: "2.1.274",
  };
  readonly startupProbeUuid = randomUUID();
  readonly safeSkills = [];
  readonly start = vi.fn(async () => this.initialization);
  readonly send = vi.fn<ClaudeRuntimeSession["send"]>();
  readonly interrupt = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setEffort = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => { this.closed = true; this.#permissionAbort.abort(); });
  readonly #permissionAbort = new AbortController();
  constructor(readonly options: ClaudeRuntimeSessionOptions) {}
  async emit(message: SDKMessage): Promise<void> { await this.options.onMessage(message); }
  async askPermission(requestId = "permission-1", toolUseID = "tool-1") {
    if (!this.options.canUseTool) throw new Error("test_permission_callback_missing");
    const response = await this.options.canUseTool("Read", { file_path: "/workspace/example.txt" }, {
      requestId, toolUseID, signal: this.#permissionAbort.signal,
    });
    await this.options.onPermissionResponseDelivered?.({ requestId, toolUseID });
    return response;
  }
}

export function createFakePersistentClaudeRuntime() {
  const sessions: FakePersistentClaudeSession[] = [];
  const runtime = {
    createSession: vi.fn((options: ClaudeRuntimeSessionOptions) => {
      const session = new FakePersistentClaudeSession(options);
      sessions.push(session);
      return session;
    }),
    probe: vi.fn<ClaudeRuntimeClient["probe"]>(async () => ({
      cliRelease: "2.1.274", account: {}, models: [], commands: [], skillNames: [], terminalCommandNames: [],
    })),
    listSessions: vi.fn<ClaudeRuntimeClient["listSessions"]>(async () => []),
    getSessionInfo: vi.fn<ClaudeRuntimeClient["getSessionInfo"]>(async () => undefined),
    getSessionMessages: vi.fn<ClaudeRuntimeClient["getSessionMessages"]>(async () => []),
    renameSession: vi.fn<ClaudeRuntimeClient["renameSession"]>(async () => undefined),
    close: vi.fn(async () => { await Promise.all(sessions.map(session => session.close())); }),
  } satisfies ClaudeRuntimeClient & { close(): Promise<void> };
  return { runtime, sessions };
}
