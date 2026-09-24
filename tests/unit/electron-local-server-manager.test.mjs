import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hydrateManagedLocalPath,
  LocalServerManager,
  pairLocalServer,
  managedLocalEnvironment,
  prepareManagedLocalFilesystem,
  readLoginShellPath,
  spawnLocalServer,
} from "../../packages/electron-connection-runtime/electron/dist/local-server-manager.mjs";

const temporaryDirectories = [];
const connectionId = "10000000-0000-4000-8000-000000000001";

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = [];

  kill(signal) {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  ready(port, authenticationRequired = true) {
    this.emit("message", {
      protocol: "sedes.electron-managed-local",
      version: 1,
      type: "ready",
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      authenticationRequired,
      ...(authenticationRequired ? { pairingToken: "p".repeat(43) } : {}),
    });
  }

  unexpectedExit(code = 1) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Electron managed local server", () => {
  it("exchanges the IPC token only at the exact local origin and hides failures", async () => {
    const input = { baseUrl: "http://127.0.0.1:32124", pairingToken: "p".repeat(43) };
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ credential: "c".repeat(43) }) }));
    await expect(pairLocalServer(input, request)).resolves.toBe("c".repeat(43));
    expect(request).toHaveBeenCalledWith(`${input.baseUrl}/api/auth/pair`, expect.objectContaining({
      method: "POST", redirect: "error",
      body: JSON.stringify({ token: input.pairingToken, clientName: "Electron Local", kind: "device" }),
    }));
    const error = await pairLocalServer(input, async () => { throw new Error(input.pairingToken); }).catch((error) => error);
    expect(error.code).toBe("local_server_auth_failed");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(input.pairingToken);
    await expect(pairLocalServer(input, async () => ({ ok: true, json: async () => ({ credential: "bad" }) })))
      .rejects.toMatchObject({ code: "local_server_auth_failed" });
  });

  it.each(["storage", "readiness"])("fails closed on %s without publishing a Local connection", async (failure) => {
    const child = new FakeChild();
    const saveCredential = vi.fn(async () => { throw new Error("storage unavailable"); });
    const revokeCredential = vi.fn(async () => undefined);
    const manager = new LocalServerManager({
      electronExecutable: "/opt/electron", resourceRoot: "/opt/resources", userDataDirectory: "/private/user-data",
      prepareFilesystem: async () => ({ resourceRoot: "/opt/resources", serverEntrypoint: "/opt/server.js", configurationFilename: "/private/config", stateDirectory: "/private/state" }),
      hydrateEnvironment: async (environment) => environment,
      pair: async () => "c".repeat(43), healthCheck: async () => undefined,
      revokeCredential,
      saveCredential,
      spawnProcess: () => {
        queueMicrotask(() => failure === "readiness" ? child.emit("message", {
          protocol: "sedes.electron-managed-local", version: 1, type: "ready", host: "127.0.0.1", port: 32124,
          baseUrl: "http://127.0.0.1:32124", authenticationRequired: true, pairingToken: "invalid",
        }) : child.ready(32124));
        return child;
      },
      terminateProcess: async (process) => process.kill("SIGTERM"),
    });
    await expect(manager.start({ connectionId })).rejects.toBeInstanceOf(Error);
    expect(manager.getStatus()).toEqual({ status: "disconnected" });
    expect(child.kills).toEqual(["SIGTERM"]);
    if (failure === "readiness") { expect(saveCredential).not.toHaveBeenCalled(); expect(revokeCredential).not.toHaveBeenCalled(); }
    else expect(revokeCredential).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:32124", credential: "c".repeat(43) });
    if (failure === "storage") expect(saveCredential).toHaveBeenCalledWith({ profileId: "00000000-0000-4000-8000-000000000001", serverUrl: "http://127.0.0.1:32124", credential: "c".repeat(43) });
  });

  it("starts auth-disabled Local without pairing or touching secure storage", async () => {
    const child = new FakeChild();
    const pair = vi.fn(async () => { throw new Error("pairing must not run"); });
    const saveCredential = vi.fn(async () => { throw new Error("keyring unavailable"); });
    const revokeCredential = vi.fn(async () => undefined);
    const healthCheck = vi.fn(async () => undefined);
    const manager = new LocalServerManager({
      electronExecutable: "/opt/electron", resourceRoot: "/opt/resources", userDataDirectory: "/private/user-data",
      environment: { SEDES_AUTH_REQUIRED: "false" },
      prepareFilesystem: async () => ({ resourceRoot: "/opt/resources", serverEntrypoint: "/opt/server.js", configurationFilename: "/private/config", stateDirectory: "/private/state" }),
      hydrateEnvironment: async environment => environment,
      pair, saveCredential, revokeCredential, healthCheck,
      spawnProcess: (_executable, _entry, _root, environment) => {
        expect(environment.SEDES_AUTH_REQUIRED).toBe("false");
        queueMicrotask(() => child.ready(32124, false));
        return child;
      },
      terminateProcess: async process => process.kill("SIGTERM"),
    });
    await expect(manager.start({ connectionId })).resolves.toEqual({ connectionId, baseUrl: "http://127.0.0.1:32124", authenticationRequired: false });
    expect(manager.getStatus()).toMatchObject({ status: "connected", authenticationRequired: false });
    expect(healthCheck).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 32124 });
    expect(pair).not.toHaveBeenCalled();
    expect(saveCredential).not.toHaveBeenCalled();
    expect(revokeCredential).not.toHaveBeenCalled();
    await manager.disconnect({ connectionId });
  });

  it.each([true, false])("rejects child readiness that disagrees with expected auth policy %s", async (required) => {
    const child = new FakeChild();
    const environment = { SEDES_AUTH_REQUIRED: String(required) };
    const pair = vi.fn();
    const manager = new LocalServerManager({
      electronExecutable: "/opt/electron", resourceRoot: "/opt/resources", userDataDirectory: "/private/user-data",
      environment,
      prepareFilesystem: async () => ({ resourceRoot: "/opt/resources", serverEntrypoint: "/opt/server.js", configurationFilename: "/private/config", stateDirectory: "/private/state" }),
      hydrateEnvironment: async value => value,
      pair,
      spawnProcess: () => { queueMicrotask(() => child.ready(32124, !required)); return child; },
      terminateProcess: async process => process.kill("SIGTERM"),
    });
    environment.SEDES_AUTH_REQUIRED = String(!required);
    await expect(manager.start({ connectionId })).rejects.toMatchObject({ code: "local_server_readiness_invalid" });
    expect(pair).not.toHaveBeenCalled();
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("overrides every network and ownership setting while preserving provider environment", () => {
    expect(
      managedLocalEnvironment(
        {
          PATH: "/provider/bin",
          PROVIDER_TOKEN: "secret",
          PORT: "9999",
          SEDES_BIND_HOST: "0.0.0.0",
          SEDES_DEBUG_DELIVERY: "1",
          SEDES_TRUSTED_LAN_HOST: "192.168.1.2",
          SEDES_ELECTRON_LOCAL_WORKSPACE_ROOTS: "/operator/workspace",
          ALLOWED_TAILSCALE_HOSTS: "unexpected.invalid",
          WORKSPACE_ROOTS: "/unexpected/workspace",
        },
        {
          stateDirectory: "/private/state",
          configurationFilename: "/private/config/server.json",
        },
      ),
    ).toEqual({
      PATH: "/provider/bin",
      PROVIDER_TOKEN: "secret",
      APP_STATE_DIR: "/private/state",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: "0",
      SEDES_BIND_HOST: "127.0.0.1",
      SEDES_CONFIG_FILE: "/private/config/server.json",
      SEDES_MANAGED_PARENT_PROTOCOL: "electron-local-v1",
    });
  });

  it.each(["0", "1", "invalid"])("passes the experimental usage value %s through for server validation", value => {
    const environment = managedLocalEnvironment({ SEDES_EXPERIMENTAL_USAGE: value }, {
      stateDirectory: "/private/state", configurationFilename: "/private/config/server.json",
    });
    expect(environment.SEDES_EXPERIMENTAL_USAGE).toBe(value);
  });

  it("spawns the exact Electron binary in Node mode without a shell", () => {
    const child = new FakeChild();
    const implementation = vi.fn(() => child);
    expect(
      spawnLocalServer(
        "/opt/Sedes/electron",
        "/opt/Sedes/resources/local-server/dist/server/index.js",
        "/opt/Sedes/resources/local-server",
        { ELECTRON_RUN_AS_NODE: "1" },
        implementation,
      ),
    ).toBe(child);
    expect(implementation).toHaveBeenCalledWith(
      "/opt/Sedes/electron",
      ["/opt/Sedes/resources/local-server/dist/server/index.js"],
      {
        cwd: "/opt/Sedes/resources/local-server",
        env: { ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
  });

  it.each([
    ["darwin", "/bin/zsh"],
    ["linux", "/bin/bash"],
  ])(
    "reads %s PATH with a bounded fixed login-shell command",
    async (platform, shell) => {
      const implementation = vi.fn(
        (executable, arguments_, options, callback) => {
          callback(
            null,
            "profile output\n__SEDES_LOGIN_PATH_START__\n/login/bin:/shared\n__SEDES_LOGIN_PATH_END__\n",
            "",
          );
        },
      );

      await expect(
        readLoginShellPath(platform, { HOME: "/Users/test" }, implementation),
      ).resolves.toBe("/login/bin:/shared");
      expect(implementation).toHaveBeenCalledWith(
        shell,
        [
          "-ilc",
          "/usr/bin/printf '%s\\n' '__SEDES_LOGIN_PATH_START__'; /usr/bin/printenv PATH; /usr/bin/printf '%s\\n' '__SEDES_LOGIN_PATH_END__'",
        ],
        {
          encoding: "utf8",
          env: { HOME: "/Users/test" },
          maxBuffer: 64 * 1_024,
          shell: false,
          timeout: 5_000,
          windowsHide: true,
        },
        expect.any(Function),
      );
    },
  );

  it("places login-shell PATH entries first and removes duplicates", async () => {
    const environment = { PATH: "/inherited/bin:/shared", TOKEN: "preserved" };
    await expect(
      hydrateManagedLocalPath(environment, {
        platform: "darwin",
        readLoginShellPath: vi.fn(async () => "/login/bin:/shared"),
      }),
    ).resolves.toEqual({
      PATH: "/login/bin:/shared:/inherited/bin",
      TOKEN: "preserved",
    });
  });

  it("does not probe or change PATH on Windows", async () => {
    const environment = { PATH: "C:\\inherited" };
    const probe = vi.fn();
    await expect(
      hydrateManagedLocalPath(environment, {
        platform: "win32",
        readLoginShellPath: probe,
      }),
    ).resolves.toBe(environment);
    expect(probe).not.toHaveBeenCalled();
  });

  it("starts managed Local on macOS without requiring Bubblewrap", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.ready(32127));
      return child;
    });
    const manager = new LocalServerManager({
      electronExecutable: "/Applications/Sedes.app/Contents/MacOS/Sedes",
      resourceRoot: "/Applications/Sedes.app/Contents/Resources/local-server",
      userDataDirectory: "/Users/test/Library/Application Support/Sedes",
      environment: { PATH: "/inherited/bin" },
      hydrateEnvironment: (environment) =>
        hydrateManagedLocalPath(environment, {
          platform: "darwin",
          readLoginShellPath: vi.fn(async () => {
            throw new Error("login shell unavailable");
          }),
        }),
      prepareFilesystem: vi.fn(async () => ({
        resourceRoot: "/Applications/Sedes.app/Contents/Resources/local-server",
        serverEntrypoint:
          "/Applications/Sedes.app/Contents/Resources/local-server/dist/server/index.js",
        configurationFilename:
          "/Users/test/Library/Application Support/Sedes/managed-local/config/server.json",
        stateDirectory:
          "/Users/test/Library/Application Support/Sedes/managed-local/state",
      })),
      healthCheck: vi.fn(async () => undefined),
      pair: vi.fn(async () => "c".repeat(43)),
      revokeCredential: async () => undefined,
      saveCredential: vi.fn(async () => undefined),
      spawnProcess,
      terminateProcess: vi.fn(async (process) => process.kill("SIGTERM")),
    });

    try {
      await expect(manager.start({ connectionId })).resolves.toEqual({
        connectionId,
        baseUrl: "http://127.0.0.1:32127",
        authenticationRequired: true,
      });
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(spawnProcess.mock.calls[0][3].PATH).toBe("/inherited/bin");
      await manager.disconnect({ connectionId });
    } finally {
      platform.mockRestore();
    }
  });

  it("creates private durable config/state once and preserves configuration edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-local-native-"));
    temporaryDirectories.push(root);
    const resourceRoot = path.join(root, "resources", "local-server");
    const userDataDirectory = path.join(root, "user-data");
    await mkdir(path.join(resourceRoot, "defaults"), { recursive: true });
    await mkdir(path.join(resourceRoot, "dist", "server"), { recursive: true });
    await writeFile(
      path.join(resourceRoot, "defaults", "server.json"),
      '{"schemaVersion":11,"packagedClients":["electron"]}',
    );
    await writeFile(path.join(resourceRoot, "dist", "server", "index.js"), "");

    const first = await prepareManagedLocalFilesystem({
      resourceRoot,
      userDataDirectory,
    });
    expect(
      JSON.parse(await readFile(first.configurationFilename, "utf8")),
    ).toEqual({
      schemaVersion: 11,
      packagedClients: ["electron"],
    });
    await writeFile(first.configurationFilename, '{"schemaVersion":11,"packagedClients":["electron"],"listen":{"port":5000}}');
    const second = await prepareManagedLocalFilesystem({
      resourceRoot,
      userDataDirectory,
    });
    expect(second).toEqual(first);
    expect(await readFile(second.configurationFilename, "utf8")).toBe(
      '{"schemaVersion":11,"packagedClients":["electron"],"listen":{"port":5000}}',
    );
  });

  it("preserves legacy configuration and database while requiring explicit import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-local-import-"));
    temporaryDirectories.push(root);
    const resourceRoot = path.join(root, "resources");
    const userDataDirectory = path.join(root, "user-data");
    await mkdir(path.join(resourceRoot, "defaults"), { recursive: true });
    await mkdir(path.join(resourceRoot, "dist", "server"), { recursive: true });
    await writeFile(path.join(resourceRoot, "defaults", "server.json"), JSON.stringify({ schemaVersion: 11, packagedClients: ["electron"] }));
    await writeFile(path.join(resourceRoot, "dist", "server", "index.js"), "");
    const paths = await prepareManagedLocalFilesystem({ resourceRoot, userDataDirectory });
    const legacy = JSON.stringify({ schemaVersion: 10, packagedClients: ["electron"], backends: [{ id: "retained-provider" }] });
    await writeFile(paths.configurationFilename, legacy);
    const databaseFilename = path.join(paths.stateDirectory, "overlay.sqlite");
    await writeFile(databaseFilename, "preserved database sentinel");
    await expect(prepareManagedLocalFilesystem({ resourceRoot, userDataDirectory })).rejects.toMatchObject({
      code: "local_server_configuration_invalid",
      message: expect.stringContaining("configuration:import"),
    });
    expect(await readFile(paths.configurationFilename, "utf8")).toBe(legacy);
    expect(await readFile(databaseFilename, "utf8")).toBe("preserved database sentinel");
    await writeFile(paths.configurationFilename, JSON.stringify({ schemaVersion: 11, packagedClients: ["electron"], stateDirectory: "/another-state" }));
    await expect(prepareManagedLocalFilesystem({ resourceRoot, userDataDirectory })).rejects.toThrow("cannot override its state directory");
    expect(await readFile(databaseFilename, "utf8")).toBe("preserved database sentinel");
  });

  it("uses the account's configured absolute login shell", async () => {
    const implementation = vi.fn(
      (_executable, arguments_, _options, callback) => {
        expect(arguments_[1]).not.toContain("$PATH");
        expect(arguments_[1]).toContain("/usr/bin/printenv PATH");
        callback(
          null,
          "Welcome to fish\n__SEDES_LOGIN_PATH_START__\n/custom/bin:/opt/homebrew/bin\n__SEDES_LOGIN_PATH_END__\n",
          "",
        );
      },
    );
    await expect(
      readLoginShellPath(
        "darwin",
        { SHELL: "/opt/homebrew/bin/fish" },
        implementation,
      ),
    ).resolves.toBe("/custom/bin:/opt/homebrew/bin");
    expect(implementation.mock.calls[0][0]).toBe("/opt/homebrew/bin/fish");
  });

  it("rejects a symlink in the managed mutable path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-local-link-"));
    temporaryDirectories.push(root);
    const resourceRoot = path.join(root, "resources", "local-server");
    const userDataDirectory = path.join(root, "user-data");
    await mkdir(path.join(resourceRoot, "defaults"), { recursive: true });
    await mkdir(path.join(resourceRoot, "dist", "server"), { recursive: true });
    await mkdir(userDataDirectory);
    await writeFile(path.join(resourceRoot, "defaults", "server.json"), "{}");
    await writeFile(path.join(resourceRoot, "dist", "server", "index.js"), "");
    await symlink(root, path.join(userDataDirectory, "managed-local"));
    await expect(
      prepareManagedLocalFilesystem({ resourceRoot, userDataDirectory }),
    ).rejects.toMatchObject({ code: "local_server_path_invalid" });
  });

  it("requires exact IPC readiness and exact-instance cleanup", async () => {
    const children = [];
    const notifications = [];
    const manager = new LocalServerManager({
      electronExecutable: "/opt/Sedes/electron",
      resourceRoot: "/opt/Sedes/resources/local-server",
      userDataDirectory: "/private/user-data",
      environment: {},
      notify: (event) => notifications.push(event),
      prepareFilesystem: vi.fn(async () => ({
        resourceRoot: "/opt/Sedes/resources/local-server",
        serverEntrypoint:
          "/opt/Sedes/resources/local-server/dist/server/index.js",
        configurationFilename: "/private/config/server.json",
        stateDirectory: "/private/state",
      })),
      reservePort: vi.fn(async () => 32124),
      healthCheck: vi.fn(async () => undefined),
      pair: vi.fn(async () => "c".repeat(43)),
      revokeCredential: async () => undefined,
      saveCredential: vi.fn(async () => undefined),
      spawnProcess: vi.fn(() => {
        const child = new FakeChild();
        children.push(child);
        queueMicrotask(() => child.ready(32124));
        return child;
      }),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });

    await expect(manager.start({ connectionId })).resolves.toEqual({
      connectionId,
      baseUrl: "http://127.0.0.1:32124",
      authenticationRequired: true,
    });
    await manager.disconnect({
      connectionId: "20000000-0000-4000-8000-000000000002",
    });
    expect(manager.getStatus()).toMatchObject({
      status: "connected",
      connectionId,
    });
    expect(children[0].kills).toEqual([]);
    children[0].unexpectedExit();
    expect(notifications).toEqual([
      {
        status: "disconnected",
        connectionId,
        error: {
          code: "local_server_lost",
          message: "The managed local Sedes server stopped unexpectedly.",
        },
      },
    ]);
  });

  it("drains verbose startup output while retaining bounded diagnostics", async () => {
    const child = new FakeChild();
    const manager = new LocalServerManager({
      electronExecutable: "/opt/Sedes/electron",
      resourceRoot: "/opt/Sedes/resources/local-server",
      userDataDirectory: "/private/user-data",
      environment: {},
      prepareFilesystem: vi.fn(async () => ({
        resourceRoot: "/opt/Sedes/resources/local-server",
        serverEntrypoint:
          "/opt/Sedes/resources/local-server/dist/server/index.js",
        configurationFilename: "/private/config/server.json",
        stateDirectory: "/private/state",
      })),
      healthCheck: vi.fn(async () => undefined),
      pair: vi.fn(async () => "c".repeat(43)),
      revokeCredential: async () => undefined,
      saveCredential: vi.fn(async () => undefined),
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          child.stdout.write(Buffer.alloc(32 * 1_024, "o"));
          child.stderr.write(Buffer.alloc(32 * 1_024, "e"));
          child.ready(32126);
        });
        return child;
      }),
      terminateProcess: vi.fn(async (process) => process.kill("SIGTERM")),
    });

    await expect(manager.start({ connectionId })).resolves.toEqual({
      connectionId,
      baseUrl: "http://127.0.0.1:32126",
      authenticationRequired: true,
    });
    expect(child.kills).toEqual([]);
    await manager.disconnect({ connectionId });
  });

  it("describes a missing packaged runtime without exposing the implementation stack", async () => {
    const spawnError = Object.assign(new Error("missing executable"), {
      code: "ENOENT",
    });
    const manager = new LocalServerManager({
      electronExecutable: "/opt/Sedes/electron",
      resourceRoot: "/opt/Sedes/resources/local-server",
      userDataDirectory: "/private/user-data",
      prepareFilesystem: vi.fn(async () => ({
        resourceRoot: "/opt/Sedes/resources/local-server",
        serverEntrypoint:
          "/opt/Sedes/resources/local-server/dist/server/index.js",
        configurationFilename: "/private/config/server.json",
        stateDirectory: "/private/state",
      })),
      spawnProcess: vi.fn(() => {
        throw spawnError;
      }),
    });

    await expect(manager.start({ connectionId })).rejects.toMatchObject({
      code: "local_server_runtime_unavailable",
      message: "The desktop app could not start the local Sedes server.",
    });
  });

  it("cancels an in-flight exact instance without affecting a different id", async () => {
    const child = new FakeChild();
    const manager = new LocalServerManager({
      electronExecutable: "/opt/Sedes/electron",
      resourceRoot: "/opt/Sedes/resources/local-server",
      userDataDirectory: "/private/user-data",
      prepareFilesystem: vi.fn(async () => ({
        resourceRoot: "/opt/Sedes/resources/local-server",
        serverEntrypoint:
          "/opt/Sedes/resources/local-server/dist/server/index.js",
        configurationFilename: "/private/config/server.json",
        stateDirectory: "/private/state",
      })),
      reservePort: vi.fn(async () => 32125),
      spawnProcess: vi.fn(() => child),
      terminateProcess: vi.fn(async () => undefined),
    });
    const starting = manager.start({ connectionId });
    await vi.waitFor(() =>
      expect(manager.getStatus()).toMatchObject({
        status: "connecting",
        connectionId,
      }),
    );
    await manager.disconnect({
      connectionId: "20000000-0000-4000-8000-000000000002",
    });
    expect(child.kills).toEqual([]);
    const stopped = manager.disconnect({ connectionId });
    await expect(starting).rejects.toMatchObject({
      code: "local_server_cancelled",
    });
    await expect(stopped).resolves.toBeUndefined();
    expect(child.kills).toContain("SIGTERM");
  });
});
