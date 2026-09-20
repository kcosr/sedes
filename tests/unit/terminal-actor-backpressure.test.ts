import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalResource,
  TerminalServerFrame,
} from "../../src/shared/protocol/terminals.js";
import { TERMINAL_PROTOCOL_VERSION } from "../../src/shared/protocol/terminals.js";
import type {
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
} from "../../src/server/execution/interactive-terminal.js";
import { TerminalActor } from "../../src/server/terminals/terminal-actor.js";
import { TerminalHeadlessEmulator } from "../../src/server/terminals/terminal-emulator.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import type { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TerminalActor backpressure and liveness", () => {
  it("pauses provider output at the high watermark and resumes below the low watermark", async () => {
    const gate = deferred<{ readonly erasedScrollback: boolean }>();
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockImplementation(
      () => gate.promise,
    );
    const harness = createHarness();

    harness.process.output(new Uint8Array(300 * 1024));
    harness.process.output(new Uint8Array(300 * 1024));
    expect(harness.process.pauseCalls).toBe(1);
    expect(harness.process.resumeCalls).toBe(0);

    gate.resolve({ erasedScrollback: false });
    await vi.waitFor(() => expect(harness.resource().headSeq).toBe(2));
    await vi.waitFor(() => expect(harness.process.resumeCalls).toBe(1));
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
    await vi.waitFor(() =>
      expect(harness.resource().lifecycle).toBe("exited"),
    );
  });

  it("kills and fails a terminal whose provider overruns the aggregate pending-output cap", async () => {
    const gate = deferred<{ readonly erasedScrollback: boolean }>();
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockImplementation(
      () => gate.promise,
    );
    const harness = createHarness();

    harness.process.output(new Uint8Array(2 * 1024 * 1024 + 1));
    expect(harness.process.pauseCalls).toBe(1);
    expect(harness.process.terminations).toContain("kill");
    await vi.waitFor(() =>
      expect(harness.resource()).toMatchObject({
        lifecycle: "failed",
        publicReason: "provider_output_overflow",
      }),
    );
    expect(harness.process.resumeCalls).toBe(0);
    expect(harness.finalized).toHaveBeenCalledOnce();
    gate.resolve({ erasedScrollback: false });
  });

  it("escalates hangup through terminate and kill before cleanup becomes unconfirmed", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await expect(harness.actor.terminate(3)).resolves.toMatchObject({
      lifecycle: "stopping",
    });
    expect(harness.process.terminations).toEqual(["hangup"]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.process.terminations).toEqual(["hangup"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.process.terminations).toEqual(["hangup", "terminate"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.process.terminations).toEqual([
      "hangup",
      "terminate",
      "kill",
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(harness.resource()).toMatchObject({
      lifecycle: "failed",
      publicReason: "cleanup_unconfirmed",
    });
    expect(harness.finalized).toHaveBeenCalledOnce();
  });

  it("rejects End and releases actor ownership when final persistence fails", async () => {
    const harness = createHarness();
    const ending = harness.actor.end(3);
    await vi.waitFor(() => expect(harness.process.terminations).toEqual(["hangup"]));
    vi.spyOn(harness.repository, "finalize").mockImplementation(() => {
      throw new Error("database_unavailable");
    });
    harness.process.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(ending).rejects.toThrow("database_unavailable");
    expect(harness.finalized).toHaveBeenCalledOnce();
  });

  it("revokes control while stopping and detaches viewers after successful End", async () => {
    const harness = createHarness();
    const frames: TerminalServerFrame[] = [];
    const viewer = await attach(harness.actor, frames);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    const ending = harness.actor.end(3);
    await vi.waitFor(() =>
      expect(frames.some((frame) =>
        frame.type === "lifecycle_state" && frame.lifecycle === "stopping"
      )).toBe(true),
    );
    expect(frames.some((frame) =>
      frame.type === "control_changed" && frame.role === "observer"
    )).toBe(true);
    const stoppedFrames: TerminalServerFrame[] = [];
    const stoppedViewer = await harness.actor.attach({
      attachmentId: "55555555-5555-4555-8555-555555555555",
      producerId: "66666666-6666-4666-8666-666666666666",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
      emit: (frame) => stoppedFrames.push(frame),
    });
    expect(stoppedFrames.find((frame) => frame.type === "attached")).toMatchObject({
      type: "attached",
      role: "observer",
      lifecycle: "stopping",
    });
    const base = {
      v: TERMINAL_PROTOCOL_VERSION,
      terminalId: terminalResource().terminalId,
      incarnationId: terminalResource().incarnationId!,
    } as const;
    await stoppedViewer.dispatch({ ...base, type: "claim_control" });
    await stoppedViewer.dispatch({
      ...base,
      type: "resize",
      controllerEpoch: 1,
      rows: 30,
      columns: 100,
    });
    await stoppedViewer.dispatch({
      ...base,
      type: "input",
      controllerEpoch: 1,
      producerId: "66666666-6666-4666-8666-666666666666",
      inputSeq: 1,
      data: Buffer.from("blocked").toString("base64url"),
    });
    expect(stoppedFrames.filter((frame) => frame.type === "error")).toHaveLength(2);
    expect(stoppedFrames.find((frame) => frame.type === "input_result")).toMatchObject({
      type: "input_result",
      outcome: "rejected",
    });
    expect(harness.process.writeCalls).toBe(0);
    expect(harness.process.resizeCalls).toBe(0);
    harness.process.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await ending;
    await harness.actor.discardAfterEnd();
    expect(frames.at(-1)).toMatchObject({
      type: "terminal_removed",
    });
    viewer.close();
    stoppedViewer.close();
  });

  it("evicts a live viewer whose unacknowledged queue exceeds its byte cap", async () => {
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockResolvedValue({ erasedScrollback: false });
    const harness = createHarness();
    const frames: TerminalServerFrame[] = [];
    await attach(harness.actor, frames);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "caught_up")).toBe(true),
    );

    for (let index = 1; index <= 24; index += 1) {
      harness.process.output(new Uint8Array(128 * 1024));
      await vi.waitFor(() =>
        expect(harness.resource().headSeq).toBeGreaterThanOrEqual(index),
      );
      if (frames.some((frame) => frame.type === "error")) break;
    }

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      code: "viewer_too_slow",
      retryable: true,
    });
    expect(frames.some((frame) => frame.type === "resync_required")).toBe(
      true,
    );
    const frameCount = frames.length;
    harness.process.output(Uint8Array.from([120]));
    await vi.waitFor(() =>
      expect(harness.resource().headSeq).toBeGreaterThan(16),
    );
    expect(frames).toHaveLength(frameCount);
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
  });

  it("detaches a viewer that fails to acknowledge the paced output window", async () => {
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockResolvedValue({ erasedScrollback: false });
    const harness = createHarness();
    const frames: TerminalServerFrame[] = [];
    await attach(harness.actor, frames);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    vi.useFakeTimers();

    for (let index = 0; index < 65; index += 1) {
      harness.process.output(Uint8Array.from([index]));
    }
    await flushMicrotasks(800);
    expect(frames.filter((frame) => frame.type === "output")).toHaveLength(64);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(frames.some((frame) => frame.type === "resync_required")).toBe(
      true,
    );
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
  });

  it("requires acknowledgements to stay at or below the last sent sequence", async () => {
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockResolvedValue({ erasedScrollback: false });
    const harness = createHarness();
    const frames: TerminalServerFrame[] = [];
    const session = await attach(harness.actor, frames);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    harness.process.output(Uint8Array.from([120]));
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.type === "output")).toHaveLength(1),
    );

    await session.dispatch({
      v: 2,
      type: "ack_output",
      terminalId: harness.resource().terminalId,
      incarnationId: harness.resource().incarnationId!,
      appliedSeq: 2,
    });
    expect(frames.some((frame) => frame.type === "resync_required")).toBe(
      true,
    );
    const frameCount = frames.length;
    harness.process.output(Uint8Array.from([121]));
    await vi.waitFor(() => expect(harness.resource().headSeq).toBe(2));
    expect(frames).toHaveLength(frameCount);
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
  });

  it("periodically checkpoints long output before the lifetime journal quota", async () => {
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockResolvedValue({
      erasedScrollback: false,
    });
    vi.spyOn(TerminalHeadlessEmulator.prototype, "checkpoint").mockReturnValue(
      Buffer.from("bounded terminal state"),
    );
    const harness = createHarness();
    for (let index = 1; index <= 4; index += 1) {
      harness.process.output(new Uint8Array(1024 * 1024));
      await vi.waitFor(() => expect(harness.resource().headSeq).toBe(index));
    }
    expect(harness.resource().historyFloorSeq).toBe(4);
    expect(harness.journal.read(harness.scope, harness.resource().terminalId)).toMatchObject({
      checkpoint: {
        seq: 4,
        bytes: Uint8Array.from(Buffer.from("bounded terminal state")),
      },
      records: [],
      headSeq: 4,
    });
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
  });

  it("replays one record larger than the byte window when no output is outstanding", async () => {
    vi.spyOn(TerminalHeadlessEmulator.prototype, "write").mockResolvedValue({
      erasedScrollback: false,
    });
    const harness = createHarness();
    harness.process.output(new Uint8Array(300 * 1024));
    await vi.waitFor(() => expect(harness.resource().headSeq).toBe(1));
    const frames: TerminalServerFrame[] = [];
    await attach(harness.actor, frames);
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.type === "output")).toHaveLength(1),
    );
    expect(frames.find((frame) => frame.type === "output")).toMatchObject({
      type: "output",
      seq: 1,
    });
    harness.process.exit({ disposition: "exited", exitCode: 0, signal: null });
  });
});

