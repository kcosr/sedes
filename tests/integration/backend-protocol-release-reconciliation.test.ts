import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import type { ResolvedBackendConfigurationFile } from "../../src/server/config/backend-configuration.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { startProductionApplication } from "../../src/server/production-application.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { OpenCodeThreadRepository } from "../../src/server/backends/opencode/opencode-thread-repository.js";

const localEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

const releaseValidationCases = [
  {
    label: "Pi",
    backendKind: "pi",
    connectionKind: "pi_sdk",
    supportedRelease: "0.86.0",
    unsupportedRelease: "0.83.0",
  },
  {
    label: "Codex",
    backendKind: "codex_app_server",
    connectionKind: "codex_app_server",
    supportedRelease: "0.163.0",
    unsupportedRelease: "0.152.0",
  },
  {
    label: "Claude",
    backendKind: "claude_agent_sdk",
    connectionKind: "claude_agent_sdk",
    supportedRelease: "0.3.296",
    unsupportedRelease: "0.3.225",
  },
  {
    label: "Grok",
    backendKind: "grok_build",
    connectionKind: "grok_acp",
    supportedRelease: "1.x",
    unsupportedRelease: "2.x",
  },
  {
    label: "OpenCode",
    backendKind: "opencode",
    connectionKind: "opencode_http",
    supportedRelease: "2.0.32",
    unsupportedRelease: "2.0.29",
  },
] as const;

function singleBackendConfiguration(
  releaseCase: (typeof releaseValidationCases)[number],
) {
  const backendId = `${releaseCase.backendKind}-primary`;
  const targetId = `${releaseCase.connectionKind}-local`;
  return parseResolvedBackendConfiguration({
    schemaVersion: 10,
    executionEnvironments: [
      {
        id: localEnvironmentId,
        kind: "local",
        label: "Local",
      },
    ],
    backends: [
      {
        id: backendId,
        kind: releaseCase.backendKind,
        label: releaseCase.label,
        enabled: true,
        modelPolicy: { type: "catalog" },
        ...(releaseCase.backendKind === "opencode" ? {
          moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio" } } },
        } : {}),
      },
    ],
    targets: [
      {
        id: targetId,
        kind: releaseCase.connectionKind,
        label: `${releaseCase.label} local`,
        backendInstanceId: backendId,
        executionEnvironmentId: localEnvironmentId,
        enabled: true,
        ...(releaseCase.backendKind === "opencode" ? {
          moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } },
        } : {}),
      },
    ],
    defaultTargetId: targetId,
  });
}

function databaseSeedConfiguration(
  releaseCase: (typeof releaseValidationCases)[number],
) {
  const provider = singleBackendConfiguration(releaseCase);
  if (releaseCase.backendKind === "pi") return provider;

  const piCase = releaseValidationCases[0];
  const pi = singleBackendConfiguration(piCase);
  return {
    ...provider,
    backends: [pi.backends[0]!, provider.backends[0]!],
    targets: [pi.targets[0]!, provider.targets[0]!],
  };
}

