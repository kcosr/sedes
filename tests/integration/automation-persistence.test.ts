import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { initialMigration } from "../../src/server/db/migrations/001-initial.js";
import { seedSingleUserMigration } from "../../src/server/db/migrations/002-seed-single-user.js";
import { automationFoundationMigration } from "../../src/server/db/migrations/003-automation-foundation.js";
import { automationDispatchMigration } from "../../src/server/db/migrations/004-automation-dispatch.js";
import { threadAutomationMigration } from "../../src/server/db/migrations/005-thread-automation.js";
import { threadAutomationIdempotencyMigration } from "../../src/server/db/migrations/006-thread-automation-idempotency.js";
import { automationPrechecksAttentionMigration } from "../../src/server/db/migrations/007-automation-prechecks-attention.js";
import { threadCompletionAttentionMigration } from "../../src/server/db/migrations/008-thread-completion-attention.js";
import { threadCompletionAttentionConstraintsMigration } from "../../src/server/db/migrations/009-thread-completion-attention-constraints.js";
import {
  AutomationRepository,
  type CreateAutomationDefinitionInput,
} from "../../src/server/db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";

const automationMigrationsV4 = [
  initialMigration,
  seedSingleUserMigration,
  automationFoundationMigration,
  automationDispatchMigration,
] as const;

const automationMigrationsV5 = [
  ...automationMigrationsV4,
  threadAutomationMigration,
] as const;

const automationMigrationsV6 = [
  ...automationMigrationsV5,
  threadAutomationIdempotencyMigration,
] as const;

const automationMigrationsV7 = [
  ...automationMigrationsV6,
  automationPrechecksAttentionMigration,
] as const;

const automationMigrationsV8 = [
  ...automationMigrationsV7,
  threadCompletionAttentionMigration,
] as const;

const automationMigrationsV9 = [
  ...automationMigrationsV8,
  threadCompletionAttentionConstraintsMigration,
] as const;

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

