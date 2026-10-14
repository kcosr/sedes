import { describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot, QueuedInputSummary } from "../../../shared/index.js";
import { pageResponseUnavailableReason } from "./page-response-services.js";
import { ServerSubmissionTracker } from "../../stores/ServerSubmissionTracker.js";

function state(input: { bound?: boolean; submit?: boolean; queue?: boolean; recovery?: boolean } = {}) {
  return {
    authoritative: true, connection: "connected" as const,
    snapshot: {
      thread: { backingState: input.bound === false ? "unbound" : "bound" },
      // A dormant bound thread has no active provider turn or actor context.
      capabilities: { deliveryModes: [
        { id: "submit", available: input.submit ?? true },
        { id: "queue", available: input.queue ?? false },
      ] },
      ...(input.recovery ? { recovery: { operationId: "uncertain" } } : {}),
    } as NormalizedThreadSnapshot,
  };
}

describe("page response eligibility", () => {
  it("allows dormant bound threads and busy threads with queue capability", () => {
    expect(pageResponseUnavailableReason(state())).toBeUndefined();
    expect(pageResponseUnavailableReason(state({ submit: false, queue: true }))).toBeUndefined();
  });
  it("requires bound current authority and available delivery without bypassing recovery", () => {
    expect(pageResponseUnavailableReason(state({ bound: false }))).toMatch(/not bound/);
    expect(pageResponseUnavailableReason({ ...state(), authoritative: false })).toMatch(/reconnect/);
    expect(pageResponseUnavailableReason({ ...state(), connection: "disconnected" })).toMatch(/reconnect/);
    expect(pageResponseUnavailableReason(state({ submit: false, queue: false }))).toMatch(/unavailable/);
    expect(pageResponseUnavailableReason(state({ recovery: true }))).toMatch(/Reconcile/);
  });
  it("does not duplicate admitted page rows in the ordinary composer submission tracker", () => {
    const read = vi.fn();
    const tracker = new ServerSubmissionTracker({ threadId: "thread", read, nextSequence: () => 1, changed: vi.fn() });
    const row: QueuedInputSummary = {
      id: "queued-page", deliveryOperationId: "operation-page", sequence: 1, state: "pending",
      origin: "user", resolvedDeliveryMode: "submit", isHead: true, preview: { text: "captured" },
      inputOrigin: { kind: "page_response", pageId: "30000000-0000-4000-8000-000000000001", revision: 1, title: "Setup" },
      attachmentCount: 0, taskCount: 0, createdAt: "2026-10-14T12:00:00.000Z",
    };
    tracker.observe({ thread: { threadRevision: 1 }, queue: [row], orderedTurnIds: [], turnsById: {}, itemsById: {} }, true, new Set());
    expect(tracker.getSnapshot()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    tracker.dispose();
  });
});
