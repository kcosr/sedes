import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { get } from "node:http";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const MAXIMUM_LOGIN_SHELL_BYTES = 64 * 1024;
const LOGIN_SHELL_TIMEOUT_MILLISECONDS = 5_000;
const START_TIMEOUT_MILLISECONDS = 60_000;
const STOP_TIMEOUT_MILLISECONDS = 32_000;
const KILL_TIMEOUT_MILLISECONDS = 2_000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STARTUP_FAILURE_CODES = new Set([
  "configuration_invalid",
  "endpoint_in_use",
  "state_in_use",
  "startup_failed",
]);
const LOGIN_PATH_START = "__SEDES_LOGIN_PATH_START__";
const LOGIN_PATH_END = "__SEDES_LOGIN_PATH_END__";
const PRINT_LOGIN_PATH =
  `/usr/bin/printf '%s\\n' '${LOGIN_PATH_START}'; ` +
  `/usr/bin/printenv PATH; ` +
  `/usr/bin/printf '%s\\n' '${LOGIN_PATH_END}'`;

export class LocalServerError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalServerError";
    this.code = code;
  }
}

export function validateLocalStartInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    typeof input.connectionId !== "string" ||
    !UUID_V4.test(input.connectionId)
  ) {
    throw new LocalServerError(
      "connection_runtime_input_invalid",
      "The connection runtime identifier is invalid.",
    );
  }
  return Object.freeze({ connectionId: input.connectionId });
}

export function managedLocalEnvironment(source, paths) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("SEDES_") ||
      name === "ALLOWED_TAILSCALE_HOSTS" ||
      name === "APP_STATE_DIR" ||
      name === "PORT" ||
      name === "WORKSPACE_ROOTS"
    ) {
      delete environment[name];
    }
  }
  return {
    ...environment,
    APP_STATE_DIR: paths.stateDirectory,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: "0",
    SEDES_BIND_HOST: LOOPBACK_HOST,
    SEDES_CONFIG_FILE: paths.configurationFilename,
    SEDES_MANAGED_PARENT_PROTOCOL: "electron-local-v1",
    ...(source.SEDES_AUTH_REQUIRED === undefined ? {} : { SEDES_AUTH_REQUIRED: source.SEDES_AUTH_REQUIRED }),
  };
}

export function readLoginShellPath(
  platform,
  environment,
  implementation = execFile,
) {
  const configuredShell = environment.SHELL;
  const executable =
    typeof configuredShell === "string" &&
    path.isAbsolute(configuredShell) &&
    configuredShell.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/u.test(configuredShell)
      ? configuredShell
      : platform === "darwin"
        ? "/bin/zsh"
        : platform === "linux"
          ? "/bin/bash"
          : undefined;
  if (!executable) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    implementation(
      executable,
      ["-ilc", PRINT_LOGIN_PATH],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: MAXIMUM_LOGIN_SHELL_BYTES,
        shell: false,
        timeout: LOGIN_SHELL_TIMEOUT_MILLISECONDS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const start = stdout.indexOf(LOGIN_PATH_START);
        const end = stdout.indexOf(
          LOGIN_PATH_END,
          start + LOGIN_PATH_START.length,
        );
        if (start === -1 || end === -1) {
          resolve(undefined);
          return;
        }
        const value = stdout
          .slice(start + LOGIN_PATH_START.length, end)
          .replace(/^\r?\n/u, "")
          .replace(/\r?\n$/u, "");
        resolve(value.length === 0 ? undefined : value);
      },
    );
  });
}

