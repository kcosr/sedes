import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidecarProtocolDeliveryError,
  type SidecarOperationDefinition,
  type SidecarStreamDataRecord,
  type WorkspaceToolsShellTerminal,
} from "../../src/internal/sidecar-protocol/index.js";
import { SshSidecarConnectionError } from "../../src/server/sidecar/ssh-sidecar-artifact-installer.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import {
  SidecarWorkspaceShellExecutor,
  type WorkspaceShellRecoveryLease,
} from "../../src/server/workspace-tools/sidecar-workspace-shell-executor.js";

describe("sidecar workspace shell executor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a running disconnected command and restores its output without replay", async () => {
    const fixture = clientFixture();
    const onData = vi.fn();
    const shell = await fixture.start({ onData });
    const completed = vi.fn();
    void shell.terminal.then(completed);
    fixture.disconnect();
    await tick();
    expect(fixture.inspect).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    fixture.result = inspection("completed", "done");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "exited",
      truncated: false,
    });
    expect(
      onData.mock.calls.map(([record]) => Buffer.from(record.bytes).toString()),
    ).toEqual(["done"]);
    expect(fixture.starts).toBe(1);
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.originalRelease).toHaveBeenCalledTimes(1);
    expect(fixture.recoveryRelease).not.toHaveBeenCalled();
    expect(fixture.acknowledgments).toBe(0);
    await shell.acknowledge();
    expect(fixture.acknowledgments).toBe(1);
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.recoveryRelease).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates pending accepted output and repeated retained prefixes", async () => {
    const fixture = clientFixture();
    const gate = deferred<void>();
    const chunks: string[] = [];
    const shell = await fixture.start({
      onData: async (record) => {
        await gate.promise;
        chunks.push(Buffer.from(record.bytes).toString());
      },
    });
    fixture.emitData("abc");
    fixture.result = inspection("running", "abcdef");
    fixture.disconnect();
    await tick();
    expect(fixture.inspect).not.toHaveBeenCalled();
    gate.resolve();
    await tick();
    await tick(250);
    fixture.result = inspection("completed", "abcdefghi");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({ truncated: false });
    expect(chunks).toEqual(["abc", "def", "ghi"]);
  });

  it("marks actual retained-output gaps and lost cross-channel order as truncated", async () => {
    const fixture = clientFixture();
    const chunks: SidecarStreamDataRecord[] = [];
    const shell = await fixture.start({
      onData: (record) => {
        chunks.push(record);
      },
    });
    fixture.result = inspection("completed", "out", "err");
    fixture.result.terminal!.stdoutBytes = 100_000;
    fixture.disconnect();
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({ truncated: true });
    expect(
      chunks.map((record) => [
        record.channel,
        Buffer.from(record.bytes).toString(),
      ]),
    ).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
    ]);
  });

  it("does not claim original cross-channel ordering even when all preview bytes survive", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start();
    fixture.result = inspection("completed", "out", "err");
    fixture.disconnect();
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({ truncated: true });
  });

  it("keeps complete output untruncated when streaming already exceeded the retained prefix", async () => {
    const fixture = clientFixture();
    const onData = vi.fn();
    const shell = await fixture.start({ onData });
    fixture.emitData("abcdef");
    await tick();
    fixture.result = inspection("completed", "abc");
    fixture.result.terminal!.stdoutBytes = 6;
    fixture.result.previewOmittedBytes = 3;
    fixture.disconnect();
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({ truncated: false });
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it("reacquires after multiple carrier failures while retaining the original operation identity", async () => {
    const fixture = clientFixture();
    fixture.inspect.mockRejectedValueOnce(disconnectedError());
    const shell = await fixture.start();
    fixture.disconnect();
    await tick();
    await tick(250);
    fixture.inspect.mockRejectedValueOnce(disconnectedError());
    await tick(250);
    fixture.result = inspection("completed", "done");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    await shell.acknowledge();
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(3);
    expect(fixture.recoveryRelease).toHaveBeenCalledTimes(3);
    expect(fixture.starts).toBe(1);
    expect(
      new Set(fixture.inspect.mock.calls.map(([request]) => request.streamId)),
    ).toEqual(new Set([shell.streamId]));
  });

  it("retries a classified SSH outage during recovery acquisition", async () => {
    const fixture = clientFixture();
    fixture.acquireRecovery.mockRejectedValueOnce(
      new SshSidecarConnectionError({ cause: new Error("ssh exit 255") }),
    );
    const shell = await fixture.start();
    fixture.result = inspection("completed", "done");
    fixture.disconnect();
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(2);
    expect(fixture.starts).toBe(1);
  });

  it("reacquires when the recovered peer closes between inspection polls", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start();
    fixture.disconnect();
    await tick();
    fixture.inspect.mockRejectedValueOnce(new Error("sidecar_protocol_peer_closed"));
    await tick(250);
    fixture.result = inspection("completed", "done");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    await shell.acknowledge();
    expect(fixture.starts).toBe(1);
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(2);
    expect(new Set(fixture.inspect.mock.calls.map(([request]) => request.streamId)))
      .toEqual(new Set([shell.streamId]));
  });

  it("allows slow healthy acquisition within the command recovery budget", async () => {
    const fixture = clientFixture();
    fixture.acquireRecovery.mockImplementationOnce(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      signal.throwIfAborted();
      return { ...fixture.recoveryLease(), assertActive: () => signal.throwIfAborted() };
    });
    const shell = await fixture.start({ timeoutMilliseconds: 60_000 });
    fixture.result = inspection("completed", "done");
    fixture.disconnect();
    await tick(8_000);
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    await shell.acknowledge();
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.starts).toBe(1);
    expect(fixture.recoveryRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a retained completion lease if the caller leaves its receipt unacknowledged", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start();
    fixture.result = inspection("completed", "prefix");
    fixture.result.terminal!.stdoutBytes = 100_000;
    fixture.disconnect();
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({ truncated: true });
    expect(fixture.recoveryRelease).not.toHaveBeenCalled();
    await tick(5_000);
    expect(fixture.recoveryRelease).toHaveBeenCalledOnce();
    expect(fixture.acknowledgments).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries cancellation that raced ahead of the retained command receipt", async () => {
    const fixture = clientFixture();
    fixture.cancelCall.mockResolvedValueOnce({ accepted: false });
    const shell = await fixture.start();
    fixture.disconnect();
    await tick();
    await shell.cancel();
    await tick(250);
    expect(fixture.cancels).toEqual(["recovered", "recovered"]);
    fixture.result = inspection("completed");
    fixture.result.terminal = terminal("cancelled");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "cancelled",
    });
  });

  it("recovers a lost start acknowledgement and ignores a late original terminal", async () => {
    const fixture = clientFixture();
    fixture.startCall.mockRejectedValueOnce(disconnectedError());
    const shell = await fixture.start();
    fixture.emitTerminal(terminal("spawn_failed"));
    await tick();
    fixture.result = inspection("completed", "done");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    expect(fixture.starts).toBe(1);
  });

  it("retains a terminal that arrives before the start acknowledgement fails", async () => {
    const fixture = clientFixture();
    const start = deferred<unknown>();
    fixture.startCall.mockImplementationOnce(() => start.promise);
    const starting = fixture.start();
    await tick();
    fixture.emitTerminal(terminal("exited"));
    start.reject(disconnectedError());
    const shell = await starting;
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it("rejects a definitely unsent start without attempting recovery", async () => {
    const fixture = clientFixture();
    fixture.startCall.mockRejectedValueOnce(
      new SidecarProtocolDeliveryError("unsent", "not_sent"),
    );
    await expect(fixture.start()).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.originalRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains output consumers before publishing an original terminal", async () => {
    const fixture = clientFixture();
    const gate = deferred<void>();
    const shell = await fixture.start({ onData: () => gate.promise });
    const settled = vi.fn();
    void shell.terminal.then(settled);
    fixture.emitData("x");
    fixture.emitTerminal(terminal("exited"));
    fixture.disconnect();
    await tick();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve();
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({ outcome: "exited" });
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.credit).not.toHaveBeenCalled();
  });

  it("recovers credit transport failure without reporting consumer failure or cancelling", async () => {
    const fixture = clientFixture();
    fixture.credit.mockRejectedValueOnce(disconnectedError());
    const shell = await fixture.start();
    fixture.result = inspection("completed", "x");
    fixture.emitData("x");
    await tick();
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "exited",
      truncated: false,
    });
    expect(fixture.cancels).toEqual([]);
  });

  it("cancels after a consumer failure and rejects that failure only after terminal proof", async () => {
    const fixture = clientFixture();
    const error = new Error("consumer broke");
    const shell = await fixture.start({
      onData: () => {
        throw error;
      },
    });
    const result = expect(shell.terminal).rejects.toBe(error);
    fixture.emitData("x");
    await tick();
    expect(fixture.cancels).toEqual(["original"]);
    fixture.emitTerminal(terminal("cancelled"));
    await result;
  });

  it("keeps cancellation active through reconnect acquisition and waits for terminal proof", async () => {
    const fixture = clientFixture();
    const acquisition = deferred<WorkspaceShellRecoveryLease>();
    fixture.acquireRecovery.mockImplementationOnce(() => acquisition.promise);
    const controller = new AbortController();
    const shell = await fixture.start({ signal: controller.signal });
    fixture.disconnect();
    await tick();
    controller.abort();
    acquisition.resolve(fixture.recoveryLease());
    await tick();
    expect(fixture.cancels).toEqual(["recovered"]);
    fixture.result = inspection("completed");
    fixture.result.terminal = terminal("cancelled");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "cancelled",
    });
    await shell.cancel();
    expect(fixture.cancels).toEqual(["recovered"]);
    await shell.acknowledge();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends cancellation again on a replacement carrier after uncertain delivery", async () => {
    const fixture = clientFixture();
    fixture.cancelCall.mockRejectedValueOnce(disconnectedError());
    const shell = await fixture.start();
    await shell.cancel();
    await tick();
    expect(fixture.cancels).toEqual(["original", "recovered"]);
    fixture.result = inspection("completed");
    fixture.result.terminal = terminal("cancelled");
    await tick(250);
    await expect(shell.terminal).resolves.toMatchObject({
      outcome: "cancelled",
    });
  });

  it.each(["unknown", "denied", "same_closed_session"])(
    "fails promptly without replay when recovery is %s",
    async (failure) => {
      const fixture = clientFixture();
      if (failure === "unknown") fixture.result = inspection("unknown");
      if (failure === "denied")
        fixture.acquireRecovery.mockRejectedValueOnce(
          new Error("sidecar_recovery_denied"),
        );
      if (failure === "same_closed_session")
        fixture.acquireRecovery.mockResolvedValueOnce({
          session: fixture.originalSession,
          assertActive: () => undefined,
          release: fixture.recoveryRelease,
        });
      const shell = await fixture.start();
      const result = expect(shell.terminal).rejects.toMatchObject({
        diagnosticCode: "workspace_tools_shell_outcome_unknown",
      });
      fixture.disconnect();
      await tick();
      await result;
      expect(fixture.starts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a running command by its original timeout plus the recovery allowance", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start({ timeoutMilliseconds: 1_000 });
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.disconnect();
    await tick(5_999);
    expect(fixture.recoveryRelease).not.toHaveBeenCalled();
    await tick(1);
    await rejected;
    expect(fixture.recoveryRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds hanging acquisition, aborts it, and releases a late lease", async () => {
    const fixture = clientFixture();
    const acquisition = deferred<WorkspaceShellRecoveryLease>();
    fixture.acquireRecovery.mockImplementation(() => acquisition.promise);
    const shell = await fixture.start({ timeoutMilliseconds: 1_000 });
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.disconnect();
    await tick(6_000);
    await rejected;
    expect(
      fixture.acquireRecovery.mock.calls.every(([signal]) => signal.aborted),
    ).toBe(true);
    acquisition.resolve(fixture.recoveryLease());
    await tick();
    expect(fixture.acquireRecovery).toHaveBeenCalledOnce();
    expect(fixture.recoveryRelease).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hanging inspect and shortens offline cancellation to five seconds", async () => {
    const fixture = clientFixture();
    fixture.inspect.mockImplementation(() => new Promise(() => undefined));
    const shell = await fixture.start({ timeoutMilliseconds: 600_000 });
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.disconnect();
    await tick();
    await shell.cancel();
    await tick(5_000);
    await rejected;
    expect(
      fixture.inspect.mock.calls.every(([, signal]) => signal.aborted),
    ).toBe(true);
    expect(fixture.recoveryRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revalidates held recovery authority and stops without another inspect or mutation", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start();
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.disconnect();
    await tick();
    fixture.assertActive.mockImplementation(() => {
      throw new Error("sidecar_recovery_denied");
    });
    await tick(250);
    await rejected;
    expect(fixture.inspect).toHaveBeenCalledOnce();
    expect(fixture.cancels).toEqual([]);
    expect(fixture.starts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend the original deadline when cancellation arrives during cleanup", async () => {
    const fixture = clientFixture();
    const shell = await fixture.start({ timeoutMilliseconds: 1_000 });
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.disconnect();
    await tick(5_750);
    await shell.cancel();
    await tick(250);
    await rejected;
    expect(fixture.cancels).toEqual(["recovered"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enqueue duplicate preview output when its consumer hangs", async () => {
    const fixture = clientFixture();
    const gate = deferred<void>();
    const onData = vi.fn(() => gate.promise);
    const shell = await fixture.start({ onData, timeoutMilliseconds: 600_000 });
    const rejected = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    fixture.result = inspection("running", "prefix");
    fixture.disconnect();
    await tick(5_000);
    await rejected;
    gate.resolve();
    await tick(1_000);
    expect(onData).toHaveBeenCalledOnce();
    expect(fixture.inspect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function tick(milliseconds = 0) {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function disconnectedError() {
  return new SidecarProtocolDeliveryError(
    "carrier_closed",
    "sent_outcome_unknown",
  );
}

function clientFixture() {
  const closure = deferred<never>();
  let listeners!: {
    onData: (record: SidecarStreamDataRecord) => void;
    onTerminal: (value: WorkspaceToolsShellTerminal) => void;
  };
  let starts = 0;
  let acknowledgments = 0;
  let currentResult = inspection("running");
  const cancels: string[] = [];
  const originalRelease = vi.fn();
  const recoveryRelease = vi.fn();
  const credit = vi.fn(async (_bytes: number) => undefined);
  const inspect = vi.fn(
    async (_request: { streamId: string }, _signal: AbortSignal) =>
      currentResult,
  );
  const startCall = vi.fn(async (): Promise<unknown> => ({ admitted: true }));
  const cancelCall = vi.fn(async () => ({ accepted: true }));
  const makeSession = (name: string) =>
    ({
      closed:
        name === "original" ? closure.promise : new Promise(() => undefined),
      registerIncomingShellStream: (input: typeof listeners) => {
        listeners = input;
        return { addCredit: credit, unregister: vi.fn() };
      },
      call: async (
        definition: SidecarOperationDefinition<unknown, unknown>,
        request: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        if (definition.operation === "shell.start") {
          starts++;
          return startCall();
        }
        if (definition.operation === "shell.inspect")
          return inspect(request as { streamId: string }, options!.signal!);
        if (definition.operation === "shell.cancel") {
          cancels.push(name);
          return cancelCall();
        }
        if (definition.operation === "shell.acknowledge") {
          acknowledgments++;
          return { acknowledged: true };
        }
        throw new Error("unexpected_call");
      },
    }) as unknown as SidecarClientSession;
  const originalSession = makeSession("original");
  const recoveredSession = makeSession("recovered");
  const assertActive = vi.fn(() => undefined);
  const recoveryLease = (): WorkspaceShellRecoveryLease => ({
    session: recoveredSession,
    assertActive,
    release: recoveryRelease,
  });
  const acquireRecovery = vi.fn(
    async (_signal: AbortSignal): Promise<WorkspaceShellRecoveryLease> =>
      recoveryLease(),
  );
  const executor = new SidecarWorkspaceShellExecutor({
    acquireWorkspaceLease: async () => ({
      session: originalSession,
      workspaceHandle: "00000000-0000-4000-8000-000000000001",
      carrierGeneration: 1,
      release: originalRelease,
    }),
    acquireRecoveryLease: acquireRecovery,
  });
  return {
    start: (
      input: Partial<
        Parameters<SidecarWorkspaceShellExecutor["start"]>[0]
      > = {},
    ) =>
      executor.start({
        command: "printf done",
        initialCreditBytes: 1024,
        timeoutMilliseconds: 5_000,
        onData: () => undefined,
        ...input,
      }),
    disconnect: () => closure.reject(new Error("carrier_closed")),
    emitData: (text: string, channel: "stdout" | "stderr" = "stdout") =>
      listeners.onData({ channel, sequence: 0, bytes: Buffer.from(text) }),
    emitTerminal: (value: WorkspaceToolsShellTerminal) =>
      listeners.onTerminal(value),
    get result() {
      return currentResult;
    },
    set result(value) {
      currentResult = value;
    },
    get starts() {
      return starts;
    },
    get acknowledgments() {
      return acknowledgments;
    },
    originalSession,
    originalRelease,
    recoveryRelease,
    cancels,
    credit,
    inspect,
    startCall,
    cancelCall,
    acquireRecovery,
    recoveryLease,
    assertActive,
  };
}

function inspection(
  state: "running" | "completed" | "unknown",
  stdout = "",
  stderr = "",
) {
  return {
    state,
    terminal:
      state === "completed"
        ? {
            ...terminal("exited"),
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
          }
        : null,
    stdoutBase64: Buffer.from(stdout).toString("base64"),
    stderrBase64: Buffer.from(stderr).toString("base64"),
    previewOmittedBytes: 0,
  };
}

function terminal(
  outcome: WorkspaceToolsShellTerminal["outcome"],
): WorkspaceToolsShellTerminal {
  return {
    outcome,
    exitCode: outcome === "exited" ? 0 : null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    emittedBytes: 0,
    omittedBytes: 0,
    truncated: false,
  };
}
