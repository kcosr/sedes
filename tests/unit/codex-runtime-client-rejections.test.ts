import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CodexRuntimeReceiptStore } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";
import { codexRuntimeMethod, type CodexRuntimeAuthority, type CodexRuntimeConnection, type CodexRuntimeEvent, type CodexRuntimeOutcome } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import { CodexRpcRemoteError, codexSteerRejectionReason } from "../../src/server/backends/codex/rpc/errors.js";

const authority: CodexRuntimeAuthority = { scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: "runtime", controllerId: "controller" };
const method = codexRuntimeMethod("turn/steer");
const params = { threadId: "thread", expectedTurnId: "turn", input: [{ type: "text", text: "input", text_elements: [] }] };
const options = { timeoutMilliseconds: 1000, runtimeCorrelation: { kind: "steer" as const, applicationOperationId: "application-operation", applicationThreadId: "application-thread" } };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture(message = "no active turn to steer", code = -32600) {
  const database = new Database(":memory:");
  initializeEmptyBackendNormalizedDatabase(database);
  cleanup.push(() => { database.close(); });
  const receipts = new CodexRuntimeReceiptStore(database);
  let listener!: (event: CodexRuntimeEvent) => void;
  let latest!: CodexRuntimeOutcome;
  const acknowledge = vi.fn(async () => {});
  const submit = vi.fn(async (_: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["submit"]>[1]): Promise<CodexRuntimeOutcome> => {
    latest = { status: "failed", operationId: input.operationId, method: input.method,
      failure: { kind: "remote", code, message, generation: 1, method: input.method } };
    return latest;
  });
  const connection: CodexRuntimeConnection = {
    attach: async (_, receive) => { listener = receive; return { protocolVersion: 1, runtimeId: authority.runtimeId,
      lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, pendingRequests: [], outcomes: [] }; },
    evictThread: async () => {},
    detach: async () => {}, submit, acknowledge, outcome: async () => latest,
    respond: async () => {}, retire: async () => {}, reattachThread: async () => undefined,
  };
  const attachmentFailure = vi.fn();
  const remote = new CodexRuntimeClient({ connection, authority, receipts, onAttachmentFailure: attachmentFailure });
  cleanup.push(() => remote.close());
  return { remote, connection, receipts, database, submit, acknowledge, attachmentFailure,
    duplicate: (transform: (outcome: CodexRuntimeOutcome) => CodexRuntimeOutcome = outcome => outcome) => listener({ type: "outcome", outcome: transform(latest) }) };
}

