import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
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
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { CodexThreadActionPersistence } from "../../src/server/backends/codex/codex-thread-action-persistence.js";
import type { CodexManagedTuiController } from "../../src/server/backends/codex/codex-managed-tui-controller.js";
import { CodexAutomationExecutionPolicy } from "../../src/server/backends/codex/codex-automation-execution-policy.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
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
    readonly managedTui?: CodexManagedTuiController;
    readonly fastModeRuntime?: {
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
  return {
    database,
    scope,
    inventory: new InventoryRepository(database),
    operations: new ConversationOperationRepository(database),
    codexThreadId,
    piThreadId: createBound("pi-thread", piProfile.id, "native-pi-thread"),
    persistence: new CodexThreadActionPersistence({
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
          ref.featureId === "codex.goal" || ref.featureId === "codex.tui"
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

  it("persists Fast mode atomically and synchronizes only after acceptance", async () => {
    const syncServiceTier = vi.fn().mockResolvedValue(undefined);
    const current = fixture({ fastModeRuntime: { syncServiceTier } });
    const thread = current.inventory.getThread(
      current.scope,
      current.codexThreadId,
    ).thread;
    const settings = current.settings.find(
      current.scope,
      current.codexThreadId,
    )!;
    const operation = {
      action: "perform_provider_feature" as const,
      feature: { featureId: "codex.fast_mode", schemaVersion: 1 },
      actionId: "enable",
      arguments: null,
      expectedFeatureRevision: settings.revision,
    };

    await expect(
      current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "fast-enable",
          expectedThreadRevision: thread.revision,
          operation,
          now: 400,
        },
      ),
    ).resolves.toEqual({ applicationOperationId: "fast-enable" });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired
        ?.serviceTier,
    ).toBe("fast");
    expect(syncServiceTier).toHaveBeenCalledWith(
      current.scope,
      current.codexThreadId,
      "fast",
    );
    expect(
      current.featureMutations.find(current.scope, "fast-enable"),
    ).toMatchObject({
      state: "accepted",
      result: { serviceTier: "fast" },
    });

    syncServiceTier.mockClear();
    await expect(
      current.persistence.performProviderFeature(
        current.scope,
        current.codexThreadId,
        {
          mutationId: "fast-enable",
          expectedThreadRevision: thread.revision,
          operation,
          now: 401,
        },
      ),
    ).resolves.toEqual({ applicationOperationId: "fast-enable" });
    expect(syncServiceTier).not.toHaveBeenCalled();
  });

  it("persists Fast mode on an unbound draft without native synchronization", async () => {
    const syncServiceTier = vi.fn().mockResolvedValue(undefined);
    const current = fixture({
      unbound: true,
      fastModeRuntime: { syncServiceTier },
    });
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
          mutationId: "draft-fast-enable",
          expectedThreadRevision: thread.revision,
          operation: {
            action: "perform_provider_feature",
            feature: { featureId: "codex.fast_mode", schemaVersion: 1 },
            actionId: "enable",
            arguments: null,
            expectedFeatureRevision: settings.revision,
          },
          now: 402,
        },
      ),
    ).resolves.toEqual({ applicationOperationId: "draft-fast-enable" });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired
        ?.serviceTier,
    ).toBe("fast");
    expect(syncServiceTier).not.toHaveBeenCalled();
    expect(
      current.featureMutations.find(current.scope, "draft-fast-enable"),
    ).toMatchObject({
      state: "accepted",
      result: { serviceTier: "fast" },
    });
  });

  it("keeps an accepted Fast selection pending when post-commit native sync races", async () => {
    const current = fixture({
      fastModeRuntime: {
        syncServiceTier: vi
          .fn()
          .mockRejectedValue(new Error("generation changed")),
      },
    });
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
          mutationId: "fast-enable-raced-sync",
          expectedThreadRevision: thread.revision,
          operation: {
            action: "perform_provider_feature",
            feature: { featureId: "codex.fast_mode", schemaVersion: 1 },
            actionId: "enable",
            arguments: null,
            expectedFeatureRevision: settings.revision,
          },
          now: 402,
        },
      ),
    ).resolves.toEqual({ applicationOperationId: "fast-enable-raced-sync" });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired
        ?.serviceTier,
    ).toBe("fast");
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
        expectedFeatureRevision: 1,
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
        expectedFeatureRevision: 2,
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
      true,
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
      expectedFeatureRevision: settings.revision,
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
          true,
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
          false,
          "standard",
        ),
      },
      now: 682,
    });
    expect(
      current.settings.find(current.scope, current.codexThreadId)?.desired,
    ).toMatchObject({ model: "gpt-standard-only", serviceTier: "standard" });
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
      expectedFeatureRevision: goalRevision,
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
      expectedFeatureRevision: activeRevision,
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
          expectedFeatureRevision: stillActive.revision,
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
      true,
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
            expectedFeatureRevision: settings.revision,
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
            expectedFeatureRevision: settings.revision,
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
