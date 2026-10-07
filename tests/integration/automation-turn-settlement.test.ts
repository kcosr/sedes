import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  latestAutomationRunJoin,
  projectThreadAutomationSummary,
  threadAutomationSummaryColumns,
  type ThreadAutomationSummaryRow,
} from "../../src/server/application/thread-automation-summary.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import type { AutomationRunRecord } from "../../src/server/domain/automation-models.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { AutomationTurnSettlementObserver } from "../../src/server/runtime/automation-conversation-gateway.js";
import {
  threadAutomationRunPageSchema,
  threadAutomationSummarySchema,
} from "../../src/shared/protocol/automation-presentation.js";
import { normalizedThreadSummarySchema } from "../../src/shared/protocol/conversation.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

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

/**
 * An anchor thread, a second thread used as a clone child and an unbound
 * thread for first input, migrated through `latestMigration`. The anchor
 * carries one automation definition.
 */
function fixture(latestMigration = Number.POSITIVE_INFINITY) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp",
      displayName: "Temporary workspace",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const thread = (title: string, at: number) =>
    legacy.createThread(scope, { workspaceId: workspace.id, title }, at).thread
      .id;
  const anchorThreadId = thread("Anchor", 200);
  const childThreadId = thread("Clone child", 201);
  const unboundThreadId = thread("First input", 202);
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= latestMigration,
    ),
  );
  importLegacyDatabaseConfigurationFixture(
    database,
    {
      configuration,
      localWorkspaceRoots: ["/tmp"],
      sourceLabel: "automation-turn-settlement",
    },
    400,
  );
  new InventoryRepository(database).updateEnvironmentAvailability(
    scope,
    environment.id,
    { available: true, now: 400 },
  );
  const bindings = new ConversationBindingRepository(database);
  for (const threadId of [anchorThreadId, childThreadId]) {
    bindings.bindDiscoveredConversation(scope, threadId, {
      backendConversationId: `native-${threadId}`,
      now: 400,
    });
  }
  const automations = new AutomationRepository(database);
  const automationId = automations.createDefinition(scope, {
    anchorThreadId,
    name: "Turn tracking",
    prompt: "Review the repository",
    precheck: null,
    runMode: "clone",
    enabled: true,
    schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 3_600 },
    misfirePolicy: "coalesce",
    nextRunAt: 1_000,
    now: 500,
  }).id;
  return {
    database,
    scope,
    bindings,
    automations,
    completions: new SubmissionCompletionRepository(database),
    automationId,
    anchorThreadId,
    childThreadId,
    unboundThreadId,
  };
}

type Fixture = ReturnType<typeof fixture>;

type InsertedRun = {
  readonly id: string;
  readonly dispatchMutationId: string;
};

/**
 * Inserts a run row directly, so it also works before migration 136. States
 * follow the table's lifecycle CHECKs.
 */
function insertRun(
  current: Fixture,
  input: {
    readonly state: "completed" | "queued" | "uncertain" | "failed";
    readonly createdAt: number;
    readonly childThreadId?: string;
    readonly forceReset?: boolean;
  },
): InsertedRun {
  const id = randomUUID();
  const dispatchMutationId = randomUUID();
  const at = input.createdAt;
  const finished = input.state === "completed" || input.state === "failed";
  current.database
    .prepare(
      `
        INSERT INTO automation_runs(
          tenant_id, owner_principal_id, automation_id, id,
          occurrence_kind, scheduled_for, occurrence_key,
          definition_revision, coalesced_count, run_mode, state,
          claim_token, lease_expires_at, claim_attempt_count,
          prompt_snapshot, precheck_status, dispatch_mutation_id,
          anchor_thread_id, child_thread_id, error_code,
          claimed_at, started_at, accepted_at, finished_at,
          created_at, updated_at
        )
        VALUES (
          ?, ?, ?, ?, 'manual', ?, ?, 0, 0, ?, ?, NULL, NULL, 1, ?,
          'not_configured', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `,
    )
    .run(
      current.scope.tenantId,
      current.scope.principalId,
      current.automationId,
      id,
      at,
      `manual:${id}`,
      input.childThreadId ? "clone" : "same_thread",
      input.state,
      input.state === "uncertain" ? "Review the repository" : null,
      dispatchMutationId,
      current.anchorThreadId,
      input.childThreadId ?? null,
      input.state !== "failed"
        ? null
        : input.forceReset
          ? "force_reset"
          : "automation_dispatch_failed",
      at,
      at,
      input.state === "uncertain" ? null : at + 1,
      finished ? at + 2 : null,
      at,
      at,
    );
  if (input.forceReset) {
    current.database
      .prepare(
        `
          UPDATE automation_runs
          SET force_reset_at = ?, force_reset_mutation_id = 'reset-1'
          WHERE id = ?
        `,
      )
      .run(at + 3, id);
  }
  return { id, dispatchMutationId };
}