async function attach(actor: TerminalActor, frames: TerminalServerFrame[]) {
  return actor.attach({
    attachmentId: "33333333-3333-4333-8333-333333333333",
    producerId: "44444444-4444-4444-8444-444444444444",
    requestedRole: "controller",
    restore: { kind: "checkpoint" },
    emit: (frame) => frames.push(frame),
  });
}

function createHarness() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "sedes-terminal-actor-pressure-"),
  );
  directories.push(directory);
  const process = new FakeProcess();
  let resource = terminalResource();
  const finalized = vi.fn();
  const repository = {
    updateHead(_scope: unknown, _id: string, headSeq: number) {
      resource = { ...resource, headSeq };
      return resource;
    },
    advanceHistoryFloor(
      _scope: unknown,
      _id: string,
      historyFloorSeq: number,
    ) {
      resource = { ...resource, historyFloorSeq };
      return resource;
    },
    resize(
      _scope: unknown,
      _id: string,
      rows: number,
      columns: number,
      headSeq: number,
    ) {
      resource = { ...resource, rows, columns, headSeq };
      return resource;
    },
    markStopping() {
      resource = {
        ...resource,
        lifecycle: "stopping",
        lifecycleRevision: resource.lifecycleRevision + 1,
      };
      return resource;
    },
    finalize(
      _scope: unknown,
      _id: string,
      input: {
        lifecycle: TerminalResource["lifecycle"];
        headSeq: number;
        exitCode: number | null;
        exitSignal: string | null;
        publicReason: string | null;
      },
    ) {
      resource = {
        ...resource,
        lifecycle: input.lifecycle,
        lifecycleRevision: resource.lifecycleRevision + 1,
        headSeq: input.headSeq,
        exitCode: input.exitCode,
        exitSignal: input.exitSignal,
        publicReason: input.publicReason,
      };
      return resource;
    },
  } as unknown as TerminalRepository;
  const scope = { tenantId: "tenant", principalId: "principal" };
  const journal = new TerminalJournalStore({ stateDirectory: directory });
  const actor = new TerminalActor({
    scope,
    terminal: resource,
    repository,
    journal,
    process,
    onTerminalSummaryChanged: () => undefined,
    onFinalized: finalized,
  });
  return { actor, process, finalized, repository, resource: () => resource, journal, scope };
}

