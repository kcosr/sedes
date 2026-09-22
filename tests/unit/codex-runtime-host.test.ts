import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-runtime-host.js";
import { CodexRuntimeSessions } from "../../src/server/backends/codex/runtime/codex-runtime-sessions.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { codexRuntimeMethod, type CodexRuntimeAuthority, type CodexRuntimeEvent } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import type { CodexRpcRequestReceipt, CodexInboundServerRequest } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { decodeCodexServerRequestParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { CodexRuntimeReceiptSink } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" };
const authority: CodexRuntimeAuthority = { scope, runtimeId: "runtime", controllerId: "1" };
const request = { operationId: "operation", generation: 1, method: "thread/name/set" as const, params: { threadId: "thread", name: "name" }, timeoutMilliseconds: 1000 };
const modelResult = { data: [], nextCursor: null };
function fixture() {
  let settle!: (value: CodexRpcRequestReceipt<unknown>) => void;
  const promise = new Promise<CodexRpcRequestReceipt<unknown>>(resolve => { settle = resolve; });
  const dispatch = vi.fn(async () => await promise);
  const client = new CodexSharedClientFacade({
    current: () => ({ generation: 1, request: async () => modelResult as never, requestWithReceipt: dispatch as never }),
    latestGeneration: () => 1, retireGeneration: async () => undefined,
  });
  client.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  host.bind(client);
  const events: CodexRuntimeEvent[] = [];
  return { host, client, dispatch, events, settle, connect: () => host.attach(authority, event => events.push(event)) };
}
const sink: CodexRuntimeReceiptSink = { reserve: () => { throw new Error("not used"); }, recordOutcome: () => "untracked", pending: () => [], reconcileRecordedApplicationState: () => 0, releaseRejected: () => false, compactRetiredRuntime: () => 0 };

