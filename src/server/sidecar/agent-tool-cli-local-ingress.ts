import {
  AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES,
  createAgentToolCliNamedPipeEndpoint,
  parseAgentToolCliNamedPipeEndpoint,
} from "../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { createAgentToolCliNamedPipeServer } from "../../internal/agent-tool-cli-protocol/named-pipe-tls.js";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import type { SedesToolError } from "../agent-tools/contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_CLI_PROTOCOL_VERSION,
  AgentToolCliFrameDecoder,
  agentToolCliRequestSchema,
  agentToolCliResultSchema,
  agentToolCliResponseSchema,
  encodeAgentToolCliFrame,
  type AgentToolCliRequest,
  type AgentToolCliResult,
} from "../../internal/agent-tool-cli-protocol/index.js";

const DEFAULT_MAXIMUM_CLIENTS = 32;
const DEFAULT_REQUEST_FRAME_TIMEOUT_MILLISECONDS = 10_000;
const REQUEST_WAIT_TIMEOUT_MILLISECONDS = 30_000;
const SOCKET_FILENAME = "agent-tools.sock";

export interface AgentToolCliIngressRelay {
  handle(
    request: AgentToolCliRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<AgentToolCliResult>;
}

export interface AgentToolCliLocalIngressOptions {
  readonly endpointKey: string;
  readonly relay: AgentToolCliIngressRelay;
  /** Test seam. Production uses a short account-private directory beneath /tmp. */
  readonly runtimeDirectory?: string;
  readonly maximumClients?: number;
  readonly requestFrameTimeoutMilliseconds?: number;
  /** Test seam. Production list/describe requests use 30 seconds. */
  readonly listDescribeTimeoutMilliseconds?: number;
}

/** A canonical relay failure safe to return to the admitted CLI caller. */
export class AgentToolCliIngressError extends Error {
  constructor(readonly toolError: SedesToolError) {
    super(toolError.message);
    this.name = "AgentToolCliIngressError";
  }
}

/**
 * Private sidecar-local ingress for the narrow agent_tools_cli@3 protocol.
 * It owns no Sedes repository, HTTP listener, Codex channel, or SSH carrier.
 */
export class AgentToolCliLocalIngress {
  readonly socketPath: string;
  readonly endpointUrl: string;
  readonly #unixOwnership: Readonly<{
    sessionDirectory: string;
    sessionDirectoryIdentity: FileIdentity;
    socketIdentity: FileIdentity;
  }> | undefined;
  readonly #transportSockets = new Set<Socket>();
  readonly #server: Server;
  readonly #relay: AgentToolCliIngressRelay;
  readonly #maximumClients: number;
  readonly #requestFrameTimeoutMilliseconds: number;
  readonly #listDescribeTimeoutMilliseconds: number;
  readonly #closeController = new AbortController();
  readonly #clients = new Set<Socket>();
  readonly #clientControllers = new Map<Socket, AbortController>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(input: {
    readonly socketPath: string;
    readonly endpointUrl: string;
    readonly unixOwnership?: Readonly<{
      sessionDirectory: string;
      sessionDirectoryIdentity: FileIdentity;
      socketIdentity: FileIdentity;
    }>;
    readonly server: Server;
    readonly relay: AgentToolCliIngressRelay;
    readonly maximumClients: number;
    readonly requestFrameTimeoutMilliseconds: number;
    readonly listDescribeTimeoutMilliseconds: number;
  }) {
    this.socketPath = input.socketPath;
    this.endpointUrl = input.endpointUrl;
    this.#unixOwnership = input.unixOwnership;
    this.#server = input.server;
    this.#relay = input.relay;
    this.#maximumClients = input.maximumClients;
    this.#requestFrameTimeoutMilliseconds =
      input.requestFrameTimeoutMilliseconds;
    this.#listDescribeTimeoutMilliseconds =
      input.listDescribeTimeoutMilliseconds;
    if (this.#unixOwnership) {
      this.#server.on("connection", (socket) => this.#accept(socket));
    } else {
      // Count and retire sockets still doing TLS admission as well as admitted
      // clients. An unauthenticated peer cannot pin an unbounded handshake set.
      this.#server.maxConnections = this.#maximumClients;
      this.#server.on("connection", (socket: Socket) => {
        this.#transportSockets.add(socket);
        socket.once("close", () => this.#transportSockets.delete(socket));
      });
      this.#server.on("secureConnection", (socket: Socket) => this.#accept(socket));
    }
  }

  static async start(
    input: AgentToolCliLocalIngressOptions,
  ): Promise<AgentToolCliLocalIngress> {
    if (!/^[0-9a-f]{24}$/u.test(input.endpointKey)) {
      throw new Error("agent_tool_cli_ingress_endpoint_key_invalid");
    }
    const maximumClients = input.maximumClients ?? DEFAULT_MAXIMUM_CLIENTS;
    const requestFrameTimeoutMilliseconds =
      input.requestFrameTimeoutMilliseconds ??
      DEFAULT_REQUEST_FRAME_TIMEOUT_MILLISECONDS;
    const listDescribeTimeoutMilliseconds =
      input.listDescribeTimeoutMilliseconds ??
      REQUEST_WAIT_TIMEOUT_MILLISECONDS;
    if (
      !Number.isSafeInteger(maximumClients) ||
      maximumClients <= 0 ||
      maximumClients > 256 ||
      !Number.isSafeInteger(requestFrameTimeoutMilliseconds) ||
      requestFrameTimeoutMilliseconds <= 0 ||
      requestFrameTimeoutMilliseconds > 60_000 ||
      !Number.isSafeInteger(listDescribeTimeoutMilliseconds) ||
      listDescribeTimeoutMilliseconds <= 0 ||
      listDescribeTimeoutMilliseconds > REQUEST_WAIT_TIMEOUT_MILLISECONDS
    ) {
      throw new Error("agent_tool_cli_ingress_limits_invalid");
    }
    if (process.platform === "win32") {
      const endpointUrl = createAgentToolCliNamedPipeEndpoint();
      const endpoint = parseAgentToolCliNamedPipeEndpoint(endpointUrl)!;
      const server = createAgentToolCliNamedPipeServer(
        endpoint.capability,
        requestFrameTimeoutMilliseconds,
      );
      // No filesystem Unix ownership claims apply to Windows. TLS PSK confines
      // relay access to processes given this incarnation's private endpoint.
      const ingress = new AgentToolCliLocalIngress({
        socketPath: endpoint.socketPath,
        endpointUrl,
        server,
        relay: input.relay,
        maximumClients,
        requestFrameTimeoutMilliseconds,
        listDescribeTimeoutMilliseconds,
      });
      try {
        await listen(server, endpoint.socketPath);
        return ingress;
      } catch (error) {
        await ingress.close();
        throw error;
      }
    }
    const euid = process.geteuid?.();
    if (!Number.isSafeInteger(euid) || (euid ?? -1) < 0) {
      throw new Error("agent_tool_cli_ingress_uid_unavailable");
    }
    const runtimeDirectory =
      input.runtimeDirectory ??
      path.join(await realpath("/tmp"), `sedes-agent-tools-${euid}`);
    if (!path.isAbsolute(runtimeDirectory)) {
      throw new Error("agent_tool_cli_ingress_runtime_directory_invalid");
    }
    // Socket addresses are independent of HOME/TMPDIR length. The fixed system
    // temp parent can be shared; every account/session directory below it must
    // still be an exact owned 0700 directory, never a symlink or inherited grant.
    await ensureOwnerDirectory(runtimeDirectory, euid!);
    const sessionDirectory = path.join(runtimeDirectory, input.endpointKey);
    const socketPath = path.join(sessionDirectory, SOCKET_FILENAME);
    if (
      Buffer.byteLength(socketPath, "utf8") > AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES
    ) {
      throw new Error("agent_tool_cli_ingress_socket_path_too_long");
    }

    let sessionCreated = false;
    let server: Server | undefined;
    try {
      try {
        await mkdir(sessionDirectory, { mode: 0o700 });
        sessionCreated = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const sessionMetadata = await assertOwnerDirectory(
        sessionDirectory,
        euid!,
      );
      await removeStaleOwnedSocket(socketPath, euid!);
      server = net.createServer({
        allowHalfOpen: false,
        pauseOnConnect: false,
      });
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
      const socketMetadata = await lstat(socketPath);
      if (
        socketMetadata.isSymbolicLink() ||
        !socketMetadata.isSocket() ||
        socketMetadata.uid !== euid ||
        (socketMetadata.mode & 0o777) !== 0o600
      ) {
        throw new Error("agent_tool_cli_ingress_socket_invalid");
      }
      return new AgentToolCliLocalIngress({
        socketPath,
        endpointUrl: `unix://${socketPath}`,
        unixOwnership: {
          sessionDirectory,
          sessionDirectoryIdentity: identity(sessionMetadata),
          socketIdentity: identity(socketMetadata),
        },
        server,
        relay: input.relay,
        maximumClients,
        requestFrameTimeoutMilliseconds,
        listDescribeTimeoutMilliseconds,
      });
    } catch (error) {
      if (server) await closeServer(server).catch(() => undefined);
      await unlinkOwnedSocket(socketPath, euid!, undefined).catch(
        () => undefined,
      );
      if (sessionCreated) await rmdir(sessionDirectory).catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#clients.size >= this.#maximumClients) {
      socket.destroy();
      return;
    }
    this.#clients.add(socket);
    const controller = new AbortController();
    this.#clientControllers.set(socket, controller);
    socket.once("error", (error) => controller.abort(error));
    socket.once("close", () => {
      controller.abort(new Error("agent_tool_cli_client_closed"));
      this.#clients.delete(socket);
      this.#clientControllers.delete(socket);
    });
    void this.#serve(socket, controller).catch(() => socket.destroy());
  }

  async #serve(socket: Socket, controller: AbortController): Promise<void> {
    const decoder = new AgentToolCliFrameDecoder();
    const request = await receiveRequest(
      socket,
      decoder,
      controller,
      this.#requestFrameTimeoutMilliseconds,
    );
    if (controller.signal.aborted || this.#closeController.signal.aborted)
      return;

    const deadlineController =
      request.operation.type === "invoke" ? undefined : new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.#closeController.signal,
      ...(deadlineController ? [deadlineController.signal] : []),
    ]);
    const deadline = deadlineController
      ? setTimeout(
          () =>
            deadlineController.abort(
              new Error("agent_tool_cli_request_timeout"),
            ),
          this.#listDescribeTimeoutMilliseconds,
        )
      : undefined;
    deadline?.unref();
    let response: unknown;
    try {
      const result = agentToolCliResultSchema.parse(
        await raceAgainstAbort(this.#relay.handle(request, { signal }), signal),
      );
      response = {
        protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
        requestId: request.requestId,
        result,
      };
    } catch (error) {
      if (controller.signal.aborted || this.#closeController.signal.aborted)
        return;
      response = {
        protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
        requestId: request.requestId,
        error: deadlineController?.signal.aborted
          ? {
              code: "timed_out",
              message: "The Sedes tool request timed out.",
              retryable: true,
            }
          : ingressToolError(error),
      };
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (controller.signal.aborted || this.#closeController.signal.aborted)
      return;
    const validated = agentToolCliResponseSchema.parse(response);
    await endSocket(socket, encodeAgentToolCliFrame(validated));
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error("agent_tool_cli_ingress_closed"));
    const ownership = this.#unixOwnership;
    const displaced = ownership ? await displaceUnexpectedSocketPath(
      this.socketPath,
      ownership.socketIdentity,
    ) : undefined;
    const closing = closeServer(this.#server);
    for (const socket of this.#clients) socket.destroy();
    for (const socket of this.#transportSockets) socket.destroy();
    await closing;
    if (displaced) {
      await rename(displaced, this.socketPath);
      throw new Error("agent_tool_cli_ingress_socket_ownership_lost");
    }
    const euid = process.geteuid?.();
    if (ownership && Number.isSafeInteger(euid) && (euid ?? -1) >= 0) {
      await unlinkOwnedSocket(this.socketPath, euid!, ownership.socketIdentity);
      await removeOwnedEmptyDirectory(
        ownership.sessionDirectory,
        euid!,
        ownership.sessionDirectoryIdentity,
      );
    }
  }
}

type FileIdentity = Readonly<{ readonly dev: number; readonly ino: number }>;

function identity(metadata: Stats): FileIdentity {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

async function assertOwnerDirectory(
  directory: string,
  euid: number,
): Promise<Stats> {
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== euid ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("agent_tool_cli_ingress_namespace_invalid");
  }
  return metadata;
}

async function ensureOwnerDirectory(
  directory: string,
  euid: number,
): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertOwnerDirectory(directory, euid);
}

async function unlinkOwnedSocket(
  socketPath: string,
  euid: number,
  expected: FileIdentity | undefined,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(socketPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isSocket() ||
    metadata.uid !== euid ||
    (expected &&
      (metadata.dev !== expected.dev || metadata.ino !== expected.ino))
  ) {
    throw new Error("agent_tool_cli_ingress_socket_ownership_lost");
  }
  await unlink(socketPath);
}

async function removeStaleOwnedSocket(
  socketPath: string,
  euid: number,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(socketPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isSocket() ||
    metadata.uid !== euid
  ) {
    throw new Error("agent_tool_cli_ingress_socket_ownership_lost");
  }
  if (await socketAcceptingConnections(socketPath)) {
    throw new Error("agent_tool_cli_ingress_socket_active");
  }
  await unlinkOwnedSocket(socketPath, euid, identity(metadata));
}

function socketAcceptingConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (error: Error | undefined, active: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(active);
    };
    socket.once("connect", () => finish(undefined, true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(undefined, false);
        return;
      }
      finish(error, false);
    });
  });
}

