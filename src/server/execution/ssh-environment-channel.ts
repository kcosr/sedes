import type { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  EnvironmentAssuredTcpStreamChannel,
  EnvironmentChannelScope,
  EnvironmentOwnedProcessChannel,
  EnvironmentPathIdentity,
  EnvironmentPrivateUnixStreamChannel,
  EnvironmentPrivateUnixStreamClosure,
  EnvironmentPrivateUnixStreamIdentity,
  EnvironmentSecretIdentity,
  EnvironmentSecretReference,
  EnvironmentTcpRoute,
  ExecutionEnvironmentChannelProvider,
  PreparedEnvironmentOwnedProcess,
  ResolvedEnvironmentSecret,
} from "./environment-channel.js";
import { LocalEnvironmentChannelProvider } from "./local-environment-channel.js";
import type {
  SshBackendAvailabilityReporter,
  SshEnvironmentAvailabilityObservation,
} from "./ssh-environment-availability.js";
import {
  defaultSshProcessSpawner,
  OPEN_SSH_BASE_ARGUMENTS,
  safeSshHostAlias,
  SshEnvironmentError,
  terminateExactSshChild,
  type SshProcessSpawner,
} from "./ssh-open-ssh.js";

const SSH_START_TIMEOUT_MILLISECONDS = 15_000;
const SSH_STOP_TIMEOUT_MILLISECONDS = 1_000;
const MAX_TUNNEL_OUTPUT_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function sameRequestScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function unavailable(): SshEnvironmentError {
  return new SshEnvironmentError(
    "unavailable",
    "ssh_environment_capability_unsupported",
  );
}

function escapeStreamLocalPath(value: string): string {
  if (
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes(":") ||
    value.includes("$")
  ) {
    throw new SshEnvironmentError(
      "identity_invalid",
      "ssh_socket_path_invalid",
    );
  }
  return value.replaceAll("%", "%%");
}

function carrierDeadlineSignal(signal: AbortSignal): Readonly<{
  signal: AbortSignal;
  deadline: number;
  dispose(): void;
}> {
  const controller = new AbortController();
  const deadline = Date.now() + SSH_START_TIMEOUT_MILLISECONDS;
  const abortFromCaller = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new SshEnvironmentError("timeout", "ssh_carrier_start_timeout"),
      ),
    SSH_START_TIMEOUT_MILLISECONDS,
  );
  timer.unref();
  if (signal.aborted) abortFromCaller();
  return Object.freeze({
    signal: controller.signal,
    deadline,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromCaller);
    },
  });
}

function throwCarrierAbort(signal: AbortSignal): never {
  if (signal.reason instanceof SshEnvironmentError) throw signal.reason;
  throw new SshEnvironmentError("unavailable", "ssh_operation_cancelled");
}

