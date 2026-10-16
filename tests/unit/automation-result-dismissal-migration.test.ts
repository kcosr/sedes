import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
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
