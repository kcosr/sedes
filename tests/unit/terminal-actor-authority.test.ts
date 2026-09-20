import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalClientFrame,
  TerminalResource,
  TerminalServerFrame,
} from "../../src/shared/protocol/terminals.js";
import type {
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
} from "../../src/server/execution/interactive-terminal.js";
import { TerminalActor } from "../../src/server/terminals/terminal-actor.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import type { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TerminalActor controller authority", () => {
  it("rejects the old socket's input and resize after explicit takeover", async () => {
    const fixture = createFixture();
    const first = await fixture.attach(1, 1, "controller");
    const second = await fixture.attach(2, 2, "observer");

    await second.session.dispatch(frame(fixture, { type: "claim_control" }));
    expect(lastControl(first.frames)).toMatchObject({
      role: "observer",
      controllerEpoch: 2,
    });
    expect(lastControl(second.frames)).toMatchObject({
      role: "controller",
      controllerEpoch: 2,
    });

    await first.session.dispatch(
      inputFrame(fixture, 1, 1, 1, Buffer.from("stale")),
    );
    await first.session.dispatch(
      frame(fixture, {
        type: "resize",
        controllerEpoch: 1,
        rows: 40,
        columns: 120,
      }),
    );
    expect(fixture.process.writes).toEqual([]);
    expect(fixture.process.resizes).toEqual([]);
    expect(first.frames).toContainEqual(
      expect.objectContaining({
        type: "input_result",
        inputSeq: 1,
        outcome: "rejected",
        message: "stale_controller",
      }),
    );
    expect(first.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "stale_controller" }),
    );

    await second.session.dispatch(
      inputFrame(fixture, 2, 2, 1, Buffer.from("current")),
    );
    await second.session.dispatch(
      frame(fixture, {
        type: "resize",
        controllerEpoch: 2,
        rows: 41,
        columns: 121,
      }),
    );
    expect(fixture.process.writes).toEqual([
      Uint8Array.from(Buffer.from("current")),
    ]);
    expect(fixture.process.resizes).toEqual([{ rows: 41, columns: 121 }]);
  });

  it("rejects input gaps and observer resize without mutating the PTY", async () => {
    const fixture = createFixture();
    const controller = await fixture.attach(1, 1, "controller");
    const observer = await fixture.attach(2, 2, "observer");

    await controller.session.dispatch(
      inputFrame(fixture, 1, 1, 2, Buffer.from("gap")),
    );
    await observer.session.dispatch(
      frame(fixture, {
        type: "resize",
        controllerEpoch: 1,
        rows: 30,
        columns: 100,
      }),
    );

    expect(fixture.process.writes).toEqual([]);
    expect(fixture.process.resizes).toEqual([]);
    expect(controller.frames).toContainEqual(
      expect.objectContaining({
        type: "input_result",
        inputSeq: 2,
        outcome: "rejected",
        lastAcceptedInputSeq: 0,
        message: "input_gap",
      }),
    );
    expect(observer.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "stale_controller" }),
    );
  });

  it("serializes pipelined input and rejects a conflicting duplicate payload", async () => {
    const fixture = createFixture();
    const controller = await fixture.attach(1, 1, "controller");

    await Promise.all([
      controller.session.dispatch(inputFrame(fixture, 1, 1, 1, Buffer.from("a"))),
      controller.session.dispatch(inputFrame(fixture, 1, 1, 2, Buffer.from("b"))),
      controller.session.dispatch(inputFrame(fixture, 1, 1, 3, Buffer.from("c"))),
    ]);
    expect(fixture.process.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual([
      "a", "b", "c",
    ]);
    expect(
      controller.frames.filter(
        (serverFrame) =>
          serverFrame.type === "input_result" && serverFrame.outcome === "accepted",
      ),
    ).toHaveLength(3);

    await controller.session.dispatch(
      inputFrame(fixture, 1, 1, 2, Buffer.from("different")),
    );
    expect(fixture.process.writes).toHaveLength(3);
    expect(controller.frames).toContainEqual(
      expect.objectContaining({
        type: "input_result",
        inputSeq: 2,
        outcome: "rejected",
        lastAcceptedInputSeq: 3,
        message: "input_sequence_conflict",
      }),
    );
  });

  it("increments authority on release and claim, while same-producer grace reclaim preserves it", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const first = await fixture.attach(1, 1, "controller");
    await first.session.dispatch(
      inputFrame(fixture, 1, 1, 1, Buffer.from("accepted")),
    );
    first.session.close();

    const reclaimed = await fixture.attach(2, 1, "controller");
    expect(attached(reclaimed.frames)).toMatchObject({
      role: "controller",
      controllerEpoch: 1,
      lastAcceptedInputSeq: 1,
    });

    await reclaimed.session.dispatch(frame(fixture, { type: "release_control" }));
    expect(lastControl(reclaimed.frames)).toMatchObject({
      role: "observer",
      controllerEpoch: 2,
    });
    const other = await fixture.attach(3, 3, "observer");
    await other.session.dispatch(frame(fixture, { type: "claim_control" }));
    expect(lastControl(other.frames)).toMatchObject({
      role: "controller",
      controllerEpoch: 3,
    });
  });

  it("holds disconnected control for its producer until grace expires", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const first = await fixture.attach(1, 1, "controller");
    first.session.close();

    const duringGrace = await fixture.attach(2, 2, "controller");
    expect(attached(duringGrace.frames)).toMatchObject({
      role: "observer",
      controllerEpoch: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const afterGrace = await fixture.attach(3, 3, "controller");
    expect(attached(afterGrace.frames)).toMatchObject({
      role: "controller",
      controllerEpoch: 3,
    });
  });

  it("caps producer dedupe identities for one incarnation", async () => {
    const fixture = createFixture();
    for (let index = 1; index <= 64; index += 1) {
      const viewer = await fixture.attach(index, index, "observer");
      await viewer.session.dispatch(frame(fixture, { type: "claim_control" }));
      const epoch = lastControl(viewer.frames).controllerEpoch;
      await viewer.session.dispatch(
        inputFrame(fixture, index, epoch, 1, Uint8Array.of(index)),
      );
      expect(viewer.frames).toContainEqual(
        expect.objectContaining({
          type: "input_result",
          inputSeq: 1,
          outcome: "accepted",
        }),
      );
      viewer.session.close();
    }
    const overflow = await fixture.attach(65, 65, "observer");
    await overflow.session.dispatch(frame(fixture, { type: "claim_control" }));
    const epoch = lastControl(overflow.frames).controllerEpoch;
    await overflow.session.dispatch(
      inputFrame(fixture, 65, epoch, 1, Uint8Array.of(65)),
    );
    expect(overflow.frames).toContainEqual(
      expect.objectContaining({
        type: "input_result",
        inputSeq: 1,
        outcome: "rejected",
        message: "producer_limit_reached",
      }),
    );
    expect(fixture.process.writes).toHaveLength(64);
  });
});

