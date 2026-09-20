import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildOwnedStdioAppServerArguments,
  OwnedStdioTransportFactory,
} from "../../src/server/backends/codex/transport/owned-stdio-transport.js";
import type { OwnedNdjsonStdioLimits } from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";
import {
  FrameWriteError,
  isValidFramedTransportAssurance,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const fixture = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "codex-owned-stdio-child.mjs",
);
const scope = {
  tenantId: "tenant-a",
  principalId: "principal-a",
  backendInstanceId: "codex-a",
  executionEnvironmentId: "environment-a",
} as const;

async function fixtureFactory(input: {
  readonly executablePath?: string;
  readonly limits?: Partial<OwnedNdjsonStdioLimits>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly sqliteHome?: string;
  readonly commandArguments?: readonly string[];
}) {
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
  });
  const prepared = await channels.prepareOwnedProcess(scope, {
    executablePath: input.executablePath ?? process.execPath,
    workingDirectory: repositoryRoot,
  });
  return new OwnedStdioTransportFactory({
    scope,
    channels,
    process: prepared,
    environment: input.environment ?? {},
    sqliteHome: input.sqliteHome ?? "/private/codex-home",
    limits: input.limits,
    commandArguments: input.commandArguments,
    sensitiveValues: ["secret-one", "secret-two", "/private/codex-home"],
  });
}

async function openFixture(
  mode: string,
  input?: {
    readonly limits?: Partial<OwnedNdjsonStdioLimits>;
    readonly environment?: Readonly<Record<string, string>>;
  },
) {
  const factory = await fixtureFactory({
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CODEX_STDIO_FIXTURE_MODE: mode,
      ...(input?.environment ?? {}),
    },
    limits: input?.limits,
    commandArguments: [fixture],
  });
  return await factory.open(scope, 1, new AbortController().signal);
}

