import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalResource, TerminalServerFrame } from "../../src/shared/protocol/terminals.js";
import type {
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
} from "../../src/server/execution/interactive-terminal.js";
import { TerminalActor } from "../../src/server/terminals/terminal-actor.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import type { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("TerminalActor", () => {
  it("keeps the process alive across detach, replays output, and deduplicates input", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-actor-"));
    directories.push(directory);
    const process = new FakeProcess();
    let resource = terminalResource();
    const repository = {
      updateHead(_scope: unknown, _id: string, headSeq: number) {
        resource = { ...resource, headSeq };
      },
      advanceHistoryFloor(
        _scope: unknown,
        _id: string,
        historyFloorSeq: number,
      ) {
        resource = { ...resource, historyFloorSeq };
        return resource;
      },
      resize(_scope: unknown, _id: string, rows: number, columns: number, headSeq: number) {
        resource = { ...resource, rows, columns, headSeq };
        return resource;
      },
      markStopping() {
        resource = { ...resource, lifecycle: "stopping", lifecycleRevision: resource.lifecycleRevision + 1 };
        return resource;
      },
      finalize(_scope: unknown, _id: string, input: { lifecycle: TerminalResource["lifecycle"]; headSeq: number; publicReason?: string | null }) {
        resource = { ...resource, lifecycle: input.lifecycle, headSeq: input.headSeq,
          publicReason: input.publicReason ?? null,
          lifecycleRevision: resource.lifecycleRevision + 1 };
        return resource;
      },
    } as unknown as TerminalRepository;
    const actor = new TerminalActor({
      scope: { tenantId: "tenant", principalId: "principal" },
      terminal: resource,
      repository,
      journal: new TerminalJournalStore({ stateDirectory: directory }),
      process,
      onTerminalSummaryChanged: () => undefined,
      onFinalized: () => undefined,
    });
    const failedRead = vi
      .spyOn(TerminalJournalStore.prototype, "read")
      .mockImplementationOnce(() => {
        throw new Error("terminal_journal_corrupt");
      });
    await expect(actor.attach({
      attachmentId: "12121212-1212-4212-8212-121212121212",
      producerId: "13131313-1313-4313-8313-131313131313",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
      emit: () => undefined,
    })).rejects.toThrow("terminal_journal_corrupt");
    failedRead.mockRestore();
    const firstFrames: TerminalServerFrame[] = [];
    const session = await actor.attach({
      attachmentId: "33333333-3333-4333-8333-333333333333",
      producerId: "44444444-4444-4444-8444-444444444444",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
      emit: (frame) => firstFrames.push(frame),
    });
    await session.dispatch({
      v: 2,
      type: "ack_output",
      terminalId: resource.terminalId,
      incarnationId: "99999999-9999-4999-8999-999999999999",
      appliedSeq: 0,
    });
    expect(firstFrames.at(-1)).toMatchObject({
      type: "error",
      code: "stale_incarnation",
      retryable: true,
    });
    process.output(Buffer.from("hello"));
    await vi.waitFor(() =>
      expect(firstFrames.some((frame) => frame.type === "output")).toBe(true),
    );
    const inputHeader = {
      v: 2 as const,
      type: "input" as const,
      terminalId: resource.terminalId,
      incarnationId: resource.incarnationId!,
      controllerEpoch: 1,
      producerId: "44444444-4444-4444-8444-444444444444",
      inputSeq: 1,
      data: Buffer.from("x").toString("base64url"),
    };
    await session.dispatch(inputHeader);
    await session.dispatch(inputHeader);
    expect(process.writes).toEqual([Uint8Array.from([120])]);
    expect(
      firstFrames.filter(
        (frame) => frame.type === "input_result" && frame.outcome === "duplicate",
      ),
    ).toHaveLength(1);
    session.close();
    process.output(Buffer.from(" detached"));
    for (let index = 0; index < 70; index += 1) process.output(Buffer.from("x"));
    await actor.ready();
    expect(resource.headSeq).toBe(72);
    const replay: TerminalServerFrame[] = [];
    const replaySession = await actor.attach({
      attachmentId: "55555555-5555-4555-8555-555555555555",
      producerId: "44444444-4444-4444-8444-444444444444",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
      emit: (frame) => replay.push(frame),
    });
    await vi.waitFor(() =>
      expect(replay.filter((frame) => frame.type === "output")).toHaveLength(64),
    );
    expect(replay.some((frame) => frame.type === "caught_up")).toBe(false);
    await replaySession.dispatch({
      v: 2,
      type: "ack_output",
      terminalId: resource.terminalId,
      incarnationId: resource.incarnationId!,
      appliedSeq: 64,
    });
    await vi.waitFor(() =>
      expect(replay.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    expect(
      replay
        .filter((frame) => frame.type === "output")
        .map((frame) =>
          frame.type === "output"
            ? Buffer.from(frame.data, "base64url").toString("utf8")
            : "",
        )
        .join(""),
    ).toBe(`hello detached${"x".repeat(70)}`);
    expect(replay.find((frame) => frame.type === "attached")).toMatchObject({
      role: "controller",
      controllerEpoch: 1,
      lastAcceptedInputSeq: 1,
    });
    process.output(Buffer.from("\x1b[H\x1b[2J\x1b[3Jafter-clear"));
    await vi.waitFor(() => expect(resource.historyFloorSeq).toBe(73));
    const compacted = new TerminalJournalStore({ stateDirectory: directory }).read(
      { tenantId: "tenant", principalId: "principal" },
      resource.terminalId,
    );
    expect(compacted.records).toEqual([]);
    const checkpointText = Buffer.from(compacted.checkpoint.bytes).toString("utf8");
    expect(checkpointText).toContain("after-clear");
    expect(checkpointText).not.toContain("hello detached");

    replaySession.close();
    const restored: TerminalServerFrame[] = [];
    const restoredSession = await actor.attach({
      attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      producerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requestedRole: "observer",
      restore: { kind: "resume", appliedSeq: 72 },
      emit: (frame) => restored.push(frame),
    });
    await vi.waitFor(() =>
      expect(restored.some((frame) => frame.type === "snapshot_chunk")).toBe(true),
    );
    await restoredSession.dispatch({
      v: 2,
      type: "ack_snapshot",
      terminalId: resource.terminalId,
      incarnationId: resource.incarnationId!,
      checkpointSeq: 73,
      chunkIndex: 0,
    });
    await vi.waitFor(() =>
      expect(restored.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    expect(restored.filter((frame) => frame.type === "output")).toEqual([]);
    expect(restored.find((frame) => frame.type === "snapshot_begin")).toMatchObject({
      checkpointSeq: 73,
      format: "ansi-checkpoint-v1",
    });
    expect(restored.find((frame) => frame.type === "attached")).toMatchObject({
      restoreKind: "checkpoint",
      historyFloorSeq: 73,
    });
    vi.spyOn(TerminalJournalStore.prototype, "append").mockImplementationOnce(() => {
      throw new Error("terminal_journal_quota_exceeded");
    });
    process.exit({ disposition: "exited", exitCode: 0, signal: null });
    await vi.waitFor(() =>
      expect(restored.find((frame) => frame.type === "lifecycle_state")).toMatchObject({
        lifecycle: "failed",
        headSeq: 73,
        publicReason: "history_write_failed",
      }),
    );
  });

  it("stops the process when a resize cannot be journaled", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-actor-"));
    directories.push(directory);
    const process = new FakeProcess();
    let resource = terminalResource();
    const repository = {
      resize(_scope: unknown, _id: string, rows: number, columns: number, headSeq: number) {
        resource = { ...resource, rows, columns, headSeq };
        return resource;
      },
      finalize(_scope: unknown, _id: string, input: { lifecycle: TerminalResource["lifecycle"]; headSeq: number; publicReason?: string | null }) {
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
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const actor = new TerminalActor({
      scope: { tenantId: "tenant", principalId: "principal" },
      terminal: resource,
      repository,
      journal,
      process,
      onTerminalSummaryChanged: () => undefined,
      onFinalized: () => undefined,
    });
    const frames: TerminalServerFrame[] = [];
    const session = await actor.attach({
      attachmentId: "33333333-3333-4333-8333-333333333333",
      producerId: "44444444-4444-4444-8444-444444444444",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
      emit: (frame) => frames.push(frame),
    });
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "caught_up")).toBe(true),
    );
    vi.spyOn(journal, "append").mockImplementationOnce(() => {
      throw new Error("terminal_journal_quota_exceeded");
    });

    await session.dispatch({
      v: 2,
      type: "resize",
      terminalId: resource.terminalId,
      incarnationId: resource.incarnationId!,
      controllerEpoch: 1,
      rows: 40,
      columns: 120,
    });

    await vi.waitFor(() => expect(process.terminations).toEqual(["kill"]));
    await vi.waitFor(() =>
      expect(resource).toMatchObject({
        lifecycle: "failed",
        rows: 24,
        columns: 80,
        publicReason: "history_write_failed",
      }),
    );
    expect(
      frames.some((frame) => frame.type === "resize_committed"),
    ).toBe(false);
  });
});

class FakeProcess implements InteractiveTerminalProcess {
  readonly writes: Uint8Array[] = [];
  readonly terminations: string[] = [];
  readonly #output = new Set<(bytes: Uint8Array) => void>();
  readonly #exit = new Set<(exit: InteractiveTerminalExit) => void>();
  pauseOutput() {}
  resumeOutput() {}
  async write(bytes: Uint8Array) {
    this.writes.push(Uint8Array.from(bytes));
    return { outcome: "sent" as const };
  }
  async resize() {}
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