describe("TerminalActor canonical resize", () => {
  it("applies, journals, persists, and broadcasts one ordered resize", async () => {
    const fixture = createFixture();
    const controller = await fixture.attach(1, 1, "controller");
    const observer = await fixture.attach(2, 2, "observer");

    await controller.session.dispatch(
      frame(fixture, {
        type: "resize",
        controllerEpoch: 1,
        rows: 55,
        columns: 144,
      }),
    );

    expect(fixture.process.resizes).toEqual([{ rows: 55, columns: 144 }]);
    expect(fixture.resizeCalls).toEqual([
      { rows: 55, columns: 144, headSeq: 1 },
    ]);
    expect(fixture.journal.read(fixture.scope, fixture.resource.terminalId).records).toEqual([
      { seq: 1, kind: "resize", rows: 55, columns: 144 },
    ]);
    await vi.waitFor(() => {
      expect(controller.frames).toContainEqual(
        expect.objectContaining({
          type: "resize_committed",
          seq: 1,
          rows: 55,
          columns: 144,
        }),
      );
      expect(observer.frames).toContainEqual(
        expect.objectContaining({
          type: "resize_committed",
          seq: 1,
          rows: 55,
          columns: 144,
        }),
      );
    });
    expect(fixture.actor.terminal).toMatchObject({
      rows: 55,
      columns: 144,
      headSeq: 1,
    });
  });

  it("ignores a late controller resize after the terminal exits", async () => {
    const fixture = createFixture();
    const controller = await fixture.attach(1, 1, "controller");

    fixture.process.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await vi.waitFor(() => {
      expect(fixture.actor.terminal.lifecycle).toBe("exited");
    });

    await controller.session.dispatch(
      frame(fixture, {
        type: "resize",
        controllerEpoch: 1,
        rows: 40,
        columns: 120,
      }),
    );

    expect(fixture.process.resizes).toEqual([]);
    expect(fixture.resizeCalls).toEqual([]);
    expect(controller.frames).not.toContainEqual(
      expect.objectContaining({ type: "error", code: "stale_controller" }),
    );
  });
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const stateDirectory = mkdtempSync(
    path.join(os.tmpdir(), "sedes-terminal-authority-"),
  );
  directories.push(stateDirectory);
  const scope = { tenantId: "tenant", principalId: "principal" };
  let resource = terminalResource();
  const resizeCalls: Array<{
    rows: number;
    columns: number;
    headSeq: number;
  }> = [];
  const repository = {
    updateHead(_scope: unknown, _id: string, headSeq: number) {
      resource = { ...resource, headSeq };
    },
    resize(
      _scope: unknown,
      _id: string,
      rows: number,
      columns: number,
      headSeq: number,
    ) {
      resizeCalls.push({ rows, columns, headSeq });
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
        publicReason?: string | null;
      },
    ) {
      resource = {
        ...resource,
        lifecycle: input.lifecycle,
        headSeq: input.headSeq,
        publicReason: input.publicReason ?? null,
        lifecycleRevision: resource.lifecycleRevision + 1,
      };
      return resource;
    },
  } as unknown as TerminalRepository;
  const process = new FakeProcess();
  const journal = new TerminalJournalStore({ stateDirectory });
  const actor = new TerminalActor({
    scope,
    terminal: resource,
    repository,
    journal,
    process,
    onTerminalSummaryChanged: () => undefined,
    onFinalized: () => undefined,
  });
  let attachment = 0;
  return {
    scope,
    get resource() {
      return resource;
    },
    actor,
    process,
    journal,
    resizeCalls,
    async attach(
      attachmentNumber: number,
      producerNumber: number,
      requestedRole: "controller" | "observer",
    ) {
      attachment += 1;
      const frames: TerminalServerFrame[] = [];
      const session = await actor.attach({
        attachmentId: uuid(attachmentNumber),
        producerId: uuid(producerNumber + 1_000),
        requestedRole,
        restore: { kind: "checkpoint" },
        emit: (serverFrame) => frames.push(serverFrame),
      });
      await vi.waitFor(() =>
        expect(frames.some((serverFrame) => serverFrame.type === "caught_up")).toBe(
          true,
        ),
      );
      return { frames, session };
    },
  };
}

