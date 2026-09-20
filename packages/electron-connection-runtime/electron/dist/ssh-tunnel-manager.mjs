import { spawn } from "node:child_process";
import { connect as connectSocket, createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const MAXIMUM_OUTPUT_BYTES = 16 * 1024;
const READINESS_TIMEOUT_MILLISECONDS = 12_000;
const READINESS_RETRY_MILLISECONDS = 50;
const STOP_TIMEOUT_MILLISECONDS = 1_000;

export const SSH_BASE_ARGUMENTS = Object.freeze([
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "NumberOfPasswordPrompts=0",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "RequestTTY=no",
  "-o",
  "ForkAfterAuthentication=no",
  "-o",
  "RemoteCommand=none",
]);

export class SshTunnelError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SshTunnelError";
    this.code = code;
  }
}

export function validateConnectInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 4 ||
    !Object.hasOwn(input, "connectionId") ||
    typeof input.profileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.profileId) ||
    !Object.hasOwn(input, "hostAlias") ||
    !Object.hasOwn(input, "remotePort") ||
    typeof input.connectionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.connectionId,
    ) ||
    typeof input.hostAlias !== "string" ||
    input.hostAlias.length === 0 ||
    input.hostAlias.length > 255 ||
    input.hostAlias.startsWith("-") ||
    !/^[A-Za-z0-9_.-]+$/u.test(input.hostAlias) ||
    !Number.isSafeInteger(input.remotePort) ||
    input.remotePort < 1 ||
    input.remotePort > 65_535
  ) {
    throw new SshTunnelError(
      "ssh_tunnel_input_invalid",
      "The SSH host alias or remote Sedes port is invalid.",
    );
  }
  return Object.freeze({
    connectionId: input.connectionId,
    profileId: input.profileId,
    hostAlias: input.hostAlias,
    remotePort: input.remotePort,
  });
}

export function validateDisconnectInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    typeof input.connectionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.connectionId,
    )
  ) {
    throw new SshTunnelError(
      "connection_runtime_input_invalid",
      "The connection runtime identifier is invalid.",
    );
  }
  return input.connectionId;
}

export function sshArguments(input, localPort) {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new SshTunnelError(
      "ssh_local_port_unavailable",
      "A local port for the SSH connection could not be allocated.",
    );
  }
  return [
    ...SSH_BASE_ARGUMENTS,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "GatewayPorts=no",
    "-L",
    `${LOOPBACK_HOST}:${localPort}:${LOOPBACK_HOST}:${input.remotePort}`,
    input.hostAlias,
  ];
}

export function classifySshFailure(input = {}) {
  if (input.spawnError?.code === "ENOENT") {
    return new SshTunnelError(
      "ssh_executable_not_found",
      "The system ssh executable was not found.",
      input.spawnError,
    );
  }
  if (input.outputOverflow) {
    return new SshTunnelError(
      "ssh_output_overflow",
      "The SSH process produced too much diagnostic output.",
    );
  }
  const output = sanitizeOutput(input.stderr ?? "").toLowerCase();
  if (output.includes("host key verification failed")) {
    return new SshTunnelError(
      "ssh_host_key_untrusted",
      "SSH host-key verification failed. Connect with system ssh first and verify the host key.",
    );
  }
  if (
    output.includes("permission denied") ||
    output.includes("no supported authentication methods available")
  ) {
    return new SshTunnelError(
      "ssh_authentication_failed",
      "SSH authentication failed. Ensure the host alias works with keys or an SSH agent without prompts.",
    );
  }
  if (
    output.includes("could not resolve hostname") ||
    output.includes("name or service not known") ||
    output.includes("nodename nor servname provided")
  ) {
    return new SshTunnelError(
      "ssh_host_unresolved",
      "The SSH host alias could not be resolved. Check the system SSH configuration.",
    );
  }
  if (output.includes("connection refused")) {
    return new SshTunnelError(
      "ssh_connection_refused",
      "The SSH host refused the connection.",
    );
  }
  if (
    output.includes("connection timed out") ||
    output.includes("operation timed out") ||
    output.includes("no route to host")
  ) {
    return new SshTunnelError(
      "ssh_connection_timeout",
      "The SSH host could not be reached before the connection timed out.",
    );
  }
  if (
    output.includes("address already in use") ||
    output.includes("cannot listen to port") ||
    output.includes("could not request local forwarding")
  ) {
    return new SshTunnelError(
      "ssh_forward_unavailable",
      "The saved SSH forwarding port is occupied. Stop the process using it and reconnect.",
    );
  }
  return new SshTunnelError(
    "ssh_tunnel_exited",
    "The SSH connection closed before the Sedes tunnel became ready.",
    input.spawnError,
  );
}

export class SshTunnelManager {
  #active;
  #connectingChild;
  #generation = 0;
  #notify;
  #operation = Promise.resolve();
  #pendingConnect;
  #requestedInput;
  #requestGeneration = 0;
  #reservePort;
  #spawnProcess;
  #terminateProcess;
  #waitForPort;

