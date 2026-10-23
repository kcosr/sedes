import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";
import { decodeCodexServerNotificationParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { describe, expect, it, vi } from "vitest";
import { CodexSpeedSession } from "../../src/server/backends/codex/codex-speed-session.js";
import type { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import type { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import type { CodexExecutionSettingsTuple } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import { CodexRpcDeliveryError, CodexRpcRemoteError } from "../../src/server/backends/codex/rpc/errors.js";

function fixture(options?: { goals: CodexGoalSessionRegistry; readGoal(): unknown | Promise<unknown> }) {
  let now = 0;
  let life = { state: "ready", generation: 1 };
  let control: { generation: number; turnId: string | null } | undefined = { generation: 1, turnId: null };
  let settings: CodexExecutionSettingsTuple = { model: "fixture", reasoningEffort: "low", serviceTier: "standard", sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user" };
  let revision = 0;
  let nativeTier: string | null = "default";
  let actorIdle = true;
  let managedTui = false;
  let goalActive = false;
  let applyDefault: boolean | "queued" = true;
  const validation = vi.fn(async (_settings: CodexExecutionSettingsTuple) => {});
  const verify = vi.fn(async (_settings: CodexExecutionSettingsTuple) => {});
  const confirm = vi.fn();
  const hold = vi.fn(async (work: () => Promise<void>) => work());
  const notifications = new Set<(value: unknown) => void>();
  let continuity = "native-1";
  let update: () => Promise<{ status: "applied" | "targetUnavailable" }> = async () => ({ status: "applied" });
  const policy = { revision: 1, fastEnabled: true, ultrafastEnabled: true, stepSwitchingEnabled: true, availability: "available" as const };
  const requests = vi.fn(async (method: { method: string }, params: Record<string, unknown>) => {
    const generation = life.generation;
    if (method.method === "turn/settings/update") return { result: await update(), generation: life.generation, inboundSequence: 1 };
    if (method.method === "thread/settings/update") { if (applyDefault === true) nativeTier = String(params.serviceTier); else if (applyDefault === false) throw new Error("write failed"); return { result: {}, generation, inboundSequence: 1 }; }
    if (method.method === "thread/read") return { result: { thread: { status: { type: control?.turnId === null ? "idle" : "active" } } }, generation, inboundSequence: 1 };
    if (method.method === "thread/resume") return { result: { model: "gpt-5", reasoningEffort: "low", serviceTier: nativeTier }, generation, inboundSequence: 2 };
    throw new Error(`Unexpected ${method.method}`);
  });
  const client = { subscribeNotifications: (listener: (value: unknown) => void) => { notifications.add(listener); return () => notifications.delete(listener); }, lifecycleSnapshot: () => life, dispatchContinuity: () => continuity, requestWithReceipt: requests,
    request: async (method: { decodeResult(value: unknown): unknown }) => method.decodeResult(await options!.readGoal()),
  } as unknown as CodexSharedClientFacade;
  const goal = () => ({ connectionGeneration: life.generation, availability: "available", state: goalActive ? { state: "set", status: "active", objective: "task" } : { state: "unset" } });
  const session = new CodexSpeedSession({
    binding: { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "app", backendInstanceId: "backend", backendConversationId: "native" } as ConversationBinding,
    client, policy: { projection: () => policy } as unknown as CodexFastModeSessionRegistry,
    goals: options?.goals ?? { refresh: async () => goal(), projection: goal } as unknown as CodexGoalSessionRegistry,
    desired: () => ({ settings, revision }), nativeControl: () => control, managedTui: () => managedTui,
    validateSelection: validation, assertPolicy: () => {}, confirmDefaults: confirm, verifyManagedTui: verify,
    withManagedTuiLock: hold, changed: () => {}, now: () => now,
  });
  session.setCoordinator({ run: async () => undefined as never, isIdle: () => actorIdle, subscribeIdle: () => () => {} });
  const start = (id = "turn") => { actorIdle = false; control = { generation: life.generation, turnId: id }; session.observedStart(id); session.started(life.generation, id, settings); return session.currentRun()!.target!; };
  const complete = (id = "turn") => { session.completed(id); control = { generation: life.generation, turnId: null }; actorIdle = true; };
  const publish = (target: ReturnType<typeof start>, selection = "fast" as "fast" | "standard" | "ultrafast") => session.publish({ arguments: { selection, currentRunTarget: target }, backendTurnId: codexBackendTurnId("native", "turn"), operationId: "operation", dispatching: dispatch });
  const dispatch = vi.fn();
  return { session, client, requests, policy, start, complete, publish, dispatch, validation, verify, confirm, hold,
    desired: (value: Partial<CodexExecutionSettingsTuple>) => { settings = { ...settings, ...value }; revision++; },
    update: (value: typeof update) => { update = value; },
    disconnect: () => { life = { state: "reconciling", generation: life.generation }; session.lifecycle(); control = undefined; },
    reconnect: () => { life = { state: "ready", generation: life.generation + 1 }; session.lifecycle(); control = { generation: life.generation, turnId: null }; actorIdle = true; },
    currentGeneration: () => { life = { state: "ready", generation: life.generation + 1 }; },
    now: (value: number) => { now = value; },
    control: (value: typeof control) => { control = value; },
    actorIdle: (value: boolean) => { actorIdle = value; },
    goalActive: (value: boolean) => { goalActive = value; },
    managedTui: (value: boolean) => { managedTui = value; },
    applyDefault: (value: boolean | "queued") => { applyDefault = value; },
    nativeTier: (value: string | null, notify = false) => {
      nativeTier = value;
      if (notify) for (const listener of notifications) listener({ kind: "decoded_notification", generation: life.generation,
        method: "thread/settings/updated", params: decodeCodexServerNotificationParams("thread/settings/updated", { threadId: "native", threadSettings: {
          cwd: "/workspace", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null, model: "gpt-5", modelProvider: "openai", serviceTier: value, effort: "low", summary: null,
          collaborationMode: { mode: "default", settings: { model: "gpt-5", reasoning_effort: "low", developer_instructions: null } },
          multiAgentMode: "explicitRequestOnly", personality: null,
        } }) });
    },
    continuity: (value: string) => { continuity = value; },
  };
}

describe("Codex Speed exact current-run authority", () => {
  it("projects the actor's application turn and sends one narrow explicit-tier update", async () => {
    const f = fixture(); const target = f.start();
    expect(target.turnId).toBe(applicationTurnIdForBackendTurn({ backendInstanceId: "backend", sourceApplicationThreadId: "app", backendTurnId: codexBackendTurnId("native", "turn") }));
    expect(f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), false)).toBe("active");
    expect(await f.publish(target)).toEqual({ status: "published", target, selection: "fast" });
    expect(f.dispatch).toHaveBeenCalledBefore(f.requests);
    expect(f.requests.mock.calls[0]![1]).toEqual({ threadId: "native", turnId: "turn", serviceTier: "priority" });
    expect(f.session.currentRun()).toMatchObject({ startingSelection: "standard", requestedSelection: "fast", publicationState: "published" });
    expect(await f.publish(target, "standard")).toMatchObject({ status: "published" });
    expect(f.requests.mock.calls[1]![1].serviceTier).toBe("default");
    f.session.close();
  });
  it("never makes a null, foreign, or replacement target a wildcard", async () => {
    const f = fixture(); const target = f.start();
    expect(() => f.session.admit({ selection: "fast", currentRunTarget: null }, undefined, false)).toThrow();
    expect(() => f.session.admit({ selection: "fast", currentRunTarget: { ...target, activationId: "foreign" } }, codexBackendTurnId("native", "turn"), false)).toThrow();
    f.start("replacement");
    expect(await f.publish(target)).toMatchObject({ status: "not_attempted", reason: "ownership_changed" });
    expect(f.requests).not.toHaveBeenCalled(); f.session.close();
  });
  it("only positive completion admits a finished target, and expires that proof", () => {
    const f = fixture(); const target = f.start(); f.complete();
    expect(f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), true)).toBe("finished");
    f.now(120_001);
    expect(() => f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), true)).toThrow();
    f.session.close();
  });
  it("retains a completion proof when native idle arrives before turn/completed", () => {
    const f = fixture(); const target = f.start();
    f.control({ generation: 1, turnId: null }); f.actorIdle(true); f.session.observedIdle();
    expect(f.session.currentRun()).toBeNull();
    expect(() => f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), true)).toThrow();
    f.session.completed("turn");
    expect(f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), true)).toBe("finished");
    f.session.close();
  });
  it("cannot carry an idle-before-completion identity across a replacement or connection", () => {
    for (const replace of [true, false]) {
      const f = fixture(); const target = f.start();
      f.control({ generation: 1, turnId: null }); f.actorIdle(true); f.session.observedIdle();
      if (replace) f.start("replacement"); else { f.disconnect(); f.reconnect(); }
      f.session.completed("turn");
      expect(() => f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), true)).toThrow();
      f.session.close();
    }
  });
  it("preserves prior requested Speed on refusal and latches only the exact native feature rejection", async () => {
    const f = fixture(); const target = f.start(); await f.publish(target);
    f.update(async () => { throw new CodexRpcRemoteError({ code: -32600, message: "another invalid request", generation: 1, method: "turn/settings/update" }); });
    expect(await f.publish(target, "ultrafast")).toMatchObject({ status: "rejected", reason: "provider_rejected" });
    expect(f.session.currentRun()).toMatchObject({ target, requestedSelection: "fast", publicationState: "published" });
    f.update(async () => { throw new CodexRpcRemoteError({ code: -32600, message: "turn settings updates require the step_model_switching feature", generation: 1, method: "turn/settings/update" }); });
    expect(await f.publish(target)).toMatchObject({ status: "rejected", reason: "not_enabled" });
    f.policy.revision++;
    expect(f.session.currentRun()!.target).toBeNull(); f.session.close();
  });
  it("permits a new explicit update after uncertainty only on continuous native ownership", async () => {
    const f = fixture(); const target = f.start();
    f.update(async () => { throw new CodexRpcDeliveryError({ code: "timeout", delivery: "sent_outcome_unknown", generation: 1, method: "turn/settings/update" }); });
    expect(await f.publish(target)).toMatchObject({ status: "uncertain" });
    expect(f.session.currentRun()).toMatchObject({ target, publicationState: "unknown" });
    f.update(async () => ({ status: "applied" }));
    expect(await f.publish(target, "ultrafast")).toMatchObject({ status: "published" });
    f.continuity("replacement-native-stream");
    expect(f.session.currentRun()!.target).toBeNull();
    expect(await f.publish(target)).toMatchObject({ status: "not_attempted", reason: "connection_changed" });
    expect(f.requests).toHaveBeenCalledTimes(2); f.session.close();
  });
  it("fails closed on model reroute, unknown ownership, and a running managed terminal", () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => f.session.rerouted("turn"),
      (f: ReturnType<typeof fixture>) => f.desired({ model: "other" }),
      (f: ReturnType<typeof fixture>) => f.managedTui(true),
      (f: ReturnType<typeof fixture>) => { f.policy.stepSwitchingEnabled = false; }]) {
      const f = fixture(); const target = f.start(); mutate(f);
      expect(() => f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), false)).toThrow(); f.session.close();
    }
  });
  it("does not let a late outcome change a replacement run", async () => {
    const f = fixture(); const target = f.start(); let resolve!: (value: { status: "applied" }) => void;
    f.update(() => new Promise(r => { resolve = r; })); const request = f.publish(target);
    const replacement = f.start("replacement"); resolve({ status: "applied" }); await request;
    expect(f.session.currentRun()).toMatchObject({ target: replacement, requestedSelection: "standard", publicationState: "initial" }); f.session.close();
  });
});