function configuration(protocolRelease: string) {
  const resolved = parseResolvedBackendConfiguration({
    schemaVersion: 10,
    executionEnvironments: [
      {
        id: localEnvironmentId,
        kind: "local",
        label: "Local",
      },
    ],
    backends: [
      {
        id: "pi-primary",
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      {
        id: "codex-primary",
        kind: "codex_app_server",
        label: "Primary Codex",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
    ],
    targets: [
      {
        id: "local-primary",
        kind: "pi_sdk",
        label: "Local Pi",
        backendInstanceId: "pi-primary",
        executionEnvironmentId: localEnvironmentId,
        enabled: true,
      },
      {
        id: "local-codex",
        kind: "codex_app_server",
        label: "Local Codex",
        backendInstanceId: "codex-primary",
        executionEnvironmentId: localEnvironmentId,
        enabled: true,
      },
    ],
    defaultTargetId: "local-codex",
  });
  return {
    ...resolved,
    backends: resolved.backends.map((backend) =>
      backend.kind === "codex_app_server"
        ? { ...backend, protocolRelease }
        : backend,
    ),
  };
}

describe("backend protocol release reconciliation", () => {
  it.each(releaseValidationCases)(
    "rejects an operator-supplied $label release before startup mutates persisted configuration",
    async (releaseCase) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "h-protocol-release-reconciliation-"),
      );
      const stateDirectory = path.join(directory, "state");
      const configurationPath = path.join(directory, "backend.json");
      const backendId = `${releaseCase.backendKind}-primary`;
      try {
        const initial = await prepareBackendNormalizedDatabase({
          stateDirectory,
          locksHeld: true,
          quiescentCutoverConfirmed: true,
        });
        new BackendConfigurationRepository(initial.database).reconcile(
          new SingleUserIdentityProvider(initial.database).getScope(), databaseSeedConfiguration(releaseCase),
          { localWorkspaceRoots: [stateDirectory], now: Date.now() },
        );
        initial.database
          .prepare(
            `UPDATE agent_backend_instances
             SET configuration_revision = 7
             WHERE id = ?`,
          )
          .run(backendId);
        const seeded = initial.database
          .prepare(
            `SELECT protocol_release AS protocolRelease,
               configuration_revision AS configurationRevision,
               updated_at AS updatedAt
             FROM agent_backend_instances
             WHERE id = ?`,
          )
          .get(backendId);
        initial.database.close();

        const resolved = singleBackendConfiguration(releaseCase);
        const operatorPinned = {
          ...resolved,
          backends: resolved.backends.map(
            ({ protocolRelease: _compiledRelease, ...backend }) => ({
              ...backend,
              protocolRelease: releaseCase.unsupportedRelease,
            }),
          ),
        };
        await writeFile(
          configurationPath,
          JSON.stringify(operatorPinned),
          "utf8",
        );

        await expect(
          startProductionApplication({
            APP_STATE_DIR: stateDirectory,
            SEDES_CONFIG_FILE: configurationPath,
            PORT: "4784",
          }),
        ).rejects.toThrow();

        const persisted = new Database(
          path.join(stateDirectory, "overlay.sqlite"),
          { readonly: true },
        );
        try {
          expect(
            persisted
              .prepare(
                `SELECT protocol_release AS protocolRelease,
                   configuration_revision AS configurationRevision,
                   updated_at AS updatedAt
                 FROM agent_backend_instances
                 WHERE id = ?`,
              )
              .get(backendId),
          ).toEqual(seeded);
        } finally {
          persisted.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { previousRelease: "2.0.29", expectedRevision: 8, expectedUpdatedAt: 300 },
    { previousRelease: "2.0.32", expectedRevision: 7, expectedUpdatedAt: 240 },
  ])("reconciles OpenCode profile $previousRelease to 2.0.32 while retaining its scoped native binding", ({
    previousRelease, expectedRevision, expectedUpdatedAt,
  }) => {
    const value = savedAgentDatabase();
    try {
      const repository = new BackendConfigurationRepository(value.database);
      const openCodeCase = releaseValidationCases.find(releaseCase => releaseCase.backendKind === "opencode")!;
      const currentConfiguration = databaseSeedConfiguration(openCodeCase);
      const backendId = "opencode-primary", targetId = "opencode_http-local";
      expect(currentConfiguration.backends.find(backend => backend.id === backendId)?.protocolRelease).toBe("2.0.32");
      repository.reconcile(value.scope, {
        ...currentConfiguration,
        backends: currentConfiguration.backends.map(backend => backend.id === backendId
          ? { ...backend, protocolRelease: previousRelease } : backend),
      }, { localWorkspaceRoots: [], now: 200 });
      const profile = repository.getProfileByTemplate(value.scope, targetId);
      const inventory = new InventoryRepository(value.database);
      const environment = inventory.getLocalEnvironment(value.scope);
      const workspace = inventory.upsertWorkspace(value.scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/opencode-protocol-release-reconciliation",
        displayName: "OpenCode protocol release reconciliation",
        project: { kind: "new", name: "OpenCode protocol release reconciliation" },
        available: true, trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 210,
      });
      const bindings = new ConversationBindingRepository(value.database);
      const thread = bindings.createUnboundThread(value.scope, {
        id: "opencode-protocol-release-thread", workspaceId: workspace.id,
        connectionProfileId: profile.id, title: "OpenCode protocol release thread", now: 220,
      });
      const binding = bindings.bindDiscoveredConversation(value.scope, thread.id, {
        backendConversationId: "ses_stable_across_profile_upgrade", now: 230,
      });
      const nativeNamespaceKey = "opencode-profile-reconciliation-store";
      const nativeThreads = new OpenCodeThreadRepository({
        database: value.database, scope: value.scope, backendInstanceId: backendId, nativeNamespaceKey,
      });
      nativeThreads.saveBinding(value.scope, thread.id, {
        version: 1, ...value.scope, backendInstanceId: backendId,
        connectionProfileId: profile.id, executionEnvironmentId: environment.id,
        canonicalWorkspacePath: workspace.canonicalPath, nativeNamespaceKey,
        sessionId: binding.backendConversationId,
      });
      const nativeBinding = nativeThreads.getBinding(value.scope, thread.id);
      value.database.prepare(`UPDATE agent_backend_instances
        SET configuration_revision = 7, updated_at = 240
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(value.scope.tenantId, value.scope.principalId, backendId);
      const backend = repository.getBackend(value.scope, backendId);
      const boundThread = inventory.getThread(value.scope, thread.id);
      for (const now of [300, 400]) {
        repository.reconcile(value.scope, currentConfiguration, { localWorkspaceRoots: [], now });
        expect(repository.getBackend(value.scope, backendId)).toEqual({
          ...backend, protocolRelease: "2.0.32", configurationRevision: expectedRevision,
        });
        expect(value.database.prepare(`SELECT updated_at AS updatedAt
          FROM agent_backend_instances WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
          .get(value.scope.tenantId, value.scope.principalId, backendId)).toEqual({ updatedAt: expectedUpdatedAt });
        expect(repository.getProfileByTemplate(value.scope, targetId)).toEqual(profile);
        expect(inventory.getThread(value.scope, thread.id)).toEqual(boundThread);
        expect(bindings.getBinding(value.scope, thread.id)).toEqual(binding);
        expect(nativeThreads.getBinding(value.scope, thread.id)).toBe(nativeBinding);
      }
    } finally { value.database.close(); }
  });

  it.each(["0.83.0", "0.84.4"])(
    "reconciles persisted Pi %s state to 0.86.0 without changing relationships",
    (previousRelease) => {
      const value = savedAgentDatabase();
      try {
        const repository = new BackendConfigurationRepository(value.database);
        repository.reconcile(value.scope, configuration("0.163.0"), {
          localWorkspaceRoots: [],
          now: 200,
        });
        const profile = repository.getProfileByTemplate(
          value.scope,
          "local-primary",
        );
        const inventory = new InventoryRepository(value.database);
        const environment = inventory.getLocalEnvironment(value.scope);
        const workspace = inventory.upsertWorkspace(value.scope, {
          environmentId: environment.id,
          canonicalPath: "/tmp/pi-protocol-release-reconciliation",
          displayName: "Pi protocol release reconciliation",
          project: { kind: "new", name: "Pi protocol release reconciliation" },
          available: true,
          trustState: "trusted",
          environmentConfigurationRevision: environment.configurationRevision,
          now: 210,
        });
        const bindings = new ConversationBindingRepository(value.database);
        const thread = bindings.createUnboundThread(value.scope, {
          id: "pi-protocol-release-thread",
          workspaceId: workspace.id,
          connectionProfileId: profile.id,
          title: "Pi protocol release thread",
          now: 220,
        });
        const binding = bindings.bindDiscoveredConversation(
          value.scope,
          thread.id,
          {
            backendConversationId: "pi-thread-stable-across-release",
            now: 230,
          },
        );

        value.database
          .prepare(
            `UPDATE agent_backend_instances
             SET protocol_release = ?, configuration_revision = 7,
               updated_at = 240
             WHERE tenant_id = ? AND id = 'pi-primary'`,
          )
          .run(previousRelease, value.scope.tenantId);

        repository.reconcile(value.scope, configuration("0.163.0"), {
          localWorkspaceRoots: [],
          now: 300,
        });
        expect(
          value.database
            .prepare(
              `SELECT protocol_release AS protocolRelease,
                 configuration_revision AS configurationRevision,
                 updated_at AS updatedAt
               FROM agent_backend_instances
               WHERE tenant_id = ? AND id = 'pi-primary'`,
            )
            .get(value.scope.tenantId),
        ).toEqual({
          protocolRelease: "0.86.0",
          configurationRevision: 8,
          updatedAt: 300,
        });
        expect(
          repository.getProfileByTemplate(value.scope, "local-primary"),
        ).toEqual(profile);
        expect(bindings.getBinding(value.scope, thread.id)).toEqual(binding);

        repository.reconcile(value.scope, configuration("0.163.0"), {
          localWorkspaceRoots: [],
          now: 400,
        });
        expect(
          value.database
            .prepare(
              `SELECT protocol_release AS protocolRelease,
                 configuration_revision AS configurationRevision,
                 updated_at AS updatedAt
               FROM agent_backend_instances
               WHERE tenant_id = ? AND id = 'pi-primary'`,
            )
            .get(value.scope.tenantId),
        ).toEqual({
          protocolRelease: "0.86.0",
          configurationRevision: 8,
          updatedAt: 300,
        });
      } finally {
        value.database.close();
      }
    },
  );

  it.each(["0.153.0", "0.162.1"])("reconciles a persisted Codex %s release to 0.163.0 without changing backend relationships", (previousRelease) => {
    const value = savedAgentDatabase();
    try {
      const repository = new BackendConfigurationRepository(value.database);
      repository.reconcile(value.scope, configuration("0.163.0"), {
        localWorkspaceRoots: [],
        now: 200,
      });
      const profile = repository.getProfileByTemplate(
        value.scope,
        "local-codex",
      );
      const environment = new InventoryRepository(
        value.database,
      ).getLocalEnvironment(value.scope);
      const workspace = new InventoryRepository(value.database).upsertWorkspace(
        value.scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/backend-protocol-release-reconciliation",
          displayName: "Backend protocol release reconciliation",
          project: { kind: "new", name: "Backend protocol release reconciliation" },
          available: true,
          trustState: "trusted",
          environmentConfigurationRevision: environment.configurationRevision,
          now: 210,
        },
      );
      const bindings = new ConversationBindingRepository(value.database);
      const thread = bindings.createUnboundThread(value.scope, {
        id: "protocol-release-thread",
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Protocol release thread",
        now: 220,
      });
      const binding = bindings.bindDiscoveredConversation(
        value.scope,
        thread.id,
        {
          backendConversationId: "provider-thread-stable-across-release",
          now: 230,
        },
      );

      value.database
        .prepare(
          `UPDATE agent_backend_instances
           SET protocol_release = ?, configuration_revision = 7,
             updated_at = 240
           WHERE tenant_id = ? AND id = 'codex-primary'`,
        )
        .run(previousRelease, value.scope.tenantId);

      repository.reconcile(value.scope, configuration("0.163.0"), {
        localWorkspaceRoots: [],
        now: 300,
      });
      expect(
        value.database
          .prepare(
            `SELECT id, kind, protocol_release AS protocolRelease,
               configuration_revision AS configurationRevision,
               updated_at AS updatedAt
             FROM agent_backend_instances
             WHERE tenant_id = ? AND id = 'codex-primary'`,
          )
          .get(value.scope.tenantId),
      ).toEqual({
        id: "codex-primary",
        kind: "codex_app_server",
        protocolRelease: "0.163.0",
        configurationRevision: 8,
        updatedAt: 300,
      });
      expect(
        repository.getProfileByTemplate(value.scope, "local-codex"),
      ).toEqual(profile);
      expect(bindings.getBinding(value.scope, thread.id)).toEqual(binding);

      repository.reconcile(value.scope, configuration("0.163.0"), {
        localWorkspaceRoots: [],
        now: 400,
      });
      expect(
        value.database
          .prepare(
            `SELECT protocol_release AS protocolRelease,
               configuration_revision AS configurationRevision,
               updated_at AS updatedAt
             FROM agent_backend_instances
             WHERE tenant_id = ? AND id = 'codex-primary'`,
          )
          .get(value.scope.tenantId),
      ).toEqual({
        protocolRelease: "0.163.0",
        configurationRevision: 8,
        updatedAt: 300,
      });

      repository.reconcile(value.scope, configuration("0.145.0"), {
        localWorkspaceRoots: [],
        now: 500,
      });
      expect(
        value.database
          .prepare(
            `SELECT protocol_release AS protocolRelease,
               configuration_revision AS configurationRevision,
               updated_at AS updatedAt
             FROM agent_backend_instances
             WHERE tenant_id = ? AND id = 'codex-primary'`,
          )
          .get(value.scope.tenantId),
      ).toEqual({
        protocolRelease: "0.145.0",
        configurationRevision: 9,
        updatedAt: 500,
      });
      expect(bindings.getBinding(value.scope, thread.id)).toEqual(binding);

      const rollbackConfiguration = configuration("0.145.0");
      const kindReplacement: ResolvedBackendConfigurationFile = {
        ...rollbackConfiguration,
        backends: [
          rollbackConfiguration.backends[0]!,
          {
            id: "codex-primary",
            kind: "pi",
            label: "Replacement Pi",
            protocolRelease: "0.86.0",
            enabled: true,
            modelPolicy: { type: "catalog" },
          },
        ],
        targets: [
          rollbackConfiguration.targets[0]!,
          {
            id: "local-codex",
            kind: "pi_sdk",
            label: "Replacement Pi target",
            backendInstanceId: "codex-primary",
            executionEnvironmentId: localEnvironmentId,
            enabled: true,
          },
        ],
      };
      expect(() =>
        repository.reconcile(value.scope, kindReplacement, {
          localWorkspaceRoots: [],
          now: 600,
        }),
      ).toThrow(/immutable identity fields/i);
    } finally {
      value.database.close();
    }
  });
});
