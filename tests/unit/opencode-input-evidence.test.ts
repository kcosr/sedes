import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeInputEvidenceRepository, openCodeOperationFingerprint, openCodePreparedPayloadFingerprint } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { OpenCodeMutationEvidenceRepository } from "../../src/server/backends/opencode/opencode-mutation-evidence.js";
import { OpenCodeThreadRepository, type OpenCodeOperationKind } from "../../src/server/backends/opencode/opencode-thread-repository.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const base = createOpenCodeConversationFixture(); cleanups.push(base.dispose);
  const evidence = new OpenCodeInputEvidenceRepository(base.repository);
  const mutations = new OpenCodeMutationEvidenceRepository(base.repository);
  const reserve = (kind: OpenCodeOperationKind = "submit", operationId = "operation", nativeInputId: string | null = "msg_owned") =>
    base.repository.reserveOperation(scope, { applicationThreadId: threadID,
      connectionProfileId: base.target.binding.connectionProfileId, executionEnvironmentId: base.target.binding.executionEnvironmentId,
      nativeSessionId: base.wire.sessionID, applicationOperationId: operationId, operationKind: kind, nativeInputId,
      requestFingerprint: openCodeOperationFingerprint({ text: "original wire input" }), requestSource: { kind: "user" }, deadlineAt: null,
    }, 1);
  const begin = (kind: "submit" | "steer" = "submit", operationId = "operation", tracker = "tracker-one") => {
    reserve(kind, operationId, `msg_${kind}_${operationId}`);
    return evidence.begin(scope, threadID, operationId, kind, tracker, kind === "submit" ? "queue" : "steer", 2);
  };
  const dispatch = (kind: "submit" | "steer" = "submit", operationId = "operation") =>
    base.repository.markDispatched(scope, threadID, operationId, kind, 3);
  return { ...base, evidence, mutations, reserve, begin, dispatch };
}

