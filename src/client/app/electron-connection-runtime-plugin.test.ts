import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  startLocal: vi.fn(),
  connectSsh: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
  getCapabilities: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

import { electronConnectionRuntime } from "./electron-connection-runtime-plugin.js";

const localId = "10000000-0000-4000-8000-000000000001";
const sshId = "10000000-0000-4000-8000-000000000002";

beforeEach(() => {
  for (const method of Object.values(plugin)) method.mockReset();
});

describe("Electron connection runtime renderer contract", () => {
  it("passes renderer-generated IDs and accepts only strict loopback results", async () => {
    plugin.startLocal.mockResolvedValue({
      connectionId: localId,
      baseUrl: "http://127.0.0.1:32123",
      authenticationRequired: true,
    });
    await expect(
      electronConnectionRuntime.startLocal({ connectionId: localId }),
    ).resolves.toEqual({
      connectionId: localId,
      baseUrl: "http://127.0.0.1:32123",
      authenticationRequired: true,
    });
    expect(plugin.startLocal).toHaveBeenCalledWith({ connectionId: localId });

    plugin.connectSsh.mockResolvedValue({
      connectionId: sshId,
      baseUrl: "http://127.0.0.1:32124",
    });
    await expect(
      electronConnectionRuntime.connectSsh({
        connectionId: sshId,
        profileId: sshId,
      hostAlias: "remote",
        remotePort: 4784,
      }),
    ).resolves.toMatchObject({ connectionId: sshId });
    expect(plugin.connectSsh).toHaveBeenCalledWith({
      connectionId: sshId,
      profileId: sshId,
      hostAlias: "remote",
      remotePort: 4784,
    });

    for (const result of [
      { connectionId: sshId, baseUrl: "http://localhost:32123" },
      { connectionId: sshId, baseUrl: "https://127.0.0.1:32123" },
      { connectionId: sshId, baseUrl: "http://127.0.0.1:32123/path" },
      {
        connectionId: sshId,
        baseUrl: "http://127.0.0.1:32123",
        authenticationRequired: true,
        extra: true,
      },
    ]) {
      plugin.connectSsh.mockResolvedValue(result);
      await expect(
        electronConnectionRuntime.connectSsh({
          connectionId: sshId,
          profileId: sshId,
      hostAlias: "remote",
          remotePort: 4784,
        }),
      ).rejects.toThrow();
    }
  });

  it("validates exact cleanup, bounded status, and loss events", async () => {
    plugin.disconnect.mockResolvedValue(undefined);
    await electronConnectionRuntime.disconnect({ connectionId: localId });
    expect(plugin.disconnect).toHaveBeenCalledWith({ connectionId: localId });
    expect(() =>
      electronConnectionRuntime.disconnect({ connectionId: "not-a-uuid" }),
    ).toThrow();

    plugin.getStatus.mockResolvedValue({
      local: {
        status: "connected",
        connectionId: localId,
        baseUrl: "http://127.0.0.1:32123",
        authenticationRequired: true,
      },
      ssh: { status: "disconnected" },
    });
    await expect(electronConnectionRuntime.getStatus()).resolves.toMatchObject({
      local: { status: "connected", connectionId: localId },
      ssh: { status: "disconnected" },
    });

    let nativeListener: ((state: unknown) => void) | undefined;
    plugin.addListener.mockImplementation(async (_event, listener) => {
      nativeListener = listener;
      return { remove: vi.fn() };
    });
    const listener = vi.fn();
    await electronConnectionRuntime.addListener(listener);
    nativeListener?.({
      kind: "local",
      connectionId: localId,
      status: "disconnected",
      error: { code: "local_server_lost", message: "Failed." },
    });
    expect(listener).toHaveBeenCalledWith({
      kind: "local",
      connectionId: localId,
      status: "disconnected",
      error: { code: "local_server_lost", message: "Failed." },
    });
    expect(() => nativeListener?.({ status: "connected" })).toThrow();
  });
});


describe("Electron native capability contract", () => {
  it("accepts only the native boolean capability document", async () => {
    for (const localServer of [false, true]) {
      plugin.getCapabilities.mockResolvedValue({ localServer });
      await expect(electronConnectionRuntime.getCapabilities()).resolves.toEqual({ localServer });
    }
    for (const value of [undefined, {}, { localServer: "full" }, { localServer: true, profile: "full" }]) {
      plugin.getCapabilities.mockResolvedValue(value);
      await expect(electronConnectionRuntime.getCapabilities()).rejects.toThrow();
    }
  });
});