describe("OwnedStdioTransport", () => {
  it("forces the configured SQLite namespace over config.toml", () => {
    expect(
      buildOwnedStdioAppServerArguments("/srv/codex/principal-one"),
    ).toEqual([
      "app-server",
      "--config",
      'sqlite_home="/srv/codex/principal-one"',
      "--strict-config",
      "--listen",
      "stdio://",
    ]);
    expect(() => buildOwnedStdioAppServerArguments("relative")).toThrow(
      "codex_owned_stdio_sqlite_home_invalid",
    );
  });

  it("keeps the SQLite namespace in CLI arguments without injecting it into the environment", async () => {
    const factory = await fixtureFactory({
      environment: { HOME: "/ordinary-home" },
      sqliteHome: "/srv/codex/principal-one",
    });
    const openOwnedProcess = vi
      .spyOn(LocalEnvironmentChannelProvider.prototype, "openOwnedProcess")
      .mockRejectedValueOnce(new Error("launch_captured"));
    try {
      await expect(
        factory.open(scope, 1, new AbortController().signal),
      ).rejects.toThrow("launch_captured");
      const [, launchInput] = openOwnedProcess.mock.calls[0]!;
      expect(launchInput.arguments).toEqual([
        "app-server",
        "--config",
        'sqlite_home="/srv/codex/principal-one"',
        "--strict-config",
        "--listen",
        "stdio://",
      ]);
      expect(launchInput.environment).toEqual({ HOME: "/ordinary-home" });
      expect(launchInput.environment).not.toHaveProperty("CODEX_HOME");
      expect(launchInput.environment).not.toHaveProperty("CODEX_SQLITE_HOME");
    } finally {
      openOwnedProcess.mockRestore();
    }
  });

  it("frames split JSONL messages and preserves exact scope assurance", async () => {
    const transport = await openFixture("split");
    const iterator = transport.frames[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { text: '{"sequence":1}', byteLength: 14 },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: { text: '{"sequence":2}', byteLength: 14 },
      done: false,
    });
    expect(transport.assurance).toMatchObject({
      kind: "owned_process",
      scope,
      environmentChannelIdentity: {
        executable: { canonicalPath: await realpath(process.execPath) },
      },
    });
    await transport.close("test_complete");
    expect(isValidFramedTransportAssurance(transport.assurance)).toBe(false);
    await expect(transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
  });

  it("keeps the Codex owned process healthy beyond the former shared lifetime frame ceiling", async () => {
    const transport = await openFixture("echo", {
      limits: {
        maximumFrameBytes: 64,
        maximumInboundQueueBytes: 64,
        maximumInboundQueueFrames: 1,
        maximumOutboundQueueBytes: 64,
        maximumOutboundQueueFrames: 1,
      },
    });
    const iterator = transport.frames[Symbol.asyncIterator]();
    const frames = 4_097;
    for (let index = 0; index < frames; index += 1) {
      const text = JSON.stringify({ sequence: index });
      await expect(transport.send(text)).resolves.toEqual({
        disposition: "sent",
      });
      await expect(iterator.next()).resolves.toEqual({
        value: { text, byteLength: Buffer.byteLength(text) },
        done: false,
      });
    }
    expect(transport.diagnostics()).toMatchObject({
      inboundFramesRead: frames,
      outboundFramesAccepted: frames,
      outboundFramesWritten: frames,
    });
    await transport.close("test_complete");
    await expect(transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
  }, 15_000);

  it("rejects invalid UTF-8 instead of substituting replacement characters", async () => {
    const transport = await openFixture("invalid_utf8");
    const iterator = transport.frames[Symbol.asyncIterator]();
    await expect(transport.closed).resolves.toMatchObject({
      reason: "invalid_inbound_frame",
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(Error);
  });

  it.each(["stderr", "stderr_split"])("drains %s without retaining late or multiline session secrets", async mode => {
    const transport = await openFixture(mode, { environment: {
      CODEX_STDIO_FIXTURE_SECRET: "late-secret\nsecond-line", CODEX_STDIO_FIXTURE_BEARER: "other-secret",
    } });
    try {
      await vi.waitFor(() => expect(transport.diagnostics().stderrBytesRead).toBeGreaterThan(0));
      expect(transport.diagnostics()).toMatchObject({ stderrTail: "", stderrTailBytes: 0 });
    } finally { await transport.close("test_complete"); }
    expect(transport.diagnostics()).toMatchObject({ streamsDrained: true, stderrTail: "", stderrTailBytes: 0 });
  });

  it("settles an aborted active write promptly with unknown delivery", async () => {
    const transport = await openFixture("blocked_stdin", {
      limits: {
        maximumFrameBytes: 1024 * 1024,
        maximumOutboundQueueBytes: 2 * 1024 * 1024,
      },
    });
    const controller = new AbortController();
    const write = transport.send("x".repeat(768 * 1024), {
      signal: controller.signal,
    });
    controller.abort(new Error("test_timeout"));

    await expect(
      Promise.race([
        write,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("active_write_abort_not_prompt")),
            200,
          ),
        ),
      ]),
    ).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await transport.closed;
  });

  it("backpressures at the queued frame limit and releases waiters on shutdown", async () => {
    const transport = await openFixture("blocked_stdin", {
      limits: {
        maximumFrameBytes: 1024 * 1024,
        maximumOutboundQueueBytes: 3 * 1024 * 1024,
        maximumOutboundQueueFrames: 1,
      },
    });
    const payload = "x".repeat(768 * 1024);
    const active = transport.send(payload);
    const queued = transport.send(payload);
    const activeOutcome = active.then(
      () => ({ disposition: "sent" as const }),
      (error: unknown) => error,
    );
    const queuedOutcome = queued.then(
      () => ({ disposition: "sent" as const }),
      (error: unknown) => error,
    );
    let saturatedSettled = false;
    const saturatedOutcome = transport.send(payload).then(
      () => ({ disposition: "sent" as const }),
      (error: unknown) => error,
    );
    void saturatedOutcome.finally(() => {
      saturatedSettled = true;
    });
    await Promise.resolve();
    expect(saturatedSettled).toBe(false);
    await transport.close("test_shutdown");
    await expect(activeOutcome).resolves.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(queuedOutcome).resolves.toMatchObject({
      delivery: "not_sent",
    });
    await expect(saturatedOutcome).resolves.toMatchObject({
      delivery: "not_sent",
    });
  });

  it("kills the owned process group including a stubborn descendant", async () => {
    const transport = await openFixture("descendant", {
      limits: {
        gracefulCloseMilliseconds: 20,
        terminateMilliseconds: 20,
        killMilliseconds: 500,
      },
    });
    const iterator = transport.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    const descendantPid = JSON.parse(first.value!.text).descendantPid as number;
    await transport.close("test_process_group_cleanup");
    expect(processExists(descendantPid)).toBe(false);
    await expect(transport.closed).resolves.toMatchObject({
      reason: "test_process_group_cleanup",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects close when process-group cleanup cannot prove the group is gone",
    async () => {
      const transport = await openFixture("echo", {
        limits: {
          gracefulCloseMilliseconds: 10,
          terminateMilliseconds: 10,
          killMilliseconds: 10,
        },
      });
      const processIdentity =
        transport.assurance.environmentChannelIdentity.providerProcessIdentity;
      if (processIdentity.type !== "local_process_group")
        throw new Error("test_requires_posix_process_group");
      const ownedPid = processIdentity.processGroupId;
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number,
      ) => {
        if (pid === -ownedPid) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill);
      try {
        await expect(transport.close("test_orphan")).rejects.toThrow(
          "orphaned_process_group",
        );
        await expect(transport.closed).resolves.toMatchObject({
          reason: "orphaned_process_group",
        });
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it("closes a transport whose child fails during spawn", async () => {
    const filename = path.join(
      os.homedir(),
      `.codex-non-executable-${process.pid}-${Date.now()}`,
    );
    await writeFile(filename, "#!/definitely/missing/interpreter\n", {
      mode: 0o700,
    });
    try {
      const factory = await fixtureFactory({
        executablePath: filename,
        environment: {},
        commandArguments: [],
        limits: {
          gracefulCloseMilliseconds: 20,
          terminateMilliseconds: 20,
          killMilliseconds: 20,
        },
      });
      await expect(
        factory.open(scope, 1, new AbortController().signal),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(filename, { force: true });
    }
  });

  it("awaits detached process-group cleanup before rejecting an open abort", async () => {
    const originalKill = process.kill.bind(process);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | number) =>
        originalKill(pid, signal)) as typeof process.kill);
    const abortReason = new Error("abort_during_open");
    const abortSignal = {
      aborted: false,
      reason: abortReason,
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        if (type !== "abort") return;
        const event = new Event("abort");
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    try {
      const factory = await fixtureFactory({
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_STDIO_FIXTURE_MODE: "descendant",
        },
        commandArguments: [fixture],
        limits: {
          gracefulCloseMilliseconds: 20,
          terminateMilliseconds: 20,
          killMilliseconds: 500,
        },
      });
      await expect(factory.open(scope, 1, abortSignal)).rejects.toBe(
        abortReason,
      );
      const signalledGroup = killSpy.mock.calls.find(
        ([pid, signal]) =>
          typeof pid === "number" &&
          pid < 0 &&
          (signal === "SIGTERM" || signal === "SIGKILL"),
      );
      if (process.platform !== "win32") {
        expect(signalledGroup).toBeDefined();
        expect(processGroupExistsForTest(-signalledGroup![0])).toBe(false);
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it("labels sends after close as definitely not sent", async () => {
    const transport = await openFixture("echo");
    await transport.close("test_complete");
    await expect(transport.send("{}")).rejects.toEqual(
      expect.objectContaining<Partial<FrameWriteError>>({
        delivery: "not_sent",
      }),
    );
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExistsForTest(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
