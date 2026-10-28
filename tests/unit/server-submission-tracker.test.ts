import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/client/api/ApiClient.js";
import { ServerSubmissionTracker } from "../../src/client/stores/ServerSubmissionTracker.js";
import type { ConversationItem, QueuedInputPresentation, QueuedInputSummary } from "../../src/shared/index.js";

const createdAt = "2026-10-04T04:00:00.000Z";
const trackers: ServerSubmissionTracker[] = [];
afterEach(() => { for (const tracker of trackers.splice(0)) tracker.dispose(); vi.useRealTimers(); });

function queued(patch: Partial<QueuedInputSummary> = {}): QueuedInputSummary {
  return { id: "queue-1", deliveryOperationId: "send-1", sequence: 1, origin: "user", isHead: true,
    state: "pending", resolvedDeliveryMode: "submit", attachmentCount: 0, taskCount: 0,
    preview: { text: "Spoken message" }, createdAt, ...patch };
}
function detail(patch: Partial<QueuedInputPresentation> = {}): QueuedInputPresentation {
  return { threadId: "thread-1", threadRevision: 1, queuedInputId: "queue-1", deliveryOperationId: "send-1",
    origin: "user", resolvedDeliveryMode: "submit", state: "pending", createdAt,
    content: [{ kind: "text", text: { text: "Spoken message" } }], ...patch };
}
function snapshot(queue: QueuedInputSummary[] = [queued()], revision = 1, items: ConversationItem[] = []) {
  return { thread: { threadRevision: revision }, queue, orderedTurnIds: ["turn-1"],
    turnsById: { "turn-1": { id: "turn-1", revision: 0, status: "completed" as const,
      orderedItemIds: ["previous", ...items.map(item => item.id)] } },
    itemsById: Object.fromEntries(items.map(item => [item.id, item])) };
}
function userItem(operationId = "send-1"): ConversationItem {
  return { id: `user-${operationId}`, turnId: "turn-1", revision: 0, kind: "user_message", status: "completed",
    deliveryOperationId: operationId, content: [{ kind: "text", text: { text: "Spoken message" } }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(read = vi.fn<(_: string, signal: AbortSignal) => Promise<QueuedInputPresentation>>(async () => detail())) {
  let sequence = 0;
  const changed = vi.fn();
  const tracker = new ServerSubmissionTracker({ threadId: "thread-1", read,
    nextSequence: () => ++sequence, changed });
  trackers.push(tracker);
  return { tracker, read, changed, observe: (value = snapshot(), active = true, composer = new Set<string>()) =>
    tracker.observe(value, active, composer) };
}
async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

describe("server submission presentation", () => {
  const nativeReceipt = (queuedInputId: string | null = "queue-1", text = "Spoken message") => ({
    operationId: "send-1", queuedInputId, text,
  });

  it("presents a native receipt's complete text before either its queue row or detail read arrives", async () => {
    const pending = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn(() => pending.promise));
    const empty = snapshot([]);
    f.observe(empty);
    const text = "First segment.\nThe café review continues. ".repeat(100) + "Final segment.";
    f.tracker.acceptNativeSubmission(nativeReceipt("queue-1", text), empty, new Set());
    const view = f.tracker.getSnapshot()[0]!;
    expect(view).toMatchObject({ operationId: "send-1", queuedInputId: "queue-1", phase: "confirming",
      content: [{ kind: "text", text: { text } }], baselineTailItemId: "previous" });
    expect(f.read).not.toHaveBeenCalled();
    await flush();
    expect(f.read).toHaveBeenCalledExactlyOnceWith("queue-1", expect.any(AbortSignal));
    f.observe(snapshot());
    expect(f.tracker.getSnapshot()).toHaveLength(1);
    expect(f.tracker.getSnapshot()[0]?.presentationSequence).toBe(view.presentationSequence);
    f.observe(snapshot([], 2, [userItem()]));
    pending.resolve(detail({ state: "accepted", content: [{ kind: "text", text: { text } }] }));
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
    f.tracker.acceptNativeSubmission(nativeReceipt("queue-1", text), snapshot([]), new Set());
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("fills a queue-first entry without changing its original transcript anchors or sequence", () => {
    const f = fixture(vi.fn(() => new Promise(() => {})));
    f.observe();
    const initial = f.tracker.getSnapshot()[0]!;
    const fullText = "Beyond the preview. ".repeat(40);
    f.tracker.acceptNativeSubmission(nativeReceipt("queue-1", fullText), snapshot(), new Set());
    expect(f.tracker.getSnapshot()).toHaveLength(1);
    expect(f.tracker.getSnapshot()[0]).toMatchObject({
      presentationSequence: initial.presentationSequence, baselineTailItemId: initial.baselineTailItemId,
      content: [{ kind: "text", text: { text: fullText } }],
    });
    f.tracker.acceptNativeSubmission(nativeReceipt("queue-1", "Changed duplicate"), snapshot(), new Set());
    expect(f.tracker.getSnapshot()[0]?.content).toEqual([{ kind: "text", text: { text: fullText } }]);
  });

  it("waits for a real queue ID while immediately showing full native content", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const empty = snapshot([]);
    f.observe(empty);
    f.tracker.acceptNativeSubmission(nativeReceipt(null), empty, new Set());
    expect(f.tracker.getSnapshot()[0]).toMatchObject({ content: detail().content, phase: "confirming" });
    expect(f.tracker.getSnapshot()[0]?.queuedInputId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("unconfirmed");
    f.observe(snapshot());
    await flush();
    expect(f.read).toHaveBeenCalledExactlyOnceWith("queue-1", expect.any(AbortSignal));
    expect(f.tracker.getSnapshot()[0]).toMatchObject({ queuedInputId: "queue-1", phase: "sending", content: detail().content });
  });

  it.each([true, false])("rejects a contradictory receipt queue ID while preserving the original entry (row present: %s)", (present) => {
    const f = fixture(vi.fn(() => new Promise(() => {})));
    f.observe();
    const current = snapshot(present ? [queued()] : [], 2);
    f.observe(current);
    f.tracker.acceptNativeSubmission(nativeReceipt("different-queue", "Unrelated text"), current, new Set());
    expect(f.tracker.getSnapshot()).toMatchObject([{ queuedInputId: "queue-1", operationId: "send-1" }]);
    expect(f.tracker.getSnapshot()[0]?.content).toBeUndefined();
    f.tracker.acceptNativeSubmission(nativeReceipt(), current, new Set());
    expect(f.tracker.getSnapshot()[0]?.content).toEqual(detail().content);
  });

  it("reconciles a native receipt with no queue identity directly to its canonical operation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.observe(snapshot([]));
    f.tracker.acceptNativeSubmission(nativeReceipt(null), snapshot([]), new Set());
    f.observe(snapshot([], 2, [userItem()]));
    await vi.runAllTimersAsync();
    expect(f.tracker.getSnapshot()).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("remembers materialization seen before the native receipt even after a projection replaces it", () => {
    const f = fixture();
    f.observe(snapshot([], 2, [userItem()]));
    f.observe(snapshot([], 3));
    f.tracker.acceptNativeSubmission(nativeReceipt(), snapshot([], 3), new Set());
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it.each(["failed", "retry_wait", "uncertain"] as const)("cannot resurrect a %s operation from a delayed receipt", (state) => {
    const f = fixture();
    f.observe(snapshot([queued({ state })]));
    f.tracker.acceptNativeSubmission(nativeReceipt(), snapshot([]), new Set());
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("rejects receipts for composer operations, materialized operations, or a replaced queue identity", () => {
    for (const [state, composer] of [
      [snapshot([]), new Set(["send-1"])],
      [snapshot([], 2, [userItem()]), new Set<string>()],
      [snapshot([queued({ deliveryOperationId: "replacement" })]), new Set<string>()],
      [snapshot([queued({ id: "wrong-queue" })]), new Set<string>()],
    ] as const) {
      const f = fixture();
      f.tracker.acceptNativeSubmission(nativeReceipt(), state, composer);
      expect(f.tracker.getSnapshot()).toEqual([]);
    }
  });

  it("retains immutable native text and reports unconfirmed delivery if scoped content disagrees", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => detail({ state: "accepted", content: [{ kind: "text", text: { text: "Different text" } }] })));
    f.observe(snapshot([]));
    f.tracker.acceptNativeSubmission(nativeReceipt(), snapshot([]), new Set());
    await vi.runAllTimersAsync();
    expect(f.read).toHaveBeenCalledTimes(8);
    expect(f.tracker.getSnapshot()[0]).toMatchObject({ phase: "unconfirmed", content: detail().content });
  });

  it("validates finalized text by UTF-8 bytes without trimming its exact content", () => {
    const f = fixture();
    for (const text of [" ", "é".repeat(131_073)]) {
      f.tracker.acceptNativeSubmission(nativeReceipt(null, text), snapshot([]), new Set());
      expect(f.tracker.getSnapshot()).toEqual([]);
    }
    const text = `  ${"é".repeat(131_069)}\n `;
    f.tracker.acceptNativeSubmission(nativeReceipt(null, text), snapshot([]), new Set());
    expect(f.tracker.getSnapshot()[0]?.content).toEqual([{ kind: "text", text: { text } }]);
  });

  it("bounds native entries and releases their identity timers on disposal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let index = 0; index < 70; index += 1) {
      f.tracker.acceptNativeSubmission({ ...nativeReceipt(null), operationId: `send-${index}` }, snapshot([]), new Set());
    }
    expect(f.tracker.getSnapshot()).toHaveLength(64);
    f.tracker.dispose();
    await vi.runAllTimersAsync();
    expect(f.tracker.getSnapshot()).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["queue-64", null])("retires a locally cancelled or restored operation outside the presentation limit (receipt queue ID: %s)", (queuedInputId) => {
    const f = fixture(vi.fn(() => new Promise(() => {})));
    const queue = Array.from({ length: 65 }, (_, index) => queued({
      id: `queue-${index}`, deliveryOperationId: `send-${index}`, sequence: index,
    }));
    f.observe(snapshot(queue));
    expect(f.tracker.getSnapshot()).toHaveLength(64);
    expect(f.tracker.getSnapshot().some(item => item.operationId === "send-64")).toBe(false);
    f.tracker.retireOperation(queue[64]!.deliveryOperationId);
    f.tracker.retireOperation(queue[0]!.deliveryOperationId);
    f.observe(snapshot([], 2));
    f.tracker.acceptNativeSubmission({ ...nativeReceipt(queuedInputId), operationId: "send-64" }, snapshot([], 2), new Set());
    expect(f.tracker.getSnapshot()).toHaveLength(63);
    expect(f.tracker.getSnapshot().some(item => item.operationId === "send-64")).toBe(false);
  });

  it("presents an ordinary send immediately and hydrates its full immutable content", async () => {
    const pending = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn(() => pending.promise));
    f.observe();
    expect(f.tracker.getSnapshot()).toMatchObject([{ kind: "server", operationId: "send-1", phase: "sending",
      preview: { text: "Spoken message" }, baselineTailItemId: "previous" }]);
    await flush();
    expect(f.read).toHaveBeenCalledWith("queue-1", expect.any(AbortSignal));
    const fullText = "Long spoken message. ".repeat(70);
    pending.resolve(detail({ content: [{ kind: "text", text: { text: fullText } }] }));
    await flush();
    expect(f.tracker.getSnapshot()[0]?.content).toEqual([{ kind: "text", text: { text: fullText } }]);
  });

  it("keeps composer, Queue, Steer, question replies and automation out of the independent send model", async () => {
    const f = fixture();
    f.observe(snapshot([
      queued(),
      queued({ id: "queue-2", deliveryOperationId: "send-2", resolvedDeliveryMode: "queue", state: "dispatching", deliveryMode: "submit" }),
      queued({ id: "queue-3", deliveryOperationId: "send-3", resolvedDeliveryMode: "steer" }),
      queued({ id: "queue-4", deliveryOperationId: "send-4", origin: "automation" }),
      queued({ id: "queue-5", deliveryOperationId: "send-5", inputOrigin: { kind: "question_response", requestId: "question-1", sourceItemId: "source-1", answers: [] } }),
    ]), true, new Set(["send-1"]));
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
    f.observe();
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("bridges acceptance before the user item and reconciles only its exact operation", async () => {
    const f = fixture(vi.fn(async () => detail({ state: "accepted", threadRevision: 2 })));
    f.observe();
    await flush();
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
    f.observe(snapshot([], 2, [userItem("different-operation")]));
    expect(f.tracker.getSnapshot()).toHaveLength(1);
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
    f.observe(snapshot([], 3, [userItem()]));
    expect(f.tracker.getSnapshot()).toEqual([]);
    f.observe(snapshot([queued()], 4));
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("rechecks a disappearing row instead of treating an older pending read as confirmation", async () => {
    vi.useFakeTimers();
    const first = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn().mockImplementationOnce(() => first.promise)
      .mockResolvedValue(detail({ state: "accepted", threadRevision: 2 })));
    f.observe();
    await flush();
    f.observe(snapshot([], 2));
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("confirming");
    first.resolve(detail());
    await flush();
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("confirming");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
  });

  it.each(["cancelled", "failed", "retry_wait", "uncertain"] as const)(
    "retires a missing row after authoritative %s without resurrecting it", async (state) => {
      const pending = deferred<QueuedInputPresentation>();
      const f = fixture(vi.fn(() => pending.promise));
      f.observe();
      f.observe(snapshot([], 2));
      await flush();
      pending.resolve(detail({ state, threadRevision: 2 }));
      await flush();
      expect(f.tracker.getSnapshot()).toEqual([]);
      f.observe(snapshot([queued()], 3));
      expect(f.tracker.getSnapshot()).toEqual([]);
    },
  );

  it("retires a record that is no longer retained without inventing a rejected send", async () => {
    const f = fixture(vi.fn(async () => { throw new ApiError(404, "not_found", "Missing", false); }));
    f.observe();
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("observes intermediate failure and ignores a late read even after pending reappears", async () => {
    const pending = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn(() => pending.promise));
    f.observe();
    await flush();
    const signal = f.read.mock.calls[0]![1];
    f.observe(snapshot([queued({ state: "failed" })], 2));
    f.observe(snapshot([queued()], 3));
    expect(signal.aborted).toBe(true);
    pending.resolve(detail({ state: "accepted", threadRevision: 3 }));
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
    f.observe(snapshot([queued({ id: "retry-row", deliveryOperationId: "retry-operation" })], 4));
    expect(f.tracker.getSnapshot()).toMatchObject([{ operationId: "retry-operation" }]);
  });

  it("fences reads across disconnection and resumes with fresh authority", async () => {
    const first = deferred<QueuedInputPresentation>();
    const second = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise));
    f.observe();
    await flush();
    const oldSignal = f.read.mock.calls[0]![1];
    f.observe(snapshot(), false);
    expect(oldSignal.aborted).toBe(true);
    f.observe(snapshot([], 2));
    await flush();
    first.resolve(detail({ state: "cancelled", threadRevision: 2 }));
    await flush();
    expect(f.tracker.getSnapshot()).toHaveLength(1);
    second.resolve(detail({ state: "accepted", threadRevision: 2 }));
    await flush();
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
  });

  it("does not let old revision reads decide a newer queue disappearance", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockResolvedValueOnce(detail({ state: "cancelled", threadRevision: 1 }))
      .mockResolvedValue(detail({ state: "accepted", threadRevision: 3 })));
    f.observe(snapshot([queued()], 2));
    f.observe(snapshot([], 3));
    await flush();
    expect(f.tracker.getSnapshot()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
  });

  it("retires an ordinary send converted to a different steering operation", async () => {
    const f = fixture();
    f.observe();
    f.observe(snapshot([queued({ deliveryOperationId: "steer-operation", resolvedDeliveryMode: "steer" })], 2));
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("cancels reads when exact materialization or a local cancellation wins", async () => {
    const pending = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn(() => pending.promise));
    f.observe();
    await flush();
    f.tracker.retireOperation("send-1");
    expect(f.read.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve(detail({ state: "accepted" }));
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
  });

  it("moves a later pending send behind an earlier send's exact materialization", () => {
    const f = fixture();
    const later = queued({ id: "queue-2", deliveryOperationId: "send-2", sequence: 2 });
    f.observe(snapshot([queued(), later]));
    f.observe(snapshot([later], 2, [userItem()]));
    expect(f.tracker.getSnapshot()).toMatchObject([{ operationId: "send-2", baselineTailItemId: "user-send-1" }]);
  });

  it("bounds parallel hydration and abandons in-flight work on disposal", async () => {
    const pending = deferred<QueuedInputPresentation>();
    const f = fixture(vi.fn(() => pending.promise));
    f.observe(snapshot(Array.from({ length: 70 }, (_, index) => queued({ id: `queue-${index}`,
      deliveryOperationId: `send-${index}`, sequence: index }))));
    await flush();
    expect(f.tracker.getSnapshot()).toHaveLength(64);
    expect(f.read).toHaveBeenCalledTimes(4);
    f.tracker.dispose();
    expect(f.read.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
    pending.resolve(detail());
    await flush();
    expect(f.tracker.getSnapshot()).toEqual([]);
    expect(f.read).toHaveBeenCalledTimes(4);
  });

  it("reports unconfirmed delivery after bounded read retries and retries on reconnection", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe();
    f.observe(snapshot([], 2));
    await vi.runAllTimersAsync();
    expect(f.read).toHaveBeenCalledTimes(8);
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("unconfirmed");
    f.read.mockResolvedValue(detail({ state: "accepted", threadRevision: 2 }));
    f.observe(snapshot([], 2), false);
    f.observe(snapshot([], 2));
    await flush();
    expect(f.read).toHaveBeenCalledTimes(9);
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("accepted");
  });

  it("reports exhausted content reads for a retained row without declaring delivery uncertain and retries only its detail", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe();
    await vi.runAllTimersAsync();
    expect(f.read).toHaveBeenCalledTimes(8);
    expect(f.tracker.getSnapshot()[0]).toMatchObject({
      phase: "sending", contentLoadError: true, operationId: "send-1", queuedInputId: "queue-1",
    });
    expect(f.tracker.getSnapshot()[0]?.content).toBeUndefined();
    const sequence = f.tracker.getSnapshot()[0]!.presentationSequence;
    const retry = deferred<QueuedInputPresentation>();
    f.read.mockImplementation(() => retry.promise);
    f.tracker.retryContent("unknown-operation");
    expect(f.read).toHaveBeenCalledTimes(8);
    f.tracker.retryContent("send-1");
    f.tracker.retryContent("send-1");
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBeUndefined();
    await flush();
    expect(f.read).toHaveBeenCalledTimes(9);
    expect(f.read).toHaveBeenLastCalledWith("queue-1", expect.any(AbortSignal));
    retry.resolve(detail({ state: "accepted" }));
    await flush();
    expect(f.tracker.getSnapshot()[0]).toMatchObject({
      content: detail().content, phase: "accepted", presentationSequence: sequence,
    });
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBeUndefined();
    f.tracker.retryContent("send-1");
    await flush();
    expect(f.read).toHaveBeenCalledTimes(9);
  });

  it("clears a content error when an exact native receipt supplies complete text", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe();
    await vi.runAllTimersAsync();
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBe(true);
    f.tracker.acceptNativeSubmission(nativeReceipt(), snapshot(), new Set());
    expect(f.tracker.getSnapshot()[0]?.content).toEqual(detail().content);
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBeUndefined();
    expect(f.tracker.getSnapshot()[0]?.phase).toBe("sending");
  });

  it("does not mark available content as failed when only delivery confirmation reads exhaust", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe(snapshot([]));
    f.tracker.acceptNativeSubmission(nativeReceipt(), snapshot([]), new Set());
    await vi.runAllTimersAsync();
    expect(f.tracker.getSnapshot()[0]).toMatchObject({ phase: "unconfirmed", content: detail().content });
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBeUndefined();
  });

  it("suspends explicit content retries without authority and recovers on reconnect", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe();
    await vi.runAllTimersAsync();
    f.observe(snapshot(), false);
    f.tracker.retryContent("send-1");
    await flush();
    expect(f.read).toHaveBeenCalledTimes(8);
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBe(true);
    f.read.mockResolvedValue(detail());
    f.observe();
    expect(f.tracker.getSnapshot()[0]?.contentLoadError).toBeUndefined();
    await flush();
    expect(f.read).toHaveBeenCalledTimes(9);
    expect(f.tracker.getSnapshot()[0]?.content).toEqual(detail().content);
  });

  it("ignores a late content retry error after exact transcript materialization", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async () => { throw new Error("offline"); }));
    f.observe();
    await vi.runAllTimersAsync();
    const retry = deferred<QueuedInputPresentation>();
    f.read.mockImplementation(() => retry.promise);
    f.tracker.retryContent("send-1");
    await flush();
    const signal = f.read.mock.calls.at(-1)![1];
    f.observe(snapshot([], 2, [userItem()]));
    expect(signal.aborted).toBe(true);
    retry.reject(new Error("late read failure"));
    await flush();
    f.tracker.retryContent("send-1");
    await vi.runAllTimersAsync();
    expect(f.tracker.getSnapshot()).toEqual([]);
    expect(f.read).toHaveBeenCalledTimes(9);
  });

  it.each(["accepted", "pending"] as const)("reports stable %s content budget exhaustion and retries after materialization frees space", async state => {
    const text = "a".repeat(256 * 1_024);
    const content: QueuedInputPresentation["content"] = [{ kind: "text", text: { text } }];
    const rows = Array.from({ length: 64 }, (_, index) => queued({
      id: `queue-${index}`, deliveryOperationId: `send-${index}`, sequence: index,
    }));
    const f = fixture(vi.fn(async (id: string) => detail({
      queuedInputId: id, deliveryOperationId: id.replace("queue-", "send-"), state, content,
    })));
    f.observe(snapshot(rows));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(64));
    const blocked = f.tracker.getSnapshot().find(item => item.contentLoadError)!;
    expect(blocked).toMatchObject({ operationId: "send-63", phase: state === "accepted" ? "accepted" : "sending", contentLoadError: true });
    expect(blocked.content).toBeUndefined();
    expect(f.tracker.getSnapshot().filter(item => item.content)).toHaveLength(63);
    f.observe(snapshot(rows.slice(1), 2, [userItem("send-0")]));
    f.read.mockImplementation(async (id: string) => detail({
      queuedInputId: id, deliveryOperationId: id.replace("queue-", "send-"),
      state: "accepted", threadRevision: 2, content,
    }));
    f.tracker.retryContent(blocked.operationId);
    await flush();
    expect(f.read).toHaveBeenCalledTimes(65);
    const recovered = f.tracker.getSnapshot().find(item => item.operationId === blocked.operationId)!;
    expect(recovered.phase).toBe("accepted");
    expect(recovered.content).toEqual(content);
    expect(recovered.contentLoadError).toBeUndefined();
  });

  it("keeps budget-limited content loading through stale-status retries before exposing terminal read failure", async () => {
    vi.useFakeTimers();
    const content: QueuedInputPresentation["content"] = [{ kind: "text", text: { text: "a".repeat(256 * 1_024) } }];
    const rows = Array.from({ length: 64 }, (_, index) => queued({
      id: `queue-${index}`, deliveryOperationId: `send-${index}`, sequence: index,
    }));
    const first = deferred<QueuedInputPresentation>();
    const second = deferred<QueuedInputPresentation>();
    let targetReads = 0;
    const targetDetail = detail({ queuedInputId: "queue-63", deliveryOperationId: "send-63", content });
    const f = fixture(vi.fn(async (id: string) => {
      if (id === "queue-63") {
        targetReads += 1;
        if (targetReads === 1) return first.promise;
        if (targetReads === 2) return second.promise;
        return targetDetail;
      }
      return detail({ queuedInputId: id, deliveryOperationId: id.replace("queue-", "send-"), state: "accepted", content });
    }));
    f.observe(snapshot(rows));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(64));
    expect(f.tracker.getSnapshot().filter(item => item.content)).toHaveLength(63);
    const dispatching = rows.map(row => row.id === "queue-63"
      ? { ...row, state: "dispatching" as const, deliveryMode: "submit" as const } : row);
    // The first content result belongs to the observation before dispatching.
    f.observe(snapshot(dispatching, 2));
    first.resolve(targetDetail);
    await flush();
    const target = () => f.tracker.getSnapshot().find(item => item.operationId === "send-63")!;
    expect(target().content).toBeUndefined();
    expect(target().contentLoadError).toBeUndefined();
    expect(targetReads).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(targetReads).toBe(2);
    expect(target().contentLoadError).toBeUndefined();
    // The automatic retry is in flight, so the UI must still show loading.
    f.tracker.retryContent("send-63");
    await flush();
    expect(targetReads).toBe(2);
    second.resolve(targetDetail);
    await flush();
    expect(target().contentLoadError).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(targetReads).toBe(9); // One superseded read plus eight current attempts.
    expect(target()).toMatchObject({ phase: "sending", contentLoadError: true });

    f.observe(snapshot(dispatching.slice(1), 3, [userItem("send-0")]));
    f.read.mockResolvedValue({ ...targetDetail, state: "accepted", threadRevision: 3 });
    f.tracker.retryContent("send-63");
    expect(target().contentLoadError).toBeUndefined();
    await flush();
    expect(f.read).toHaveBeenCalledTimes(73);
    expect(target()).toMatchObject({ phase: "accepted", content });
    expect(target().contentLoadError).toBeUndefined();
  });

  it.each([1, 8])("resumes an accepted submission's missing content after authority interrupts read attempt %s", async interruptedAttempt => {
    vi.useFakeTimers();
    const content: QueuedInputPresentation["content"] = [{ kind: "text", text: { text: "a".repeat(256 * 1_024) } }];
    const rows = Array.from({ length: 64 }, (_, index) => queued({
      id: `queue-${index}`, deliveryOperationId: `send-${index}`, sequence: index,
    }));
    const f = fixture(vi.fn(async (id: string) => detail({
      queuedInputId: id, deliveryOperationId: id.replace("queue-", "send-"), state: "accepted", content,
    })));
    f.observe(snapshot(rows));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(64));
    const target = () => f.tracker.getSnapshot().find(item => item.operationId === "send-63")!;
    expect(target()).toMatchObject({ phase: "accepted", contentLoadError: true });

    const interrupted = deferred<QueuedInputPresentation>();
    let attempts = 0;
    f.read.mockImplementation(async () => {
      attempts += 1;
      if (attempts === interruptedAttempt) return interrupted.promise;
      throw new Error("Content read temporarily unavailable");
    });
    f.tracker.retryContent("send-63");
    await flush();
    if (interruptedAttempt === 8) await vi.advanceTimersByTimeAsync(61_500);
    expect(attempts).toBe(interruptedAttempt);
    expect(target().contentLoadError).toBeUndefined();
    const interruptedSignal = f.read.mock.calls.at(-1)![1];
    f.observe(snapshot(rows), false);
    expect(interruptedSignal.aborted).toBe(true);

    const resumed = deferred<QueuedInputPresentation>();
    f.read.mockImplementation(() => resumed.promise);
    f.observe(snapshot(rows));
    await flush();
    expect(f.read).toHaveBeenCalledTimes(65 + interruptedAttempt);
    expect(f.read.mock.calls.at(-1)![1]).not.toBe(interruptedSignal);
    expect(target()).toMatchObject({ phase: "accepted" });
    expect(target().contentLoadError).toBeUndefined();
    // A late cancellation response from the aborted request cannot retire
    // the accepted input or decide the resumed read's outcome.
    const retained = detail({ queuedInputId: "queue-63", deliveryOperationId: "send-63", content });
    interrupted.resolve({ ...retained, state: "cancelled" });
    await flush();
    expect(target().phase).toBe("accepted");
    resumed.resolve({ ...retained, state: "accepted" });
    await flush();
    expect(target()).toMatchObject({ phase: "accepted", contentLoadError: true });

    f.observe(snapshot(rows.slice(1), 2, [userItem("send-0")]));
    f.read.mockResolvedValue({ ...retained, state: "accepted", threadRevision: 2 });
    f.tracker.retryContent("send-63");
    await flush();
    expect(target().content).toEqual(content);
    expect(target().contentLoadError).toBeUndefined();
  });
});
