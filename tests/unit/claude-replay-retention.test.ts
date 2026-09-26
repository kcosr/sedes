import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { ClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-host.js";
import { claudePersistentAttachmentSchema, type ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { compactedStreamSequences, historyCandidates, historyCovers, isTransientReplay } from "../../src/server/backends/claude/runtime/claude-replay-retention.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { createFakePersistentClaudeRuntime } from "../helpers/persistent-claude-fixture.js";

const sessionId = randomUUID();
function message(value: Record<string, unknown>): SDKMessage {
  return { uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, ...value } as unknown as SDKMessage;
}
function complete(text = "hello", id: string = randomUUID()): SDKMessage {
  return message({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
}
function stream(id: string, text = "hello"): SDKMessage[] {
  const frame = (event: unknown) => message({ type: "stream_event", event });
  return [frame({ type: "message_start", message: { id, content: [] } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    frame({ type: "content_block_stop", index: 0 }), complete(text, id), frame({ type: "message_stop" })];
}
function events(messages: SDKMessage[]): Map<number, ClaudePersistentEvent> {
  return new Map(messages.map((value, index) => [index + 1, { sessionId, sequence: index + 1, payload: { kind: "message", message: value as never } }]));
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
async function fixture(highWaterEntries = 8, highWaterBytes?: number) {
  vi.useFakeTimers();
  const native = createFakePersistentClaudeRuntime();
  const configuration = { tenantId: "t", principalId: "p", executionEnvironmentId: "e", backendInstanceId: "b", executablePath: "/claude", initializationTimeoutMs: 5000 };
  const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: "t", principalId: "p", executionEnvironmentId: "e", installationId: "i" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION, configuration: serviceConfiguration });
  const controllerEpoch = services.attach(serviceConfiguration);
  const host = new ClaudePersistentRuntimeHost({ configuration, client: native.runtime, close: native.runtime.close, services,
    replayRetention: { highWaterEntries, highWaterBytes, minimumHistoryIntervalMs: 100 } });
  const authority = { runtimeId: host.runtimeId, controllerEpoch };
  const delivered: ClaudePersistentEvent[] = [];
  const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
  await host.execute({ ...authority, action: "open", replay: "full", request: { queryId: sessionId, sessionId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: true } }, listener);
  const session = native.sessions[0]!;
  const ack = (sequence: number) => host.execute({ ...authority, action: "acknowledge", request: { sessionId, sequence } }, listener);
  const emit = async (value: SDKMessage, acknowledge = true) => { await session.emit(value); const event = delivered.at(-1)!; if (acknowledge) await ack(event.sequence); return event; };
  const snapshot = async () => claudePersistentAttachmentSchema.parse(await host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, listener));
  cleanups.push(async () => { host.detach(); await native.runtime.close(); });
  return { ...native, session, host, services, emit, ack, snapshot, authority, listener };
}

describe("Claude acknowledged replay retention", () => {
  it("compacts exact closed text streams only after every original and replacement is acknowledged", () => {
    const replay = events(stream("api-message"));
    const hole = new Map([[3, replay.get(3)!]]);
    expect(compactedStreamSequences(replay, hole)).toEqual([]);
    expect(historyCandidates(replay, hole)).toEqual([]);
    expect(compactedStreamSequences(replay, new Map())).toEqual([1, 2, 3, 4, 6]);
    replay.delete(6);
    expect(compactedStreamSequences(replay, new Map())).toEqual([]);
  });
  it("does not compact mismatched, ambiguous, or incomplete block replacements", () => {
    const values = stream("api-message");
    values[4] = complete("different", "api-message");
    expect(compactedStreamSequences(events(values), new Map())).toEqual([]);
    values[4] = message({ type: "assistant", message: { id: "api-message", content: [{ type: "text", text: "hello" }, { type: "text", text: "hello" }] } });
    expect(compactedStreamSequences(events(values), new Map())).toEqual([]);
  });
  it("matches complete tool blocks by content without guessing their native indexes", () => {
    const frame = (event: unknown) => message({ type: "stream_event", event });
    const block = { type: "tool_use", id: "tool", name: "Read", input: { path: "/file" } };
    const replay = events([
      frame({ type: "message_start", message: { id: "api", content: [] } }),
      frame({ type: "content_block_start", index: 7, content_block: { ...block, input: {} } }),
      frame({ type: "content_block_delta", index: 7, delta: { type: "input_json_delta", partial_json: '{"path":"/file"}' } }),
      frame({ type: "content_block_stop", index: 7 }),
      message({ type: "assistant", message: { id: "api", content: [block] } }),
      frame({ type: "message_stop" }),
    ]);
    expect(compactedStreamSequences(replay, new Map())).toEqual([1, 2, 3, 4, 6]);
  });
  it("compacts a stopped host stream when an earlier delivery hole is finally acknowledged", async () => {
    const f = await fixture();
    let hole = 0;
    for (const [index, value] of stream("late-ack").entries()) {
      const event = await f.emit(value, index !== 2);
      if (index === 2) hole = event.sequence;
    }
    expect((await f.snapshot()).events).toHaveLength(6);
    await f.ack(hole);
    const remaining = (await f.snapshot()).events;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.payload.kind === "message" && remaining[0]!.payload.message.type).toBe("assistant");
  });
  it("protects replacements when orphan deltas precede another framed stream", () => {
    const replay = events([message({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "orphan" } } }), complete("orphan", "old"), ...stream("new")]);
    expect(historyCandidates(replay, new Map())).toEqual([]);
  });
  it("bounds more than 8190 thinking estimates while preserving exact input stamps and acceptance", async () => {
    const f = await fixture();
    const operationId = randomUUID();
    await f.host.execute({ ...f.authority, action: "send", request: { queryId: sessionId, operationId, content: "hello" } }, f.listener);
    await f.emit(message({ ...complete(), user_message_uuid: operationId }));
    const synthetic = (await f.snapshot()).events.find(event => event.payload.kind === "message" && event.payload.message.type === "user")!;
    await f.ack(synthetic.sequence);
    for (let index = 0; index < 8200; index++) {
      await f.emit(message({ type: "system", subtype: "thinking_tokens", user_message_uuid: operationId, estimated_tokens: index + 1, estimated_tokens_delta: 1 }));
    }
    await f.emit(message({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1, estimated_tokens_delta: 1 }));
    const snapshot = await f.snapshot();
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.some(event => event.sequence === synthetic.sequence)).toBe(true);
    expect(snapshot.events.at(-1)?.payload).toMatchObject({ kind: "message", message: { subtype: "thinking_tokens", user_message_uuid: operationId, estimated_tokens: 8200 } });
    expect(f.session.close).not.toHaveBeenCalled();
  }, 15_000);
  it("treats an acknowledged native command lifecycle frame as transient", () => {
    const event = events([message({ type: "command_lifecycle", command_uuid: randomUUID(), state: "started" })]).get(1)!;
    expect(isTransientReplay(event)).toBe(true);
  });
  it("does not discard private consumption wrappers or unadmitted plural thinking stamps", () => {
    const event = events([message({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1, estimated_tokens_delta: 1 })]).get(1)!;
    expect(isTransientReplay(event)).toBe(true);
    if (event.payload.kind === "message") event.payload.consumedTurnRootUuid = randomUUID();
    expect(isTransientReplay(event)).toBe(false);
    const plural = events([message({ type: "system", subtype: "thinking_tokens", user_message_uuids: [randomUUID()], estimated_tokens: 1, estimated_tokens_delta: 1 })]).get(1)!;
    expect(isTransientReplay(plural)).toBe(false);
  });
  it("retires per-input thinking state with terminal cleanup, including a late original ACK", async () => {
    const f = await fixture();
    for (let index = 0; index < 40; index++) {
      const operationId = randomUUID();
      await f.host.execute({ ...f.authority, action: "send", request: { queryId: sessionId, operationId, content: "hello" } }, f.listener);
      const estimate = await f.emit(message({ type: "system", subtype: "thinking_tokens", user_message_uuid: operationId, estimated_tokens: 1, estimated_tokens_delta: 1 }), false);
      await f.emit(message({ type: "result", user_message_uuid: operationId, subtype: "success" }));
      for (const event of (await f.snapshot()).events) if (event.sequence !== estimate.sequence) await f.ack(event.sequence);
      await f.ack(estimate.sequence);
      expect((await f.snapshot()).events).toHaveLength(0);
    }
  });
  it("requires exact persisted identity and content, allowing nullable native parent metadata", () => {
    const value = complete();
    const candidate = events([value]).get(1)!;
    expect(historyCovers(candidate, { ...value, parent_agent_id: null })).toBe(true);
    expect(historyCovers(candidate, { ...value, uuid: randomUUID() })).toBe(false);
    expect(historyCovers(candidate, { ...value, message: { content: [] } })).toBe(false);
    expect(historyCovers(candidate, { ...value, message: Object.assign(Object.create(null), (value as { message: object }).message) })).toBe(true);
  });
  it("allows finalized assistant usage and a null stop reason while keeping other metadata exact", () => {
    const content = { id: "api", role: "assistant", content: [{ type: "text", text: "hello" }], model: "claude", stop_reason: null,
      usage: { input_tokens: 12, output_tokens: 1 }, future_metadata: { exact: "value" } };
    const live = message({ type: "assistant", message: content });
    const candidate = events([live]).get(1)!;
    const finalContent = { ...content, usage: { input_tokens: 12, output_tokens: 20 }, stop_reason: "end_turn" };
    const persisted = { ...live, message: finalContent };
    expect(historyCovers(candidate, persisted)).toBe(true);
    expect(historyCovers(candidate, { ...persisted, message: { ...finalContent, stop_reason: null } })).toBe(true);
    for (const changed of [{ id: "other" }, { model: "other" }, { content: [{ type: "text", text: "changed" }] },
      { future_metadata: { exact: "changed" } }, { future_field: true }]) {
      expect(historyCovers(candidate, { ...persisted, message: { ...finalContent, ...changed } })).toBe(false);
    }
    const knownReason = events([message({ ...live, message: { ...content, stop_reason: "tool_use" } })]).get(1)!;
    expect(historyCovers(knownReason, { ...persisted, uuid: knownReason.payload.kind === "message" ? knownReason.payload.message.uuid : "" })).toBe(false);
    const missingReason = { ...content } as Record<string, unknown>;
    delete missingReason.stop_reason;
    expect(historyCovers(events([message({ ...live, message: missingReason })]).get(1)!, persisted)).toBe(false);
    expect(content.stop_reason).toBeNull();
    expect(content.usage.output_tokens).toBe(1);
  });
  it("does not relax user message metadata or ACK holes when assistant history finalizes", async () => {
    const user = message({ type: "user", message: { role: "user", content: "hello", usage: { value: 1 } } });
    expect(historyCovers(events([user]).get(1)!, { ...user, message: { role: "user", content: "hello", usage: { value: 2 } } })).toBe(false);
    const f = await fixture(2);
    const live = message({ type: "assistant", message: { id: "api", role: "assistant", content: [{ type: "text", text: "hello" }], usage: { output_tokens: 1 }, stop_reason: null } });
    const other = complete();
    f.runtime.getSessionMessages.mockResolvedValue([{ ...live, message: { ...(live as { message: object }).message, usage: { output_tokens: 20 }, stop_reason: "end_turn" } }, other] as never);
    const hole = await f.emit(live, false); await f.emit(other);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events.map(event => event.sequence)).toEqual([hole.sequence]);
    await f.ack(hole.sequence);
    // Restore byte pressure after the earlier sweep fell below its low water.
    await f.emit(complete("uncovered"));
    await vi.advanceTimersByTimeAsync(100);
    expect((await f.snapshot()).events.some(event => event.sequence === hole.sequence)).toBe(false);
  });
  it("bounds long connected tool/progress turns without a terminal result", async () => {
    const f = await fixture(16);
    const history: SDKMessage[] = [];
    f.runtime.getSessionMessages.mockImplementation(async () => history as never);
    for (let index = 0; index < 1500; index++) {
      const group = stream(`api-${index}`);
      history.push(group[4]!);
      for (const value of group) await f.emit(value);
      await f.emit(message({ type: "tool_progress", tool_use_id: `tool-${index}`, tool_name: "Read", elapsed_time_seconds: 1 }));
      await f.emit(message({ type: "system", subtype: "task_progress", task_id: "task", description: "working" }));
      await f.emit(message({ type: "system", subtype: "status", status: "requesting" }));
      if (index % 16 === 15) await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = await f.snapshot();
    expect(snapshot.events.length).toBeLessThan(20);
    expect(snapshot.failureCode).toBeNull();
    expect(f.session.close).not.toHaveBeenCalled();
    expect(f.runtime.getSessionMessages.mock.calls.length).toBeGreaterThan(1);
    expect(f.runtime.getSessionMessages.mock.calls.length).toBeLessThan(110);
  }, 30_000);
  it("retains ACK holes and same-UUID changed history while pruning covered neighbors", async () => {
    const f = await fixture(2);
    const first = complete("first"), second = complete("second"), third = complete("third");
    const hole = await f.emit(first, false);
    await f.emit(second); await f.emit(third);
    f.runtime.getSessionMessages.mockResolvedValue([first, { ...second, message: { content: [] } }, third] as never);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events.map(event => event.sequence)).toEqual([hole.sequence, hole.sequence + 1]);
    expect(f.session.close).not.toHaveBeenCalled();
  });
  it("reclaims on byte pressure without mutating a previously returned attachment", async () => {
    const f = await fixture(1024, 256);
    const value = complete("x".repeat(1024));
    f.runtime.getSessionMessages.mockResolvedValue([value] as never);
    await f.emit(value);
    const before = await f.host.execute({ ...f.authority, action: "attach", replay: "full", request: { sessionId } }, f.listener) as { events: ClaudePersistentEvent[] };
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events).toHaveLength(0);
    expect(before.events).toHaveLength(1);
    expect(f.runtime.getSessionMessages).toHaveBeenCalledOnce();
  });
  it("keeps pending permissions even after their delivery ACK and transcript reclamation", async () => {
    const f = await fixture(2);
    const pending = f.session.askPermission();
    const permission = (await f.snapshot()).events.find(event => event.payload.kind === "permission")!;
    await f.ack(permission.sequence);
    const first = complete(), second = complete();
    f.runtime.getSessionMessages.mockResolvedValue([first, second] as never);
    await f.emit(first); await f.emit(second);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events.map(event => event.payload.kind)).toEqual(["permission"]);
    await f.session.close(); await pending;
  });
  it("discards a stale history result after controller detach and backs off failed reads", async () => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    let resolve!: (value: never) => void;
    f.runtime.getSessionMessages.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    await f.emit(first); await f.emit(second);
    await vi.advanceTimersByTimeAsync(1);
    f.host.detach(); resolve([first, second] as never);
    await Promise.resolve(); await Promise.resolve();
    expect((await f.snapshot()).events).toHaveLength(2);
    f.runtime.getSessionMessages.mockRejectedValue(new Error("history unavailable"));
    await vi.advanceTimersByTimeAsync(100);
    const reads = f.runtime.getSessionMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(99);
    expect(f.runtime.getSessionMessages).toHaveBeenCalledTimes(reads);
    expect(f.session.close).not.toHaveBeenCalled();
  });
  it("does not prune after a replacement controller attaches during history acquisition", async () => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    let resolve!: (value: never) => void;
    f.runtime.getSessionMessagesPage.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }))
      .mockResolvedValueOnce({ messages: [second] as never, nextCursor: null });
    await f.emit(first); await f.emit(second);
    await vi.advanceTimersByTimeAsync(1);
    const controllerEpoch = f.services.attach({ environmentRevision: 1, operationsRevision: 1 });
    const authority = { runtimeId: f.host.runtimeId, controllerEpoch };
    const replacement = vi.fn();
    const snapshot = () => f.host.execute({ ...authority, action: "attach", replay: "full", request: { sessionId } }, replacement);
    await snapshot();
    resolve({ messages: [first], nextCursor: { snapshotId: randomUUID(), offset: 1, end: 2 } } as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(claudePersistentAttachmentSchema.parse(await snapshot()).events).toHaveLength(2);
    expect(f.runtime.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(f.session.close).not.toHaveBeenCalled();
  });
  it("discards first-page matches if a later history page fails", async () => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    f.runtime.getSessionMessagesPage
      .mockResolvedValueOnce({ messages: [first] as never, nextCursor: { snapshotId: randomUUID(), offset: 1, end: 2 } })
      .mockRejectedValueOnce(new Error("claude_runtime_history_snapshot_expired"));
    await f.emit(first); await f.emit(second);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events).toHaveLength(2);
    expect(f.runtime.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(f.runtime.getSessionMessagesPage.mock.calls[0]![1].includeSystemMessages).toBe(false);
    expect(f.runtime.getSessionMessagesPage.mock.calls[0]![1].maintenance).toBe(true);
    // Replay covers only what the live query produced: the resumable segment.
    expect(f.runtime.getSessionMessagesPage.mock.calls[0]![1].resumableOnly).toBe(true);
    expect(f.session.close).not.toHaveBeenCalled();
  });
  it("runs only one history sweep at a time across sessions and advances queued work", async () => {
    const f = await fixture(2);
    const secondId = randomUUID();
    const delivered: ClaudePersistentEvent[] = [];
    const listener = (event: ClaudePersistentEvent) => { delivered.push(event); };
    await f.host.execute({ ...f.authority, action: "open", replay: "full", request: { queryId: secondId, sessionId: secondId, cwd: "/workspace", launch: "new", environment: {}, enableCanUseTool: false } }, listener);
    let resolve!: (value: never) => void;
    f.runtime.getSessionMessagesPage.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    await f.emit(complete()); await f.emit(complete());
    for (let index = 0; index < 2; index++) {
      await f.sessions[1]!.emit(message({ ...complete(), session_id: secondId }));
      await f.host.execute({ ...f.authority, action: "acknowledge", request: { sessionId: secondId, sequence: delivered.at(-1)!.sequence } }, listener);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.getSessionMessagesPage).toHaveBeenCalledOnce();
    expect(f.runtime.getSessionMessagesPage.mock.calls[0]![0]).toBe(sessionId);
    resolve({ messages: [], nextCursor: null } as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.getSessionMessagesPage).toHaveBeenCalledTimes(2);
    expect(f.runtime.getSessionMessagesPage.mock.calls[1]![0]).toBe(secondId);
  });
  it.each(["same", "other"] as const)("serves foreground history for the %s session while an attach-triggered sweep's native read is pending", async (target) => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    await f.emit(first); await f.emit(second);
    f.host.detach();
    let resolveSweep!: (value: never) => void;
    const foregroundSessionId = target === "same" ? sessionId : randomUUID();
    const foregroundMessage = message({ ...complete("foreground"), session_id: foregroundSessionId });
    // Keep the real fixture pager: only the underlying native read is delayed.
    // A mock page response would miss interference between pager acquisitions.
    f.runtime.getSessionMessages
      .mockImplementationOnce(() => new Promise(resolve => { resolveSweep = resolve; }))
      .mockResolvedValueOnce([foregroundMessage] as never);
    await f.snapshot();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.getSessionMessages).toHaveBeenCalledOnce();
    const foreground = await f.host.execute({ ...f.authority, action: "messages", request: {
      sessionId: foregroundSessionId, dir: "/workspace", includeSystemMessages: false,
    } }, f.listener) as { messages: { uuid: string }[]; nextCursor: unknown };
    expect(foreground.messages.map(value => value.uuid)).toEqual([foregroundMessage.uuid]);
    expect(foreground.nextCursor).toBeNull();
    expect(f.runtime.getSessionMessages).toHaveBeenCalledTimes(2);
    expect((await f.snapshot()).events).toHaveLength(2);
    resolveSweep([first, second] as never);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events).toHaveLength(0);
  });
  it("resumes queued reclamation when a lifecycle admission freeze is restored", async () => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    f.runtime.getSessionMessages.mockResolvedValue([first, second] as never);
    await f.emit(first); await f.emit(second);
    f.host.freezeAdmission();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.getSessionMessagesPage).not.toHaveBeenCalled();
    f.host.restoreAdmission();
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.snapshot()).events).toHaveLength(0);
  });
  it("does not reclaim from history acquired across a canonical rewrite", async () => {
    const f = await fixture(2);
    const first = complete(), second = complete();
    let resolve!: (value: never) => void;
    f.runtime.getSessionMessages.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    await f.emit(first); await f.emit(second);
    await vi.advanceTimersByTimeAsync(1);
    await f.emit(message({ type: "system", subtype: "compact_boundary" }));
    resolve([first, second] as never);
    await Promise.resolve(); await Promise.resolve();
    expect((await f.snapshot()).events).toHaveLength(3);
  });
  it("retains task obligations until every related original is acknowledged", async () => {
    const f = await fixture();
    const started = await f.emit(message({ type: "system", subtype: "task_started", task_id: "task", task_type: "local_agent", tool_use_id: "tool", description: "working" }), false);
    await f.emit(message({ type: "system", subtype: "task_notification", task_id: "task", status: "completed" }));
    expect((await f.snapshot()).events).toHaveLength(2);
    await f.ack(started.sequence);
    expect((await f.snapshot()).events).toHaveLength(0);
  });
});