describe("Codex Speed idle native defaults", () => {
  it("does not hold or verify a managed TUI while native work is active", async () => {
    const f = fixture(); f.managedTui(true); f.start();
    expect(await f.session.syncDefaults()).toBe("deferred");
    expect(f.hold).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.requests).not.toHaveBeenCalled(); f.session.close();
  });
  it("does not repeatedly hold and verify a TUI whose Speed is already confirmed", async () => {
    const f = fixture(); f.managedTui(true);
    expect(await f.session.syncDefaults()).toBe("confirmed");
    expect(await f.session.syncDefaults()).toBe("confirmed");
    expect(f.hold).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce(); f.session.close();
  });
  it("does not return an old confirmation when desired settings change during validation", async () => {
    const f = fixture(); expect(await f.session.syncDefaults()).toBe("confirmed");
    f.desired({ serviceTier: "fast" });
    f.validation.mockImplementationOnce(async () => { f.desired({ serviceTier: "ultrafast" }); });
    expect(await f.session.syncDefaults()).toBe("unknown");
    expect(f.session.defaultState).toBe("unknown");
    expect(f.requests.mock.calls.some(([method]) => method.method === "thread/settings/update")).toBe(false); f.session.close();
  });
  it("starts and expires recovery grace for externally started native work", async () => {
    const f = fixture(); f.control({ generation: 1, turnId: "external" }); f.actorIdle(false);
    f.disconnect(); f.reconnect();
    expect(await f.session.syncDefaults()).toBe("deferred");
    f.now(30_001); expect(await f.session.syncDefaults()).toBe("confirmed");
    f.disconnect(); f.reconnect();
    expect(await f.session.syncDefaults()).toBe("confirmed"); f.session.close();
  });
  it("writes explicit Standard when the native tier is unset before confirming inheritance", async () => {
    const f = fixture(); f.nativeTier(null);
    await f.session.syncDefaults();
    expect(f.requests.mock.calls.filter(([method]) => method.method === "thread/settings/update")
      .map(([, params]) => params)).toEqual([{ threadId: "native", serviceTier: "default" }]);
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "default" }), 1);
    expect(f.session.defaultState).toBe("confirmed");
    f.session.close();
  });
  it("uses tier-only writes, confirms readback, and never calls the turn update while idle", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); await f.session.syncDefaults();
    expect(f.requests.mock.calls.filter(([m]) => m.method === "thread/settings/update").map(([, p]) => p)).toEqual([{ threadId: "native", serviceTier: "priority" }]);
    expect(f.requests.mock.calls.some(([m]) => m.method === "turn/settings/update")).toBe(false);
    expect(f.session.defaultState).toBe("confirmed"); f.session.close();
  });
  it("defers for actor work, unknown native control, active Goal, and interrupted recovery", async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => f.start(),
      (f: ReturnType<typeof fixture>) => f.control(undefined),
      (f: ReturnType<typeof fixture>) => f.actorIdle(false),
      (f: ReturnType<typeof fixture>) => f.goalActive(true)]) {
      const f = fixture(); f.desired({ serviceTier: "fast" }); change(f); await f.session.syncDefaults();
      expect(f.requests.mock.calls.some(([m]) => m.method === "thread/settings/update")).toBe(false); f.session.close();
    }
    const f = fixture(); f.start(); f.disconnect(); f.reconnect(); f.desired({ serviceTier: "fast" });
    await f.session.syncDefaults(); expect(f.session.defaultState).toBe("deferred");
    f.now(30_001); await f.session.syncDefaults(); expect(f.session.defaultState).toBe("confirmed"); f.session.close();
  });
  it("consumes one write budget for a failed convergence until desired authority changes", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.applyDefault(false);
    await f.session.syncDefaults(); await f.session.syncDefaults();
    expect(f.session.defaultState).toBe("not_convergent");
    expect(f.requests.mock.calls.filter(([m]) => m.method === "thread/settings/update")).toHaveLength(1);
    f.policy.revision++; await f.session.syncDefaults();
    expect(f.requests.mock.calls.filter(([m]) => m.method === "thread/settings/update")).toHaveLength(1);
    f.desired({ serviceTier: "ultrafast" }); await f.session.syncDefaults();
    expect(f.requests.mock.calls.filter(([m]) => m.method === "thread/settings/update")).toHaveLength(2); f.session.close();
  });
  it.each(["failed", "interrupted", "drifted"] as const)("verifies a mismatched managed TUI under hold after a %s write without writing again", async previous => {
    const f = fixture(); f.desired({ serviceTier: "fast" });
    if (previous === "failed") f.applyDefault(false);
    if (previous === "interrupted") {
      f.managedTui(true); f.applyDefault("queued");
      const request = f.requests.getMockImplementation()!;
      f.requests.mockImplementation(async (method, params) => {
        const response = await request(method, params);
        if (method.method === "thread/settings/update") f.start();
        return response;
      });
    }
    await f.session.syncDefaults();
    if (previous === "interrupted") {
      expect(f.verify).not.toHaveBeenCalled();
      f.hold.mockClear();
      expect(await f.session.syncDefaults()).toBe("deferred");
      expect(f.hold).not.toHaveBeenCalled();
      f.complete();
    }
    f.nativeTier("default"); f.managedTui(true);
    f.hold.mockClear(); f.verify.mockClear();
    let held = false;
    f.hold.mockImplementation(async work => { held = true; try { await work(); } finally { held = false; } });
    f.verify.mockImplementation(async settings => {
      expect(held).toBe(true);
      expect(settings.serviceTier).toBe("fast");
      // The controller fails the mismatched terminal and clears running authority.
      f.managedTui(false);
    });
    expect(await f.session.syncDefaults()).toBe("not_convergent");
    expect(f.hold).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.requests.mock.calls.filter(([method]) => method.method === "thread/settings/update")).toHaveLength(1);
    f.session.close();
  });
  it("rechecks idle admission under the hold before verifying an exhausted-budget TUI", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.applyDefault(false);
    await f.session.syncDefaults(); f.managedTui(true); f.verify.mockClear();
    f.hold.mockImplementation(async work => { f.start(); await work(); });
    expect(await f.session.syncDefaults()).toBe("unknown");
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.requests.mock.calls.filter(([method]) => method.method === "thread/settings/update")).toHaveLength(1);
    f.session.close();
  });
});