/** Records the rail's final snapshot for an accepted operation. */
function observeFinal(
  current: Fixture,
  threadId: string,
  operationId: string,
  input: {
    readonly turnId: string;
    readonly outcome: "completed" | "interrupted" | "failed";
    readonly observedAt: number;
  },
) {
  current.completions.recordAccepted(current.scope, threadId, {
    operationId,
    acceptedAt: input.observedAt - 10,
    backendCorrelation: operationId,
  });
  return current.completions.observeBackendCompletion(current.scope, threadId, {
    backendCorrelation: operationId,
    completionIdentity: `${input.turnId}:${input.outcome}`,
    observedAt: input.observedAt,
    applicationTurnId: input.turnId,
    outcome: input.outcome,
    result: { text: "Done" },
    classifiedResult: null,
  })!;
}

function settlement(database: Database.Database, runId: string) {
  return database
    .prepare(
      `
        SELECT turn_id AS turnId, turn_outcome AS turnOutcome,
          turn_settled_at AS turnSettledAt, turn_started_at AS turnStartedAt,
          turn_ended_at AS turnEndedAt
        FROM automation_runs WHERE id = ?
      `,
    )
    .get(runId);
}

const unsettled = {
  turnId: null,
  turnOutcome: null,
  turnSettledAt: null,
  turnStartedAt: null,
  turnEndedAt: null,
};

function plan(database: Database.Database, sql: string): string {
  const parameters = sql.match(/\?/g)?.length ?? 0;
  return (
    database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: parameters }, () => "x")) as {
      detail: string;
    }[]
  )
    .map(({ detail }) => detail)
    .join("\n");
}

function service(current: Fixture) {
  const publish = vi.fn();
  const onRunLifecycle = vi.fn();
  const onChanged = vi.fn();
  const automations = new AutomationService({
    repository: current.automations,
    inventory: new InventoryRepository(current.database),
    publisher: { publish },
    executionPolicy: { assertCanAutomate: () => undefined },
    onRunLifecycle,
    onChanged,
  });
  return { automations, publish, onRunLifecycle, onChanged };
}

function projectedAutomation(current: Fixture) {
  const row = current.database
    .prepare(
      `
        SELECT ${threadAutomationSummaryColumns("definition", "run")}
        FROM automation_definitions AS definition
        ${latestAutomationRunJoin("definition", "run")}
        WHERE definition.tenant_id = ? AND definition.owner_principal_id = ?
          AND definition.anchor_thread_id = ?
      `,
    )
    .get(
      current.scope.tenantId,
      current.scope.principalId,
      current.anchorThreadId,
    ) as ThreadAutomationSummaryRow;
  return normalizedThreadSummarySchema.shape.automation.parse(
    projectThreadAutomationSummary(row),
  );
}

