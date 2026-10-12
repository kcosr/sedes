import { afterEach, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { ApiClient } from "./ApiClient.js";

const thread: NormalizedApplicationThreadSummary = {
  id: "thread/one", workspaceId: "workspace", targetId: "target", title: { text: "Older fork" },
  backend: { label: { text: "Pi" }, brand: "pi" }, backingState: "bound", inventoryState: "active",
  inventoryRevision: 0, threadRevision: 0, runState: "idle", available: true,
  lastActivityAt: "2026-10-12T00:00:00.000Z", stateChangedAt: "2026-10-12T00:00:00.000Z", automation: null,
  terminalSummary: { runningCount: 0, retainedCount: 0 }, pinned: false, pinRevision: 0,
  preferredWorktree: null, preferredWorktreeRevision: 0, bookmarkRevision: 0, turnBookmarkCount: 0,
  groupId: null, groupAssignmentRevision: 0, queuedInputCount: 0, stashedPromptCount: 0,
  nonArchivedWorkpadCount: 0, pendingQuestionCount: 0,
  attention: { wake: false, automationContext: null, unseenCompletion: false, queueFailure: false },
};
afterEach(() => vi.unstubAllGlobals());

it("reads the authorized summary with an escaped ID and cancellable request", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(thread));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await expect(new ApiClient().readThreadSummary(thread.id, controller.signal)).resolves.toEqual(thread);
  expect(fetch.mock.calls[0]![0]).toBe("/api/threads/thread%2Fone/summary");
  expect(fetch.mock.calls[0]![1].signal).toBe(controller.signal);
});

it.each([{ ...thread, id: "other" }, { id: thread.id }])("rejects an unrelated or incomplete summary", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  await expect(new ApiClient().readThreadSummary(thread.id)).rejects.toThrow();
});

it("preserves inaccessible/missing thread errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: {
    code: "not_found", message: "Thread not found.", retryable: false,
  } }, { status: 404 })));
  await expect(new ApiClient().readThreadSummary(thread.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
});