describe("Codex Speed default confirmation and ordering", () => {
  const writes = (f: ReturnType<typeof fixture>) => f.requests.mock.calls.filter(([m]) => m.method === "thread/settings/update");
  it("rechecks after projected idle even when the earlier native idle check is still settling", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.actorIdle(false);
    await new Promise(resolve => setImmediate(resolve));
    let notifyIdle!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let runs = 0;
    let projectedIdle = false;
    const unsubscribe = vi.fn();
    f.session.setCoordinator({
      isIdle: () => projectedIdle,
      subscribeIdle: listener => { notifyIdle = listener; return unsubscribe; },
      run: async operation => {
        const first = ++runs === 1;
        const result = await operation();
        if (first) await held;
        return result;
      },
    });
    await vi.waitFor(() => expect(f.session.defaultState).toBe("deferred"));
    expect(writes(f)).toHaveLength(0);
    projectedIdle = true;
    notifyIdle(); release();
    await vi.waitFor(() => expect(f.session.defaultState).toBe("confirmed"));
    expect(runs).toBe(2); expect(writes(f)).toHaveLength(1);
    f.session.close(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("waits for a queued native setting to become visible without issuing another write", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.applyDefault("queued");
    const sync = f.session.syncDefaults();
    await vi.waitFor(() => expect(f.requests.mock.calls.filter(([m]) => m.method === "thread/resume")).toHaveLength(2));
    expect(f.session.defaultState).toBe("unknown");
    f.nativeTier("priority", true); await sync;
    expect(f.session.defaultState).toBe("confirmed"); expect(writes(f)).toHaveLength(1); f.session.close();
  });
  it("consumes the budget after mismatching readback times out", async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      f.desired({ serviceTier: "fast" }); f.applyDefault("queued");
      const sync = f.session.syncDefaults(); await vi.advanceTimersByTimeAsync(10_001); await sync;
      expect(f.session.defaultState).toBe("not_convergent");
      await f.session.syncDefaults(); expect(writes(f)).toHaveLength(1);
    } finally { f.session.close(); vi.useRealTimers(); }
  });
  it("uses an unused budget for external drift but never resets an exhausted one", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.nativeTier("priority");
    await f.session.syncDefaults(); expect(writes(f)).toHaveLength(0);
    f.nativeTier("default"); await f.session.syncDefaults(); expect(writes(f)).toHaveLength(1);
    f.nativeTier("default"); await f.session.syncDefaults(); expect(writes(f)).toHaveLength(1);
    expect(f.session.defaultState).toBe("not_convergent"); f.session.close();
  });
  it("does not write an obsolete choice after a newer save during catalog validation", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" });
    f.validation.mockImplementationOnce(async () => { f.desired({ serviceTier: "ultrafast" }); });
    await f.session.syncDefaults(); expect(writes(f)).toHaveLength(0);
    await f.session.syncDefaults(); expect(writes(f).map(([, params]) => params.serviceTier)).toEqual(["ultrafast"]); f.session.close();
  });
  it("requires the actual native model to support the tier before a tier-only update", async () => {
    const f = fixture(); f.desired({ serviceTier: "fast" }); f.validation.mockRejectedValueOnce(new Error("native model unsupported"));
    await expect(f.session.syncDefaults()).rejects.toThrow("native model unsupported");
    expect(f.validation).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5", serviceTier: "fast" }));
    expect(writes(f)).toHaveLength(0); f.session.close();
  });
  it("clears recovery grace only on positive evidence and allows a fresh Sedes run throughout", async () => {
    const f = fixture(); f.start(); f.disconnect(); f.reconnect(); f.desired({ serviceTier: "fast" });
    await f.session.syncDefaults(); expect(writes(f)).toHaveLength(0);
    // A fresh explicit start does not wait for the old recovery grace.
    const current = f.start("fresh"); expect(current).toBeTruthy();
    f.complete("fresh"); f.session.completed("turn");
    await f.session.syncDefaults(); expect(writes(f)).toHaveLength(1); f.session.close();
  });
  it("keeps an active Goal eligible for an exactly owned Sedes run", async () => {
    const f = fixture(); const target = f.start(); f.goalActive(true);
    expect(f.session.admit({ selection: "fast", currentRunTarget: target }, codexBackendTurnId("native", "turn"), false)).toBe("active");
    expect(await f.publish(target)).toMatchObject({ status: "published" }); f.session.close();
  });
});