  constructor(dependencies = {}) {
    this.#notify = dependencies.notify ?? (() => undefined);
    this.#reservePort = dependencies.reservePort ?? (() => { throw new SshTunnelError("ssh_port_storage_unavailable", "SSH forwarding port storage is unavailable."); });
    this.#spawnProcess = dependencies.spawnProcess ?? spawnSshProcess;
    this.#terminateProcess =
      dependencies.terminateProcess ?? terminateExactChild;
    this.#waitForPort = dependencies.waitForPort ?? waitForLoopbackPort;
  }

  getStatus() {
    if (this.#active) {
      return Object.freeze({
        status: "connected",
        connectionId: this.#active.input.connectionId,
        baseUrl: this.#active.baseUrl,
        hostAlias: this.#active.input.hostAlias,
        remotePort: this.#active.input.remotePort,
      });
    }
    if (this.#connectingChild || this.#pendingConnect) {
      return Object.freeze({
        status: "connecting",
        connectionId: this.#requestedInput.connectionId,
      });
    }
    return Object.freeze({ status: "disconnected" });
  }

  connect(rawInput) {
    const input = validateConnectInput(rawInput);
    const sameRequest =
      this.#requestedInput?.connectionId === input.connectionId &&
      this.#requestedInput.profileId === input.profileId &&
      this.#requestedInput?.hostAlias === input.hostAlias &&
      this.#requestedInput.remotePort === input.remotePort;
    if (
      sameRequest &&
      this.#pendingConnect?.generation === this.#requestGeneration
    ) {
      return this.#pendingConnect.promise;
    }
    if (!sameRequest) {
      this.#requestGeneration += 1;
      this.#requestedInput = input;
      this.#connectingChild?.kill("SIGTERM");
    }
    const requestGeneration = this.#requestGeneration;
    const promise = this.#serialize(() =>
      this.#connect(input, requestGeneration),
    );
    this.#pendingConnect = { generation: requestGeneration, promise };
    void promise.then(
      () => this.#clearPendingConnect(promise),
      () => this.#clearPendingConnect(promise),
    );
    return promise;
  }

  disconnect(rawInput) {
    const connectionId = validateDisconnectInput(rawInput);
    if (
      this.#requestedInput?.connectionId !== connectionId &&
      this.#active?.input.connectionId !== connectionId
    ) {
      return Promise.resolve();
    }
    this.#requestGeneration += 1;
    this.#requestedInput = undefined;
    this.#connectingChild?.kill("SIGTERM");
    return this.#serialize(() => this.#disconnect(connectionId));
  }

  disconnectAll() {
    this.#requestGeneration += 1;
    this.#requestedInput = undefined;
    this.#connectingChild?.kill("SIGTERM");
    return this.#serialize(() => this.#disconnect());
  }

  async #connect(input, requestGeneration) {
    this.#assertCurrentRequest(requestGeneration);
    if (
      this.#active?.input.connectionId === input.connectionId &&
      this.#active.input.profileId === input.profileId &&
      this.#active.input.hostAlias === input.hostAlias &&
      this.#active.input.remotePort === input.remotePort
    ) {
      return Object.freeze({
        connectionId: this.#active.input.connectionId,
        baseUrl: this.#active.baseUrl,
      });
    }
    await this.#disconnect();
    this.#assertCurrentRequest(requestGeneration);
    const generation = ++this.#generation;
    {
      const localPort = await this.#reservePort(input);
      this.#assertCurrentRequest(requestGeneration);
      let child;
      try {
        child = this.#spawnProcess("ssh", sshArguments(input, localPort));
      } catch (error) {
        const failure = classifySshFailure({ spawnError: error });
        if (this.#requestGeneration === requestGeneration) {
          this.#requestedInput = undefined;
        }
        throw failure;
      }
      this.#connectingChild = child;
      const diagnostics = observeChild(child);
      try {
        await this.#waitForPort({
          host: LOOPBACK_HOST,
          port: localPort,
          timeoutMilliseconds: READINESS_TIMEOUT_MILLISECONDS,
          failure: () => diagnostics.failure(),
        });
        this.#assertCurrentRequest(requestGeneration);
        const failure = diagnostics.failure();
        if (failure) throw classifySshFailure(failure);
        diagnostics.promoteActive();
        const active = {
          child,
          generation,
          input,
          baseUrl: `http://${LOOPBACK_HOST}:${localPort}`,
          stopping: false,
          diagnostics,
        };
        this.#active = active;
        this.#connectingChild = undefined;
        child.once("exit", (code, signal) =>
          this.#handleUnexpectedExit(active, code, signal),
        );
        return Object.freeze({
          connectionId: active.input.connectionId,
          baseUrl: active.baseUrl,
        });
      } catch (error) {
        this.#connectingChild = undefined;
        await this.#terminateProcess(child, STOP_TIMEOUT_MILLISECONDS).catch(
          () => undefined,
        );
        const failure =
          requestGeneration !== this.#requestGeneration
            ? new SshTunnelError(
                "ssh_tunnel_cancelled",
                "The SSH connection attempt was cancelled.",
              )
            : error instanceof SshTunnelError
              ? error
              : classifySshFailure(diagnostics.failure() ?? {});
        if (this.#requestGeneration === requestGeneration) this.#requestedInput = undefined;
        throw failure;
      }
    }
  }

  async #disconnect(connectionId) {
    this.#generation += 1;
    const active = this.#active;
    if (connectionId && active?.input.connectionId !== connectionId) return;
    this.#active = undefined;
    if (!active) return;
    active.stopping = true;
    await this.#terminateProcess(active.child, STOP_TIMEOUT_MILLISECONDS);
    this.#notify(
      Object.freeze({
        status: "disconnected",
        connectionId: active.input.connectionId,
      }),
    );
  }

  #handleUnexpectedExit(active, code, signal) {
    if (
      active.stopping ||
      this.#active !== active ||
      active.generation !== this.#generation
    ) {
      return;
    }
    this.#active = undefined;
    this.#requestedInput = undefined;
    const classifiedFailure = classifySshFailure({
      ...active.diagnostics.failure(),
      exitCode: code,
      signal,
    });
    const failure =
      classifiedFailure.code === "ssh_tunnel_exited"
        ? new SshTunnelError(
            "ssh_tunnel_lost",
            "The managed SSH connection closed unexpectedly.",
          )
        : classifiedFailure;
    this.#notify(
      Object.freeze({
        status: "disconnected",
        connectionId: active.input.connectionId,
        error: Object.freeze({ code: failure.code, message: failure.message }),
      }),
    );
  }

  #serialize(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => undefined);
    return result;
  }

  #assertCurrentRequest(requestGeneration) {
    if (requestGeneration !== this.#requestGeneration) {
      throw new SshTunnelError(
        "ssh_tunnel_cancelled",
        "The SSH connection attempt was cancelled.",
      );
    }
  }

  #clearPendingConnect(promise) {
    if (this.#pendingConnect?.promise === promise) {
      this.#pendingConnect = undefined;
    }
  }
}

