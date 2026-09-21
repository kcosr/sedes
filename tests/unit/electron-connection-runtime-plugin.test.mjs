import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const electron = vi.hoisted(() => ({ app: {} }));
vi.mock("electron", () => electron);

const { ConnectionRuntimeManager, ElectronConnectionRuntime, readDistribution } =
  await import("../../packages/electron-connection-runtime/electron/dist/plugin.mjs");
const { SshTunnelManager, sshArguments } =
  await import("../../packages/electron-connection-runtime/electron/dist/ssh-tunnel-manager.mjs");

class FakeWindow extends EventEmitter {
  webContents = new EventEmitter();
}

describe("Electron connection runtime", () => {
  it("preserves hardened SSH arguments and exact-id disconnect semantics", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn((signal) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    const id = "20000000-0000-4000-8000-000000000002";
    expect(
      sshArguments({ connectionId: id, profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "build-host", remotePort: 4784 }, 32120),
    ).toEqual(expect.arrayContaining([
      "BatchMode=yes",
      "ForwardAgent=no",
      "PermitLocalCommand=no",
      "ExitOnForwardFailure=yes",
      "127.0.0.1:32120:127.0.0.1:4784",
      "build-host",
    ]));
    const manager = new SshTunnelManager({
      reservePort: vi.fn(async () => 32120),
      spawnProcess: vi.fn(() => child),
      waitForPort: vi.fn(async () => undefined),
      terminateProcess: vi.fn(async (process) => process.kill("SIGTERM")),
    });
    await manager.connect({ connectionId: id, profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "build-host", remotePort: 4784 });
    await manager.disconnect({
      connectionId: "30000000-0000-4000-8000-000000000003",
    });
    expect(child.kill).not.toHaveBeenCalled();
    await manager.disconnect({ connectionId: id });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("allows Local and an SSH candidate together and delegates exact-id disconnect safely", async () => {
    const local = {
      start: vi.fn(async ({ connectionId }) => ({ connectionId, baseUrl: "http://127.0.0.1:1" })),
      disconnect: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        status: "connected",
        connectionId: "10000000-0000-4000-8000-000000000001",
        baseUrl: "http://127.0.0.1:1",
      })),
    };
    const ssh = {
      connect: vi.fn(async ({ connectionId }) => ({ connectionId, baseUrl: "http://127.0.0.1:2" })),
      disconnect: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        status: "connected",
        connectionId: "20000000-0000-4000-8000-000000000002",
        baseUrl: "http://127.0.0.1:2",
      })),
    };
    const manager = new ConnectionRuntimeManager({ local, ssh });
    expect(manager.getCapabilities()).toEqual({ localServer: true });
    expect(manager.getStatus()).toMatchObject({
      local: { status: "connected" },
      ssh: { status: "connected" },
    });
    await manager.disconnect({
      connectionId: "10000000-0000-4000-8000-000000000001",
    });
    expect(local.disconnect).toHaveBeenCalledOnce();
    expect(ssh.disconnect).toHaveBeenCalledOnce();
    await manager.disconnect({
      connectionId: "30000000-0000-4000-8000-000000000003",
    });
    expect(local.disconnect).toHaveBeenCalledTimes(2);
    expect(ssh.disconnect).toHaveBeenCalledTimes(2);
  });

  let application;
  let manager;

  beforeEach(() => {
    application = new EventEmitter();
    application.quit = vi.fn();
    manager = {
      connectSsh: vi.fn(),
      startLocal: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      disconnectAll: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        local: { status: "connected", connectionId: "10000000-0000-4000-8000-000000000001" },
        ssh: { status: "connected", connectionId: "20000000-0000-4000-8000-000000000002" },
      })),
    };
  });

  it("has one idempotent quit coordinator for every owned resource", async () => {
    new ElectronConnectionRuntime(
      { notifyListeners: vi.fn() },
      { app: application, manager },
    );
    const window = new FakeWindow();
    application.emit("browser-window-created", {}, window);
    window.webContents.emit("render-process-gone");
    window.emit("closed");
    const event = { preventDefault: vi.fn() };
    application.emit("before-quit", event);
    await vi.waitFor(() => expect(application.quit).toHaveBeenCalledOnce());
    expect(manager.disconnectAll).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});


