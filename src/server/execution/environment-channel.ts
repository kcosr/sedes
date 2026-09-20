import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import { isAbsolute as pathIsAbsolute } from "node:path";
import type {
  ManagedWorkerArtifactRegistration,
  ManagedWorkerLaunchIdentity,
} from "../managed-workers/artifact.js";

const validOwnedProcessIdentities = new WeakSet<object>();
const validOwnedPtyIdentities = new WeakSet<object>();
const validPrivateUnixStreamIdentities = new WeakSet<object>();
const activePrivateUnixStreamIdentities = new WeakSet<object>();
const validAssuredTcpStreamIdentities = new WeakSet<object>();
const activeAssuredTcpStreamIdentities = new WeakSet<object>();
const validEnvironmentSecretIdentities = new WeakSet<object>();
const activeEnvironmentSecretIdentities = new WeakSet<object>();

export type EnvironmentChannelKind =
  "process_stdio" | "process_pty" | "unix_websocket" | "tcp_websocket";

/**
 * Exact authority for one backend connection inside one execution namespace.
 * Channel identities and assured provider transports must retain every axis.
 */
export interface EnvironmentChannelScope extends RequestScope {
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
}

export interface EnvironmentPathIdentity {
  readonly canonicalPath: string;
  readonly kind: "directory" | "executable" | "unix_socket";
}

export interface PreparedEnvironmentOwnedProcess {
  readonly kind: "owned_process";
  readonly scope: EnvironmentChannelScope;
  readonly executable: EnvironmentPathIdentity & {
    readonly kind: "executable";
  };
  readonly workingDirectory: EnvironmentPathIdentity & {
    readonly kind: "directory";
  };
}

export type EnvironmentManagedProcessEndpointRequest =
  | Readonly<{
      readonly kind: "private_unix_websocket";
      readonly socketPath: string;
    }>
  | Readonly<{
      readonly kind: "assured_tcp_websocket";
      readonly address: string;
      readonly route: EnvironmentTcpRoute;
      readonly authentication: EnvironmentSecretReference;
    }>;

export interface PreparedEnvironmentManagedProcessEndpoint {
  readonly kind: "managed_process_endpoint";
  /** Address as visible to a process launched in this environment namespace. */
  readonly processAddress: string;
  /** Opaque proof bound to the current endpoint route/inode generation. */
  readonly endpointIdentity: string;
  readonly authentication?: ResolvedEnvironmentSecret;
}

export interface EnvironmentOwnedProcessCleanupPolicy {
  readonly gracefulCloseMilliseconds: number;
  readonly terminateMilliseconds: number;
  readonly killMilliseconds: number;
}

export interface EnvironmentOwnedProcessIdentity {
  readonly kind: "owned_process";
  readonly scope: EnvironmentChannelScope;
  readonly channelId: string;
  readonly executable: EnvironmentPathIdentity & {
    readonly kind: "executable";
  };
  readonly providerProcessIdentity: Readonly<
    | {
        readonly type: "local_process_group";
        readonly processId: number;
        readonly processGroupId: number;
      }
    | {
        readonly type: "windows_job";
        readonly supervisorProcessId: number;
        readonly jobId: string;
      }
  >;
}

export interface EnvironmentPtySize {
  readonly columns: number;
  readonly rows: number;
}

export interface EnvironmentOwnedPtyIdentity {
  readonly kind: "owned_pty";
  readonly scope: EnvironmentChannelScope;
  readonly channelId: string;
  readonly executable: EnvironmentPathIdentity & {
    readonly kind: "executable";
  };
}

/** Environment-provider minting boundary; plain structural objects are invalid. */
export function createEnvironmentOwnedPtyIdentity(
  input: EnvironmentOwnedPtyIdentity,
): EnvironmentOwnedPtyIdentity {
  if (
    input.kind !== "owned_pty" ||
    !validEnvironmentChannelScope(input.scope) ||
    !input.channelId ||
    input.executable.kind !== "executable" ||
    !pathIsAbsolute(input.executable.canonicalPath)
  ) {
    throw new Error("environment_owned_pty_identity_invalid");
  }
  const identity = Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    executable: Object.freeze({ ...input.executable }),
  });
  validOwnedPtyIdentities.add(identity);
  return identity;
}