describe("automation turn settlement migration", () => {
  it("backfills settled runs from the completion rail, skipping force-reset runs", () => {
    const current = fixture(135);
    try {
      const sameThread = insertRun(current, {
        state: "completed",
        createdAt: 1_000,
      });
      observeFinal(
        current,
        current.anchorThreadId,
        sameThread.dispatchMutationId,
        { turnId: "turn_same", outcome: "completed", observedAt: 1_500 },
      );
      const clone = insertRun(current, {
        state: "completed",
        createdAt: 2_000,
        childThreadId: current.childThreadId,
      });
      observeFinal(current, current.childThreadId, clone.dispatchMutationId, {
        turnId: "turn_clone",
        outcome: "failed",
        observedAt: 2_500,
      });
      // The rail keys a clone run's turn by its child, never its anchor.
      const cloneOnAnchor = insertRun(current, {
        state: "completed",
        createdAt: 3_000,
        childThreadId: current.unboundThreadId,
      });
      observeFinal(
        current,
        current.anchorThreadId,
        cloneOnAnchor.dispatchMutationId,
        { turnId: "turn_anchor", outcome: "completed", observedAt: 3_500 },
      );
      // Reconciliation recorded the end before normalized history.
      const identityOnly = insertRun(current, {
        state: "completed",
        createdAt: 4_000,
      });
      current.completions.recordAccepted(
        current.scope,
        current.anchorThreadId,
        { operationId: identityOnly.dispatchMutationId, acceptedAt: 4_001 },
      );
      current.completions.observeCompletion(
        current.scope,
        current.anchorThreadId,
        identityOnly.dispatchMutationId,
        {
          completionIdentity: "identity",
          observedAt: 4_500,
          createAttention: true,
        },
      );
      const forceReset = insertRun(current, {
        state: "failed",
        createdAt: 5_000,
        forceReset: true,
      });
      observeFinal(
        current,
        current.anchorThreadId,
        forceReset.dispatchMutationId,
        { turnId: "turn_reset", outcome: "completed", observedAt: 5_500 },
      );
      const unobserved = insertRun(current, {
        state: "completed",
        createdAt: 6_000,
      });

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(settlement(current.database, sameThread.id)).toEqual({
        ...unsettled,
        turnId: "turn_same",
        turnOutcome: "completed",
        turnSettledAt: 1_500,
      });
      expect(settlement(current.database, clone.id)).toEqual({
        ...unsettled,
        turnId: "turn_clone",
        turnOutcome: "failed",
        turnSettledAt: 2_500,
      });
      for (const run of [cloneOnAnchor, identityOnly, forceReset, unobserved]) {
        expect(settlement(current.database, run.id)).toEqual(unsettled);
      }
    } finally {
      current.database.close();
    }
  });

  it("keeps a settlement all-or-nothing and write-once, with times only beside it", () => {
    const current = fixture();
    try {
      const run = insertRun(current, { state: "completed", createdAt: 1_000 });
      const update = (assignments: string) => () =>
        current.database
          .prepare(`UPDATE automation_runs SET ${assignments} WHERE id = ?`)
          .run(run.id);

      expect(update("turn_id = 'turn_1'")).toThrow(
        "Automation run turn settlement is incomplete",
      );
      expect(
        update("turn_id = 'turn_1', turn_outcome = 'completed'"),
      ).toThrow("Automation run turn settlement is incomplete");
      expect(update("turn_started_at = 1")).toThrow(
        "Automation run turn settlement is incomplete",
      );
      expect(
        update(
          "turn_id = 'turn_1', turn_outcome = 'cancelled', turn_settled_at = 1",
        ),
      ).toThrow("CHECK constraint failed");
      expect(
        update("turn_id = '', turn_outcome = 'completed', turn_settled_at = 1"),
      ).toThrow("CHECK constraint failed");

      update(
        "turn_id = 'turn_1', turn_outcome = 'completed', turn_settled_at = 2000",
      )();
      for (const assignments of [
        "turn_outcome = 'failed'",
        "turn_id = 'turn_2'",
        "turn_settled_at = 2001",
        "turn_id = NULL, turn_outcome = NULL, turn_settled_at = NULL",
      ]) {
        expect(update(assignments)).toThrow(
          /Automation run turn settlement is (immutable|incomplete)/,
        );
      }
      expect(update("turn_ended_at = 1000, turn_started_at = 1500")).toThrow(
        "CHECK constraint failed",
      );
      update("turn_started_at = 1000")();
      update("turn_ended_at = 1900")();
      expect(update("turn_started_at = 1100")).toThrow(
        "Automation run turn settlement is immutable",
      );
      expect(update("turn_ended_at = NULL")).toThrow(
        "Automation run turn settlement is immutable",
      );
      expect(settlement(current.database, run.id)).toEqual({
        turnId: "turn_1",
        turnOutcome: "completed",
        turnSettledAt: 2_000,
        turnStartedAt: 1_000,
        turnEndedAt: 1_900,
      });
      // Run state stays independent of the settlement.
      update("updated_at = 3000, error_code = 'later'")();

      expect(() =>
        current.database
          .prepare(
            `
              INSERT INTO automation_runs
              SELECT tenant_id, owner_principal_id, automation_id, 'copy',
                occurrence_kind, scheduled_for, 'copy', definition_revision,
                coalesced_count, run_mode, state, claim_token,
                lease_expires_at, claim_attempt_count, prompt_snapshot,
                'copy-dispatch', anchor_thread_id, child_thread_id,
                error_code, error_diagnostic, claimed_at, started_at,
                accepted_at, finished_at, created_at, updated_at,
                precheck_command_snapshot, precheck_timeout_seconds,
                precheck_include_stdout, precheck_status,
                precheck_started_at, precheck_finished_at,
                precheck_exit_code, precheck_duration_ms,
                precheck_stdout_bytes, precheck_stdout_included,
                force_reset_at, force_reset_mutation_id,
                turn_id, NULL, turn_settled_at, NULL, NULL
              FROM automation_runs WHERE id = ?
            `,
          )
          .run(run.id),
      ).toThrow("Automation run turn settlement is incomplete");
    } finally {
      current.database.close();
    }
  });

  it("serves settlement lookups, failed-turn filters and counts from indexes", () => {
    const current = fixture();
    try {
      expect(
        plan(
          current.database,
          `SELECT id FROM automation_runs
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND dispatch_mutation_id = ?
             AND coalesce(child_thread_id, anchor_thread_id) = ?`,
        ),
      ).toContain("USING INDEX automation_runs_dispatch_mutation");
      const failedTurns = plan(
        current.database,
        `SELECT id FROM automation_runs
         WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ?
           AND turn_outcome = 'failed' AND state NOT IN ('failed', 'uncertain')
         ORDER BY created_at DESC, id DESC LIMIT 26`,
      );
      expect(failedTurns).toContain("automation_runs_failed_turn_history");
      expect(failedTurns).not.toContain("TEMP B-TREE");
      expect(
        plan(
          current.database,
          `SELECT count(*) FROM automation_runs
           WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ?
             AND turn_outcome = 'failed'
             AND state NOT IN ('failed', 'uncertain')`,
        ),
      ).toContain("USING COVERING INDEX automation_runs_failed_turn_history");
    } finally {
      current.database.close();
    }
  });
});

