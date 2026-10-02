import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import { backendCapabilityDocumentSchema } from "../../src/shared/protocol/backend.js";
import { OpenCodeExecutionSettings } from "../../src/server/backends/opencode/opencode-execution-settings.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { findOpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OPENCODE_HISTORY_LIMITS } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const messages = (count = 1): SessionMessageInfo[] => Array.from({ length: count }, (_, index): SessionMessageInfo[] => [
  { id: `msg_user_${index}`, type: "user", text: `Question ${index}`, time: { created: index * 3 + 1 } },
  { id: `msg_answer_${index}`, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
    content: [{ type: "text", text: `Answer ${index}` }], time: { created: index * 3 + 2, completed: index * 3 + 3 } },
  { id: `msg_idle_${index}`, type: "idle", outcome: "succeeded", time: { created: index * 3 + 3 } },
]).flat();
function setup(count = 1) {
  const current = createOpenCodeConversationFixture({ messages: messages(count) });
  cleanup.push(current.dispose); return current;
}
async function open(current: ReturnType<typeof setup>) {
  const reader = await current.driver.openHistory(current.target); cleanup.push(() => reader.close()); return reader;
}

describe("OpenCode detached conversation history", () => {
  it("captures immutable paged history without attaching or acquiring execution machinery", async () => {
    const current = setup(14);
    const admit = vi.spyOn(current.context.tools, "admit");
    const accounting = vi.spyOn(current.context.usage, "acquire");
    const settings = vi.spyOn(OpenCodeExecutionSettings.prototype, "observe");
    const reader = await open(current);
    expect(current.runtime.start).not.toHaveBeenCalled();
    const initial = await reader.readSnapshot({ signal: signal() });
    expect(initial.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(initial.history).toMatchObject({ operational: true, previousCursor: expect.any(String) });
    expect(current.runtime.snapshot().references).toBe(0);
    expect(current.attached).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    expect(accounting).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    expect(current.hostHooks.installSessionEnvironment).not.toHaveBeenCalled();
    expect(findOpenCodeInputObserver(current.port, current.target)).toBeUndefined();
    expect(current.wire.requests.every(request => request.method === "GET")).toBe(true);
    const reads = current.wire.requests.length;
    current.wire.messages.splice(0, current.wire.messages.length, ...messages(1));
    const older = await reader.history({ cursor: initial.history.previousCursor, limit: 10, signal: signal() });
    expect(older.orderedBackendTurnIds).toHaveLength(4);
    expect(new Set([...older.orderedBackendTurnIds, ...initial.snapshot.orderedBackendTurnIds]).size).toBe(14);
    const oldest = older.orderedBackendTurnIds[0]!;
    expect(await reader.locateTurn({ maximumTurnCandidates: 13, matchesBackendTurnId: id => id === oldest, signal: signal() }))
      .toEqual({ status: "search_limit_reached" });
    expect(await reader.locateTurn({ maximumTurnCandidates: 14, matchesBackendTurnId: id => id === oldest, signal: signal() }))
      .toMatchObject({ status: "found", page: { orderedBackendTurnIds: [oldest] } });
    expect(await reader.readSnapshot({ signal: signal() })).toEqual(initial);
    expect(await reader.usage()).toMatchObject({ counters: { userMessages: 14, assistantMessages: 14, totalMessages: 28 } });
    expect(current.wire.requests).toHaveLength(reads);
    expect(backendCapabilityDocumentSchema.parse(await reader.backendCapabilities())).toMatchObject({ actions: [], supportsHistory: true, deliveryModes: [] });
    await reader.close();
    await expect(reader.history({ limit: 1, signal: signal() })).rejects.toMatchObject({ backendCode: "opencode_history_cancelled" });
  });

  it("rejects another reader's cursors", async () => {
    const current = setup(12), first = await open(current), second = await open(current);
    const initial = await first.readSnapshot({ signal: signal() });
    await expect(second.history({ cursor: initial.history.previousCursor, limit: 10, signal: signal() }))
      .rejects.toMatchObject({ backendCode: "opencode_history_cursor" });
    expect(current.runtime.snapshot().references).toBe(0);
  });

  it("denies wrong scope and pre-cancelled reads before runtime acquisition", async () => {
    const current = setup();
    await expect(current.driver.openHistory({ ...current.target, scope: { ...scope, principalId: "other" } }))
      .rejects.toMatchObject({ category: "permission_denied" });
    const aborted = AbortSignal.abort();
    await expect(current.driver.openHistory({ ...current.target, signal: aborted })).rejects.toMatchObject({ backendCode: "opencode_request_aborted" });
    const reader = await open(current);
    await expect(reader.readSnapshot({ signal: aborted })).rejects.toMatchObject({ backendCode: "opencode_history_cancelled" });
    expect(current.runtime.start).not.toHaveBeenCalled(); expect(current.runtime.acquire).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close"])("releases pending native acquisition on %s", async method => {
    const current = setup(), reader = await open(current), controller = new AbortController();
    const held = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const read = expect(reader.readSnapshot({ signal: controller.signal })).rejects.toMatchObject({ backendCode: "opencode_history_cancelled" });
    await held.entered;
    if (method === "cancel") controller.abort(); else await reader.close();
    await read;
    await vi.waitFor(() => expect(current.runtime.snapshot().references).toBe(0));
    held.release();
  });

  it("invalidates a changed native cut and allows a fresh bounded acquisition", async () => {
    const current = setup(), reader = await open(current);
    const held = current.wire.hold(`/api/session/${current.wire.sessionID}/message`);
    const read = expect(reader.readSnapshot({ signal: signal() })).rejects.toMatchObject({ backendCode: "opencode_history_invalidated" });
    await held.entered;
    current.wire.send({ id: "evt_history_reverted", created: 5, type: "session.revert.cleared",
      data: { sessionID: current.wire.sessionID }, durable: { aggregateID: current.wire.sessionID, seq: 1, version: 1 } });
    held.release(); await read;
    expect(current.runtime.snapshot().references).toBe(0);
    expect((await reader.readSnapshot({ signal: signal() })).snapshot.orderedBackendTurnIds).toHaveLength(1);
  });

  it("enforces native byte limits without retaining its runtime lease", async () => {
    const current = setup(), reader = await open(current);
    vi.spyOn(OpenCodeNativeApi.prototype, "getHistoryPage").mockResolvedValue({
      data: [], cursor: {}, decodedBytes: OPENCODE_HISTORY_LIMITS.decodedBytes + 1,
    });
    await expect(reader.readSnapshot({ signal: signal() })).rejects.toMatchObject({ backendCode: "opencode_history_limit_bytes" });
    expect(current.runtime.snapshot().references).toBe(0);
  });

  it("uses durable correlations without observing or changing input evidence", async () => {
    const current = setup(), binding = current.target.binding;
    const evidence = new OpenCodeInputEvidenceRepository(current.repository);
    current.repository.reserveOperation(scope, { applicationThreadId: binding.applicationThreadId, connectionProfileId: binding.connectionProfileId,
      executionEnvironmentId: binding.executionEnvironmentId, nativeSessionId: binding.backendConversationId,
      applicationOperationId: "operation", operationKind: "submit", nativeInputId: "msg_user_0", requestFingerprint: "a".repeat(64),
      requestSource: { kind: "user" }, deadlineAt: null }, Date.now());
    evidence.begin(scope, binding.applicationThreadId, "operation", "submit", "tracker", "queue");
    current.repository.markDispatched(scope, binding.applicationThreadId, "operation", "submit", Date.now());
    evidence.consume(scope, binding.applicationThreadId, "operation", "submit", "b".repeat(64));
    const before = current.database.serialize();
    const reader = await open(current), result = await reader.readSnapshot({ signal: signal() });
    expect(Object.values(result.snapshot.itemsById)).toContainEqual(expect.objectContaining({ deliveryOperationId: "operation" }));
    expect(current.database.serialize()).toEqual(before);
    expect(findOpenCodeInputObserver(current.port, current.target)).toBeUndefined();
  });
});
