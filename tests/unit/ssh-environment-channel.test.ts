import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshEnvironmentChannelProvider } from "../../src/server/execution/ssh-environment-channel.js";
import { SshEnvironmentAvailabilityAggregator } from "../../src/server/execution/ssh-environment-availability.js";
import type { SshProcessSpawner } from "../../src/server/execution/ssh-open-ssh.js";

const scope = Object.freeze({
  tenantId: "tenant-ssh",
  principalId: "principal-ssh",
  backendInstanceId: "codex-ssh",
  executionEnvironmentId: "ssh-environment",
});
it("does not advertise a transient remote provider-worker launcher", () => {
  expect("openInstallationManagedWorker" in SshEnvironmentChannelProvider.prototype)
    .toBe(false);
});

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(options?: {
  readonly activeConfigurationRevision?: () => number | Promise<number>;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "h-ssh-channel-test-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const remoteSocket = path.join(directory, "remote%h.sock");
  const remoteServer = createServer((socket) =>
    socket.on("data", (data) => socket.write(data)),
  );
  servers.push(remoteServer);
  await new Promise<void>((resolve, reject) => {
    remoteServer.once("error", reject);
    remoteServer.listen(remoteSocket, () => resolve());
  });
  await chmod(remoteSocket, 0o600);

  const executable = path.join(directory, "ssh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const specification = args[args.indexOf("-L") + 1];
const separator = specification.indexOf(":");
const localPath = specification.slice(0, separator).replaceAll("%%", "%");
const remotePath = specification.slice(separator + 1).replaceAll("%%", "%");
const server = net.createServer((local) => {
  const remote = net.createConnection({ path: remotePath });
  local.pipe(remote).pipe(local);
});
server.listen(localPath, () => fs.chmodSync(localPath, 0o600));
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
`,
  );
  await chmod(executable, 0o700);
  const calls: string[][] = [];
  const children: Array<{
    readonly arguments: readonly string[];
    readonly child: ChildProcess;
  }> = [];
  const spawnProcess: SshProcessSpawner = (command, arguments_) => {
    calls.push([...arguments_]);
    const child = spawn(command, [...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FAKE_DIRECTORY: directory,
      },
    });
    children.push({ arguments: [...arguments_], child });
    return child;
  };
  let revision = 7;
  const availabilityReports: Array<{
    available: boolean;
    diagnosticCode?: string;
  }> = [];
  const provider = new SshEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
    host: "srv",
    configurationRevision: 7,
    activeConfigurationRevision:
      options?.activeConfigurationRevision ?? (() => revision),
    sshExecutable: executable,
    spawnProcess,
    availability: new SshEnvironmentAvailabilityAggregator({
      configurationRevision: 7,
      activeConfigurationRevision: () => revision,
      reportAvailability: (available, diagnosticCode) => {
        availabilityReports.push({
          available,
          ...(diagnosticCode ? { diagnosticCode } : {}),
        });
      },
    }),
  });
  return {
    provider,
    calls,
    children,
    remoteSocket,
    availabilityReports,
    setRevision: (value: number) => {
      revision = value;
    },
  };
}

describe("SshEnvironmentChannelProvider", () => {
  it("opens and revalidates a StreamLocal carrier without auxiliary SSH probes", async () => {
    const { provider, calls, remoteSocket } = await fixture();
    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    expect(calls.filter((arguments_) => !arguments_.includes("-N"))).toEqual(
      [],
    );
    expect(
      calls.filter((arguments_) => arguments_.includes("-N")),
    ).toHaveLength(1);
    await channel.revalidateIdentity();
    expect(calls.filter((arguments_) => !arguments_.includes("-N"))).toEqual(
      [],
    );
    expect(
      calls.filter((arguments_) => arguments_.includes("-N")),
    ).toHaveLength(1);
    await channel.closeClient("test_complete");
    await channel.closed;
    await provider.close();
  });

  it("opens one foreground OpenSSH StreamLocal carrier with bounded safe options", async () => {
    const { provider, calls, remoteSocket, availabilityReports } =
      await fixture();
    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    const tunnelArguments = calls.find((arguments_) =>
      arguments_.includes("-N"),
    );
    expect(tunnelArguments).toBeDefined();
    expect(tunnelArguments).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ExitOnForwardFailure=yes",
        "StreamLocalBindMask=0177",
        "StreamLocalBindUnlink=no",
      ]),
    );
    expect(tunnelArguments?.at(-1)).toBe("srv");
    const forward = tunnelArguments?.[tunnelArguments.indexOf("-L") + 1];
    expect(forward).toContain(":");
    expect(forward?.endsWith(remoteSocket.replaceAll("%", "%%"))).toBe(true);
    const carrierDirectory = path.dirname(forward?.split(":", 1)[0] ?? "");
    try {
      await channel.write(Buffer.from("hello"));
      const iterator = channel.bytes[Symbol.asyncIterator]();
      const received = await iterator.next();
      expect(received.done).toBe(false);
      expect(Buffer.from(received.value ?? new Uint8Array()).toString()).toBe(
        "hello",
      );
      await channel.revalidateIdentity();
    } finally {
      await channel.closeClient("test_complete");
      await channel.closed;
    }
    await expect(lstat(carrierDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(availabilityReports).toEqual([]);
    await provider.reportRuntimeAvailability(scope, {
      availability: "available",
    });
    expect(availabilityReports).toEqual([{ available: true }]);
    await provider.close();
  });

  it("reports unexpected carrier loss but not an intentional close", async () => {
    const { provider, remoteSocket, children, availabilityReports } =
      await fixture();
    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    const tunnel = children.find(({ arguments: arguments_ }) =>
      arguments_.includes("-N"),
    )?.child;
    expect(tunnel).toBeDefined();
    tunnel!.kill("SIGKILL");
    await channel.closed;
    await vi.waitFor(() =>
      expect(availabilityReports).toContainEqual({
        available: false,
        diagnosticCode: "ssh_carrier_exited",
      }),
    );
    await provider.close();
  });

  it("cannot publish a channel after close wins the final authority check", async () => {
    const finalRevision = deferred<number>();
    const activeConfigurationRevision = vi
      .fn<() => number | Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockImplementationOnce(() => finalRevision.promise);
    const { provider, remoteSocket, children } = await fixture({
      activeConfigurationRevision,
    });
    const opening = provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    const rejected = expect(opening).rejects.toThrow(
      "ssh_environment_unavailable",
    );
    await vi.waitFor(() =>
      expect(activeConfigurationRevision).toHaveBeenCalledTimes(2),
    );
    const tunnel = children.find(({ arguments: arguments_ }) =>
      arguments_.includes("-N"),
    )!;
    const forward = tunnel.arguments[tunnel.arguments.indexOf("-L") + 1]!;
    const carrierDirectory = path.dirname(forward.split(":", 1)[0]!);

    const closing = provider.close();
    finalRevision.resolve(7);
    await rejected;
    await closing;

    expect(tunnel.child.killed).toBe(true);
    await expect(lstat(carrierDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a carrier that exits between delegate open and final authority validation", async () => {
    const finalRevision = deferred<number>();
    const activeConfigurationRevision = vi
      .fn<() => number | Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockImplementationOnce(() => finalRevision.promise);
    const { provider, remoteSocket, children, availabilityReports } =
      await fixture({ activeConfigurationRevision });
    const opening = provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    const rejected = expect(opening).rejects.toThrow("ssh_carrier_exited");
    await vi.waitFor(() =>
      expect(activeConfigurationRevision).toHaveBeenCalledTimes(2),
    );
    const tunnel = children.find(({ arguments: arguments_ }) =>
      arguments_.includes("-N"),
    )!;
    const forward = tunnel.arguments[tunnel.arguments.indexOf("-L") + 1]!;
    const carrierDirectory = path.dirname(forward.split(":", 1)[0]!);
    const exited = new Promise<void>((resolve) =>
      tunnel.child.once("exit", () => resolve()),
    );
    tunnel.child.kill("SIGKILL");
    await exited;
    finalRevision.resolve(7);

    await rejected;
    await vi.waitFor(() =>
      expect(availabilityReports).toContainEqual({
        available: false,
        diagnosticCode: "ssh_carrier_exited",
      }),
    );
    await expect(lstat(carrierDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await provider.close();
  });

  it("does not claim availability merely because a local listener opened for a missing remote socket", async () => {
    const { provider, remoteSocket, availabilityReports } = await fixture();
    await rm(remoteSocket, { force: true });
    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    expect(availabilityReports).not.toContainEqual({ available: true });
    await channel.closeClient("test_complete");
    await channel.closed;
    await provider.close();
  });

  it("publishes provider-neutral backend lifecycle availability", async () => {
    const { provider, availabilityReports } = await fixture();
    await provider.reportRuntimeAvailability(scope, {
      availability: "unavailable",
      diagnosticCode: "backend_runtime_unavailable",
    });
    await provider.reportRuntimeAvailability(scope, {
      availability: "available",
    });
    expect(availabilityReports).toEqual([
      {
        available: false,
        diagnosticCode: "backend_runtime_unavailable",
      },
      { available: true },
    ]);
    await provider.close();
  });

  it("keeps a shared SSH environment available while any backend runtime is ready", async () => {
    const { provider, availabilityReports } = await fixture();
    const otherBackendScope = {
      ...scope,
      backendInstanceId: "codex-ssh-secondary",
    };
    await provider.reportRuntimeAvailability(scope, {
      availability: "available",
    });
    await provider.reportRuntimeAvailability(otherBackendScope, {
      availability: "unavailable",
      diagnosticCode: "backend_runtime_unavailable",
    });
    await provider.reportRuntimeAvailability(scope, {
      availability: "unavailable",
      diagnosticCode: "backend_runtime_circuit_open",
    });
    expect(availabilityReports).toEqual([
      { available: true },
      { available: true },
      {
        available: false,
        diagnosticCode: "backend_runtime_circuit_open",
      },
    ]);
    await provider.close();
  });

  it("lets the transport-open signal cancel carrier revalidation", async () => {
    const { provider, remoteSocket } = await fixture();
    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(channel.revalidateIdentity(controller.signal)).rejects.toThrow(
      "ssh_operation_cancelled",
    );
    await channel.closed;
    await provider.close();
  });

  it("rejects OpenSSH environment expansion in a remote StreamLocal path", async () => {
    const { provider } = await fixture();
    await expect(
      provider.openPrivateUnixStream(
        scope,
        "/run/user/1000/${SSH_AUTH_SOCK}.sock",
        new AbortController().signal,
      ),
    ).rejects.toThrow("ssh_socket_path_invalid");
  });

  it("applies one absolute deadline to the whole carrier attempt", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        exitCode: null,
        signalCode: null,
        kill: () => {
          (
            child as unknown as { signalCode: NodeJS.Signals | null }
          ).signalCode = "SIGTERM";
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return true;
        },
      }) as unknown as ReturnType<SshProcessSpawner>;
      const provider = new SshEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: scope.executionEnvironmentId,
        host: "srv",
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        availability: ignoredAvailability,
        spawnProcess: () => child,
      });
      const opened = provider.openPrivateUnixStream(
        scope,
        "/run/user/1000/codex.sock",
        new AbortController().signal,
      );
      const rejected = expect(opened).rejects.toThrow(
        "ssh_carrier_start_timeout",
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves output-overflow failure when availability publication fails", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: () => {
        (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode =
          "SIGTERM";
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      },
    }) as unknown as ReturnType<SshProcessSpawner>;
    const backgroundError = vi.fn();
    const provider = new SshEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
      host: "srv",
      configurationRevision: 1,
      activeConfigurationRevision: () => 1,
      spawnProcess: () => child,
      availability: new SshEnvironmentAvailabilityAggregator({
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        reportAvailability: () => {
          throw new Error("availability persistence failed");
        },
      }),
      onBackgroundError: backgroundError,
    });
    const opened = provider.openPrivateUnixStream(
      scope,
      "/run/user/1000/codex.sock",
      new AbortController().signal,
    );
    const rejected = expect(opened).rejects.toThrow(
      "ssh_carrier_output_overflow",
    );
    stdout.write(Buffer.alloc(16 * 1024 + 1));

    await rejected;
    expect(backgroundError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "availability persistence failed" }),
    );
    await provider.close();
  });

  it("fails closed for other capabilities and stale configuration authority", async () => {
    const { provider, calls, remoteSocket, setRevision } = await fixture();
    await expect(
      provider.resolveDirectory(scope, path.dirname(remoteSocket)),
    ).rejects.toThrow("ssh_environment_capability_unsupported");
    await expect(
      provider.openAssuredTcpStream(
        scope,
        { security: "loopback_plaintext", host: "127.0.0.1", port: 1234 },
        1,
        {} as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ssh_environment_capability_unsupported");

    const channel = await provider.openPrivateUnixStream(
      scope,
      remoteSocket,
      new AbortController().signal,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-N");
    setRevision(8);
    await expect(channel.revalidateIdentity()).rejects.toThrow(
      "ssh_environment_configuration_stale",
    );
    await channel.closed;
    await expect(
      provider.openPrivateUnixStream(
        scope,
        remoteSocket,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ssh_environment_configuration_stale");
  });
});

const ignoredAvailability = Object.freeze({
  reportBackendObservation: async () => undefined,
});
