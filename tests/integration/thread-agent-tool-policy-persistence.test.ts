import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import {
  DatabaseThreadApplicationInventoryReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { DatabaseThreadAgentToolRuntimeAvailabilityReader } from "../../src/server/conversations/thread-agent-tool-runtime-availability.js";
import type { BackendModuleRuntime } from "../../src/server/backends/module.js";
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
      : [
          { surface: "native", modes: ["individual", "progressive"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
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
  it("tracks the current named association and preserves it only for unchanged policy content", async () => {
    const value = fixture();
    try {
      const policies = new ThreadAgentToolPolicyRepository(value.database,eligibility);
      const sets = new ToolPolicyRepository(value.database);
      const first = sets.create(value.scope,{name:"Review",enabledToolIds:["thread.status","agent.context"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}},400);
      const content = {enabled:true,enabledToolIds:[...first.enabledToolIds],resourceScope:first.resourceScope};
      let current = policies.update(value.scope,value.piThreadId,{...content,expectedRevision:0,presentation:{surface:"native",mode:"individual"},policySet:{id:first.id,revision:first.revision},now:500});
      const captured = {id:first.id,name:first.name,revision:first.revision};
      expect(current.policySet).toEqual(captured);
      const changedDefinition = sets.update(value.scope,first.id,{name:"Changed review",enabledToolIds:["thread.status"],resourceScope:first.resourceScope},0,501);
      current = policies.update(value.scope,value.piThreadId,{...content,expectedRevision:current.revision,presentation:{surface:"native",mode:"progressive"},now:502});
      expect(current.policySet).toEqual(captured);
      sets.delete(value.scope,first.id,changedDefinition.revision);
      current = policies.update(value.scope,value.piThreadId,{...content,expectedRevision:current.revision,presentation:{surface:"native",mode:"individual"},policySet:{id:first.id,revision:first.revision},now:503});
      expect(current.policySet).toEqual(captured);
      current = policies.update(value.scope,value.piThreadId,{...content,expectedRevision:current.revision,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true},presentation:current.presentation,now:504});
      expect(current.policySet).toBeNull();
      expect(() => policies.update(value.scope,value.piThreadId,{...content,expectedRevision:current.revision,presentation:current.presentation,policySet:{id:first.id,revision:first.revision},now:505})).toThrow(/not found/i);
      expect(policies.getDurable(value.scope,value.piThreadId)).toEqual(current);
      const second = sets.create(value.scope,{name:"Current review",enabledToolIds:[...current.enabledToolIds],resourceScope:current.resourceScope},506);
      const next = policies.update(value.scope,value.piThreadId,{...current,expectedRevision:current.revision,policySet:{id:second.id,revision:second.revision},now:507});
      expect(next.revision).toBe(current.revision+1);
      expect(next.policySet).toEqual({id:second.id,name:second.name,revision:second.revision});
      current = policies.update(value.scope,value.piThreadId,{...next,expectedRevision:next.revision,policySet:null,now:508});
      expect(current.policySet).toBeNull();
      expect(current.revision).toBe(next.revision+1);
      const dependencies = createThreadAgentToolPolicyDependencies();
      const reader = new DatabaseThreadApplicationInventoryReader({inventory:new InventoryRepository(value.database),queue:new QueuedInputRepository(value.database),completion:new SubmissionCompletionRepository(value.database),agentTools:policies,agentToolCatalog:dependencies.catalog,agentToolRuntimeAvailability:{read:()=>({availability:"available"})},directoryBrowsingAvailability:()=>"unavailable",executionWorkspaces:directThreadExecutionWorkspaceReader});
      const projected = (await reader.getAuthorized(value.scope,value.piThreadId)).agentTools;
      expect(projected.policySet).toBeNull();
      expect(projected).not.toHaveProperty("origin");
    } finally {value.database.close();}
  });

  it("rejects stale, foreign, or mismatching named associations without changing grants or metadata", () => {
    const value = fixture();
    try {
      const policies = new ThreadAgentToolPolicyRepository(value.database,eligibility);
      const sets = new ToolPolicyRepository(value.database);
      const definition = sets.create(value.scope,{name:"Exact review",enabledToolIds:["thread.status"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}},400);
      const valid = {enabled:true,enabledToolIds:definition.enabledToolIds,resourceScope:definition.resourceScope,presentation:{surface:"native" as const,mode:"individual" as const},expectedRevision:0,now:500};
      const before = policies.getDurable(value.scope,value.piThreadId);
      const reference = {id:definition.id,revision:definition.revision};
      for (const invalid of [
        {...valid,enabled:false,policySet:reference},
        {...valid,enabledToolIds:["agent.context"],policySet:reference},
        {...valid,resourceScope:{allowOtherEnvironments:true,allowOtherProjects:false},policySet:reference},
        {...valid,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true},policySet:reference},
        {...valid,policySet:{...reference,revision:1}},
      ]) {
        expect(() => policies.update(value.scope,value.piThreadId,invalid)).toThrow();
        expect(policies.getDurable(value.scope,value.piThreadId)).toEqual(before);
      }
      const foreignScope = {...value.scope,principalId:"foreign-policy-owner"};
      value.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',100)").run(foreignScope.tenantId,foreignScope.principalId);
      const foreign = sets.create(foreignScope,{name:"Private",enabledToolIds:definition.enabledToolIds,resourceScope:definition.resourceScope},400);
      expect(() => policies.update(value.scope,value.piThreadId,{...valid,policySet:{id:foreign.id,revision:foreign.revision}})).toThrow(/not found/i);
      expect(policies.getDurable(value.scope,value.piThreadId)).toEqual(before);
      const applied = policies.update(value.scope,value.piThreadId,{...valid,policySet:reference});
      expect(applied.policySet).toEqual({id:definition.id,name:definition.name,revision:definition.revision});
      expect(() => policies.update(value.scope,value.piThreadId,{...valid,expectedRevision:0,policySet:null})).toThrow(/changed in another client/i);
      expect(policies.getDurable(value.scope,value.piThreadId)).toEqual(applied);
      const custom = policies.update(value.scope,value.piThreadId,{...valid,expectedRevision:applied.revision,enabledToolIds:["agent.context"],now:501});
      expect(custom.policySet).toBeNull();
      const disabled = policies.update(value.scope,value.piThreadId,{...valid,expectedRevision:custom.revision,enabled:false,now:502});
      expect(disabled.policySet).toBeNull();
    } finally {value.database.close();}
  });

  it("projects runtime and archived-thread denials independently of saved grants and catalog availability", async () => {
    const value = fixture();
    try {
      const dependencies = createThreadAgentToolPolicyDependencies();
      const policies = new ThreadAgentToolPolicyRepository(value.database, dependencies.eligibility);
      policies.update(value.scope, value.codexThreadId, {
        expectedRevision: 0, enabled: true, enabledToolIds: ["agent.context"],
        presentation: { surface: "native", mode: "individual" }, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true }, now: 500,
      });
      const inventory = new InventoryRepository(value.database);
      const calls: string[] = [];
      let eligible = false;
      const backendId = inventory.getThread(value.scope, value.codexThreadId).thread.backendInstanceId;
      const runtime = {
        scope: value.scope,
        instance: { id: backendId, tenantId: value.scope.tenantId, enabled: true },
        agentToolRuntimeAvailability: ({ applicationThreadId }: { applicationThreadId: string }) => {
          calls.push(applicationThreadId);
          return eligible ? { availability: "available" as const } : {
            availability: "unavailable" as const, reason: "Enable network access in this thread's execution settings.",
          };
        },
      } as unknown as BackendModuleRuntime;
      const availability = new DatabaseThreadAgentToolRuntimeAvailabilityReader({
        inventory, runtimes: new Map([[backendId, runtime]]), executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const reader = new DatabaseThreadApplicationInventoryReader({
        inventory, queue: new QueuedInputRepository(value.database), completion: new SubmissionCompletionRepository(value.database),
        agentTools: policies, agentToolCatalog: dependencies.catalog, agentToolRuntimeAvailability: availability,
        directoryBrowsingAvailability: () => "unavailable", executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const denied = await reader.getAuthorized(value.scope, value.codexThreadId);
      expect(denied.agentTools).toMatchObject({ enabled: true, revision: 1,
        presentation: { surface: "native", mode: "individual" },
        runtimeAvailability: { availability: "unavailable", reason: { text: expect.stringContaining("Enable network access") } },
      });
      expect(denied.agentTools.groups.flatMap(group => group.tools).find(tool => tool.id === "agent.context"))
        .toMatchObject({ enabled: true, available: true });
      eligible = true;
      const restored = await reader.getAuthorized(value.scope, value.codexThreadId);
      expect(restored.agentTools).toEqual({ ...denied.agentTools, runtimeAvailability: { availability: "available" } });
      expect(calls).toEqual([value.codexThreadId, value.codexThreadId]);
      expect(() => availability.read({ ...value.scope, principalId: "different-principal" }, value.codexThreadId,
        { surface: "native", mode: "individual" })).toThrow(/not found/i);
      expect(calls).toHaveLength(2);
      value.database.prepare("UPDATE thread_principal_state SET inventory_state = 'archived' WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?")
        .run(value.scope.tenantId, value.scope.principalId, value.codexThreadId);
      const archived = await reader.getAuthorized(value.scope, value.codexThreadId);
      expect(archived.agentTools).toEqual({ ...restored.agentTools, runtimeAvailability: {
        availability: "unavailable", reason: { text: "This thread is archived. Restore it to use Sedes tools." },
      } });
      expect(calls).toHaveLength(2);
      value.database.prepare("UPDATE thread_principal_state SET inventory_state = 'active' WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?")
        .run(value.scope.tenantId, value.scope.principalId, value.codexThreadId);
      expect((await reader.getAuthorized(value.scope, value.codexThreadId)).agentTools).toEqual(restored.agentTools);
      expect(calls).toHaveLength(3);
    } finally { value.database.close(); }
  });

  it("fails closed for unavailable, cross-scope, or disabled backend runtime contributions", () => {
    const value = fixture();
    try {
      const inventory = new InventoryRepository(value.database);
      const backendId = inventory.getThread(value.scope, value.codexThreadId).thread.backendInstanceId;
      const runtimes = new Map<string, BackendModuleRuntime>();
      const reader = new DatabaseThreadAgentToolRuntimeAvailabilityReader({
        inventory, runtimes, executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const read = () => reader.read(value.scope, value.codexThreadId, { surface: "native", mode: "individual" });
      expect(read()).toMatchObject({ availability: "unavailable" });
      const runtime = { scope: { ...value.scope, principalId: "other" }, instance: { id: backendId, tenantId: value.scope.tenantId, enabled: true },
        agentToolRuntimeAvailability: () => { throw new Error("must not call wrong-scope backend"); },
      } as unknown as BackendModuleRuntime;
      runtimes.set(backendId, runtime);
      expect(read()).toMatchObject({ availability: "unavailable" });
      runtimes.set(backendId, { scope: value.scope, instance: { id: backendId, tenantId: value.scope.tenantId, enabled: true } } as BackendModuleRuntime);
      expect(read()).toMatchObject({ availability: "unavailable" });
      value.database.prepare("UPDATE agent_connection_profiles SET enabled = 0 WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ?")
        .run(value.scope.tenantId, value.scope.principalId, backendId);
      expect(read()).toMatchObject({ availability: "unavailable", reason: { text: expect.stringContaining("disabled") } });
    } finally { value.database.close(); }
  });

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
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        revision: 0,
        enabledToolIds: [],
      });
      expect(repository.get(value.scope, value.codexThreadId)).toMatchObject({
        enabled: false,
        presentation: { surface: "cli", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
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
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
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
      // Existing threads keep their policy; new Codex threads default to
      // Native/Individual through the thread's `sedes` MCP server.
      expect(
        repository.get(value.scope, createdCodexAfterMigration.id),
      ).toMatchObject({
        enabled: false,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
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

  it("keeps threads readable after automation recovery tools leave the catalog", () => {
    const value = fixture();
    try {
      const retiredToolIds = ["automation.acknowledge", "automation.resolve"];
      const previous = new ThreadAgentToolPolicyRepository(value.database, {
        ...eligibility,
        eligibleToolIds: new Set([...eligibleToolIds, ...retiredToolIds]),
      });
      const saved = previous.update(value.scope, value.piThreadId, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        enabledToolIds: [...retiredToolIds, "thread.status"],
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        now: 400,
      });
      const current = new ThreadAgentToolPolicyRepository(value.database, eligibility);
      expect(current.get(value.scope, value.piThreadId)).toEqual({
        ...saved,
        enabledToolIds: ["thread.status"],
      });
      expect(current.getDurable(value.scope, value.piThreadId)).toEqual(saved);
      for (const toolId of retiredToolIds) {
        expect(() => current.update(value.scope, value.piThreadId, {
          ...saved,
          expectedRevision: saved.revision,
          enabledToolIds: [toolId],
          now: 401,
        })).toThrow(/ineligible tool/i);
      }
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
        resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true },
        now: 400,
      });
      expect(changed).toMatchObject({
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true },
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
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
          now: 401,
        }),
      ).toThrow(/changed in another client/i);
      expect(repository.get(value.scope, value.piThreadId)).toEqual(changed);

      const replaced = repository.update(value.scope, value.piThreadId, {
        expectedRevision: 1,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        enabledToolIds: ["thread.tasks"],
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        now: 402,
      });
      expect(replaced.enabledToolIds).toEqual(["thread.tasks"]);
      expect(replaced.resourceScope).toEqual({ allowOtherEnvironments: false, allowOtherProjects: true });
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
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
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
        agentToolRuntimeAvailability: { read: () => ({ availability: "available" }) },
        directoryBrowsingAvailability: () => "unavailable",
        executionWorkspaces: directThreadExecutionWorkspaceReader,
      });
      const pi = await reader.getAuthorized(value.scope, value.piThreadId);
      expect(pi.agentTools).toMatchObject({
        enabled: false,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
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
        "client.list", "client.end_interaction", "client.switch_thread", "client.settings.get", "client.settings.update", "client.replay_turn",
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
        "task.delete",
        "workpad.list",
        "workpad.get",
        "workpad.revisions",
        "workpad.create",
        "workpad.update",
        "page.publish",
        "page.preview",
        "page.list",
        "page.get",
        "page.revisions",
        "image.show",
        "automation.list",
        "automation.get",
        "automation.runs",
        "automation.create",
        "automation.update",
        "automation.set_state",
        "automation.run_now",
        "automation.delete",
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
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        presentationOptions: [
          { surface: "native", modes: ["individual", "progressive"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      });
    } finally {
      value.database.close();
    }
  });

  it("denies wrong-scope, unknown-tool, duplicate, and unsupported native updates", () => {
    const value = fixture();
    try {
      // A CLI-only disposition, as Grok has, for the non-Pi thread.
      const repository = new ThreadAgentToolPolicyRepository(value.database, {
        ...eligibility,
        presentationOptions: (backendKind, environmentKind) =>
          backendKind === "pi"
            ? eligibility.presentationOptions(backendKind, environmentKind)
            : [{ surface: "cli", modes: ["progressive", "individual"] }],
      });
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
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
          now: 500,
        }),
      ).toThrow(/ineligible/i);
      expect(() =>
        repository.update(value.scope, value.piThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "native", mode: "individual" },
          enabledToolIds: ["agent.context", "agent.context"],
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
          now: 500,
        }),
      ).toThrow(/duplicated/i);
      expect(() =>
        repository.update(value.scope, value.codexThreadId, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          enabledToolIds: ["agent.context"],
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
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
        agentToolRuntimeAvailability: { read: () => ({ availability: "available" }) },
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
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
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
