import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SSH_BASE_ARGUMENTS,
  SshTunnelError,
  SshTunnelManager,
  classifySshFailure,
  spawnSshProcess,
  sshArguments,
  terminateExactChild,
  validateConnectInput,
} from "../../packages/electron-connection-runtime/electron/dist/ssh-tunnel-manager.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
    this.kills = [];
    this.exitOnKill = exitOnKill;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.exitOnKill) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }

  unexpectedExit(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const validInput = {
  connectionId: "10000000-0000-4000-8000-000000000001",
  profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "build-host",
  remotePort: 4784,
};

function disconnectCurrent(manager) {
  const status = manager.getStatus();
  if (status.status === "disconnected") return Promise.resolve();
  return manager.disconnect({ connectionId: status.connectionId });
}

describe("Electron SSH tunnel native manager", () => {
  it("accepts only the exact safe host-alias and port input", () => {
    expect(validateConnectInput(validInput)).toEqual(validInput);
    for (const input of [
      null,
      {},
      { ...validInput, extra: true },
      { ...validInput, profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "-oProxyCommand=bad" },
      { ...validInput, profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "user@host" },
      { ...validInput, profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "host name" },
      { ...validInput, remotePort: 0 },
      { ...validInput, remotePort: 65_536 },
      { ...validInput, remotePort: 4784.5 },
    ]) {
      expect(() => validateConnectInput(input)).toThrowError(
        expect.objectContaining({ code: "ssh_tunnel_input_invalid" }),
      );
    }
  });

  it("builds one bounded OpenSSH foreground forward with fixed loopback targets", () => {
    const arguments_ = sshArguments(validInput, 32123);
    expect(arguments_).toEqual([
      ...SSH_BASE_ARGUMENTS,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "GatewayPorts=no",
      "-L",
      "127.0.0.1:32123:127.0.0.1:4784",
      "build-host",
    ]);
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "ForkAfterAuthentication=no",
        "RemoteCommand=none",
      ]),
    );
  });

  it("spawns the literal executable without a shell or inherited stdio", () => {
    const child = new FakeChild();
    const implementation = vi.fn(() => child);
    expect(spawnSshProcess("ssh", ["-N", "host"], implementation)).toBe(
      child,
    );
    expect(implementation).toHaveBeenCalledWith("ssh", ["-N", "host"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("is idempotent for the active target and serializes a target switch", async () => {
    const children = [];
    const terminations = [];
    const manager = new SshTunnelManager({
      reservePort: vi
        .fn()
        .mockResolvedValueOnce(31001)
        .mockResolvedValueOnce(31002),
      spawnProcess: vi.fn(() => {
        const child = new FakeChild();
        children.push(child);
        return child;
      }),
      waitForPort: vi.fn(async () => undefined),
      terminateProcess: vi.fn(async (child) => {
        terminations.push(child);
        child.kill("SIGTERM");
      }),
    });

    const firstRequest = manager.connect(validInput);
    expect(manager.connect({ ...validInput })).toBe(firstRequest);
    const first = await firstRequest;
    const adopted = await manager.connect({ ...validInput });
    expect(adopted).toEqual(first);
    expect(children).toHaveLength(1);

    const second = await manager.connect({
      connectionId: "20000000-0000-4000-8000-000000000002",
      profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "other-host",
      remotePort: 9000,
    });
    expect(second.baseUrl).toBe("http://127.0.0.1:31002");
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(children).toHaveLength(2);
    expect(terminations).toEqual([children[0]]);
    await disconnectCurrent(manager);
  });

  it("fails closed on a local bind race without changing the credential origin", async () => {
    const children = [new FakeChild(), new FakeChild()];
    const reservePort = vi
      .fn()
      .mockResolvedValueOnce(31011)
      .mockResolvedValueOnce(31012);
    const manager = new SshTunnelManager({
      reservePort,
      spawnProcess: vi
        .fn()
        .mockReturnValueOnce(children[0])
        .mockReturnValueOnce(children[1]),
      waitForPort: vi
        .fn()
        .mockRejectedValueOnce(
          new SshTunnelError(
            "ssh_forward_unavailable",
            "SSH could not open the local forwarding port.",
          ),
        )
        .mockResolvedValueOnce(undefined),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });
    await expect(manager.connect(validInput)).rejects.toMatchObject({ code: "ssh_forward_unavailable" });
    expect(reservePort).toHaveBeenCalledTimes(1);
    await disconnectCurrent(manager);

    const failed = new SshTunnelManager({
      reservePort: vi.fn(async () => 31013),
      spawnProcess: vi.fn(() => new FakeChild()),
      waitForPort: vi.fn(async () => {
        throw new SshTunnelError(
          "ssh_authentication_failed",
          "SSH authentication failed.",
        );
      }),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });
    await expect(failed.connect(validInput)).rejects.toMatchObject({
      code: "ssh_authentication_failed",
    });

    const boundedSpawn = vi.fn(() => new FakeChild());
    const exhausted = new SshTunnelManager({
      reservePort: vi
        .fn()
        .mockResolvedValueOnce(31301)
        .mockResolvedValueOnce(31302)
        .mockResolvedValueOnce(31303),
      spawnProcess: boundedSpawn,
      waitForPort: vi.fn(async () => {
        throw new SshTunnelError(
          "ssh_forward_unavailable",
          "SSH could not open the local forwarding port.",
        );
      }),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });
    await expect(exhausted.connect(validInput)).rejects.toMatchObject({
      code: "ssh_forward_unavailable",
    });
    expect(boundedSpawn).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight attempt without waiting for its readiness deadline", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child);
    const manager = new SshTunnelManager({
      reservePort: vi.fn(async () => 31021),
      spawnProcess,
      waitForPort: vi.fn(
        ({ failure }) =>
          new Promise((_resolve, reject) => {
            const poll = () => {
              const current = failure();
              if (current) {
                reject(classifySshFailure(current));
                return;
              }
              setTimeout(poll, 0);
            };
            poll();
          }),
      ),
      terminateProcess: vi.fn(async () => undefined),
    });
    const connecting = manager.connect(validInput);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    const disconnected = disconnectCurrent(manager);
    await expect(connecting).rejects.toMatchObject({
      code: "ssh_tunnel_cancelled",
    });
    await expect(disconnected).resolves.toBeUndefined();
    expect(child.kills).toContain("SIGTERM");
    expect(manager.getStatus()).toEqual({ status: "disconnected" });
  });

  it("emits one actionable event for unexpected active loss and ignores stale exits", async () => {
    const notifications = [];
    const children = [new FakeChild(), new FakeChild()];
    let childIndex = 0;
    const manager = new SshTunnelManager({
      notify: (state) => notifications.push(state),
      reservePort: vi
        .fn()
        .mockResolvedValueOnce(31101)
        .mockResolvedValueOnce(31102),
      spawnProcess: vi.fn(() => children[childIndex++]),
      waitForPort: vi.fn(async () => undefined),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });
    await manager.connect(validInput);
    const active = await manager.connect({
      connectionId: "20000000-0000-4000-8000-000000000002",
      profileId: "10000000-0000-4000-8000-000000000001", hostAlias: "other-host",
      remotePort: 4784,
    });
    notifications.length = 0;
    children[0].unexpectedExit();
    expect(notifications).toEqual([]);

    children[1].stderr.write("Permission denied (publickey).\n");
    children[1].unexpectedExit(255);
    expect(manager.getStatus()).toEqual({ status: "disconnected" });
    expect(notifications).toEqual([
      {
        status: "disconnected",
        connectionId: active.connectionId,
        error: {
          code: "ssh_tunnel_lost",
          message: "The managed SSH connection closed unexpectedly.",
        },
      },
    ]);

    notifications.length = 0;
    const replacement = new FakeChild();
    const genericLossManager = new SshTunnelManager({
      notify: (state) => notifications.push(state),
      reservePort: vi.fn(async () => 31103),
      spawnProcess: vi.fn(() => replacement),
      waitForPort: vi.fn(async () => undefined),
      terminateProcess: vi.fn(async (child) => child.kill("SIGTERM")),
    });
    const generic = await genericLossManager.connect(validInput);
    replacement.unexpectedExit(0);
    expect(notifications).toEqual([
      {
        status: "disconnected",
        connectionId: generic.connectionId,
        error: {
          code: "ssh_tunnel_lost",
          message: "The managed SSH connection closed unexpectedly.",
        },
      },
    ]);
  });

  it("bounds child diagnostics and maps stable setup failures", async () => {
    const child = new FakeChild();
    const manager = new SshTunnelManager({
      reservePort: vi.fn(async () => 31201),
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.stderr.write(Buffer.alloc(16 * 1024 + 1)));
        return child;
      }),
      waitForPort: vi.fn(async ({ failure }) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const current = failure();
        if (current) throw classifySshFailure(current);
      }),
      terminateProcess: vi.fn(async () => undefined),
    });
    await expect(manager.connect(validInput)).rejects.toMatchObject({
      code: "ssh_output_overflow",
    });
    expect(child.kills).toContain("SIGTERM");

    expect(
      classifySshFailure({ spawnError: { code: "ENOENT" } }),
    ).toMatchObject({ code: "ssh_executable_not_found" });
    expect(
      classifySshFailure({ stderr: "Host key verification failed." }),
    ).toMatchObject({ code: "ssh_host_key_untrusted" });
    expect(
      classifySshFailure({ stderr: "Could not resolve hostname example" }),
    ).toMatchObject({ code: "ssh_host_unresolved" });
  });

  it("drains but does not accumulate or kill for diagnostics after readiness", async () => {
    const child = new FakeChild();
    const notifications = [];
    const manager = new SshTunnelManager({
      notify: (state) => notifications.push(state),
      reservePort: vi.fn(async () => 31202),
      spawnProcess: vi.fn(() => child),
      waitForPort: vi.fn(async () => undefined),
      terminateProcess: vi.fn(async (process) => process.kill("SIGTERM")),
    });
    const connection = await manager.connect(validInput);

    child.stderr.write(Buffer.alloc(16 * 1024 + 1));
    child.stdout.write(Buffer.alloc(16 * 1024 + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.kills).toEqual([]);
    expect(manager.getStatus()).toMatchObject({
      status: "connected",
      connectionId: connection.connectionId,
    });

    child.unexpectedExit(0);
    expect(notifications).toEqual([
      {
        status: "disconnected",
        connectionId: connection.connectionId,
        error: {
          code: "ssh_tunnel_lost",
          message: "The managed SSH connection closed unexpectedly.",
        },
      },
    ]);
  });

  it("escalates exact-child cleanup from TERM to KILL after the bound", async () => {
    const child = new FakeChild({ exitOnKill: false });
    child.kill = (signal) => {
      child.kills.push(signal);
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        queueMicrotask(() => child.emit("exit", null, signal));
      }
      return true;
    };
    await terminateExactChild(child, 1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
