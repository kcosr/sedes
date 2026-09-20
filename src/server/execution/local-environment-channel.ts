import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { realpathSync, statSync } from "node:fs";
import {
  access,
  lstat,
  open as openFile,
  realpath,
  stat,
} from "node:fs/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { connect as createTlsConnection, type TLSSocket } from "node:tls";
import type { IPty } from "node-pty";
import { spawnWindowsOwnedProcess } from "./windows-owned-process.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import type {
  ManagedWorkerArtifactRegistration,
  ManagedWorkerLaunchIdentity,
} from "../managed-workers/artifact.js";
import { launchLocalManagedWorker } from "../managed-workers/local-launcher.js";
import {
  EnvironmentProcessWriteError,
  EnvironmentStreamWriteError,
  createEnvironmentAssuredTcpStreamIdentity,
  createEnvironmentSecretIdentity,
  createEnvironmentPrivateUnixStreamIdentity,
  createEnvironmentOwnedProcessIdentity,
  createEnvironmentOwnedPtyIdentity,
  revokeEnvironmentPrivateUnixStreamIdentity,
  revokeEnvironmentAssuredTcpStreamIdentity,
  revokeEnvironmentSecretIdentity,
  sameEnvironmentChannelScope,
  validEnvironmentChannelScope,
  type EnvironmentChannelScope,
  type EnvironmentAssuredTcpStreamChannel,
  type EnvironmentAssuredTcpStreamIdentity,
  type EnvironmentSecretIdentity,
  type EnvironmentSecretReference,
  type EnvironmentOwnedProcessChannel,
  type EnvironmentOwnedProcessCleanupPolicy,
  type EnvironmentOwnedProcessIdentity,
  type EnvironmentOwnedPtyChannel,
  type EnvironmentOwnedPtyIdentity,
  type EnvironmentPathIdentity,
  type EnvironmentPtySize,
  type EnvironmentPrivateUnixStreamChannel,
  type EnvironmentPrivateUnixStreamClosure,
  type EnvironmentPrivateUnixStreamIdentity,
  type EnvironmentProcessClosure,
  type EnvironmentTcpRoute,
  type ResolvedEnvironmentSecret,
  type ExecutionEnvironmentChannelProvider,
  type PreparedEnvironmentOwnedProcess,
  type PreparedEnvironmentManagedProcessEndpoint,
  type EnvironmentManagedProcessEndpointRequest,
} from "./environment-channel.js";

const PRIVATE_UNIX_CONNECT_TIMEOUT_MILLISECONDS = 5_000;
const PRIVATE_UNIX_CLIENT_CLOSE_MILLISECONDS = 1_000;
const TCP_CONNECT_TIMEOUT_MILLISECONDS = 5_000;
const TCP_CLIENT_CLOSE_MILLISECONDS = 1_000;
const MAXIMUM_CAPABILITY_TOKEN_BYTES = 4_096;
const MAXIMUM_PTY_WRITE_BYTES = 1_048_576;
const PTY_OUTPUT_HIGH_WATER_BYTES = 262_144;
const PTY_OUTPUT_LOW_WATER_BYTES = 131_072;

/** Local provider preflight used before application storage is opened. */
export function canonicalLocalEnvironmentDirectorySync(
  configuredPath: string,
): string {
  assertConfiguredPath(configuredPath);
  const canonicalPath = realpathSync(configuredPath);
  if (!statSync(canonicalPath).isDirectory()) {
    throw new Error("environment_channel_directory_invalid");
  }
  return canonicalPath;
}

function sameRequestScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function assertConfiguredPath(configuredPath: string): void {
  if (
    configuredPath.length === 0 ||
    configuredPath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(configuredPath) ||
    !path.isAbsolute(configuredPath) ||
    path.resolve(configuredPath) !== configuredPath
  ) {
    throw new Error("environment_channel_path_invalid");
  }
}

async function resolveDirectoryIdentity(
  configuredPath: string,
): Promise<EnvironmentPathIdentity & { readonly kind: "directory" }> {
  assertConfiguredPath(configuredPath);
  const canonicalPath = await realpath(configuredPath);
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new Error("environment_channel_directory_invalid");
  }
  return Object.freeze({
    kind: "directory" as const,
    canonicalPath,
  });
}

async function resolveExecutableIdentity(
  configuredPath: string,
): Promise<EnvironmentPathIdentity & { readonly kind: "executable" }> {
  assertConfiguredPath(configuredPath);
  const canonicalPath = await realpath(configuredPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error("environment_channel_executable_invalid");
  }
  await access(canonicalPath, fsConstants.X_OK);
  return Object.freeze({
    kind: "executable" as const,
    canonicalPath,
  });
}

function assertExecutableCommandName(commandName: string): void {
  if (
    commandName.length === 0 ||
    commandName.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(commandName)
  ) {
    throw new Error("environment_channel_executable_command_invalid");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("environment_operation_aborted");
  }
}

type PrivateUnixFilesystemSnapshot = Readonly<{
  readonly socketIdentity: string;
  readonly parentDevice: bigint;
  readonly parentInode: bigint;
  readonly parentChangeTime: bigint;
  readonly socketDevice: bigint;
  readonly socketInode: bigint;
  readonly socketChangeTime: bigint;
}>;

async function inspectPrivateUnixSocket(
  configuredPath: string,
): Promise<PrivateUnixFilesystemSnapshot> {
  assertConfiguredPath(configuredPath);
  // Linux sockaddr_un.sun_path is 108 bytes including the terminating NUL.
  if (Buffer.byteLength(configuredPath, "utf8") > 107) {
    throw new Error("environment_private_unix_stream_path_unsafe");
  }
  const parentPath = path.dirname(configuredPath);
  let canonicalParent: string;
  let canonicalSocket: string;
  let parentMetadata: BigIntStats;
  let socketMetadata: BigIntStats;
  try {
    [canonicalParent, canonicalSocket, parentMetadata, socketMetadata] =
      await Promise.all([
        realpath(parentPath),
        realpath(configuredPath),
        lstat(parentPath, { bigint: true }),
        lstat(configuredPath, { bigint: true }),
      ]);
  } catch {
    throw new Error("environment_private_unix_stream_identity_unavailable");
  }
  if (
    canonicalParent !== parentPath ||
    canonicalSocket !== configuredPath ||
    !parentMetadata.isDirectory()
  ) {
    throw new Error("environment_private_unix_stream_path_unsafe");
  }
  if (!socketMetadata.isSocket()) {
    throw new Error("environment_private_unix_stream_type_invalid");
  }
  const effectiveUserId = BigInt(
    process.geteuid?.() ?? process.getuid?.() ?? -1,
  );
  if (
    effectiveUserId < 0n ||
    parentMetadata.uid !== effectiveUserId ||
    socketMetadata.uid !== effectiveUserId
  ) {
    throw new Error("environment_private_unix_stream_owner_invalid");
  }
  if ((parentMetadata.mode & 0o777n) !== 0o700n) {
    throw new Error("environment_private_unix_stream_parent_mode_invalid");
  }
  if ((socketMetadata.mode & 0o777n) !== 0o600n) {
    throw new Error("environment_private_unix_stream_socket_mode_invalid");
  }
  const socketIdentity = createHash("sha256")
    .update(configuredPath)
    .update("\0")
    .update(parentMetadata.dev.toString())
    .update(":")
    .update(parentMetadata.ino.toString())
    .update(":")
    .update(parentMetadata.ctimeNs.toString())
    .update(":")
    .update(socketMetadata.dev.toString())
    .update(":")
    .update(socketMetadata.ino.toString())
    .update(":")
    .update(socketMetadata.ctimeNs.toString())
    .digest("base64url");
  return Object.freeze({
    socketIdentity,
    parentDevice: parentMetadata.dev,
    parentInode: parentMetadata.ino,
    parentChangeTime: parentMetadata.ctimeNs,
    socketDevice: socketMetadata.dev,
    socketInode: socketMetadata.ino,
    socketChangeTime: socketMetadata.ctimeNs,
  });
}