describe("automation persistence", () => {
  let directory: string;
  let database: Database.Database;
  let inventory: InventoryRepository;
  let automations: AutomationRepository;
  let bindings: ConversationBindingRepository;
  let connectionProfileId: string;
  let scope: RequestScope;
  let anchorThreadId: string;
  let workspaceId: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "sedes-automation-"));
    database = openOverlayDatabase(path.join(directory, "overlay.sqlite"));
    scope = new SingleUserIdentityProvider(database).getScope();
    const legacyInventory = new ThreadInventoryService(
      new OverlayRepository(database),
    );
    const environment = legacyInventory.getLocalEnvironment(scope);
    workspaceId = legacyInventory.rememberWorkspace(
      scope,
      {
        environmentId: environment.id,
        canonicalPath: path.join(directory, "workspace"),
        displayName: "Automation workspace",
        availability: "available",
        trustState: "trusted",
      },
      1_000,
    ).id;
    anchorThreadId = legacyInventory.createThread(
      scope,
      { workspaceId, title: "Automation anchor" },
      1_100,
    ).thread.id;
    applyBackendNormalizationMigration(database, {
      configuration,
      quiescentCutoverConfirmed: true,
      appliedAt: 1_200,
    });
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    inventory = new InventoryRepository(database);
    bindings = new ConversationBindingRepository(database);
    connectionProfileId = (
      database
        .prepare(
          `
            SELECT id
            FROM agent_connection_profiles
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND template_id = 'local-primary'
          `,
        )
        .get(scope.tenantId, scope.principalId) as { id: string }
    ).id;
    automations = new AutomationRepository(database);
  });

  it("keeps the deployed completion-attention migration immutable", () => {
    expect(
      createHash("sha256")
        .update(threadCompletionAttentionMigration.sql)
        .digest("hex"),
    ).toBe("cc9573aeb8254fb9de477096942f240aab27cf77309f7270b4c81a61c9378fd1");
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createThread(title: string, now: number): string {
    return bindings.createUnboundThread(scope, {
      workspaceId,
      connectionProfileId,
      title,
      now,
    }).id;
  }

  it("upgrades populated overlays without losing thread-owned rows", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, [
        initialMigration,
        seedSingleUserMigration,
      ]);
      const legacy = seedLegacyThread(upgradeDatabase, {
        label: "Upgrade workspace",
        canonicalPath: path.join(directory, "upgrade-workspace"),
        draftText: "",
        draftRevision: 2,
        stashText: "Preserve this draft",
      });

      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV9);
      applyBackendNormalizationMigration(upgradeDatabase, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 2_000,
      });

      expect(
        upgradeDatabase
          .prepare(
            `SELECT text, revision FROM thread_drafts
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .get(
            legacy.scope.tenantId,
            legacy.scope.principalId,
            legacy.threadId,
          ),
      ).toEqual({ text: "", revision: 2 });
      expect(
        upgradeDatabase
          .prepare(
            `SELECT text FROM prompt_stashes
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .all(
            legacy.scope.tenantId,
            legacy.scope.principalId,
            legacy.threadId,
          ),
      ).toEqual([{ text: "Preserve this draft" }]);
      expect(
        upgradeDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
      ]);
      expect(upgradeDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
    } finally {
      upgradeDatabase.close();
    }
  });

  it("upgrades a clean automation overlay to one live definition per thread", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "clean-thread-automation-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV4);
      const seeded = seedScopedPrincipal(upgradeDatabase, "Clean upgrade");
      const existingId = insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );

      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV5);

      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT id, anchor_thread_id AS anchorThreadId
              FROM automation_definitions
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND anchor_thread_id = ? AND deleted_at IS NULL
            `,
          )
          .get(
            seeded.scope.tenantId,
            seeded.scope.principalId,
            seeded.anchorThreadId,
          ),
      ).toEqual({
        id: existingId,
        anchorThreadId: seeded.anchorThreadId,
      });
      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT name
              FROM sqlite_master
              WHERE type = 'index'
                AND name = 'automation_definitions_one_per_thread'
            `,
          )
          .get(),
      ).toEqual({ name: "automation_definitions_one_per_thread" });
      expect(() =>
        insertLegacyDefinition(
          upgradeDatabase,
          seeded.scope,
          seeded.anchorThreadId,
        ),
      ).toThrow();
    } finally {
      upgradeDatabase.close();
    }
  });

  it("upgrades v5 run and mutation identity constraints without losing receipts", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "clean-idempotency-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV5);
      const seeded = seedScopedPrincipal(
        upgradeDatabase,
        "Idempotency upgrade",
      );
      const definitionId = insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );
      const mutationId = randomUUID();
      upgradeDatabase
        .prepare(
          `
            INSERT INTO automation_mutation_receipts(
              tenant_id, owner_principal_id, mutation_id, automation_id,
              mutation_kind, request_fingerprint, result_revision, created_at
            )
            VALUES (?, ?, ?, ?, 'update', ?, 0, 1600)
          `,
        )
        .run(
          seeded.scope.tenantId,
          seeded.scope.principalId,
          mutationId,
          definitionId,
          "a".repeat(64),
        );

      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV6);

      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT automation_id AS automationId,
                mutation_kind AS mutationKind,
                request_fingerprint AS requestFingerprint,
                result_revision AS resultRevision
              FROM automation_mutation_receipts
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND mutation_id = ?
            `,
          )
          .get(seeded.scope.tenantId, seeded.scope.principalId, mutationId),
      ).toEqual({
        automationId: definitionId,
        mutationKind: "update",
        requestFingerprint: "a".repeat(64),
        resultRevision: 0,
      });
      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT name
              FROM sqlite_master
              WHERE type = 'index' AND name = 'automation_runs_scoped_id'
            `,
          )
          .get(),
      ).toEqual({ name: "automation_runs_scoped_id" });
      expect(
        upgradeDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
    } finally {
      upgradeDatabase.close();
    }
  });

  it("upgrades v6 definitions, runs, and thread attention to v9 defaults", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "precheck-attention-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV6);
      const seeded = seedScopedPrincipal(
        upgradeDatabase,
        "Pre-check and attention upgrade",
      );
      const definitionId = insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );
      const runId = randomUUID();
      insertLegacyRun(upgradeDatabase, seeded.scope, {
        automationId: definitionId,
        runId,
        occurrenceKey: `manual:${randomUUID()}`,
        anchorThreadId: seeded.anchorThreadId,
      });

      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV9);
      applyBackendNormalizationMigration(upgradeDatabase, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 2_000,
      });

      const repository = new AutomationRepository(upgradeDatabase);
      expect(
        repository.getDefinition(seeded.scope, definitionId),
      ).toMatchObject({
        precheck: null,
      });
      expect(
        repository.getRun(seeded.scope, definitionId, runId),
      ).toMatchObject({
        precheckCommandSnapshot: null,
        precheckTimeoutSeconds: null,
        precheckIncludeStdout: null,
        precheckStatus: "not_configured",
      });
      expect(
        upgradeDatabase
          .prepare(
            `SELECT
               wake_reminder_text AS wakeReminderText,
               automation_context_run_id AS automationContextRunId,
               automation_context_source_thread_id AS automationContextSourceThreadId,
               automation_context_at AS automationContextAt,
               automation_context_outcome AS automationContextOutcome,
               automation_context_diagnostic AS automationContextDiagnostic
             FROM thread_principal_state
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .get(
            seeded.scope.tenantId,
            seeded.scope.principalId,
            seeded.anchorThreadId,
          ),
      ).toEqual({
        wakeReminderText: null,
        automationContextRunId: null,
        automationContextSourceThreadId: null,
        automationContextAt: null,
        automationContextOutcome: null,
        automationContextDiagnostic: null,
      });
      expect(
        upgradeDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
      ]);
      expect(() =>
        upgradeDatabase
          .prepare(
            `
              UPDATE automation_definitions
              SET precheck_command = 'exit 0'
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(seeded.scope.tenantId, seeded.scope.principalId, definitionId),
      ).toThrow();
      expect(() =>
        upgradeDatabase
          .prepare(
            `
              UPDATE thread_principal_state
              SET automation_context_run_id = 'incomplete'
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(
            seeded.scope.tenantId,
            seeded.scope.principalId,
            seeded.anchorThreadId,
          ),
      ).toThrow();
      expect(() =>
        upgradeDatabase
          .prepare(
            `
              UPDATE thread_principal_state
              SET seen_agent_completion_id = 'orphaned-completion'
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(
            seeded.scope.tenantId,
            seeded.scope.principalId,
            seeded.anchorThreadId,
          ),
      ).toThrow();
      expect(upgradeDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
    } finally {
      upgradeDatabase.close();
    }
  });

  it("moves legacy automation attention to its target and removes automation wake state", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "completion-attention-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV7);
      const seeded = seedScopedPrincipal(
        upgradeDatabase,
        "Completion attention upgrade",
      );
      const childThreadId = insertLegacyThread(
        upgradeDatabase,
        seeded.scope,
        seeded.workspaceId,
        "Automation child",
        1_200,
      );
      const runId = randomUUID();
      upgradeDatabase
        .prepare(
          `
            UPDATE thread_principal_state
            SET woke_at = 2_000,
              wake_reason = 'automation',
              wake_acknowledged_at = NULL,
              automation_notice_kind = 'ran',
              automation_notice_run_id = ?,
              automation_notice_at = 2_000,
              automation_notice_result_thread_id = ?
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(
          runId,
          childThreadId,
          seeded.scope.tenantId,
          seeded.scope.principalId,
          seeded.anchorThreadId,
        );
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV8);

      const inventory = new ThreadInventoryService(
        new OverlayRepository(upgradeDatabase),
      );
      expect(
        inventory.getThread(seeded.scope, seeded.anchorThreadId).inventory,
      ).toMatchObject({
        wokeAt: null,
        wakeReason: null,
        wakeAcknowledgedAt: null,
        automationContextRunId: null,
      });
      expect(
        inventory.getThread(seeded.scope, childThreadId).inventory,
      ).toMatchObject({
        automationContextRunId: runId,
        automationContextSourceThreadId: seeded.anchorThreadId,
        automationContextAt: 2_000,
        automationContextOutcome: "triggered",
      });
      expect(() =>
        upgradeDatabase
          .prepare(
            `
              UPDATE thread_principal_state
              SET woke_at = 3_000, wake_reason = 'automation'
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .run(seeded.scope.tenantId, seeded.scope.principalId, childThreadId),
      ).toThrow();
    } finally {
      upgradeDatabase.close();
    }
  });

  it("refuses to migrate v5 duplicate scoped run ids", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "duplicate-run-id-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV5);
      const seeded = seedScopedPrincipal(
        upgradeDatabase,
        "Duplicate run identity",
      );
      const otherThreadId = insertLegacyThread(
        upgradeDatabase,
        seeded.scope,
        seeded.workspaceId,
        "Other run identity anchor",
        1_200,
      );
      const firstDefinitionId = insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );
      const secondDefinitionId = insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        otherThreadId,
      );
      const sharedRunId = randomUUID();
      insertLegacyRun(upgradeDatabase, seeded.scope, {
        automationId: firstDefinitionId,
        runId: sharedRunId,
        occurrenceKey: `manual:${randomUUID()}`,
        anchorThreadId: seeded.anchorThreadId,
      });
      insertLegacyRun(upgradeDatabase, seeded.scope, {
        automationId: secondDefinitionId,
        runId: sharedRunId,
        occurrenceKey: `manual:${randomUUID()}`,
        anchorThreadId: otherThreadId,
      });

      expect(() =>
        applyDatabaseMigrations(upgradeDatabase, automationMigrationsV6),
      ).toThrow();
      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT count(*) AS count
              FROM automation_runs
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(seeded.scope.tenantId, seeded.scope.principalId, sharedRunId),
      ).toEqual({ count: 2 });
      expect(
        upgradeDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
      ]);
    } finally {
      upgradeDatabase.close();
    }
  });

  it("refuses to migrate a v4 overlay with duplicate live thread automations", () => {
    const upgradeDatabase = openOverlayDatabase(
      path.join(directory, "duplicate-thread-automation-upgrade.sqlite"),
      { migrate: false },
    );
    try {
      applyDatabaseMigrations(upgradeDatabase, automationMigrationsV4);
      const seeded = seedScopedPrincipal(upgradeDatabase, "Duplicate upgrade");
      insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );
      insertLegacyDefinition(
        upgradeDatabase,
        seeded.scope,
        seeded.anchorThreadId,
      );

      expect(() =>
        applyDatabaseMigrations(upgradeDatabase, automationMigrationsV5),
      ).toThrow();
      expect(
        upgradeDatabase
          .prepare(
            `
              SELECT count(*) AS count
              FROM automation_definitions
              WHERE deleted_at IS NULL
            `,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        upgradeDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ]);
    } finally {
      upgradeDatabase.close();
    }
  });

  it("enforces exact schedule, prompt, anchor, and wake-reason constraints", () => {
    expect(() =>
      automations.createDefinition(scope, {
        ...definitionInput(anchorThreadId),
        schedule: {
          kind: "interval",
          anchorAt: 2_000,
          everySeconds: 299,
        },
      }),
    ).toThrow();
    expect(() =>
      automations.createDefinition(scope, {
        ...definitionInput(anchorThreadId),
        prompt: "x".repeat(65_537),
      }),
    ).toThrow();
    expect(() =>
      automations.createDefinition(scope, definitionInput(randomUUID())),
    ).toThrow();

    expect(() =>
      database
        .prepare(
          `
            UPDATE thread_principal_state
            SET woke_at = 2_000, wake_reason = 'automation',
              wake_acknowledged_at = NULL
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, anchorThreadId),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `
            UPDATE thread_principal_state
            SET wake_reason = 'future_unknown_reason'
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, anchorThreadId),
    ).toThrow();
  });

  it("keeps definitions scoped and applies optimistic edit, pause, enable, and delete semantics", () => {
    const created = automations.createDefinition(
      scope,
      definitionInput(anchorThreadId),
    );
    expect(created).toMatchObject({
      anchorThreadId,
      runMode: "same_thread",
      enabled: true,
      revision: 0,
      schedule: { kind: "date_time", runAt: 5_000 },
      nextRunAt: 5_000,
    });
    expect(automations.findDefinitionForThread(scope, anchorThreadId)).toEqual(
      created,
    );
    expect(() =>
      automations.createDefinition(scope, definitionInput(anchorThreadId)),
    ).toThrow();

    const updated = automations.updateDefinition(scope, created.id, {
      expectedRevision: 0,
      anchorThreadId,
      name: "Updated automation",
      prompt: "Run the updated bounded prompt",
      precheck: null,
      runMode: "clone",
      enabled: true,
      completedAt: null,
      schedule: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timeZone: "America/Chicago",
      },
      misfirePolicy: "skip",
      nextRunAt: 8_000,
      now: 2_000,
    });
    expect(updated).toMatchObject({
      revision: 1,
      name: "Updated automation",
      runMode: "clone",
      schedule: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timeZone: "America/Chicago",
      },
      misfirePolicy: "skip",
    });
    expect(() =>
      automations.updateDefinition(scope, created.id, {
        expectedRevision: 0,
        anchorThreadId,
        name: "Stale",
        prompt: "Stale",
        precheck: null,
        runMode: "same_thread",
        enabled: true,
        completedAt: null,
        schedule: { kind: "date_time", runAt: 9_000 },
        misfirePolicy: "coalesce",
        nextRunAt: 9_000,
        now: 2_100,
      }),
    ).toThrowError(DomainError);

    const paused = automations.pauseDefinition(scope, created.id, {
      expectedRevision: updated.revision,
      now: 2_200,
    });
    expect(paused).toMatchObject({
      enabled: false,
      nextRunAt: null,
      revision: 2,
    });
    const enabled = automations.enableDefinition(scope, created.id, {
      expectedRevision: paused.revision,
      nextRunAt: 10_000,
      now: 2_300,
    });
    expect(enabled).toMatchObject({
      enabled: true,
      nextRunAt: 10_000,
      revision: 3,
    });

    const foreignScope = {
      scope: {
        tenantId: "missing-tenant",
        principalId: "missing-principal",
      },
    };
    expect(() =>
      automations.getDefinition(foreignScope.scope, created.id),
    ).toThrowError(
      new DomainError("not_found", "The automation was not found."),
    );
    expect(
      automations.listDefinitions(scope, { limit: 100 }).map(({ id }) => id),
    ).toEqual([created.id]);
    expect(
      automations
        .listDefinitions(foreignScope.scope, { limit: 100 })
        .map(({ id }) => id),
    ).toEqual([]);

    const deleted = automations.softDeleteDefinition(scope, created.id, {
      expectedRevision: enabled.revision,
      now: 2_400,
    });
    expect(deleted).toMatchObject({
      enabled: false,
      deletedAt: 2_400,
      nextRunAt: null,
      revision: 4,
    });
    expect(automations.listDefinitions(scope, { limit: 100 })).toEqual([]);
    expect(
      automations.listDefinitions(scope, {
        includeDeleted: true,
        limit: 100,
      }),
    ).toHaveLength(1);
    expect(
      automations.findDefinitionForThread(scope, anchorThreadId),
    ).toBeUndefined();
    const replacement = automations.createDefinition(
      scope,
      definitionInput(anchorThreadId),
    );
    expect(replacement.id).not.toBe(created.id);
    expect(automations.findDefinitionForThread(scope, anchorThreadId)).toEqual(
      replacement,
    );
    expect(
      automations.listDefinitions(scope, {
        includeDeleted: true,
        limit: 100,
      }),
    ).toHaveLength(2);
  });

  it("claims each scheduled occurrence once, advances deadlines, reclaims leases, and bounds overlap", () => {
    const definition = automations.createDefinition(scope, {
      ...definitionInput(anchorThreadId),
      schedule: {
        kind: "interval",
        anchorAt: 2_000,
        everySeconds: 300,
      },
      nextRunAt: 2_000,
    });
    expect(automations.getNearestDeadline()).toBe(2_000);
    expect(automations.listDueDefinitions(1_999, 10)).toEqual([]);
    expect(automations.listDueDefinitions(2_000, 10)).toHaveLength(1);

    const claimInput = {
      runId: randomUUID(),
      occurrenceKey: "scheduled:2000",
      scheduledFor: 2_000,
      lastScheduledAt: 2_000,
      nextRunAt: 302_000,
      coalescedCount: 3,
      claimToken: "claim-1",
      leaseExpiresAt: 2_500,
      dispatchMutationId: randomUUID(),
      now: 2_000,
    };
    const claimed = automations.claimScheduledOccurrence(
      scope,
      definition.id,
      claimInput,
    );
    expect(claimed).toMatchObject({
      replayed: false,
      run: {
        state: "claimed",
        definitionRevision: 0,
        coalescedCount: 3,
        promptSnapshot: "Inspect the workspace",
        claimAttemptCount: 1,
      },
    });
    expect(automations.getDefinition(scope, definition.id)).toMatchObject({
      revision: 1,
      nextRunAt: 302_000,
      lastScheduledAt: 2_000,
    });
    expect(
      automations.claimScheduledOccurrence(scope, definition.id, claimInput),
    ).toMatchObject({ replayed: true, run: { id: claimInput.runId } });
    expect(() =>
      automations.createManualRun(scope, definition.id, {
        occurrenceKey: claimInput.occurrenceKey,
        scheduledFor: claimInput.scheduledFor,
        claimToken: "wrong-kind",
        leaseExpiresAt: 3_000,
        dispatchMutationId: claimInput.dispatchMutationId,
        now: 2_100,
      }),
    ).toThrowError(DomainError);
    expect(automations.getNearestDeadline()).toBe(2_500);
    expect(automations.listExpiredLeasedRuns(2_499, 10)).toEqual([]);
    expect(automations.listExpiredLeasedRuns(2_500, 10)).toEqual([claimed.run]);
    expect(() =>
      automations.createManualRun(scope, definition.id, {
        occurrenceKey: `manual:${randomUUID()}`,
        scheduledFor: 2_100,
        claimToken: "manual-claim",
        leaseExpiresAt: 2_600,
        dispatchMutationId: randomUUID(),
        now: 2_100,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      automations.reclaimExpiredRun(scope, definition.id, claimed.run.id, {
        claimToken: "claim-2",
        leaseExpiresAt: 3_000,
        now: 2_499,
      }),
    ).toThrowError(DomainError);

    const reclaimed = automations.reclaimExpiredRun(
      scope,
      definition.id,
      claimed.run.id,
      {
        claimToken: "claim-2",
        leaseExpiresAt: 3_500,
        now: 2_500,
      },
    );
    expect(reclaimed).toMatchObject({
      claimToken: "claim-2",
      leaseExpiresAt: 3_500,
      claimAttemptCount: 2,
    });
    expect(automations.getNearestDeadline()).toBe(3_500);
    const dispatching = automations.updateRunState(
      scope,
      definition.id,
      claimed.run.id,
      {
        expectedState: "claimed",
        state: "dispatching",
        claimToken: "claim-2",
        retainPromptSnapshot: true,
        now: 2_600,
      },
    );
    expect(dispatching).toMatchObject({
      state: "dispatching",
      promptSnapshot: "Inspect the workspace",
      startedAt: 2_600,
    });
    const running = automations.updateRunState(
      scope,
      definition.id,
      claimed.run.id,
      {
        expectedState: "dispatching",
        state: "running",
        claimToken: "claim-2",
        now: 2_700,
      },
    );
    expect(running).toMatchObject({
      state: "running",
      claimToken: null,
      promptSnapshot: null,
      acceptedAt: 2_700,
    });
    expect(automations.getNearestDeadline()).toBeNull();
    expect(automations.listDueDefinitions(400_000, 10)).toEqual([]);
    expect(automations.listNonterminalRuns(10)).toEqual([running]);
    const completed = automations.updateRunState(
      scope,
      definition.id,
      claimed.run.id,
      {
        expectedState: "running",
        state: "completed",
        now: 2_800,
      },
    );
    expect(completed).toMatchObject({
      state: "completed",
      finishedAt: 2_800,
    });
    expect(automations.getNearestDeadline()).toBe(302_000);
    expect(automations.listDueDefinitions(400_000, 10)).toHaveLength(1);
    expect(automations.listNonterminalRuns(10)).toEqual([]);

    const manual = automations.createManualRun(scope, definition.id, {
      occurrenceKey: "manual:first",
      scheduledFor: 2_900,
      claimToken: "manual-claim",
      leaseExpiresAt: 3_900,
      dispatchMutationId: randomUUID(),
      now: 2_900,
    });
    expect(manual.run.occurrenceKind).toBe("manual");
    expect(() =>
      automations.softDeleteDefinition(scope, definition.id, {
        expectedRevision: 1,
        now: 3_000,
      }),
    ).toThrowError(DomainError);
    expect(automations.listRuns(scope, definition.id, { limit: 1 })).toEqual([
      manual.run,
    ]);
    expect(() =>
      automations.listRuns(scope, definition.id, { limit: 102 }),
    ).toThrowError(DomainError);
    expect(() =>
      automations.updateDefinition(scope, definition.id, {
        expectedRevision: 1,
        anchorThreadId,
        name: "Must not edit in flight",
        prompt: "Do not replace a frozen run.",
        precheck: null,
        runMode: "same_thread",
        enabled: true,
        completedAt: null,
        schedule: { kind: "date_time", runAt: 9_000 },
        misfirePolicy: "coalesce",
        nextRunAt: 9_000,
        now: 3_100,
      }),
    ).toThrowError(DomainError);

    const dateTimeAnchorThreadId = createThread("Date & time anchor", 4_900);
    const dateTime = automations.createDefinition(
      scope,
      definitionInput(dateTimeAnchorThreadId),
    );
    const dateRun = automations.claimScheduledOccurrence(scope, dateTime.id, {
      occurrenceKey: "scheduled:5000",
      scheduledFor: 5_000,
      lastScheduledAt: 5_000,
      nextRunAt: null,
      coalescedCount: 0,
      claimToken: "date-claim",
      leaseExpiresAt: 6_000,
      dispatchMutationId: randomUUID(),
      now: 5_000,
    }).run;
    automations.updateRunState(scope, dateTime.id, dateRun.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: "date-claim",
      retainPromptSnapshot: true,
      now: 5_050,
    });
    automations.updateRunState(scope, dateTime.id, dateRun.id, {
      expectedState: "dispatching",
      state: "completed",
      claimToken: "date-claim",
      now: 5_100,
      completeDefinition: true,
    });
    expect(automations.getDefinition(scope, dateTime.id)).toMatchObject({
      enabled: false,
      completedAt: null,
      deletedAt: 5_100,
      nextRunAt: null,
      revision: 2,
    });
    expect(
      automations.findDefinitionForThread(scope, dateTimeAnchorThreadId),
    ).toBeUndefined();
    expect(
      inventory.getThread(scope, dateTimeAnchorThreadId).inventory,
    ).toMatchObject({
      automationContextOutcome: "triggered",
      automationContextRunId: dateRun.id,
      automationContextAt: 5_100,
      automationContextSourceThreadId: dateTimeAnchorThreadId,
      automationContextDiagnostic: null,
    });

    const uncertainAnchorThreadId = createThread(
      "Uncertain Date & time anchor",
      5_150,
    );
    const uncertainDate = automations.createDefinition(
      scope,
      definitionInput(uncertainAnchorThreadId),
    );
    const uncertainDateRun = automations.claimScheduledOccurrence(
      scope,
      uncertainDate.id,
      {
        occurrenceKey: "scheduled:uncertain-5000",
        scheduledFor: 5_000,
        lastScheduledAt: 5_000,
        nextRunAt: null,
        coalescedCount: 0,
        claimToken: "uncertain-date-claim",
        leaseExpiresAt: 6_000,
        dispatchMutationId: randomUUID(),
        now: 5_000,
      },
    ).run;
    automations.updateRunState(scope, uncertainDate.id, uncertainDateRun.id, {
      expectedState: "claimed",
      state: "dispatching",
      claimToken: "uncertain-date-claim",
      retainPromptSnapshot: true,
      now: 5_050,
    });
    automations.markRunUncertainAndPause(
      scope,
      uncertainDate.id,
      uncertainDateRun.id,
      {
        expectedState: "dispatching",
        claimToken: "uncertain-date-claim",
        errorCode: "automation_dispatch_uncertain",
        errorDiagnostic: "Acceptance could not be proven.",
        now: 5_100,
      },
    );
    const pausedUncertain = automations.getDefinition(scope, uncertainDate.id);
    expect(() =>
      automations.enableDefinition(scope, uncertainDate.id, {
        expectedRevision: pausedUncertain.revision,
        nextRunAt: 7_000,
        now: 5_150,
      }),
    ).toThrowError(DomainError);
    automations.resolveUncertainRun(
      scope,
      uncertainDate.id,
      uncertainDateRun.id,
      5_200,
    );
    expect(automations.getDefinition(scope, uncertainDate.id)).toMatchObject({
      enabled: false,
      completedAt: null,
      deletedAt: 5_200,
      nextRunAt: null,
    });
    expect(
      automations.findDefinitionForThread(scope, uncertainAnchorThreadId),
    ).toBeUndefined();
    expect(
      inventory.getThread(scope, uncertainAnchorThreadId).inventory,
    ).toMatchObject({
      automationContextOutcome: "failed",
      automationContextRunId: uncertainDateRun.id,
      automationContextAt: 5_200,
      automationContextSourceThreadId: uncertainAnchorThreadId,
      automationContextDiagnostic: "The uncertain run was manually resolved.",
    });
  });

  it("binds one idempotent child and backend checkpoint to clone runs only", () => {
    bindings.bindDiscoveredConversation(scope, anchorThreadId, {
      backendConversationId: "clone-anchor",
      now: 1_900,
    });
    const cloneDefinition = automations.createDefinition(scope, {
      ...definitionInput(anchorThreadId),
      runMode: "clone",
    });
    const cloneRun = automations.createManualRun(scope, cloneDefinition.id, {
      occurrenceKey: "manual:clone",
      scheduledFor: 2_000,
      claimToken: "clone-claim",
      leaseExpiresAt: 3_000,
      dispatchMutationId: randomUUID(),
      now: 2_000,
    }).run;
    const checkpoints = new BackendCheckpointRepository(database);
    const checkpoint = checkpoints.create(scope, anchorThreadId, {
      id: "checkpoint-1",
      applicationTurnId: "clone-source-turn",
      opaqueReference: JSON.stringify({ leaf: "stable-source" }),
      now: 2_050,
    });
    const childThreadId = createThread("Automation clone child", 2_100);
    const lineage = new ThreadLineageRepository(database);
    lineage.prepareOrigin(scope, {
      childThreadId,
      sourceThreadId: anchorThreadId,
      sourceTurnId: "clone-source-turn",
      sourceTurnCompletedAt: null,
      sourceCheckpointId: checkpoint.id,
      originKind: "automation_fork",
      initiatingPrincipalId: scope.principalId,
      sourceAutomationId: cloneDefinition.id,
      sourceAutomationRunId: cloneRun.id,
      branchMethod: "provider_native",
      creationOperationId: cloneRun.dispatchMutationId,
      now: 2_110,
    });
    const creation = new ConversationCreationRepository(database);
    creation.prepare(scope, childThreadId, {
      attemptId: "clone-attempt",
      mutationId: cloneRun.dispatchMutationId,
      expectedThreadRevision: 0,
      creationKind: "fork",
      forkChildIdentity: "application_reserved",
      forkCreationRecovery: "idempotent",
      sourceKind: "automation",
      sourceAutomationId: cloneDefinition.id,
      sourceAutomationRunId: cloneRun.id,
      initialInputText: null,
      initialAttachmentIds: [],
      backendCreationCorrelation: "clone-correlation",
      now: 2_120,
    });
    creation.markExternalCallStarted(
      scope,
      childThreadId,
      "clone-attempt",
      2_130,
    );
    creation.recordConversationIdentified(
      scope,
      childThreadId,
      "clone-attempt",
      {
        backendConversationId: "clone-child",
        opaqueBindingDetail: "clone-child-detail",
        now: 2_140,
      },
    );
    bindings.bindCreatedConversation(scope, childThreadId, {
      attemptId: "clone-attempt",
      backendConversationId: "clone-child",
      acceptedAt: 2_150,
    });
    const bound = automations.bindForkChild(
      scope,
      cloneDefinition.id,
      cloneRun.id,
      {
        childThreadId,
        now: 2_200,
      },
    );
    expect(bound).toMatchObject({
      anchorThreadId,
      childThreadId,
    });
    expect(
      automations.bindForkChild(scope, cloneDefinition.id, cloneRun.id, {
        childThreadId,
        now: 2_300,
      }),
    ).toEqual(bound);
    const otherChildThreadId = createThread("Wrong clone child", 2_400);
    bindings.bindDiscoveredConversation(scope, otherChildThreadId, {
      backendConversationId: "other-clone-child",
      now: 2_450,
    });
    expect(() =>
      automations.bindForkChild(scope, cloneDefinition.id, cloneRun.id, {
        childThreadId: otherChildThreadId,
        now: 2_500,
      }),
    ).toThrowError(DomainError);

    const otherCloneAnchorThreadId = createThread("Other clone anchor", 2_525);
    const otherCloneDefinition = automations.createDefinition(scope, {
      ...definitionInput(otherCloneAnchorThreadId),
      runMode: "clone",
    });
    const otherCloneRun = automations.createManualRun(
      scope,
      otherCloneDefinition.id,
      {
        occurrenceKey: "manual:other-clone",
        scheduledFor: 2_550,
        claimToken: "other-clone-claim",
        leaseExpiresAt: 3_550,
        dispatchMutationId: randomUUID(),
        now: 2_550,
      },
    ).run;
    expect(() =>
      automations.bindForkChild(
        scope,
        otherCloneDefinition.id,
        otherCloneRun.id,
        {
          childThreadId,
          now: 2_575,
        },
      ),
    ).toThrow();

    const sameModeAnchorThreadId = createThread(
      "Same-thread lineage anchor",
      2_590,
    );
    const sameThreadDefinition = automations.createDefinition(
      scope,
      definitionInput(sameModeAnchorThreadId),
    );
    const sameThreadRun = automations.createManualRun(
      scope,
      sameThreadDefinition.id,
      {
        occurrenceKey: "manual:same",
        scheduledFor: 2_600,
        claimToken: "same-claim",
        leaseExpiresAt: 3_600,
        dispatchMutationId: randomUUID(),
        now: 2_600,
      },
    ).run;
    expect(() =>
      automations.bindForkChild(
        scope,
        sameThreadDefinition.id,
        sameThreadRun.id,
        {
          childThreadId: otherChildThreadId,
          now: 2_700,
        },
      ),
    ).toThrowError(DomainError);
  });
});