export class SshEnvironmentChannelProvider implements ExecutionEnvironmentChannelProvider {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  readonly #host: string;
  readonly #configurationRevision: number;
  readonly #activeConfigurationRevision: () => number | Promise<number>;
  readonly #sshExecutable: string;
  readonly #spawnProcess: SshProcessSpawner;
  readonly #availability: SshBackendAvailabilityReporter;
  readonly #onBackgroundError: (error: unknown) => void;
  readonly #channels = new Set<SshPrivateUnixStreamChannel>();
  readonly #openAttempts = new Map<AbortController, Promise<void>>();
  #closed = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly executionEnvironmentId: string;
    readonly host: string;
    readonly configurationRevision: number;
    readonly activeConfigurationRevision: () => number | Promise<number>;
    readonly sshExecutable?: string;
    readonly spawnProcess?: SshProcessSpawner;
    readonly availability: SshBackendAvailabilityReporter;
    readonly onBackgroundError?: (error: unknown) => void;
  }) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.executionEnvironmentId ||
      !safeSshHostAlias(input.host) ||
      !Number.isSafeInteger(input.configurationRevision) ||
      input.configurationRevision < 0
    ) {
      throw new Error("ssh_environment_channel_configuration_invalid");
    }
    this.scope = Object.freeze({ ...input.scope });
    this.executionEnvironmentId = input.executionEnvironmentId;
    this.#host = input.host;
    this.#configurationRevision = input.configurationRevision;
    this.#activeConfigurationRevision = input.activeConfigurationRevision;
    this.#sshExecutable = input.sshExecutable ?? "ssh";
    this.#spawnProcess = input.spawnProcess ?? defaultSshProcessSpawner;
    this.#availability = input.availability;
    this.#onBackgroundError = input.onBackgroundError ?? (() => undefined);
  }

  async resolveDirectory(
    _scope: EnvironmentChannelScope,
    _configuredPath: string,
  ): Promise<EnvironmentPathIdentity & { readonly kind: "directory" }> {
    // SSH environments support only operator-owned external runtimes. An
    // owned runtime would require remote filesystem/process authority, which
    // this provider intentionally does not claim or probe for.
    throw unavailable();
  }

  async resolveOwnedProcessExecutable(): Promise<
    EnvironmentPathIdentity & { readonly kind: "executable" }
  > {
    throw unavailable();
  }

  async prepareOwnedProcess(): Promise<PreparedEnvironmentOwnedProcess> {
    throw unavailable();
  }

  async openOwnedProcess(): Promise<EnvironmentOwnedProcessChannel> {
    throw unavailable();
  }

  async openAssuredTcpStream(
    _scope: EnvironmentChannelScope,
    _route: EnvironmentTcpRoute,
    _connectionGeneration: number,
    _authenticationIdentity: EnvironmentSecretIdentity,
    _signal: AbortSignal,
  ): Promise<EnvironmentAssuredTcpStreamChannel> {
    throw unavailable();
  }

  async resolveSecret(
    _scope: EnvironmentChannelScope,
    _reference: EnvironmentSecretReference,
    _connectionGeneration: number,
    _signal: AbortSignal,
  ): Promise<ResolvedEnvironmentSecret> {
    throw unavailable();
  }

  async openPrivateUnixStream(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
  ): Promise<EnvironmentPrivateUnixStreamChannel> {
    try {
      return await this.#openPrivateUnixStream(scope, configuredPath, signal);
    } catch (error) {
      await this.#reportFailureWithoutMasking(scope.backendInstanceId, error);
      throw error;
    }
  }

  async reportRuntimeAvailability(
    scope: EnvironmentChannelScope,
    observation: SshEnvironmentAvailabilityObservation,
  ): Promise<void> {
    await this.#assertActive(scope);
    await this.#availability.reportBackendObservation(
      scope.backendInstanceId,
      observation,
    );
  }

  async #openPrivateUnixStream(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
  ): Promise<EnvironmentPrivateUnixStreamChannel> {
    const closeController = new AbortController();
    const combinedSignal = AbortSignal.any([signal, closeController.signal]);
    const opening = this.#openPrivateUnixStreamTracked(
      scope,
      configuredPath,
      combinedSignal,
    );
    const settled = opening.then(
      () => undefined,
      () => undefined,
    );
    this.#openAttempts.set(closeController, settled);
    try {
      return await opening;
    } finally {
      this.#openAttempts.delete(closeController);
    }
  }

  async #openPrivateUnixStreamTracked(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
  ): Promise<EnvironmentPrivateUnixStreamChannel> {
    const attempt = carrierDeadlineSignal(signal);
    try {
      return await this.#openPrivateUnixStreamBeforeDeadline(
        scope,
        configuredPath,
        attempt.signal,
        attempt.deadline,
      );
    } finally {
      attempt.dispose();
    }
  }

  async #openPrivateUnixStreamBeforeDeadline(
    scope: EnvironmentChannelScope,
    configuredPath: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<EnvironmentPrivateUnixStreamChannel> {
    await this.#assertActive(scope, signal);
    if (
      !path.posix.isAbsolute(configuredPath) ||
      configuredPath.includes("\0") ||
      configuredPath.includes("\n") ||
      configuredPath.includes(":") ||
      configuredPath.includes("$") ||
      path.posix.normalize(configuredPath) !== configuredPath ||
      (configuredPath !== "/" && configuredPath.endsWith("/"))
    ) {
      throw new SshEnvironmentError(
        "identity_invalid",
        "ssh_socket_path_invalid",
      );
    }
    const carrierDirectory = await mkdtemp(path.join(tmpdir(), "h-ssh-"));
    await chmod(carrierDirectory, 0o700);
    const localSocketPath = path.join(carrierDirectory, "s");
    if (Buffer.byteLength(localSocketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      await rm(carrierDirectory, { recursive: true, force: true });
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_local_carrier_path_too_long",
      );
    }
    let localForwardPath: string;
    let remoteForwardPath: string;
    try {
      localForwardPath = escapeStreamLocalPath(localSocketPath);
      remoteForwardPath = escapeStreamLocalPath(configuredPath);
    } catch (error) {
      await rm(carrierDirectory, { recursive: true, force: true });
      throw error;
    }
    const tunnel = this.#spawnProcess(this.#sshExecutable, [
      ...OPEN_SSH_BASE_ARGUMENTS,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "GatewayPorts=no",
      "-o",
      "StreamLocalBindMask=0177",
      "-o",
      "StreamLocalBindUnlink=no",
      "-L",
      `${localForwardPath}:${remoteForwardPath}`,
      this.#host,
    ]);
    let outputBytes = 0;
    let outputOverflow = false;
    let tunnelFailureCode:
      "ssh_carrier_exited" | "ssh_carrier_failed" | undefined;
    tunnel.once("error", () => {
      tunnelFailureCode ??= "ssh_carrier_failed";
    });
    tunnel.once("exit", () => {
      tunnelFailureCode ??= "ssh_carrier_exited";
    });
    tunnel.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_TUNNEL_OUTPUT_BYTES) {
        outputOverflow = true;
        tunnel.kill("SIGTERM");
      }
    });
    tunnel.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_TUNNEL_OUTPUT_BYTES) {
        outputOverflow = true;
        tunnel.kill("SIGTERM");
      }
    });

    const localProvider = new LocalEnvironmentChannelProvider({
      scope: this.scope,
      executionEnvironmentId: this.executionEnvironmentId,
    });
    let delegate: EnvironmentPrivateUnixStreamChannel | undefined;
    try {
      await waitForLocalSocket(
        tunnel,
        localSocketPath,
        signal,
        deadline,
        () => tunnelFailureCode !== undefined,
        () => outputOverflow,
      );
      if (outputOverflow) {
        throw new SshEnvironmentError(
          "unavailable",
          "ssh_carrier_output_overflow",
        );
      }
      delegate = await localProvider.openPrivateUnixStream(
        scope,
        localSocketPath,
        signal,
      );
      await this.#assertActive(scope, signal);
      if (
        tunnelFailureCode ||
        tunnel.exitCode !== null ||
        tunnel.signalCode !== null
      ) {
        throw new SshEnvironmentError(
          "unavailable",
          tunnelFailureCode ?? "ssh_carrier_exited",
        );
      }
      if (signal.aborted || this.#closed) {
        throw new SshEnvironmentError(
          "unavailable",
          "ssh_environment_unavailable",
        );
      }
      let channel!: SshPrivateUnixStreamChannel;
      channel = new SshPrivateUnixStreamChannel({
        delegate,
        tunnel,
        localProvider,
        carrierDirectory,
        assertActive: () => this.#assertActive(scope),
        onCarrierFailure: (diagnosticCode) =>
          this.#reportFailureWithoutMasking(
            scope.backendInstanceId,
            new SshEnvironmentError("unavailable", diagnosticCode),
          ),
        onClosed: () => this.#channels.delete(channel),
      });
      this.#channels.add(channel);
      return channel;
    } catch (error) {
      delegate?.destroyClient("ssh_carrier_start_failed");
      localProvider.close();
      let cleanupFailure: unknown;
      try {
        await terminateExactSshChild(tunnel, SSH_STOP_TIMEOUT_MILLISECONDS);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      await rm(carrierDirectory, { recursive: true, force: true });
      if (cleanupFailure) throw cleanupFailure;
      if (signal.aborted) throwCarrierAbort(signal);
      if (error instanceof SshEnvironmentError) throw error;
      throw new SshEnvironmentError("unavailable", "ssh_carrier_start_failed");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const attempts = [...this.#openAttempts.entries()];
    for (const [controller] of attempts) {
      controller.abort(
        new SshEnvironmentError("unavailable", "ssh_environment_unavailable"),
      );
    }
    const channels = [...this.#channels];
    for (const channel of channels) {
      channel.destroyClient("ssh_environment_channel_closed");
    }
    this.#channels.clear();
    await Promise.all([
      ...attempts.map(([, settled]) => settled),
      ...channels.map((channel) => channel.closed),
    ]);

  }

  async #assertActive(
    scope: EnvironmentChannelScope,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      signal?.aborted ||
      this.#closed ||
      !sameRequestScope(this.scope, scope) ||
      scope.executionEnvironmentId !== this.executionEnvironmentId ||
      !scope.backendInstanceId
    ) {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_environment_unavailable",
      );
    }
    let activeRevision: number;
    try {
      activeRevision = await this.#activeConfigurationRevision();
    } catch {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_environment_configuration_unavailable",
      );
    }
    if (signal?.aborted || this.#closed) {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_environment_unavailable",
      );
    }
    if (activeRevision !== this.#configurationRevision) {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_environment_configuration_stale",
      );
    }
  }

  async #reportFailure(
    backendInstanceId: string,
    error: unknown,
  ): Promise<void> {
    if (
      !(error instanceof SshEnvironmentError) ||
      !new Set([
        "ssh_transport_unavailable",
        "ssh_operation_timeout",
        "ssh_carrier_start_timeout",
        "ssh_carrier_exited",
        "ssh_carrier_failed",
        "ssh_carrier_output_overflow",
        "ssh_environment_configuration_unavailable",
      ]).has(error.diagnosticCode)
    ) {
      return;
    }
    const diagnosticCode = error.diagnosticCode;
    await this.#availability.reportBackendObservation(backendInstanceId, {
      availability: "unavailable",
      diagnosticCode,
    });
  }

  async #reportFailureWithoutMasking(
    backendInstanceId: string,
    transportError: unknown,
  ): Promise<void> {
    try {
      await this.#reportFailure(backendInstanceId, transportError);
    } catch (error) {
      this.#onBackgroundError(error);
    }
  }
}