function samePrivateUnixFilesystemSnapshot(
  left: PrivateUnixFilesystemSnapshot,
  right: PrivateUnixFilesystemSnapshot,
): boolean {
  return (
    left.socketIdentity === right.socketIdentity &&
    left.parentDevice === right.parentDevice &&
    left.parentInode === right.parentInode &&
    left.parentChangeTime === right.parentChangeTime &&
    left.socketDevice === right.socketDevice &&
    left.socketInode === right.socketInode &&
    left.socketChangeTime === right.socketChangeTime
  );
}

export class LocalEnvironmentChannelProvider implements ExecutionEnvironmentChannelProvider {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  readonly #prepared = new WeakSet<object>();
  readonly #privateUnixChannels =
    new Set<EnvironmentPrivateUnixStreamChannel>();
  readonly #assuredTcpChannels = new Set<EnvironmentAssuredTcpStreamChannel>();
  readonly #ownedPtyChannels = new Set<EnvironmentOwnedPtyChannel>();
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #secretIdentityKey = randomBytes(32);
  readonly #activeSecrets = new Set<EnvironmentSecretIdentity>();
  #closed = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly executionEnvironmentId: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) {
    if (
      !input.executionEnvironmentId ||
      !input.scope.tenantId ||
      !input.scope.principalId
    ) {
      throw new Error("local_environment_channel_configuration_invalid");
    }
    this.scope = Object.freeze({ ...input.scope });
    this.executionEnvironmentId = input.executionEnvironmentId;
    // Resolve environment-backed connection secrets on each generation so an
    // operator can rotate the value without changing or fingerprinting config.
    this.#environment = input.environment ?? process.env;
  }

  async reportRuntimeAvailability(
    scope: EnvironmentChannelScope,
    _observation:
      | Readonly<{ readonly availability: "available" }>
      | Readonly<{
          readonly availability: "unavailable";
          readonly diagnosticCode: string;
        }>,
  ): Promise<void> {
    this.#assertScope(scope);
  }

  async resolveDirectory(
    scope: EnvironmentChannelScope,
    configuredPath: string,
  ): Promise<EnvironmentPathIdentity & { readonly kind: "directory" }> {
    this.#assertScope(scope);
    return await resolveDirectoryIdentity(configuredPath);
  }

  async resolveOwnedProcessExecutable(
    scope: EnvironmentChannelScope,
    input: {
      readonly commandName: string;
      readonly configuredPath?: string;
    },
  ): Promise<EnvironmentPathIdentity & { readonly kind: "executable" }> {
    this.#assertScope(scope);
    assertExecutableCommandName(input.commandName);
    if (input.configuredPath !== undefined) {
      return await resolveExecutableIdentity(input.configuredPath);
    }
    const searchPath = this.#environment.PATH ?? "/usr/bin:/bin";
    for (const entry of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(entry)) continue;
      try {
        return await resolveExecutableIdentity(
          path.join(entry, input.commandName),
        );
      } catch {
        // Match command lookup precedence by continuing to the next PATH entry
        // when this candidate is absent, not a regular file, or not executable.
      }
    }
    throw new Error("environment_channel_executable_unavailable");
  }

  async prepareOwnedProcess(
    scope: EnvironmentChannelScope,
    input: {
      readonly executablePath: string;
      readonly workingDirectory: string;
    },
  ): Promise<PreparedEnvironmentOwnedProcess> {
    this.#assertScope(scope);
    const [executable, workingDirectory] = await Promise.all([
      resolveExecutableIdentity(input.executablePath),
      resolveDirectoryIdentity(input.workingDirectory),
    ]);
    const prepared = Object.freeze({
      kind: "owned_process" as const,
      scope: Object.freeze({ ...scope }),
      executable,
      workingDirectory,
    });
    this.#prepared.add(prepared);
    return prepared;
  }

  async openInstallationManagedWorker(
    scope: EnvironmentChannelScope,
    input: {
      readonly artifact: ManagedWorkerArtifactRegistration;
      readonly workingDirectory: string;
      readonly identity: ManagedWorkerLaunchIdentity;
    },
    signal: AbortSignal,
  ): Promise<SidecarByteStream> {
    this.#assertScope(scope);
    return await launchLocalManagedWorker({
      channels: this,
      scope,
      artifact: input.artifact,
      workingDirectory: input.workingDirectory,
      identity: input.identity,
      signal,
    });
  }

  async prepareManagedProcessEndpoint(
    scope: EnvironmentChannelScope,
    request: EnvironmentManagedProcessEndpointRequest,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<PreparedEnvironmentManagedProcessEndpoint> {
    this.#assertScope(scope);
    throwIfAborted(signal);
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration <= 0
    ) {
      throw new Error("environment_managed_endpoint_generation_invalid");
    }
    if (request.kind === "private_unix_websocket") {
      const snapshot = await inspectPrivateUnixSocket(request.socketPath);
      this.#assertScope(scope);
      throwIfAborted(signal);
      return Object.freeze({
        kind: "managed_process_endpoint" as const,
        processAddress: `unix://${request.socketPath}`,
        endpointIdentity: `unix:${snapshot.socketIdentity}`,
      });
    }
    assertTcpRoute(request.route);
    if (
      request.address.length === 0 ||
      request.address.length > 2_048 ||
      /[^\u0021-\u007e]/u.test(request.address)
    ) {
      throw new Error("environment_managed_endpoint_address_invalid");
    }
    const authentication = await this.resolveSecret(
      scope,
      request.authentication,
      connectionGeneration,
      signal,
    );
    if (signal.aborted) {
      authentication.discard();
      throwIfAborted(signal);
    }
    return Object.freeze({
      kind: "managed_process_endpoint" as const,
      processAddress: request.address,
      endpointIdentity: createHash("sha256")
        .update(JSON.stringify(request.route))
        .update("\0")
        .update(authentication.identity.secretIdentity)
        .digest("base64url"),
      authentication,
    });
  }

  async openOwnedProcess(
    scope: EnvironmentChannelScope,
    input: {
      readonly prepared: PreparedEnvironmentOwnedProcess;
      readonly arguments: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
    },
    signal: AbortSignal,
  ): Promise<EnvironmentOwnedProcessChannel> {
    return await this.#openOwnedProcess(scope, input, signal);
  }

  async #openOwnedProcess(
    scope: EnvironmentChannelScope,
    input: {
      readonly prepared: PreparedEnvironmentOwnedProcess;
      readonly arguments: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
    },
    signal: AbortSignal,
  ): Promise<EnvironmentOwnedProcessChannel> {
    this.#assertScope(scope);
    assertCleanupPolicy(input.cleanup);
    if (
      !this.#prepared.has(input.prepared) ||
      !sameEnvironmentChannelScope(input.prepared.scope, scope)
    ) {
      throw new Error("environment_owned_process_preparation_invalid");
    }
    if (signal.aborted) throw signal.reason;
    let child: ChildProcessWithoutNullStreams;
    let windowsOwnership:
      Awaited<ReturnType<typeof spawnWindowsOwnedProcess>> | undefined;
    if (process.platform === "win32") {
      windowsOwnership = await spawnWindowsOwnedProcess({
        executable: input.prepared.executable.canonicalPath,
        arguments: input.arguments,
        cwd: input.prepared.workingDirectory.canonicalPath,
        environment: input.environment,
        signal,
      });
      child = windowsOwnership.child;
    } else {
      child = spawn(
        input.prepared.executable.canonicalPath,
        [...input.arguments],
        {
          cwd: input.prepared.workingDirectory.canonicalPath,
          detached: true,
          env: input.environment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ) as ChildProcessWithoutNullStreams;
      const outcome = await waitForSpawn(child, signal);
      if (outcome.kind === "failed") {
        await cleanupSpawnFailure(child, input.cleanup);
        throw outcome.error;
      }
    }
    const channel = new LocalOwnedProcessChannel({
      scope,
      prepared: input.prepared,
      child,
      windowsOwnership,
      cleanup: input.cleanup,
    });
    if (signal.aborted) {
      await channel.close("environment_owned_process_open_aborted");
      throw signal.reason;
    }
    return channel;
  }

  async openOwnedPty(
    scope: EnvironmentChannelScope,
    input: {
      readonly prepared: PreparedEnvironmentOwnedProcess;
      readonly arguments: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly initialSize: EnvironmentPtySize;
      readonly terminalType: string;
      readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
    },
    signal: AbortSignal,
  ): Promise<EnvironmentOwnedPtyChannel> {
    this.#assertScope(scope);
    assertCleanupPolicy(input.cleanup);
    assertPtySize(input.initialSize);
    assertTerminalType(input.terminalType);
    if (
      !this.#prepared.has(input.prepared) ||
      !sameEnvironmentChannelScope(input.prepared.scope, scope)
    ) {
      throw new Error("environment_owned_pty_preparation_invalid");
    }
    if (signal.aborted) throw signal.reason;
    let pty: IPty;
    try {
      const { spawn: spawnPty } = await import("node-pty");
      pty = spawnPty(
        input.prepared.executable.canonicalPath,
        [...input.arguments],
        {
          cwd: input.prepared.workingDirectory.canonicalPath,
          env: { ...input.environment },
          name: input.terminalType,
          cols: input.initialSize.columns,
          rows: input.initialSize.rows,
          // node-pty delivers Buffer values when encoding is explicitly null.
          encoding: null,
        },
      );
    } catch (error) {
      throw new Error("environment_owned_pty_spawn_failed", { cause: error });
    }
    let channel!: EnvironmentOwnedPtyChannel;
    channel = new LocalOwnedPtyChannel({
      scope,
      prepared: input.prepared,
      pty,
      cleanup: input.cleanup,
      onClosed: () => this.#ownedPtyChannels.delete(channel),
    });
    this.#ownedPtyChannels.add(channel);
    if (signal.aborted || this.#closed) {
      await channel.close("environment_owned_pty_open_aborted");
      throw signal.aborted
        ? signal.reason
        : new Error("execution_environment_channel_unavailable");
    }
    return channel;
  }

  async openPrivateUnixStream(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
  ): Promise<EnvironmentPrivateUnixStreamChannel> {
    this.#assertScope(scope);
    if (signal.aborted) throw signal.reason;
    const before = await inspectPrivateUnixSocket(configuredPath);
    if (signal.aborted) throw signal.reason;
    const socket = createConnection({ path: configuredPath });
    try {
      await waitForPrivateUnixConnect(
        socket,
        PRIVATE_UNIX_CONNECT_TIMEOUT_MILLISECONDS,
        signal,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
    let after: PrivateUnixFilesystemSnapshot;
    try {
      after = await inspectPrivateUnixSocket(configuredPath);
    } catch {
      socket.destroy();
      throw new Error("environment_private_unix_stream_identity_replaced");
    }
    if (!samePrivateUnixFilesystemSnapshot(before, after)) {
      socket.destroy();
      throw new Error("environment_private_unix_stream_identity_replaced");
    }
    if (signal.aborted || this.#closed) {
      socket.destroy();
      throw signal.aborted
        ? signal.reason
        : new Error("execution_environment_channel_unavailable");
    }
    let channel!: EnvironmentPrivateUnixStreamChannel;
    channel = new LocalPrivateUnixStreamChannel({
      scope,
      configuredPath,
      filesystemSnapshot: after,
      socketIdentity: after.socketIdentity,
      socket,
      onClosed: () => this.#privateUnixChannels.delete(channel),
    });
    this.#privateUnixChannels.add(channel);
    return channel;
  }

  async openAssuredTcpStream(
    scope: EnvironmentChannelScope,
    route: EnvironmentTcpRoute,
    connectionGeneration: number,
    authenticationIdentity: EnvironmentSecretIdentity,
    signal: AbortSignal,
  ): Promise<EnvironmentAssuredTcpStreamChannel> {
    this.#assertScope(scope);
    assertTcpRoute(route);
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration <= 0
    ) {
      throw new Error("environment_assured_tcp_stream_generation_invalid");
    }
    if (
      !this.#activeSecrets.has(authenticationIdentity) ||
      authenticationIdentity.connectionGeneration !== connectionGeneration ||
      !sameEnvironmentChannelScope(authenticationIdentity.scope, scope)
    ) {
      throw new Error("environment_assured_tcp_stream_authentication_invalid");
    }
    if (signal.aborted) throw signal.reason;
    const socket =
      route.security === "tls"
        ? createTlsConnection({
            host: route.host,
            port: route.port,
            ...(isIpLiteral(route.host) ? {} : { servername: route.host }),
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
          })
        : createConnection({ host: route.host, port: route.port });
    try {
      await waitForTcpConnect(socket, route, signal);
    } catch (error) {
      socket.destroy();
      this.#discardSecret(authenticationIdentity);
      throw error;
    }
    if (signal.aborted || this.#closed) {
      socket.destroy();
      this.#discardSecret(authenticationIdentity);
      throw signal.aborted
        ? signal.reason
        : new Error("execution_environment_channel_unavailable");
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    let channel!: EnvironmentAssuredTcpStreamChannel;
    try {
      channel = new LocalAssuredTcpStreamChannel({
        scope,
        route,
        connectionGeneration,
        authenticationIdentity,
        socket,
        onClosed: () => {
          this.#assuredTcpChannels.delete(channel);
          this.#discardSecret(authenticationIdentity);
        },
      });
    } catch (error) {
      socket.destroy();
      this.#discardSecret(authenticationIdentity);
      throw error;
    }
    this.#assuredTcpChannels.add(channel);
    return channel;
  }

  async resolveSecret(
    scope: EnvironmentChannelScope,
    reference: EnvironmentSecretReference,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<ResolvedEnvironmentSecret> {
    this.#assertScope(scope);
    throwIfAborted(signal);
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration <= 0
    ) {
      throw new Error("environment_secret_generation_invalid");
    }
    const value = await Promise.resolve(
      reference.source === "environment"
        ? resolveEnvironmentSecret(this.#environment, reference.variable)
        : resolveProtectedFileSecret(reference.path, signal),
    );
    // Secret resolution is an asynchronous capability boundary even for an
    // environment-backed value. Close must linearize before identity minting
    // and prevent a resolved value from escaping a closed provider.
    this.#assertScope(scope);
    throwIfAborted(signal);
    assertCapabilityToken(value);
    const secretIdentity = createHmac("sha256", this.#secretIdentityKey)
      .update(reference.source)
      .update("\0")
      .update(
        reference.source === "environment"
          ? reference.variable
          : reference.path,
      )
      .update("\0")
      .update(value)
      .update("\0")
      .update(String(connectionGeneration))
      .digest("base64url");
    const identity = createEnvironmentSecretIdentity({
      kind: "environment_secret",
      scope: Object.freeze({ ...scope }),
      connectionGeneration,
      secretIdentity,
    });
    this.#activeSecrets.add(identity);
    let discarded = false;
    return Object.freeze({
      identity,
      value,
      discard: () => {
        if (discarded) return;
        discarded = true;
        this.#discardSecret(identity);
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const channel of this.#privateUnixChannels) {
      channel.destroyClient("execution_environment_channel_closed");
    }
    this.#privateUnixChannels.clear();
    for (const channel of this.#assuredTcpChannels) {
      channel.destroyClient("execution_environment_channel_closed");
    }
    this.#assuredTcpChannels.clear();
    for (const channel of this.#ownedPtyChannels) {
      void channel
        .close("execution_environment_channel_closed")
        .catch(() => undefined);
    }
    this.#ownedPtyChannels.clear();
    for (const identity of this.#activeSecrets) {
      revokeEnvironmentSecretIdentity(identity);
    }
    this.#activeSecrets.clear();
  }

  #assertScope(scope: EnvironmentChannelScope): void {
    if (
      this.#closed ||
      !validEnvironmentChannelScope(scope) ||
      !sameRequestScope(this.scope, scope) ||
      scope.executionEnvironmentId !== this.executionEnvironmentId
    ) {
      throw new Error("execution_environment_channel_unavailable");
    }
  }

  #discardSecret(identity: EnvironmentSecretIdentity): void {
    if (!this.#activeSecrets.delete(identity)) return;
    revokeEnvironmentSecretIdentity(identity);
  }
}

class LocalAssuredTcpStreamChannel implements EnvironmentAssuredTcpStreamChannel {
  readonly identity: EnvironmentAssuredTcpStreamIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  readonly #socket: Socket | TLSSocket;
  readonly #onClosed: () => void;
  readonly #resolveClosed: (
    closure: EnvironmentPrivateUnixStreamClosure,
  ) => void;
  #acceptingWrites = true;
  #closeReason: string | undefined;
  #socketError: Error | undefined;
  #closedSettled = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly scope: EnvironmentChannelScope;
    readonly route: EnvironmentTcpRoute;
    readonly connectionGeneration: number;
    readonly authenticationIdentity: EnvironmentSecretIdentity;
    readonly socket: Socket | TLSSocket;
    readonly onClosed: () => void;
  }) {
    this.#socket = input.socket;
    this.#onClosed = input.onClosed;
    const routeIdentityHash = createHash("sha256")
      .update(input.route.security)
      .update("\0")
      .update(input.route.host)
      .update("\0")
      .update(String(input.route.port))
      .update("\0")
      .update(
        input.route.security === "tls" ? input.route.trustPolicy : "loopback",
      );
    if (
      input.route.security === "tls" &&
      "getPeerCertificate" in input.socket
    ) {
      const peer = input.socket.getPeerCertificate(true);
      if (!peer.raw || peer.raw.byteLength === 0) {
        input.socket.destroy();
        throw new Error("environment_assured_tcp_stream_tls_identity_invalid");
      }
      routeIdentityHash.update(peer.raw);
    }
    const routeIdentity = routeIdentityHash.digest("base64url");
    this.identity = createEnvironmentAssuredTcpStreamIdentity({
      kind: "assured_tcp_stream",
      scope: Object.freeze({ ...input.scope }),
      channelId: randomUUID(),
      connectionGeneration: input.connectionGeneration,
      authenticationIdentity: input.authenticationIdentity,
      routeIdentity,
      transportSecurity:
        input.route.security === "tls"
          ? Object.freeze({
              type: "tls" as const,
              chainVerified: true as const,
              peerIdentityVerified: true as const,
              trustPolicy: "platform" as const,
            })
          : Object.freeze({
              type: "loopback_plaintext" as const,
              loopbackVerified: true as const,
            }),
    });
    this.bytes = byteIterable(input.socket);
    let resolveClosed!: (closure: EnvironmentPrivateUnixStreamClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    input.socket.on("error", () => {
      this.#socketError = new Error(
        "environment_assured_tcp_stream_socket_error",
      );
    });
    input.socket.once("close", () => this.#settleClosed());
    input.socket.once("end", () => {
      if (!this.#closeReason) this.#acceptingWrites = false;
    });
    if (input.socket.destroyed) queueMicrotask(() => this.#settleClosed());
  }

  async write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#acceptingWrites || !this.#socket.writable) {
      throw new EnvironmentStreamWriteError(
        "environment_assured_tcp_stream_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new EnvironmentStreamWriteError(
        "environment_assured_tcp_stream_write_aborted",
        "not_sent",
      );
    }
    if (bytes.byteLength === 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        finish(
          new EnvironmentStreamWriteError(
            "environment_assured_tcp_stream_write_aborted_during_write",
            "sent_outcome_unknown",
          ),
        );
        this.destroyClient("environment_assured_tcp_stream_write_aborted");
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      this.#socket.write(Buffer.from(bytes), (error) =>
        finish(
          error
            ? new EnvironmentStreamWriteError(
                "environment_assured_tcp_stream_write_failed",
                "sent_outcome_unknown",
              )
            : undefined,
        ),
      );
      if (options?.signal?.aborted) abort();
    });
  }

  closeClient(reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  destroyClient(reason: string): void {
    if (!this.#closeReason) this.#closeReason = boundedReason(reason);
    this.#acceptingWrites = false;
    this.#socket.destroy();
  }

  async #performClose(reason: string): Promise<void> {
    if (!this.#closeReason) this.#closeReason = boundedReason(reason);
    this.#acceptingWrites = false;
    if (!this.#socket.destroyed) this.#socket.end();
    if (!(await waitForPromise(this.closed, TCP_CLIENT_CLOSE_MILLISECONDS))) {
      this.#socket.destroy();
      if (!(await waitForPromise(this.closed, TCP_CLIENT_CLOSE_MILLISECONDS))) {
        throw new Error(
          "environment_assured_tcp_stream_close_deadline_exceeded",
        );
      }
    }
  }

  #settleClosed(): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#acceptingWrites = false;
    revokeEnvironmentAssuredTcpStreamIdentity(this.identity);
    this.#onClosed();
    this.#resolveClosed(
      Object.freeze(
        this.#socketError
          ? { reason: "socket_error" as const, cause: this.#socketError }
          : this.#closeReason
            ? { reason: "client_closed" as const }
            : { reason: "peer_closed" as const },
      ),
    );
  }
}

class LocalPrivateUnixStreamChannel implements EnvironmentPrivateUnixStreamChannel {
  readonly identity: EnvironmentPrivateUnixStreamIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  readonly #socket: Socket;
  readonly #configuredPath: string;
  readonly #filesystemSnapshot: PrivateUnixFilesystemSnapshot;
  readonly #onClosed: () => void;
  readonly #resolveClosed: (
    closure: EnvironmentPrivateUnixStreamClosure,
  ) => void;
  #acceptingWrites = true;
  #closeReason: string | undefined;
  #socketError: Error | undefined;
  #closedSettled = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly scope: EnvironmentChannelScope;
    readonly configuredPath: string;
    readonly filesystemSnapshot: PrivateUnixFilesystemSnapshot;
    readonly socketIdentity: string;
    readonly socket: Socket;
    readonly onClosed: () => void;
  }) {
    this.#socket = input.socket;
    this.#configuredPath = input.configuredPath;
    this.#filesystemSnapshot = input.filesystemSnapshot;
    this.#onClosed = input.onClosed;
    this.identity = createEnvironmentPrivateUnixStreamIdentity({
      kind: "private_unix_stream",
      scope: Object.freeze({ ...input.scope }),
      channelId: randomUUID(),
      socketIdentity: input.socketIdentity,
      filesystemIdentity: Object.freeze({
        ownerVerified: true,
        parentMode: "0700",
        socketMode: "0600",
      }),
    });
    this.bytes = byteIterable(input.socket);
    let resolveClosed!: (closure: EnvironmentPrivateUnixStreamClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    input.socket.on("error", () => {
      this.#socketError = new Error(
        "environment_private_unix_stream_socket_error",
      );
    });
    input.socket.once("close", () => this.#settleClosed());
    input.socket.once("end", () => {
      if (!this.#closeReason) this.#acceptingWrites = false;
    });
    if (input.socket.destroyed) queueMicrotask(() => this.#settleClosed());
  }

  async write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#acceptingWrites || !this.#socket.writable) {
      throw new EnvironmentStreamWriteError(
        "environment_private_unix_stream_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new EnvironmentStreamWriteError(
        "environment_private_unix_stream_write_aborted",
        "not_sent",
      );
    }
    if (bytes.byteLength === 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        finish(
          new EnvironmentStreamWriteError(
            "environment_private_unix_stream_write_aborted_during_write",
            "sent_outcome_unknown",
            { cause: options?.signal?.reason },
          ),
        );
        this.destroyClient("environment_private_unix_stream_write_aborted");
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      this.#socket.write(Buffer.from(bytes), (error) =>
        finish(
          error
            ? new EnvironmentStreamWriteError(
                "environment_private_unix_stream_write_failed",
                "sent_outcome_unknown",
                { cause: error },
              )
            : undefined,
        ),
      );
      if (options?.signal?.aborted) abort();
    });
  }

  closeClient(reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  async revalidateIdentity(): Promise<void> {
    if (this.#closedSettled || this.#socket.destroyed) {
      throw new Error("environment_private_unix_stream_closed");
    }
    let current: PrivateUnixFilesystemSnapshot;
    try {
      current = await inspectPrivateUnixSocket(this.#configuredPath);
    } catch {
      this.destroyClient("environment_private_unix_stream_identity_replaced");
      throw new Error("environment_private_unix_stream_identity_replaced");
    }
    if (!samePrivateUnixFilesystemSnapshot(this.#filesystemSnapshot, current)) {
      this.destroyClient("environment_private_unix_stream_identity_replaced");
      throw new Error("environment_private_unix_stream_identity_replaced");
    }
  }

  destroyClient(reason: string): void {
    if (!this.#closeReason) this.#closeReason = boundedReason(reason);
    this.#acceptingWrites = false;
    this.#socket.destroy();
  }

  async #performClose(reason: string): Promise<void> {
    if (!this.#closeReason) this.#closeReason = boundedReason(reason);
    this.#acceptingWrites = false;
    if (!this.#socket.destroyed) this.#socket.end();
    if (
      !(await waitForPromise(
        this.closed,
        PRIVATE_UNIX_CLIENT_CLOSE_MILLISECONDS,
      ))
    ) {
      this.#socket.destroy();
      if (
        !(await waitForPromise(
          this.closed,
          PRIVATE_UNIX_CLIENT_CLOSE_MILLISECONDS,
        ))
      ) {
        throw new Error(
          "environment_private_unix_stream_close_deadline_exceeded",
        );
      }
    }
  }

  #settleClosed(): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#acceptingWrites = false;
    revokeEnvironmentPrivateUnixStreamIdentity(this.identity);
    this.#onClosed();
    this.#resolveClosed(
      Object.freeze(
        this.#socketError
          ? { reason: "socket_error" as const, cause: this.#socketError }
          : this.#closeReason
            ? { reason: "client_closed" as const }
            : { reason: "peer_closed" as const },
      ),
    );
  }
}

async function waitForPrivateUnixConnect(
  socket: Socket,
  timeoutMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(new Error("environment_private_unix_stream_connect_timeout")),
      timeoutMilliseconds,
    );
    timer.unref?.();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("environment_private_unix_stream_connect_aborted"),
      );
    const connected = () => finish();
    const failed = () =>
      finish(new Error("environment_private_unix_stream_connect_failed"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", connected);
    socket.once("error", failed);
    if (signal.aborted) abort();
  });
}

function assertTcpRoute(route: EnvironmentTcpRoute): void {
  if (
    !Number.isSafeInteger(route.port) ||
    route.port < 1 ||
    route.port > 65_535 ||
    route.host.length === 0 ||
    route.host.length > 253 ||
    /[^\u0021-\u007e]/u.test(route.host) ||
    (route.security === "loopback_plaintext" &&
      route.host !== "127.0.0.1" &&
      route.host !== "::1") ||
    (route.security === "tls" && route.trustPolicy !== "platform")
  ) {
    throw new Error("environment_assured_tcp_stream_route_invalid");
  }
  if (
    route.security === "tls" &&
    route.host !== "127.0.0.1" &&
    route.host !== "::1"
  ) {
    throw new Error(
      "environment_assured_tcp_stream_remote_environment_required",
    );
  }
}

function resolveEnvironmentSecret(
  environment: Readonly<Record<string, string | undefined>>,
  variable: string,
): string {
  if (!/^SEDES_CODEX_[A-Z0-9_]*TOKEN[A-Z0-9_]*$/u.test(variable)) {
    throw new Error("environment_secret_reference_invalid");
  }
  const value = environment[variable];
  if (value === undefined) {
    throw new Error("environment_secret_unavailable");
  }
  return value;
}

async function resolveProtectedFileSecret(
  configuredPath: string,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  assertConfiguredPath(configuredPath);
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    const parentPath = path.dirname(configuredPath);
    const canonicalParent = await realpath(parentPath);
    throwIfAborted(signal);
    const parent = await lstat(parentPath, { bigint: true });
    const canonicalPath = await realpath(configuredPath);
    const before = await lstat(configuredPath, { bigint: true });
    throwIfAborted(signal);
    if (canonicalPath !== configuredPath || canonicalParent !== parentPath) {
      throw new Error("environment_secret_file_path_unsafe");
    }
    const effectiveUserId = BigInt(
      process.geteuid?.() ?? process.getuid?.() ?? -1,
    );
    if (
      effectiveUserId < 0n ||
      !parent.isDirectory() ||
      parent.uid !== effectiveUserId ||
      (parent.mode & 0o077n) !== 0n ||
      !before.isFile()
    ) {
      throw new Error("environment_secret_file_identity_invalid");
    }
    handle = await openFile(
      configuredPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    throwIfAborted(signal);
    const opened = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    const mode = opened.mode & 0o777n;
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.ctimeNs !== opened.ctimeNs ||
      opened.uid !== effectiveUserId ||
      (mode !== 0o400n && mode !== 0o600n) ||
      opened.nlink !== 1n ||
      opened.size <= 0n ||
      opened.size > BigInt(MAXIMUM_CAPABILITY_TOKEN_BYTES + 2)
    ) {
      throw new Error("environment_secret_file_identity_invalid");
    }
    const bytes = await handle.readFile({ signal });
    const after = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.ctimeNs !== after.ctimeNs ||
      opened.size !== after.size
    ) {
      throw new Error("environment_secret_file_identity_replaced");
    }
    let canonicalParentAfter: string;
    let parentAfter: BigIntStats;
    let canonicalPathAfter: string;
    let pathAfter: BigIntStats;
    try {
      canonicalParentAfter = await realpath(parentPath);
      parentAfter = await lstat(parentPath, { bigint: true });
      canonicalPathAfter = await realpath(configuredPath);
      pathAfter = await lstat(configuredPath, { bigint: true });
      throwIfAborted(signal);
    } catch {
      throw new Error("environment_secret_file_identity_replaced");
    }
    if (
      canonicalParentAfter !== parentPath ||
      canonicalPathAfter !== configuredPath ||
      parent.dev !== parentAfter.dev ||
      parent.ino !== parentAfter.ino ||
      parent.ctimeNs !== parentAfter.ctimeNs ||
      opened.dev !== pathAfter.dev ||
      opened.ino !== pathAfter.ino ||
      opened.ctimeNs !== pathAfter.ctimeNs ||
      opened.size !== pathAfter.size
    ) {
      throw new Error("environment_secret_file_identity_replaced");
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("environment_secret_malformed");
    }
    return value.endsWith("\r\n")
      ? value.slice(0, -2)
      : value.endsWith("\n")
        ? value.slice(0, -1)
        : value;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("environment_secret_")
    ) {
      throw error;
    }
    throw new Error("environment_secret_file_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertCapabilityToken(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < 16 ||
    bytes > MAXIMUM_CAPABILITY_TOKEN_BYTES ||
    !/^[A-Za-z0-9._~+\/-]+={0,2}$/u.test(value)
  ) {
    throw new Error("environment_secret_malformed");
  }
}

