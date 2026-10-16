import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { LocalInteractiveTerminalProvider } from "../../src/server/execution/local-interactive-terminal-provider.js";

const scope = { tenantId: "tenant", principalId: "principal" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalInteractiveTerminalProvider", () => {
  it("resolves execution variables on the terminal host and isolates successive terminals", async () => {
    const spawnPty = vi.fn(() => new FakePty() as unknown as IPty);
    const provider = new LocalInteractiveTerminalProvider({ scope, environmentId: "local", environment: { SHELL: "/bin/bash", HOST_KEY: "host-secret", LANG: "C" }, spawnPty });
    await provider.openTerminal({ ...openInput(), environmentVariables: { KEY: { kind: "secret", source: { kind: "environment", name: "HOST_KEY" } }, LANG: { kind: "unset" } } });
    await provider.openTerminal(openInput());
    const first = spawnPty.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    const second = spawnPty.mock.calls[1] as unknown as [string, string[], { env: Record<string, string> }];
    expect(first[2].env.KEY).toBe("host-secret");
    expect(first[2].env).not.toHaveProperty("LANG");
    expect(second[2].env).not.toHaveProperty("KEY");
    expect(second[2].env.LANG).toBe("C");
  });

  it("spawns an absolute login shell with the requested CWD, geometry, and normalized environment", async () => {
    const pty = new FakePty();
    const spawnPty = vi.fn(() => pty as unknown as IPty);
    const provider = new LocalInteractiveTerminalProvider({
      scope,
      environmentId: "local",
      environment: {
        SHELL: "/bin/zsh",
        PATH: "/opt/bin",
        OMITTED: undefined,
        TERM: "wrong",
        COLORTERM: "wrong",
      },
      spawnPty,
    });

    expect(provider.availability(scope, "local")).toBe("available");
    expect(
      provider.availability({ ...scope, principalId: "other" }, "local"),
    ).toBe("unavailable");
    const terminal = await provider.openTerminal(openInput());

    expect(spawnPty).toHaveBeenCalledWith(
      "/bin/zsh",
      process.platform === "win32" ? [] : ["-l"],
      {
        cwd: "/workspace",
        env: {
          SHELL: "/bin/zsh",
          PATH: "/opt/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        name: "xterm-256color",
        cols: 132,
        rows: 43,
        encoding: null,
      },
    );

    await expect(terminal.write(Buffer.from("echo ok"))).resolves.toEqual({
      outcome: "sent",
    });
    expect(pty.writes).toEqual([Buffer.from("echo ok")]);
    await terminal.resize({ rows: 50, columns: 160 });
    expect(pty.resizes).toEqual([{ columns: 160, rows: 50 }]);
    terminal.pauseOutput();
    terminal.pauseOutput();
    terminal.resumeOutput();
    terminal.resumeOutput();
    expect(pty.pauseCalls).toBe(1);
    expect(pty.resumeCalls).toBe(1);
  });

  it("rejects unavailable scopes and unsupported shell profiles before spawning", async () => {
    const spawnPty = vi.fn(() => new FakePty() as unknown as IPty);
    const provider = new LocalInteractiveTerminalProvider({
      scope,
      environmentId: "local",
      spawnPty,
    });

    await expect(
      provider.openTerminal(
        openInput({ scope: { ...scope, tenantId: "other" } }),
      ),
    ).rejects.toThrow("interactive_terminal_environment_unavailable");
    await expect(
      provider.openTerminal(openInput({ shellProfile: "fish" })),
    ).rejects.toThrow("interactive_terminal_shell_profile_unsupported");
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "falls back to bash when SHELL is relative",
    async () => {
      const pty = new FakePty();
      const spawnPty = vi.fn(() => pty as unknown as IPty);
      const provider = new LocalInteractiveTerminalProvider({
        scope,
        environmentId: "local",
        environment: { SHELL: "bin/fish" },
        spawnPty,
      });

      await provider.openTerminal(openInput());
      expect(spawnPty).toHaveBeenCalledWith(
        "/bin/bash",
        ["-l"],
        expect.any(Object),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "falls back to the native command shell and uses signal-free PTY termination",
    async () => {
      const pty = new FakePty();
      const spawnPty = vi.fn(() => pty as unknown as IPty);
      const provider = new LocalInteractiveTerminalProvider({
        scope,
        environmentId: "local",
        environment: {
          SHELL: "bin/fish",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
        spawnPty,
      });

      const terminal = await provider.openTerminal(openInput());
      expect(spawnPty).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\cmd.exe",
        [],
        expect.any(Object),
      );
      await terminal.terminate("terminate");
      expect(pty.kills).toEqual([""]);
    },
  );

  it("signals the PTY process group and falls back to node-pty signaling", async () => {
    const pty = new FakePty();
    const provider = providerWith(pty);
    const terminal = await provider.openTerminal(openInput());
    const groupKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => {
        throw new Error("no process group");
      });

    await terminal.terminate("hangup");
    if (process.platform !== "win32") {
      expect(groupKill).toHaveBeenCalledWith(-pty.pid, "SIGHUP");
    }
    expect(pty.kills).toEqual(
      process.platform === "win32" ? [""] : ["SIGHUP"],
    );

    groupKill.mockImplementation(() => true);
    await terminal.terminate("terminate");
    await terminal.terminate("kill");
    if (process.platform === "win32") {
      expect(groupKill).not.toHaveBeenCalled();
      expect(pty.kills).toEqual([""]);
    } else {
      expect(groupKill).toHaveBeenCalledWith(-pty.pid, "SIGTERM");
      expect(groupKill).toHaveBeenCalledWith(-pty.pid, "SIGKILL");
      expect(pty.kills).toEqual(["SIGHUP"]);
    }
  });

  it("caps unattached early output and reports the forced exit as interrupted", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    pty.emitData(new Uint8Array(1024 * 1024 + 1));
    expect(pty.kills).toEqual(
      process.platform === "win32" ? [""] : ["SIGHUP"],
    );
    pty.emitExit({ exitCode: 1, signal: 1 });

    const exits: unknown[] = [];
    terminal.onExit((exit) => exits.push(exit));
    expect(exits).toEqual([
      {
        disposition: "interrupted",
        exitCode: 1,
        signal: "1",
        diagnosticCode: "local_terminal_early_output_limit",
      },
    ]);
  });

  it("confirms requested cleanup only after the local process group is gone", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });
    const exits: unknown[] = [];
    terminal.onExit((exit) => exits.push(exit));
    await terminal.terminate("hangup");
    pty.emitExit({ exitCode: 0, signal: 0 });
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(exits[0]).toMatchObject({
      disposition: "exited",
      cleanupConfirmed: true,
    });
  });

  it("retains an unconfirmed local cleanup when descendants survive leader exit", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    vi.spyOn(process, "kill").mockReturnValue(true);
    const exits: unknown[] = [];
    terminal.onExit((exit) => exits.push(exit));
    await terminal.terminate("hangup");
    pty.emitExit({ exitCode: 0, signal: 0 });
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 1_000 });
    expect(exits[0]).toMatchObject({
      disposition: "interrupted",
      diagnosticCode: "local_terminal_cleanup_unconfirmed",
      cleanupConfirmed: false,
    });
    if (process.platform !== "win32") {
      expect(process.kill).toHaveBeenCalledWith(-pty.pid, "SIGTERM");
      expect(process.kill).toHaveBeenCalledWith(-pty.pid, "SIGKILL");
    }
  });

  it("ignores output and rejects process operations after exit", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    const output: string[] = [];
    terminal.onOutput((bytes) => output.push(Buffer.from(bytes).toString()));
    pty.emitData("before");
    pty.emitExit({ exitCode: 0, signal: 0 });
    pty.emitData("after");

    expect(output).toEqual(["before"]);
    await expect(terminal.write(Buffer.from("ignored"))).resolves.toEqual({
      outcome: "not_sent",
    });
    await expect(
      terminal.resize({ rows: 30, columns: 90 }),
    ).rejects.toThrow("interactive_terminal_process_exited");
    await terminal.terminate("kill");
    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
    expect(pty.kills).toEqual(process.platform === "win32" ? [""] : []);
  });

  it.each([false, true])("releases the Windows PTY on natural exit with descendant cleanup=%s", async cleanupOnNaturalExit => {
    const pty = new FakePty();
    const terminal = await providerWith(pty, cleanupOnNaturalExit).openTerminal(openInput());
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const events: unknown[] = [];
    terminal.onOutput(bytes => events.push(Buffer.from(bytes).toString()));
    const exited = new Promise(resolve => terminal.onExit(exit => { events.push(exit); resolve(exit); }));
    pty.emitData("last output");
    pty.emitExit({ exitCode: 0, signal: 0 });
    const exit = await exited;
    expect(exit).toEqual({ disposition: "exited", exitCode: 0, signal: null, ...(cleanupOnNaturalExit ? { cleanupConfirmed: true } : {}) });
    expect(events).toEqual(["last output", exit]);
    const replay: unknown[] = [];
    terminal.onExit(value => replay.push(value));
    expect(replay).toEqual([exit]);
    pty.emitData("late output");
    pty.emitExit({ exitCode: 9, signal: 0 });
    await terminal.terminate("kill");
    expect(events).toHaveLength(2);
    expect(pty.kills).toEqual(process.platform === "win32" ? [""] : []);
    if (process.platform !== "win32") {
      expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    }
  });

  it.runIf(process.platform === "win32").each([false, true])("does not confirm failed Windows PTY cleanup with descendant cleanup=%s", async cleanupOnNaturalExit => {
    const pty = new FakePty();
    vi.spyOn(pty, "kill").mockImplementation(() => { throw new Error("cleanup failed"); });
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const terminal = await providerWith(pty, cleanupOnNaturalExit).openTerminal(openInput());
    const exited = new Promise(resolve => terminal.onExit(resolve));
    expect(() => pty.emitExit({ exitCode: 0, signal: 0 })).not.toThrow();
    await expect(exited).resolves.toEqual({ disposition: "interrupted", exitCode: 0, signal: null, diagnosticCode: "local_terminal_cleanup_unconfirmed", cleanupConfirmed: false });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "win32")("does not repeat Windows cleanup across output limits, termination and exit", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    pty.emitData(new Uint8Array(1024 * 1024 + 1));
    pty.emitData("still buffered");
    await terminal.terminate("hangup");
    await terminal.terminate("terminate");
    await terminal.terminate("kill");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const exited = new Promise(resolve => terminal.onExit(resolve));
    pty.emitExit({ exitCode: 1, signal: 0 });
    await expect(exited).resolves.toMatchObject({ disposition: "interrupted", diagnosticCode: "local_terminal_early_output_limit", cleanupConfirmed: true });
    expect(pty.kills).toEqual([""]);
  });

  it.runIf(process.platform === "win32")("retains a failed explicit cleanup without invoking the PTY twice", async () => {
    const pty = new FakePty();
    vi.spyOn(pty, "kill").mockImplementation(() => { throw new Error("cleanup failed"); });
    const terminal = await providerWith(pty).openTerminal(openInput());
    await expect(terminal.terminate("hangup")).rejects.toThrow();
    await expect(terminal.terminate("kill")).rejects.toThrow();
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const exited = new Promise(resolve => terminal.onExit(resolve));
    pty.emitExit({ exitCode: 0, signal: 0 });
    await expect(exited).resolves.toMatchObject({ disposition: "interrupted", cleanupConfirmed: false });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "win32")("contains cleanup failure in the early-output callback", async () => {
    const pty = new FakePty();
    vi.spyOn(pty, "kill").mockImplementation(() => { throw new Error("cleanup failed"); });
    const terminal = await providerWith(pty).openTerminal(openInput());
    expect(() => pty.emitData(new Uint8Array(1024 * 1024 + 1))).not.toThrow();
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const exited = new Promise(resolve => terminal.onExit(resolve));
    pty.emitExit({ exitCode: 1, signal: 0 });
    await expect(exited).resolves.toMatchObject({ disposition: "interrupted", diagnosticCode: "local_terminal_early_output_limit", cleanupConfirmed: false });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "win32")("retains cleanup failure when termination reports exit reentrantly", async () => {
    const pty = new FakePty();
    const terminal = await providerWith(pty).openTerminal(openInput());
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    vi.spyOn(pty, "kill").mockImplementation(() => {
      pty.emitExit({ exitCode: 0, signal: 0 });
      throw new Error("cleanup failed after exit");
    });
    const exited = new Promise(resolve => terminal.onExit(resolve));
    await expect(terminal.terminate("hangup")).rejects.toThrow();
    await expect(exited).resolves.toMatchObject({ disposition: "interrupted", cleanupConfirmed: false });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("does not signal a retired POSIX terminal PID", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      const pty = new FakePty();
      const terminal = await providerWith(pty, true).openTerminal(openInput());
      const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
      const exited = new Promise(resolve => terminal.onExit(resolve));
      pty.emitExit({ exitCode: 0, signal: 0 });
      await expect(exited).resolves.toMatchObject({ disposition: "exited", cleanupConfirmed: true });
      await terminal.terminate("kill");
      expect(pty.kills).toEqual([]);
      expect(probe.mock.calls).toEqual([[-pty.pid, 0]]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

function providerWith(pty: FakePty, cleanupOnNaturalExit = false): LocalInteractiveTerminalProvider {
  return new LocalInteractiveTerminalProvider({
    scope,
    environmentId: "local",
    environment: { SHELL: "/bin/bash" },
    spawnPty: () => pty as unknown as IPty,
    cleanupOnNaturalExit,
  });
}

function openInput(
  overrides: Partial<Parameters<LocalInteractiveTerminalProvider["openTerminal"]>[0]> = {},
) {
  return {
    scope,
    environmentId: "local",
    terminalId: "11111111-1111-4111-8111-111111111111",
    incarnationId: "22222222-2222-4222-8222-222222222222",
    initialCwd: "/workspace",
    rows: 43,
    columns: 132,
    ...overrides,
  };
}

class FakePty {
  readonly pid = 1234;
  readonly writes: Buffer[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly kills: string[] = [];
  pauseCalls = 0;
  resumeCalls = 0;
  #dataListener: ((chunk: string | Uint8Array) => void) | undefined;
  #exitListener:
    | ((event: { exitCode: number; signal: number }) => void)
    | undefined;

  onData(listener: (chunk: string | Uint8Array) => void) {
    this.#dataListener = listener;
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void) {
    this.#exitListener = listener;
    return { dispose: () => undefined };
  }

  write(bytes: Buffer) {
    this.writes.push(Buffer.from(bytes));
  }

  resize(columns: number, rows: number) {
    this.resizes.push({ columns, rows });
  }

  kill(signal?: string) {
    this.kills.push(signal ?? "");
  }

  pause() {
    this.pauseCalls += 1;
  }

  resume() {
    this.resumeCalls += 1;
  }

  emitData(chunk: string | Uint8Array) {
    this.#dataListener?.(chunk);
  }

  emitExit(event: { exitCode: number; signal: number }) {
    this.#exitListener?.(event);
  }
}