class FakeProcess implements InteractiveTerminalProcess {
  readonly writes: Uint8Array[] = [];
  readonly resizes: Array<{ rows: number; columns: number }> = [];
  readonly #output = new Set<(bytes: Uint8Array) => void>();
  readonly #exit = new Set<(exit: InteractiveTerminalExit) => void>();

  pauseOutput(): void {}
  resumeOutput(): void {}

  async write(bytes: Uint8Array) {
    this.writes.push(Uint8Array.from(bytes));
    return { outcome: "sent" as const };
  }

  async resize(input: { rows: number; columns: number }) {
    this.resizes.push(input);
  }

  async terminate() {}

  onOutput(listener: (bytes: Uint8Array) => void) {
    this.#output.add(listener);
    return () => this.#output.delete(listener);
  }

  onExit(listener: (exit: InteractiveTerminalExit) => void) {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }

  exit(exit: InteractiveTerminalExit) {
    for (const listener of this.#exit) listener(exit);
  }
}

function frame<T extends Omit<TerminalClientFrame, "v" | "terminalId" | "incarnationId">>(
  fixture: Fixture,
  value: T,
): TerminalClientFrame {
  return {
    v: 2,
    terminalId: fixture.resource.terminalId,
    incarnationId: fixture.resource.incarnationId!,
    ...value,
  } as TerminalClientFrame;
}

function inputFrame(
  fixture: Fixture,
  producerNumber: number,
  controllerEpoch: number,
  inputSeq: number,
  bytes: Uint8Array,
): TerminalClientFrame {
  return frame(fixture, {
    type: "input",
    controllerEpoch,
    producerId: uuid(producerNumber + 1_000),
    inputSeq,
    data: Buffer.from(bytes).toString("base64url"),
  });
}

function attached(frames: readonly TerminalServerFrame[]) {
  const result = frames.find((serverFrame) => serverFrame.type === "attached");
  if (!result || result.type !== "attached") throw new Error("attached frame missing");
  return result;
}

function lastControl(frames: readonly TerminalServerFrame[]) {
  const result = frames.findLast(
    (serverFrame) => serverFrame.type === "control_changed",
  );
  if (!result || result.type !== "control_changed") {
    throw new Error("control_changed frame missing");
  }
  return result;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function terminalResource(): TerminalResource {
  return {
    terminalId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    environmentId: "44444444-4444-4444-8444-444444444444",
    environmentLabel: "Local",
    terminationEffect: "end_process",
    incarnationId: "55555555-5555-4555-8555-555555555555",
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