describe("Codex persistent rejection handoff", () => {
  it.each([
    ["no active turn to steer", "no_active_turn"],
    ["expected active turn id `old-native-id` but found `new-native-id`", "expected_turn_mismatch"],
  ] as const)("normalizes %s before durable storage and permits a fresh intended retry", async (message, reason) => {
    const f = fixture(message);
    let acknowledge!: () => void;
    f.acknowledge.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: reason });
    expect(f.receipts.pending(authority)[0]?.outcome).toMatchObject({ status: "failed", failure: { rejectionReason: reason } });
    const stored = JSON.stringify(f.database.prepare("SELECT * FROM codex_runtime_receipts").all());
    expect(stored).not.toContain(message);
    expect(stored).not.toContain("old-native-id");
    expect(f.acknowledge).toHaveBeenCalledOnce();
    acknowledge();
    await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
    f.duplicate();
    await Promise.resolve();
    expect(f.attachmentFailure).not.toHaveBeenCalled();
    expect(f.remote.retainedOutcomes()).toEqual([]);
    f.acknowledge.mockResolvedValue();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: reason });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[0]?.[1].operationId).not.toBe(f.submit.mock.calls[1]?.[1].operationId);
  });

  describe.each([
    { name: "thread/start", kind: "create", input: {} },
    { name: "thread/fork", kind: "fork", input: { threadId: "thread" } },
    { name: "turn/start", kind: "start", input: { threadId: "thread", input: params.input } },
    { name: "turn/steer", kind: "steer", input: params },
  ] as const)("definitive overload rejection for $name", ({ name, kind, input }) => {
    const overloadMethod = codexRuntimeMethod(name);
    const overloadOptions = { ...options, runtimeCorrelation: { ...options.runtimeCorrelation, kind } };

    it("retains proof until ACK, suppresses matching buffered duplicates, and admits only an explicit fresh retry", async () => {
      const f = fixture("overloaded", -32001);
      let acknowledge!: () => void;
      f.acknowledge.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
      await f.remote.start();
      await expect(f.remote.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001, disposition: "rejected_not_accepted" });
      expect(f.receipts.pending(authority)[0]?.outcome).toMatchObject({ status: "failed", failure: { code: -32001 } });
      // An explicit retry before ACK only replays the durable no-effect result.
      await expect(f.remote.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001 });
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.acknowledge).toHaveBeenCalledOnce();
      f.duplicate();
      expect(f.receipts.pending(authority)).toHaveLength(1);
      acknowledge();
      await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
      f.duplicate();
      await Promise.resolve();
      expect(f.attachmentFailure).not.toHaveBeenCalled();
      expect(f.remote.retainedOutcomes()).toEqual([]);
      expect(f.submit).toHaveBeenCalledOnce();
      f.acknowledge.mockResolvedValue();
      await expect(f.remote.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001 });
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(f.submit.mock.calls[0]?.[1].operationId).not.toBe(f.submit.mock.calls[1]?.[1].operationId);
      await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
    });

    it("replays durable proof after failed ACK and a new client without resending the native request", async () => {
      const f = fixture("overloaded", -32001);
      f.acknowledge.mockRejectedValue(new Error("carrier lost"));
      await f.remote.start();
      await expect(f.remote.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001 });
      await f.remote.close();
      expect(f.receipts.pending(authority)).toHaveLength(1);
      const recovered = new CodexRuntimeClient({ connection: f.connection, authority, receipts: new CodexRuntimeReceiptStore(f.database) });
      cleanup.push(() => recovered.close());
      await recovered.start();
      f.acknowledge.mockResolvedValue();
      await expect(recovered.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001, disposition: "rejected_not_accepted", message: "Codex previously rejected this operation." });
      expect(f.submit).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
    });

    it("fences a contradictory buffered outcome after releasing the rejection", async () => {
      const f = fixture("overloaded", -32001);
      await f.remote.start();
      await expect(f.remote.client.requestWithReceipt(overloadMethod, input, overloadOptions)).rejects.toMatchObject({ code: -32001 });
      await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
      f.duplicate(outcome => {
        if (outcome.status !== "failed") throw new Error("fixture outcome");
        return { ...outcome, failure: { ...outcome.failure, generation: 2 } };
      });
      await vi.waitFor(() => expect(f.attachmentFailure).toHaveBeenCalledOnce());
      expect(f.submit).toHaveBeenCalledOnce();
    });
  });

  it("replays persisted mismatch without inventing native identifiers, then releases it after ACK", async () => {
    const f = fixture();
    f.receipts.reserve(authority, { operationId: "prior-wire-operation", method: "turn/steer",
      requestFingerprint: createHash("sha256").update(JSON.stringify([method.method, method.encodeParams(params)])).digest("hex"),
      correlation: options.runtimeCorrelation });
    f.receipts.recordOutcome(authority, { status: "failed", operationId: "prior-wire-operation", method: "turn/steer",
      failure: { kind: "remote", code: -32600, generation: 1, rejectionReason: "expected_turn_mismatch" } });
    await f.remote.start();
    const error = await f.remote.client.requestWithReceipt(method, params, options).catch(error => error);
    expect(error).toBeInstanceOf(CodexRpcRemoteError);
    expect(error).toMatchObject({ rejectionReason: "expected_turn_mismatch", message: "Codex previously rejected this operation." });
    expect(f.submit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.receipts.pending(authority)).toEqual([]));
  });

  it("keeps durable rejection proof when ACK fails and replays it without another native submission", async () => {
    const f = fixture();
    f.acknowledge.mockRejectedValue(new Error("carrier lost"));
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: "no_active_turn" });
    expect(f.receipts.pending(authority)).toHaveLength(1);
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: "no_active_turn" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.receipts.pending(authority)).toHaveLength(1);
  });

  it.each([
    ["no active turn to steer ", -32600],
    ["no active turn to steer", -32603],
    ["native failed after applying part of the request", -32600],
  ] as const)("preserves general or inexact rejection %s (%s)", async (message, code) => {
    const f = fixture(message, code);
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: undefined });
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ rejectionReason: undefined });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.receipts.pending(authority)).toHaveLength(1);
  });

  it("retains uncertain delivery and never acknowledges if SQLite cannot record the result", async () => {
    const f = fixture();
    f.database.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON codex_runtime_receipts BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;");
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ delivery: "sent_outcome_unknown", message: "codex_runtime_receipt_record_unconfirmed" });
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.receipts.pending(authority)[0]?.state).toBe("reserved");
  });

  it("returns an accepted result even when immediate ACK failure triggers carrier recovery", async () => {
    const f = fixture();
    f.submit.mockImplementation(async (_, input) => ({ status: "completed", operationId: input.operationId,
      method: "turn/steer", receipt: { result: { turnId: "accepted-turn" }, generation: 1, inboundSequence: 7 } }));
    f.acknowledge.mockRejectedValue(new Error("ACK carrier lost"));
    f.attachmentFailure.mockImplementation(() => f.remote.disconnected());
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).resolves.toMatchObject({ result: { turnId: "accepted-turn" } });
    expect(f.receipts.pending(authority)[0]?.outcome).toMatchObject({ status: "completed", nativeTurnId: "accepted-turn" });
    expect(f.attachmentFailure).toHaveBeenCalledOnce();
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)("releases only a proven delivery rejection: %s", async (delivery) => {
    const f = fixture();
    f.submit.mockImplementation(async (_, input) => ({ status: "failed", operationId: input.operationId,
      method: "turn/steer", failure: { kind: "delivery", code: "transport_failure", delivery, generation: 1, method: "turn/steer" } }));
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ delivery });
    await vi.waitFor(() => expect(f.receipts.pending(authority)).toHaveLength(delivery === "not_sent" ? 0 : 1));
  });

  it("classifies only the steer method and exact bounded native mismatch form", () => {
    expect(codexSteerRejectionReason({ method: "turn/start", code: -32600, message: "no active turn to steer" })).toBeUndefined();
    expect(codexSteerRejectionReason({ method: "turn/steer", code: -32600, message: `expected active turn id \`${"x".repeat(161)}\` but found \`y\`` })).toBeUndefined();
  });
});