export function isValidEnvironmentOwnedPtyIdentity(
  identity: EnvironmentOwnedPtyIdentity,
): boolean {
  return validOwnedPtyIdentities.has(identity);
}

/** Environment-provider minting boundary; plain structural objects are invalid. */
export function createEnvironmentOwnedProcessIdentity(
  input: EnvironmentOwnedProcessIdentity,
): EnvironmentOwnedProcessIdentity {
  if (
    !validEnvironmentChannelScope(input.scope) ||
    !input.channelId ||
    input.executable.kind !== "executable" ||
    !pathIsAbsolute(input.executable.canonicalPath) ||
    !(input.providerProcessIdentity.type === "local_process_group"
      ? Number.isSafeInteger(input.providerProcessIdentity.processId) &&
        input.providerProcessIdentity.processId > 0 &&
        input.providerProcessIdentity.processGroupId ===
          input.providerProcessIdentity.processId
      : input.providerProcessIdentity.type === "windows_job" &&
        Number.isSafeInteger(
          input.providerProcessIdentity.supervisorProcessId,
        ) &&
        input.providerProcessIdentity.supervisorProcessId > 0 &&
        input.providerProcessIdentity.jobId === input.channelId)
  ) {
    throw new Error("environment_owned_process_identity_invalid");
  }
  const identity = Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    executable: Object.freeze({ ...input.executable }),
    providerProcessIdentity: Object.freeze({
      ...input.providerProcessIdentity,
    }),
  });
  validOwnedProcessIdentities.add(identity);
  return identity;
}

export function isValidEnvironmentOwnedProcessIdentity(
  identity: EnvironmentOwnedProcessIdentity,
): boolean {
  return validOwnedProcessIdentities.has(identity);
}

export type EnvironmentProcessClosure = Readonly<{
  readonly reason: "exit" | "spawn_error";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause?: Error;
}>;

export type EnvironmentProcessWriteDelivery =
  "not_sent" | "sent_outcome_unknown";

export class EnvironmentProcessWriteError extends Error {
  readonly delivery: EnvironmentProcessWriteDelivery;

  constructor(
    message: string,
    delivery: EnvironmentProcessWriteDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentProcessWriteError";
    this.delivery = delivery;
  }
}

export interface EnvironmentPrivateUnixStreamIdentity {
  readonly kind: "private_unix_stream";
  readonly scope: EnvironmentChannelScope;
  readonly channelId: string;
  /** Opaque identity for the canonical path and exact socket inode. */
  readonly socketIdentity: string;
  readonly filesystemIdentity: Readonly<{
    readonly ownerVerified: true;
    readonly parentMode: "0700";
    readonly socketMode: "0600";
  }>;
}

export type EnvironmentTcpRoute =
  | Readonly<{
      security: "loopback_plaintext";
      host: "127.0.0.1" | "::1";
      port: number;
    }>
  | Readonly<{
      security: "tls";
      host: string;
      port: number;
      trustPolicy: "platform";
    }>;

export type EnvironmentSecretReference =
  | Readonly<{ source: "environment"; variable: string }>
  | Readonly<{ source: "protected_file"; path: string }>;

export interface EnvironmentSecretIdentity {
  readonly kind: "environment_secret";
  readonly scope: EnvironmentChannelScope;
  readonly connectionGeneration: number;
  /** Opaque binding to the reference and exact resolved secret generation. */
  readonly secretIdentity: string;
}

export interface ResolvedEnvironmentSecret {
  readonly identity: EnvironmentSecretIdentity;
  /** Provider-private value for the carrier handshake; never normalized. */
  readonly value: string;
  /** Revokes this connection-attempt capability without exposing provider state. */
  discard(): void;
}

