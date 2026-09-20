import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedSidecarSshConfiguration,
  openOwnedSshStdio,
  SshOwnedStdioCleanupError,
  SshOwnedStdioWriteError,
} from "../../src/server/execution/ssh-owned-stdio.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("openOwnedSshStdio", () => {
  it("opens one hardened foreground command with bidirectional stdio", async () => {
    const child = fakeChild();
    const calls: string[][] = [];
    const channel = await openOwnedSshStdio({
      host: "srv",
      remoteCommand: "exec node sidecar.mjs serve --stdio",
      signal: new AbortController().signal,
      spawnProcess: (_executable, arguments_) => {
        calls.push([...arguments_]);
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      stopTimeoutMilliseconds: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "SendEnv=-*",
        "ControlMaster=no",
        "RequestTTY=no",
        "srv",
        "exec node sidecar.mjs serve --stdio",
      ]),
    );
    expect(calls[0]).not.toContain("-N");
    await channel.writeStdin(Buffer.from("frame"));
    expect(child.stdin.read()?.toString()).toBe("frame");
    await channel.close("test_complete");
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects residual SetEnv from an effective Host alias", async () => {
    const child = fakeChild();
    const calls: string[][] = [];
    const result = assertManagedSidecarSshConfiguration({
      host: "alias-with-directives",
      signal: new AbortController().signal,
      spawnProcess: (_executable, arguments_) => {
        calls.push([...arguments_]);
        queueMicrotask(() => {
          child.stdout.end(
            "clearallforwardings yes\nsendenv\nsetenv TOKEN=operator-value\n",
          );
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    });
    await expect(result).rejects.toThrow("ssh_sidecar_setenv_unsupported");
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "ClearAllForwardings=yes",
        "SendEnv=-*",
        "-G",
        "alias-with-directives",
      ]),
    );
  });

  it("accepts an alias after forwarding and SendEnv directives are cleared", async () => {
    const child = fakeChild();
    await expect(
      assertManagedSidecarSshConfiguration({
        host: "alias-with-forwarding",
        signal: new AbortController().signal,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.stdout.end(
              "clearallforwardings yes\nforwardagent no\nforwardx11 no\n",
            );
            child.exitCode = 0;
            child.emit("exit", 0, null);
            child.emit("close", 0, null);
          });
          return child as unknown as ChildProcess;
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("terminates an effective-configuration process when its admission is aborted", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const result = assertManagedSidecarSshConfiguration({
      host: "slow-alias",
      signal: controller.signal,
      spawnProcess: () => {
        queueMicrotask(() => controller.abort(new Error("test_abort")));
        return child as unknown as ChildProcess;
      },
      stopTimeoutMilliseconds: 1,
    });
    await expect(result).rejects.toThrow("test_abort");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for effective-configuration stdout that arrives after process exit", async () => {
    const child = fakeChild();
    await expect(
      assertManagedSidecarSshConfiguration({
        host: "alias-with-delayed-output",
        signal: new AbortController().signal,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.stdout.write("forwardagent no\nforwardx11 no\n");
            child.exitCode = 0;
            child.emit("exit", 0, null);
            setImmediate(() => {
              child.stdout.end("clearallforwardings yes\n");
              child.stderr.end();
              child.emit("close", 0, null);
            });
          });
          return child as unknown as ChildProcess;
        },
      }),
    ).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["setenv TOKEN=operator-value\n", "ssh_sidecar_setenv_unsupported"],
    ["sendenv HOME\n", "ssh_sidecar_effective_configuration_unsafe"],
    ["forwardagent yes\n", "ssh_sidecar_effective_configuration_unsafe"],
    ["forwardx11 yes\n", "ssh_sidecar_effective_configuration_unsafe"],
  ])(
    "rejects unsafe final configuration output after process exit: %s",
    async (tail, code) => {
      const child = fakeChild();
      await expect(
        assertManagedSidecarSshConfiguration({
          host: "alias-with-delayed-output",
          signal: new AbortController().signal,
          spawnProcess: () => {
            queueMicrotask(() => {
              child.stdout.write("clearallforwardings yes\n");
              child.exitCode = 0;
              child.emit("exit", 0, null);
              setImmediate(() => {
                child.stdout.end(tail);
                child.stderr.end();
                child.emit("close", 0, null);
              });
            });
            return child as unknown as ChildProcess;
          },
        }),
      ).rejects.toThrow(code);
    },
  );

  it("allows cancellation while effective-configuration stdout is still draining", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const result = assertManagedSidecarSshConfiguration({
      host: "alias-with-delayed-output",
      signal: controller.signal,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write("clearallforwardings yes\n");
          child.exitCode = 0;
          child.emit("exit", 0, null);
          setImmediate(() => controller.abort(new Error("test_abort")));
        });
        return child as unknown as ChildProcess;
      },
    });
    await expect(result).rejects.toThrow("test_abort");
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });

  it("enforces the configuration output limit while stdout drains after exit", async () => {
    const child = fakeChild();
    await expect(
      assertManagedSidecarSshConfiguration({
        host: "alias-with-delayed-output",
        signal: new AbortController().signal,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.stdout.write("clearallforwardings yes\n");
            child.exitCode = 0;
            child.emit("exit", 0, null);
            setImmediate(() => {
              child.stdout.end(Buffer.alloc(256 * 1_024));
              child.stderr.end();
              child.emit("close", 0, null);
            });
          });
          return child as unknown as ChildProcess;
        },
      }),
    ).rejects.toThrow("ssh_sidecar_effective_configuration_overflow");
  });

  it("hardens real effective aliases with forwarding and environment directives", async () => {
    const safe = await sshAliasFixture([
      "SendEnv SEDES_TEST_CANARY LANG LC_*",
      "ForwardAgent yes",
      "ForwardX11 yes",
      "LocalForward 18080 127.0.0.1:80",
      "RemoteForward 18081 127.0.0.1:81",
      "DynamicForward 18082",
    ]);
    await expect(
      assertManagedSidecarSshConfiguration({
        host: "carrier-alias",
        sshExecutable: safe,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    const unsafe = await sshAliasFixture(["SetEnv SEDES_TEST_CANARY=secret"]);
    await expect(
      assertManagedSidecarSshConfiguration({
        host: "carrier-alias",
        sshExecutable: unsafe,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("ssh_sidecar_setenv_unsupported");
  });

  it("reports pre-write closure as not sent", async () => {
    const child = fakeChild();
    const channel = await openOwnedSshStdio({
      host: "srv",
      remoteCommand: "true",
      signal: new AbortController().signal,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      stopTimeoutMilliseconds: 1,
    });
    channel.closeStdin();
    await expect(channel.writeStdin(Buffer.from("x"))).rejects.toMatchObject({
      delivery: "not_sent",
    } satisfies Partial<SshOwnedStdioWriteError>);
    await channel.close("test_complete");
  });

  it("observes a remote command that exits immediately after spawn", async () => {
    const child = fakeChild();
    const channel = await openOwnedSshStdio({
      host: "srv",
      remoteCommand: "true",
      signal: new AbortController().signal,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.exitCode = 0;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0, null);
        });
        return child as unknown as ChildProcess;
      },
      stopTimeoutMilliseconds: 1,
    });

    await expect(channel.closed).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
    });
  });

  it("reports a child that survives failed-spawn cleanup", async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => true);

    await expect(
      openOwnedSshStdio({
        host: "srv",
        remoteCommand: "true",
        signal: new AbortController().signal,
        spawnProcess: () => child as unknown as ChildProcess,
        startTimeoutMilliseconds: 1,
        stopTimeoutMilliseconds: 1,
      }),
    ).rejects.toMatchObject({
      name: SshOwnedStdioCleanupError.name,
      cause: { diagnosticCode: "ssh_child_survived_cleanup" },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reports a child that survives an abort immediately after spawn", async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => true);
    const controller = new AbortController();

    await expect(
      openOwnedSshStdio({
        host: "srv",
        remoteCommand: "true",
        signal: controller.signal,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.emit("spawn");
            controller.abort(new Error("caller_aborted"));
          });
          return child as unknown as ChildProcess;
        },
        stopTimeoutMilliseconds: 1,
      }),
    ).rejects.toMatchObject({
      name: SshOwnedStdioCleanupError.name,
      cause: { diagnosticCode: "ssh_child_survived_cleanup" },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("terminates stderr overflow without retaining its contents", async () => {
    const child = fakeChild();
    const channel = await openOwnedSshStdio({
      host: "srv",
      remoteCommand: "true",
      signal: new AbortController().signal,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      maximumStderrBytes: 4,
      stopTimeoutMilliseconds: 1,
    });
    child.stderr.write("12345");
    await expect(channel.closed).resolves.toMatchObject({
      reason: "stderr_overflow",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }),
  });
  return child;
}

async function sshAliasFixture(directives: readonly string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "h-ssh-config-"));
  temporaryDirectories.push(directory);
  const config = path.join(directory, "config");
  await writeFile(
    config,
    [
      "Host carrier-alias",
      "  HostName 127.0.0.1",
      ...directives.map((directive) => `  ${directive}`),
      "",
    ].join("\n"),
  );
  const wrapper = path.join(directory, "ssh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}