describe("Electron native distribution capabilities", () => {
  async function fixture(profile, run) {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-electron-distribution-"));
    try {
      await mkdir(path.join(root, "generated"));
      await writeFile(path.join(root, "generated", "distribution.json"), JSON.stringify({ profile }));
      const application = new EventEmitter();
      application.isPackaged = false;
      application.getAppPath = () => root;
      application.getPath = () => path.join(root, "user-data");
      application.quit = vi.fn();
      await run(root, application);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it("rejects Local natively in client packages while retaining SSH and existing state", async () => {
    await fixture("client", async (root, application) => {
      await mkdir(path.join(root, "user-data", "local-server"), { recursive: true });
      const retained = path.join(root, "user-data", "local-server", "retained-state");
      await writeFile(retained, "retained");
      const runtime = new ElectronConnectionRuntime({ notifyListeners: vi.fn() }, { app: application });
      expect(runtime.getCapabilities()).toEqual({ localServer: false });
      expect(Object.isFrozen(runtime.getCapabilities())).toBe(true);
      await expect(runtime.startLocal({ connectionId: "10000000-0000-4000-8000-000000000001", profile: "full" })).rejects.toMatchObject({ code: "local_server_unavailable" });
      expect(runtime.getStatus()).toEqual({ local: { status: "disconnected" }, ssh: { status: "disconnected" } });
      await runtime.disconnect({ connectionId: "10000000-0000-4000-8000-000000000001" });
      expect(await readFile(retained, "utf8")).toBe("retained");
      // The manifest is read once: renderer-era changes cannot grant authority.
      await writeFile(path.join(root, "generated", "distribution.json"), JSON.stringify({ profile: "full" }));
      expect(runtime.getCapabilities()).toEqual({ localServer: false });
      await expect(runtime.startLocal({ connectionId: "10000000-0000-4000-8000-000000000001" })).rejects.toMatchObject({ code: "local_server_unavailable" });
    });
  });

  it("retains Local authority in full packages", async () => {
    await fixture("full", async (_root, application) => {
      const runtime = new ElectronConnectionRuntime({ notifyListeners: vi.fn() }, { app: application });
      expect(runtime.getCapabilities()).toEqual({ localServer: true });
    });
  });

  it.each([{}, { profile: "other" }, { profile: "full", localServer: true }, null])("fails closed for invalid native build metadata %j", async (manifest) => {
    await fixture("client", async (root, application) => {
      await writeFile(path.join(root, "generated", "distribution.json"), JSON.stringify(manifest));
      expect(() => new ElectronConnectionRuntime({ notifyListeners: vi.fn() }, { app: application })).toThrow("electron_distribution_invalid");
    });
  });

  it("requires the native-owned manifest instead of inferring a profile from installed files", async () => {
    await fixture("full", async (root) => {
      await rm(path.join(root, "generated", "distribution.json"));
      expect(() => readDistribution(root)).toThrow();
    });
  });

  it("keeps SSH resource cleanup available without a Local manager", async () => {
    const ssh = { connect: vi.fn(async () => ({ connected: true })), disconnect: vi.fn(), disconnectAll: vi.fn(), getStatus: () => ({ status: "disconnected" }) };
    const manager = new ConnectionRuntimeManager({ local: null, ssh });
    await expect(manager.connectSsh({ hostAlias: "host" })).resolves.toEqual({ connected: true });
    await manager.disconnect({ connectionId: "10000000-0000-4000-8000-000000000001" });
    await manager.disconnectAll();
    expect(ssh.disconnect).toHaveBeenCalledOnce();
    expect(ssh.disconnectAll).toHaveBeenCalledOnce();
  });
});
