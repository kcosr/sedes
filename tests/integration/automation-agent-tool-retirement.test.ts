import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import {
  AutomationService,
  type AutomationDefinitionFields,
} from "../../src/server/domain/automation-service.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import { createAutomationSetStateToolDefinition } from "../../src/server/agent-tools/tools/automation-set-state-tool.js";
import { createAutomationUpdateToolDefinition } from "../../src/server/agent-tools/tools/automation-update-tool.js";

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
      label: "Primary Pi",
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
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

let seed: Buffer, scope: RequestScope, threadId: string;
beforeAll(() => {
  const db = openOverlayDatabase(":memory:");
  scope = new SingleUserIdentityProvider(db).getScope();
  const old = new ThreadInventoryService(new OverlayRepository(db));
  const environment = old.getLocalEnvironment(scope);
  const workspace = old.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/automation-agent-tool-test",
      displayName: "Test",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  threadId = old.createThread(
    scope,
    { workspaceId: workspace.id, title: "Assistant" },
    200,
  ).thread.id;
  applyBackendNormalizationMigration(db, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(db, backendNormalizedMigrations);
  seed = db.serialize();
  db.close();
});

describe("automation agent tools after one-shot retirement", () => {
  let db: Database.Database,
    repository: AutomationRepository,
    inventory: InventoryRepository,
    service: AutomationService,
    tools: AutomationAgentToolService,
    registry: AgentToolRegistry;
  beforeEach(() => {
    db = new Database(seed);
    db.pragma("foreign_keys=ON");
    repository = new AutomationRepository(db);
    inventory = new InventoryRepository(db);
    service = new AutomationService({
      repository,
      inventory,
      publisher: { publish: () => {}, publishAutomation: () => {} },
      executionPolicy: { assertCanAutomate: () => {} },
    });
    tools = new AutomationAgentToolService({
      automations: service,
      mutationRecords: repository,
      threads: {
        automationCapability: async () => ({ canCloneOnRun: true }),
      } as never,
      inventory,
      now: () => 13_000,
    });
    registry = new AgentToolRegistry();
    registry.register(createAutomationUpdateToolDefinition(tools));
    registry.register(createAutomationSetStateToolDefinition(tools));
  });
  afterEach(() => db.close());

  const once = (): AutomationDefinitionFields => ({
    prompt: "Remind me",
    runMode: "same_thread",
    schedule: { kind: "date_time", runAt: new Date(10_000).toISOString() },
    misfirePolicy: null,
    precheck: null,
  });
  const recurring = (): AutomationDefinitionFields => ({
    prompt: "Daily report",
    runMode: "same_thread",
    schedule: {
      kind: "interval",
      anchorAt: new Date(1_000).toISOString(),
      everySeconds: 300,
    },
    misfirePolicy: "coalesce",
    precheck: null,
  });
  function create(name: string, fields = once()) {
    return service.create(
      scope,
      threadId,
      { ...fields, name, initialState: "enabled", mutationId: randomUUID() },
      1_000,
    );
  }

  function toolContext(
    mutationId: string,
    input: {
      readonly scope?: RequestScope;
      readonly automationIds?: readonly string[];
    } = {},
  ): TrustedToolInvocationContext {
    const thread = inventory.getThread(scope, threadId).thread;
    const defaults = {
      kind: "thread_agent" as const,
      environmentId: thread.environmentId,
      workspaceId: thread.workspaceId,
      projectId: "project-1",
      threadId,
    };
    const policyIdentity = {
      ownerKind: "thread" as const,
      ownerId: threadId,
      revision: 1,
    };
    return {
      invocationId: randomUUID(),
      mutationId,
      ...(input.scope ?? scope),
      subject: {
        kind: "thread_agent",
        sourceThreadId: threadId,
        backendKind: "pi",
      },
      defaults,
      policyIdentity,
      environmentAuthority: {
        id: "authority-1",
        callerKind: "thread_agent",
        defaults,
        policyIdentity,
        admittedEnvironmentIds: [thread.environmentId],
        targetEnvironmentIds: [],
        resolvedResourceRefs: (input.automationIds ?? []).map((id) => ({
          kind: "automation" as const,
          id,
          environmentId: thread.environmentId,
          workspaceId: thread.workspaceId,
        })),
        display: { targetEnvironmentLabels: [], resourceLabels: [] },
        canonicalInputDigest: "input-digest",
        authorityDigest: "authority-digest",
      },
      adapter: "http",
      effectiveCapabilities: [],
      hasCapability: () => false,
      requestId: randomUUID(),
      abortSignal: new AbortController().signal,
      reportProgress: () => undefined,
    };
  }

  /**
   * A dismissed successful one-shot that a deferred Run now keeps from
   * retiring; cancelling that run (Pause, or an edit that supersedes it)
   * retires it in the same mutation.
   */
  function heldReminder() {
    const reminder = create("Reminder");
    const claimed = repository.claimScheduledOccurrence(scope, reminder.id, {
      occurrenceKey: "scheduled:10000",
      scheduledFor: 10_000,
      lastScheduledAt: 10_000,
      nextRunAt: null,
      coalescedCount: 0,
      claimToken: randomUUID(),
      leaseExpiresAt: 310_000,
      dispatchMutationId: randomUUID(),
      now: 10_000,
    }).run;
    repository.updateRunState(scope, reminder.id, claimed.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: claimed.claimToken!,
      retainPromptSnapshot: true,
      now: 10_001,
    });
    const run = repository.updateRunState(scope, reminder.id, claimed.id, {
      expectedState: "dispatching",
      state: "completed",
      claimToken: claimed.claimToken!,
      completeDefinition: true,
      now: 10_002,
    });
    const settled = repository.settleRunTurn(
      scope,
      run.anchorThreadId,
      run.dispatchMutationId,
      {
        turnId: `turn-${run.id}`,
        outcome: "completed",
        settledAt: 11_000,
        startedAt: null,
        endedAt: null,
      },
    );
    if (settled) service.publishRunSettlement(scope, settled);
    const pending = repository.createManualRun(scope, reminder.id, {
      occurrenceKey: "manual:deferred",
      scheduledFor: 11_100,
      claimToken: "deferred",
      leaseExpiresAt: 60_000,
      dispatchMutationId: randomUUID(),
      now: 11_100,
    }).run;
    repository.deferRun(scope, reminder.id, pending.id, {
      expectedState: "claimed",
      claimToken: pending.claimToken!,
      reason: "source_busy",
      eligibleAt: null,
      now: 11_200,
    });
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    return service.get(scope, reminder.id);
  }

  it("replays a retried update that retired its one-time automation", async () => {
    const reminder = heldReminder();
    const mutationId = randomUUID();
    const input = {
      automationId: reminder.id,
      expectedRevision: reminder.revision,
      runMode: "clone" as const,
    };
    const first = await tools.update(
      input,
      toolContext(mutationId, { automationIds: [reminder.id] }),
    );
    expect(first).toMatchObject({
      id: reminder.id,
      runMode: "clone",
      upcoming: [],
      retired: true,
    });
    expect(registry.validatesOutput("automation.update", 2, first)).toBe(true);
    const retired = repository.getDefinition(scope, reminder.id);
    expect(retired.deletedAt).not.toBeNull();
    expect(() => service.get(scope, reminder.id)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );

    await expect(
      tools.update(
        input,
        toolContext(mutationId, { automationIds: [reminder.id] }),
      ),
    ).resolves.toEqual(first);
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(
      retired.revision,
    );
  });

  it("replays a retried pause that retired its one-time automation", async () => {
    const reminder = heldReminder();
    const mutationId = randomUUID();
    const input = {
      automationId: reminder.id,
      expectedRevision: reminder.revision,
      action: "pause" as const,
    };
    const first = await tools.setState(
      input,
      toolContext(mutationId, { automationIds: [reminder.id] }),
    );
    expect(first).toMatchObject({
      id: reminder.id,
      upcoming: [],
      retired: true,
    });
    expect(registry.validatesOutput("automation.set_state", 2, first)).toBe(
      true,
    );
    const retired = repository.getDefinition(scope, reminder.id);
    expect(retired.deletedAt).not.toBeNull();

    await expect(
      tools.setState(
        input,
        toolContext(mutationId, { automationIds: [reminder.id] }),
      ),
    ).resolves.toEqual(first);
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(
      retired.revision,
    );
  });

  it("reports a live result for a mutation that does not retire", async () => {
    const daily = create("Daily", recurring());
    const result = await tools.setState(
      {
        automationId: daily.id,
        expectedRevision: daily.revision,
        action: "pause",
      },
      toolContext(randomUUID(), { automationIds: [daily.id] }),
    );
    expect(result).toMatchObject({
      id: daily.id,
      status: "paused",
      retired: false,
    });
    expect(result.upcoming.length).toBeGreaterThan(0);
    expect(registry.validatesOutput("automation.set_state", 2, result)).toBe(
      true,
    );
    expect(service.get(scope, daily.id).id).toBe(daily.id);
  });

  it("keeps fresh mutations of a retired automation not found", async () => {
    const reminder = heldReminder();
    await tools.setState(
      {
        automationId: reminder.id,
        expectedRevision: reminder.revision,
        action: "pause",
      },
      toolContext(randomUUID(), { automationIds: [reminder.id] }),
    );
    const revision = repository.getDefinition(scope, reminder.id).revision;
    await expect(
      tools.update(
        { automationId: reminder.id, expectedRevision: revision, name: "Again" },
        toolContext(randomUUID(), { automationIds: [reminder.id] }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      tools.setState(
        { automationId: reminder.id, expectedRevision: revision, action: "enable" },
        toolContext(randomUUID(), { automationIds: [reminder.id] }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(
      revision,
    );
  });

  it("never replays a recorded mutation across scope or automation boundaries", async () => {
    const reminder = heldReminder();
    const daily = create("Daily", recurring());
    const mutationId = randomUUID();
    const pause = {
      automationId: reminder.id,
      expectedRevision: reminder.revision,
      action: "pause" as const,
    };
    await tools.setState(
      pause,
      toolContext(mutationId, { automationIds: [reminder.id, daily.id] }),
    );
    const revision = repository.getDefinition(scope, reminder.id).revision;
    const receipts = vi.spyOn(repository, "getMutationReceipt");

    // An unadmitted automation is denied before its receipt is consulted.
    await expect(
      tools.setState(pause, toolContext(mutationId, { automationIds: [daily.id] })),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      tools.update(
        { automationId: reminder.id, expectedRevision: revision, name: "Again" },
        toolContext(mutationId),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(receipts).not.toHaveBeenCalled();

    // Another principal's identical mutation ID finds no receipt or definition.
    await expect(
      tools.setState(
        pause,
        toolContext(mutationId, {
          scope: { ...scope, principalId: randomUUID() },
          automationIds: [reminder.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    // A receipt recorded for one automation is never another's replay.
    await expect(
      tools.setState(
        {
          automationId: daily.id,
          expectedRevision: daily.revision,
          action: "pause",
        },
        toolContext(mutationId, { automationIds: [reminder.id, daily.id] }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(service.get(scope, daily.id)).toMatchObject({
      status: "enabled",
      revision: daily.revision,
    });
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(
      revision,
    );
  });
});
