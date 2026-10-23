import { CODEX_SPEED_REF, speedArgumentsValue, speedResultWireSchema, type SpeedCurrentRunResult, type SpeedSelection } from "../../src/shared/provider-features/codex-speed.js";
import type { CodexSpeedSession } from "../../src/server/backends/codex/codex-speed-session.js";
import { CodexSpeedPublicationRepository } from "../../src/server/backends/codex/codex-speed-publication-repository.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { CodexThreadActionPersistence } from "../../src/server/backends/codex/codex-thread-action-persistence.js";
import type { CodexManagedTuiController } from "../../src/server/backends/codex/codex-managed-tui-controller.js";
import { CodexAutomationExecutionPolicy } from "../../src/server/backends/codex/codex-automation-execution-policy.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { CodexThreadPresentationProvider } from "../../src/server/backends/codex/codex-thread-presentation-provider.js";
import { boundValue } from "../../src/server/conversations/payload-policy.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { encodeCodexModelSetting } from "../../src/server/backends/codex/codex-setting-values.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
    {
      id: "codex-primary",
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
      moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/usr/bin/false", workingDirectory: "/tmp", codexHome: "/tmp/codex-fixture-home" } },
        policy: { allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"], allowedNetworkAccess: ["disabled", "enabled"], allowedApprovalPolicies: ["untrusted", "on-request", "never"], allowedApprovalReviewers: ["user", "auto_review"] },
      },
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Local Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } } },
    },
  ],
  defaultTargetId: "pi-local",
});

const databases: Database.Database[] = [];
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const readOnlyPolicy = {
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;
const workspacePolicy = {
  sandboxMode: "workspace-write",
  networkAccess: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
} as const;
const executionPolicy = {
  allowedSandboxModes: [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const,
  allowedNetworkAccess: ["disabled", "enabled"] as const,
  allowedApprovalPolicies: ["untrusted", "on-request", "never"] as const,
  allowedApprovalReviewers: ["user", "auto_review"] as const,
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(
  input: {
    readonly imported?: boolean;
    readonly unbound?: boolean;
    readonly enabledAutomation?: boolean;
    readonly managedTui?: CodexManagedTuiController;
    readonly desiredSettingsChanged?: (scope: RequestScope, applicationThreadId: string) => void;
    readonly fastModeRuntime?: {
      controller(scope: RequestScope, applicationThreadId: string): CodexSpeedSession | undefined;
      syncServiceTier(
        scope: RequestScope,
        applicationThreadId: string,
        serviceTier: "standard" | "fast",
      ): Promise<void>;
    };
  } = {},
) {
  const database = openOverlayDatabase(":memory:");
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/codex-actions",
      displayName: "Codex actions",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 200,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const configurations = new BackendConfigurationRepository(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "codex-persistence-fixture" }, 210);

  new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 210 });
  const profiles = configurations.listProfiles(scope);
  const codexProfile = profiles.find(
    ({ templateId }) => templateId === "codex-local",
  )!;
  const piProfile = profiles.find(
    ({ templateId }) => templateId === "pi-local",
  )!;
  const bindings = new ConversationBindingRepository(database);
  const settings = new CodexThreadExecutionSettingsRepository(database);
  const featureMutations = new ProviderFeatureMutationRepository(database);
  const createUnbound = (id: string, connectionProfileId: string) =>
    bindings.createUnboundThread(scope, {
      id,
      workspaceId: workspace.id,
      connectionProfileId,
      title: `Initial ${id}`,
      now: 300,
    });
  const createBound = (
    id: string,
    connectionProfileId: string,
    backendConversationId: string,
  ) => {
    const created = createUnbound(id, connectionProfileId);
    bindings.bindDiscoveredConversation(scope, created.id, {
      backendConversationId,
      now: 310,
    });
    return created.id;
  };
  const codexThreadId = input.unbound
    ? createUnbound("codex-thread", codexProfile.id).id
    : createBound("codex-thread", codexProfile.id, "native-codex-thread");
  settings.initialize(scope, {
    applicationThreadId: codexThreadId,
    desired: input.imported
      ? null
      : {
          model: "gpt-5.6-codex",
          reasoningEffort: "low",
          serviceTier: "standard",
          ...readOnlyPolicy,
        },
    now: 320,
  });
  const automations = new AutomationRepository(database);
  const automation = input.enabledAutomation
    ? automations.createDefinition(scope, {
        anchorThreadId: codexThreadId,
        name: "Recurring thread wake-up",
        prompt: "Check for updates",
        runMode: "same_thread",
        enabled: true,
        precheck: null,
        schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 300 },
        misfirePolicy: "coalesce",
        nextRunAt: 1_000,
        now: 330,
      })
    : undefined;
  return {
    database,
    scope,
    automations,
    automation,
    codexProfile,
    configurations,
    workspace,
    inventory: new InventoryRepository(database),
    operations: new ConversationOperationRepository(database),
    codexThreadId,
    piThreadId: createBound("pi-thread", piProfile.id, "native-pi-thread"),
    persistence: new CodexThreadActionPersistence({
      desiredSettingsChanged: input.desiredSettingsChanged ?? (() => undefined),
      database,
      scope,
      backendInstanceId: "codex-primary",
      settings,
      featureMutations,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      defaultExecutionPolicyByConnectionId: new Map([
        [codexProfile.id, readOnlyPolicy],
      ]),
      ...(input.managedTui ? { managedTui: input.managedTui } : {}),
      ...(input.fastModeRuntime
        ? { fastModeRuntime: input.fastModeRuntime }
        : {}),
    }),
    settings,
    featureMutations,
  };
}