describe("Codex Speed Goal-driven scheduling", () => {
  const scope = { tenantId: "tenant", principalId: "principal" };
  const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  function goalFixture(initial: "active" | "paused" | null = null) {
    const goals = new CodexGoalSessionRegistry();
    let status = initial;
    let objective = "fixture";
    let unavailable = false;
    let beforeRead: (() => Promise<void>) | undefined;
    const f = fixture({ goals, readGoal: async () => {
      await beforeRead?.();
      if (unavailable) throw new Error("unavailable");
      return { goal: status === null ? null : { threadId: "native", objective, status,
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } };
    } });
    const refreshInput = { scope, applicationThreadId: "app", nativeThreadId: "native", connectionGeneration: 1, client: f.client };
    const settle = async () => {
      await new Promise<void>(resolve => goals.scheduleInvalidation({ ...refreshInput,
        onSettled: () => { f.session.goalProjectionSettled(); resolve(); } }));
      // Let the registry release its coalesced invalidation before the next hint.
      await nextTick();
    };
    let runs = 0;
    let idle = true;
    let notifyIdle: () => void;
    let afterRun: (() => Promise<void>) | undefined;
    const coordinator = {
      isIdle: () => idle,
      subscribeIdle: (listener: () => void) => { notifyIdle = listener; return () => {}; },
      run: async <T,>(operation: () => Promise<T>): Promise<T> => {
        runs++;
        const value = await operation();
        await afterRun?.();
        return value;
      },
    };
    return { ...f, goals, settle, refreshInput, runs: () => runs,
      status: (value: typeof status) => { status = value; },
      objective: (value: string) => { objective = value; },
      unavailable: (value: boolean) => { unavailable = value; },
      beforeRead: (value?: () => Promise<void>) => { beforeRead = value; },
      afterRun: (value?: () => Promise<void>) => { afterRun = value; },
      begin: async () => { await nextTick(); f.session.setCoordinator(coordinator); await nextTick(); },
      idle: (value: boolean) => { idle = value; notifyIdle?.(); },
      resumes: () => f.requests.mock.calls.filter(([method]) => method.method === "thread/resume").length,
    };
  }

  it.each([null, "paused"] as const)("ignores repeated resume echoes for an unchanged %s Goal", async initial => {
    const f = goalFixture(initial);
    try {
      await f.begin();
      expect(f.session.defaultState).toBe("confirmed");
      for (let i = 0; i < 4; i++) { await f.settle(); await nextTick(); }
      expect(f.resumes()).toBe(1);
      expect(f.runs()).toBe(1);
      // Explicit action-time reads are still fresh, even with a confirmed default.
      await f.session.syncDefaults();
      expect(f.resumes()).toBe(2);
    } finally { f.session.close(); }
  });

  it.each([false, true])("retains a prepublished Goal pause (previous pass still settling: %s)", async held => {
    const f = goalFixture("active");
    const gate = deferred();
    if (held) f.afterRun(() => gate.promise);
    try {
      await f.begin();
      expect(f.session.defaultState).toBe("deferred");
      f.status("paused");
      f.goals.publishObserved({ ...f.refreshInput, state: { state: "set", status: "paused", objective: "fixture" } });
      await f.settle();
      gate.resolve(); await nextTick();
      expect(f.session.defaultState).toBe("confirmed");
      expect(f.resumes()).toBe(1);
      expect(f.runs()).toBe(2);
    } finally { gate.resolve(); f.session.close(); }
  });

  it("coalesces changed Goals during settlement without dropping their trailing check", async () => {
    const f = goalFixture("active");
    const gate = deferred();
    f.afterRun(() => gate.promise);
    try {
      await f.begin();
      for (const status of ["paused", null, "paused"] as const) { f.status(status); await f.settle(); }
      expect(f.runs()).toBe(1);
      gate.resolve(); await nextTick();
      expect(f.session.defaultState).toBe("confirmed");
      expect(f.runs()).toBe(2);
      expect(f.resumes()).toBe(1);
    } finally { gate.resolve(); f.session.close(); }
  });

  it("does not erase a pending Goal wakeup when its own refresh adopts the latest state", async () => {
    const f = goalFixture("active");
    const gate = deferred();
    const entered = deferred();
    try {
      await f.begin();
      f.beforeRead(async () => { entered.resolve(); await gate.promise; });
      f.session.scheduleDefaults();
      await entered.promise;
      f.status("paused");
      f.goals.publishObserved({ ...f.refreshInput, state: { state: "set", status: "paused", objective: "fixture" } });
      f.session.goalProjectionSettled();
      gate.resolve(); await nextTick();
      expect(f.session.defaultState).toBe("confirmed");
      expect(f.runs()).toBe(3);
      expect(f.resumes()).toBe(2);
      await f.settle(); await nextTick();
      expect(f.runs()).toBe(3);
    } finally { gate.resolve(); f.session.close(); }
  });

  it("ignores progress and repeated unavailable revisions, but observes availability recovery", async () => {
    const f = goalFixture("active");
    try {
      await f.begin();
      const revision = f.goals.projection(scope, "app")!.revision;
      f.objective("updated objective"); await f.settle(); await nextTick();
      expect(f.goals.projection(scope, "app")!.revision).toBeGreaterThan(revision);
      expect(f.runs()).toBe(1);
      f.unavailable(true); await f.settle(); await nextTick();
      expect(f.runs()).toBe(2);
      const withdrawn = f.goals.projection(scope, "app")!.revision;
      for (let i = 0; i < 3; i++) { await f.settle(); await nextTick(); }
      expect(f.goals.projection(scope, "app")!.revision).toBeGreaterThan(withdrawn);
      expect(f.runs()).toBe(2);
      f.unavailable(false); f.status(null); await f.settle(); await nextTick();
      expect(f.runs()).toBe(3);
      expect(f.resumes()).toBe(1);
      expect(f.session.defaultState).toBe("confirmed");
    } finally { f.session.close(); }
  });

  it("retains idle and reconnect triggers after suppressing identical Goal observations", async () => {
    const f = goalFixture();
    try {
      f.idle(false); await f.begin();
      await f.settle(); await nextTick();
      expect(f.session.defaultState).toBe("deferred");
      f.idle(true); await nextTick();
      expect(f.session.defaultState).toBe("confirmed");
      const runs = f.runs();
      await f.settle(); await nextTick(); expect(f.runs()).toBe(runs);
      f.disconnect(); f.reconnect(); await nextTick();
      expect(f.runs()).toBeGreaterThan(runs);
      expect(f.session.defaultState).toBe("confirmed");
    } finally { f.session.close(); }
  });

  it("observes current shared state rather than a superseded invalidation result", async () => {
    const f = goalFixture("active");
    try {
      await f.begin();
      const obsolete = f.goals.projection(scope, "app")!;
      f.status(null);
      await f.goals.refresh(f.refreshInput);
      expect(obsolete.state).toMatchObject({ state: "set", status: "active" });
      f.session.goalProjectionSettled(); await nextTick();
      expect(f.session.defaultState).toBe("confirmed");
      expect(f.runs()).toBe(2);
    } finally { f.session.close(); }
  });
});