export async function hydrateManagedLocalPath(environment, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return environment;
  let loginPath;
  try {
    loginPath = await (options.readLoginShellPath ?? readLoginShellPath)(
      platform,
      environment,
    );
  } catch {
    return environment;
  }
  if (typeof loginPath !== "string" || loginPath.length === 0) {
    return environment;
  }
  const entries = [];
  const seen = new Set();
  for (const value of [loginPath, environment.PATH]) {
    if (typeof value !== "string") continue;
    for (const entry of value.split(":")) {
      if (entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries.length === 0
    ? environment
    : { ...environment, PATH: entries.join(":") };
}

export function spawnLocalServer(
  executable,
  entrypoint,
  resourceRoot,
  environment,
  implementation = spawn,
) {
  return implementation(executable, [entrypoint], {
    cwd: resourceRoot,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
}

export class LocalServerManager {
  #active;
  #connecting;
  #electronExecutable;
  #environment;
  #generation = 0;
  #healthCheck;
  #pair;
  #saveCredential;
  #revokeCredential;
  #hydrateEnvironment;
  #notify;
  #operation = Promise.resolve();
  #pendingStart;
  #prepareFilesystem;
  #resourceRoot;
  #spawnProcess;
  #terminateProcess;
  #userDataDirectory;

  constructor(input) {
    if (
      !input ||
      !path.isAbsolute(input.electronExecutable) ||
      !path.isAbsolute(input.resourceRoot) ||
      !path.isAbsolute(input.userDataDirectory)
    ) {
      throw new LocalServerError(
        "local_server_configuration_invalid",
        "The managed local server paths are invalid.",
      );
    }
    this.#electronExecutable = path.resolve(input.electronExecutable);
    this.#resourceRoot = path.resolve(input.resourceRoot);
    this.#userDataDirectory = path.resolve(input.userDataDirectory);
    this.#environment = { ...(input.environment ?? process.env) };
    this.#notify = input.notify ?? (() => undefined);
    this.#healthCheck = input.healthCheck ?? checkLocalHealth;
    this.#pair = input.pair ?? pairLocalServer;
    this.#saveCredential = input.saveCredential;
    this.#revokeCredential = input.revokeCredential ?? revokeLocalCredential;
    this.#hydrateEnvironment =
      input.hydrateEnvironment ?? hydrateManagedLocalPath;
    this.#prepareFilesystem =
      input.prepareFilesystem ?? prepareManagedLocalFilesystem;
    this.#spawnProcess = input.spawnProcess ?? spawnLocalServer;
    this.#terminateProcess = input.terminateProcess ?? terminateExactChild;
  }

  getStatus() {
    if (this.#active) {
      return Object.freeze({
        status: "connected",
        connectionId: this.#active.connectionId,
        baseUrl: this.#active.baseUrl,
        authenticationRequired: this.#active.authenticationRequired,
      });
    }
    if (this.#connecting) {
      return Object.freeze({
        status: "connecting",
        connectionId: this.#connecting.connectionId,
      });
    }
    return Object.freeze({ status: "disconnected" });
  }

  start(rawInput) {
    const { connectionId } = validateLocalStartInput(rawInput);
    if (this.#active?.connectionId === connectionId) {
      return Promise.resolve(
        Object.freeze({ connectionId, baseUrl: this.#active.baseUrl, authenticationRequired: this.#active.authenticationRequired }),
      );
    }
    if (this.#pendingStart?.connectionId === connectionId) {
      return this.#pendingStart.promise;
    }
    const generation = ++this.#generation;
    this.#connecting?.child?.kill("SIGTERM");
    const promise = this.#serialize(() => this.#start(connectionId, generation));
    this.#pendingStart = { connectionId, promise };
    void promise.then(
      () => this.#clearPending(promise),
      () => this.#clearPending(promise),
    );
    return promise;
  }

  disconnect(rawInput) {
    const { connectionId } = validateLocalStartInput(rawInput);
    if (
      this.#active?.connectionId !== connectionId &&
      this.#connecting?.connectionId !== connectionId &&
      this.#pendingStart?.connectionId !== connectionId
    ) {
      return Promise.resolve();
    }
    ++this.#generation;
    if (this.#connecting?.connectionId === connectionId) {
      this.#connecting.child?.kill("SIGTERM");
    }
    return this.#serialize(() => this.#disconnect(connectionId));
  }

  disconnectAll() {
    ++this.#generation;
    this.#connecting?.child?.kill("SIGTERM");
    return this.#serialize(() => this.#disconnect());
  }

  async #start(connectionId, generation) {
    if (generation !== this.#generation) throw cancelled();
    if (this.#active) {
      await this.#disconnect();
      if (generation !== this.#generation) throw cancelled();
    }
    const paths = await this.#prepareFilesystem({
      resourceRoot: this.#resourceRoot,
      userDataDirectory: this.#userDataDirectory,
    });
    if (generation !== this.#generation) throw cancelled();
    const environment = await this.#hydrateEnvironment(
      managedLocalEnvironment(this.#environment, paths),
    );
    if (generation !== this.#generation) throw cancelled();
    let child;
    try {
      child = this.#spawnProcess(
        this.#electronExecutable,
        paths.serverEntrypoint,
        paths.resourceRoot,
        environment,
      );
    } catch (error) {
      throw classifyStartFailure({ spawnError: error });
    }
    const diagnostics = observeChild(child);
    this.#connecting = { child, connectionId, generation };
    try {
      const ready = await waitForReady(child, {
        connectionId,
        timeoutMilliseconds: START_TIMEOUT_MILLISECONDS,
        authenticationRequired: this.#environment.SEDES_AUTH_REQUIRED !== "false",
        failure: diagnostics.failure,
      });
      if (generation !== this.#generation) throw cancelled();
      if (ready.authenticationRequired) {
        const credential = await this.#pair(ready);
        try {
          if (generation !== this.#generation) throw cancelled();
          await this.#healthCheck({ host: LOOPBACK_HOST, port: ready.port, credential });
          if (generation !== this.#generation) throw cancelled();
          if (typeof this.#saveCredential !== "function") {
            throw new LocalServerError("local_server_auth_failed", "Secure credential storage is unavailable.");
          }
          await this.#saveCredential({ profileId: "00000000-0000-4000-8000-000000000001", serverUrl: ready.baseUrl, credential });
          if (generation !== this.#generation) throw cancelled();
        } catch (error) {
          await this.#revokeCredential({ baseUrl: ready.baseUrl, credential }).catch(() => undefined);
          throw error;
        }
      } else {
        await this.#healthCheck({ host: LOOPBACK_HOST, port: ready.port });
        if (generation !== this.#generation) throw cancelled();
      }
      if (diagnostics.failure()) throw classifyStartFailure(diagnostics.failure());
      diagnostics.promoteActive();
      const active = {
        child,
        connectionId,
        generation,
        baseUrl: ready.baseUrl,
        authenticationRequired: ready.authenticationRequired,
        stopping: false,
        diagnostics,
      };
      this.#active = active;
      this.#connecting = undefined;
      child.once("exit", (code, signal) =>
        this.#handleUnexpectedExit(active, code, signal),
      );
      return Object.freeze({ connectionId, baseUrl: active.baseUrl, authenticationRequired: active.authenticationRequired });
    } catch (error) {
      this.#connecting = undefined;
      await this.#terminateProcess(child).catch(() => undefined);
      throw generation !== this.#generation
        ? cancelled()
        : error instanceof LocalServerError
          ? error
          : classifyStartFailure(diagnostics.failure() ?? {}, error);
    }
  }

  async #disconnect(connectionId) {
    const active = this.#active;
    if (connectionId && active?.connectionId !== connectionId) return;
    this.#active = undefined;
    if (!active) return;
    active.stopping = true;
    await this.#terminateProcess(active.child);
    this.#notify(
      Object.freeze({
        status: "disconnected",
        connectionId: active.connectionId,
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
    this.#notify(
      Object.freeze({
        status: "disconnected",
        connectionId: active.connectionId,
        error: Object.freeze({
          code: "local_server_lost",
          message: "The managed local Sedes server stopped unexpectedly.",
        }),
      }),
    );
  }

  #serialize(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => undefined);
    return result;
  }

  #clearPending(promise) {
    if (this.#pendingStart?.promise === promise) this.#pendingStart = undefined;
  }
}

export async function prepareManagedLocalFilesystem(input) {
  const resourceRoot = await canonicalDirectory(input.resourceRoot);
  const userDataDirectory = await canonicalDirectory(input.userDataDirectory, {
    create: true,
  });
  const managedRoot = path.join(userDataDirectory, "managed-local");
  const configurationDirectory = path.join(managedRoot, "config");
  const stateDirectory = path.join(managedRoot, "state");
  for (const directory of [
    managedRoot,
    configurationDirectory,
    stateDirectory,
  ]) {
    await ensurePrivateDirectory(directory);
  }
  const configurationFilename = path.join(
    configurationDirectory,
    "server.json",
  );
  const defaultConfiguration = await canonicalFile(
    path.join(resourceRoot, "defaults", "server.json"),
    resourceRoot,
  );
  const serverEntrypoint = await canonicalFile(
    path.join(resourceRoot, "dist", "server", "index.js"),
    resourceRoot,
  );
  await ensureConfiguration(defaultConfiguration, configurationFilename, stateDirectory);
  return Object.freeze({
    resourceRoot,
    configurationFilename,
    stateDirectory,
    serverEntrypoint,
  });
}

function assertBootstrapConfiguration(value, target, stateDirectory) {
  if (value?.schemaVersion === 10 || value && typeof value === "object" &&
    ["executionEnvironments", "backends", "targets", "defaultTargetId", "webSearch"].some(field => field in value)) {
    throw new LocalServerError(
      "local_server_configuration_invalid",
      `Local configuration needs explicit import. Quit Electron and back up managed-local. From a current Sedes checkout run npm run configuration:import -- --file "${target}" --state-directory "${stateDirectory}" --workspace-roots /absolute/workspace-root. Then replace server.json with schemaVersion 11 and packagedClients ["electron"]. Existing configuration and state have been preserved.`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 11 ||
    JSON.stringify(value.packagedClients) !== JSON.stringify(["electron"]) ||
    Object.keys(value).some(key => !["schemaVersion", "packagedClients", "listen", "stateDirectory", "allowedTailscaleHosts"].includes(key))) {
    throw new LocalServerError("local_server_configuration_invalid", "Local requires a schemaVersion 11 bootstrap file with packagedClients [\"electron\"]. Configure environments and backends in Settings.");
  }
  // The desktop runtime owns the installation paths and network perimeter.
  if (value.stateDirectory !== undefined || value.allowedTailscaleHosts?.length ||
    value.listen && (value.listen.host !== undefined && value.listen.host !== LOOPBACK_HOST || value.listen.trustedLanHost !== undefined)) {
    throw new LocalServerError("local_server_configuration_invalid", "Managed Local bootstrap cannot override its state directory or loopback access boundary.");
  }
}

async function ensureConfiguration(source, target, stateDirectory) {
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new LocalServerError(
        "local_server_configuration_invalid",
        "The managed local server configuration is not a regular file.",
      );
    }
    assertBootstrapConfiguration(JSON.parse(await readFile(target, "utf8")), target, stateDirectory);
    await chmod(target, 0o600);
    return;
  }
  assertBootstrapConfiguration(JSON.parse(await readFile(source, "utf8")), target, stateDirectory);
  const temporary = `${target}.incoming-${randomBytes(16).toString("hex")}`;
  try {
    await copyFile(source, temporary, 1);
    await chmod(temporary, 0o600);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function canonicalDirectory(filename, options = {}) {
  if (options.create) await mkdir(filename, { recursive: true, mode: 0o700 });
  const metadata = await lstat(filename);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalServerError(
      "local_server_path_invalid",
      "A managed local server directory is invalid.",
    );
  }
  return realpath(filename);
}

async function ensurePrivateDirectory(filename) {
  const existing = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new LocalServerError(
      "local_server_path_invalid",
      "A managed local server directory is invalid.",
    );
  }
  if (!existing) await mkdir(filename, { mode: 0o700 });
  await chmod(filename, 0o700);
}

async function canonicalFile(filename, root) {
  const canonical = await realpath(filename);
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) {
    throw new LocalServerError(
      "local_server_resource_invalid",
      "A managed local server resource is outside its package.",
    );
  }
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) {
    throw new LocalServerError(
      "local_server_resource_invalid",
      "A managed local server resource is invalid.",
    );
  }
  return canonical;
}

function waitForReady(child, input) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new LocalServerError(
        "local_server_timeout",
        "The managed local Sedes server did not become ready in time.",
      )),
      input.timeoutMilliseconds,
    );
    const onMessage = (message) => {
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        Object.keys(message).length === 5 &&
        message.protocol === "sedes.electron-managed-local" &&
        message.version === 1 &&
        message.type === "startup_failed" &&
        typeof message.code === "string" &&
        STARTUP_FAILURE_CODES.has(message.code) &&
        typeof message.message === "string"
      ) {
        finish(new LocalServerError(
          message.code === "endpoint_in_use"
            ? "local_server_port_unavailable"
            : message.code === "configuration_invalid"
              ? "local_server_configuration_invalid"
              : message.code === "state_in_use"
                ? "local_server_state_in_use"
                : "local_server_start_failed",
          message.message.slice(0, 1_024),
        ));
        return;
      }
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        Object.keys(message).length !== (message.authenticationRequired === true ? 8 : 7) ||
        message.protocol !== "sedes.electron-managed-local" ||
        message.version !== 1 ||
        message.type !== "ready" ||
        message.host !== LOOPBACK_HOST ||
        !Number.isSafeInteger(message.port) ||
        message.port < 1 ||
        message.port > 65_535 ||
        message.baseUrl !== `http://${LOOPBACK_HOST}:${message.port}` ||
        typeof message.authenticationRequired !== "boolean" ||
        message.authenticationRequired !== input.authenticationRequired ||
        (message.authenticationRequired
          ? typeof message.pairingToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(message.pairingToken)
          : Object.hasOwn(message, "pairingToken"))
      ) {
        finish(new LocalServerError(
          "local_server_readiness_invalid",
          "The managed local Sedes server returned an invalid readiness message.",
        ));
        return;
      }
      finish(undefined, Object.freeze({
        port: message.port,
        baseUrl: message.baseUrl,
        authenticationRequired: message.authenticationRequired,
        ...(message.authenticationRequired ? { pairingToken: message.pairingToken } : {}),
      }));
    };
    const onError = () => finish(classifyStartFailure(input.failure() ?? {}));
    const onExit = () => finish(classifyStartFailure(input.failure() ?? {}));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      error ? reject(error) : resolve(value);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function revokeLocalCredential(input) {
  const response = await fetch(`${input.baseUrl}/api/auth/logout`, {
    method: "POST", headers: { Authorization: `Bearer ${input.credential}` },
    redirect: "error", signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new LocalServerError("local_server_auth_failed", "Could not revoke the unused Local credential.");
}

export async function pairLocalServer(input, fetchImplementation = fetch) {
  try {
    const response = await fetchImplementation(`${input.baseUrl}/api/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: input.pairingToken, clientName: "Electron Local", kind: "device" }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("pairing rejected");
    const result = await response.json();
    if (typeof result.credential !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(result.credential)) {
      throw new Error("invalid credential");
    }
    return result.credential;
  } catch {
    // Never surface response bodies or transport errors containing enrollment secrets.
    throw new LocalServerError("local_server_auth_failed", "The managed local Sedes server could not authenticate.");
  }
}

export function checkLocalHealth(input) {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: input.host, port: input.port, path: "/api/health", timeout: 3_000,
        headers: input.credential ? { Authorization: `Bearer ${input.credential}` } : {} },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1_024) request.destroy();
        });
        response.on("end", () => {
          try {
            const decoded = JSON.parse(body);
            if (
              response.statusCode !== 200 ||
              !decoded ||
              typeof decoded !== "object" ||
              Array.isArray(decoded) ||
              Object.keys(decoded).length !== 1 ||
              decoded.status !== "ok"
            ) throw new Error("invalid_health");
            resolve();
          } catch (error) {
            reject(new LocalServerError(
              "local_server_health_invalid",
              "The managed local Sedes server health check failed.",
              error,
            ));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", (error) =>
      reject(new LocalServerError(
        "local_server_health_invalid",
        "The managed local Sedes server health check failed.",
        error,
      )),
    );
  });
}

export async function terminateExactChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (child.connected && typeof child.send === "function") {
    try {
      child.send({
        protocol: "sedes.electron-managed-local",
        version: 1,
        type: "shutdown",
      });
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  if (await raceExit(exited, STOP_TIMEOUT_MILLISECONDS)) return;
  child.kill("SIGTERM");
  if (await raceExit(exited, KILL_TIMEOUT_MILLISECONDS)) return;
  child.kill("SIGKILL");
  if (await raceExit(exited, KILL_TIMEOUT_MILLISECONDS)) return;
  throw new LocalServerError(
    "local_server_cleanup_failed",
    "The managed local Sedes server could not be stopped.",
  );
}

function raceExit(exited, milliseconds) {
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function observeChild(child) {
  let active = false;
  let spawnError;
  let exited = false;
  let stderr = "";
  const consumeStderr = (chunk) => {
    if (active) return;
    if (stderr.length < MAXIMUM_DIAGNOSTIC_BYTES) {
      stderr += chunk
        .subarray(0, MAXIMUM_DIAGNOSTIC_BYTES - stderr.length)
        .toString("utf8");
    }
  };
  child.stdout?.resume();
  child.stderr?.on("data", consumeStderr);
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", () => { exited = true; });
  return {
    promoteActive: () => { active = true; stderr = ""; },
    failure: () =>
      spawnError || exited
        ? { spawnError, exited, stderr }
        : undefined,
  };
}

function classifyStartFailure(observation = {}, cause) {
  if (observation.spawnError?.code === "ENOENT") {
    return new LocalServerError(
      "local_server_runtime_unavailable",
      "The desktop app could not start the local Sedes server.",
      observation.spawnError,
    );
  }
  if (observation.stderr?.toLowerCase().includes("already in use")) {
    return new LocalServerError(
      "local_server_port_unavailable",
      "The managed local Sedes server could not reserve its loopback port.",
    );
  }
  return new LocalServerError(
    "local_server_start_failed",
    "The managed local Sedes server could not start.",
    cause ?? observation.spawnError,
  );
}

function cancelled() {
  return new LocalServerError(
    "local_server_cancelled",
    "The managed local Sedes server start was cancelled.",
  );
}