describe("Codex interactive action persistence", () => {
  it.each([false, true])("offers model, reasoning, speed, and permissions with enabled automation (unbound=%s)", async (unbound) => {
    const current = fixture({ enabledAutomation: true, unbound });
    const backend = current.configurations.getBackend(current.scope, "codex-primary");
    const provider = new CodexThreadPresentationProvider({
      settings: current.settings,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      fastModeRuntime: {
        controller: () => ({ currentRun: () => null }) as unknown as CodexSpeedSession,
        projection: () => ({ revision: 1, fastEnabled: true, ultrafastEnabled: true, availability: "available" }),
      },
    });
    const presentation = await provider.read({
      scope: current.scope,
      applicationThreadId: current.codexThreadId,
      backend: { ...backend, enabled: backend.enabled === 1 },
      connection: { ...current.codexProfile, enabled: current.codexProfile.enabled === 1 },
      workspace: {
        authorityRevision: 0,
        canonicalPath: "/tmp/codex-actions",
        summary: {
          id: current.workspace.id,
          environmentId: current.codexProfile.executionEnvironmentId,
          displayName: "Codex actions",
          displayPath: "/tmp/codex-actions",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
      },
      catalog: {
        models: [{
          provider: current.codexProfile.id,
          id: "gpt-5.6-codex",
          label: "GPT-5.6 Codex",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          inputModalities: ["text"],
          serviceTiers: { offered: [{ selection: "fast" }, { selection: "ultrafast" }], defaultSelection: "standard" },
        }],
        commands: [], skills: [], notices: [],
      },
    });

    expect(presentation.settingDescriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model", available: true }),
      expect.objectContaining({ id: "thinking_level", available: true }),
    ]));
    expect(presentation.providerFeatureCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: { featureId: "codex.execution", schemaVersion: 1 }, availability: "available" }),
      expect.objectContaining({ ref: { featureId: "codex.fast_mode", schemaVersion: 3 }, availability: "available" }),
    ]));
    expect(presentation.automationAllowed).toBe(true);
    expect(current.automations.getDefinition(current.scope, current.automation!.id).enabled).toBe(true);
  });

  it.each([
    {
      settingId: "model" as const,
      value: encodeCodexModelSetting("gpt-5.7-codex", "medium", ["fast"], "standard"),
      desired: { model: "gpt-5.7-codex", reasoningEffort: "medium" },
    },
    {
      settingId: "thinking_level" as const,
      value: "high",
      desired: { model: "gpt-5.6-codex", reasoningEffort: "high" },
    },
  ])("changes $settingId while a recurring automation stays enabled", ({ settingId, value, desired }) => {
    const current = fixture({ enabledAutomation: true });
    const thread = current.inventory.getThread(current.scope, current.codexThreadId).thread;
    const settings = current.settings.find(current.scope, current.codexThreadId)!;

    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: `automated-thread-${settingId}`,
      expectedThreadRevision: thread.revision,
      settingsGuard: { kind: "staged", expectedRevision: settings.revision },
      operation: { action: "set_setting", settingId, value },
      now: 400,
    });

    expect(current.settings.find(current.scope, current.codexThreadId)).toMatchObject({
      desired,
      revision: settings.revision + 1,
    });
    expect(current.automations.getDefinition(current.scope, current.automation!.id))
      .toEqual(current.automation);
  });

  it.each([
    { featureId: "codex.execution", schemaVersion: 1, actionId: "set_sandbox_workspace", desired: { sandboxMode: "workspace-write" } },
    { featureId: "codex.execution", schemaVersion: 1, actionId: "set_network_enabled", desired: { networkAccess: "enabled" } },
    { featureId: "codex.execution", schemaVersion: 1, actionId: "set_approval_on_request", desired: { approvalPolicy: "on-request" } },
    { featureId: "codex.execution", schemaVersion: 1, actionId: "set_reviewer_auto_review", desired: { approvalReviewer: "auto_review" } },
  ])("accepts $actionId while a recurring automation stays enabled", async ({ featureId, schemaVersion, actionId, desired }) => {
    const current = fixture({ enabledAutomation: true });
    const thread = current.inventory.getThread(current.scope, current.codexThreadId).thread;
    const settings = current.settings.find(current.scope, current.codexThreadId)!;
    const mutationId = `automated-thread-${actionId}`;

    await expect(current.persistence.performProviderFeature(current.scope, current.codexThreadId, {
      mutationId,
      expectedThreadRevision: thread.revision,
      operation: {
        action: "perform_provider_feature",
        feature: { featureId, schemaVersion },
        actionId,
        arguments: null,
        expectedMutationRevision: settings.revision,
      },
      now: 400,
    })).resolves.toEqual({ applicationOperationId: mutationId });

    expect(current.settings.find(current.scope, current.codexThreadId)).toMatchObject({
      desired,
      revision: settings.revision + 1,
    });
    expect(current.featureMutations.find(current.scope, mutationId)?.state).toBe("accepted");
    expect(current.automations.getDefinition(current.scope, current.automation!.id))
      .toEqual(current.automation);
  });

  it("preserves a frozen operation while the next operation uses edited thread settings", () => {
    const current = fixture({ enabledAutomation: true });
    const thread = current.inventory.getThread(current.scope, current.codexThreadId).thread;
    const before = current.settings.find(current.scope, current.codexThreadId)!;
    const frozen = current.settings.freezeOperationSnapshot(current.scope, {
      applicationThreadId: current.codexThreadId,
      applicationOperationId: "earlier-automation-operation",
      now: 400,
    });

    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "between-runs-model-change",
      expectedThreadRevision: thread.revision,
      settingsGuard: { kind: "staged", expectedRevision: before.revision },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: encodeCodexModelSetting("gpt-5.7-codex", "high", ["fast"], "standard"),
      },
      now: 410,
    });

    const replay = current.settings.freezeOperationSnapshot(current.scope, {
      applicationThreadId: current.codexThreadId,
      applicationOperationId: frozen.applicationOperationId,
      now: 420,
    });
    const next = current.settings.freezeOperationSnapshot(current.scope, {
      applicationThreadId: current.codexThreadId,
      applicationOperationId: "next-automation-operation",
      now: 430,
    });
    expect(replay).toEqual(frozen);
    expect(replay.settings).toEqual(before.desired);
    const after = current.settings.find(current.scope, current.codexThreadId)!;
    expect(next.settings).toEqual(after.desired);
    expect(next.settingsRevision).toBe(after.revision);
    expect(next.settings).toMatchObject({ model: "gpt-5.7-codex", reasoningEffort: "high" });
    expect(current.automations.getDefinition(current.scope, current.automation!.id))
      .toEqual(current.automation);
  });

  it("rejects a settings edit admitted before an automation input was queued", () => {
    const current = fixture({ enabledAutomation: true });
    const thread = current.inventory.getThread(current.scope, current.codexThreadId).thread;
    const settings = current.settings.find(current.scope, current.codexThreadId)!;
    const automationId = current.automation!.id;
    const { run } = current.automations.claimScheduledOccurrence(current.scope, automationId, {
      runId: randomUUID(),
      occurrenceKey: "scheduled:1000",
      scheduledFor: 1_000,
      lastScheduledAt: 1_000,
      nextRunAt: 301_000,
      coalescedCount: 0,
      claimToken: "settings-race-claim",
      leaseExpiresAt: 2_000,
      dispatchMutationId: randomUUID(),
      now: 1_000,
    });
    current.automations.updateRunState(current.scope, automationId, run.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: run.claimToken!,
      retainPromptSnapshot: true,
      now: 1_001,
    });
    const queued = new QueuedInputRepository(current.database).enqueue(current.scope, current.codexThreadId, {
      mutationId: run.dispatchMutationId,
      text: run.promptSnapshot!,
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: { kind: "automation", automationId, automationRunId: run.id, claimToken: run.claimToken! },
      now: 1_002,
    });
    expect(queued.item.triggerKind).toBe("automation");
    expect(current.inventory.getThread(current.scope, current.codexThreadId).thread.revision)
      .toBeGreaterThan(thread.revision);

    expect(() => current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "raced-settings-edit",
      expectedThreadRevision: thread.revision,
      settingsGuard: { kind: "staged", expectedRevision: settings.revision },
      operation: { action: "set_setting", settingId: "thinking_level", value: "high" },
      now: 1_003,
    })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(current.settings.find(current.scope, current.codexThreadId)).toEqual(settings);
  });

  it("owns the best-effort Goal pause after accepted Stop", async () => {
    const current = fixture();
    const mutateProviderFeature = vi.fn(async () => ({
      outcome: "accepted" as const,
    }));

    await expect(
      current.persistence.afterInterruptAccepted({ mutateProviderFeature }),
    ).resolves.toBe(true);
    expect(mutateProviderFeature).toHaveBeenCalledWith({
      featureId: "codex.goal",
      schemaVersion: 1,
      actionId: "pause",
      arguments: {},
    });

    mutateProviderFeature.mockRejectedValueOnce(new Error("pause failed"));
    await expect(
      current.persistence.afterInterruptAccepted({ mutateProviderFeature }),
    ).resolves.toBe(false);
  });

  it("declares one closed concurrency disposition for every compiled Codex feature action", () => {
    const current = fixture();
    const refs = compiledProviderFeatureRegistry.refs("codex_app_server");
    expect(refs.map(({ featureId }) => featureId)).toEqual([
      "codex.execution",
      "codex.fast_mode",
      "codex.goal",
      "codex.tui",
    ]);

    for (const ref of refs) {
      const module = compiledProviderFeatureRegistry.module(
        ref,
        "codex_app_server",
      );
      for (const action of module.operations) {
        expect(
          current.persistence.providerFeatureConcurrency(ref, action.actionId),
        ).toEqual(
          ref.featureId === "codex.goal" || ref.featureId === "codex.tui" || ref.featureId === "codex.fast_mode"
            ? {
                kind: "concurrent",
                activeTurn: true,
                queuedInput: true,
              }
            : { kind: "quiet_thread" },
        );
      }
    }
    expect(
      current.persistence.providerFeatureConcurrency(
        { featureId: "codex.unknown", schemaVersion: 1 },
        "start",
      ),
    ).toEqual({ kind: "quiet_thread" });
    expect(
      current.persistence.providerFeatureConcurrency(
        { featureId: "codex.tui", schemaVersion: 1 },
        "unknown",
      ),
    ).toEqual({ kind: "quiet_thread" });
  });

  const speedTarget = { turnId: "application-turn", activationId: "activation" };
  function speedRequest(current: ReturnType<typeof fixture>, id: string, selection: SpeedSelection, active = false,
    expectedMutationRevision = current.settings.find(current.scope, current.codexThreadId)!.desiredRevision) {
    return {
      mutationId: id, expectedThreadRevision: current.inventory.getThread(current.scope, current.codexThreadId).thread.revision,
      operation: { action: "perform_provider_feature" as const, feature: CODEX_SPEED_REF, actionId: "set_speed",
        arguments: speedArgumentsValue({ selection, currentRunTarget: active ? speedTarget : null }), expectedMutationRevision },
      now: 400, actor: { isIdle: () => !active, resolveTurnId: () => "native-turn", mutateExternal: async () => ({ outcome: "rejected" as const }) },
      featureState: boundValue({ saved: { selection: "standard", desiredRevision: 0 }, offered: ["standard", "fast", "ultrafast"].map(selection => ({ selection })), currentRun: null, lastChange: null }),
    };
  }
  function speedFixture(active = false) {
    const publish = vi.fn(async (input: { arguments: { selection: SpeedSelection }; dispatching(continuity: string): void }): Promise<SpeedCurrentRunResult> => {
      input.dispatching("native-stream-1");
      return { status: "published", target: speedTarget, selection: input.arguments.selection };
    });
    const controller = { currentRun: () => null, prepare: vi.fn(async () => {}), admit: () => active ? "active" : "idle",
      publish, syncDefaults: vi.fn(async () => {}) } as unknown as CodexSpeedSession;
    const current = fixture({ fastModeRuntime: { controller: () => controller, syncServiceTier: vi.fn(async () => {}) } });
    const request = (id: string, selection: SpeedSelection, expectedMutationRevision?: number) =>
      speedRequest(current, id, selection, active, expectedMutationRevision);
    const perform = (input: ReturnType<typeof request>) => current.persistence.performProviderFeature(current.scope, current.codexThreadId, input);
    return { ...current, publish, controller, request, perform };
  }
  it("saves idle Speed once and replays the exact original result after newer intent", async () => {
    const f = speedFixture(); const first = f.request("first", "fast");
    const response = await f.perform(first);
    expect(response).toMatchObject({ status: "provider_feature_result", operationId: "first" });
    expect("result" in response && speedResultWireSchema.parse(response.result)).toMatchObject({ saved: { selection: "fast", desiredRevision: 1 }, currentRun: { status: "not_requested" } });
    expect(f.controller.syncDefaults).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
    await f.perform(f.request("newer", "ultrafast"));
    expect(await f.perform(first)).toEqual(response);
    expect(f.settings.find(f.scope, f.codexThreadId)!.desired!.serviceTier).toBe("ultrafast");
    await expect(f.perform({ ...first, operation: { ...first.operation, arguments: speedArgumentsValue({ selection: "standard", currentRunTarget: null }) } })).rejects.toThrow();
  });
  it("persists the parent and dispatch phase before the native leg", async () => {
    const f = speedFixture(true);
    f.publish.mockImplementation(async input => {
      expect(f.featureMutations.find(f.scope, "active")!.state).toBe("accepted");
      expect(new CodexSpeedPublicationRepository(f.database).find(f.scope, "active")!.phase).toBe("ready");
      input.dispatching("native-stream-1");
      expect(new CodexSpeedPublicationRepository(f.database).find(f.scope, "active")!.phase).toBe("dispatching");
      return { status: "published", target: speedTarget, selection: "fast" };
    });
    const response = await f.perform(f.request("active", "fast"));
    expect("result" in response && speedResultWireSchema.parse(response.result)).toMatchObject({ saved: { selection: "fast" }, currentRun: { status: "published" }, receiptRevision: 3 });
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it.each(["rejected", "uncertain"] as const)("retains saved intent and an immutable accepted parent after %s", async status => {
    const f = speedFixture(true);
    f.publish.mockImplementation(async input => { input.dispatching("native-stream-1"); return status === "rejected"
      ? { status, target: speedTarget, selection: "fast", reason: "provider_rejected", message: { text: "Rejected" } }
      : { status, target: speedTarget, selection: "fast", reason: "response_lost" }; });
    const request = f.request("partial", "fast"); const response = await f.perform(request);
    expect("result" in response && speedResultWireSchema.parse(response.result).currentRun.status).toBe(status);
    expect(f.featureMutations.find(f.scope, "partial")!.state).toBe("accepted");
    expect(f.settings.find(f.scope, f.codexThreadId)!.desired!.serviceTier).toBe("fast");
    await f.perform(request); expect(f.publish).toHaveBeenCalledOnce();
  });
  it("rejects competing saved CAS while allowing same-value reapplication without revision bumps", async () => {
    const f = speedFixture(true); const loser = f.request("loser", "ultrafast");
    await f.perform(f.request("winner", "fast"));
    await expect(f.perform(loser)).rejects.toThrow();
    const before = f.settings.find(f.scope, f.codexThreadId)!;
    const threadBefore = f.inventory.getThread(f.scope, f.codexThreadId).thread.revision;
    await f.perform(f.request("reapply", "fast"));
    expect(f.settings.find(f.scope, f.codexThreadId)!.desiredRevision).toBe(before.desiredRevision);
    expect(f.inventory.getThread(f.scope, f.codexThreadId).thread.revision).toBe(threadBefore);
    expect(f.publish).toHaveBeenCalledTimes(2);
  });
  it("never dispatches a publication when its transaction rolls back", async () => {
    const f = speedFixture(true);
    f.database.exec("CREATE TRIGGER fail_speed BEFORE INSERT ON codex_speed_publications BEGIN SELECT RAISE(ABORT, 'injected rollback'); END;");
    await expect(f.perform(f.request("rollback", "fast"))).rejects.toThrow("injected rollback");
    expect(f.settings.find(f.scope, f.codexThreadId)!.desired!.serviceTier).toBe("standard");
    expect(f.featureMutations.find(f.scope, "rollback")).toBeUndefined(); expect(f.publish).not.toHaveBeenCalled();
  });
  it("preserves a frozen queued start while later unfrozen work takes the saved Speed", async () => {
    const f = speedFixture(); const queue = new QueuedInputRepository(f.database);
    const enqueue = (id: string) => queue.enqueue(f.scope, f.codexThreadId, { mutationId: id,
      text: `Payload ${id}`, contextExcerpts: [], attachmentIds: [], taskReferences: [],
      source: { kind: "direct_input", resolvedDeliveryMode: "queue", expectedThreadRevision: f.inventory.getThread(f.scope, f.codexThreadId).thread.revision }, now: 390 });
    const frozenItem = enqueue("frozen").item, pendingItem = enqueue("unfrozen").item;
    const frozen = f.settings.freezeOperationSnapshot(f.scope, { applicationThreadId: f.codexThreadId, applicationOperationId: "frozen", now: 391 });
    await f.perform(f.request("save-fast", "fast"));
    expect(f.settings.freezeOperationSnapshot(f.scope, { applicationThreadId: f.codexThreadId, applicationOperationId: "frozen", now: 410 })).toEqual(frozen);
    expect(f.settings.freezeOperationSnapshot(f.scope, { applicationThreadId: f.codexThreadId, applicationOperationId: "unfrozen", now: 410 }).settings.serviceTier).toBe("fast");
    expect(queue.get(f.scope, f.codexThreadId, frozenItem.id)).toEqual(frozenItem);
    expect(queue.get(f.scope, f.codexThreadId, pendingItem.id)).toEqual(pendingItem);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["queue", "steer"] as const)("preserves the asymmetric thread CAS policy around %s admission", async mode => {
    const f = speedFixture(true); const queue = new QueuedInputRepository(f.database);
    const originalSpeed = f.request("speed-after-input", "fast");
    const originalThreadRevision = originalSpeed.expectedThreadRevision;
    const enqueue = (id: string, expectedThreadRevision: number) => queue.enqueue(f.scope, f.codexThreadId, {
      mutationId: id, text: `Preserve ${mode} payload`, contextExcerpts: [], attachmentIds: [], taskReferences: [],
      source: { kind: "direct_input", resolvedDeliveryMode: mode, ...(mode === "steer" ? { resolvedSteerTarget: { kind: "turn" as const, turnId: "target-turn" } } : {}), expectedThreadRevision }, now: 392,
    });
    const input = enqueue("input-first", originalThreadRevision).item;
    await f.perform(originalSpeed);
    expect(queue.get(f.scope, f.codexThreadId, input.id)).toEqual(input);
    const beforeSpeed = f.inventory.getThread(f.scope, f.codexThreadId).thread.revision;
    await f.perform(f.request("speed-first", "ultrafast"));
    expect(() => enqueue("stale-input", beforeSpeed)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(queue.get(f.scope, f.codexThreadId, input.id)).toEqual(input);
    expect(f.settings.find(f.scope, f.codexThreadId)?.desired?.serviceTier).toBe("ultrafast");
  });

  it("saves drafts without acquiring a runtime and rejects retired action shapes", async () => {
    const f = fixture({ unbound: true, enabledAutomation: true });
    const base = speedRequest(f, "draft", "fast");
    const response = await f.persistence.performProviderFeature(f.scope, f.codexThreadId, { ...base, actor: undefined,
      expectedThreadRevision: f.inventory.getThread(f.scope, f.codexThreadId).thread.revision,
      operation: { ...base.operation, expectedMutationRevision: f.settings.find(f.scope, f.codexThreadId)!.desiredRevision } });
    expect(response).toMatchObject({ status: "provider_feature_result" });
    expect(f.automations.getDefinition(f.scope, f.automation!.id).enabled).toBe(true);
    await expect(f.persistence.performProviderFeature(f.scope, f.codexThreadId, { ...base, mutationId: "retired", operation: { ...base.operation, actionId: "set_fast", arguments: null } })).rejects.toThrow();
  });

  it("notifies a committed execution-policy edit before failed native synchronization", async () => {
    const notified = vi.fn();
    const managedTui = {
      syncSettings: vi.fn(async () => {
        expect(notified).toHaveBeenCalledOnce();
        throw new Error("tui_sync_failed");
      }),
    } as unknown as CodexManagedTuiController;
    const current = fixture({ managedTui, desiredSettingsChanged: notified });
    const thread = current.inventory.getThread(current.scope, current.codexThreadId).thread;
    const settings = current.settings.find(current.scope, current.codexThreadId)!;
    notified.mockImplementation((changedScope, applicationThreadId) => {
      expect(current.database.inTransaction).toBe(false);
      expect(current.settings.find(changedScope, applicationThreadId)?.desired?.sandboxMode).toBe("workspace-write");
      expect(current.featureMutations.find(changedScope, "policy-edit")?.state).toBe("accepted");
    });
    const mutation = { mutationId: "policy-edit", expectedThreadRevision: thread.revision, now: 400,
      operation: { action: "perform_provider_feature" as const,
        feature: { featureId: "codex.execution", schemaVersion: 1 }, actionId: "set_sandbox_workspace",
        arguments: null, expectedMutationRevision: settings.revision },
    };
    await expect(current.persistence.performProviderFeature(current.scope, current.codexThreadId, mutation))
      .rejects.toThrow("tui_sync_failed");
    expect(notified).toHaveBeenCalledExactlyOnceWith(current.scope, current.codexThreadId);
    // The committed receipt makes retry a replay; it must not repeat the edit.
    await expect(current.persistence.performProviderFeature(current.scope, current.codexThreadId, mutation))
      .resolves.toEqual({ applicationOperationId: "policy-edit" });
    expect(notified).toHaveBeenCalledOnce();
  });

  it("durably replays managed TUI Start and Stop without repeating either external effect", async () => {
    const managedTui = {
      presentation: vi.fn(() => ({
        state: {
          lifecycle: "running",
          resourceGeneration: 41,
          streamAvailable: true,
        },
      })),
      syncSettings: vi.fn(async () => undefined),
    } as unknown as CodexManagedTuiController;
    const current = fixture({ managedTui });
    const thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    const startMutation = {
      mutationId: "tui-start-once",
      expectedThreadRevision: thread.revision,
      operation: {
        action: "perform_provider_feature" as const,
        feature: { featureId: "codex.tui", schemaVersion: 1 },
        actionId: "start",
        arguments: null,
        expectedMutationRevision: 1,
      },
      now: 330,
    };
    const startExternal = vi.fn(async () => ({
      outcome: "accepted" as const,
      projectedState: {
        lifecycle: "running",
        resourceGeneration: 41,
        streamAvailable: true,
      },
    }));

    await expect(
      current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        { ...startMutation, mutateExternal: startExternal },
      ),
    ).resolves.toEqual({ applicationOperationId: "tui-start-once" });
    expect(
      current.featureMutations.find(current.scope, "tui-start-once"),
    ).toMatchObject({
      state: "accepted",
      desiredPostcondition: { lifecycle: "running" },
      result: { lifecycle: "running", resourceGeneration: 41 },
    });

    // Simulate replay after runtime eviction/restart: even a newly supplied
    // callback is historical evidence only and cannot recreate the process.
    const forbiddenRespawn = vi.fn(async () => ({
      outcome: "accepted" as const,
    }));
    await expect(
      current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        { ...startMutation, now: 340, mutateExternal: forbiddenRespawn },
      ),
    ).resolves.toEqual({ applicationOperationId: "tui-start-once" });
    expect(startExternal).toHaveBeenCalledTimes(1);
    expect(forbiddenRespawn).not.toHaveBeenCalled();

    const stopMutation = {
      mutationId: "tui-stop-once",
      expectedThreadRevision: thread.revision,
      operation: {
        ...startMutation.operation,
        actionId: "stop",
        expectedMutationRevision: 2,
      },
      now: 350,
    };
    const stopExternal = vi.fn(async () => ({
      outcome: "accepted" as const,
      projectedState: {
        lifecycle: "stopped",
        resourceGeneration: null,
        streamAvailable: false,
      },
    }));
    await current.persistence.performProviderFeature(
      current.scope,
      current.codexThreadId,
      { ...stopMutation, mutateExternal: stopExternal },
    );
    expect(
      current.featureMutations.find(current.scope, "tui-stop-once"),
    ).toMatchObject({
      state: "accepted",
      desiredPostcondition: { lifecycle: "stopped" },
      // Stop preserves the generation of the resource it terminated.
      result: { lifecycle: "stopped", resourceGeneration: 41 },
    });
    await current.persistence.performProviderFeature(
      current.scope,
      current.codexThreadId,
      { ...stopMutation, now: 360, mutateExternal: forbiddenRespawn },
    );
    expect(stopExternal).toHaveBeenCalledTimes(1);
    expect(forbiddenRespawn).not.toHaveBeenCalled();
  });

  it("commits accepted rename and compact beside their durable receipts", () => {
    const current = fixture();
    const initial = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    const generationBefore = current.database
      .prepare(
        `
          SELECT inventory_generation AS inventoryGeneration
          FROM principal_generations
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .get(current.scope.tenantId, current.scope.principalId) as {
      readonly inventoryGeneration: number;
    };
    const rename = {
      mutationId: "rename-operation",
      expectedThreadRevision: initial.revision,
      settingsGuard: { kind: "proven_applied" as const },
      operation: { action: "rename" as const, title: "Renamed by Codex" },
      now: 400,
    };
    current.operations.prepareBackendAction(
      current.scope,
      current.codexThreadId,
      rename,
    );
    current.operations.markBackendActionStarted(
      current.scope,
      rename.mutationId,
    );
    current.database.transaction(() => {
      current.persistence.persistAccepted(
        current.scope,
        current.codexThreadId,
        rename,
      );
      current.operations.acceptBackendAction(current.scope, rename.mutationId);
    })();

    expect(
      current.operations.getBackendAction(current.scope, rename.mutationId),
    ).toMatchObject({
      operationKind: "conversation_rename",
      state: "accepted",
      operation: rename.operation,
    });
    const renamed = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    expect(renamed).toMatchObject({
      title: "Renamed by Codex",
      revision: initial.revision + 1,
    });
    const generationAfter = current.database
      .prepare(
        `
          SELECT inventory_generation AS inventoryGeneration
          FROM principal_generations
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .get(current.scope.tenantId, current.scope.principalId) as {
      readonly inventoryGeneration: number;
    };
    expect(generationAfter.inventoryGeneration).toBe(
      generationBefore.inventoryGeneration + 1,
    );
    expect(
      current.operations.prepareBackendAction(
        current.scope,
        current.codexThreadId,
        rename,
      ).state,
    ).toBe("accepted");

    const compact = {
      mutationId: "compact-operation",
      expectedThreadRevision: renamed.revision,
      settingsGuard: { kind: "proven_applied" as const },
      operation: { action: "compact" as const },
      now: 500,
    };
    current.operations.prepareBackendAction(
      current.scope,
      current.codexThreadId,
      compact,
    );
    current.database.transaction(() => {
      current.persistence.persistAccepted(
        current.scope,
        current.codexThreadId,
        compact,
      );
      current.operations.acceptBackendAction(current.scope, compact.mutationId);
    })();
    expect(
      current.operations.getBackendAction(current.scope, compact.mutationId),
    ).toMatchObject({
      operationKind: "conversation_compact",
      state: "accepted",
    });
    expect(
      current.inventory.getThread(current.scope, current.codexThreadId).thread
        .revision,
    ).toBe(renamed.revision);
  });

  it("rejects cross-principal, cross-backend, stale, and setting writes", () => {
    const current = fixture();
    const revision = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread.revision;
    const acceptedCompact = {
      mutationId: "compact",
      expectedThreadRevision: revision,
      settingsGuard: { kind: "proven_applied" as const },
      operation: { action: "compact" as const },
      now: 600,
    };

    expect(() =>
      current.persistence.persistAccepted(
        { ...current.scope, principalId: "another-principal" },
        current.codexThreadId,
        acceptedCompact,
      ),
    ).toThrow(
      expect.objectContaining<Partial<Error>>({
        message: "The Codex thread action target was not found.",
      }),
    );
    expect(() =>
      current.persistence.persistAccepted(
        current.scope,
        current.piThreadId,
        acceptedCompact,
      ),
    ).toThrow(
      expect.objectContaining<Partial<Error>>({
        message: "The Codex thread action target was not found.",
      }),
    );
    expect(() =>
      current.persistence.persistAccepted(
        current.scope,
        current.codexThreadId,
        { ...acceptedCompact, expectedThreadRevision: revision + 1 },
      ),
    ).toThrow(
      expect.objectContaining<Partial<Error>>({
        message: "The Codex thread changed while compaction was accepted.",
      }),
    );
    expect(() =>
      current.persistence.driverAction(
        {
          action: "set_setting",
          settingId: "thinking_level",
          value: "high",
        },
        "setting-operation",
      ),
    ).toThrow(
      expect.objectContaining<Partial<Error>>({
        message:
          "Codex settings must be staged through the local thread settings boundary.",
      }),
    );
    // Codex desired settings never cross the driver action boundary, so a
    // proven-applied settings accept is contract misuse and must fail
    // closed rather than persist against the current revision.
    expect(() =>
      current.persistence.persistAccepted(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "proven-applied-setting",
          expectedThreadRevision: revision,
          settingsGuard: { kind: "proven_applied" as const },
          operation: {
            action: "set_setting" as const,
            settingId: "thinking_level",
            value: "high",
          },
          now: 600,
        },
      ),
    ).toThrow(
      expect.objectContaining<Partial<Error>>({
        message: "The Codex setting mutation is invalid.",
      }),
    );
  });

  it("stages model, reasoning, and execution-policy changes atomically", async () => {
    const current = fixture();
    let thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    let settings = current.settings.find(current.scope, current.codexThreadId)!;
    const modelValue = encodeCodexModelSetting(
      "gpt-5.7-codex",
      "medium",
      ["fast"],
      "standard",
    );
    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "model-change",
      expectedThreadRevision: thread.revision,
      settingsGuard: {
        kind: "staged" as const,
        expectedRevision: settings.revision,
      },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: modelValue,
      },
      now: 700,
    });
    settings = current.settings.find(current.scope, current.codexThreadId)!;
    thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    expect(settings.desired).toEqual({
      model: "gpt-5.7-codex",
      reasoningEffort: "medium",
      serviceTier: "standard",
      ...readOnlyPolicy,
    });

    const featureOperation = {
      action: "perform_provider_feature" as const,
      feature: { featureId: "codex.execution", schemaVersion: 1 },
      actionId: "set_sandbox_workspace",
      arguments: null,
      expectedMutationRevision: settings.revision,
    };
    const result = await current.persistence.performProviderFeature(
      current.scope,
      current.codexThreadId,
      {
        mutationId: "permission-change",
        expectedThreadRevision: thread.revision,
        operation: featureOperation,
        now: 710,
      },
    );
    expect(
      "applicationOperationId" in result ? result.applicationOperationId : null,
    ).toBe("permission-change");
    expect(
      current.settings.find(current.scope, current.codexThreadId)!.desired
        ?.sandboxMode,
    ).toBe("workspace-write");

    expect(
      current.persistence.replayProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "permission-change",
          expectedThreadRevision: thread.revision,
          operation: featureOperation,
        },
      ),
    ).toEqual({ applicationOperationId: "permission-change" });
    expect(() =>
      current.persistence.replayProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "permission-change",
          expectedThreadRevision: thread.revision,
          operation: {
            ...featureOperation,
            actionId: "set_sandbox_read_only",
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("retains an explicit Fast selection across supported models and clamps unsupported models", () => {
    const current = fixture();
    let thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    let settings = current.settings.find(current.scope, current.codexThreadId)!;
    current.settings.updateDesired(current.scope, current.codexThreadId, {
      expectedRevision: settings.revision,
      desired: { ...settings.desired!, serviceTier: "fast" },
      now: 680,
    });
    settings = current.settings.find(current.scope, current.codexThreadId)!;

    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "fast-model-change",
      expectedThreadRevision: thread.revision,
      settingsGuard: { kind: "staged", expectedRevision: settings.revision },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: encodeCodexModelSetting(
          "gpt-fast-capable",
          "medium",
          ["fast"],
          "standard",
        ),
      },
      now: 681,
    });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired,
    ).toMatchObject({ model: "gpt-fast-capable", serviceTier: "fast" });

    thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    settings = current.settings.find(current.scope, current.codexThreadId)!;
    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "standard-model-change",
      expectedThreadRevision: thread.revision,
      settingsGuard: { kind: "staged", expectedRevision: settings.revision },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: encodeCodexModelSetting(
          "gpt-standard-only",
          "low",
          [],
          "standard",
        ),
      },
      now: 682,
    });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired,
    ).toMatchObject({ model: "gpt-standard-only", serviceTier: "standard" });
  });

  it("retains Ultrafast only on models that offer it and never steps down to Fast", () => {
    const current = fixture();
    const changeModel = (
      mutationId: string,
      model: string,
      offered: readonly ("fast" | "ultrafast")[],
      now: number,
    ) => {
      const thread = current.inventory.getThread(
        current.scope,
        current.codexThreadId,
      ).thread;
      const settings = current.settings.find(
        current.scope,
        current.codexThreadId,
      )!;
      current.persistence.persistAccepted(current.scope, current.codexThreadId, {
        mutationId,
        expectedThreadRevision: thread.revision,
        settingsGuard: { kind: "staged", expectedRevision: settings.revision },
        operation: {
          action: "set_setting",
          settingId: "model",
          value: encodeCodexModelSetting(model, "medium", offered, "standard"),
        },
        now,
      });
      return current.settings.find(current.scope, current.codexThreadId)
        ?.desired;
    };
    const settings = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    current.settings.updateDesired(current.scope, current.codexThreadId, {
      expectedRevision: settings.revision,
      desired: { ...settings.desired!, serviceTier: "ultrafast" },
      now: 690,
    });

    expect(
      changeModel("ultrafast-capable", "gpt-ultrafast", ["fast", "ultrafast"], 691),
    ).toMatchObject({ model: "gpt-ultrafast", serviceTier: "ultrafast" });
    expect(
      changeModel("ultrafast-only", "gpt-ultrafast-only", ["ultrafast"], 692),
    ).toMatchObject({ model: "gpt-ultrafast-only", serviceTier: "ultrafast" });
    expect(
      changeModel("fast-only", "gpt-fast-only", ["fast"], 693),
    ).toMatchObject({ model: "gpt-fast-only", serviceTier: "standard" });
  });

  it("persists Goal receipts with replay, fingerprint conflict, and uncertain recovery", async () => {
    const database = openOverlayDatabase(":memory:");
    databases.push(database);
    const scope = new SingleUserIdentityProvider(database).getScope();
    const legacy = new ThreadInventoryService(new OverlayRepository(database));
    const environment = legacy.getLocalEnvironment(scope);
    const workspace = legacy.rememberWorkspace(
      scope,
      {
        environmentId: environment.id,
        canonicalPath: "/tmp/codex-goal-actions",
        displayName: "Codex goal actions",
        availability: "available",
        trustState: "trusted",
      },
      100,
    );
    applyBackendNormalizationMigration(database, {
      configuration,
      quiescentCutoverConfirmed: true,
      appliedAt: 200,
    });
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    const configurations = new BackendConfigurationRepository(database);
    importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "codex-persistence-fixture" }, 210);

    new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 210 });
    const codexProfile = configurations
      .listProfiles(scope)
      .find(({ templateId }) => templateId === "codex-local")!;
    const bindings = new ConversationBindingRepository(database);
    const settings = new CodexThreadExecutionSettingsRepository(database);
    const featureMutations = new ProviderFeatureMutationRepository(database);
    const goalSessions = new CodexGoalSessionRegistry({ now: () => 800 });
    const created = bindings.createUnboundThread(scope, {
      id: "goal-thread",
      workspaceId: workspace.id,
      connectionProfileId: codexProfile.id,
      title: "Goal thread",
      now: 300,
    });
    bindings.bindDiscoveredConversation(scope, created.id, {
      backendConversationId: "native-goal-thread",
      now: 310,
    });
    settings.initialize(scope, {
      applicationThreadId: created.id,
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...readOnlyPolicy,
      },
      now: 320,
    });
    goalSessions.store.publish(scope, {
      applicationThreadId: created.id,
      nativeThreadId: "native-goal-thread",
      state: { state: "unset" },
      connectionGeneration: 1,
      now: 330,
    });
    const inventory = new InventoryRepository(database);
    const persistence = new CodexThreadActionPersistence({
      desiredSettingsChanged: () => undefined,
      database,
      scope,
      backendInstanceId: "codex-primary",
      settings,
      featureMutations,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      defaultExecutionPolicyByConnectionId: new Map([
        [codexProfile.id, readOnlyPolicy],
      ]),
      goalSessions,
    });
    const thread = inventory.getThread(scope, created.id).thread;
    const goalRevision = goalSessions.store.get(scope, created.id)!.revision;
    const createOperation = {
      action: "perform_provider_feature" as const,
      feature: { featureId: "codex.goal", schemaVersion: 1 },
      actionId: "create",
      arguments: boundValue({ objective: "Ship Goal recovery" }),
      expectedMutationRevision: goalRevision,
    };

    const accepted = await persistence.performProviderFeature(
      scope,
      created.id,
      {
        mutationId: "goal-create",
        expectedThreadRevision: thread.revision,
        operation: createOperation,
        now: 900,
        mutateExternal: async () => ({
          outcome: "accepted" as const,
          projectedState: {
            state: "set" as const,
            objective: "Ship Goal recovery",
            status: "active" as const,
          },
        }),
      },
    );
    expect(
      "applicationOperationId" in accepted
        ? accepted.applicationOperationId
        : null,
    ).toBe("goal-create");
    const receipt = featureMutations.find(scope, "goal-create")!;
    expect(receipt.state).toBe("accepted");
    expect(receipt.desiredPostcondition).toMatchObject({
      kind: "create",
      status: "active",
    });
    expect(receipt.desiredPostcondition).not.toHaveProperty("objective");
    expect(receipt.result).toMatchObject({
      state: "set",
      status: "active",
    });
    expect(receipt.result).not.toHaveProperty("objective");

    expect(
      persistence.replayProviderFeature(scope, created.id, {
        mutationId: "goal-create",
        expectedThreadRevision: thread.revision,
        operation: createOperation,
      }),
    ).toEqual({ applicationOperationId: "goal-create" });

    expect(() =>
      persistence.replayProviderFeature(scope, created.id, {
        mutationId: "goal-create",
        expectedThreadRevision: thread.revision,
        operation: {
          ...createOperation,
          arguments: boundValue({ objective: "Different objective" }),
        },
      }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));

    // Seed an active projection for pause uncertain path.
    const afterCreate = inventory.getThread(scope, created.id).thread;
    goalSessions.store.publish(scope, {
      applicationThreadId: created.id,
      nativeThreadId: "native-goal-thread",
      state: {
        state: "set",
        objective: "Ship Goal recovery",
        status: "active",
      },
      connectionGeneration: 1,
      now: 910,
    });
    const activeRevision = goalSessions.store.get(scope, created.id)!.revision;
    const pauseOperation = {
      action: "perform_provider_feature" as const,
      feature: { featureId: "codex.goal", schemaVersion: 1 },
      actionId: "pause",
      arguments: boundValue({}),
      expectedMutationRevision: activeRevision,
    };
    const uncertain = await persistence.performProviderFeature(
      scope,
      created.id,
      {
        mutationId: "goal-pause-uncertain",
        expectedThreadRevision: afterCreate.revision,
        operation: pauseOperation,
        now: 920,
        mutateExternal: async () => ({
          outcome: "uncertain" as const,
          safeMessage: "goal_mutation_uncertain",
        }),
      },
    );
    expect(uncertain).toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(featureMutations.find(scope, "goal-pause-uncertain")?.state).toBe(
      "uncertain",
    );

    // Pre-boundary rejection throws and does not accept the receipt.
    goalSessions.store.publish(scope, {
      applicationThreadId: created.id,
      nativeThreadId: "native-goal-thread",
      state: {
        state: "set",
        objective: "Ship Goal recovery",
        status: "active",
      },
      connectionGeneration: 1,
      now: 930,
    });
    const stillActive = goalSessions.store.get(scope, created.id)!;
    const threadAgain = inventory.getThread(scope, created.id).thread;
    await expect(
      persistence.performProviderFeature(scope, created.id, {
        mutationId: "goal-pause-rejected",
        expectedThreadRevision: threadAgain.revision,
        operation: {
          action: "perform_provider_feature",
          feature: { featureId: "codex.goal", schemaVersion: 1 },
          actionId: "pause",
          arguments: boundValue({}),
          expectedMutationRevision: stillActive.revision,
        },
        now: 940,
        mutateExternal: async () => ({
          outcome: "rejected" as const,
          safeMessage: "Goal action rejected before boundary",
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(featureMutations.find(scope, "goal-pause-rejected")?.state).toBe(
      "prepared",
    );
  });

  it("resolves an imported thread atomically from an explicit model selection", () => {
    const current = fixture({ imported: true });
    const thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    const unresolved = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    expect(unresolved.desired).toBeNull();

    const modelValue = encodeCodexModelSetting(
      "gpt-5.7-codex",
      "medium",
      ["fast"],
      "standard",
    );
    current.persistence.persistAccepted(current.scope, current.codexThreadId, {
      mutationId: "resolve-imported-settings",
      expectedThreadRevision: thread.revision,
      settingsGuard: {
        kind: "staged" as const,
        expectedRevision: unresolved.revision,
      },
      operation: {
        action: "set_setting",
        settingId: "model",
        value: modelValue,
      },
      now: 720,
    });

    expect(
      current.settings.find(current.scope, current.codexThreadId)!.desired,
    ).toEqual({
      model: "gpt-5.7-codex",
      reasoningEffort: "medium",
      serviceTier: "standard",
      ...readOnlyPolicy,
    });
  });

  it("forces network on for unrestricted and rejects an invalid disable", async () => {
    const current = fixture();
    const apply = async (mutationId: string, actionId: string, now: number) => {
      const thread = current.inventory.getThread(
        current.scope,
        current.codexThreadId,
      ).thread;
      const settings = current.settings.find(
        current.scope,
        current.codexThreadId,
      )!;
      return current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId,
          expectedThreadRevision: thread.revision,
          operation: {
            action: "perform_provider_feature",
            feature: { featureId: "codex.execution", schemaVersion: 1 },
            actionId,
            arguments: null,
            expectedMutationRevision: settings.revision,
          },
          now,
        },
      );
    };

    await apply("enable-unrestricted", "set_sandbox_unrestricted", 730);
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired,
    ).toMatchObject({
      sandboxMode: "danger-full-access",
      networkAccess: "enabled",
    });

    await expect(
      apply("disable-unrestricted-network", "set_network_disabled", 740),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(
      current.featureMutations.find(
        current.scope,
        "disable-unrestricted-network",
      ),
    ).toBeUndefined();

    await apply("restore-workspace", "set_sandbox_workspace", 750);
    await apply("disable-workspace-network", "set_network_disabled", 760);
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired,
    ).toMatchObject({
      sandboxMode: "workspace-write",
      networkAccess: "disabled",
    });
  });

  it("rolls back a stale provider-feature receipt with no partial mutation", async () => {
    const current = fixture();
    const thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    const settings = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    await expect(
      current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "stale-permission",
          expectedThreadRevision: thread.revision + 1,
          operation: {
            action: "perform_provider_feature",
            feature: { featureId: "codex.execution", schemaVersion: 1 },
            actionId: "set_sandbox_workspace",
            arguments: null,
            expectedMutationRevision: settings.revision,
          },
          now: 800,
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "conflict" }));
    expect(
      current.featureMutations.find(current.scope, "stale-permission"),
    ).toBeUndefined();
    expect(current.settings.find(current.scope, current.codexThreadId)).toEqual(
      settings,
    );
  });

  it("admits every durable execution tuple allowed for a manual Codex turn", () => {
    const current = fixture();
    const policy = new CodexAutomationExecutionPolicy(
      current.database,
      compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    );
    expect(() =>
      policy.assertCanAutomate(current.scope, current.codexThreadId),
    ).not.toThrow();
    const deniedModelPolicy = new CodexAutomationExecutionPolicy(
      current.database,
      compileBackendModelPolicy(
        {
          type: "denylist",
          denied: [{ modelIds: ["gpt-5.6-codex"], reasoningEfforts: ["low"] }],
        },
        "model_effort",
      ),
    );
    expect(() =>
      deniedModelPolicy.assertCanAutomate(current.scope, current.codexThreadId),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    const settings = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    current.settings.updateDesired(current.scope, current.codexThreadId, {
      expectedRevision: settings.revision,
      desired: { ...settings.desired!, ...workspacePolicy },
      now: 900,
    });
    expect(() =>
      policy.assertCanAutomate(current.scope, current.codexThreadId),
    ).not.toThrow();
    const workspaceSettings = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    current.settings.updateDesired(current.scope, current.codexThreadId, {
      expectedRevision: workspaceSettings.revision,
      desired: {
        ...workspaceSettings.desired!,
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
      },
      now: 901,
    });
    expect(() =>
      policy.assertCanAutomate(current.scope, current.codexThreadId),
    ).not.toThrow();
    expect(() =>
      policy.assertCanAutomate(
        { ...current.scope, principalId: "other" },
        current.codexThreadId,
      ),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
