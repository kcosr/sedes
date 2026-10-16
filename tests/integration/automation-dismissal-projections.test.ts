import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { readThreadAutomationContexts } from "../../src/server/application/thread-automation-context.js";
import { readThreadAutomationSummary } from "../../src/server/application/thread-automation-summary.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { AutomationDefinitionRecord, AutomationRunRecord } from "../../src/server/domain/automation-models.js";

let seed: Buffer, scope: RequestScope, sourceId: string, childId: string, secondChildId: string;
beforeAll(() => {
  const current = savedAgentDatabase();
  scope = current.scope;
  try {
    const inventory = new InventoryRepository(current.database);
    const environment = inventory.getLocalEnvironment(scope);
    const workspace = inventory.upsertWorkspace(scope, {
      environmentId: environment.id, canonicalPath: "/tmp/automation-dismissal",
      displayName: "Automation dismissal", available: true, trustState: "trusted",
      environmentConfigurationRevision: environment.configurationRevision,
      project: { kind: "new", name: "Automation dismissal" }, now: 110,
    });
    const profile = current.database.prepare(`SELECT id FROM agent_connection_profiles
      WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY id LIMIT 1`)
      .get(scope.tenantId, scope.principalId) as { id: string };
    const bindings = new ConversationBindingRepository(current.database);
    const thread = (title: string) => bindings.createUnboundThread(scope, {
      workspaceId: workspace.id, connectionProfileId: profile.id, title, now: 120,
    }).id;
    sourceId = thread("Assistant");
    childId = thread("Automation result");
    secondChildId = thread("Second automation result");
    seed = current.database.serialize();
  } finally {
    current.database.close();
  }
});