describe("automation run turn settlement", () => {
  it("settles a run once from its rail observation and fills in turn times later", () => {
    const current = fixture();
    try {
      const run = insertRun(current, { state: "completed", createdAt: 1_000 });
      const settle = (
        startedAt: number | null,
        endedAt: number | null,
        turnId = "turn_1",
      ) =>
        current.automations.settleRunTurn(
          current.scope,
          current.anchorThreadId,
          run.dispatchMutationId,
          { turnId, outcome: "completed", settledAt: 2_000, startedAt, endedAt },
        );

      expect(settle(null, null)).toMatchObject({
        id: run.id,
        state: "completed",
        turnId: "turn_1",
        turnOutcome: "completed",
        turnSettledAt: 2_000,
        turnStartedAt: null,
        turnEndedAt: null,
        updatedAt: 1_000,
      });
      expect(settle(null, null)).toBeUndefined();
      // A replay that carries the turn's own times fills them in once.
      expect(settle(1_100, 1_900)).toMatchObject({
        turnStartedAt: 1_100,
        turnEndedAt: 1_900,
      });
      expect(settle(1_100, 1_900)).toBeUndefined();
      expect(settle(1_200, 1_800)).toBeUndefined();
      expect(() => settle(null, null, "turn_other")).toThrow(
        "The automation run already settled a different turn.",
      );
      expect(settlement(current.database, run.id)).toEqual({
        turnId: "turn_1",
        turnOutcome: "completed",
        turnSettledAt: 2_000,
        turnStartedAt: 1_100,
        turnEndedAt: 1_900,
      });
    } finally {
      current.database.close();
    }
  });

  it("keys clone runs by their child and never settles unknown or force-reset runs", () => {
    const current = fixture();
    try {
      const clone = insertRun(current, {
        state: "completed",
        createdAt: 1_000,
        childThreadId: current.childThreadId,
      });
      const reset = insertRun(current, {
        state: "failed",
        createdAt: 2_000,
        forceReset: true,
      });
      const input = {
        turnId: "turn_1",
        outcome: "failed" as const,
        settledAt: 3_000,
        startedAt: null,
        endedAt: null,
      };
      const settle = (threadId: string, operationId: string) =>
        current.automations.settleRunTurn(
          current.scope,
          threadId,
          operationId,
          input,
        );

      expect(settle(current.anchorThreadId, clone.dispatchMutationId)).toBe(
        undefined,
      );
      expect(settle(current.anchorThreadId, "unknown-operation")).toBe(
        undefined,
      );
      expect(settle(current.anchorThreadId, reset.dispatchMutationId)).toBe(
        undefined,
      );
      expect(settlement(current.database, reset.id)).toEqual(unsettled);
      expect(
        settle(current.childThreadId, clone.dispatchMutationId),
      ).toMatchObject({ id: clone.id, turnId: "turn_1", turnOutcome: "failed" });
    } finally {
      current.database.close();
    }
  });

  it("settles a run still queued, and delivery then keeps the settlement", () => {
    const current = fixture();
    try {
      const run = insertRun(current, { state: "queued", createdAt: 1_000 });
      current.automations.settleRunTurn(
        current.scope,
        current.anchorThreadId,
        run.dispatchMutationId,
        {
          turnId: "turn_fast",
          outcome: "completed",
          settledAt: 1_500,
          startedAt: null,
          endedAt: null,
        },
      );
      expect(
        current.automations.updateRunState(
          current.scope,
          current.automationId,
          run.id,
          { expectedState: "queued", state: "completed", now: 1_600 },
        ),
      ).toMatchObject({
        state: "completed",
        finishedAt: 1_600,
        turnId: "turn_fast",
        turnOutcome: "completed",
        turnSettledAt: 1_500,
      });
    } finally {
      current.database.close();
    }
  });
});