describe("persistent Codex runtime ownership", () => {
  it("reports a refused resume tracker allocation as not sent without dispatching native work", async () => {
    const f = fixture();
    await f.connect();
    const tracker = vi.spyOn(CodexRuntimeSessions.prototype, "trackResume").mockImplementationOnce(() => {
      throw new Error("codex_runtime_resume_already_pending");
    });
    try {
      await f.host.submit(authority, { ...request, method: "thread/resume", params: { threadId: "thread", excludeTurns: true } });
      await vi.waitFor(() => expect(f.host.readRetainedOutcome(request.operationId)).toMatchObject({ status: "failed", method: "thread/resume",
        failure: { kind: "delivery", code: "codex_runtime_resume_already_pending", delivery: "not_sent", generation: 1, method: "thread/resume" } }));
      expect(f.dispatch).not.toHaveBeenCalled();
      await f.host.acknowledge(authority, request.operationId);
    } finally { tracker.mockRestore(); }
  });

  it("uses definitions identity rather than resolved environment values for replay", async () => {
    const f = fixture(); await f.connect();
    const input = { ...request, method: "thread/start" as const,
      params: { config: { shell_environment_policy: { set: { PROVIDER_KEY: "secret-one", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "generated-one" } } } },
      environmentVariablesFingerprint: "a".repeat(64),
    };
    await f.host.submit(authority, input);
    await f.host.submit(authority, { ...input, params: { config: { shell_environment_policy: { set: { PROVIDER_KEY: "secret-two", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "generated-two" } } } } });
    await expect(f.host.submit(authority, { ...input, environmentVariablesFingerprint: "b".repeat(64) })).rejects.toThrow("operation_conflict");
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledOnce());
    expect(f.dispatch.mock.calls[0]).toBeDefined();
  });

  it.each(["wake", "detach", "replacement"])("cancels deferred idle retirement on %s before an old read finishes", async action => {
    const f = fixture();
    await f.connect();
    const read = f.host.submit(authority, { ...request, method: "model/list", params: {} });
    const retire = vi.fn(async () => {});
    expect(await f.host.idle(authority, 1, retire)).toBe(false);
    if (action === "wake") f.host.cancelIdle();
    else if (action === "detach") await f.host.detach(authority);
    else await f.host.attach({ ...authority, controllerId: "replacement" }, () => {});
    f.settle({ result: modelResult, generation: 1, inboundSequence: 1 });
    await read;
    expect(retire).not.toHaveBeenCalled();
  });

  it("does not remove a later Stop admission fence when idle cleanup completes", async () => {
    const f = fixture();
    await f.connect();
    let finish!: () => void;
    const idle = f.host.idle(authority, 1, () => new Promise<void>(resolve => { finish = resolve; }));
    f.host.freezeAdmission();
    finish();
    await idle;
    await expect(f.host.submit(authority, request)).rejects.toThrow("draining");
  });

  it("defers an unconfirmed remote eviction without poisoning main's handle cleanup", async () => {
    const f = fixture();
    const failure = new Error("carrier_closed");
    vi.spyOn(f.host, "evictThread").mockRejectedValueOnce(failure);
    const report = vi.fn();
    const lost = vi.fn();
    const remote = new CodexRuntimeClient({ connection: f.host, authority, receipts: sink, onIdleReleaseError: report, onAttachmentFailure: lost });
    await remote.start();
    await expect(remote.client.persistentSessions!.detachThread("thread", 1, true)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(failure);
    expect(lost).toHaveBeenCalledOnce();
    await remote.close();
  });

  it("keeps in-flight reads and retained outcomes alive during an idle release", async () => {
    const f = fixture();
    await f.connect();
    const retire = vi.fn(async () => { f.client.updateLifecycle({ state: "idle", generation: 1 }); });
    const read = f.host.submit(authority, { ...request, method: "model/list", params: {} });
    await expect(f.host.idle(authority, 1, retire)).resolves.toBe(false);
    await f.host.submit(authority, { ...request, operationId: "mutation" });
    f.settle({ result: modelResult, generation: 1, inboundSequence: 1 });
    await read;
    await vi.waitFor(() => expect(f.host.readRetainedOutcome("mutation").status).toBe("completed"));
    await expect(f.host.idle(authority, 1, retire)).resolves.toBe(false);
    await f.host.acknowledge(authority, "mutation");
    await expect(f.host.idle(authority, 1, retire)).resolves.toBe(true);
    expect(retire).toHaveBeenCalledTimes(1);
    await f.host.detach(authority);
    await expect(f.host.idle(authority, 1, retire)).rejects.toThrow("controller_stale");
  });

  it("emits an eviction only for deliberate idle handle cleanup", async () => {
    const f = fixture();
    const evict = vi.spyOn(f.host, "evictThread");
    const remote = new CodexRuntimeClient({ connection: f.host, authority, receipts: sink });
    await remote.start();
    await remote.client.persistentSessions!.detachThread("thread", 1);
    expect(evict).not.toHaveBeenCalled();
    await remote.client.persistentSessions!.detachThread("thread", 1, true);
    expect(evict).toHaveBeenCalledWith(authority, "thread", 1);
    await remote.close();
    expect(evict).toHaveBeenCalledTimes(1);
  });

  it("force interruption settles sent and queued work distinctly and rejects unanswered requests", async () => {
    const f = fixture();
    await f.connect();
    for (let index = 0; index < 5; index++) await f.host.submit(authority, { ...request, operationId: `stopped_${index}` });
    expect(f.dispatch).toHaveBeenCalledTimes(4);
    const handler = f.host.serverRequests.handlersForGeneration(1)["item/tool/requestUserInput"]!;
    const response = Promise.resolve(handler({ generation: 1, sequence: 1, id: "request", method: "item/tool/requestUserInput", params: {}, signal: new AbortController().signal } as CodexInboundServerRequest<"item/tool/requestUserInput">));
    const assertion = expect(response).rejects.toThrow("operator_stopped");
    f.host.abandonPendingWork();
    await assertion;
    for (let index = 0; index < 5; index++) expect(f.host.readRetainedOutcome(`stopped_${index}`)).toMatchObject({ status: "failed",
      failure: { kind: "delivery", delivery: index < 4 ? "sent_outcome_unknown" : "not_sent" } });
    f.host.restoreAdmission();
    await expect(f.host.submit(authority, { ...request, operationId: "late" })).rejects.toThrow("draining");
    f.settle({ result: {}, generation: 1, inboundSequence: 2 });
    await vi.waitFor(() => expect(f.host.pendingInteractionCount()).toBe(0));
    expect(f.dispatch).toHaveBeenCalledTimes(4);
    expect(f.host.readRetainedOutcome("stopped_0")).toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
  });
  it("uses a free mutation slot while another call remains slow", async () => {
    const method = "thread/name/set" as const;
    const f = fixture();
    let releaseFirst!: (value: CodexRpcRequestReceipt<unknown>) => void;
    f.dispatch.mockImplementationOnce(async () => await new Promise(resolve => { releaseFirst = resolve; }));
    await f.connect();
    const calls = Array.from({ length: 5 }, (_, index) => f.host.submit(authority, {
      ...request, operationId: `parallel_${index}`, method,
      params: request.params,
    }));
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(4));
    const receipt = { result: {}, generation: 1, inboundSequence: 2 };
    f.settle(receipt);
    try {
      // Request five must use a newly free slot, even while request one is
      // unresolved. Fixed round-robin promise lanes would leave it blocked.
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(5));
    } finally {
      releaseFirst(receipt);
      await Promise.all(calls);
    }
  });

  it("accounts for actual mutation data while bounding concurrent native dispatch", async () => {
    const f = fixture();
    await f.connect();
    // The former 128 MiB reservation rejected request five, despite each
    // request needing only a few bytes of retained state.
    for (let index = 0; index < 12; index++) {
      await expect(f.host.submit(authority, { ...request, operationId: `mutation_${index}` })).resolves.toMatchObject({ status: "pending" });
    }
    expect(f.dispatch).toHaveBeenCalledTimes(4);
    expect(f.host.pendingOutcomeCount()).toBe(12);
    await f.host.detach(authority);
    f.settle({ result: {}, generation: 1, inboundSequence: 2 });
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(12));
    const replacement = { ...authority, controllerId: "replacement" };
    const snapshot = await f.host.attach(replacement, () => {});
    expect(snapshot.outcomes).toHaveLength(12);
    expect(snapshot.outcomes.every(outcome => outcome.status === "completed")).toBe(true);
    for (const outcome of snapshot.outcomes) await f.host.acknowledge(replacement, outcome.operationId);
    expect(f.host.pendingOutcomeCount()).toBe(0);
  });

  it("dispatches overlapping reads without filling mutation receipts or waiting for acknowledgements", async () => {
    const f = fixture();
    const record = vi.fn(() => "untracked" as const);
    const acknowledge = vi.spyOn(f.host, "acknowledge");
    const remote = new CodexRuntimeClient({ connection: f.host, authority, receipts: { ...sink, recordOutcome: record } });
    await remote.start();
    const reads = Array.from({ length: 12 }, () => remote.client.requestWithReceipt(codexRuntimeMethod("model/list"), { limit: 10 }, { timeoutMilliseconds: 1000 }));
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(12));
    expect(f.host.pendingOutcomeCount()).toBe(0);
    f.settle({ result: modelResult, generation: 1, inboundSequence: 2 });
    await expect(Promise.all(reads)).resolves.toHaveLength(12);
    expect(f.dispatch).toHaveBeenCalledTimes(12);
    expect(record).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(f.host.pendingOutcomeCount()).toBe(0);
    await remote.close();
  });

  it("returns a metadata read while four unrelated native reads remain slow", async () => {
    const f = fixture();
    let releaseSlow!: (receipt: CodexRpcRequestReceipt<unknown>) => void;
    const slow = new Promise<CodexRpcRequestReceipt<unknown>>(resolve => { releaseSlow = resolve; });
    const receipt = { result: modelResult, generation: 1, inboundSequence: 2 };
    f.dispatch.mockResolvedValue(receipt);
    for (let index = 0; index < 4; index++) f.dispatch.mockImplementationOnce(async () => await slow);
    await f.connect();
    const reads = Array.from({ length: 4 }, (_, index) => f.host.submit(authority, {
      ...request, operationId: `slow_${index}`, method: "model/list", params: { limit: 10 },
    }));
    try {
      await expect(f.host.submit(authority, { ...request, operationId: "fast", method: "model/list", params: { limit: 10 } })).resolves.toMatchObject({ status: "completed" });
      expect(f.dispatch).toHaveBeenCalledTimes(5);
      expect(f.host.pendingOutcomeCount()).toBe(0);
    } finally {
      releaseSlow(receipt);
      await Promise.all(reads);
    }
  });

  it("returns a durably recorded mutation while its carrier acknowledgement is delayed", async () => {
    const f = fixture();
    let releaseAck!: () => void;
    const delayed = new Promise<void>(resolve => { releaseAck = resolve; });
    const originalAck = f.host.acknowledge.bind(f.host);
    vi.spyOn(f.host, "acknowledge").mockImplementation(async (...args) => { await delayed; await originalAck(...args); });
    const record = vi.fn(() => "untracked" as const);
    const remote = new CodexRuntimeClient({ connection: f.host, authority, receipts: { ...sink, recordOutcome: record } });
    await remote.start();
    const result = remote.client.requestWithReceipt(codexRuntimeMethod("thread/name/set"), request.params, { timeoutMilliseconds: 1000 });
    f.settle({ result: {}, generation: 1, inboundSequence: 2 });
    await expect(result).resolves.toMatchObject({ generation: 1, inboundSequence: 2 });
    expect(record).toHaveBeenCalledOnce();
    expect(f.host.pendingOutcomeCount()).toBe(1);
    releaseAck();
    await vi.waitFor(() => expect(f.host.pendingOutcomeCount()).toBe(0));
    await remote.close();
  });

  it("continues admitted work after detach, retains its outcome and never submits a duplicate", async () => {
    const f = fixture();
    await f.connect();
    await expect(f.host.submit(authority, request)).resolves.toMatchObject({ status: "pending" });
    await f.host.detach(authority);
    f.settle({ result: {}, generation: 1, inboundSequence: 7 });
    await vi.waitFor(() => expect(f.host.unsettledCount()).toBe(1));
    const replacement = { ...authority, controllerId: "2" };
    await f.host.attach(replacement, event => f.events.push(event));
    await vi.waitFor(async () => { await expect(f.host.outcome(replacement, "operation")).resolves.toMatchObject({ status: "completed", receipt: { inboundSequence: 7 } }); });
    await f.host.submit(replacement, request);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    await f.host.acknowledge(replacement, "operation");
    expect(f.host.unsettledCount()).toBe(0);
    await expect(f.host.submit(replacement, request)).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("denies every scope axis, stale controllers and conflicting operation replay", async () => {
    const f = fixture(); await f.connect();
    for (const field of ["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId"] as const) {
      await expect(f.host.attach({ ...authority, scope: { ...scope, [field]: "other" } }, () => {})).rejects.toThrow("scope_denied");
    }
    await f.host.submit(authority, request);
    await expect(f.host.submit(authority, { ...request, params: { threadId: "thread", name: "changed" } })).rejects.toThrow("operation_conflict");
    await f.host.attach({ ...authority, controllerId: "2" }, () => {});
    await expect(f.host.acknowledge(authority, request.operationId)).rejects.toThrow("controller_stale");
    await expect(f.host.respond(authority, { generation: 1, requestId: "x", result: {} })).rejects.toThrow("controller_stale");
  });

  it("keeps approvals pending without upstream, replays on attach and rejects conflicting responses", async () => {
    const f = fixture(); await f.connect();
    const controller = new AbortController();
    const params = decodeCodexServerRequestParams("item/tool/requestUserInput", { threadId: "thread", turnId: "turn", itemId: "item", questions: [], isBlocking: true });
    const incoming = { generation: 1, sequence: 9, id: "approval", method: "item/tool/requestUserInput", params, signal: controller.signal } as const;
    const handler = f.host.serverRequests.handlersForGeneration(1)[incoming.method]!;
    const response = handler(incoming);
    await f.host.detach(authority);
    const replacement = { ...authority, controllerId: "2" };
    const snapshot = await f.host.attach(replacement, () => {});
    expect(snapshot.pendingRequests).toHaveLength(1);
    await f.host.respond(replacement, { generation: 1, requestId: "approval", result: { answers: {} } });
    await expect(response).resolves.toEqual({ answers: {} });
    await f.host.respond(replacement, { generation: 1, requestId: "approval", result: { answers: {} } });
    await expect(f.host.respond(replacement, { generation: 1, requestId: "approval", result: { answers: { one: { answers: ["yes"] } } } })).rejects.toThrow("response_conflict");
  });

  it("preserves provider expiration while disconnected", async () => {
    const f = fixture(); await f.connect();
    const controller = new AbortController();
    const handler = f.host.serverRequests.handlersForGeneration(1)["item/tool/requestUserInput"]!;
    const response = Promise.resolve(handler({ generation: 1, sequence: 1, id: "request", method: "item/tool/requestUserInput", params: {}, signal: controller.signal } as CodexInboundServerRequest<"item/tool/requestUserInput">));
    const assertion = expect(response).rejects.toThrow("request_expired");
    await f.host.detach(authority); controller.abort(); await assertion;
    const snapshot = await f.host.attach({ ...authority, controllerId: "2" }, () => {});
    expect(snapshot.pendingRequests).toHaveLength(0);
  });

  it("presents the existing facade and acknowledges only after its outcome sink accepts delivery", async () => {
    const f = fixture();
    const record = vi.fn(() => "untracked" as const);
    const remote = new CodexRuntimeClient({ connection: f.host, authority, receipts: { ...sink, recordOutcome: record } });
    await remote.start();
    const result = remote.client.requestWithReceipt(codexRuntimeMethod("thread/name/set"), { threadId: "thread", name: "name" }, { timeoutMilliseconds: 1000 });
    f.settle({ result: {}, generation: 1, inboundSequence: 2 });
    await expect(result).resolves.toEqual({ result: {}, generation: 1, inboundSequence: 2 });
    expect(record).toHaveBeenCalled();
    expect(f.host.unsettledCount()).toBe(0);
    await remote.close();
    expect(f.client.lifecycleSnapshot().state).toBe("ready");
  });

  it("retains the authoritative host result when durable receipt storage fails", async () => {
    const f = fixture();
    const failed = vi.fn();
    const remote = new CodexRuntimeClient({ connection: f.host, authority,
      receipts: { ...sink, recordOutcome: () => { throw new Error("database_full"); } },
      onAttachmentFailure: failed,
    });
    await remote.start();
    const result = remote.client.requestWithReceipt(codexRuntimeMethod("thread/name/set"), { threadId: "thread", name: "name" }, { timeoutMilliseconds: 1000 });
    const rejected = expect(result).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    f.settle({ result: {}, generation: 1, inboundSequence: 3 });
    await rejected;
    expect(failed).toHaveBeenCalledOnce();
    expect(f.host.pendingOutcomeCount()).toBe(1);
    expect(f.client.lifecycleSnapshot().state).toBe("ready");
    const replacement = await f.host.attach({ ...authority, controllerId: "2" }, () => {});
    expect(replacement.outcomes).toMatchObject([{ status: "completed" }]);
    await remote.close();
  });
});
