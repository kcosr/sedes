import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import {
  quoteWindowsArgument,
  spawnWindowsOwnedProcess,
} from "../../src/server/execution/windows-owned-process.js";

const input = {
  executable: "C:\\Program Files\\node.exe",
  arguments: ["", 'quote" and slash\\', "日本語"],
  cwd: "C:\\workspace",
  environment: { TOKEN: "secret value", PATH: "C:\\bin" },
  signal: new AbortController().signal,
};

function supervisor(
  options: {
    acknowledge?: boolean;
    ready?: boolean;
    delayedReceipt?: boolean;
    receipt?: string;
  } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      socket?.destroy();
      child.emit("close", null, "SIGTERM");
      return true;
    }),
  });
  let socket: Socket | undefined;
  let configurationResolve!: (value: string[]) => void;
  const configuration = new Promise<string[]>((resolve) => {
    configurationResolve = resolve;
  });
  spawn.mockImplementation((_executable, _args, launch) => {
    const [port, token] = launch.env.SEDES_WINDOWS_JOB_CONTROL.split(":");
    socket = createConnection({
      host: "127.0.0.1",
      port: Number(port),
      allowHalfOpen: true,
    });
    socket.once("connect", () => socket!.write(`${token}\n`));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.split("\n").length !== 5) return;
      configurationResolve(
        buffer
          .trimEnd()
          .split("\n")
          .map((part) => Buffer.from(part, "base64").toString("utf8")),
      );
      if (options.ready !== false) socket!.write("ready\n");
    });
    socket.on("end", () => {
      if (options.delayedReceipt) child.emit("close", 0, null);
      if (options.ready === false && options.acknowledge !== false)
        socket!.write("ready\n");
      if (options.acknowledge !== false)
        socket!.write(options.receipt ?? "clean\n");
      socket!.end();
      if (!options.delayedReceipt) child.emit("close", 0, null);
    });
    return child;
  });
  return { child, configuration };
}

afterEach(() => vi.resetAllMocks());

describe("Windows job ownership", () => {
  it("sends exact launch data over authenticated control, separately from raw streams", async () => {
    const fake = supervisor();
    const owned = await spawnWindowsOwnedProcess(input);
    const config = await fake.configuration;
    expect(config).toEqual([
      input.executable,
      input.arguments.length
        ? [input.executable, ...input.arguments]
            .map(quoteWindowsArgument)
            .join(" ")
        : "",
      input.cwd,
      `PATH=C:\\bin\0SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}\0TOKEN=secret value\0\0`,
    ]);
    const [, args, options] = spawn.mock.calls[0]!;
    expect(args.join(" ")).not.toContain("secret value");
    expect(args.join(" ").length).toBeLessThan(32_000);
    expect(options.env.TOKEN).toBeUndefined();
    expect(owned.child.stdout).toBe(fake.child.stdout);
    await owned.close(1_000);
  });

  it("uses Node's deterministic case-insensitive environment precedence", async () => {
    const fake = supervisor();
    const owned = await spawnWindowsOwnedProcess({
      ...input,
      environment: { Path: "old", PATH: "new", Z: "last", a: "first" },
    });
    expect((await fake.configuration)[3]).toBe(`a=first\0PATH=new\0SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}\0Z=last\0\0`);
    await owned.close(1_000);
  });

  it("uses the required double NUL even for an empty environment", async () => {
    const fake = supervisor();
    const owned = await spawnWindowsOwnedProcess({ ...input, environment: {} });
    expect((await fake.configuration)[3]).toBe(`SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}\0\0`);
    await owned.close(1_000);
  });

  it("does not admit before ownership is acknowledged", async () => {
    const fake = supervisor({ ready: false });
    const controller = new AbortController();
    let admitted = false;
    const opened = spawnWindowsOwnedProcess({
      ...input,
      signal: controller.signal,
    }).then((value) => {
      admitted = true;
      return value;
    });
    const abortReason = new Error("test_open_aborted");
    const rejected = expect(opened).rejects.toBe(abortReason);
    await fake.configuration;
    expect(admitted).toBe(false);
    controller.abort(abortReason);
    await rejected;
    expect(fake.child.kill).not.toHaveBeenCalled();
  });

  it("reports uncertain startup cleanup when a configured supervisor exits without its receipt", async () => {
    const fake = supervisor({ ready: false, acknowledge: false });
    const controller = new AbortController();
    const opened = spawnWindowsOwnedProcess({
      ...input,
      signal: controller.signal,
    });
    const rejected = expect(opened).rejects.toThrow(
      "windows_job_open_cleanup_unconfirmed",
    );
    await fake.configuration;
    controller.abort();
    await rejected;
    expect(fake.child.kill).toHaveBeenCalled();
  });

  it("does not confuse supervisor exit with confirmed descendant cleanup", async () => {
    supervisor({ acknowledge: false });
    const owned = await spawnWindowsOwnedProcess(input);
    await expect(owned.close(1_000)).rejects.toThrow(
      "windows_job_cleanup_unconfirmed",
    );
  });

  it.each(["clean\nclean\n", "ready\nclean\n", "clean\ninvalid\n"])(
    "rejects malformed cleanup sequence %j",
    async (receipt) => {
      supervisor({ receipt });
      const owned = await spawnWindowsOwnedProcess(input);
      await expect(owned.close(1_000)).rejects.toThrow(
        "windows_job_cleanup_unconfirmed",
      );
    },
  );

  it("drains a cleanup acknowledgment delivered after the process close event", async () => {
    supervisor({ delayedReceipt: true });
    const owned = await spawnWindowsOwnedProcess(input);
    await expect(owned.close(1_000)).resolves.toBeUndefined();
  });

  it("rejects invalid launch data before opening a supervisor", async () => {
    await expect(
      spawnWindowsOwnedProcess({ ...input, arguments: ["bad\0argument"] }),
    ).rejects.toThrow("windows_job_launch_input_invalid");
    await expect(
      spawnWindowsOwnedProcess({
        ...input,
        environment: { "BAD=KEY": "value" },
      }),
    ).rejects.toThrow("windows_job_launch_input_invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["", '""'],
    ["plain", '"plain"'],
    ["space value", '"space value"'],
    ['a"b', '"a\\"b"'],
    ["a\\", '"a\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
  ])("quotes argument %j without shell interpretation", (value, expected) => {
    expect(quoteWindowsArgument(value)).toBe(expected);
  });
});