function definitionInput(
  anchorThreadId: string,
): CreateAutomationDefinitionInput {
  return {
    anchorThreadId,
    name: "Review automation",
    prompt: "Inspect the workspace",
    precheck: null,
    runMode: "same_thread",
    enabled: true,
    schedule: { kind: "date_time", runAt: 5_000 },
    misfirePolicy: "coalesce",
    nextRunAt: 5_000,
    now: 1_500,
  };
}

function seedScopedPrincipal(
  database: Database.Database,
  label: string,
): { scope: RequestScope; anchorThreadId: string; workspaceId: string } {
  const scope = {
    tenantId: randomUUID(),
    principalId: randomUUID(),
  };
  const environmentId = randomUUID();
  database
    .prepare("INSERT INTO tenants(id, created_at) VALUES (?, 0)")
    .run(scope.tenantId);
  database
    .prepare(
      `
        INSERT INTO principals(tenant_id, id, kind, created_at)
        VALUES (?, ?, 'local_human', 0)
      `,
    )
    .run(scope.tenantId, scope.principalId);
  database
    .prepare(
      `
        INSERT INTO execution_environments(
          tenant_id, owner_principal_id, id, kind, label, availability,
          diagnostic_code, revision, created_at, updated_at
        )
        VALUES (?, ?, ?, 'local', ?, 'available', NULL, 0, 0, 0)
      `,
    )
    .run(scope.tenantId, scope.principalId, environmentId, label);
  database
    .prepare(
      `
        INSERT INTO principal_generations(
          tenant_id, principal_id, inventory_generation
        )
        VALUES (?, ?, 0)
      `,
    )
    .run(scope.tenantId, scope.principalId);
  const workspaceId = insertLegacyWorkspace(
    database,
    scope,
    environmentId,
    `/tmp/${scope.tenantId}`,
    label,
    1_000,
  );
  return {
    scope,
    workspaceId,
    anchorThreadId: insertLegacyThread(
      database,
      scope,
      workspaceId,
      `${label} anchor`,
      1_100,
    ),
  };
}