describe("automation dismissal projections", () => {
  let database: Database.Database, repository: AutomationRepository;
  beforeEach(() => {
    database = new Database(seed);
    database.pragma("foreign_keys = ON");
    repository = new AutomationRepository(database);
  });
  afterEach(() => database.close());

  const definition = (runMode: "same_thread" | "clone" = "same_thread", recurring = false) =>
    repository.createDefinition(scope, {
      id: randomUUID(), anchorThreadId: sourceId, name: "Scheduled update",
      prompt: "Review the update", runMode, enabled: true, precheck: null,
      schedule: recurring ? { kind: "interval", anchorAt: 1_000, everySeconds: 300 }
        : { kind: "date_time", runAt: 1_000 },
      misfirePolicy: recurring ? "coalesce" : null, nextRunAt: 1_000, now: 500,
    });
  const deliver = (definition: AutomationDefinitionRecord, manual = false, now = 1_000, child = childId) => {
    const claim = {
      runId: randomUUID(), occurrenceKey: manual ? `manual:${randomUUID()}` : "scheduled:1000",
      scheduledFor: manual ? now : 1_000, claimToken: randomUUID(), leaseExpiresAt: now + 60_000,
      dispatchMutationId: randomUUID(), now,
    };
    const run = manual ? repository.createManualRun(scope, definition.id, claim).run
      : repository.claimScheduledOccurrence(scope, definition.id, {
        ...claim, lastScheduledAt: 1_000, nextRunAt: definition.schedule.kind === "date_time" ? null : 301_000,
        coalescedCount: 0,
      }).run;
    repository.updateRunState(scope, definition.id, run.id, {
      expectedState: "claimed", state: "dispatching", claimToken: run.claimToken!,
      retainPromptSnapshot: true, now: now + 1,
    });
    // This fixture tests durable projections; child lifecycle/provenance has separate coverage.
    if (definition.runMode === "clone") database.prepare(`UPDATE automation_runs SET child_thread_id = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ? AND id = ?`)
      .run(child, scope.tenantId, scope.principalId, definition.id, run.id);
    return repository.updateRunState(scope, definition.id, run.id, {
      expectedState: "dispatching", state: "completed", claimToken: run.claimToken!,
      completeDefinition: !manual && definition.schedule.kind === "date_time", now: now + 2,
    });
  };
  const settle = (run: AutomationRunRecord, outcome: "completed" | "failed" | "interrupted", now = 1_100) =>
    repository.settleRunTurn(scope, run.childThreadId ?? run.anchorThreadId, run.dispatchMutationId, {
      turnId: randomUUID(), outcome, settledAt: now, startedAt: run.claimedAt + 1, endedAt: now,
    });
  const summary = () => readThreadAutomationSummary(database, scope, sourceId);
  const contexts = (threadId = sourceId) => readThreadAutomationContexts(database, scope, threadId);
  const inventorySummary = (threadId: string) => new DatabaseApplicationThreadSummaryReader({
    inventory: new InventoryRepository(database), queue: new QueuedInputRepository(database),
    completion: new SubmissionCompletionRepository(database),
  }).listByIds(scope, [threadId])[0]!;

  it.each([
    ["same_thread", "failed"], ["same_thread", "interrupted"],
    ["clone", "failed"], ["clone", "interrupted"],
  ] as const)("resurfaces a dismissed %s notice after the agent turn is %s", (mode, outcome) => {
    const automation = definition(mode);
    const run = deliver(automation);
    const target = mode === "clone" ? childId : sourceId;
    expect(contexts(target)).toEqual([expect.objectContaining({ runId: run.id, outcome: "triggered" })]);
    expect(summary()).toMatchObject({ totalCount: 1, inFlightCount: 1, attentionCount: 0 });
    repository.acknowledgeRun(scope, automation.id, run.id, 1_050);
    expect(contexts(target)).toEqual([]);
    expect(summary().totalCount).toBe(1);

    settle(run, outcome);

    const diagnostic = outcome === "failed" ? "The automation’s agent turn failed."
      : "The automation’s agent turn was interrupted.";
    expect(contexts(target)).toEqual([expect.objectContaining({
      automationId: automation.id, runId: run.id, outcome: "failed", diagnostic: { text: diagnostic },
      triggeredAt: new Date(1_100).toISOString(),
    })]);
    expect(contexts()).toEqual([expect.objectContaining({ runId: run.id, outcome: "failed" })]);
    expect(summary()).toMatchObject({ totalCount: 1, inFlightCount: 0, attentionCount: 1 });
    expect(inventorySummary(target).attention.automationContext).toBe("failed");
    expect(repository.attentionRun(scope, automation.id)?.id).toBe(run.id);
    expect(readThreadAutomationContexts(database, { ...scope, principalId: "other-principal" }, target)).toEqual([]);

    repository.acknowledgeRun(scope, automation.id, run.id, 1_200);
    expect(contexts(target)).toEqual([]);
    expect(summary()).toMatchObject({ totalCount: 1, attentionCount: 0 });
    expect(repository.getDefinition(scope, automation.id).deletedAt).toBeNull();
  });

  it.each(["same_thread", "clone"] as const)("removes only the dismissed successful %s one-shot while its failed sibling remains", (mode) => {
    const failed = definition();
    const failedRun = deliver(failed);
    settle(failedRun, "failed");
    const successful = definition(mode);
    const successfulRun = deliver(successful, false, 1_200);
    settle(successfulRun, "completed", 1_300);
    expect(summary()).toMatchObject({ totalCount: 2, attentionCount: 1, inFlightCount: 0 });
    const target = mode === "clone" ? childId : sourceId;
    expect(contexts(target)).toContainEqual(expect.objectContaining({ automationId: successful.id, outcome: "triggered" }));
    const revision = summary().revision;

    repository.acknowledgeRun(scope, successful.id, successfulRun.id, 1_400);

    expect(summary()).toMatchObject({ totalCount: 1, attentionCount: 1 });
    expect(summary().revision).toBeGreaterThan(revision);
    expect(contexts()).toEqual([expect.objectContaining({ automationId: failed.id, outcome: "failed" })]);
    if (mode === "clone") expect(contexts(childId)).toEqual([]);
    expect(repository.getRun(scope, successful.id, successfulRun.id).turnOutcome).toBe("completed");
  });

  it.each(["same_thread", "clone"] as const)("surfaces failed manual %s turns without creating a successful manual trigger notice", (mode) => {
    const automation = definition(mode, true);
    const run = deliver(automation, true);
    const target = mode === "clone" ? childId : sourceId;
    expect(contexts(target)).toEqual([]);
    settle(run, "failed");
    expect(contexts(target)).toEqual([expect.objectContaining({ automationId: automation.id, outcome: "failed" })]);
    expect(summary()).toMatchObject({ attentionCount: 1, inFlightCount: 0 });
    expect(inventorySummary(target).attention.automationContext).toBe("failed");
  });

  it.each(["completed", "failed"] as const)("keeps a Fork one-shot until every result notice is dismissed after a %s Run now", (outcome) => {
    const automation = definition("clone");
    const scheduled = deliver(automation);
    settle(scheduled, "completed");
    const manual = deliver(automation, true, 1_200, secondChildId);
    settle(manual, outcome, 1_300);
    // Each result thread keeps its own notice; a later run does not supersede it.
    expect(contexts(childId)).toEqual([expect.objectContaining({ runId: scheduled.id, outcome: "triggered" })]);
    expect(contexts(secondChildId)).toEqual(outcome === "failed"
      ? [expect.objectContaining({ runId: manual.id, outcome: "failed" })] : []);
    expect(repository.getDefinition(scope, automation.id).deletedAt).toBeNull();

    repository.acknowledgeRun(scope, automation.id, scheduled.id, 1_400);
    if (outcome === "failed") {
      expect(repository.getDefinition(scope, automation.id).deletedAt).toBeNull();
      expect(contexts()).toEqual([expect.objectContaining({ runId: manual.id, outcome: "failed" })]);
      repository.acknowledgeRun(scope, automation.id, manual.id, 1_500);
    }
    expect(repository.getDefinition(scope, automation.id).deletedAt).not.toBeNull();
    expect(contexts(childId)).toEqual([]);
    expect(contexts(secondChildId)).toEqual([]);
  });

  it("counts the latest accepted turn without changing the actionable schedule or reviving historical unsettled turns", () => {
    const automation = definition("same_thread", true);
    deliver(automation);
    expect(summary()).toMatchObject({ inFlightCount: 1, nextRunAt: new Date(301_000).toISOString() });
    expect(contexts()).toHaveLength(1);
    const manual = deliver(automation, true, 1_200);
    settle(manual, "completed", 1_300);
    expect(summary()).toMatchObject({ inFlightCount: 0, attentionCount: 0, nextRunAt: new Date(301_000).toISOString() });
    expect(contexts()).toEqual([]);
    expect(inventorySummary(sourceId).attention.automationContext).toBeNull();
  });

  it("keeps a settled successful recurring notice until dismissal without retiring its schedule", () => {
    const automation = definition("same_thread", true);
    const run = deliver(automation);
    settle(run, "completed");
    expect(contexts()).toEqual([expect.objectContaining({ runId: run.id, outcome: "triggered" })]);
    repository.acknowledgeRun(scope, automation.id, run.id, 1_200);
    expect(contexts()).toEqual([]);
    expect(summary()).toMatchObject({ totalCount: 1, enabledCount: 1, inFlightCount: 0 });
  });
});
