import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export class RawCodexAppServerClient {
  #capturedResponses = [];
  #capturedResponseWaiters = [];
  #child;
  #closed = false;
  #exitPromise;
  #nextRequestId = 1;
  #notifications = [];
  #notificationWaiters = [];
  #pending = new Map();
  #stderr = "";
  #serverRequestHandler;
  #withheldResponseMethods;

  constructor(input) {
    this.codexBinary = input.codexBinary;
    this.cwd = input.cwd;
    this.environment = input.environment;
    this.#serverRequestHandler = input.serverRequestHandler;
    this.#withheldResponseMethods = new Set(
      input.faultInjection?.withholdResponseMethods ?? [],
    );
  }

  get pid() {
    return this.#child?.pid;
  }

  get stderr() {
    return this.#stderr;
  }

  async start() {
    if (this.#child) throw new Error("raw_codex_client_already_started");
    const child = spawn(
      this.codexBinary,
      ["app-server", "--strict-config", "--stdio"],
      {
        cwd: this.cwd,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => {
      child.once("error", (error) => {
        this.#fail(error);
        resolve({ error });
      });
      child.once("exit", (code, signal) => {
        this.#fail(
          new Error(
            `codex_app_server_exited: code=${String(code)} signal=${String(signal)}`,
          ),
        );
        resolve({ code, signal });
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => this.#receiveLine(line));

    try {
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: "sedes_c0_probe",
          title: "Sedes C0 protocol probe",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
        },
      });
      await this.notify("initialized", {});
      return initialized;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.#nextRequestId++;
    let pending;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex_app_server_request_timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending = { method, resolve, reject, timer };
      this.#pending.set(id, pending);
    });
    try {
      await this.#send({ method, id, params });
    } catch (error) {
      if (this.#pending.delete(id)) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    return await response;
  }

  async notify(method, params) {
    await this.#send({ method, params });
  }

  async nextNotification(method, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const existingIndex = this.#notifications.findIndex(
      (notification) => notification.method === method,
    );
    if (existingIndex >= 0) {
      return this.#notifications.splice(existingIndex, 1)[0];
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#notificationWaiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (index >= 0) this.#notificationWaiters.splice(index, 1);
        reject(new Error(`codex_app_server_notification_timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#notificationWaiters.push({ method, resolve, reject, timer });
    });
  }

  async nextCapturedResponse(method, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const existingIndex = this.#capturedResponses.findIndex(
      (captured) => captured.method === method,
    );
    if (existingIndex >= 0) {
      return this.#capturedResponses.splice(existingIndex, 1)[0];
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#capturedResponseWaiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (index >= 0) this.#capturedResponseWaiters.splice(index, 1);
        reject(
          new Error(`codex_app_server_captured_response_timeout: ${method}`),
        );
      }, timeoutMs);
      timer.unref?.();
      this.#capturedResponseWaiters.push({
        method,
        resolve,
        reject,
        timer,
      });
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    this.#fail(new Error("codex_app_server_client_closed"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = this.#exitPromise;
    child.kill("SIGTERM");
    if ((await waitForExit(exited, 2_000)) === "timeout") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    }
  }

  async terminate(signal = "SIGKILL") {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = this.#exitPromise;
    child.kill(signal);
    await exited;
  }

  async #send(message) {
    if (this.#closed || !this.#child?.stdin.writable) {
      throw new Error("codex_app_server_transport_closed");
    }
    if (!isOutboundEnvelope(message)) {
      throw new Error("codex_app_server_invalid_outbound_envelope");
    }
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("codex_app_server_outbound_frame_too_large");
    }
    if (!this.#child.stdin.write(frame, "utf8")) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          this.#child.stdin.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          this.#child.stdin.off("drain", onDrain);
          reject(error);
        };
        this.#child.stdin.once("drain", onDrain);
        this.#child.stdin.once("error", onError);
      });
    }
  }

  #receiveLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      this.#fail(new Error("codex_app_server_inbound_frame_too_large"));
      this.#child?.kill("SIGTERM");
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#fail(
        new Error("codex_app_server_malformed_json", { cause: error }),
      );
      this.#child?.kill("SIGTERM");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#fail(new Error("codex_app_server_invalid_envelope"));
      return;
    }
    if ("jsonrpc" in message) {
      this.#fail(new Error("codex_app_server_unexpected_jsonrpc_member"));
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (
      hasId &&
      isRequestId(message.id) &&
      !hasMethod &&
      hasResult !== hasError &&
      (!hasError || isRpcError(message.error))
    ) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (this.#withheldResponseMethods.has(pending.method)) {
        this.#captureResponse({
          id: message.id,
          message,
          method: pending.method,
        });
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (hasError) {
        const error = new Error(
          `codex_app_server_error: ${pending.method}: ${JSON.stringify(message.error)}`,
        );
        error.rpcError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      hasId &&
      isRequestId(message.id) &&
      hasMethod &&
      typeof message.method === "string" &&
      message.method.length > 0 &&
      !hasResult &&
      !hasError
    ) {
      void (async () => {
        if (this.#serverRequestHandler) {
          const result = await this.#serverRequestHandler(message);
          await this.#send({ id: message.id, result });
        } else {
          await this.#send({
            id: message.id,
            error: {
              code: -32601,
              message: `Probe does not implement server request ${message.method}.`,
            },
          });
        }
      })().catch((error) => this.#fail(error));
      return;
    }
    if (
      !hasId &&
      hasMethod &&
      typeof message.method === "string" &&
      message.method.length > 0 &&
      !hasResult &&
      !hasError
    ) {
      const waiterIndex = this.#notificationWaiters.findIndex(
        (waiter) => waiter.method === message.method,
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.#notificationWaiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.#notifications.push(message);
      }
      return;
    }
    this.#fail(new Error("codex_app_server_invalid_envelope_shape"));
  }

  #captureResponse(captured) {
    const waiterIndex = this.#capturedResponseWaiters.findIndex(
      (waiter) => waiter.method === captured.method,
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.#capturedResponseWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(captured);
    } else {
      this.#capturedResponses.push(captured);
    }
  }

  #fail(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#notificationWaiters = [];
    for (const waiter of this.#capturedResponseWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#capturedResponseWaiters = [];
  }
}

function isRequestId(value) {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function isRpcError(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string"
  );
}

function isOutboundEnvelope(message) {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    Object.hasOwn(message, "jsonrpc")
  ) {
    return false;
  }
  const hasId = Object.hasOwn(message, "id");
  const hasMethod = Object.hasOwn(message, "method");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (
    hasMethod &&
    typeof message.method === "string" &&
    message.method.length > 0 &&
    !hasResult &&
    !hasError
  ) {
    return !hasId || isRequestId(message.id);
  }
  return (
    hasId &&
    isRequestId(message.id) &&
    !hasMethod &&
    hasResult !== hasError &&
    (!hasError || isRpcError(message.error))
  );
}

async function waitForExit(exitPromise, timeoutMs) {
  let timer;
  const result = await Promise.race([
    exitPromise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs, "timeout");
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  return result;
}

export function probeEnvironment(codexHome) {
  const allowed = ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "USER"];
  return Object.fromEntries([
    ...allowed.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
    ["HOME", codexHome],
    ["CODEX_HOME", codexHome],
  ]);
}