export function spawnSshProcess(
  executable,
  arguments_,
  spawnImplementation = spawn,
) {
  const windowsSmokeScript =
    process.platform === "win32"
      ? process.env.SEDES_ELECTRON_SMOKE_SSH_SCRIPT
      : undefined;
  return spawnImplementation(
    windowsSmokeScript ? process.execPath : executable,
    windowsSmokeScript
      ? [windowsSmokeScript, ...arguments_]
      : [...arguments_],
    {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(windowsSmokeScript
      ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
      : {}),
    },
  );
}

export async function reserveLoopbackPort(port = 0) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        { host: LOOPBACK_HOST, port, exclusive: true },
        resolve,
      );
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no_address");
    return address.port;
  } catch (error) {
    throw new SshTunnelError(
      "ssh_local_port_unavailable",
      "A local port for the SSH connection could not be allocated.",
      error,
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(
      () => undefined,
    );
  }
}

export async function waitForLoopbackPort(input) {
  const deadline = Date.now() + input.timeoutMilliseconds;
  while (Date.now() < deadline) {
    const failure = input.failure();
    if (failure) throw classifySshFailure(failure);
    if (await canConnect(input.host, input.port)) return;
    await new Promise((resolve) =>
      setTimeout(resolve, READINESS_RETRY_MILLISECONDS),
    );
  }
  const failure = input.failure();
  if (failure) throw classifySshFailure(failure);
  throw new SshTunnelError(
    "ssh_tunnel_timeout",
    "The SSH connection did not become ready before it timed out.",
  );
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connectSocket({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function terminateExactChild(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const terminated = await Promise.race([
    exited.then(() => true),
    delay(timeoutMilliseconds).then(() => false),
  ]);
  if (terminated || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  const killed = await Promise.race([
    exited.then(() => true),
    delay(timeoutMilliseconds).then(() => false),
  ]);
  if (!killed && child.exitCode === null && child.signalCode === null) {
    throw new SshTunnelError(
      "ssh_tunnel_cleanup_failed",
      "The SSH process did not stop cleanly.",
    );
  }
}

function observeChild(child) {
  let active = false;
  let outputBytes = 0;
  let outputOverflow = false;
  let spawnError;
  let exited = false;
  let stderr = "";
  const observe = (chunk, capture) => {
    if (active) return;
    outputBytes += chunk.byteLength;
    if (capture && stderr.length < MAXIMUM_OUTPUT_BYTES) {
      stderr += chunk
        .subarray(0, Math.max(0, MAXIMUM_OUTPUT_BYTES - stderr.length))
        .toString("utf8");
    }
    if (outputBytes > MAXIMUM_OUTPUT_BYTES && !outputOverflow) {
      outputOverflow = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout?.on("data", (chunk) => observe(chunk, false));
  child.stderr?.on("data", (chunk) => observe(chunk, true));
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", () => {
    exited = true;
  });
  return {
    promoteActive: () => {
      active = true;
      outputBytes = 0;
      outputOverflow = false;
      stderr = "";
    },
    failure: () =>
      spawnError || exited || outputOverflow
        ? { spawnError, stderr, outputOverflow }
        : undefined,
  };
}

function sanitizeOutput(value) {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 4_096);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