describe("Codex attachment failure diagnostics", () => {
  function logs() {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[delivery-attachment] "))
      .map(line => JSON.parse(line.slice("[delivery-attachment] ".length)));
  }

  it("identifies SQLite recording as the failing stage before any ACK and retains uncertainty", async () => {
    const records = logs();
    const f = fixture("private-provider-output");
    f.database.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON codex_runtime_receipts BEGIN SELECT RAISE(ABORT, 'private-database-error'); END;");
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).rejects.toMatchObject({ message: "codex_runtime_receipt_record_unconfirmed" });
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(records()).toContainEqual(expect.objectContaining({ event: "stage_failed", stage: "receipt_record", method: "turn/steer",
      operationId: f.submit.mock.calls[0]![1].operationId, backendInstanceId: "backend", executionEnvironmentId: "remote", generation: 1,
      durationMs: expect.any(Number), errors: [{ name: "SqliteError", code: "SQLITE_CONSTRAINT_TRIGGER" }] }));
    expect(JSON.stringify(records())).not.toMatch(/private|expectedTurnId|application-thread/u);
  });

  it("reports ACK failure while delivering the already accepted result", async () => {
    const records = logs();
    const f = fixture();
    const error = new Error("sidecar_carrier_failed", { cause: new Error("private-cause") });
    f.submit.mockImplementation(async (_, input) => ({ status: "completed", operationId: input.operationId, method: "turn/steer",
      receipt: { result: { turnId: "private-native-turn" }, generation: 1, inboundSequence: 7 } }));
    f.acknowledge.mockRejectedValue(error);
    f.attachmentFailure.mockImplementation(() => f.remote.disconnected());
    await f.remote.start();
    await expect(f.remote.client.requestWithReceipt(method, params, options)).resolves.toMatchObject({ result: { turnId: "private-native-turn" } });
    expect(f.attachmentFailure).toHaveBeenCalledWith({ stage: "receipt_acknowledge", error, operationId: f.submit.mock.calls[0]![1].operationId });
    expect(records()).toContainEqual(expect.objectContaining({ event: "stage_failed", stage: "receipt_acknowledge", deferred: expect.any(Boolean),
      durationMs: expect.any(Number), errors: [{ name: "Error", code: "sidecar_carrier_failed" }, { name: "Error" }] }));
    expect(JSON.stringify(records())).not.toContain("private");
  });

  it("reports typed reattach failure without closing the attachment or logging the native thread", async () => {
    const records = logs();
    const f = fixture();
    const error = new CodexRpcRemoteError({ code: -32603, method: "thread/read", generation: 1, message: "private-reattach-error" });
    vi.spyOn(f.connection, "reattachThread").mockRejectedValue(error);
    await f.remote.start();
    await expect(f.remote.client.persistentSessions!.reattachThread("private-native-thread", options)).rejects.toMatchObject({ code: -32603, message: "private-reattach-error" });
    expect(f.attachmentFailure).not.toHaveBeenCalled();
    expect(f.remote.client.lifecycleSnapshot().state).toBe("ready");
    expect(records()).toContainEqual(expect.objectContaining({ event: "stage_failed", stage: "thread_reattach", errors: [{ name: "CodexRpcRemoteError", code: -32603 }] }));
    expect(JSON.stringify(records())).not.toContain("private");
  });
});
