import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import {
  DatabaseThreadApplicationInventoryReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
} from "../../src/server/db/migrate.js";
import { executionEnvironmentOperationsConfigurationMigration } from "../../src/server/db/migrations/045-execution-environment-operations-configuration.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { Pre93BackendConfigurationRepository } from "../support/pre93/backend-configuration-repository.js";
import {
  ThreadAgentToolPolicyRepository,
  type ThreadAgentToolEligibilityPolicy,
} from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
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
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
    },
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
    },
  ],
  defaultTargetId: "pi-local",
});
const legacyProtocolConfiguration = {
  ...configuration,
  backends: configuration.backends.map((backend) =>
    backend.kind === "pi" ? { ...backend, protocolRelease: "0.83.0" } : backend,
  ),
};

const eligibleToolIds = new Set(["agent.context", "thread.status"]);
const eligibility: ThreadAgentToolEligibilityPolicy = {
  eligibleToolIds,
  presentationOptions: (backendKind) =>
    backendKind === "pi"
      ? [
          { surface: "native", modes: ["progressive", "individual"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ]
      : [{ surface: "cli", modes: ["progressive", "individual"] }],
};

function fixture(): {
  readonly database: ReturnType<typeof openOverlayDatabaseConnection>;
  readonly scope: RequestScope;
  readonly piThreadId: string;
  readonly codexThreadId: string;
  readonly workspaceId: string;
} {
  const database = openOverlayDatabaseConnection(":memory:");
  applyDatabaseMigrations(database, deployedMigrations);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacyInventory = new ThreadInventoryService(
    new OverlayRepository(database),
  );
  const environment = legacyInventory.getLocalEnvironment(scope);
  const workspace = legacyInventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/thread-agent-tool-policy",
      displayName: "Agent tool policy",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const piThread = legacyInventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Pi thread" },
    110,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 200,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter((migration) => migration.version <= 27),
  );
  // Reconcile needs the current environment columns before the fixture creates
  // a pre-schema-28 Codex thread. Migration 31 then rebuilds this table and the
  // registered schema-45 migration adds the columns in their durable order.
  database.exec(executionEnvironmentOperationsConfigurationMigration.sql);
  // This fixture deliberately reconciles before migration 069 removes the
  // historical exact-0.83 Pi constraint. Keep that pre-migration write on the
  // historical compiled profile; current startup reconciliation is covered
  // separately after the mutable-release migration.
  new Pre93BackendConfigurationRepository(database).reconcile(
    scope,
    legacyProtocolConfiguration,
    {
      localWorkspaceRoots: [],
      now: 290,
    },
  );
  const codexThread = new ConversationBindingRepository(
    database,
  ).createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: deriveConnectionProfileId(
      scope.tenantId,
      scope.principalId,
      "codex-local",
    ),
    title: "Codex thread",
    now: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  return {
    database,
    scope,
    piThreadId: piThread.thread.id,
    codexThreadId: codexThread.id,
    workspaceId: workspace.id,
  };
}

describe("thread agent tool policy persistence", () => {
  it("backfills every thread disabled with a backend-appropriate mode", () => {
    const value = fixture();
    try {
      const repository = new ThreadAgentToolPolicyRepository(
        value.database,
        eligibility,
      );
      expect(repository.get(value.scope, value.piThreadId)).toMatchObject({
        enabled: false,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        revision: 0,
        enabledToolIds: [],
      });
      expect(repository.get(value.scope, value.codexThreadId)).toMatchObject({
        enabled: false,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        revision: 0,
        enabledToolIds: [],
      });
      const bindings = new ConversationBindingRepository(value.database);
      const createdPiAfterMigration = bindings.createUnboundThread(
        value.scope,
        {
          workspaceId: value.workspaceId,
          connectionProfileId: deriveConnectionProfileId(
            value.scope.tenantId,
            value.scope.principalId,
            "pi-local",
          ),
          title: "New Pi thread",
          now: 340,
        },
      );
      expect(
        repository.get(value.scope, createdPiAfterMigration.id),
      ).toMatchObject({
        enabled: false,
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary: "environment",
        revision: 0,
        enabledToolIds: [],
        updatedAt: 340,
      });
      const createdCodexAfterMigration = bindings.createUnboundThread(
        value.scope,
        {
          workspaceId: value.workspaceId,
          connectionProfileId: deriveConnectionProfileId(
            value.scope.tenantId,
            value.scope.principalId,
            "codex-local",
          ),
          title: "New Codex thread",
          now: 350,
        },
      );
      expect(
        repository.get(value.scope, createdCodexAfterMigration.id),
      ).toMatchObject({
        enabled: false,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        revision: 0,
        enabledToolIds: [],
        updatedAt: 350,
      });
      expect(
        value.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: latestBackendNormalizedVersion });
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  it("CAS-replaces the exact enabled set without auto-enabling new tools", () => {
    const value = fixture();
    try {
      const policyToolIds = new Set(["agent.context", "thread.status"]);
      const repository = new ThreadAgentToolPolicyRepository(value.database, {
        eligibleToolIds: policyToolIds,
        presentationOptions: (backendKind) =>
          backendKind === "pi"
            ? [
                { surface: "native", modes: ["progressive", "individual"] },
                { surface: "cli", modes: ["progressive", "individual"] },
              ]
            : [{ surface: "cli", modes: ["progressive", "individual"] }],
      });
      const changed = repository.update(value.scope, value.piThreadId, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        enabledToolIds: ["thread.status", "agent.context"],
        accessBoundary: "unrestricted",
        now: 400,
      });
      expect(changed).toMatchObject({
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "unrestricted",
        revision: 1,
        updatedAt: 400,
        enabledToolIds: ["agent.context", "thread.status"],
      });

      policyToolIds.add("thread.tasks");
      expect(
        repository.get(value.scope, value.piThreadId).enabledToolIds,
      ).toEqual(["agent.context", "thread.status"]);

      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 0,
          enabled: false,
          presentation: { surface: "cli", mode: "progressive" },
          enabledToolIds: ["thread.tasks"],
          accessBoundary: "environment",
          now: 401,
        }),
      ).toThrow(/changed in another client/i);
      expect(repository.get(value.scope, value.piThreadId)).toEqual(changed);

      const replaced = repository.update(value.scope, value.piThreadId, {
        expectedRevision: 1,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        enabledToolIds: ["thread.tasks"],
        accessBoundary: "environment",
        now: 402,
      });
      expect(replaced.enabledToolIds).toEqual(["thread.tasks"]);
      expect(replaced.accessBoundary).toEqual("environment");
      expect(replaced.revision).toBe(2);

      policyToolIds.delete("thread.tasks");
      expect(repository.get(value.scope, value.piThreadId)).toMatchObject({
        enabled: true,
        revision: 2,
        enabledToolIds: [],
      });
      expect(
        repository.getDurable(value.scope, value.piThreadId),
      ).toMatchObject({
        enabled: true,
        revision: 2,
        enabledToolIds: ["thread.tasks"],
      });
      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 2,
          enabled: true,
          presentation: { surface: "cli", mode: "progressive" },
          enabledToolIds: ["thread.tasks"],
          accessBoundary: "environment",
          now: 403,
        }),
      ).toThrow(/ineligible/i);
    } finally {
      value.database.close();
    }
  });

  it("projects canonical tool descriptors and truthful backend modes", async () => {
    const value = fixture();
    try {
      const dependencies = createThreadAgentToolPolicyDependencies();
      const reader = new DatabaseThreadApplicationInventoryReader({
        inventory: new InventoryRepository(value.database),
        queue: new QueuedInputRepository(value.database),
        completion: new SubmissionCompletionRepository(value.database),
        agentTools: new ThreadAgentToolPolicyRepository(
          value.database,
          dependencies.eligibility,
        ),
        agentToolCatalog: dependencies.catalog,
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const pi = await reader.getAuthorized(value.scope, value.piThreadId);
      expect(pi.agentTools).toMatchObject({
        enabled: false,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        presentationOptions: [
          { surface: "native", modes: ["progressive", "individual"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      });
      expect(
        pi.agentTools.groups.flatMap(({ tools }) => tools.map(({ id }) => id)),
      ).toEqual([
        "agent.context",
        "environment.list",
        "workspace.list",
        "workspace.open",
        "thread.worktree_list",
        "thread.worktree_set",
        "thread.worktree_clear",
        "thread.status",
        "thread.list",
        "thread.create",
        "thread.messages",
        "thread.send",
        "thread.fork",
        "thread.archive",
        "thread.restore",
        "saved_agent.list",
        "saved_agent.get",
        "saved_agent.options",
        "saved_agent.create",
        "saved_agent.update",
        "saved_agent.delete",
        "task.list",
        "task.get",
        "task.create",
        "task.update",
        "workpad.list",
        "workpad.get",
        "workpad.revisions",
        "workpad.create",
        "workpad.update",
        "automation.get",
        "automation.runs",
        "automation.create",
        "automation.update",
        "automation.set_state",
        "automation.run_now",
        "research.web_search",
      ]);
      expect(
        pi.agentTools.groups.every(({ tools }) =>
          tools.every(({ enabled }) => !enabled),
        ),
      ).toBe(true);

      const codex = await reader.getAuthorized(
        value.scope,
        value.codexThreadId,
      );
      expect(codex.agentTools).toMatchObject({
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        presentationOptions: [
          { surface: "cli", modes: ["progressive", "individual"] },
          { surface: "native", modes: ["progressive", "individual"] },
        ],
      });
    } finally {
      value.database.close();
    }
  });

  it("denies wrong-scope, unknown-tool, duplicate, and unsupported native updates", () => {
    const value = fixture();
    try {
      const repository = new ThreadAgentToolPolicyRepository(
        value.database,
        eligibility,
      );
      const wrongScope = {
        ...value.scope,
        principalId: "019196f7-a0a8-7bc4-a89b-8cf013978499",
      };
      expect(() => repository.get(wrongScope, value.piThreadId)).toThrow(
        /not found/i,
      );
      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          enabledToolIds: ["unknown.tool"],
          accessBoundary: "environment",
          now: 500,
        }),
      ).toThrow(/ineligible/i);
      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "native", mode: "individual" },
          enabledToolIds: ["agent.context", "agent.context"],
          accessBoundary: "environment",
          now: 500,
        }),
      ).toThrow(/duplicated/i);
      expect(() =>
        repository.update(value.scope, value.codexThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          enabledToolIds: ["agent.context"],
          accessBoundary: "environment",
          now: 500,
        }),
      ).toThrow(/unavailable/i);

      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_agent_tool_policies
             SET presentation_surface = 'invalid'
             WHERE application_thread_id = ?`,
          )
          .run(value.piThreadId),
      ).toThrow();
      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_agent_tool_policies
             SET other_environment_access = 'deny'
             WHERE application_thread_id = ?`,
          )
          .run(value.piThreadId),
      ).toThrow();

      expect(repository.get(value.scope, value.piThreadId)).toMatchObject({
        revision: 0,
        enabledToolIds: [],
      });
      expect(repository.get(value.scope, value.codexThreadId)).toMatchObject({
        revision: 0,
        enabledToolIds: [],
      });
    } finally {
      value.database.close();
    }
  });

  it("allows only native presentation for Pi threads on an SSH environment", async () => {
    const value = fixture();
    try {
      value.database
        .prepare(
          `UPDATE execution_environments SET kind = 'ssh'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, environmentId);
      const repository = new ThreadAgentToolPolicyRepository(
        value.database,
        createThreadAgentToolPolicyDependencies().eligibility,
      );
      expect(
        repository.presentationOptions(value.scope, value.piThreadId),
      ).toEqual([
        { surface: "native", modes: ["progressive", "individual"] },
      ]);
      const dependencies = createThreadAgentToolPolicyDependencies();
      const reader = new DatabaseThreadApplicationInventoryReader({
        inventory: new InventoryRepository(value.database),
        queue: new QueuedInputRepository(value.database),
        completion: new SubmissionCompletionRepository(value.database),
        agentTools: repository,
        agentToolCatalog: dependencies.catalog,
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      await expect(
        reader.getAuthorized(value.scope, value.piThreadId),
      ).resolves.toMatchObject({
        agentTools: {
          presentation: { surface: "native", mode: "individual" },
          presentationOptions: [
            { surface: "native", modes: ["progressive", "individual"] },
          ],
        },
      });
      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "cli", mode: "progressive" },
          enabledToolIds: ["task.list"],
          accessBoundary: "environment",
          now: 600,
        }),
      ).toThrow(/unavailable for the thread target/i);

      value.database
        .prepare(
          `UPDATE thread_agent_tool_policies SET presentation_surface = 'cli'
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.piThreadId);
      expect(() => repository.get(value.scope, value.piThreadId)).toThrow(
        /stored agent tool presentation is unavailable/i,
      );
    } finally {
      value.database.close();
    }
  });
});
