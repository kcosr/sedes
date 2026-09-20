// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  encodeTerminalBinaryFrame,
  type TerminalResource,
} from "../../shared/index.js";
import {
  MAX_QUEUED_INPUT_ENTRIES,
  TERMINAL_CLIENT_CLOSE_CODES,
  TerminalSession,
  type TerminalEmulatorSink,
} from "./terminal-session.js";

const TERMINAL_ID = "11111111-1111-4111-8111-111111111111";
const INCARNATION_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCER_ID = "44444444-4444-4444-8444-444444444444";

describe("TerminalSession", () => {
  it("uses only close codes accepted by the browser WebSocket API", () => {
    for (const code of Object.values(TERMINAL_CLIENT_CLOSE_CODES)) {
      expect(code).toBeGreaterThanOrEqual(3_000);
      expect(code).toBeLessThanOrEqual(4_999);
      expect(() => new FakeSocket().close(code, "client_restart")).not.toThrow();
    }
    expect(() => new FakeSocket().close(1012, "invalid_browser_code")).toThrow(
      DOMException,
    );
  });

  it("assembles and verifies a paced ANSI checkpoint before replacing the renderer", async () => {
    const sink: TerminalEmulatorSink = {
      reset: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const fixture = createFixture(sink);
    fixture.session.connect();
    await settle();
    fixture.socket.open();
    fixture.socket.frame(attached());
    const checkpoint = Buffer.from("checkpoint state");
    fixture.socket.frame(frame({
      type: "snapshot_begin",
      checkpointSeq: 7,
      rows: 24,
      columns: 80,
      format: "ansi-checkpoint-v1",
      byteLength: checkpoint.byteLength,
      chunkCount: 1,
    }));
    fixture.socket.frame(frame({
      type: "snapshot_chunk",
      checkpointSeq: 7,
      chunkIndex: 0,
      data: checkpoint.toString("base64url"),
    }));
    expect(JSON.parse(fixture.socket.sent.at(-1) as string)).toMatchObject({
      type: "ack_snapshot",
      checkpointSeq: 7,
      chunkIndex: 0,
    });
    expect(sink.reset).not.toHaveBeenCalled();
    fixture.socket.frame(frame({
      type: "snapshot_end",
      checkpointSeq: 7,
      sha256: "e19f0f0d3b3401236908cf6734ec6c7f8a358797a3a9c4409d7afde27eacd60c",
    }));
    fixture.socket.frame(frame({ type: "caught_up", headSeq: 7 }));
    await settle();
    expect(sink.reset).toHaveBeenCalledOnce();
    expect(sink.write).toHaveBeenCalledWith(Uint8Array.from(checkpoint));
    expect(fixture.session.snapshot).toMatchObject({
      connection: "ready",
      appliedSeq: 7,
    });
  });

  it("accepts a server-selected checkpoint when the requested resume falls behind the floor", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const sink: TerminalEmulatorSink = {
        reset: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      const session = new TerminalSession({
        api: terminalApi(),
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink,
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await vi.runAllTicks();
      await Promise.resolve();
      const first = sockets[0]!;
      first.open();
      first.frame(attached());
      first.frame(frame({ type: "snapshot_begin", checkpointSeq: 0,
        rows: 24, columns: 80, format: "ansi-checkpoint-v1",
        byteLength: 0, chunkCount: 0 }));
      first.frame(frame({ type: "snapshot_end", checkpointSeq: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
      first.output(frame({ type: "output", seq: 1 }), Buffer.from("old"));
      first.frame(frame({ type: "caught_up", headSeq: 1 }));
      await settle();
      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);

      const second = sockets[1]!;
      const checkpoint = Buffer.from("new floor");
      second.open();
      second.frame(attached({
        restoreKind: "checkpoint",
        historyFloorSeq: 2,
        headSeq: 2,
      }));
      second.frame(frame({ type: "snapshot_begin", checkpointSeq: 2,
        rows: 24, columns: 80, format: "ansi-checkpoint-v1",
        byteLength: checkpoint.byteLength, chunkCount: 1 }));
      second.frame(frame({ type: "snapshot_chunk", checkpointSeq: 2,
        chunkIndex: 0, data: checkpoint.toString("base64url") }));
      second.frame(frame({ type: "snapshot_end", checkpointSeq: 2,
        sha256: "65da4e823fa7a6c123153d9756208f74e15038c26e8a1e2a4170228356ff05d7" }));
      second.frame(frame({ type: "caught_up", headSeq: 2 }));
      await settle();
      expect(session.snapshot).toMatchObject({
        connection: "ready",
        appliedSeq: 2,
      });
      expect(sink.reset).toHaveBeenCalledTimes(2);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores in order, acknowledges only after the renderer applies output, then enables input", async () => {
    let resolveWrite!: () => void;
    const sink: TerminalEmulatorSink = {
      reset: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; })),
    };
    const fixture = createFixture(sink);
    fixture.session.connect();
    await settle();

    expect(fixture.api.createTerminalAdmission).toHaveBeenCalledWith(
      TERMINAL_ID,
      expect.objectContaining({
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        emulator: {
          family: "ghostty-web",
          version: "0.4.0",
          unicodeVersion: "11",
          restoreFormat: "ansi-checkpoint-v1",
        },
        restore: { kind: "checkpoint" },
      }),
    );
    fixture.socket.open();
    fixture.socket.frame(attached());
    fixture.socket.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
    fixture.socket.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
    fixture.socket.output(frame({ type: "output", seq: 1 }), new TextEncoder().encode("hi"));
    fixture.socket.frame(frame({ type: "caught_up", headSeq: 1 }));
    await settle();

    expect(sink.reset).toHaveBeenCalledOnce();
    expect(Array.from(vi.mocked(sink.write).mock.calls[0]![0])).toEqual([104, 105]);
    expect(fixture.socket.sent).toEqual([]);
    expect(fixture.session.snapshot.inputAvailable).toBe(false);

    resolveWrite();
    await settle();
    expect(parseSent(fixture.socket)).toContainEqual(expect.objectContaining({ type: "ack_output", appliedSeq: 1 }));
    expect(fixture.session.snapshot).toMatchObject({ connection: "ready", caughtUp: true, role: "controller", inputAvailable: true });
    expect(fixture.session.sendInput("pwd\r")).toBe(true);
    expect(parseSent(fixture.socket)).toContainEqual(expect.objectContaining({ type: "input", inputSeq: 1, producerId: PRODUCER_ID }));
  });

  it("coalesces replay acknowledgements without publishing every applied sequence", async () => {
    const sink: TerminalEmulatorSink = {
      reset: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const fixture = createFixture(sink);
    fixture.session.connect();
    await settle();
    fixture.socket.open();
    fixture.socket.frame(attached());
    fixture.socket.frame(frame({
      type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80,
      format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0,
    }));
    fixture.socket.frame(frame({
      type: "snapshot_end", checkpointSeq: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }));
    await settle();
    const listener = vi.fn();
    fixture.session.subscribe(listener);
    listener.mockClear();

    fixture.socket.output(frame({ type: "output", seq: 1 }), Buffer.from("one"));
    fixture.socket.output(frame({ type: "output", seq: 2 }), Buffer.from("two"));
    fixture.socket.output(frame({ type: "output", seq: 3 }), Buffer.from("three"));
    await settle();

    expect(fixture.session.snapshot.appliedSeq).toBe(3);
    expect(listener).not.toHaveBeenCalled();
    expect(parseSent(fixture.socket).filter(isOutputAck)).toEqual([]);

    fixture.socket.frame(frame({ type: "caught_up", headSeq: 3 }));
    await settle();
    expect(parseSent(fixture.socket).filter(isOutputAck)).toEqual([
      expect.objectContaining({ appliedSeq: 3 }),
    ]);
    expect(fixture.session.snapshot).toMatchObject({
      connection: "ready",
      appliedSeq: 3,
    });
  });

  it("adopts a running attached controller role when the listed terminal was still starting", async () => {
    const fixture = createFixture(
      { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
      resource({ lifecycle: "starting", lifecycleRevision: 1, startedAt: null }),
    );
    fixture.session.connect();
    await settle();
    fixture.socket.open();
    fixture.socket.frame(attached({ lifecycle: "running", lifecycleRevision: 2 }));
    fixture.socket.frame(frame({
      type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80,
      format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0,
    }));
    fixture.socket.frame(frame({
      type: "snapshot_end", checkpointSeq: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }));
    fixture.socket.frame(frame({ type: "caught_up", headSeq: 0 }));
    await settle();

    expect(fixture.session.snapshot).toMatchObject({
      connection: "ready",
      lifecycle: "running",
      lifecycleRevision: 2,
      role: "controller",
      inputAvailable: true,
    });
  });

  it("fails closed on a replay gap instead of acknowledging fabricated continuity", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    fixture.session.connect();
    await settle();
    fixture.socket.open();
    fixture.socket.frame(attached());
    fixture.socket.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
    fixture.socket.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
    fixture.socket.output(frame({ type: "output", seq: 2 }), new TextEncoder().encode("x"));
    await settle();
    expect(fixture.session.snapshot.inputAvailable).toBe(false);
    expect(fixture.session.snapshot).toMatchObject({
      message: expect.stringMatching(/sequence gap/u),
    });
    expect(fixture.socket.closed).toContainEqual([
      TERMINAL_CLIENT_CLOSE_CODES.applyFailed,
      "terminal_apply_failed",
    ]);
  });

  it("preserves an unresolved producer sequence through a transient disconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const api = terminalApi();
      const session = new TerminalSession({
        api,
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await vi.runAllTicks();
      await Promise.resolve();
      const first = sockets[0]!;
      first.open();
      first.frame(attached());
      first.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
      first.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
      first.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      expect(session.sendInput("echo one\r")).toBe(true);
      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.createTerminalAdmission).toHaveBeenLastCalledWith(
        TERMINAL_ID,
        expect.objectContaining({ restore: { kind: "resume", appliedSeq: 0 } }),
      );
      const second = sockets[1]!;
      second.open();
      second.frame(attached({ restoreKind: "resume" }));
      second.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      expect(session.snapshot.role).toBe("controller");
      expect(session.snapshot.inputAvailable).toBe(true);
      expect(parseSent(second)).toContainEqual(expect.objectContaining({ type: "input", inputSeq: 1 }));
      session.close();
    } finally { vi.useRealTimers(); }
  });

  it("pipelines rapid input before any write result and retires it in order", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);

    expect(fixture.session.sendInput("one")).toBe(true);
    expect(fixture.session.sendInput("two")).toBe(true);
    expect(fixture.session.sendInput("three")).toBe(true);
    expect(inputFrames(fixture.socket)).toMatchObject([
      { inputSeq: 1 }, { inputSeq: 2 }, { inputSeq: 3 },
    ]);
    expect(fixture.session.snapshot).toMatchObject({
      inputAvailable: true,
      queuedInputCount: 0,
      queuedInputBytes: 0,
    });

    fixture.socket.frame(frame({
      type: "input_result", inputSeq: 1, outcome: "accepted", lastAcceptedInputSeq: 1,
    }));
    expect(inputFrames(fixture.socket)).toHaveLength(3);
    expect(fixture.session.snapshot.queuedInputCount).toBe(0);
    fixture.socket.frame(frame({
      type: "input_result", inputSeq: 2, outcome: "accepted", lastAcceptedInputSeq: 2,
    }));
    expect(inputFrames(fixture.socket)).toMatchObject([
      { inputSeq: 1 }, { inputSeq: 2 }, { inputSeq: 3 },
    ]);
    expect(fixture.session.snapshot.queuedInputCount).toBe(0);
  });

  it("replays a full retained window after reattach", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const api = terminalApi();
      const session = new TerminalSession({
        api,
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await vi.runAllTicks();
      await Promise.resolve();
      const first = sockets[0]!;
      first.open();
      first.frame(attached());
      first.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
      first.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
      first.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      for (let index = 0; index < 24; index += 1) {
        expect(session.sendInput(String(index % 10))).toBe(true);
      }
      expect(inputFrames(first)).toHaveLength(24);

      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);
      const second = sockets[1]!;
      second.open();
      second.frame(attached({ restoreKind: "resume" }));
      second.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();

      expect(inputFrames(second)).toHaveLength(24);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues an input frame that does not fit the remaining byte window", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    expect(fixture.session.sendInput(new Uint8Array(64 * 1024))).toBe(true);
    expect(fixture.session.sendInput(new Uint8Array(63 * 1024))).toBe(true);
    expect(fixture.session.sendInput(new Uint8Array(2 * 1024))).toBe(true);
    expect(inputFrames(fixture.socket)).toHaveLength(2);
    expect(fixture.session.snapshot).toMatchObject({
      inputAvailable: true,
      queuedInputCount: 1,
      queuedInputBytes: 2 * 1024,
    });
  });

  it("bounds buffered input and reports overflow without replacing queued bytes", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    expect(fixture.session.sendInput("pending")).toBe(true);
    for (let index = 1; index < MAX_QUEUED_INPUT_ENTRIES; index += 1) {
      expect(fixture.session.sendInput("x")).toBe(true);
    }
    expect(fixture.session.sendInput("overflow")).toBe(false);
    expect(fixture.session.snapshot).toMatchObject({
      inputAvailable: false,
      queuedInputCount: MAX_QUEUED_INPUT_ENTRIES - 24,
      queuedInputBytes: MAX_QUEUED_INPUT_ENTRIES - 24,
      inputQueueOverflowed: true,
      message: expect.stringMatching(/queue is full/u),
    });
  });

  it("reconciles a late result after takeover and replays only the unaccepted suffix", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    expect(fixture.session.sendInput("one")).toBe(true);
    expect(fixture.session.sendInput("two")).toBe(true);

    fixture.socket.frame(frame({
      type: "control_changed", role: "observer", controllerEpoch: 2,
      lastAcceptedInputSeq: 0,
    }));
    expect(fixture.session.snapshot).toMatchObject({
      role: "observer", uncertainInputSeq: undefined, queuedInputCount: 0,
    });
    fixture.socket.frame(frame({
      type: "input_result", inputSeq: 1, outcome: "accepted", lastAcceptedInputSeq: 1,
    }));
    expect(fixture.session.snapshot.uncertainInputSeq).toBeUndefined();
    expect(inputFrames(fixture.socket)).toHaveLength(2);

    fixture.socket.frame(frame({
      type: "control_changed", role: "controller", controllerEpoch: 3,
      lastAcceptedInputSeq: 1,
    }));
    expect(inputFrames(fixture.socket)).toMatchObject([
      { inputSeq: 1, controllerEpoch: 1 },
      { inputSeq: 2, controllerEpoch: 1 },
      { inputSeq: 2, controllerEpoch: 3 },
    ]);
    expect(fixture.session.snapshot).toMatchObject({
      role: "controller", queuedInputCount: 0, uncertainInputSeq: undefined,
    });
  });

  it("keeps an observer claim pending until the server confirms its role", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    fixture.socket.frame(frame({
      type: "control_changed", role: "observer", controllerEpoch: 2,
      lastAcceptedInputSeq: 0,
    }));

    expect(fixture.session.claimControl()).toBe(true);
    expect(parseSent(fixture.socket)).toContainEqual(
      expect.objectContaining({ type: "claim_control" }),
    );
    expect(fixture.session.snapshot).toMatchObject({
      role: "observer",
      controlRequestPending: true,
      inputAvailable: false,
    });

    fixture.socket.frame(frame({
      type: "error",
      code: "terminal_unavailable",
      message: "Control could not be transferred.",
      retryable: true,
    }));
    expect(fixture.session.snapshot.controlRequestPending).toBe(false);
    expect(fixture.session.claimControl()).toBe(true);

    fixture.socket.frame(frame({
      type: "control_changed", role: "controller", controllerEpoch: 3,
      lastAcceptedInputSeq: 0,
    }));
    expect(fixture.session.snapshot).toMatchObject({
      role: "controller",
      controlRequestPending: false,
      inputAvailable: true,
    });
  });

  it("requires explicit discard after uncertain input cannot be confirmed", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const session = new TerminalSession({
        api: terminalApi(),
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await vi.runAllTicks();
      await Promise.resolve();
      const first = sockets[0]!;
      first.open();
      first.frame(attached());
      first.frame(frame({
        type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80,
        format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0,
      }));
      first.frame(frame({
        type: "snapshot_end", checkpointSeq: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }));
      first.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      expect(session.sendInput("maybe sent")).toBe(true);
      expect(session.sendInput("dependent suffix")).toBe(true);
      first.frame(frame({
        type: "input_result", inputSeq: 1, outcome: "sent_outcome_unknown",
        lastAcceptedInputSeq: 0,
      }));
      expect(first.closed).toContainEqual([
        TERMINAL_CLIENT_CLOSE_CODES.reconcileInput,
        "reconcile_input",
      ]);
      expect(session.discardUnconfirmedInput()).toBe(false);

      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);
      const second = sockets[1]!;
      second.open();
      second.frame(attached({ restoreKind: "resume", lastAcceptedInputSeq: 0 }));
      second.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();

      expect(session.snapshot).toMatchObject({
        connection: "ready",
        uncertainInputSeq: 1,
        inputAvailable: false,
        message: expect.stringMatching(/may already have reached/u),
      });
      expect(inputFrames(second)).toHaveLength(0);
      expect(session.discardUnconfirmedInput()).toBe(true);
      expect(session.snapshot).toMatchObject({
        uncertainInputSeq: undefined,
        queuedInputCount: 0,
        inputAvailable: true,
        message: expect.stringMatching(/was discarded/u),
      });
      expect(session.sendInput("fresh input")).toBe(true);
      expect(inputFrames(second)).toMatchObject([{ inputSeq: 1 }]);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies nonjournaled lifecycle state without advancing rendered history", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    const appliedSeq = fixture.session.snapshot.appliedSeq;
    fixture.socket.frame(frame({
      type: "lifecycle_state",
      lifecycle: "failed",
      lifecycleRevision: 2,
      headSeq: 9,
      exitCode: null,
      exitSignal: null,
      publicReason: "Terminal journal failed.",
    }));

    expect(fixture.session.snapshot).toMatchObject({
      lifecycle: "failed",
      lifecycleRevision: 2,
      role: "observer",
      inputAvailable: false,
      appliedSeq,
      message: "Terminal journal failed.",
    });
    fixture.socket.frame(frame({
      type: "terminal_status",
      seq: (appliedSeq ?? 0) + 1,
      lifecycle: "running",
      lifecycleRevision: 1,
      exitCode: null,
      exitSignal: null,
      publicReason: null,
    }));
    await settle();
    expect(fixture.session.snapshot).toMatchObject({
      lifecycle: "failed",
      lifecycleRevision: 2,
      appliedSeq: (appliedSeq ?? 0) + 1,
    });
  });

  it("clears rendered history and closes without reconnecting when the terminal is removed", async () => {
    let rendered = "stale retained history";
    const onRemoved = vi.fn();
    const sink: TerminalEmulatorSink = {
      reset: vi.fn(() => {
        rendered = "";
      }),
      resize: vi.fn(),
      write: vi.fn((bytes) => {
        rendered += new TextDecoder().decode(bytes);
      }),
    };
    const fixture = createFixture(sink, resource(), onRemoved);
    await makeReady(fixture);
    rendered = "stale retained history";

    fixture.socket.frame(frame({ type: "terminal_removed" }));
    // A frame delivered after removal cannot repopulate the detached sink.
    fixture.socket.output(
      frame({ type: "output", seq: 1 }),
      new TextEncoder().encode("late output"),
    );
    await settle();

    expect(rendered).toBe("");
    expect(sink.reset).toHaveBeenCalledTimes(2);
    expect(sink.write).not.toHaveBeenCalled();
    expect(onRemoved).toHaveBeenCalledOnce();
    expect(fixture.socket.closed).toContainEqual([1_000, "terminal_removed"]);
    expect(fixture.session.snapshot).toMatchObject({
      connection: "closed",
      role: "observer",
      caughtUp: false,
      inputAvailable: false,
    });
    expect(fixture.session.sendInput("must not send")).toBe(false);
  });

  it("persists an explicit release as the desired role across reconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const api = terminalApi();
      const session = new TerminalSession({
        api,
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await vi.runAllTicks();
      await Promise.resolve();
      const first = sockets[0]!;
      first.open();
      first.frame(attached());
      first.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
      first.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
      first.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      expect(session.releaseControl()).toBe(true);
      first.frame(frame({
        type: "control_changed", role: "observer", controllerEpoch: 2,
        lastAcceptedInputSeq: 0,
      }));
      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.createTerminalAdmission).toHaveBeenLastCalledWith(
        TERMINAL_ID,
        expect.objectContaining({ requestedRole: "observer" }),
      );
      session.close();
    } finally { vi.useRealTimers(); }
  });

  it("revokes control and input immediately when a live terminal exits", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    expect(fixture.session.sendInput("pending")).toBe(true);
    expect(fixture.session.sendInput("queued")).toBe(true);
    fixture.socket.frame(frame({
      type: "terminal_status", seq: 1, lifecycle: "exited", lifecycleRevision: 2,
      exitCode: 0, exitSignal: null, publicReason: null,
    }));
    await settle();
    expect(fixture.session.snapshot).toMatchObject({
      lifecycle: "exited",
      lifecycleRevision: 2,
      role: "observer",
      inputAvailable: false,
    });
    expect(fixture.session.sendInput("should not run")).toBe(false);
    fixture.socket.frame(frame({
      type: "input_result", inputSeq: 1, outcome: "not_sent", lastAcceptedInputSeq: 0,
    }));
    expect(fixture.session.retryNotSentInput()).toBe(false);
    expect(inputFrames(fixture.socket)).toHaveLength(2);
    fixture.socket.frame(frame({
      type: "control_changed", role: "controller", controllerEpoch: 3,
      lastAcceptedInputSeq: 0,
    }));
    expect(fixture.session.snapshot.role).toBe("observer");
    expect(inputFrames(fixture.socket)).toHaveLength(2);
  });

  it("keeps the same sequence retryable after a synchronous socket send failure", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    await makeReady(fixture);
    fixture.socket.throwOnNextSend = true;
    expect(fixture.session.sendInput("one")).toBe(false);
    expect(fixture.session.snapshot).toMatchObject({
      inputAvailable: false,
      retryInputAvailable: true,
    });
    expect(fixture.session.retryNotSentInput()).toBe(true);
    expect(inputFrames(fixture.socket)).toMatchObject([{ inputSeq: 1 }]);
  });

  it("applies and acknowledges sealed final status before caught-up, then resumes it", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const api = terminalApi();
      const sealed = resource({
        lifecycle: "exited",
        lifecycleRevision: 2,
        headSeq: 1,
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      });
      const session = new TerminalSession({
        api,
        terminal: sealed,
        producerId: PRODUCER_ID,
        requestedRole: "observer",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 1,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      session.connect();
      await settle();
      const first = sockets[0]!;
      first.open();
      first.frame(attached({
        role: "observer",
        lifecycle: "exited",
        lifecycleRevision: 2,
        headSeq: 1,
      }));
      first.frame(frame({ type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80, format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0 }));
      first.frame(frame({ type: "snapshot_end", checkpointSeq: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
      first.frame(frame({
        type: "terminal_status",
        seq: 1,
        lifecycle: "exited",
        lifecycleRevision: 2,
        exitCode: 0,
        exitSignal: null,
        publicReason: null,
      }));
      first.frame(frame({ type: "caught_up", headSeq: 1 }));
      await settle();
      expect(session.snapshot).toMatchObject({
        connection: "ready",
        lifecycle: "exited",
        lifecycleRevision: 2,
        appliedSeq: 1,
        role: "observer",
        inputAvailable: false,
      });
      expect(parseSent(first)).toContainEqual(expect.objectContaining({
        type: "ack_output",
        appliedSeq: 1,
      }));

      first.serverClose();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.createTerminalAdmission).toHaveBeenLastCalledWith(
        TERMINAL_ID,
        expect.objectContaining({ restore: { kind: "resume", appliedSeq: 1 } }),
      );
      const second = sockets[1]!;
      second.open();
      second.frame(attached({
        restoreKind: "resume",
        role: "observer",
        lifecycle: "exited",
        lifecycleRevision: 2,
        headSeq: 1,
        historyFloorSeq: 1,
      }));
      second.frame(frame({ type: "caught_up", headSeq: 1 }));
      await settle();
      expect(session.snapshot).toMatchObject({
        connection: "ready",
        lifecycle: "exited",
        appliedSeq: 1,
        inputAvailable: false,
      });
      session.close();
    } finally { vi.useRealTimers(); }
  });

  it("keeps retrying a visible terminal after more than forty seconds offline", async () => {
    vi.useFakeTimers();
    try {
      const api = terminalApi();
      vi.mocked(api.createTerminalAdmission).mockRejectedValue(new Error("offline"));
      const session = new TerminalSession({
        api,
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 500,
      });

      session.connect();
      await vi.advanceTimersByTimeAsync(45_000);

      expect(api.createTerminalAdmission.mock.calls.length).toBeGreaterThan(8);
      expect(session.snapshot.connection).toBe("reconnecting");
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset reconnect backoff until replay catches up", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const session = new TerminalSession({
        api: terminalApi(),
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 10,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      session.connect();
      await settle();
      sockets[0]!.open();
      sockets[0]!.frame(attached());
      await settle();
      sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(2);

      sockets[1]!.open();
      sockets[1]!.frame(attached({ restoreKind: "resume" }));
      await settle();
      sockets[1]!.serverClose();
      await vi.advanceTimersByTimeAsync(19);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);

      sockets[2]!.open();
      sockets[2]!.frame(attached({ restoreKind: "resume" }));
      sockets[2]!.frame(frame({ type: "caught_up", headSeq: 0 }));
      await settle();
      sockets[2]!.serverClose();
      await vi.advanceTimersByTimeAsync(9);
      expect(sockets).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(4);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a slow-viewer close while preserving automatic retry", async () => {
    const fixture = createFixture({ reset: vi.fn(), resize: vi.fn(), write: vi.fn() });
    fixture.session.connect();
    await settle();
    fixture.socket.open();

    fixture.socket.serverClose(1_013, "viewer_too_slow");

    expect(fixture.session.snapshot).toMatchObject({
      connection: "reconnecting",
      inputAvailable: false,
      message: "Terminal output outpaced this viewer; restoring the latest screen.",
    });
    fixture.session.close();
  });

  it("accelerates a pending reconnect when the browser comes online or the user retries", async () => {
    vi.useFakeTimers();
    try {
      const api = terminalApi();
      vi.mocked(api.createTerminalAdmission).mockRejectedValue(new Error("offline"));
      const session = new TerminalSession({
        api,
        terminal: resource(),
        producerId: PRODUCER_ID,
        requestedRole: "controller",
        sink: { reset: vi.fn(), resize: vi.fn(), write: vi.fn() },
        reconnectDelayMilliseconds: 8_000,
      });

      session.connect();
      await settle();
      expect(api.createTerminalAdmission).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("online"));
      await settle();
      expect(api.createTerminalAdmission).toHaveBeenCalledTimes(2);

      expect(session.retryConnection()).toBe(true);
      await settle();
      expect(api.createTerminalAdmission).toHaveBeenCalledTimes(3);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFixture(
  sink: TerminalEmulatorSink,
  terminal: TerminalResource = resource(),
  onRemoved?: () => void,
) {
  const socket = new FakeSocket();
  const api = terminalApi();
  const session = new TerminalSession({
    api,
    terminal,
    producerId: PRODUCER_ID,
    requestedRole: "controller",
    sink,
    ...(onRemoved ? { onRemoved } : {}),
    reconnectDelayMilliseconds: 1,
    webSocketFactory: () => socket,
  });
  return { session, socket, api };
}

async function makeReady(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.session.connect();
  await settle();
  fixture.socket.open();
  fixture.socket.frame(attached());
  fixture.socket.frame(frame({
    type: "snapshot_begin", checkpointSeq: 0, rows: 24, columns: 80,
    format: "ansi-checkpoint-v1", byteLength: 0, chunkCount: 0,
  }));
  fixture.socket.frame(frame({
    type: "snapshot_end", checkpointSeq: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  }));
  fixture.socket.frame(frame({ type: "caught_up", headSeq: 0 }));
  await settle();
}

function terminalApi() {
  return {
    createTerminalAdmission: vi.fn(async () => ({
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      terminalId: TERMINAL_ID,
      incarnationId: INCARNATION_ID,
      attachmentId: ATTACHMENT_ID,
    })),
    terminalWebSocketUrl: vi.fn(() => "ws://example.test/api/terminal"),
  };
}

class FakeSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closed: Array<[number | undefined, string | undefined]> = [];
  throwOnNextSend = false;
  send(data: string | ArrayBuffer): void {
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false;
      throw new Error("socket send failed");
    }
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (
      code !== undefined &&
      code !== 1_000 &&
      (code < 3_000 || code > 4_999)
    ) {
      throw new DOMException("The close code is not valid for browser clients.", "InvalidAccessError");
    }
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  open(): void { this.readyState = 1; this.onopen?.(new Event("open")); }
  frame(value: unknown): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
  output(header: unknown, payload: Uint8Array): void {
    const bytes = encodeTerminalBinaryFrame("output", header as Record<string, unknown>, payload);
    this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
  }
  serverClose(code = 1_006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

function resource(overrides: Partial<TerminalResource> = {}): TerminalResource {
  return {
    terminalId: TERMINAL_ID,
    threadId: "55555555-5555-4555-8555-555555555555",
    workspaceId: "66666666-6666-4666-8666-666666666666",
    environmentId: "local",
    environmentLabel: "Local",
    incarnationId: INCARNATION_ID,
    displayName: "Terminal",
    shellProfile: null,
    initialCwd: "/workspace",
    terminationEffect: "end_process",
    lifecycle: "running",
    lifecycleRevision: 1,
    rows: 24,
    columns: 80,
    initialRows: 24,
    initialColumns: 80,
    historyFloorSeq: 0,
    headSeq: 0,
    exitCode: null,
    exitSignal: null,
    publicReason: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    exitedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function attached(overrides: Record<string, unknown> = {}) {
  return frame({
    type: "attached", attachmentId: ATTACHMENT_ID, role: "controller",
    controllerEpoch: 1, lastAcceptedInputSeq: 0, lifecycle: "running",
    lifecycleRevision: 1, rows: 24, columns: 80, historyFloorSeq: 0, headSeq: 0,
    restoreKind: "checkpoint",
    ...overrides,
  });
}

function frame(body: Record<string, unknown>): Record<string, unknown> {
  return { v: 2, terminalId: TERMINAL_ID, incarnationId: INCARNATION_ID, ...body };
}

function parseSent(socket: FakeSocket): unknown[] {
  return socket.sent.map((value) => {
    if (typeof value === "string") return JSON.parse(value) as unknown;
    const decoded = decodeSentBinary(new Uint8Array(value));
    return { ...(decoded.header as object), data: Array.from(decoded.payload) };
  });
}
function inputFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return parseSent(socket).filter((value): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && "type" in value && value.type === "input"
  ));
}
function isOutputAck(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "type" in value &&
    value.type === "ack_output";
}
function decodeSentBinary(value: Uint8Array) {
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(5, false);
  const offset = 9 + headerLength;
  return {
    header: JSON.parse(new TextDecoder().decode(value.subarray(9, offset))) as unknown,
    payload: value.subarray(offset),
  };
}
async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}