export function createEnvironmentSecretIdentity(
  input: EnvironmentSecretIdentity,
): EnvironmentSecretIdentity {
  if (
    input.kind !== "environment_secret" ||
    !validEnvironmentChannelScope(input.scope) ||
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration <= 0 ||
    input.secretIdentity.length === 0
  ) {
    throw new Error("environment_secret_identity_invalid");
  }
  const identity = Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
  });
  validEnvironmentSecretIdentities.add(identity);
  activeEnvironmentSecretIdentities.add(identity);
  return identity;
}

export function isValidEnvironmentSecretIdentity(
  identity: EnvironmentSecretIdentity,
): boolean {
  return (
    validEnvironmentSecretIdentities.has(identity) &&
    activeEnvironmentSecretIdentities.has(identity)
  );
}

export function revokeEnvironmentSecretIdentity(
  identity: EnvironmentSecretIdentity,
): void {
  activeEnvironmentSecretIdentities.delete(identity);
}

export interface EnvironmentAssuredTcpStreamIdentity {
  readonly kind: "assured_tcp_stream";
  readonly scope: EnvironmentChannelScope;
  readonly channelId: string;
  readonly connectionGeneration: number;
  readonly authenticationIdentity: EnvironmentSecretIdentity;
  /** Opaque binding for the exact host, port, and transport-security policy. */
  readonly routeIdentity: string;
  readonly transportSecurity:
    | Readonly<{
        readonly type: "loopback_plaintext";
        readonly loopbackVerified: true;
      }>
    | Readonly<{
        readonly type: "tls";
        readonly chainVerified: true;
        readonly peerIdentityVerified: true;
        readonly trustPolicy: "platform";
      }>;
}

/** Environment-provider minting boundary; plain structural objects are invalid. */
export function createEnvironmentAssuredTcpStreamIdentity(
  input: EnvironmentAssuredTcpStreamIdentity,
): EnvironmentAssuredTcpStreamIdentity {
  const validSecurity =
    (input.transportSecurity.type === "loopback_plaintext" &&
      input.transportSecurity.loopbackVerified === true) ||
    (input.transportSecurity.type === "tls" &&
      input.transportSecurity.chainVerified === true &&
      input.transportSecurity.peerIdentityVerified === true &&
      input.transportSecurity.trustPolicy === "platform");
  if (
    !validEnvironmentChannelScope(input.scope) ||
    input.kind !== "assured_tcp_stream" ||
    input.channelId.length === 0 ||
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration <= 0 ||
    !isValidEnvironmentSecretIdentity(input.authenticationIdentity) ||
    input.authenticationIdentity.connectionGeneration !==
      input.connectionGeneration ||
    !sameEnvironmentChannelScope(
      input.scope,
      input.authenticationIdentity.scope,
    ) ||
    input.routeIdentity.length === 0 ||
    !validSecurity
  ) {
    throw new Error("environment_assured_tcp_stream_identity_invalid");
  }
  const identity = Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    transportSecurity: Object.freeze({ ...input.transportSecurity }),
  });
  validAssuredTcpStreamIdentities.add(identity);
  activeAssuredTcpStreamIdentities.add(identity);
  return identity;
}

export function isValidEnvironmentAssuredTcpStreamIdentity(
  identity: EnvironmentAssuredTcpStreamIdentity,
): boolean {
  return (
    validAssuredTcpStreamIdentities.has(identity) &&
    activeAssuredTcpStreamIdentities.has(identity)
  );
}

export function revokeEnvironmentAssuredTcpStreamIdentity(
  identity: EnvironmentAssuredTcpStreamIdentity,
): void {
  activeAssuredTcpStreamIdentities.delete(identity);
  revokeEnvironmentSecretIdentity(identity.authenticationIdentity);
}

