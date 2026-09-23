import { describe, expect, it, vi } from "vitest";
import { CodexSubagentUsageCoordinator } from "../../src/server/backends/codex/codex-subagent-usage.js";
import { CodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-runtime-host.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { RetainedRuntimeLifecycle } from "../../src/server/backends/retained-runtime-lifecycle.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { codexRuntimeMethod } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import { decodeCodexServerNotificationParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { NO_USAGE_CAPTURE, type UsageSink } from "../../src/server/usage/contracts.js";
import type { CodexRuntimeReceiptSink } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" };
const authority = { scope, runtimeId: "runtime", controllerId: "1" };
const binding = { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: "application", backendConversationId: "root",
  backendInstanceId: scope.backendInstanceId, executionEnvironmentId: scope.executionEnvironmentId, connectionProfileId: "connection", createdAt: "2026-09-22T00:00:00Z" };
const receipts: CodexRuntimeReceiptSink = { reserve: () => { throw new Error("not used"); }, recordOutcome: () => "untracked", pending: () => [],
  reconcileRecordedApplicationState: () => 0, releaseRejected: () => false, compactRetiredRuntime: () => 0 };

function resumeResult(active: boolean) {
  return codexRuntimeMethod("thread/resume").decodeResult({
    thread: { id: "child", extra: {}, sessionId: "child-session", forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "openai", model: null, reasoningEffort: null,
      createdAt: 1700000000, updatedAt: 1700000000, recencyAt: 1700000000, status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
      path: "/provider/child.jsonl", cwd: "/workspace", cliVersion: "0.153.0", source: "appServer", canAcceptDirectInput: true,
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] },
    model: "gpt-5.6-luna", modelProvider: "openai", serviceTier: "default", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"], instructionSources: [],
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: { id: ":read-only", extends: null },
    reasoningEffort: "low", multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  });
}

async function fixture(active: boolean, completedBeforeResumeContinuation = false, options: { failure?: "thread/loaded/list" | "thread/resume"; persistedIdle?: boolean } = {}) {
  let sequence = 0;
  const dispatch = vi.fn(async (method: { method: string }, params: unknown) => {
    if (method.method === options.failure) throw new Error("fixture_recovery_unavailable");
    if (method.method === "thread/loaded/list") return { result: { data: ["child"], nextCursor: null }, generation: 1, inboundSequence: ++sequence };
    if (method.method === "thread/resume") {
      expect(params).toEqual({ threadId: "child", excludeTurns: true });
      const inboundSequence = ++sequence;
      // A transport batch resolves the native response first, then delivers a
      // later notification before the host's promise continuation executes.
      if (completedBeforeResumeContinuation) complete();
      return { result: resumeResult(active), generation: 1, inboundSequence };
    }
    throw new Error(`Unexpected native request: ${method.method}`);
  });
  const native = new CodexSharedClientFacade({ current: () => ({ generation: 1, request: async () => undefined as never, requestWithReceipt: dispatch as never }),
    latestGeneration: () => 1, retireGeneration: async () => undefined });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  host.bind(native);
  const evict = vi.spyOn(host, "evictThread");
  const remote = new CodexRuntimeClient({ connection: host, authority, receipts });
  await remote.start();
  const errors: unknown[] = [];
  const retire = vi.fn(async () => {
    await remote.drainAcknowledgements();
    return await host.idle(authority, 1, async () => undefined);
  });
  const residency = new RetainedRuntimeLifecycle({ wake: () => undefined, retire: async () => { await retire(); } });
  const rootLease = residency.retain();
  const presentation = new CodexSharedClientFacade({ residency, persistentSessions: remote.client.persistentSessions,
    current: () => ({ generation: remote.client.lifecycleSnapshot().generation,
      request: (...args) => remote.client.request(...args), requestWithReceipt: (...args) => remote.client.requestWithReceipt(...args) }),
    latestGeneration: () => remote.client.lifecycleSnapshot().generation, retireGeneration: async () => undefined });
  remote.client.subscribeLifecycle(state => presentation.updateLifecycle(state));
  remote.client.subscribeNotifications(notification => presentation.forwardNotification(notification.generation, notification));
  const gap = vi.fn(), seal = vi.fn();
  const open = vi.fn(() => ({ ...NO_USAGE_CAPTURE, gap, seal }));
  const sink: UsageSink = { open, findSubagent: () => null, listSubagentRoots: () => ({ bindings: [binding], nextCursor: null }),
    listSubagents: () => [{ nativeSession: "child", nativeParentSession: "root", epoch: "native-counter-v1", normalizationVersion: "codex-subagent-usage-v1", captureState: options.persistedIdle ? "idle" : "disconnected" }] };
  new CodexSubagentUsageCoordinator({ client: presentation, sink, nativeNamespace: "native-store", runtimeScope: { ...scope, connectionProfileId: binding.connectionProfileId },
    onError: error => errors.push(error) });
  const complete = () => native.forwardNotification(1, { kind: "decoded_notification", generation: 1, sequence: ++sequence, method: "turn/completed",
    params: decodeCodexServerNotificationParams("turn/completed", { threadId: "child", turn: { id: "child-turn", items: [], itemsView: "full", status: "completed",
      error: null, startedAt: 1700000000, completedAt: 1700000001, durationMs: 1000 } }) });
  return { native, host, remote, dispatch, evict, errors, complete, rootLease, retire, gap, seal, open };
}

