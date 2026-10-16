import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import {
  AutomationService,
  type AutomationDefinitionFields,
} from "../../src/server/domain/automation-service.js";
import { AutomationDispatcher } from "../../src/server/runtime/automation-dispatcher.js";
import { readThreadAutomationContexts } from "../../src/server/application/thread-automation-context.js";
import { readThreadAutomationSummary } from "../../src/server/application/thread-automation-summary.js";
import type { AutomationRunRecord, AutomationTurnOutcome } from "../../src/server/domain/automation-models.js";
import { AutomationTurnSettlementObserver } from "../../src/server/runtime/automation-conversation-gateway.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";

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
let preMigrationSeed: Buffer;
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
      canonicalPath: "/automation-test",
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
  applyDatabaseMigrations(
    db,
    backendNormalizedMigrations.filter((migration) => migration.version < 146),
  );
  preMigrationSeed = db.serialize();
  applyDatabaseMigrations(db, backendNormalizedMigrations);
  seed = db.serialize();
  db.close();
});

describe("multiple independent thread automations", () => {
  let db: Database.Database,
    repository: AutomationRepository,
    inventory: InventoryRepository,
    service: AutomationService,
    dispatcher: AutomationDispatcher,
    now: number;
  const execute = vi.fn(),
    publications = vi.fn(),
    dispatch = vi.fn();
  let duringPrecheck: (() => void) | undefined;
  beforeEach(() => {
    db = new Database(seed);
    db.pragma("foreign_keys=ON");
    repository = new AutomationRepository(db);
    inventory = new InventoryRepository(db);
    now = 1_000;
    execute.mockReset();
    publications.mockReset();
    dispatch.mockReset();
    duringPrecheck = undefined;
    execute.mockImplementation(async () => {
      duringPrecheck?.();
      return {
        result: {
          decision: "invoke",
          effectivePrompt: "Frozen checked prompt",
          durationMilliseconds: 2,
          exitCode: 0,
          stdoutBytes: 0,
          stdoutIncluded: false,
        },
        execution: {},
      };
    });
    service = new AutomationService({
      repository,
      inventory,
      publisher: { publish: () => {}, publishAutomation: publications },
      executionPolicy: { assertCanAutomate: () => {} },
    });
    dispatch.mockImplementation(async (input) => ({
      status: "accepted",
      targetThreadId: input.anchorThreadId,
    }));
    dispatcher = new AutomationDispatcher({
      queueObserver: { reconcile: () => undefined },
      repository,
      inventory,
      service,
      prechecks: { execute },
      gateway: { dispatch },
      now: () => now,
    });
    service.bindDispatcher(dispatcher);
  });
  afterEach(async () => {
    await dispatcher.dispose();
    db.close();
  });
  const once = (runAt = 10_000): AutomationDefinitionFields => ({
    prompt: "Remind me",
    runMode: "same_thread",
    schedule: { kind: "date_time", runAt: new Date(runAt).toISOString() },
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
      now,
    );
  }
  async function settle() {
    for (let n = 0; n < 30; n++) await Promise.resolve();
  }
  function snooze(until: number) {
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: inventory.getInventory(scope, threadId)
        .inventoryRevision,
      mutationId: randomUUID(),
      change: { action: "snooze", snoozedUntil: until, wakeReminderText: null },
      now,
    });
  }
  function wake() {
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: inventory.getInventory(scope, threadId)
        .inventoryRevision,
      mutationId: randomUUID(),
      change: { action: "wake" },
      now,
    });
  }
  function claim(id: string, at = 10_000) {
    return repository.claimScheduledOccurrence(scope, id, {
      occurrenceKey: `scheduled:${at}`,
      scheduledFor: at,
      lastScheduledAt: at,
      nextRunAt: null,
      coalescedCount: 0,
      claimToken: randomUUID(),
      leaseExpiresAt: at + 300_000,
      dispatchMutationId: randomUUID(),
      now: at,
    }).run;
  }

  function deliver(id: string, at = 10_000) {
    const run = claim(id, at);
    repository.updateRunState(scope, id, run.id, {
      expectedState: "claimed", state: "dispatching", claimToken: run.claimToken!,
      retainPromptSnapshot: true, now: at + 1,
    });
    return repository.updateRunState(scope, id, run.id, {
      expectedState: "dispatching", state: "completed", claimToken: run.claimToken!,
      completeDefinition: repository.getDefinition(scope, id).schedule.kind === "date_time",
      now: at + 2,
    });
  }

  function claimManual(id: string, at: number) {
    return repository.createManualRun(scope, id, {
      runId: randomUUID(), occurrenceKey: `manual:${randomUUID()}`, scheduledFor: at,
      claimToken: randomUUID(), leaseExpiresAt: at + 300_000, dispatchMutationId: randomUUID(), now: at,
    }).run;
  }

  function deliverClaimed(run: AutomationRunRecord, at: number) {
    repository.updateRunState(scope, run.automationId, run.id, {
      expectedState: "claimed", state: "dispatching", claimToken: run.claimToken!,
      retainPromptSnapshot: true, now: at,
    });
    return repository.updateRunState(scope, run.automationId, run.id, {
      expectedState: "dispatching", state: "completed", claimToken: run.claimToken!, now: at + 1,
    });
  }

  function finishTurn(run: AutomationRunRecord, outcome: AutomationTurnOutcome, at = 11_000) {
    const settled = repository.settleRunTurn(scope, run.childThreadId ?? run.anchorThreadId,
      run.dispatchMutationId, {
        turnId: `turn-${run.id}`, outcome, settledAt: at, startedAt: null, endedAt: null,
      });
    if (settled) service.publishRunSettlement(scope, settled);
    return settled;
  }

  it("keeps a successful one-shot and its banner until dismissal, then retains only its internal records", () => {
    const reminder = create("Reminder"), daily = create("Daily", recurring());
    const run = deliver(reminder.id);
    finishTurn(run, "completed");
    expect(service.list(scope, { threadId, pageSize: 10 }).items.map((item) => item.id))
      .toEqual(expect.arrayContaining([reminder.id, daily.id]));
    expect(readThreadAutomationContexts(db, scope, threadId))
      .toEqual([expect.objectContaining({ runId: run.id, outcome: "triggered" })]);
    const result = service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    expect(result.automation).toBeNull();
    expect(service.list(scope, { threadId, pageSize: 10 }).items.map((item) => item.id)).toEqual([daily.id]);
    expect(readThreadAutomationContexts(db, scope, threadId)).toEqual([]);
    expect(readThreadAutomationSummary(db, scope, threadId)).toMatchObject({ totalCount: 1, enabledCount: 1 });
    expect(repository.getRun(scope, reminder.id, run.id)).toMatchObject({
      state: "completed", turnOutcome: "completed", acknowledgedAt: 12_000,
    });
    expect(repository.isExhausted(scope, reminder.id)).toBe(true);
    expect(inventory.getThread(scope, threadId).thread.id).toBe(threadId);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
    const revision = repository.getDefinition(scope, reminder.id).revision;
    expect(service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 13_000).automation).toBeNull();
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(revision);
  });

  it("defers an early dismissal until the agent turn succeeds", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 10_500);
    expect(service.get(scope, reminder.id).id).toBe(reminder.id);
    expect(readThreadAutomationContexts(db, scope, threadId)).toEqual([]);
    expect(readThreadAutomationSummary(db, scope, threadId).inFlightCount).toBe(1);
    finishTurn(run, "completed");
    expect(repository.getDefinition(scope, reminder.id).deletedAt).not.toBeNull();
    expect(service.list(scope, { threadId, pageSize: 10 }).items).toEqual([]);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
  });

  it.each(["failed", "interrupted"] as const)("surfaces a later %s turn after early dismissal and ignores stale trigger dismissal", (outcome) => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 10_500);
    finishTurn(run, outcome);
    expect(repository.getRun(scope, reminder.id, run.id).acknowledgedAt).toBeNull();
    expect(service.get(scope, reminder.id).attention).toMatchObject({ runId: run.id, kind: "failed" });
    expect(readThreadAutomationContexts(db, scope, threadId))
      .toEqual([expect.objectContaining({ runId: run.id, outcome: "failed" })]);
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    expect(repository.getRun(scope, reminder.id, run.id).acknowledgedAt).toBeNull();
    service.acknowledgeThreadRun(scope, threadId, run.id, "failed", 12_100);
    expect(service.get(scope, reminder.id).attention).toBeUndefined();
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    // Replaying immutable settlement must not undo an acknowledgement of the failure.
    expect(finishTurn(run, outcome, 12_200)).toBeUndefined();
    expect(repository.getRun(scope, reminder.id, run.id).acknowledgedAt).toBe(12_100);
  });

  it("does not retire a rearmed schedule when an older result is dismissed", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    finishTurn(run, "completed");
    const edited = service.update(scope, reminder.id, {
      ...once(20_000), name: "Next reminder", expectedRevision: service.get(scope, reminder.id).revision,
      mutationId: randomUUID(),
    }, 11_500);
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    expect(service.get(scope, reminder.id).schedule).toEqual(edited.schedule);
  });

  it("does not retire recurring schedules or a one-shot after only a manual success", async () => {
    const daily = create("Daily", recurring()), recurringRun = deliver(daily.id, 301_000);
    finishTurn(recurringRun, "completed", 302_000);
    service.acknowledgeThreadRun(scope, threadId, recurringRun.id, "triggered", 303_000);
    expect(repository.getDefinition(scope, daily.id).deletedAt).toBeNull();
    const reminder = create("Reminder");
    now = 2_000;
    const manual = await service.runNow(scope, reminder.id, randomUUID(), now);
    await settle();
    const run = repository.getRun(scope, reminder.id, manual.id);
    expect(run.state).toBe("completed");
    finishTurn(run, "completed");
    service.acknowledgeRun(scope, reminder.id, run.id, 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
  });

  it("retires a reminder after Run now once the notice shown at that time is dismissed", () => {
    const reminder = create("Reminder"), scheduled = deliver(reminder.id);
    finishTurn(scheduled, "completed");
    const manual = claimManual(reminder.id, 11_500);
    // Until Run now is delivered, the scheduled notice is the one shown.
    expect(readThreadAutomationContexts(db, scope, threadId))
      .toEqual([expect.objectContaining({ runId: scheduled.id, outcome: "triggered" })]);
    service.acknowledgeThreadRun(scope, threadId, scheduled.id, "triggered", 11_600);
    const delivered = deliverClaimed(manual, 11_700);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    finishTurn(delivered, "completed", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBe(12_000);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
  });

  it("retires a reminder whose scheduled notice a successful Run now superseded", async () => {
    const reminder = create("Reminder"), scheduled = deliver(reminder.id);
    finishTurn(scheduled, "completed");
    now = 11_500;
    const manual = await service.runNow(scope, reminder.id, randomUUID(), now);
    await settle();
    const delivered = repository.getRun(scope, reminder.id, manual.id);
    expect(delivered.state).toBe("completed");
    // The anchor shows only the latest decisive run, and a successful manual
    // run has no notice, so nothing about the reminder remains to dismiss.
    expect(readThreadAutomationContexts(db, scope, threadId)).toEqual([]);
    expect(repository.getRun(scope, reminder.id, scheduled.id).acknowledgedAt).toBeNull();
    expect(readThreadAutomationSummary(db, scope, threadId)).toMatchObject({ inFlightCount: 1 });
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    finishTurn(delivered, "completed", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBe(12_000);
    expect(service.list(scope, { threadId, pageSize: 10 }).items).toEqual([]);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
  });

  it("keeps a reminder after a failed Run now until that failure is dismissed", () => {
    const reminder = create("Reminder"), scheduled = deliver(reminder.id);
    finishTurn(scheduled, "completed");
    const manual = deliverClaimed(claimManual(reminder.id, 11_500), 11_600);
    finishTurn(manual, "failed", 12_000);
    expect(readThreadAutomationContexts(db, scope, threadId))
      .toEqual([expect.objectContaining({ runId: manual.id, outcome: "failed" })]);
    expect(service.get(scope, reminder.id).attention).toMatchObject({ runId: manual.id, kind: "failed" });
    // A stale dismissal of a delivered notice cannot acknowledge the failure.
    service.acknowledgeThreadRun(scope, threadId, manual.id, "triggered", 12_100);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    service.acknowledgeThreadRun(scope, threadId, manual.id, "failed", 12_200);
    expect(readThreadAutomationContexts(db, scope, threadId)).toEqual([]);
    expect(repository.getRun(scope, reminder.id, scheduled.id).acknowledgedAt).toBeNull();
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBe(12_200);
  });

  it("does not let an older turn that never settled block retirement", () => {
    const reminder = create("Reminder");
    // An early Run now whose completion was never observed.
    const stale = deliverClaimed(claimManual(reminder.id, 2_000), 2_100);
    expect(readThreadAutomationSummary(db, scope, threadId)).toMatchObject({ inFlightCount: 1 });
    const scheduled = deliver(reminder.id);
    expect(readThreadAutomationSummary(db, scope, threadId)).toMatchObject({ inFlightCount: 1 });
    finishTurn(scheduled, "completed");
    expect(readThreadAutomationSummary(db, scope, threadId)).toMatchObject({ inFlightCount: 0 });
    expect(repository.getRun(scope, reminder.id, stale.id).turnOutcome).toBeNull();
    service.acknowledgeThreadRun(scope, threadId, scheduled.id, "triggered", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBe(12_000);
  });

  it("retains a dismissed successful one-shot while another invocation is unfinished", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    finishTurn(run, "completed");
    const pending = repository.createManualRun(scope, reminder.id, {
      runId: randomUUID(), occurrenceKey: "manual:pending", scheduledFor: 11_100,
      claimToken: "pending-claim", leaseExpiresAt: 60_000, dispatchMutationId: randomUUID(), now: 11_100,
    }).run;
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    repository.updateRunState(scope, reminder.id, pending.id, {
      expectedState: "claimed", state: "cancelled", claimToken: pending.claimToken!, now: 12_100,
    });
    expect(repository.getDefinition(scope, reminder.id).deletedAt).not.toBeNull();
  });

  it("retires after Pause cancels the last deferred invocation and safely replays that mutation", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    finishTurn(run, "completed");
    const pending = repository.createManualRun(scope, reminder.id, {
      occurrenceKey: "manual:deferred", scheduledFor: 11_100, claimToken: "deferred",
      leaseExpiresAt: 60_000, dispatchMutationId: randomUUID(), now: 11_100,
    }).run;
    repository.deferRun(scope, reminder.id, pending.id, {
      expectedState: "claimed", claimToken: pending.claimToken!,
      reason: "source_busy", eligibleAt: null, now: 11_200,
    });
    service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 12_000);
    const mutation = {
      action: "pause" as const, expectedRevision: service.get(scope, reminder.id).revision,
      mutationId: randomUUID(),
    };
    service.setState(scope, reminder.id, mutation, 12_100);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).not.toBeNull();
    expect(repository.getRun(scope, reminder.id, pending.id).state).toBe("cancelled");
    const revision = repository.getDefinition(scope, reminder.id).revision;
    expect(() => service.setState(scope, reminder.id, mutation, 12_200)).not.toThrow();
    expect(repository.getDefinition(scope, reminder.id).revision).toBe(revision);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
  });

  it("reconciles lifecycle cleanup only for the affected principal and source threads", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    finishTurn(run, "completed");
    db.prepare(`UPDATE automation_runs SET acknowledged_at = 12000 WHERE id = ?`).run(run.id);
    service.reconcileRetirementsForThreads({ ...scope, principalId: randomUUID() }, [threadId], 12_100);
    service.reconcileRetirementsForThreads(scope, [randomUUID()], 12_100);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    service.reconcileRetirementsForThreads(scope, [threadId], 12_100);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBe(12_100);
    expect(publications).toHaveBeenLastCalledWith(scope, expect.objectContaining({ automationId: reminder.id, deleted: true }));
  });

  it("reconciles persisted successful dismissals at startup without removing failed results", () => {
    new ConversationBindingRepository(db).bindDiscoveredConversation(scope, threadId, {
      backendConversationId: `native-${threadId}`, now: 1_000,
    });
    const success = create("Success"), successRun = deliver(success.id);
    const failure = create("Failure"), failureRun = deliver(failure.id);
    const completions = new SubmissionCompletionRepository(db);
    for (const [run, outcome] of [[successRun, "completed"], [failureRun, "failed"]] as const) {
      service.acknowledgeThreadRun(scope, threadId, run.id, "triggered", 10_500);
      completions.recordAccepted(scope, threadId, {
        operationId: run.dispatchMutationId, acceptedAt: 10_002, backendCorrelation: run.dispatchMutationId,
      });
      completions.observeBackendCompletion(scope, threadId, {
        backendCorrelation: run.dispatchMutationId, completionIdentity: `turn-${run.id}:${outcome}`,
        observedAt: 11_000, applicationTurnId: `turn-${run.id}`, outcome,
        result: { text: outcome }, classifiedResult: null,
      });
    }
    const observer = new AutomationTurnSettlementObserver({ repository, publisher: service });
    observer.recover();
    expect(repository.getDefinition(scope, success.id).deletedAt).not.toBeNull();
    expect(repository.getDefinition(scope, failure.id).deletedAt).toBeNull();
    expect(service.get(scope, failure.id).attention?.runId).toBe(failureRun.id);
    expect(repository.getRun(scope, failure.id, failureRun.id).acknowledgedAt).toBeNull();
    const revision = repository.getDefinition(scope, success.id).revision;
    publications.mockClear();
    observer.recover();
    expect(repository.getDefinition(scope, success.id).revision).toBe(revision);
    expect(publications).not.toHaveBeenCalled();
  });

  it("retires already-settled acknowledged one-shots during upgrade recovery", () => {
    const reminder = create("Reminder"), run = deliver(reminder.id);
    finishTurn(run, "completed");
    db.prepare(`UPDATE automation_runs SET acknowledged_at = 12000 WHERE id = ?`).run(run.id);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).toBeNull();
    expect(repository.settleRunTurnsFromCompletions().map((item) => item.id)).toEqual([run.id]);
    expect(repository.getDefinition(scope, reminder.id).deletedAt).not.toBeNull();
    expect(repository.settleRunTurnsFromCompletions()).toEqual([]);
  });

  it("keeps a daily schedule and independently named reminders on one thread", () => {
    const daily = create("Daily report", recurring()),
      reminder = create("Take a break");
    const page = service.list(scope, { threadId, pageSize: 10 });
    expect(page.items.map((x) => x.id).sort()).toEqual(
      [daily.id, reminder.id].sort(),
    );
    expect(page.items.find((x) => x.id === reminder.id)?.source.title).toBe(
      "Assistant",
    );
    service.setState(
      scope,
      reminder.id,
      {
        action: "pause",
        expectedRevision: reminder.revision,
        mutationId: randomUUID(),
      },
      now,
    );
    expect(service.get(scope, daily.id).status).toBe("enabled");
    expect(service.get(scope, reminder.id).status).toBe("paused");
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='automation_definitions_one_per_thread'",
        )
        .get(),
    ).toBeUndefined();
    expect(publications).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        automationId: reminder.id,
        threadId,
        deleted: false,
      }),
    );
  });

  it("binds create and mutation replay to exact content and resource identity", () => {
    const mutationId = randomUUID(),
      input = {
        ...once(),
        name: "Reminder",
        initialState: "enabled" as const,
        mutationId,
      };
    const first = service.create(scope, threadId, input, now);
    expect(service.create(scope, threadId, input, now).id).toBe(first.id);
    expect(() =>
      service.create(scope, threadId, { ...input, name: "Different" }, now),
    ).toThrow(/mutation/i);
    const sibling = create("Sibling"),
      key = randomUUID();
    service.setState(
      scope,
      first.id,
      { action: "pause", expectedRevision: first.revision, mutationId: key },
      now,
    );
    expect(() =>
      service.setState(
        scope,
        sibling.id,
        {
          action: "pause",
          expectedRevision: sibling.revision,
          mutationId: key,
        },
        now,
      ),
    ).toThrow(/mutation/i);
    expect(() =>
      service.get({ ...scope, principalId: randomUUID() }, first.id),
    ).toThrow();
  });

  it("retains exhausted one-shots and does not rearm them on content edits or manual runs", async () => {
    const created = create("One shot");
    now = 10_000;
    await service.reconcileDue(now);
    await settle();
    expect(service.get(scope, created.id).status).toBe("exhausted");
    expect(repository.getDefinition(scope, created.id).deletedAt).toBeNull();
    const current = service.get(scope, created.id);
    const changed = service.update(
      scope,
      created.id,
      {
        ...once(),
        name: "Renamed",
        prompt: "Changed prompt",
        expectedRevision: current.revision,
        mutationId: randomUUID(),
      },
      now,
    );
    expect(changed.status).toBe("exhausted");
    await service.runNow(scope, created.id, randomUUID(), now);
    expect(service.get(scope, created.id).status).toBe("exhausted");
    expect(() =>
      service.setState(
        scope,
        created.id,
        {
          action: "enable",
          expectedRevision: changed.revision,
          mutationId: randomUUID(),
        },
        now,
      ),
    ).toThrow(/exhausted/i);
    const latest = service.get(scope, created.id);
    const rearmed = service.update(
      scope,
      created.id,
      {
        ...once(20_000),
        name: "Renamed",
        expectedRevision: latest.revision,
        mutationId: randomUUID(),
      },
      now,
    );
    expect(rearmed.status).toBe("paused");
    expect(
      service.listRuns(scope, created.id, { pageSize: 10 }).items,
    ).toHaveLength(2);
  });

  it("rejects new manual work on an archived source without reserving its mutation", async () => {
    const created = create("Daily report", recurring());
    const mutationId = randomUUID();
    const transition = (action: "archive" | "restore") =>
      inventory.transitionInventory(scope, threadId, {
        expectedRevision: inventory.getInventory(scope, threadId)
          .inventoryRevision,
        mutationId: randomUUID(),
        change: { action },
        now: ++now,
      });
    transition("archive");
    await expect(
      service.runNow(scope, created.id, mutationId, now),
    ).rejects.toMatchObject({ code: "archived_thread" });
    expect(repository.listRuns(scope, created.id, { limit: 10 })).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();

    transition("restore");
    const completed = await service.runNow(scope, created.id, mutationId, now);
    expect(completed.state).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);

    transition("archive");
    await expect(
      service.runNow(scope, created.id, mutationId, now),
    ).resolves.toMatchObject({ id: completed.id, state: "completed" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("defers snoozed reminders without a lease and delivers once after an early wake", async () => {
    const created = create("Reminder");
    snooze(50_000);
    now = 10_000;
    await service.reconcileDue(now);
    await settle();
    let run = repository.listRuns(scope, created.id, { limit: 1 })[0]!;
    expect(run).toMatchObject({
      state: "deferred",
      deferredReason: "snoozed",
      leaseExpiresAt: null,
      claimToken: null,
      scheduledFor: 10_000,
      eligibleAt: 50_000,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.get(scope, created.id).status).toBe("enabled");
    now = 20_000;
    wake();
    await service.reconcileDue(now);
    await settle();
    run = repository.listRuns(scope, created.id, { limit: 1 })[0]!;
    expect(run.state).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(service.get(scope, created.id).status).toBe("exhausted");
  });

  it("atomically gates sibling dispatch and preserves the waiting frozen prompt", () => {
    const a = create("A"),
      b = create("B");
    const ra = claim(a.id),
      rb = claim(b.id);
    expect(
      repository.checkRunAdmission(scope, a.id, ra.id, {
        claimToken: ra.claimToken!,
        now: 10_000,
        dispatch: true,
      }).state,
    ).toBe("dispatching");
    expect(
      repository.checkRunAdmission(scope, b.id, rb.id, {
        claimToken: rb.claimToken!,
        now: 10_000,
        dispatch: true,
      }),
    ).toMatchObject({
      state: "deferred",
      deferredReason: "sibling",
      claimToken: null,
      leaseExpiresAt: null,
    });
    const current = service.get(scope, b.id);
    service.update(
      scope,
      b.id,
      {
        ...once(),
        name: "Edited",
        prompt: "A new prompt",
        expectedRevision: current.revision,
        mutationId: randomUUID(),
      },
      10_000,
    );
    expect(repository.getRun(scope, b.id, rb.id).promptSnapshot).toBe(
      "Remind me",
    );
    expect(repository.getDefinition(scope, b.id).enabled).toBe(true);
    const edited = service.get(scope, b.id);
    service.setState(
      scope,
      b.id,
      {
        action: "pause",
        expectedRevision: edited.revision,
        mutationId: randomUUID(),
      },
      10_000,
    );
    expect(repository.getRun(scope, b.id, rb.id).state).toBe("cancelled");
    expect(repository.getRun(scope, a.id, ra.id).state).toBe("dispatching");
  });

  it("runs a precheck at most once across a snooze that arrives during the check", async () => {
    const created = create("Checked", {
      ...once(),
      precheck: { command: "true", timeoutSeconds: 5, includeStdout: false },
    });
    duringPrecheck = () => snooze(50_000);
    now = 10_000;
    await service.reconcileDue(now);
    await settle();
    expect(
      repository.listRuns(scope, created.id, { limit: 1 })[0],
    ).toMatchObject({ state: "deferred", precheckStatus: "passed" });
    expect(execute).toHaveBeenCalledTimes(1);
    duringPrecheck = undefined;
    now = 60_000;
    wake();
    await service.reconcileDue(now);
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps failure attention independent and only exact acknowledgements clear it", () => {
    const a = create("A"),
      b = create("B");
    const ra = claim(a.id),
      rb = claim(b.id);
    repository.updateRunState(scope, a.id, ra.id, {
      expectedState: "claimed",
      state: "failed",
      claimToken: ra.claimToken!,
      errorCode: "automation_dispatch_failed",
      errorDiagnostic: "Failed A",
      now: 10_001,
      completeDefinition: true,
    });
    repository.updateRunState(scope, b.id, rb.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: rb.claimToken!,
      retainPromptSnapshot: true,
      now: 10_001,
    });
    repository.updateRunState(scope, b.id, rb.id, {
      expectedState: "dispatching",
      state: "completed",
      claimToken: rb.claimToken!,
      now: 10_002,
      completeDefinition: true,
    });
    expect(service.get(scope, a.id).attention?.runId).toBe(ra.id);
    expect(service.get(scope, b.id).attention).toBeUndefined();
    service.acknowledgeThreadRun(scope, threadId, ra.id, "failed", 10_003);
    expect(service.get(scope, a.id).attention).toBeUndefined();
    expect(repository.getRun(scope, a.id, ra.id).acknowledgedAt).toBe(10_003);
  });
  it("rejects acknowledgement through an unrelated thread", () => {
    const a = create("A"),
      run = claim(a.id);
    repository.updateRunState(scope, a.id, run.id, {
      expectedState: "claimed",
      state: "failed",
      claimToken: run.claimToken!,
      errorCode: "automation_dispatch_failed",
      now: 10_001,
      completeDefinition: true,
    });
    const source = inventory.getThread(scope, threadId).thread;
    const unrelated = new ConversationBindingRepository(db).createUnboundThread(
      scope,
      {
        workspaceId: source.workspaceId,
        connectionProfileId: source.connectionProfileId,
        title: "Unrelated",
        now: 10_002,
      },
    );
    expect(() =>
      service.acknowledgeThreadRun(scope, unrelated.id, run.id, "failed", 10_003),
    ).toThrow(/not found/i);
    expect(repository.getRun(scope, a.id, run.id).acknowledgedAt).toBeNull();
  });

  it("does not apply recurring skip policy to time spent waiting in the pipeline", async () => {
    const created = create("Skip", { ...recurring(), misfirePolicy: "skip" });
    const run = repository.claimScheduledOccurrence(scope, created.id, {
      occurrenceKey: "scheduled:301000",
      scheduledFor: 301_000,
      lastScheduledAt: 301_000,
      nextRunAt: 601_000,
      coalescedCount: 0,
      claimToken: randomUUID(),
      leaseExpiresAt: 601_000,
      dispatchMutationId: randomUUID(),
      now: 301_000,
    }).run;
    repository.deferRun(scope, created.id, run.id, {
      expectedState: "claimed",
      claimToken: run.claimToken!,
      reason: "source_busy",
      eligibleAt: null,
      now: 301_000,
    });
    now = 550_000;
    await service.reconcileDue(now);
    await settle();
    expect(repository.getRun(scope, created.id, run.id).state).toBe(
      "completed",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["skip", "coalesce"] as const)(
    "applies %s once to a suppressed recurring span",
    async (policy) => {
      const created = create("Recurring", {
        ...recurring(),
        misfirePolicy: policy,
      });
      snooze(1_000_001);
      now = 301_000;
      await service.reconcileDue(now);
      await settle();
      const original = repository.listRuns(scope, created.id, { limit: 1 })[0]!;
      expect(original.state).toBe("deferred");
      now = 1_000_001;
      wake();
      await service.reconcileDue(now);
      await settle();
      const run = repository.getRun(scope, created.id, original.id);
      expect(run.state).toBe(policy === "skip" ? "skipped" : "completed");
      expect(run.coalescedCount).toBe(2);
      expect(run.suppressedAt).toBe(301_000);
      expect(run.suppressionPending).toBe(false);
      expect(repository.getDefinition(scope, created.id).nextRunAt).toBe(
        1_201_000,
      );
      expect(dispatch).toHaveBeenCalledTimes(policy === "skip" ? 0 : 1);
    },
  );
  it("upgrades existing runs, receipts and removed definitions without resurrecting them", () => {
    const previous = new Database(preMigrationSeed);
    previous.pragma("foreign_keys=ON");
    const oldRepository = new AutomationRepository(previous);
    const id = randomUUID(),
      removedId = randomUUID(),
      runId = randomUUID(),
      mutationId = randomUUID();
    const input = {
      anchorThreadId: threadId,
      name: "Existing",
      prompt: "Stored prompt",
      precheck: null,
      runMode: "same_thread" as const,
      enabled: true,
      schedule: { kind: "date_time" as const, runAt: 10_000 },
      misfirePolicy: null,
      nextRunAt: 10_000,
      now: 1_000,
    };
    oldRepository.createDefinition(scope, { ...input, id });
    oldRepository.createDefinition(scope, {
      ...input,
      id: removedId,
      anchorThreadId: new ConversationBindingRepository(
        previous,
      ).createUnboundThread(scope, {
        workspaceId: inventory.getThread(scope, threadId).thread.workspaceId,
        connectionProfileId: inventory.getThread(scope, threadId).thread
          .connectionProfileId,
        title: "Removed",
        now: 1_000,
      }).id,
    });
    previous
      .prepare(
        "UPDATE automation_definitions SET enabled=0,next_run_at=NULL,deleted_at=2000 WHERE id=?",
      )
      .run(removedId);
    oldRepository.recordMutationReceipt(scope, {
      mutationId,
      automationId: id,
      mutationKind: "create",
      requestFingerprint: "a".repeat(64),
      resultRevision: 0,
      now: 1_000,
    });
    previous
      .prepare(
        `INSERT INTO automation_runs(tenant_id,owner_principal_id,automation_id,id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,coalesced_count,run_mode,state,claim_token,lease_expires_at,claim_attempt_count,prompt_snapshot,dispatch_mutation_id,anchor_thread_id,claimed_at,created_at,updated_at,precheck_status) VALUES(?,?,?,?,'scheduled',10000,'scheduled:10000',0,0,'same_thread','claimed','claim',310000,1,'Stored prompt',?,?,10000,10000,10000,'not_configured')`,
      )
      .run(scope.tenantId, scope.principalId, id, runId, runId, threadId);
    applyDatabaseMigrations(previous, backendNormalizedMigrations);
    const current = new AutomationRepository(previous);
    expect(current.getRun(scope, id, runId)).toMatchObject({
      id: runId,
      state: "claimed",
      claimToken: "claim",
      initialEligibleAt: 10_000,
      suppressionPending: false,
    });
    expect(current.getDefinition(scope, removedId).deletedAt).toBe(2_000);
    expect(current.getMutationReceipt(scope, mutationId)?.automationId).toBe(
      id,
    );
    current.createDefinition(scope, { ...input, id: randomUUID() });
    expect(previous.pragma("foreign_key_check")).toEqual([]);
    previous.close();
  });
  it("preserves a recurring deadline when only the name or prompt changes", () => {
    const created = create("Daily", recurring());
    const original = repository.getDefinition(scope, created.id).nextRunAt;
    now = 400_000;
    service.update(
      scope,
      created.id,
      {
        ...recurring(),
        name: "Renamed daily",
        prompt: "New report prompt",
        expectedRevision: created.revision,
        mutationId: randomUUID(),
      },
      now,
    );
    expect(repository.getDefinition(scope, created.id)).toMatchObject({
      nextRunAt: original,
      enabled: true,
      name: "Renamed daily",
      prompt: "New report prompt",
    });
  });
  it("rechecks event-driven deferrals once on a source poke without spinning", async () => {
    const blocker = create("Blocker"),
      blocked = create("Waiting");
    const active = claim(blocker.id),
      waiting = claim(blocked.id);
    repository.updateRunState(scope, blocker.id, active.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: active.claimToken!,
      retainPromptSnapshot: true,
      now: 10_000,
    });
    repository.deferRun(scope, blocked.id, waiting.id, {
      expectedState: "claimed",
      claimToken: waiting.claimToken!,
      reason: "sibling",
      eligibleAt: null,
      now: 10_000,
    });
    service.requestDeferredReconcile(10_000);
    expect(service.getNearestDeadline()).toBe(10_000);
    now = 10_000;
    await service.reconcileDue(now);
    expect(repository.getRun(scope, blocked.id, waiting.id).state).toBe(
      "deferred",
    );
    expect(service.getNearestDeadline()).toBe(40_000);
  });
  it("does not immediately retry a worker that reports an event-driven source wait", async () => {
    const created = create("Waiting");
    dispatch.mockResolvedValue({
      status: "deferred",
      reason: "source_busy",
      eligibleAt: null,
    });
    now = 10_000;
    await service.reconcileDue(now);
    await settle();
    expect(repository.listRuns(scope, created.id, { limit: 1 })[0]?.state).toBe(
      "deferred",
    );
    expect(service.getNearestDeadline()).toBe(40_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    now = 40_000;
    await service.reconcileDue(now);
    await settle();
    expect(service.getNearestDeadline()).toBe(70_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { mode: "same_thread", state: "completed", visible: false },
    { mode: "same_thread", state: "completed", visible: true },
    { mode: "same_thread", state: "failed", visible: false },
    { mode: "same_thread", state: "failed", visible: true },
    { mode: "clone", state: "completed", visible: false },
    { mode: "clone", state: "completed", visible: true },
    { mode: "clone", state: "failed", visible: false },
    { mode: "clone", state: "failed", visible: true },
  ] as const)(
    "preserves historical $mode $state attention visibility=$visible",
    ({ mode, state, visible }) => {
      const previous = new Database(preMigrationSeed);
      previous.pragma("foreign_keys=ON");
      try {
        const definitionId = randomUUID(),
          runId = randomUUID();
        const source = new InventoryRepository(previous).getThread(
          scope,
          threadId,
        ).thread;
        const child =
          mode === "clone"
            ? new ConversationBindingRepository(previous).createUnboundThread(
                scope,
                {
                  workspaceId: source.workspaceId,
                  connectionProfileId: source.connectionProfileId,
                  title: "Prior fork result",
                  now: 1_000,
                },
              ).id
            : null;
        new AutomationRepository(previous).createDefinition(scope, {
          id: definitionId,
          anchorThreadId: threadId,
          name: source.title,
          prompt: "Prior prompt",
          precheck: null,
          runMode: mode,
          enabled: false,
          schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 300 },
          misfirePolicy: "coalesce",
          nextRunAt: null,
          now: 1_000,
        });
        previous
          .prepare(
            `INSERT INTO automation_runs(tenant_id,owner_principal_id,automation_id,id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,coalesced_count,run_mode,state,claim_token,lease_expires_at,claim_attempt_count,prompt_snapshot,dispatch_mutation_id,anchor_thread_id,child_thread_id,claimed_at,started_at,accepted_at,finished_at,created_at,updated_at,precheck_status,error_code,error_diagnostic) VALUES(?,?,?,?,'scheduled',10000,'scheduled:10000',0,0,?,?,NULL,NULL,1,NULL,?,?,?,10000,10000,?,11000,10000,11000,'not_configured',?,?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            definitionId,
            runId,
            mode,
            state,
            runId,
            threadId,
            child,
            state === "completed" ? 10_000 : null,
            state === "failed" ? "automation_dispatch_failed" : null,
            state === "failed" ? "Prior failure" : null,
          );
        const target = child ?? threadId;
        if (visible)
          previous
            .prepare(
              `UPDATE thread_principal_state SET automation_context_run_id=?,automation_context_source_thread_id=?,automation_context_at=11000,automation_context_outcome=?,automation_context_diagnostic=? WHERE tenant_id=? AND principal_id=? AND thread_id=?`,
            )
            .run(
              runId,
              threadId,
              state === "completed" ? "triggered" : "failed",
              state === "failed" ? "Prior failure" : null,
              scope.tenantId,
              scope.principalId,
              target,
            );
        previous
          .prepare(
            `UPDATE thread_principal_state SET pinned=1,pin_revision=7,bookmark_revision=3,group_assignment_revision=2 WHERE tenant_id=? AND principal_id=? AND thread_id=?`,
          )
          .run(scope.tenantId, scope.principalId, target);
        applyDatabaseMigrations(previous, backendNormalizedMigrations);
        const current = new AutomationRepository(previous);
        expect(current.getDefinition(scope, definitionId)).toMatchObject({
          id: definitionId,
          anchorThreadId: threadId,
          name: source.title,
          runMode: mode,
          enabled: false,
          schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 300 },
        });
        expect(current.getRun(scope, definitionId, runId).acknowledgedAt).toBe(
          visible ? null : 11_000,
        );
        const contexts = readThreadAutomationContexts(previous, scope, target);
        if (visible)
          expect(contexts).toEqual([
            expect.objectContaining({
              automationId: definitionId,
              runId,
              outcome: state === "completed" ? "triggered" : "failed",
            }),
          ]);
        else {
          expect(contexts).toEqual([]);
          expect(
            readThreadAutomationContexts(previous, scope, threadId),
          ).toEqual([]);
          expect(current.attentionRun(scope, definitionId)).toBeUndefined();
        }
        expect(
          previous
            .prepare(
              `SELECT pinned,pin_revision AS pinRevision,bookmark_revision AS bookmarkRevision,group_assignment_revision AS groupRevision FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?`,
            )
            .get(scope.tenantId, scope.principalId, target),
        ).toEqual({
          pinned: 1,
          pinRevision: 7,
          bookmarkRevision: 3,
          groupRevision: 2,
        });
        expect(
          (
            previous.pragma("table_info(thread_principal_state)") as {
              name: string;
            }[]
          ).some((column) => column.name.startsWith("automation_context_")),
        ).toBe(false);
        expect(previous.pragma("foreign_key_check")).toEqual([]);
      } finally {
        previous.close();
      }
    },
  );

  it("keeps historical uncertainty unresolved while acknowledging silent manual failures", () => {
    const previous = new Database(preMigrationSeed);
    previous.pragma("foreign_keys=ON");
    try {
      const bindings = new ConversationBindingRepository(previous),
        inventory = new InventoryRepository(previous);
      const source = inventory.getThread(scope, threadId).thread;
      for (const state of ["failed", "uncertain"] as const) {
        const target = bindings.createUnboundThread(scope, {
          workspaceId: source.workspaceId,
          connectionProfileId: source.connectionProfileId,
          title: state,
          now: 1_000,
        }).id;
        const id = randomUUID(),
          runId = randomUUID();
        new AutomationRepository(previous).createDefinition(scope, {
          id,
          anchorThreadId: target,
          name: state,
          prompt: "Historical manual prompt",
          precheck: null,
          runMode: "same_thread",
          enabled: false,
          schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 300 },
          misfirePolicy: "coalesce",
          nextRunAt: null,
          now: 1_000,
        });
        previous
          .prepare(
            `INSERT INTO automation_runs(tenant_id,owner_principal_id,automation_id,id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,coalesced_count,run_mode,state,claim_token,lease_expires_at,claim_attempt_count,prompt_snapshot,dispatch_mutation_id,anchor_thread_id,claimed_at,started_at,finished_at,created_at,updated_at,precheck_status,error_code) VALUES(?,?,?,?,'manual',10000,?,0,0,'same_thread',?,NULL,NULL,1,?,?,?,10000,10000,?,10000,11000,'not_configured',?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            id,
            runId,
            `manual:${runId}`,
            state,
            state === "uncertain" ? "Historical manual prompt" : null,
            runId,
            target,
            state === "uncertain" ? null : 11_000,
            state === "uncertain"
              ? "automation_dispatch_uncertain"
              : "automation_dispatch_failed",
          );
      }
      applyDatabaseMigrations(previous, backendNormalizedMigrations);
      const rows = previous
        .prepare(
          "SELECT state,acknowledged_at AS acknowledgedAt FROM automation_runs ORDER BY state",
        )
        .all();
      expect(rows).toEqual([
        { state: "failed", acknowledgedAt: 11_000 },
        { state: "uncertain", acknowledgedAt: null },
      ]);
      const uncertain = previous
        .prepare(
          "SELECT automation_id AS id FROM automation_runs WHERE state='uncertain'",
        )
        .get() as { id: string };
      expect(
        new AutomationRepository(previous).attentionRun(scope, uncertain.id)
          ?.state,
      ).toBe("uncertain");
    } finally {
      previous.close();
    }
  });
});