/** Environment-provider minting boundary; plain structural objects are invalid. */
export function createEnvironmentPrivateUnixStreamIdentity(
  input: EnvironmentPrivateUnixStreamIdentity,
): EnvironmentPrivateUnixStreamIdentity {
  if (
    !validEnvironmentChannelScope(input.scope) ||
    input.kind !== "private_unix_stream" ||
    input.channelId.length === 0 ||
    input.socketIdentity.length === 0 ||
    input.filesystemIdentity.ownerVerified !== true ||
    input.filesystemIdentity.parentMode !== "0700" ||
    input.filesystemIdentity.socketMode !== "0600"
  ) {
    throw new Error("environment_private_unix_stream_identity_invalid");
  }
  const identity = Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    filesystemIdentity: Object.freeze({ ...input.filesystemIdentity }),
  });
  validPrivateUnixStreamIdentities.add(identity);
  activePrivateUnixStreamIdentities.add(identity);
  return identity;
}

export function isValidEnvironmentPrivateUnixStreamIdentity(
  identity: EnvironmentPrivateUnixStreamIdentity,
): boolean {
  return (
    validPrivateUnixStreamIdentities.has(identity) &&
    activePrivateUnixStreamIdentities.has(identity)
  );
}

export function revokeEnvironmentPrivateUnixStreamIdentity(
  identity: EnvironmentPrivateUnixStreamIdentity,
): void {
  activePrivateUnixStreamIdentities.delete(identity);
}

export type EnvironmentPrivateUnixStreamClosure = Readonly<{
  readonly reason: "peer_closed" | "client_closed" | "socket_error";
  readonly cause?: Error;
}>;

export type EnvironmentStreamWriteDelivery =
  "not_sent" | "sent_outcome_unknown";

export class EnvironmentStreamWriteError extends Error {
  readonly delivery: EnvironmentStreamWriteDelivery;

  constructor(
    message: string,
    delivery: EnvironmentStreamWriteDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentStreamWriteError";
    this.delivery = delivery;
  }
}

/**
 * Provider-neutral external Unix byte stream. It exposes neither a Node socket
 * nor the configured endpoint. Cleanup authority is limited to this client.
 */
export interface EnvironmentPrivateUnixStreamChannel {
  readonly identity: EnvironmentPrivateUnixStreamIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  /** Rechecks the provider's current local channel and configuration proof. */
  revalidateIdentity(signal?: AbortSignal): Promise<void>;
  closeClient(reason: string): Promise<void>;
  destroyClient(reason: string): void;
}

/**
 * Provider-neutral external TCP/TLS byte stream. The route and native socket
 * remain owned by the execution environment; cleanup can close only this
 * Sedes client.
 */
export interface EnvironmentAssuredTcpStreamChannel {
  readonly identity: EnvironmentAssuredTcpStreamIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  closeClient(reason: string): Promise<void>;
  destroyClient(reason: string): void;
}

export type EnvironmentExternalByteStreamChannel =
  EnvironmentPrivateUnixStreamChannel | EnvironmentAssuredTcpStreamChannel;

/**
 * Provider-neutral owned process channel. It deliberately exposes no Node,
 * SSH, container, stream, PID-management, or tunnel handle. Only the owning
 * environment implementation may perform lifecycle cleanup.
 */