describe("AutomationTurnSettlementObserver", () => {
  function observer(current: Fixture) {
    const setup = service(current);
    return {
      ...setup,
      observer: new AutomationTurnSettlementObserver({
        repository: current.automations,
        publisher: setup.automations,
      }),
    };
  }

  it("records a replayed completion once and publishes the run without a lifecycle notification", () => {
    const current = fixture();
    try {
      const setup = observer(current);
      const clone = insertRun(current, {
        state: "completed",
        createdAt: 1_000,
        childThreadId: current.childThreadId,
      });
      const observed = observeFinal(
        current,
        current.childThreadId,
        clone.dispatchMutationId,
        { turnId: "turn_clone", outcome: "interrupted", observedAt: 2_000 },
      );
      const times = {
        startedAt: "1970-01-01T00:00:01.100Z",
        completedAt: "1970-01-01T00:00:01.900Z",
      };

      for (let replay = 0; replay < 3; replay += 1) {
        setup.observer.observe(
          current.scope,
          current.childThreadId,
          observed,
          times,
        );
      }

      expect(setup.publish.mock.calls).toEqual([
        [current.scope, current.anchorThreadId],
        [current.scope, current.childThreadId],
      ]);
      expect(setup.onRunLifecycle).not.toHaveBeenCalled();
      expect(setup.onChanged).not.toHaveBeenCalled();
      expect(
        setup.automations.listRuns(current.scope, current.anchorThreadId, {
          pageSize: 10,
        }).items,
      ).toEqual([
        expect.objectContaining({
          id: clone.id,
          state: "completed",
          resultThreadId: current.childThreadId,
          turn: {
            id: "turn_clone",
            outcome: "interrupted",
            settledAt: new Date(2_000).toISOString(),
            startedAt: times.startedAt,
            endedAt: times.completedAt,
          },
        }),
      ]);
    } finally {
      current.database.close();
    }
  });

  it("settles a first input's turn on the thread it bound", () => {
    const current = fixture();
    try {
      const setup = observer(current);
      const automationId = current.automations.createDefinition(current.scope, {
        anchorThreadId: current.unboundThreadId,
        name: "First input",
        prompt: "Start the work",
        precheck: null,
        runMode: "same_thread",
        enabled: true,
        schedule: { kind: "interval", anchorAt: 1_000, everySeconds: 3_600 },
        misfirePolicy: "coalesce",
        nextRunAt: 1_000,
        now: 500,
      }).id;
      const run = current.automations.createManualRun(
        current.scope,
        automationId,
        {
          runId: randomUUID(),
          occurrenceKey: "manual:first-input",
          scheduledFor: 1_000,
          claimToken: "claim",
          leaseExpiresAt: 60_000,
          dispatchMutationId: randomUUID(),
          now: 1_000,
        },
      ).run;
      // The first send binds the thread and records acceptance under the
      // dispatch mutation, exactly like a queued submit.
      current.bindings.bindDiscoveredConversation(
        current.scope,
        current.unboundThreadId,
        { backendConversationId: "native-first-input", now: 1_100 },
      );
      const observed = observeFinal(
        current,
        current.unboundThreadId,
        run.dispatchMutationId,
        { turnId: "turn_first", outcome: "completed", observedAt: 1_500 },
      );

      setup.observer.observe(current.scope, current.unboundThreadId, observed);

      expect(
        current.automations.getRun(current.scope, automationId, run.id),
      ).toMatchObject({
        state: "claimed",
        turnId: "turn_first",
        turnOutcome: "completed",
      });
      expect(setup.publish).toHaveBeenCalledWith(
        current.scope,
        current.unboundThreadId,
      );
    } finally {
      current.database.close();
    }
  });

  it("ignores operations that started no run, incomplete observations and force-reset runs", () => {
    const current = fixture();
    try {
      const setup = observer(current);
      const userTurn = observeFinal(
        current,
        current.anchorThreadId,
        "user-operation",
        { turnId: "turn_user", outcome: "completed", observedAt: 1_000 },
      );
      setup.observer.observe(current.scope, current.anchorThreadId, userTurn);

      const pending = insertRun(current, {
        state: "completed",
        createdAt: 2_000,
      });
      setup.observer.observe(current.scope, current.anchorThreadId, {
        operationId: pending.dispatchMutationId,
        applicationTurnId: null,
        completionOutcome: null,
        completionObservedAt: 2_500,
      });

      const reset = insertRun(current, {
        state: "failed",
        createdAt: 3_000,
        forceReset: true,
      });
      setup.observer.observe(
        current.scope,
        current.anchorThreadId,
        observeFinal(current, current.anchorThreadId, reset.dispatchMutationId, {
          turnId: "turn_reset",
          outcome: "completed",
          observedAt: 3_500,
        }),
      );

      expect(setup.publish).not.toHaveBeenCalled();
      expect(settlement(current.database, pending.id)).toEqual(unsettled);
      expect(settlement(current.database, reset.id)).toEqual(unsettled);
    } finally {
      current.database.close();
    }
  });

  it("records no duration from times that end before they start", () => {
    const current = fixture();
    try {
      const setup = observer(current);
      const run = insertRun(current, { state: "completed", createdAt: 1_000 });
      const observed = observeFinal(
        current,
        current.anchorThreadId,
        run.dispatchMutationId,
        { turnId: "turn_1", outcome: "completed", observedAt: 2_000 },
      );
      setup.observer.observe(current.scope, current.anchorThreadId, observed, {
        startedAt: "1970-01-01T00:00:01.900Z",
        completedAt: "1970-01-01T00:00:01.100Z",
      });
      setup.observer.observe(current.scope, current.anchorThreadId, observed, {
        startedAt: "not a time",
      });
      expect(settlement(current.database, run.id)).toEqual({
        ...unsettled,
        turnId: "turn_1",
        turnOutcome: "completed",
        turnSettledAt: 2_000,
      });
      expect(setup.publish).toHaveBeenCalledTimes(1);
    } finally {
      current.database.close();
    }
  });

  it("recovers what the rail recorded while no observer was bound, once per thread", () => {
    const current = fixture();
    try {
      const setup = observer(current);
      const first = insertRun(current, { state: "completed", createdAt: 1_000 });
      const second = insertRun(current, {
        state: "completed",
        createdAt: 2_000,
      });
      const reset = insertRun(current, {
        state: "failed",
        createdAt: 3_000,
        forceReset: true,
      });
      for (const [run, turnId] of [
        [first, "turn_first"],
        [second, "turn_second"],
        [reset, "turn_reset"],
      ] as const) {
        observeFinal(current, current.anchorThreadId, run.dispatchMutationId, {
          turnId,
          outcome: "completed",
          observedAt: 4_000,
        });
      }

      setup.observer.recover();
      setup.observer.recover();

      expect(setup.publish.mock.calls).toEqual([
        [current.scope, current.anchorThreadId],
      ]);
      expect(setup.onRunLifecycle).not.toHaveBeenCalled();
      expect(settlement(current.database, first.id)).toMatchObject({
        turnId: "turn_first",
      });
      expect(settlement(current.database, second.id)).toMatchObject({
        turnId: "turn_second",
      });
      expect(settlement(current.database, reset.id)).toEqual(unsettled);
    } finally {
      current.database.close();
    }
  });
});

