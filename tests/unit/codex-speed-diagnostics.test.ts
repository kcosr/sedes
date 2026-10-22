import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSpeedSession } from "../../src/server/backends/codex/codex-speed-session.js";
import { CodexSpeedDiagnostic, codexSpeedPresentationDiagnostic } from "../../src/server/backends/codex/codex-speed-diagnostics.js";
import type { CodexSharedClientFacade, CodexClientLifecycleSnapshot } from "../../src/server/backends/codex/codex-client-facade.js";
import type { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import type { CodexExecutionSettingsTuple } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { CodexRpcDeliveryError, CodexRpcRemoteError } from "../../src/server/backends/codex/rpc/errors.js";
import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";

function fixture() {
  let life: CodexClientLifecycleSnapshot = { state: "ready", generation: 1 };
  let control: { generation: number; turnId: string | null } | undefined = { generation: 1, turnId: "native-turn-secret" };
  let desired: CodexExecutionSettingsTuple = { model: "private-model-name", reasoningEffort: "low", serviceTier: "standard",
    sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user" };
  let tui = false;
  let continuity = "private-native-stream";
  const policy = { revision: 1, availability: "available" as const, fastEnabled: true, ultrafastEnabled: true, stepSwitchingEnabled: true };
  const request = vi.fn(async () => ({ result: { status: "applied" }, generation: 1, inboundSequence: 1 }));
  const input: ConstructorParameters<typeof CodexSpeedSession>[0] = {
    binding: { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "application-thread",
      backendInstanceId: "backend", backendConversationId: "native-session-secret" } as ConversationBinding,
    client: { lifecycleSnapshot: () => life, dispatchContinuity: () => continuity, requestWithReceipt: request } as unknown as CodexSharedClientFacade,
    policy: { projection: () => policy } as unknown as CodexFastModeSessionRegistry,
    desired: () => ({ settings: desired, revision: 1 }), nativeControl: () => control, managedTui: () => tui,
    validateSelection: async () => {}, assertPolicy: () => {}, confirmDefaults: () => {},
    withManagedTuiLock: async work => work(), verifyManagedTui: async () => {}, changed: vi.fn(),
  };
  const session = new CodexSpeedSession(input);
  const start = () => { session.started(1, "native-turn-secret", desired); return session.currentRun()!.target!; };
  const publish = () => session.publish({ arguments: { selection: "fast", currentRunTarget: session.currentRun()!.target! },
    backendTurnId: codexBackendTurnId("native-session-secret", "native-turn-secret"), operationId: "operation", dispatching: () => {} });
  return { input, session, policy, start, publish, request,
    life: (value: CodexClientLifecycleSnapshot) => { life = value; },
    control: (value: typeof control) => { control = value; },
    model: () => { desired = { ...desired, model: "other-private-model" }; },
    tui: () => { tui = true; }, continuity: () => { continuity = "new-private-stream"; },
  };
}

let output: ReturnType<typeof vi.spyOn>;
const records = () => output.mock.calls.flatMap(([line]: readonly unknown[]) => typeof line === "string" && line.startsWith("[delivery-attachment] ")
  ? [JSON.parse(line.slice("[delivery-attachment] ".length)) as Record<string, unknown>] : []);

beforeEach(() => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  output = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Codex Speed availability diagnostics", () => {
  it("is opt-in and does not alter authority when disabled", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
    const f = fixture(); const target = f.start();
    expect(f.session.currentRun()?.target).toEqual(target);
    f.session.close();
    expect(output).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("deduplicates repeated reads and separates handle replacement from generation changes", () => {
    const f = fixture(); const target = f.start();
    for (let index = 0; index < 20; index++) expect(f.session.currentRun()?.target).toEqual(target);
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({ reason: "no_activation", activationLoss: "new_handle", generation: 1 });
    expect(records()[1]).toMatchObject({ reason: "eligible", activationId: target.activationId, applicationTurnId: target.turnId });
    f.session.close();
    const replacement = new CodexSpeedSession(f.input);
    expect(replacement.currentRun()?.target).toBeNull();
    const observed = records();
    expect(observed.slice(-2)).toMatchObject([{ reason: "closed", generation: 1 },
      { reason: "no_activation", activationLoss: "new_handle", generation: 1 }]);
    expect(observed.at(-1)!.handleId).not.toBe(observed[0]!.handleId);
    expect(JSON.stringify(observed)).not.toMatch(/private-model|native-session-secret|native-turn-secret|private-native-stream/);
    expect(f.request).not.toHaveBeenCalled(); replacement.close();
  });

  it.each([
    ["connection_not_ready", (f: ReturnType<typeof fixture>) => f.life({ state: "reconciling", generation: 1 })],
    ["activation_generation_changed", (f: ReturnType<typeof fixture>) => f.life({ state: "ready", generation: 2 })],
    ["native_control_missing", (f: ReturnType<typeof fixture>) => f.control(undefined)],
    ["native_generation_changed", (f: ReturnType<typeof fixture>) => f.control({ generation: 2, turnId: "native-turn-secret" })],
    ["native_turn_changed", (f: ReturnType<typeof fixture>) => f.control({ generation: 1, turnId: "other-native-turn" })],
    ["desired_model_changed", (f: ReturnType<typeof fixture>) => f.model()],
    ["managed_tui", (f: ReturnType<typeof fixture>) => f.tui()],
    ["step_switching_disabled", (f: ReturnType<typeof fixture>) => { f.policy.stepSwitchingEnabled = false; }],
  ] as const)("logs the same failed eligibility check used by authority: %s", (reason, change) => {
    const f = fixture(); const target = f.start(); change(f);
    expect(f.session.currentRun()?.target).toBeNull();
    expect(() => f.session.admit({ selection: "fast", currentRunTarget: target },
      codexBackendTurnId("native-session-secret", "native-turn-secret"), false)).toThrow();
    expect(records().at(-1)).toMatchObject({ reason, applicationTurnId: target.turnId });
    f.session.close();
  });

  it("distinguishes idle, invalidation, rerouting and lifecycle loss", () => {
    const f = fixture(); f.start(); f.session.invalidate();
    expect(records().at(-1)).toMatchObject({ reason: "no_activation", activationLoss: "invalidated" });
    f.start(); f.session.rerouted("native-turn-secret");
    expect(records().at(-1)).toMatchObject({ reason: "no_activation", activationLoss: "rerouted" });
    f.start(); f.life({ state: "reconciling", generation: 1 }); f.session.lifecycle();
    expect(records().at(-1)).toMatchObject({ reason: "connection_not_ready", activationLoss: "connection_changed" });
    f.life({ state: "ready", generation: 1 }); f.control({ generation: 1, turnId: null }); f.session.observedIdle();
    expect(f.session.currentRun()).toBeNull();
    expect(records().at(-1)).toMatchObject({ reason: "native_idle", activationLoss: "native_idle" });
    f.session.close();
  });

  it("reports the native rejection latch and lost uncertainty continuity", async () => {
    const f = fixture(); f.start();
    f.request.mockRejectedValueOnce(new CodexRpcRemoteError({ code: -32600,
      message: "turn settings updates require the step_model_switching feature", generation: 1, method: "turn/settings/update" }));
    expect(await f.publish()).toMatchObject({ status: "rejected", reason: "not_enabled" });
    expect(records().at(-1)).toMatchObject({ reason: "step_switching_rejected" }); f.session.close();
    const g = fixture(); g.start();
    g.request.mockRejectedValueOnce(new CodexRpcDeliveryError({ code: "timeout", delivery: "sent_outcome_unknown", generation: 1, method: "turn/settings/update" }));
    expect(await g.publish()).toMatchObject({ status: "uncertain" });
    g.continuity(); expect(g.session.currentRun()?.target).toBeNull();
    expect(records().at(-1)).toMatchObject({ reason: "uncertain_connection_changed", uncertainContinuityMatches: false });
    g.session.close();
  });

  it("is safe when the diagnostic output fails", () => {
    output.mockImplementation(() => { throw new Error("stderr unavailable"); });
    const f = fixture(); const target = f.start();
    expect(f.session.currentRun()?.target).toEqual(target);
    expect(() => f.session.close()).not.toThrow();
  });

  it("sanitizes identifiers and bounds records before serialization", () => {
    const diagnostic = new CodexSpeedDiagnostic();
    diagnostic.record("codex_speed_eligibility", { applicationThreadId: "/secret/path\ncredential",
      handleId: "x".repeat(500), generation: Infinity, reason: "no_activation" });
    expect(records()[0]).toMatchObject({ applicationThreadId: "redacted", handleId: "redacted", reason: "no_activation" });
    expect(records()[0]).not.toHaveProperty("generation");
    expect(JSON.stringify(records())).not.toContain("credential");
  });

  it("keeps presentation deduplication bounded and separate for principal ownership", () => {
    const thread = randomUUID(); const tenantId = randomUUID();
    const fields = { applicationThreadId: thread, availability: "read_only" as const, reason: "controller_missing" as const };
    const scope = { tenantId, principalId: "one" };
    codexSpeedPresentationDiagnostic(scope, fields); codexSpeedPresentationDiagnostic(scope, fields);
    expect(records()).toHaveLength(1);
    codexSpeedPresentationDiagnostic({ tenantId, principalId: "two" }, fields);
    expect(records()).toHaveLength(2);
    for (let index = 0; index < 4096; index++) codexSpeedPresentationDiagnostic(scope, { ...fields, applicationThreadId: `thread-${index}` });
    const count = records().length;
    codexSpeedPresentationDiagnostic(scope, fields);
    expect(records()).toHaveLength(count + 1);
  });
});
