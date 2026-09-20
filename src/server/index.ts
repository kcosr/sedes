import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunningApplication } from "./production-application.js";
import { startProductionApplication } from "./production-application.js";
import { BackendConfigurationFileError } from "./config/backend-configuration.js";
import { ProcessShutdownCoordinator } from "./runtime/process-shutdown.js";
import { startDeliveryDiagnostics } from "./diagnostics/event-loop-diagnostics.js";
import { startMainCpuProfile } from "./diagnostics/main-cpu-profile.js";

export const MANAGED_PARENT_ENVIRONMENT_VARIABLE =
  "SEDES_MANAGED_PARENT_PROTOCOL" as const;
export const MANAGED_PARENT_ENVIRONMENT_VALUE = "electron-local-v1" as const;
export const MANAGED_PARENT_PROTOCOL = "sedes.electron-managed-local" as const;
export const MANAGED_PARENT_PROTOCOL_VERSION = 1 as const;

export type ManagedParentServerMessage =
  | ({
      readonly protocol: typeof MANAGED_PARENT_PROTOCOL;
      readonly version: typeof MANAGED_PARENT_PROTOCOL_VERSION;
      readonly type: "ready";
      readonly host: "127.0.0.1";
      readonly port: number;
      readonly baseUrl: string;
    } & ({ readonly authenticationRequired: true; readonly pairingToken: string } | { readonly authenticationRequired: false }))
  | {
      readonly protocol: typeof MANAGED_PARENT_PROTOCOL;
      readonly version: typeof MANAGED_PARENT_PROTOCOL_VERSION;
      readonly type: "startup_failed";
      readonly code:
        | "configuration_invalid"
        | "endpoint_in_use"
        | "state_in_use"
        | "startup_failed";
      readonly message: string;
    };

interface ServerProcessHost {
  readonly env: NodeJS.ProcessEnv;
  readonly connected?: boolean;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  exitCode?: number;
  disconnect?: () => void;
  send?: (message: ManagedParentServerMessage) => boolean;
  once(event: "SIGINT" | "SIGTERM" | "disconnect", listener: () => void): this;
  on(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  exit(code?: number): never;
}

interface ServerProcessDependencies {
  readonly host?: ServerProcessHost;
  readonly startApplication?: (
    environment?: NodeJS.ProcessEnv,
  ) => Promise<RunningApplication>;
}

export function startupMessage(error: unknown): string {
  if (error instanceof BackendConfigurationFileError) {
    return error.message;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    const addressError = error as NodeJS.ErrnoException & {
      address?: string;
      port?: number;
    };
    const endpoint =
      addressError.address && addressError.port
        ? `${addressError.address}:${addressError.port}`
        : "the configured endpoint";
    return `Sedes cannot listen on ${endpoint} because it is already in use.`;
  }
  if (stateOwnershipFailure(error)) {
    return error.message;
  }
  return "The Sedes server could not start.";
}

function startupFailureCode(
  error: unknown,
): Extract<ManagedParentServerMessage, { type: "startup_failed" }>["code"] {
  if (error instanceof BackendConfigurationFileError) {
    return "configuration_invalid";
  }
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return "endpoint_in_use";
  }
  if (stateOwnershipFailure(error)) return "state_in_use";
  return "startup_failed";
}

function stateOwnershipFailure(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("Another Sedes process owns") ||
      (error.message.startsWith("The Sedes") && error.message.includes("lock")))
  );
}

function isManagedShutdownMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    Object.keys(message).length === 3 &&
    message.protocol === MANAGED_PARENT_PROTOCOL &&
    message.version === MANAGED_PARENT_PROTOCOL_VERSION &&
    message.type === "shutdown"
  );
}

function sendManagedMessage(
  host: ServerProcessHost,
  message: ManagedParentServerMessage,
): boolean {
  if (host.connected !== true || typeof host.send !== "function") return false;
  try {
    host.send(message);
    return true;
  } catch {
    return false;
  }
}

export async function runServerProcess(
  dependencies: ServerProcessDependencies = {},
): Promise<void> {
  const host = dependencies.host ?? (process as unknown as ServerProcessHost);
  const startApplication =
    dependencies.startApplication ?? startProductionApplication;
  const managed =
    host.env[MANAGED_PARENT_ENVIRONMENT_VARIABLE] ===
    MANAGED_PARENT_ENVIRONMENT_VALUE;

  if (managed && (typeof host.send !== "function" || host.connected !== true)) {
    host.stderr.write(
      "The managed Sedes server requires an active parent IPC channel.\n",
    );
    host.exitCode = 1;
    return;
  }

  let application: RunningApplication | undefined;
  const stopDiagnostics = startDeliveryDiagnostics("main");
  const stopCpuProfile = startMainCpuProfile(host.env);
  let shutdownRequested = false;
  let requestShutdown: (() => Promise<void>) | undefined;
  const onManagedShutdownMessage = (message: unknown): void => {
    if (!isManagedShutdownMessage(message)) return;
    shutdownRequested = true;
    void requestShutdown?.();
  };
  const onManagedDisconnect = (): void => {
    shutdownRequested = true;
    void requestShutdown?.();
  };
  if (managed) {
    host.on("message", onManagedShutdownMessage);
    host.once("disconnect", onManagedDisconnect);
  }

  try {
    application = await startApplication(host.env);
  } catch (error) {
    const message = startupMessage(error);
    host.stderr.write(`${message}\n`);
    if (managed) {
      sendManagedMessage(host, {
        protocol: MANAGED_PARENT_PROTOCOL,
        version: MANAGED_PARENT_PROTOCOL_VERSION,
        type: "startup_failed",
        code: startupFailureCode(error),
        message,
      });
      host.removeListener("message", onManagedShutdownMessage);
    }
    host.exitCode = 1;
    await stopCpuProfile();
    await stopDiagnostics();
    return;
  }

  const shutdown = new ProcessShutdownCoordinator({
    application,
    deadlineMilliseconds: 30_000,
    report: (message) => host.stderr.write(`${message}\n`),
    terminate: (code) => host.exit(code),
  });
  requestShutdown = async (): Promise<void> => {
    const outcome = await shutdown.shutdown();
    if (outcome.status === "closed") {
      await stopCpuProfile();
      await stopDiagnostics();
      host.removeListener("message", onManagedShutdownMessage);
      host.exitCode = 0;
      if (managed && host.connected === true) host.disconnect?.();
    }
  };
  host.once("SIGINT", () => void requestShutdown!());
  host.once("SIGTERM", () => void requestShutdown!());

  if (managed) {
    if (shutdownRequested || host.connected !== true) {
      await requestShutdown();
      return;
    }
    if (application.listening.host !== "127.0.0.1") {
      const message = "The managed Sedes server must listen on 127.0.0.1.";
      host.stderr.write(`${message}\n`);
      sendManagedMessage(host, {
        protocol: MANAGED_PARENT_PROTOCOL,
        version: MANAGED_PARENT_PROTOCOL_VERSION,
        type: "startup_failed",
        code: "configuration_invalid",
        message,
      });
      await requestShutdown();
      host.exitCode = 1;
      return;
    }
    const { port } = application.listening;
    const readyPublished = sendManagedMessage(host, {
      protocol: MANAGED_PARENT_PROTOCOL,
      version: MANAGED_PARENT_PROTOCOL_VERSION,
      type: "ready",
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      ...(application.authenticationRequired
        ? { authenticationRequired: true as const, pairingToken: application.createManagedLocalPairing().token }
        : { authenticationRequired: false as const }),
    });
    if (!readyPublished) await requestShutdown();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await runServerProcess();
