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
    f.tracker.retireQueuedInput("queue-1");
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
});