export interface EnvironmentOwnedProcessChannel {
  readonly identity: EnvironmentOwnedProcessIdentity;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentProcessClosure>;
  writeStdin(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  closeStdin(): void;
  close(reason: string): Promise<void>;
}

/**
 * Provider-neutral owned pseudoterminal. Bytes are not decoded or interpreted
 * by the environment layer. Native PTY and process handles remain private to
 * the owning environment implementation.
 */
export interface EnvironmentOwnedPtyChannel {
  readonly identity: EnvironmentOwnedPtyIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentProcessClosure>;
  write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  resize(size: EnvironmentPtySize): void;
  close(reason: string): Promise<void>;
}

/**
 * Companion capability to ExecutionEnvironmentProvider. Later SSH and
 * container environments implement this interface in their own namespaces;
 * Codex receives the composed capability and never constructs those clients.
 */
export interface ExecutionEnvironmentChannelProvider {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  /**
   * Publish backend-runtime reachability observed through this exact channel.
   * Opening a carrier is not sufficient evidence of availability: providers
   * publish positive availability only after the backend protocol handshake is
   * ready, and publish negative availability after a runtime failure. The SSH
   * implementation combines this backend-scoped evidence with independent
   * environment-scoped sidecar lifecycle evidence.
   */
  reportRuntimeAvailability(
    scope: EnvironmentChannelScope,
    observation:
      | Readonly<{ readonly availability: "available" }>
      | Readonly<{
          readonly availability: "unavailable";
          readonly diagnosticCode: string;
        }>,
  ): Promise<void>;
  resolveDirectory(
    scope: EnvironmentChannelScope,
    configuredPath: string,
  ): Promise<EnvironmentPathIdentity & { readonly kind: "directory" }>;
  /**
   * Resolve an operator-installed executable in this environment. An explicit
   * path is authoritative; otherwise the environment's PATH is searched for
   * the provider-owned command name.
   */
  readonly resolveOwnedProcessExecutable?: (
    scope: EnvironmentChannelScope,
    input: {
      readonly commandName: string;
      readonly configuredPath?: string;
    },
  ) => Promise<EnvironmentPathIdentity & { readonly kind: "executable" }>;
  prepareOwnedProcess(
    scope: EnvironmentChannelScope,
    input: {
      readonly executablePath: string;
      readonly workingDirectory: string;
    },
  ): Promise<PreparedEnvironmentOwnedProcess>;
  /**
   * Launch one installation-registered, digest-verified worker artifact in
   * this exact environment. The provider retains all topology-specific
   * process/SSH authority; backend callers cannot provide argv or environment.
   */
  readonly openInstallationManagedWorker?: (
    scope: EnvironmentChannelScope,
    input: {
      readonly artifact: ManagedWorkerArtifactRegistration;
      readonly workingDirectory: string;
      readonly identity: ManagedWorkerLaunchIdentity;
    },
    signal: AbortSignal,
  ) => Promise<SidecarByteStream>;
  /** Resolve a current endpoint address usable by a process in this namespace. */
  readonly prepareManagedProcessEndpoint?: (
    scope: EnvironmentChannelScope,
    request: EnvironmentManagedProcessEndpointRequest,
    connectionGeneration: number,
    signal: AbortSignal,
  ) => Promise<PreparedEnvironmentManagedProcessEndpoint>;
  openOwnedProcess(
    scope: EnvironmentChannelScope,
    input: {
      readonly prepared: PreparedEnvironmentOwnedProcess;
      readonly arguments: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly cleanup: EnvironmentOwnedProcessCleanupPolicy;
    },
    signal: AbortSignal,
  ): Promise<EnvironmentOwnedProcessChannel>;
  readonly openOwnedPty?: (
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
  ) => Promise<EnvironmentOwnedPtyChannel>;
  openPrivateUnixStream(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
  ): Promise<EnvironmentPrivateUnixStreamChannel>;
  openAssuredTcpStream(
    scope: EnvironmentChannelScope,
    route: EnvironmentTcpRoute,
    connectionGeneration: number,
    authenticationIdentity: EnvironmentSecretIdentity,
    signal: AbortSignal,
  ): Promise<EnvironmentAssuredTcpStreamChannel>;
  resolveSecret(
    scope: EnvironmentChannelScope,
    reference: EnvironmentSecretReference,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<ResolvedEnvironmentSecret>;
}

export function sameEnvironmentChannelScope(
  left: EnvironmentChannelScope,
  right: EnvironmentChannelScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.backendInstanceId === right.backendInstanceId &&
    left.executionEnvironmentId === right.executionEnvironmentId
  );
}

export function validEnvironmentChannelScope(
  scope: EnvironmentChannelScope,
): boolean {
  return (
    scope.tenantId.length > 0 &&
    scope.principalId.length > 0 &&
    scope.backendInstanceId.length > 0 &&
    scope.executionEnvironmentId.length > 0
  );
}