describe("Codex subagent accounting on the persistent runtime host", () => {
  it.each(["thread/loaded/list", "thread/resume"] as const)("does not retain residency when lightweight recovery fails at %s", async failure => {
    const f = await fixture(false, false, { failure });
    try {
      await vi.waitFor(() => expect(f.errors).toHaveLength(1));
      await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(0));
      await f.rootLease.release(true);
      await vi.waitFor(() => expect(f.retire).toHaveBeenCalled());
      expect(await f.retire.mock.results.at(-1)!.value).toBe(true);
      expect(f.gap).toHaveBeenCalledWith("capture_gap");
    } finally { await f.remote.close(); }
  });

  it("keeps a durably completed child idle across reconnect without reopening capture or inventing a gap", async () => {
    const f = await fixture(false, false, { persistedIdle: true });
    try {
      await new Promise(done=>setImmediate(done));
      expect(f.evict).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
      f.native.updateLifecycle({ state: "unavailable", generation: 1 });
      f.native.updateLifecycle({ state: "ready", generation: 1 });
      await new Promise(done=>setImmediate(done));
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.evict).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(0));
      expect(f.open).not.toHaveBeenCalled();
      expect(f.seal).not.toHaveBeenCalled();
      expect(f.gap).not.toHaveBeenCalled();
      await f.rootLease.release(true);
      expect(await f.retire.mock.results.at(-1)!.value).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.remote.close(); }
  });

  it("re-establishes a lightweight subscription then releases an idle child so the host can idle", async () => {
    const f = await fixture(false);
    try {
      await vi.waitFor(() => expect(f.evict).toHaveBeenCalledWith(authority, "child", 1));
      await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(0));
      const retire = vi.fn(async () => undefined);
      expect(await f.host.idle(authority, 1, retire)).toBe(true);
      expect(retire).toHaveBeenCalledOnce();
      expect(f.dispatch.mock.calls.map(([method]) => method.method)).toEqual(["thread/loaded/list", "thread/resume"]);
      expect(f.errors).toEqual([]);
    } finally { await f.remote.close(); }
  });

  it("preserves a newer child completion delivered before the resume response continuation", async () => {
    const f = await fixture(true, true);
    try {
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(0));
      // Explicitly perform the known-correct release to isolate host registry
      // ordering from the coordinator's separate eviction responsibility.
      await f.host.evictThread(authority, "child", 1);
      const retire = vi.fn(async () => undefined);
      expect(await f.host.idle(authority, 1, retire)).toBe(true);
      expect(retire).toHaveBeenCalledOnce();
    } finally { await f.remote.close(); }
  });

  it("keeps an active recovered child resident until its completion and then permits host idle", async () => {
    const f = await fixture(true);
    try {
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(0));
      const retire = vi.fn(async () => undefined);
      expect(await f.host.idle(authority, 1, retire)).toBe(false);
      expect(f.evict).not.toHaveBeenCalled();
      f.complete();
      await vi.waitFor(() => expect(f.evict).toHaveBeenCalledWith(authority, "child", 1));
      await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
      // The queued eviction finishes after the native completion callback.
      // It must wake idle retirement without another provider request/event.
      expect(f.dispatch).toHaveBeenCalledTimes(2);
      expect(f.errors).toEqual([]);
    } finally { await f.remote.close(); }
  });
});