class SshPrivateUnixStreamChannel implements EnvironmentPrivateUnixStreamChannel {
  readonly identity: EnvironmentPrivateUnixStreamIdentity;
  readonly bytes;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  readonly #delegate: EnvironmentPrivateUnixStreamChannel;
  readonly #tunnel: ChildProcess;
  readonly #localProvider: LocalEnvironmentChannelProvider;
  readonly #carrierDirectory: string;
  readonly #assertActive: () => Promise<void>;
  readonly #onCarrierFailure: (diagnosticCode: string) => Promise<void>;
  readonly #onClosed: () => void;
  readonly #carrierSettled: Promise<void>;
  #cleanupPromise: Promise<void> | undefined;
  #clientCloseRequested = false;
  #terminationRequested = false;

  constructor(input: {
    readonly delegate: EnvironmentPrivateUnixStreamChannel;
    readonly tunnel: ChildProcess;
    readonly localProvider: LocalEnvironmentChannelProvider;
    readonly carrierDirectory: string;
    readonly assertActive: () => Promise<void>;
    readonly onCarrierFailure: (diagnosticCode: string) => Promise<void>;
    readonly onClosed: () => void;
  }) {
    this.#delegate = input.delegate;
    // The application connects only to this process-owned local carrier. The
    // remote endpoint is operator authority conveyed by OpenSSH's verified
    // host/session and the configured StreamLocal destination; it is not a
    // second filesystem identity for Sedes to probe or mint.
    this.identity = input.delegate.identity;
    this.bytes = input.delegate.bytes;
    this.#tunnel = input.tunnel;
    this.#localProvider = input.localProvider;
    this.#carrierDirectory = input.carrierDirectory;
    this.#assertActive = input.assertActive;
    this.#onCarrierFailure = input.onCarrierFailure;
    this.#onClosed = input.onClosed;
    this.closed = input.delegate.closed.finally(() => this.#cleanup());
    let settleCarrier!: () => void;
    this.#carrierSettled = new Promise<void>((resolve) => {
      settleCarrier = resolve;
    });
    input.tunnel.once("exit", () => {
      const unexpected =
        !this.#clientCloseRequested && !this.#terminationRequested;
      settleCarrier();
      input.delegate.destroyClient("ssh_carrier_exited");
      if (unexpected) {
        void this.#onCarrierFailure("ssh_carrier_exited").catch(
          () => undefined,
        );
      }
    });
    input.tunnel.once("error", () => {
      const unexpected =
        !this.#clientCloseRequested && !this.#terminationRequested;
      settleCarrier();
      input.delegate.destroyClient("ssh_carrier_failed");
      if (unexpected) {
        void this.#onCarrierFailure("ssh_carrier_failed").catch(
          () => undefined,
        );
      }
    });
  }

  write(bytes: Uint8Array, options?: { readonly signal?: AbortSignal }) {
    return this.#delegate.write(bytes, options);
  }

  async revalidateIdentity(signal?: AbortSignal): Promise<void> {
    const callerSignal = signal ?? new AbortController().signal;
    const attempt = carrierDeadlineSignal(callerSignal);
    try {
      if (attempt.signal.aborted) throwCarrierAbort(attempt.signal);
      await this.#assertActive();
      await this.#delegate.revalidateIdentity(attempt.signal);
      if (attempt.signal.aborted) throwCarrierAbort(attempt.signal);
    } catch (error) {
      this.destroyClient("ssh_streamlocal_carrier_revalidation_failed");
      throw error;
    } finally {
      attempt.dispose();
    }
  }

  async closeClient(reason: string): Promise<void> {
    this.#clientCloseRequested = true;
    let failure: unknown;
    try {
      await this.#delegate.closeClient(reason);
    } catch (error) {
      failure = error;
    }
    try {
      await this.#cleanup();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  destroyClient(reason: string): void {
    this.#clientCloseRequested = true;
    this.#delegate.destroyClient(reason);
    void this.#cleanup();
  }

  #cleanup(): Promise<void> {
    this.#cleanupPromise ??= (async () => {
      let failure: unknown;
      if (
        !this.#clientCloseRequested &&
        this.#tunnel.exitCode === null &&
        this.#tunnel.signalCode === null
      ) {
        await Promise.race([
          this.#carrierSettled,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
      }
      this.#terminationRequested = true;
      try {
        await terminateExactSshChild(
          this.#tunnel,
          SSH_STOP_TIMEOUT_MILLISECONDS,
        );
      } catch (error) {
        failure = error;
      }
      try {
        this.#localProvider.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await rm(this.#carrierDirectory, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      } finally {
        this.#onClosed();
      }
      if (failure) throw failure;
    })();
    return this.#cleanupPromise;
  }
}

async function waitForLocalSocket(
  tunnel: ChildProcess,
  localSocketPath: string,
  signal: AbortSignal,
  deadline: number,
  tunnelFailed: () => boolean,
  outputOverflowed: () => boolean,
): Promise<void> {
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throwCarrierAbort(signal);
    }
    if (outputOverflowed()) {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_carrier_output_overflow",
      );
    }
    if (
      tunnelFailed() ||
      tunnel.exitCode !== null ||
      tunnel.signalCode !== null
    ) {
      throw new SshEnvironmentError("unavailable", "ssh_carrier_exited");
    }
    const socket = await lstat(localSocketPath).catch(() => undefined);
    if (socket?.isSocket()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new SshEnvironmentError("timeout", "ssh_carrier_start_timeout");
}