describe("automation run turn presentation", () => {
  function settle(
    current: Fixture,
    run: InsertedRun,
    outcome: "completed" | "interrupted" | "failed",
    times: { readonly startedAt: number; readonly endedAt: number } | null,
  ): AutomationRunRecord {
    return current.automations.settleRunTurn(
      current.scope,
      current.anchorThreadId,
      run.dispatchMutationId,
      {
        turnId: `turn_${run.id}`,
        outcome,
        settledAt: (times?.endedAt ?? 0) + 50,
        startedAt: times?.startedAt ?? null,
        endedAt: times?.endedAt ?? null,
      },
    )!;
  }

  it("lists failed turns as problems, once, and counts them", () => {
    const current = fixture();
    try {
      const { automations } = service(current);
      const finished = insertRun(current, {
        state: "completed",
        createdAt: 1_000,
      });
      settle(current, finished, "completed", null);
      const interrupted = insertRun(current, {
        state: "completed",
        createdAt: 2_000,
      });
      settle(current, interrupted, "interrupted", null);
      const failedTurn = insertRun(current, {
        state: "completed",
        createdAt: 3_000,
      });
      settle(current, failedTurn, "failed", {
        startedAt: 3_100,
        endedAt: 3_900,
      });
      const failedDelivery = insertRun(current, {
        state: "failed",
        createdAt: 4_000,
      });
      // Uncertain with a failed turn is listed and counted once.
      const uncertain = insertRun(current, {
        state: "uncertain",
        createdAt: 5_000,
      });
      settle(current, uncertain, "failed", null);

      const page = (filter: "all" | "problems" | "skipped", cursor?: string) =>
        threadAutomationRunPageSchema.parse(
          automations.listRuns(current.scope, current.anchorThreadId, {
            pageSize: 2,
            filter,
            ...(cursor ? { cursor } : {}),
          }),
        );
      const first = page("problems");
      expect(first.counts).toEqual({ all: 5, problems: 3, skipped: 0 });
      const second = page("problems", first.nextCursor!);
      expect(second.nextCursor).toBeNull();
      expect(
        [...first.items, ...second.items].map(({ id }) => id),
      ).toEqual([uncertain.id, failedDelivery.id, failedTurn.id]);
      expect(first.items[0]).toMatchObject({
        state: "uncertain",
        turn: { outcome: "failed" },
      });
      expect(second.items[0]).toEqual(
        expect.objectContaining({
          state: "completed",
          turn: {
            id: `turn_${failedTurn.id}`,
            outcome: "failed",
            settledAt: new Date(3_950).toISOString(),
            startedAt: new Date(3_100).toISOString(),
            endedAt: new Date(3_900).toISOString(),
          },
        }),
      );
      const all = automations.listRuns(current.scope, current.anchorThreadId, {
        pageSize: 10,
      });
      expect(all.items.find(({ id }) => id === failedDelivery.id)).not.toHaveProperty(
        "turn",
      );
      expect(
        all.items.find(({ id }) => id === interrupted.id)?.turn,
      ).toEqual({
        id: `turn_${interrupted.id}`,
        outcome: "interrupted",
        settledAt: new Date(50).toISOString(),
      });
    } finally {
      current.database.close();
    }
  });

  it("presents the latest run's turn outcome in the REST and projected summaries", () => {
    const current = fixture();
    try {
      const { automations } = service(current);
      const latest = insertRun(current, {
        state: "completed",
        createdAt: 1_000,
      });
      const definition = current.automations.getDefinition(
        current.scope,
        current.automationId,
      );
      expect(
        automations.presentSummary(current.scope, definition).lastRun,
      ).not.toHaveProperty("turn");
      expect(projectedAutomation(current)?.lastRun).not.toHaveProperty("turn");

      settle(current, latest, "failed", null);
      expect(
        threadAutomationSummarySchema.parse(
          automations.presentSummary(current.scope, definition),
        ).lastRun?.turn,
      ).toEqual({ outcome: "failed" });
      expect(projectedAutomation(current)?.lastRun?.turn).toEqual({
        outcome: "failed",
      });

      settle(current, latest, "failed", { startedAt: 1_100, endedAt: 1_900 });
      const turn = { outcome: "failed", endedAt: new Date(1_900).toISOString() };
      expect(
        automations.presentSummary(current.scope, definition).lastRun?.turn,
      ).toEqual(turn);
      expect(projectedAutomation(current)?.lastRun?.turn).toEqual(turn);
    } finally {
      current.database.close();
    }
  });
});
