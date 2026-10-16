import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { readThreadAutomationContexts } from "../../src/server/application/thread-automation-context.js";
import { readThreadAutomationSummary } from "../../src/server/application/thread-automation-summary.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const dismissalMigrations = backendNormalizedMigrations.filter(
  (migration) => migration.version <= 147,
);

function fixture() {
  const { database, scope } = savedAgentDatabase(146);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    id: randomUUID(),
    environmentId: environment.id,
    canonicalPath: "/tmp/automation-result-dismissal-migration",
    displayName: "Result dismissal migration",
    project: { kind: "new", name: "Result dismissal migration" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 100,
  });
  const profile = database
    .prepare(
      "SELECT id FROM agent_connection_profiles WHERE tenant_id=? AND owner_principal_id=? LIMIT 1",
    )
    .get(scope.tenantId, scope.principalId) as { id: string };
  const thread = new ConversationBindingRepository(
    database,
  ).createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title: "Result dismissal",
    now: 110,
  });
  const repository = new AutomationRepository(database);
  function seed(input: {
    outcome?: "completed" | "failed" | "interrupted";
    acknowledgedAt: number | null;
    deleted?: boolean;
    forceReset?: boolean;
    state?: "completed" | "failed";
  }) {
    const automationId = randomUUID();
    const runId = randomUUID();
    repository.createDefinition(scope, {
      id: automationId,
      anchorThreadId: thread.id,
      name: "Reminder",
      prompt: "Remind me",
      precheck: null,
      runMode: "same_thread",
      enabled: false,
      schedule: { kind: "date_time", runAt: 1_000 },
      misfirePolicy: null,
      nextRunAt: null,
      now: 200,
    });
    if (input.deleted)
      database
        .prepare(
          "UPDATE automation_definitions SET deleted_at=3000,updated_at=3000 WHERE id=?",
        )
        .run(automationId);
    database
      .prepare(
        `INSERT INTO automation_runs(
          tenant_id,owner_principal_id,automation_id,id,occurrence_kind,
          scheduled_for,occurrence_key,definition_revision,coalesced_count,
          run_mode,state,claim_token,lease_expires_at,claim_attempt_count,
          prompt_snapshot,dispatch_mutation_id,anchor_thread_id,claimed_at,
          started_at,accepted_at,finished_at,created_at,updated_at,
          precheck_status,initial_eligible_at,acknowledged_at,
          turn_id,turn_outcome,turn_settled_at,force_reset_at,force_reset_mutation_id
        ) VALUES(?,?,?,?,'scheduled',1000,'scheduled:1000',0,0,
          'same_thread',?,NULL,NULL,1,NULL,?,?,1000,1000,1001,1002,1000,3000,
          'not_configured',1000,?,?,?,?,?,?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        automationId,
        runId,
        input.state ?? "completed",
        randomUUID(),
        thread.id,
        input.acknowledgedAt,
        input.outcome ? `turn-${runId}` : null,
        input.outcome ?? null,
        input.outcome ? 2_000 : null,
        input.forceReset ? 4_000 : null,
        input.forceReset ? randomUUID() : null,
      );
    return runId;
  }
  const read = (runId: string) =>
    database.prepare("SELECT * FROM automation_runs WHERE id=?").get(runId) as {
      acknowledged_at: number | null;
      turn_id: string | null;
      turn_outcome: string | null;
      [key: string]: unknown;
    };
  return { database, seed, read };
}

describe("automation result dismissal migration", () => {
  let current: ReturnType<typeof fixture>;
  beforeEach(() => {
    current = fixture();
  });
  afterEach(() => {
    current.database.close();
  });

  it("reopens only live, nonreset failure dismissals that predate turn settlement", () => {
    const cases = [
      { outcome: "failed", acknowledgedAt: 1_500, expected: null },
      { outcome: "interrupted", acknowledgedAt: 1_500, expected: null },
      // 146 carried a main-era notice state over as finished_at (1002); these
      // turns settled before 146 was applied, so nothing was dismissed early.
      { outcome: "failed", acknowledgedAt: 1_002, expected: 1_002 },
      { outcome: "interrupted", acknowledgedAt: 1_002, expected: 1_002 },
      { outcome: "failed", acknowledgedAt: null, expected: null },
      { outcome: "failed", acknowledgedAt: 2_000, expected: 2_000 },
      { outcome: "interrupted", acknowledgedAt: 2_500, expected: 2_500 },
      { outcome: "completed", acknowledgedAt: 1_500, expected: 1_500 },
      { acknowledgedAt: 1_500, expected: 1_500 },
      {
        outcome: "failed",
        acknowledgedAt: 1_500,
        deleted: true,
        expected: 1_500,
      },
      {
        outcome: "failed",
        acknowledgedAt: 1_500,
        forceReset: true,
        expected: 1_500,
      },
      {
        outcome: "failed",
        acknowledgedAt: 1_500,
        state: "failed",
        expected: 1_500,
      },
    ] as const;
    const rows = cases.map(({ expected, ...input }) => {
      const runId = current.seed(input);
      return { runId, expected, before: current.read(runId) };
    });

    applyDatabaseMigrations(current.database, dismissalMigrations);

    for (const { runId, expected, before } of rows)
      expect(current.read(runId)).toEqual({
        ...before,
        acknowledged_at: expected,
      });
    expect(
      current.database
        .prepare("SELECT max(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 147 });
    expect(
      current.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='automation_runs_failed_turn_history'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      current.database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='index' AND name='automation_runs_problem_turn_history'",
        )
        .get(),
    ).toEqual({
      sql: expect.stringMatching(
        /WHERE turn_outcome IN \('failed', 'interrupted'\)/,
      ),
    });
    expect(current.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(current.database.pragma("foreign_key_check")).toEqual([]);
    expect(current.database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
  });

  it.each(["failed", "interrupted"] as const)(
    "allows only an atomic first %s settlement to reopen acknowledgement",
    (outcome) => {
      const runId = current.seed({ acknowledgedAt: 1_500 });
      const clear = current.database.prepare(
        "UPDATE automation_runs SET acknowledged_at=NULL WHERE id=?",
      );
      const settle = current.database.prepare(
        `UPDATE automation_runs
         SET turn_id=?,turn_outcome=?,turn_settled_at=2000,acknowledged_at=NULL
         WHERE id=?`,
      );
      const turnId = `turn-${runId}`;
      expect(() => settle.run(turnId, outcome, runId)).toThrow(
        /acknowledgement is immutable/,
      );
      applyDatabaseMigrations(current.database, dismissalMigrations);

      expect(() => clear.run(runId)).toThrow(/acknowledgement is immutable/);
      expect(() =>
        current.database
          .prepare("UPDATE automation_runs SET acknowledged_at=1600 WHERE id=?")
          .run(runId),
      ).toThrow(/acknowledgement is immutable/);
      expect(() => settle.run(turnId, "completed", runId)).toThrow(
        /acknowledgement is immutable/,
      );
      expect(current.read(runId)).toMatchObject({
        acknowledged_at: 1_500,
        turn_id: null,
      });

      expect(() => settle.run(turnId, outcome, runId)).not.toThrow();
      expect(current.read(runId)).toMatchObject({
        acknowledged_at: null,
        turn_id: turnId,
        turn_outcome: outcome,
      });
      current.database
        .prepare("UPDATE automation_runs SET acknowledged_at=2500 WHERE id=?")
        .run(runId);
      expect(() => settle.run(turnId, outcome, runId)).toThrow(
        /acknowledgement is immutable/,
      );
      expect(() => clear.run(runId)).toThrow(/acknowledgement is immutable/);
      current.database
        .prepare(
          "UPDATE automation_runs SET turn_started_at=1000,turn_ended_at=2000 WHERE id=?",
        )
        .run(runId);
      expect(current.read(runId)).toMatchObject({
        acknowledged_at: 2_500,
        turn_id: turnId,
        turn_outcome: outcome,
      });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(current.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    },
  );
});

/**
 * Main allowed one automation per thread and recorded a dismissible notice in
 * one slot on the result thread. Each automation gets its own thread.
 */
function mainEraFixture() {
  const { database, scope } = savedAgentDatabase(145);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    id: randomUUID(),
    environmentId: environment.id,
    canonicalPath: "/tmp/automation-result-dismissal-upgrade",
    displayName: "Result dismissal upgrade",
    project: { kind: "new", name: "Result dismissal upgrade" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 100,
  });
  const profile = database
    .prepare(
      "SELECT id FROM agent_connection_profiles WHERE tenant_id=? AND owner_principal_id=? LIMIT 1",
    )
    .get(scope.tenantId, scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(database);
  function automation(kind: "date_time" | "interval") {
    const threadId = bindings.createUnboundThread(scope, {
      workspaceId: workspace.id,
      connectionProfileId: profile.id,
      title: `Main ${kind}`,
      now: 110,
    }).id;
    const automationId = randomUUID();
    // A main-era one-shot that remains live carries completed_at.
    database
      .prepare(
        `INSERT INTO automation_definitions(tenant_id,owner_principal_id,id,
          anchor_thread_id,name,prompt,run_mode,enabled,completed_at,revision,
          schedule_kind,run_at,interval_anchor_at,interval_seconds,
          misfire_policy,next_run_at,last_scheduled_at,created_at,updated_at)
        VALUES(?,?,?,?,'Automation','Prompt','same_thread',?,?,1,?,?,?,?,
          'coalesce',?,1000,500,1500)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        automationId,
        threadId,
        kind === "interval" ? 1 : 0,
        kind === "interval" ? null : 1_002,
        kind,
        kind === "date_time" ? 1_000 : null,
        kind === "interval" ? 1_000 : null,
        kind === "interval" ? 300 : null,
        kind === "interval" ? 301_000 : null,
      );
    return { threadId, automationId };
  }
  /** A delivered scheduled run, settled on main unless `outcome` is null. */
  function mainEraRun(
    target: { threadId: string; automationId: string },
    outcome: "completed" | "failed" | "interrupted" | null,
    notice: "dismissed" | "shown",
  ) {
    const runId = randomUUID();
    const dispatchMutationId = randomUUID();
    database
      .prepare(
        `INSERT INTO automation_runs(tenant_id,owner_principal_id,automation_id,
          id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,
          run_mode,state,claim_attempt_count,dispatch_mutation_id,
          anchor_thread_id,claimed_at,started_at,accepted_at,finished_at,
          created_at,updated_at,precheck_status,turn_id,turn_outcome,
          turn_settled_at)
        VALUES(?,?,?,?,'scheduled',1000,'scheduled:1000',1,'same_thread',
          'completed',1,?,?,1000,1001,1001,1002,1000,1002,'not_configured',
          ?,?,?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        target.automationId,
        runId,
        dispatchMutationId,
        target.threadId,
        outcome ? `turn-${runId}` : null,
        outcome,
        outcome ? 5_000 : null,
      );
    if (notice === "shown")
      database
        .prepare(
          `UPDATE thread_principal_state
          SET automation_context_run_id=?, automation_context_source_thread_id=?,
            automation_context_at=1002, automation_context_outcome='triggered'
          WHERE tenant_id=? AND principal_id=? AND thread_id=?`,
        )
        .run(
          runId,
          target.threadId,
          scope.tenantId,
          scope.principalId,
          target.threadId,
        );
    return { ...target, runId, dispatchMutationId };
  }
  const acknowledgedAt = (runId: string) =>
    (
      database
        .prepare("SELECT acknowledged_at AS value FROM automation_runs WHERE id=?")
        .get(runId) as { value: number | null }
    ).value;
  const attentionCount = (threadId: string) =>
    readThreadAutomationSummary(database, scope, threadId).attentionCount;
  return {
    database,
    scope,
    automation,
    mainEraRun,
    acknowledgedAt,
    attentionCount,
  };
}

describe("upgrading main-era automation history", () => {
  let current: ReturnType<typeof mainEraFixture>;
  beforeEach(() => {
    current = mainEraFixture();
  });
  afterEach(() => {
    current.database.close();
  });

  it("keeps dismissed main-era results dismissed when 146 and 147 apply together", () => {
    const { automation, mainEraRun, acknowledgedAt, attentionCount } = current;
    const failedOnce = mainEraRun(automation("date_time"), "failed", "dismissed");
    const interrupted = mainEraRun(automation("interval"), "interrupted", "dismissed");
    const dismissedSuccess = mainEraRun(automation("date_time"), "completed", "dismissed");
    const shownSuccess = mainEraRun(automation("date_time"), "completed", "shown");
    const shownFailure = mainEraRun(automation("interval"), "failed", "shown");
    const running = mainEraRun(automation("interval"), null, "dismissed");

    applyDatabaseMigrations(current.database, dismissalMigrations);

    for (const run of [failedOnce, interrupted, dismissedSuccess, running])
      expect(acknowledgedAt(run.runId)).toBe(1_002);
    for (const run of [failedOnce, interrupted, dismissedSuccess, running])
      expect(attentionCount(run.threadId)).toBe(0);
    expect(acknowledgedAt(shownSuccess.runId)).toBeNull();
    expect(
      readThreadAutomationContexts(current.database, current.scope, shownSuccess.threadId),
    ).toEqual([expect.objectContaining({ runId: shownSuccess.runId, outcome: "triggered" })]);
    expect(acknowledgedAt(shownFailure.runId)).toBeNull();
    expect(attentionCount(shownFailure.threadId)).toBe(1);

    // First start retires the successful one-shot whose notice was dismissed
    // on main; one whose notice is still shown stays until it is dismissed.
    const repository = new AutomationRepository(current.database);
    expect(repository.settleRunTurnsFromCompletions().map(({ id }) => id))
      .toEqual([dismissedSuccess.runId]);
    expect(repository.getDefinition(current.scope, dismissedSuccess.automationId).deletedAt)
      .not.toBeNull();
    for (const run of [failedOnce, shownSuccess])
      expect(repository.getDefinition(current.scope, run.automationId).deletedAt).toBeNull();

    // A turn still running at the upgrade fails after the carried-over
    // dismissal, so settlement reopens it.
    repository.settleRunTurn(current.scope, running.threadId, running.dispatchMutationId, {
      turnId: `turn-${running.runId}`,
      outcome: "failed",
      settledAt: 6_000,
      startedAt: null,
      endedAt: null,
    });
    expect(acknowledgedAt(running.runId)).toBeNull();
    expect(attentionCount(running.threadId)).toBe(1);
  });

  it("reopens only failures that settled after 146 when 147 is applied later", () => {
    const { automation, mainEraRun, acknowledgedAt, attentionCount, database, scope } = current;
    const mainEra = mainEraRun(automation("interval"), "failed", "dismissed");
    const runningAtUpgrade = mainEraRun(automation("interval"), null, "dismissed");
    applyDatabaseMigrations(
      database,
      backendNormalizedMigrations.filter((migration) => migration.version <= 146),
    );
    const upgradedAt = (
      database
        .prepare("SELECT applied_at AS value FROM schema_migrations WHERE version=146")
        .get() as { value: number }
    ).value;
    expect(acknowledgedAt(mainEra.runId)).toBe(1_002);
    expect(acknowledgedAt(runningAtUpgrade.runId)).toBe(1_002);

    // Before 147, settlement recorded a failure without reopening the
    // acknowledgement, and dismissals could precede the turn's end.
    const settle = database.prepare(
      "UPDATE automation_runs SET turn_id=?,turn_outcome=?,turn_settled_at=? WHERE id=?",
    );
    const acknowledge = database.prepare(
      "UPDATE automation_runs SET acknowledged_at=? WHERE id=?",
    );
    settle.run(`turn-${runningAtUpgrade.runId}`, "failed", upgradedAt + 1_000, runningAtUpgrade.runId);
    function postUpgradeRun(at: number) {
      const target = automation("interval");
      const runId = randomUUID();
      database
        .prepare(
          `INSERT INTO automation_runs(tenant_id,owner_principal_id,automation_id,
            id,occurrence_kind,scheduled_for,occurrence_key,definition_revision,
            run_mode,state,claim_attempt_count,dispatch_mutation_id,
            anchor_thread_id,claimed_at,started_at,accepted_at,finished_at,
            created_at,updated_at,precheck_status,initial_eligible_at)
          VALUES(?,?,?,?,'scheduled',?,?,1,'same_thread','completed',1,?,?,
            ?,?,?,?,?,?,'not_configured',?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          target.automationId,
          runId,
          at,
          `scheduled:${at}`,
          randomUUID(),
          target.threadId,
          at,
          at,
          at,
          at,
          at,
          at,
          at,
        );
      return { ...target, runId };
    }
    const dismissedThenFailed = postUpgradeRun(upgradedAt + 2_000);
    acknowledge.run(upgradedAt + 2_100, dismissedThenFailed.runId);
    settle.run(`turn-${dismissedThenFailed.runId}`, "interrupted", upgradedAt + 2_200, dismissedThenFailed.runId);
    const failedThenDismissed = postUpgradeRun(upgradedAt + 3_000);
    settle.run(`turn-${failedThenDismissed.runId}`, "failed", upgradedAt + 3_100, failedThenDismissed.runId);
    acknowledge.run(upgradedAt + 3_200, failedThenDismissed.runId);
    const dismissedThenSucceeded = postUpgradeRun(upgradedAt + 4_000);
    acknowledge.run(upgradedAt + 4_100, dismissedThenSucceeded.runId);
    settle.run(`turn-${dismissedThenSucceeded.runId}`, "completed", upgradedAt + 4_200, dismissedThenSucceeded.runId);

    applyDatabaseMigrations(database, dismissalMigrations);

    expect(acknowledgedAt(mainEra.runId)).toBe(1_002);
    expect(attentionCount(mainEra.threadId)).toBe(0);
    expect(acknowledgedAt(runningAtUpgrade.runId)).toBeNull();
    expect(attentionCount(runningAtUpgrade.threadId)).toBe(1);
    expect(acknowledgedAt(dismissedThenFailed.runId)).toBeNull();
    expect(attentionCount(dismissedThenFailed.threadId)).toBe(1);
    expect(acknowledgedAt(failedThenDismissed.runId)).toBe(upgradedAt + 3_200);
    expect(attentionCount(failedThenDismissed.threadId)).toBe(0);
    expect(acknowledgedAt(dismissedThenSucceeded.runId)).toBe(upgradedAt + 4_100);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
  });
});