describe("OpenCode durable private input and mutation evidence", () => {
  it("tracks native prepared payload separately from immutable original request and consumption", () => {
    const f = fixture(); const prepared = f.begin(); f.dispatch();
    const native = openCodePreparedPayloadFingerprint({ text: "Native hook transformed input", metadata: { prepared: true } });
    const admitted = f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: native, delivery: "queue", enqueueSequence: 7 });
    expect(admitted).toMatchObject({ preparedPayloadFingerprint: native, consumedFingerprint: null, payloadConflict: false,
      receipt: { disposition: "accepted", requestFingerprint: prepared.receipt.requestFingerprint } });
    expect(admitted.preparedPayloadFingerprint).not.toBe(admitted.receipt.requestFingerprint);
    const consumed = f.evidence.consume(scope, threadID, "operation", "submit", openCodeOperationFingerprint({ exactDelivered: 8 }), native);
    expect(consumed.consumedFingerprint).not.toBeNull(); expect(consumed.payloadConflict).toBe(false);
  });

  it("requires dispatch before admitting, consuming, or withdrawing reserved input", () => {
    const f = fixture(); f.begin(); const digest = "a".repeat(64);
    expect(() => f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: digest, delivery: "queue" })).toThrow();
    expect(() => f.evidence.consume(scope, threadID, "operation", "submit", digest)).toThrow();
    expect(() => f.evidence.withdraw(scope, threadID, "operation", "submit", "cancelled", digest)).toThrow();
    expect(f.evidence.get(scope, threadID, "operation", "submit")).toMatchObject({ consumedFingerprint: null, withdrawnFingerprint: null,
      preparedPayloadFingerprint: null, receipt: { disposition: "prepared" } });
  });

  it("refreshes tracker identity only until dispatch and preserves it across restarts", () => {
    const f = fixture(); f.begin();
    expect(f.evidence.begin(scope, threadID, "operation", "submit", "tracker-two", "queue").trackerId).toBe("tracker-two");
    f.dispatch();
    expect(f.evidence.begin(scope, threadID, "operation", "submit", "tracker-three", "queue").trackerId).toBe("tracker-two");
    expect(() => f.evidence.begin(scope, threadID, "operation", "submit", "tracker-four", "steer")).toThrow();
    expect(f.evidence.get(scope, threadID, "operation", "submit").trackerId).toBe("tracker-two");
  });

  it.each(["payload", "enqueue"] as const)("retains sticky %s conflicts without replacing the original native evidence", kind => {
    const f = fixture(); f.begin(); f.dispatch();
    const first = { payloadFingerprint: "a".repeat(64), delivery: "queue" as const, enqueueSequence: 2 };
    f.evidence.admit(scope, threadID, "operation", "submit", first);
    f.evidence.admit(scope, threadID, "operation", "submit", {
      ...first, ...(kind === "payload" ? { payloadFingerprint: "b".repeat(64) } : { enqueueSequence: 3 }),
    });
    f.evidence.admit(scope, threadID, "operation", "submit", first);
    expect(f.evidence.consume(scope, threadID, "operation", "submit", "c".repeat(64), first.payloadFingerprint)).toMatchObject({
      preparedPayloadFingerprint: first.payloadFingerprint, enqueueSequence: 2, payloadConflict: true,
    });
  });

  it("preserves exact consumption through subsequent cancellation and revert", () => {
    const f = fixture(); f.begin(); f.dispatch();
    f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    f.evidence.withdraw(scope, threadID, "operation", "submit", "cancelled", "b".repeat(64));
    f.evidence.withdraw(scope, threadID, "operation", "submit", "reverted", "c".repeat(64));
    expect(f.evidence.get(scope, threadID, "operation", "submit")).toMatchObject({
      consumedFingerprint: "a".repeat(64), withdrawnFingerprint: "b".repeat(64), withdrawalKind: "cancelled", payloadConflict: false,
    });
  });

  it("isolates principal, thread, native namespace and create/submit/steer operation kinds", () => {
    const f = fixture(); f.reserve("create", "operation", null); f.begin(); f.dispatch(); f.begin("steer");
    f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    expect(f.repository.requireOperation(scope, threadID, "operation", "create").disposition).toBe("prepared");
    expect(f.evidence.get(scope, threadID, "operation", "steer").consumedFingerprint).toBeNull();
    expect(() => f.evidence.get({ ...scope, principalId: "other" }, threadID, "operation", "submit")).toThrow();
    expect(() => f.evidence.get(scope, "other-thread", "operation", "submit")).toThrow();
    const foreign = new OpenCodeThreadRepository({ database: f.database, scope, backendInstanceId: f.context.instance.id, nativeNamespaceKey: "other-store" });
    expect(() => new OpenCodeInputEvidenceRepository(foreign).get(scope, threadID, "operation", "submit")).toThrow();
    expect(() => f.evidence.get(scope, threadID, "operation", "create" as never)).toThrow();
    expect(f.evidence.list(scope, threadID)).toHaveLength(2);
  });

  it("freezes mutation intent independently of input phase and rejects changed or unscoped replay", () => {
    const f = fixture(); f.reserve("action", "operation", null); f.reserve("interaction", "operation", null);
    const payload = { kind: "model", selection: { providerID: "provider", id: "model" } };
    f.mutations.prepare(scope, threadID, "operation", "action", payload);
    payload.selection.id = "later-mutated-object";
    expect(f.mutations.find(scope, threadID, "operation", "action")).toEqual({ kind: "model", selection: { providerID: "provider", id: "model" } });
    expect(() => f.mutations.prepare(scope, threadID, "operation", "action", payload)).toThrow();
    f.mutations.prepare(scope, threadID, "operation", "action", { selection: { id: "model", providerID: "provider" }, kind: "model" });
    f.mutations.prepare(scope, threadID, "operation", "interaction", { decision: "reject" });
    expect(f.mutations.find(scope, threadID, "operation", "interaction")).toEqual({ decision: "reject" });
    expect(() => f.mutations.find({ ...scope, tenantId: "other" }, threadID, "operation", "action")).toThrow();
    expect(() => f.mutations.find(scope, "other-thread", "operation", "action")).toThrow();
    expect(() => f.mutations.prepare(scope, threadID, "missing", "action", {})).toThrow();
  });

  it("rejects malformed digests and oversized immutable mutation payloads", () => {
    const f = fixture(); f.begin(); f.dispatch(); f.reserve("action", "large", null);
    expect(() => f.evidence.consume(scope, threadID, "operation", "submit", "not-a-digest")).toThrow();
    expect(() => f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: "a".repeat(64), delivery: "queue", enqueueSequence: -1 })).toThrow();
    expect(() => f.mutations.prepare(scope, threadID, "large", "action", { text: "x".repeat(1_048_577) })).toThrow();
    expect(f.mutations.find(scope, threadID, "large", "action")).toBeUndefined();
  });
});