function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0;
}

async function waitForTcpConnect(
  socket: Socket | TLSSocket,
  route: EnvironmentTcpRoute,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("environment_assured_tcp_stream_connect_timeout")),
      TCP_CONNECT_TIMEOUT_MILLISECONDS,
    );
    timer.unref?.();
    const event = route.security === "tls" ? "secureConnect" : "connect";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.removeListener(event, connected);
      socket.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("environment_assured_tcp_stream_connect_aborted"),
      );
    const connected = () => {
      if (
        route.security === "tls" &&
        (!(socket instanceof Object) ||
          !("authorized" in socket) ||
          socket.authorized !== true)
      ) {
        finish(
          new Error("environment_assured_tcp_stream_tls_identity_invalid"),
        );
        return;
      }
      const remoteAddress = socket.remoteAddress;
      if (
        remoteAddress !== "127.0.0.1" &&
        remoteAddress !== "::1" &&
        remoteAddress !== "::ffff:127.0.0.1"
      ) {
        finish(new Error("environment_assured_tcp_stream_route_invalid"));
        return;
      }
      finish();
    };
    const failed = (error: NodeJS.ErrnoException) => {
      const retryable = new Set([
        "ECONNREFUSED",
        "ECONNRESET",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ETIMEDOUT",
      ]).has(error.code ?? "");
      finish(
        new Error(
          retryable
            ? "environment_assured_tcp_stream_unavailable"
            : route.security === "tls"
              ? "environment_assured_tcp_stream_tls_identity_invalid"
              : "environment_assured_tcp_stream_connect_failed",
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once(event, connected);
    socket.once("error", failed);
    if (signal.aborted) abort();
  });
}