async function removeOwnedEmptyDirectory(
  directory: string,
  euid: number,
  expected: FileIdentity,
): Promise<void> {
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== euid ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino
  ) {
    throw new Error("agent_tool_cli_ingress_namespace_ownership_lost");
  }
  await rmdir(directory);
}

async function displaceUnexpectedSocketPath(
  socketPath: string,
  expected: FileIdentity,
): Promise<string | undefined> {
  let metadata: Stats;
  try {
    metadata = await lstat(socketPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (metadata.dev === expected.dev && metadata.ino === expected.ino) {
    return undefined;
  }
  const displaced = `${socketPath}.ownership-lost`;
  try {
    await lstat(displaced);
    throw new Error("agent_tool_cli_ingress_socket_ownership_lost");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await rename(socketPath, displaced);
  return displaced;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(socketPath);
  });
}

function receiveRequest(
  socket: Socket,
  decoder: AgentToolCliFrameDecoder,
  controller: AbortController,
  timeoutMilliseconds: number,
): Promise<AgentToolCliRequest> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, request?: AgentToolCliRequest) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("end", end);
      controller.signal.removeEventListener("abort", abort);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.on("data", trailingData);
      resolve(request!);
    };
    const data = (chunk: Buffer) => {
      try {
        const decoded = decoder.push(chunk);
        if (decoded !== undefined) {
          finish(undefined, agentToolCliRequestSchema.parse(decoded));
        }
      } catch (error) {
        finish(error);
      }
    };
    const trailingData = (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        controller.abort(error);
        socket.destroy();
      }
    };
    const end = () => {
      try {
        decoder.finishRequest();
        finish(new Error("agent_tool_cli_request_missing"));
      } catch (error) {
        finish(error);
      }
    };
    const abort = () => finish(controller.signal.reason);
    const timer = setTimeout(
      () => finish(new Error("agent_tool_cli_request_frame_timeout")),
      timeoutMilliseconds,
    );
    timer.unref();
    socket.on("data", data);
    socket.once("end", end);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function endSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.end(Buffer.from(bytes), (error?: Error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function ingressToolError(error: unknown): SedesToolError {
  if (error instanceof AgentToolCliIngressError) return error.toolError;
  return {
    code: "internal_error",
    message: "The Sedes tool request failed.",
    retryable: false,
  };
}

async function raceAgainstAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