function seedLegacyThread(
  database: Database.Database,
  input: {
    label: string;
    canonicalPath: string;
    draftText: string;
    draftRevision: number;
    stashText?: string;
  },
): { scope: RequestScope; threadId: string } {
  const scope = new SingleUserIdentityProvider(database).getScope();
  const environment = database
    .prepare(
      `
        SELECT id
        FROM execution_environments
        WHERE tenant_id = ? AND owner_principal_id = ?
      `,
    )
    .get(scope.tenantId, scope.principalId) as { id: string };
  const workspaceId = insertLegacyWorkspace(
    database,
    scope,
    environment.id,
    input.canonicalPath,
    input.label,
    100,
  );
  const threadId = insertLegacyThread(
    database,
    scope,
    workspaceId,
    "New thread",
    200,
  );
  database
    .prepare(
      `
        UPDATE thread_drafts
        SET text = ?, updated_at = 400, revision = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `,
    )
    .run(
      input.draftText,
      input.draftRevision,
      scope.tenantId,
      scope.principalId,
      threadId,
    );
  if (input.stashText) {
    database
      .prepare(
        `
          INSERT INTO prompt_stashes(
            tenant_id, principal_id, thread_id, id, text, created_at
          )
          VALUES (?, ?, ?, ?, ?, 400)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        randomUUID(),
        input.stashText,
      );
  }
  return { scope, threadId };
}

function insertLegacyWorkspace(
  database: Database.Database,
  scope: RequestScope,
  environmentId: string,
  canonicalPath: string,
  label: string,
  now: number,
): string {
  const workspaceId = randomUUID();
  database
    .prepare(
      `
        INSERT INTO workspaces(
          tenant_id, owner_principal_id, environment_id, id, canonical_path,
          display_name, availability, trust_state, revision, last_opened_at,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'available', 'trusted', 0, ?, ?, ?)
      `,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      environmentId,
      workspaceId,
      canonicalPath,
      label,
      now,
      now,
      now,
    );
  return workspaceId;
}

function insertLegacyThread(
  database: Database.Database,
  scope: RequestScope,
  workspaceId: string,
  title: string,
  now: number,
): string {
  const environment = database
    .prepare(
      `
        SELECT environment_id AS environmentId
        FROM workspaces
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
    )
    .get(scope.tenantId, scope.principalId, workspaceId) as {
    environmentId: string;
  };
  const threadId = randomUUID();
  database.transaction(() => {
    database
      .prepare(
        `
          INSERT INTO application_threads(
            tenant_id, id, owner_principal_id, environment_id, workspace_id,
            backing_state, reserved_native_session_id, native_session_path,
            title, tool_mode, availability, reconciliation_at,
            last_activity_at, materialization_attempt_id, attempt_phase,
            attempt_diagnostic_code, uncertain_at, revision, created_at,
            updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, 'full', 'available', NULL,
            ?, NULL, NULL, NULL, NULL, 0, ?, ?
          )
        `,
      )
      .run(
        scope.tenantId,
        threadId,
        scope.principalId,
        environment.environmentId,
        workspaceId,
        title,
        now,
        now,
        now,
      );
    database
      .prepare(
        `
          INSERT INTO thread_principal_state(
            tenant_id, principal_id, thread_id, inventory_state,
            state_changed_at, snoozed_at, snoozed_until, woke_at, wake_reason,
            wake_acknowledged_at, inventory_revision
          )
          VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL, NULL, 0)
        `,
      )
      .run(scope.tenantId, scope.principalId, threadId, now);
    database
      .prepare(
        `
          INSERT INTO thread_drafts(
            tenant_id, principal_id, thread_id, text, updated_at, revision
          )
          VALUES (?, ?, ?, '', ?, 0)
        `,
      )
      .run(scope.tenantId, scope.principalId, threadId, now);
    database
      .prepare(
        `
          INSERT INTO thread_start_preferences(
            tenant_id, thread_id, model_provider, model_id, thinking_level,
            revision
          )
          VALUES (?, ?, NULL, NULL, NULL, 0)
        `,
      )
      .run(scope.tenantId, threadId);
  })();
  return threadId;
}

function insertLegacyDefinition(
  database: Database.Database,
  scope: RequestScope,
  anchorThreadId: string,
): string {
  const automationId = randomUUID();
  database
    .prepare(
      `
        INSERT INTO automation_definitions(
          tenant_id, owner_principal_id, id, anchor_thread_id, name, prompt,
          run_mode, enabled, completed_at, deleted_at, revision, schedule_kind,
          run_at, interval_anchor_at, interval_seconds, cron_expression,
          time_zone, misfire_policy, next_run_at, last_scheduled_at, created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?, 'Review automation', 'Inspect the workspace',
          'same_thread', 1, NULL, NULL, 0, 'date_time', 5000, NULL, NULL,
          NULL, NULL, 'coalesce', 5000, NULL, 1500, 1500
        )
      `,
    )
    .run(scope.tenantId, scope.principalId, automationId, anchorThreadId);
  return automationId;
}

function insertLegacyRun(
  database: Database.Database,
  scope: RequestScope,
  input: {
    automationId: string;
    runId: string;
    occurrenceKey: string;
    anchorThreadId: string;
  },
): void {
  database
    .prepare(
      `
        INSERT INTO automation_runs(
          tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
          scheduled_for, occurrence_key, definition_revision, coalesced_count,
          run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
          prompt_snapshot, dispatch_mutation_id, anchor_thread_id,
          child_thread_id, source_leaf_entry_id, lineage_kind, lineage_metadata,
          pi_user_entry_id, error_code, error_diagnostic, claimed_at,
          started_at, accepted_at, finished_at, created_at, updated_at
        )
        VALUES (
          ?, ?, ?, ?, 'manual', 2000, ?, 0, 0, 'same_thread', 'claimed',
          ?, 3000, 1, 'Inspect the workspace', ?, ?, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, 2000, NULL, NULL, NULL, 2000, 2000
        )
      `,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      input.automationId,
      input.runId,
      input.occurrenceKey,
      randomUUID(),
      randomUUID(),
      input.anchorThreadId,
    );
}