function boundedReason(reason: string): string {
  return reason.length <= 256 ? reason : reason.slice(0, 256);
}

async function waitForPromise(
  promise: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class LocalOwnedPtyChannel implements EnvironmentOwnedPtyChannel {
  readonly identity: EnvironmentOwnedPtyIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentProcessClosure>;
  readonly #pty: IPty;
  readonly #cleanup: EnvironmentOwnedProcessCleanupPolicy;
  readonly #output: PausablePtyByteQueue;
  readonly #onClosed: () => void;
  readonly #processGroupId: number;
  #acceptingWrites = true;
  #closedSettled = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly scope: EnvironmentChannelScope;
    readonly prepared: PreparedEnvironmentOwnedProcess;
    readonly pty: IPty;
    readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
    readonly onClosed: () => void;
  }) {
    if (!Number.isSafeInteger(input.pty.pid) || input.pty.pid <= 0) {
      killPty(input.pty, "SIGKILL");
      throw new Error("environment_owned_pty_identity_unavailable");
    }
    this.#pty = input.pty;
    this.#processGroupId = input.pty.pid;
    this.#cleanup = input.cleanup;
    this.#onClosed = input.onClosed;
    this.identity = createEnvironmentOwnedPtyIdentity({
      kind: "owned_pty",
      scope: Object.freeze({ ...input.scope }),
      channelId: randomUUID(),
      executable: input.prepared.executable,
    });
    this.#output = new PausablePtyByteQueue(input.pty);
    this.bytes = this.#output;
    let resolveClosed!: (closure: EnvironmentProcessClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    input.pty.onData((data: string | Uint8Array) => {
      // With encoding:null node-pty supplies Buffer at runtime. The published
      // IPty declaration retains the historical string-only event signature.
      this.#output.push(
        typeof data === "string"
          ? Buffer.from(data, "utf8")
          : new Uint8Array(data),
      );
    });
    input.pty.onExit(({ exitCode, signal }) => {
      if (this.#closedSettled) return;
      this.#closedSettled = true;
      this.#acceptingWrites = false;
      this.#output.end();
      this.#onClosed();
      resolveClosed(
        Object.freeze({
          reason: "exit" as const,
          exitCode,
          signal: signalName(signal),
        }),
      );
    });
  }

  async write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#acceptingWrites) {
      throw new EnvironmentProcessWriteError(
        "environment_owned_pty_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new EnvironmentProcessWriteError(
        "environment_owned_pty_write_aborted",
        "not_sent",
        { cause: options.signal.reason },
      );
    }
    if (bytes.byteLength > MAXIMUM_PTY_WRITE_BYTES) {
      throw new EnvironmentProcessWriteError(
        "environment_owned_pty_write_too_large",
        "not_sent",
      );
    }
    if (bytes.byteLength === 0) return;
    try {
      this.#pty.write(Buffer.from(bytes));
      if (options?.signal?.aborted) {
        throw new EnvironmentProcessWriteError(
          "environment_owned_pty_write_aborted_during_write",
          "sent_outcome_unknown",
          { cause: options.signal.reason },
        );
      }
    } catch (cause) {
      if (cause instanceof EnvironmentProcessWriteError) throw cause;
      throw new EnvironmentProcessWriteError(
        "environment_owned_pty_write_failed",
        "sent_outcome_unknown",
        { cause },
      );
    }
  }

  resize(size: EnvironmentPtySize): void {
    assertPtySize(size);
    if (!this.#acceptingWrites) {
      throw new Error("environment_owned_pty_closed");
    }
    try {
      this.#pty.resize(size.columns, size.rows);
    } catch (cause) {
      throw new Error("environment_owned_pty_resize_failed", { cause });
    }
  }

  close(_reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#acceptingWrites = false;
    const processGroupId = this.#processGroupId;
    if (process.platform === "win32") {
      killPty(this.#pty, "SIGKILL");
      if (
        !(await waitForPromise(this.closed, this.#cleanup.killMilliseconds))
      ) {
        throw new Error("environment_owned_pty_close_deadline_exceeded");
      }
      return;
    }
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGHUP");
      await waitForProcessGroupGone(
        processGroupId,
        this.#cleanup.gracefulCloseMilliseconds,
      );
    }
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGTERM");
      await waitForProcessGroupGone(
        processGroupId,
        this.#cleanup.terminateMilliseconds,
      );
    }
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGKILL");
      await waitForProcessGroupGone(
        processGroupId,
        this.#cleanup.killMilliseconds,
      );
    }
    if (processGroupExists(processGroupId)) {
      throw new Error("environment_owned_pty_process_group_survived");
    }
    if (!(await waitForPromise(this.closed, this.#cleanup.killMilliseconds))) {
      throw new Error("environment_owned_pty_close_deadline_exceeded");
    }
  }
}

class PausablePtyByteQueue implements AsyncIterable<Uint8Array> {
  readonly #pty: IPty;
  readonly #chunks: Uint8Array[] = [];
  readonly #waiters: Array<() => void> = [];
  #queuedBytes = 0;
  #ended = false;
  #paused = false;
  #claimed = false;

  constructor(pty: IPty) {
    this.#pty = pty;
  }

  push(bytes: Uint8Array): void {
    if (this.#ended || bytes.byteLength === 0) return;
    const owned = Uint8Array.from(bytes);
    this.#chunks.push(owned);
    this.#queuedBytes += owned.byteLength;
    if (!this.#paused && this.#queuedBytes >= PTY_OUTPUT_HIGH_WATER_BYTES) {
      this.#paused = true;
      this.#pty.pause();
    }
    this.#wake();
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#claimed) {
      throw new Error("environment_owned_pty_output_already_consumed");
    }
    this.#claimed = true;
    return {
      next: async () => {
        while (this.#chunks.length === 0 && !this.#ended) {
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
        const chunk = this.#chunks.shift();
        if (!chunk) return { done: true, value: undefined };
        this.#queuedBytes -= chunk.byteLength;
        if (this.#paused && this.#queuedBytes <= PTY_OUTPUT_LOW_WATER_BYTES) {
          this.#paused = false;
          this.#pty.resume();
        }
        return { done: false, value: chunk };
      },
    };
  }

  #wake(): void {
    for (const wake of this.#waiters.splice(0)) wake();
  }
}

class LocalOwnedProcessChannel implements EnvironmentOwnedProcessChannel {
  readonly identity: EnvironmentOwnedProcessIdentity;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentProcessClosure>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #cleanup: EnvironmentOwnedProcessCleanupPolicy;
  readonly #windowsOwnership:
    Awaited<ReturnType<typeof spawnWindowsOwnedProcess>> | undefined;
  #acceptingWrites = true;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly scope: EnvironmentChannelScope;
    readonly prepared: PreparedEnvironmentOwnedProcess;
    readonly child: ChildProcessWithoutNullStreams;
    readonly windowsOwnership?:
      Awaited<ReturnType<typeof spawnWindowsOwnedProcess>> | undefined;
    readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
  }) {
    const processId = input.child.pid;
    if (!processId) {
      throw new Error("environment_owned_process_identity_unavailable");
    }
    this.#child = input.child;
    this.#windowsOwnership = input.windowsOwnership;
    this.#cleanup = input.cleanup;
    const channelId = randomUUID();
    const identity = createEnvironmentOwnedProcessIdentity({
      kind: "owned_process" as const,
      scope: Object.freeze({ ...input.scope }),
      channelId,
      executable: input.prepared.executable,
      providerProcessIdentity: input.windowsOwnership
        ? Object.freeze({
            type: "windows_job" as const,
            supervisorProcessId: processId,
            jobId: channelId,
          })
        : Object.freeze({
            type: "local_process_group" as const,
            processId,
            processGroupId: processId,
          }),
    });
    this.identity = identity;
    this.stdout = byteIterable(input.child.stdout);
    this.stderr = byteIterable(input.child.stderr);
    input.child.stdin.on("error", () => undefined);
    this.closed = input.windowsOwnership?.closed ?? processClosure(input.child);
  }

  async writeStdin(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#acceptingWrites || !this.#child.stdin.writable) {
      throw new EnvironmentProcessWriteError(
        "environment_owned_process_stdin_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new EnvironmentProcessWriteError(
        "environment_owned_process_write_aborted",
        "not_sent",
        { cause: options.signal.reason },
      );
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(
          new EnvironmentProcessWriteError(
            "environment_owned_process_write_aborted_during_write",
            "sent_outcome_unknown",
            { cause: options?.signal?.reason },
          ),
        );
      options?.signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(Buffer.from(bytes), (error) =>
        finish(
          error
            ? new EnvironmentProcessWriteError(
                "environment_owned_process_write_failed",
                "sent_outcome_unknown",
                { cause: error },
              )
            : undefined,
        ),
      );
      if (options?.signal?.aborted) abort();
    });
  }

  closeStdin(): void {
    if (!this.#acceptingWrites) return;
    this.#acceptingWrites = false;
    this.#child.stdin.end();
  }

  close(_reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.closeStdin();
    await raceWithCleanupDelay(
      this.closed,
      this.#cleanup.gracefulCloseMilliseconds,
    );
    if (this.#windowsOwnership) {
      await this.#windowsOwnership.close(this.#cleanup.killMilliseconds);
      return;
    }
    if (this.identity.providerProcessIdentity.type !== "local_process_group") {
      throw new Error("environment_owned_process_ownership_unavailable");
    }
    const processGroupId = this.identity.providerProcessIdentity.processGroupId;
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGTERM");
      await waitForProcessGroupGone(
        processGroupId,
        this.#cleanup.terminateMilliseconds,
      );
    }
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGKILL");
      await waitForProcessGroupGone(
        processGroupId,
        this.#cleanup.killMilliseconds,
      );
    }
    await raceWithCleanupDelay(this.closed, this.#cleanup.killMilliseconds);
    if (processGroupExists(processGroupId)) {
      throw new Error("environment_owned_process_group_survived");
    }
  }
}

