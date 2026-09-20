import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const electron = vi.hoisted(() => ({ app: {} }));
vi.mock("electron", () => electron);

const { ConnectionRuntimeManager, ElectronConnectionRuntime } =
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
