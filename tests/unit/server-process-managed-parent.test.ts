import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { BackendConfigurationFileError } from "../../src/server/config/backend-configuration.js";
import {
  MANAGED_PARENT_ENVIRONMENT_VALUE,
  MANAGED_PARENT_ENVIRONMENT_VARIABLE,
  MANAGED_PARENT_PROTOCOL,
  MANAGED_PARENT_PROTOCOL_VERSION,
  runServerProcess,
} from "../../src/server/index.js";
import type { RunningApplication } from "../../src/server/production-application.js";

class FakeProcessHost extends EventEmitter {
  readonly env: NodeJS.ProcessEnv;
  connected = true;
  exitCode: number | undefined;
  readonly sent: unknown[] = [];
  readonly stderrText: string[] = [];
  readonly stderr = {
    write: (value: string | Uint8Array) => {
      this.stderrText.push(String(value));
      return true;
    },
  };

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }

  constructor(managed = true) {
    super();
    this.env = managed
      ? {
          [MANAGED_PARENT_ENVIRONMENT_VARIABLE]:
            MANAGED_PARENT_ENVIRONMENT_VALUE,
        }
      : {};
  }

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  exit(_code?: number): never {
    throw new Error("unexpected_process_exit");
  }
}

function application(
  close: () => Promise<void>,
  host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1",
): RunningApplication {
  return {
    authenticationRequired: true,
    server: {} as Server,
    listening: { host, port: 54_321 },
    createManagedLocalPairing: () => ({ token: "p".repeat(43), expiresAt: "2026-09-13T19:00:00.000Z" }),
    createManagementPairing: () => { throw new Error("Managed startup must use its dedicated pairing grant."); },
    close,
  };
}

const shutdownMessage = Object.freeze({
  protocol: MANAGED_PARENT_PROTOCOL,
  version: MANAGED_PARENT_PROTOCOL_VERSION,
  type: "shutdown",
});

describe("managed parent server process", () => {
  it("publishes the actual bound loopback endpoint and accepts exact shutdown", async () => {
    const host = new FakeProcessHost();
    const close = vi.fn(async () => undefined);
    await runServerProcess({
      host,
      startApplication: async () => application(close),
    });

    expect(host.sent).toEqual([
      {
        protocol: MANAGED_PARENT_PROTOCOL,
        version: MANAGED_PARENT_PROTOCOL_VERSION,
        type: "ready",
        host: "127.0.0.1",
        port: 54_321,
        baseUrl: "http://127.0.0.1:54321",
        authenticationRequired: true,
        pairingToken: "p".repeat(43),
      },
    ]);

    expect(host.stderrText.join("")).not.toContain("p".repeat(43));
    expect(JSON.stringify(host.env)).not.toContain("p".repeat(43));

    host.emit("message", { ...shutdownMessage, extra: true });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    host.emit("message", shutdownMessage);
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(host.exitCode).toBe(0);
      expect(host.connected).toBe(false);
    });
  });

  it("publishes auth-disabled readiness without creating or exposing a pairing grant", async () => {
    const host = new FakeProcessHost();
    const close = vi.fn(async () => undefined);
    const createManagedLocalPairing = vi.fn(() => { throw new Error("Enrollment must not run with authentication disabled."); });
    await runServerProcess({
      host,
      startApplication: async () => ({ ...application(close), authenticationRequired: false, createManagedLocalPairing }),
    });
    expect(host.sent).toEqual([{
      protocol: MANAGED_PARENT_PROTOCOL, version: MANAGED_PARENT_PROTOCOL_VERSION,
      type: "ready", host: "127.0.0.1", port: 54_321, baseUrl: "http://127.0.0.1:54321", authenticationRequired: false,
    }]);
    expect(createManagedLocalPairing).not.toHaveBeenCalled();
    host.emit("message", shutdownMessage);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("gracefully closes when its owning IPC parent disconnects", async () => {
    const host = new FakeProcessHost();
    const close = vi.fn(async () => undefined);
    await runServerProcess({
      host,
      startApplication: async () => application(close),
    });

    host.connected = false;
    host.emit("disconnect");
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(host.exitCode).toBe(0);
    });
  });

  it("reports a closed actionable startup failure over managed IPC", async () => {
    const host = new FakeProcessHost();
    await runServerProcess({
      host,
      startApplication: async () => {
        throw new BackendConfigurationFileError("Invalid server config.");
      },
    });

    expect(host.sent).toEqual([
      {
        protocol: MANAGED_PARENT_PROTOCOL,
        version: MANAGED_PARENT_PROTOCOL_VERSION,
        type: "startup_failed",
        code: "configuration_invalid",
        message: "Invalid server config.",
      },
    ]);
    expect(host.stderrText.join("")).toBe("Invalid server config.\n");
    expect(host.exitCode).toBe(1);
  });

  it("does not activate the contract without the exact discriminator", async () => {
    const host = new FakeProcessHost(false);
    host.env[MANAGED_PARENT_ENVIRONMENT_VARIABLE] = "electron-local-v2";
    const close = vi.fn(async () => undefined);
    await runServerProcess({
      host,
      startApplication: async () => application(close),
    });

    expect(host.sent).toEqual([]);
    host.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("refuses managed startup without a live IPC channel", async () => {
    const host = new FakeProcessHost();
    host.connected = false;
    const startApplication = vi.fn(async () =>
      application(async () => undefined),
    );
    await runServerProcess({ host, startApplication });

    expect(startApplication).not.toHaveBeenCalled();
    expect(host.stderrText.join("")).toContain("active parent IPC channel");
    expect(host.exitCode).toBe(1);
  });

  it("fails closed if a managed launch is configured for wildcard ingress", async () => {
    const host = new FakeProcessHost();
    const close = vi.fn(async () => undefined);
    await runServerProcess({
      host,
      startApplication: async () => application(close, "0.0.0.0"),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(host.sent).toEqual([
      {
        protocol: MANAGED_PARENT_PROTOCOL,
        version: MANAGED_PARENT_PROTOCOL_VERSION,
        type: "startup_failed",
        code: "configuration_invalid",
        message: "The managed Sedes server must listen on 127.0.0.1.",
      },
    ]);
    expect(host.exitCode).toBe(1);
  });
});