function assertCleanupPolicy(
  policy: EnvironmentOwnedProcessCleanupPolicy,
): void {
  if (
    Object.values(policy).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error("environment_owned_process_cleanup_invalid");
  }
}

function assertPtySize(size: EnvironmentPtySize): void {
  if (
    !Number.isSafeInteger(size.columns) ||
    size.columns < 2 ||
    size.columns > 1_000 ||
    !Number.isSafeInteger(size.rows) ||
    size.rows < 1 ||
    size.rows > 1_000
  ) {
    throw new Error("environment_owned_pty_size_invalid");
  }
}

function assertTerminalType(terminalType: string): void {
  if (
    terminalType.length === 0 ||
    terminalType.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(terminalType)
  ) {
    throw new Error("environment_owned_pty_terminal_type_invalid");
  }
}

function signalName(signal: number | undefined): NodeJS.Signals | null {
  if (!signal) return null;
  for (const [name, number] of Object.entries(osConstants.signals)) {
    if (number === signal) return name as NodeJS.Signals;
  }
  return null;
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "spawned" }
  | { readonly kind: "failed"; readonly error: unknown }
> {
  return await new Promise((resolve) => {
    const abort = () => {
      cleanup();
      resolve({ kind: "failed", error: signal.reason });
    };
    const spawned = () => {
      cleanup();
      resolve({ kind: "spawned" });
    };
    const failed = (error: unknown) => {
      cleanup();
      resolve({ kind: "failed", error });
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", spawned);
    child.once("error", failed);
    if (signal.aborted) abort();
  });
}

async function cleanupSpawnFailure(
  child: ChildProcessWithoutNullStreams,
  cleanup: EnvironmentOwnedProcessCleanupPolicy,
): Promise<void> {
  child.stdin.destroy();
  const processId = child.pid;
  if (!processId) return;
  signalProcessGroup(processId, "SIGTERM");
  await waitForProcessGroupGone(processId, cleanup.terminateMilliseconds);
  if (processGroupExists(processId)) {
    signalProcessGroup(processId, "SIGKILL");
    await waitForProcessGroupGone(processId, cleanup.killMilliseconds);
  }
  if (processGroupExists(processId)) {
    throw new Error("environment_owned_process_group_survived");
  }
}

function processClosure(
  child: ChildProcessWithoutNullStreams,
): Promise<EnvironmentProcessClosure> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closure: EnvironmentProcessClosure) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze(closure));
    };
    child.once("exit", (exitCode, signal) =>
      finish({ reason: "exit", exitCode, signal }),
    );
    child.once("error", (cause) =>
      finish({
        reason: "spawn_error",
        exitCode: null,
        signal: null,
        cause,
      }),
    );
  });
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  if (processGroupId <= 0) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupExists(processGroupId: number): boolean {
  if (processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPty(pty: IPty, signal: NodeJS.Signals): void {
  if (process.platform === "win32") pty.kill();
  else pty.kill(signal);
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function raceWithCleanupDelay(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function byteIterable(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) yield new Uint8Array(chunk);
    },
  });
}