class FakeProcess implements InteractiveTerminalProcess {
  readonly terminations: Array<"hangup" | "terminate" | "kill"> = [];
  pauseCalls = 0;
  resumeCalls = 0;
  writeCalls = 0;
  resizeCalls = 0;
  readonly #output = new Set<(bytes: Uint8Array) => void>();
  readonly #exit = new Set<(exit: InteractiveTerminalExit) => void>();

  pauseOutput() {
    this.pauseCalls += 1;
  }

  resumeOutput() {
    this.resumeCalls += 1;
  }

  async write() {
    this.writeCalls += 1;
    return { outcome: "sent" as const };
  }

  async resize() { this.resizeCalls += 1; }

  async terminate(signal: "hangup" | "terminate" | "kill") {
    this.terminations.push(signal);
  }

  onOutput(listener: (bytes: Uint8Array) => void) {
    this.#output.add(listener);
    return () => this.#output.delete(listener);
  }

  onExit(listener: (exit: InteractiveTerminalExit) => void) {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }

  output(bytes: Uint8Array) {
    for (const listener of this.#output) listener(bytes);
  }

  exit(exit: InteractiveTerminalExit) {
    for (const listener of this.#exit) listener(exit);
  }
}

function terminalResource(): TerminalResource {
  return {
    terminalId: "11111111-1111-4111-8111-111111111111",
    threadId: "66666666-6666-4666-8666-666666666666",
    workspaceId: "77777777-7777-4777-8777-777777777777",
    environmentId: "88888888-8888-4888-8888-888888888888",
    environmentLabel: "Local",
    terminationEffect: "end_process",
    incarnationId: "22222222-2222-4222-8222-222222222222",
    displayName: "Shell",
    shellProfile: null,
    initialCwd: "/work",
    lifecycle: "running",
    lifecycleRevision: 3,
    rows: 24,
    columns: 80,
    initialRows: 24,
    initialColumns: 80,
    historyFloorSeq: 0,
    headSeq: 0,
    exitCode: null,
    exitSignal: null,
    publicReason: null,
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(1).toISOString(),
    exitedAt: null,
    updatedAt: new Date(1).toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
