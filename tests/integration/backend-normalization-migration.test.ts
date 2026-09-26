import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { ABSENT_MODULE_CONFIGURATION_FINGERPRINT } from "../../src/server/config/configuration-fingerprint.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
  migrateDatabase,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { ThreadForkService } from "../../src/server/conversations/thread-fork-service.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

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
      id: "configured-pi",
      kind: "pi",
      label: "Configured Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "configured-local-sdk",
      kind: "pi_sdk",
      label: "Configured Local SDK",
      backendInstanceId: "configured-pi",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "configured-local-sdk",
});

const codexDefaultConfiguration = parseResolvedBackendConfiguration({
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
      id: "configured-pi",
      kind: "pi",
      label: "Configured Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
    {
      id: "configured-codex",
      kind: "codex_app_server",
      label: "Configured Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "configured-local-sdk",
      kind: "pi_sdk",
      label: "Configured Local SDK",
      backendInstanceId: "configured-pi",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
    {
      id: "configured-codex-local",
      kind: "codex_app_server",
      label: "Configured Codex Local",
      backendInstanceId: "configured-codex",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "configured-codex-local",
});

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

function version(database: Database.Database): number {
  return (
    database
      .prepare("SELECT max(version) AS version FROM schema_migrations")
      .get() as { version: number }
  ).version;
}

function applyCutover(database: Database.Database, appliedAt = 90_000): void {
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt,
  });
}

function populateSchema13(database: Database.Database) {
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/schema-14-rehearsal",
      displayName: "Schema 14 rehearsal",
      availability: "available",
      trustState: "trusted",
    },
    1,
  );
  const thread = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Preserved thread" },
    2,
  );
  applyCutover(database, 3);
  const profile = database
    .prepare(
      `
        SELECT id
        FROM agent_connection_profiles
        WHERE tenant_id = ? AND owner_principal_id = ?
      `,
    )
    .get(scope.tenantId, scope.principalId) as { readonly id: string };
  database
    .prepare(
      `
        INSERT INTO agent_connection_setting_preferences(
          tenant_id, owner_principal_id, connection_profile_id, setting_id,
          value, revision, created_at, updated_at
        )
        VALUES (?, ?, ?, 'model', 'preserved-model', 2, 4, 4)
      `,
    )
    .run(scope.tenantId, scope.principalId, profile.id);
  return { scope, profileId: profile.id, threadId: thread.thread.id };
}

function normalizedRowCounts(database: Database.Database) {
  return Object.fromEntries(
    [
      "agent_backend_instances",
      "agent_connection_profiles",
      "agent_connection_setting_preferences",
      "application_threads",
      "conversation_bindings",
      "pi_binding_details",
    ].map((table) => [
      table,
      (
        database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count,
    ]),
  );
}

describe("inactive backend-normalization migration", () => {
  it("imports desired Pi configuration using the compiled release after the historical cutover seed", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const futureConfiguration = {
        ...configuration,
        backends: configuration.backends.map((backend) => ({
          ...backend,
          protocolRelease: "0.84.0",
        })),
      };

      applyBackendNormalizationMigration(database, {
        configuration: futureConfiguration,
        quiescentCutoverConfirmed: true,
        appliedAt: 10,
      });
      expect(
        database
          .prepare(
            `SELECT protocol_release AS protocolRelease
             FROM agent_backend_instances
             WHERE tenant_id = ? AND id = 'configured-pi'`,
          )
          .get(scope.tenantId),
      ).toEqual({ protocolRelease: "0.83.0" });

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      importLegacyDatabaseConfigurationFixture(database, { configuration: futureConfiguration, localWorkspaceRoots: ["/tmp"], sourceLabel: "compiled-release-migration" }, 20);
      expect(
        database
          .prepare(
            `SELECT protocol_release AS protocolRelease,
                    configuration_revision AS configurationRevision
             FROM agent_backend_instances
             WHERE tenant_id = ? AND id = 'configured-pi'`,
          )
          .get(scope.tenantId),
      ).toEqual({
        protocolRelease: configuration.backends[0]!.protocolRelease,
        configurationRevision: 1,
      });
    } finally {
      database.close();
    }
  });

  it("upgrades v20 Codex bindings to scoped versioned native evidence", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/codex-c4-migration",
        displayName: "Codex C4 migration",
        availability: "available",
        trustState: "trusted",
      });
      applyBackendNormalizationMigration(database, {
        configuration: codexDefaultConfiguration,
        quiescentCutoverConfirmed: true,
        appliedAt: 10,
      });
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version <= 20,
        ),
      );
      database
        .prepare(
          `
            INSERT INTO agent_backend_instances(
              tenant_id, id, kind, label, enabled, configuration_revision,
              configuration_fingerprint, protocol_release, created_at, updated_at
            )
            VALUES (?, 'configured-codex', 'codex_app_server',
              'Configured Codex', 1, 0, ?, 'future-pin', 11, 11)
          `,
        )
        .run(scope.tenantId, ABSENT_MODULE_CONFIGURATION_FINGERPRINT);
      database
        .prepare(
          `
            INSERT INTO agent_connection_profiles(
              tenant_id, owner_principal_id, id, template_id,
              backend_instance_id, backend_kind, execution_environment_id,
              kind, label, enabled, configuration_revision,
              configuration_fingerprint, created_at, updated_at
            )
            VALUES (?, ?, ?, 'configured-codex-local', 'configured-codex',
              'codex_app_server', ?, 'codex_app_server',
              'Configured Codex Local', 1, 0, ?, 11, 11)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          deriveConnectionProfileId(
            scope.tenantId,
            scope.principalId,
            "configured-codex-local",
          ),
          environment.id,
          ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
        );
      const profile = database
        .prepare(
          `
            SELECT id
            FROM agent_connection_profiles
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND backend_instance_id = 'configured-codex'
          `,
        )
        .get(scope.tenantId, scope.principalId) as { readonly id: string };
      const bindings = new ConversationBindingRepository(database);
      const imported = bindings.createUnboundThread(scope, {
        id: "codex-v20-import",
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Imported before C4",
        now: 20,
      });
      bindings.bindDiscoveredConversation(scope, imported.id, {
        backendConversationId: "native-codex-v20",
        now: 21,
      });

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(version(database)).toBe(latestBackendNormalizedVersion);
      expect(
        database
          .prepare(
            `
              SELECT opaque_binding_detail AS opaqueBindingDetail
              FROM codex_binding_details
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, imported.id),
      ).toEqual({
        opaqueBindingDetail:
          '{"version":2,"threadId":"native-codex-v20","sessionId":null,"correlationAncestorThreadIds":[],"nativeAncestry":null}',
      });
      expect(
        database
          .prepare("PRAGMA table_info(conversation_creation_attempts)")
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(
        expect.arrayContaining([
          "fork_child_identity",
          "fork_creation_recovery",
          "fork_uncertainty_kind",
        ]),
      );
      expect(() =>
        database
          .prepare(
            `
              UPDATE codex_binding_details
              SET opaque_binding_detail = '{"version":1,"threadId":"old"}'
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ?
            `,
          )
          .run(scope.tenantId, scope.principalId, imported.id),
      ).toThrow();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("is not part of normal production migration yet", () => {
    const database = new Database(":memory:");
    try {
      migrateDatabase(database);
      expect(version(database)).toBe(9);
      expect(
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_bindings'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("keeps the applied schema-10 migration immutable", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      applyCutover(database);
      expect(
        database
          .prepare(
            `
              SELECT name, checksum
              FROM schema_migrations
              WHERE version = 10
            `,
          )
          .get(),
      ).toEqual({
        name: "backend_normalization_foundation",
        checksum:
          "8ab7e6fefeab5da451abda77edc16a22b6f8ce1eb654677ab5f17c08141f635b",
      });
    } finally {
      database.close();
    }
  });

  it("rebuilds a populated schema 13 exactly and enforces the expanded identities", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const populated = populateSchema13(database);
      const before = normalizedRowCounts(database);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(version(database)).toBe(latestBackendNormalizedVersion);
      expect(normalizedRowCounts(database)).toEqual(before);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database
          .prepare(
            `
              SELECT backend_kind AS backendKind, kind
              FROM agent_connection_profiles
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(
            populated.scope.tenantId,
            populated.scope.principalId,
            populated.profileId,
          ),
      ).toEqual({ backendKind: "pi", kind: "pi_sdk" });
      expect(
        database
          .prepare(
            `
              SELECT value, revision
              FROM agent_connection_setting_preferences
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND connection_profile_id = ?
            `,
          )
          .get(
            populated.scope.tenantId,
            populated.scope.principalId,
            populated.profileId,
          ),
      ).toEqual({ value: "preserved-model", revision: 2 });
      expect(
        database
          .prepare(
            `
              SELECT configuration_fingerprint AS configurationFingerprint
              FROM agent_backend_instances
              WHERE tenant_id = ? AND id = 'configured-pi'
            `,
          )
          .get(populated.scope.tenantId),
      ).toEqual({
        configurationFingerprint: ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
      });
      expect(
        database
          .prepare(
            `
              SELECT configuration_fingerprint AS configurationFingerprint
              FROM agent_connection_profiles
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(
            populated.scope.tenantId,
            populated.scope.principalId,
            populated.profileId,
          ),
      ).toEqual({
        configurationFingerprint: ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
      });
    } finally {
      database.close();
    }
  });

  it("upgrades durable skill payloads and admits empty text only with a skill", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const populated = populateSchema13(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version <= 36,
        ),
      );

      database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = 'preserved first input',
              selected_skill_id = 'preserved-skill',
              updated_at = 100, revision = revision + 2
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(
          populated.scope.tenantId,
          populated.scope.principalId,
          populated.threadId,
        );
      database
        .prepare(
          `
            INSERT INTO conversation_creation_attempts(
              tenant_id, owner_principal_id, application_thread_id,
              attempt_id, mutation_id, backend_instance_id,
              connection_profile_id, execution_environment_id,
              creation_kind, source_kind, initial_input_text,
              initial_skill_id, consumed_draft_revision,
              backend_creation_correlation, phase, prepared_at
            )
            SELECT tenant_id, owner_principal_id, id,
              'preserved-attempt', 'preserved-first-input',
              backend_instance_id, connection_profile_id, environment_id,
              'first_input', 'composer', 'preserved first input',
              'preserved-skill', 2, 'preserved-correlation', 'prepared', 101
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          populated.scope.tenantId,
          populated.scope.principalId,
          populated.threadId,
        );
      database
        .prepare(
          `
            UPDATE application_threads
            SET backing_state = 'creating', revision = revision + 1,
              updated_at = 101
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          populated.scope.tenantId,
          populated.scope.principalId,
          populated.threadId,
        );
      database
        .prepare(
          `
            INSERT INTO queued_inputs(
              tenant_id, owner_principal_id, id, application_thread_id,
              sequence, mutation_id, text, selected_skill_id,
              state, created_at
            ) VALUES (?, ?, 'preserved-queue', ?, 1, 'preserved-queue-mutation',
              'preserved queued input', 'preserved-skill', 'pending', 102)
          `,
        )
        .run(
          populated.scope.tenantId,
          populated.scope.principalId,
          populated.threadId,
        );

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(version(database)).toBe(latestBackendNormalizedVersion);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database
          .prepare(
            `
              SELECT initial_input_text AS text, initial_skill_id AS skill
              FROM conversation_creation_attempts
              WHERE mutation_id = 'preserved-first-input'
            `,
          )
          .get(),
      ).toEqual({ text: "preserved first input", skill: "preserved-skill" });
      expect(
        database
          .prepare(
            `
              SELECT text, selected_skill_id AS skill
              FROM queued_inputs WHERE id = 'preserved-queue'
            `,
          )
          .get(),
      ).toEqual({ text: "preserved queued input", skill: "preserved-skill" });

      database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET initial_input_text = ''
            WHERE mutation_id = 'preserved-first-input'
          `,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `
              UPDATE conversation_creation_attempts
              SET initial_skill_id = NULL
              WHERE mutation_id = 'preserved-first-input'
            `,
          )
          .run(),
      ).toThrow();

      database
        .prepare(
          "UPDATE queued_inputs SET text = '' WHERE id = 'preserved-queue'",
        )
        .run();
      expect(() =>
        database
          .prepare(
            "UPDATE queued_inputs SET selected_skill_id = NULL WHERE id = 'preserved-queue'",
          )
          .run(),
      ).toThrow();

      expect(
        database
          .prepare(
            `
              SELECT name FROM sqlite_master
              WHERE type = 'trigger'
                AND name IN (
                  'conversation_creation_attempts_fork_contract_insert',
                  'conversation_creation_attempts_fork_contract_update',
                  'queued_inputs_trigger_provenance_insert',
                  'queued_inputs_trigger_provenance_update',
                  'queued_inputs_caller_provenance_update',
                  'queued_inputs_automation_source_insert',
                  'queued_inputs_principal_client_provenance_insert',
                  'queued_inputs_retry_provenance_parent_update',
                  'automation_runs_queued_provenance_delete',
                  'automation_runs_queued_provenance_update'
                )
              ORDER BY name
            `,
          )
          .all(),
      ).toHaveLength(10);
    } finally {
      database.close();
    }
  });

  it("rolls back migration 14 table swaps and restores foreign-key enforcement", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      populateSchema13(database);
      const before = normalizedRowCounts(database);

      expect(() =>
        applyDatabaseMigrations(database, backendNormalizedMigrations, {
          verifyBeforeCommit(_database, migration) {
            if (migration.version === 14) {
              throw new Error("injected migration 14 verification failure");
            }
          },
        }),
      ).toThrow("injected migration 14 verification failure");

      expect(version(database)).toBe(13);
      expect(normalizedRowCounts(database)).toEqual(before);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database.pragma("table_info('agent_connection_profiles')") as Array<{
          readonly name: string;
        }>,
      ).not.toContainEqual(expect.objectContaining({ name: "backend_kind" }));
    } finally {
      database.close();
    }
  });

  it("backfills constrained fingerprints when upgrading schema 14", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      populateSchema13(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version <= 14,
        ),
      );
      expect(version(database)).toBe(14);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(version(database)).toBe(latestBackendNormalizedVersion);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database
          .prepare(
            `
              SELECT DISTINCT configuration_fingerprint AS fingerprint
              FROM agent_backend_instances
            `,
          )
          .all(),
      ).toEqual([{ fingerprint: ABSENT_MODULE_CONFIGURATION_FINGERPRINT }]);
      expect(
        database
          .prepare(
            `
              SELECT DISTINCT configuration_fingerprint AS fingerprint
              FROM agent_connection_profiles
            `,
          )
          .all(),
      ).toEqual([{ fingerprint: ABSENT_MODULE_CONFIGURATION_FINGERPRINT }]);
      for (const table of [
        "agent_backend_instances",
        "agent_connection_profiles",
      ]) {
        expect(() =>
          database
            .prepare(
              `
                UPDATE ${table}
                SET configuration_fingerprint = ?
              `,
            )
            .run("A".repeat(64)),
        ).toThrow();
        expect(() =>
          database
            .prepare(
              `
                UPDATE ${table}
                SET configuration_fingerprint = ?
              `,
            )
            .run("a".repeat(63)),
        ).toThrow();
      }
      expect(database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back migration 15 column additions atomically", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      populateSchema13(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version <= 14,
        ),
      );

      expect(() =>
        applyDatabaseMigrations(database, backendNormalizedMigrations, {
          verifyBeforeCommit(_database, migration) {
            if (migration.version === 15) {
              throw new Error("injected migration 15 verification failure");
            }
          },
        }),
      ).toThrow("injected migration 15 verification failure");

      expect(version(database)).toBe(14);
      for (const table of [
        "agent_backend_instances",
        "agent_connection_profiles",
      ]) {
        expect(
          database.pragma(`table_info('${table}')`) as Array<{
            readonly name: string;
          }>,
        ).not.toContainEqual(
          expect.objectContaining({ name: "configuration_fingerprint" }),
        );
      }
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades every deployed migration prefix through the final schema", () => {
    for (let prefix = 1; prefix <= deployedMigrations.length; prefix += 1) {
      const database = new Database(":memory:");
      try {
        applyDatabaseMigrations(database, deployedMigrations.slice(0, prefix));
        applyDatabaseMigrations(database, deployedMigrations);
        applyCutover(database);
        expect(version(database)).toBe(13);
        expect(database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        database.close();
      }
    }
  });

  it("rebuilds lineage boundary tables while preserving all lineage guards", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const preserved = populateSchema13(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version <= 56,
        ),
      );
      database
        .prepare(
          `INSERT INTO aborted_thread_forks(
             tenant_id, owner_principal_id, creation_operation_id,
             reserved_child_thread_id, source_thread_id, source_turn_id,
             source_turn_revision, source_kind, source_automation_id,
             source_automation_run_id, initiating_agent_thread_id,
             diagnostic, aborted_at
           ) VALUES (?, ?, 'preserved-abort', 'removed-child', ?,
             'preserved-turn', 4, 'user_fork', NULL, NULL, NULL,
             'Provider proved non-acceptance.', 10000)`,
        )
        .run(
          preserved.scope.tenantId,
          preserved.scope.principalId,
          preserved.threadId,
        );
      const beforeTriggers = (
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'trigger' AND tbl_name = 'thread_fork_origins'
             ORDER BY name`,
          )
          .all() as { readonly name: string }[]
      ).map(({ name }) => name);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(beforeTriggers).toEqual([
        "thread_force_reset_abandoned_fork_commit",
        "thread_fork_force_reset_automation_insert",
        "thread_fork_origins_agent_control_insert",
        "thread_fork_origins_agent_control_update",
        "thread_fork_origins_fork_point_immutable",
        "thread_fork_origins_immutable_delete",
        "thread_fork_origins_immutable_update",
        "thread_lineage_closure_origin_commit",
        "thread_lineage_closure_origin_insert",
        "thread_lineage_closure_source_resolution",
      ]);
      expect(
        (
          database
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'trigger' AND tbl_name = 'thread_fork_origins'
               ORDER BY name`,
            )
            .all() as { readonly name: string }[]
        ).map(({ name }) => name),
      ).toEqual([
        ...beforeTriggers.slice(0, 7),
        "thread_fork_origins_principal_client_insert",
        "thread_fork_origins_principal_client_update",
        ...beforeTriggers.slice(7),
      ]);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'thread_fork_origins_by_source'`,
          )
          .get(),
      ).toBeDefined();
      expect(
        database
          .prepare(
            `SELECT name AS boundaryKind
             FROM pragma_table_info('aborted_thread_forks')
             WHERE name = 'boundary_kind'`,
          )
          .get(),
      ).toEqual({ boundaryKind: "boundary_kind" });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT source_turn_id AS sourceTurnId,
               source_turn_revision AS sourceTurnRevision,
               boundary_kind AS boundaryKind
             FROM aborted_thread_forks
             WHERE creation_operation_id = 'preserved-abort'`,
          )
          .get(),
      ).toEqual({
        sourceTurnId: "preserved-turn",
        sourceTurnRevision: 4,
        boundaryKind: "completed_turn_inclusive",
      });
      expect(version(database)).toBe(latestBackendNormalizedVersion);
    } finally {
      database.close();
    }
  });

  it("requires schema 9 and explicit quiescent cutover confirmation", () => {
    const empty = new Database(":memory:");
    try {
      expect(() =>
        applyBackendNormalizationMigration(empty, {
          configuration,
          quiescentCutoverConfirmed: true,
        }),
      ).toThrow("requires schema version 9");
    } finally {
      empty.close();
    }

    const database = openOverlayDatabase(":memory:");
    try {
      expect(() =>
        applyBackendNormalizationMigration(database, {
          configuration,
          quiescentCutoverConfirmed: false,
        } as never),
      ).toThrow("quiescent old server");
      expect(version(database)).toBe(9);
    } finally {
      database.close();
    }
  });

  it("assigns legacy Pi state to a Pi target when the new-thread default is Codex", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/codex-default-cutover",
          displayName: "Codex default cutover",
          availability: "available",
          trustState: "trusted",
        },
        1,
      );
      const thread = inventory.createThread(
        scope,
        { workspaceId: workspace.id, title: "Legacy Pi thread" },
        2,
      );

      applyBackendNormalizationMigration(database, {
        configuration: codexDefaultConfiguration,
        quiescentCutoverConfirmed: true,
        appliedAt: 3,
      });

      expect(
        database
          .prepare(
            `
              SELECT backend_instance_id AS backendInstanceId
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, thread.thread.id),
      ).toEqual({ backendInstanceId: "configured-pi" });
    } finally {
      database.close();
    }
  });

  it.each(["native_send", "materialization_retry"])(
    "fails closed instead of creating an unrecoverable %s operation fence",
    (mutationKind) => {
      const database = openOverlayDatabase(":memory:");
      try {
        const scope = new SingleUserIdentityProvider(database).getScope();
        const inventory = new ThreadInventoryService(
          new OverlayRepository(database),
        );
        const environment = inventory.getLocalEnvironment(scope);
        const workspace = inventory.rememberWorkspace(
          scope,
          {
            environmentId: environment.id,
            canonicalPath: "/tmp/unresolved-cutover",
            displayName: "Unresolved cutover",
            availability: "available",
            trustState: "trusted",
          },
          1,
        );
        const thread = inventory.createThread(
          scope,
          { workspaceId: workspace.id, title: "Pending operation" },
          2,
        );
        insertRuntimeReceipt(database, scope, thread.thread.id, {
          mutationKind,
          resultCode: "submitting",
          createdAt: 3,
        });

        expect(() => applyCutover(database)).toThrow(
          /cannot safely migrate unresolved legacy operation/i,
        );
        expect(version(database)).toBe(9);
      } finally {
        database.close();
      }
    },
  );

  it("does not clear a newer non-empty draft while migrating a pending first send", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/backend-normalization-newer-draft",
          displayName: "Newer draft migration",
          availability: "available",
          trustState: "trusted",
        },
        1_000,
      );
      const pending = createPendingThread(
        inventory,
        scope,
        workspace.id,
        "Pending with newer draft",
        "submitted prompt",
        "reserved-newer-draft",
        2_000,
      );
      inventory.saveDraft(
        scope,
        pending.thread.id,
        { text: "newer unsent draft", expectedRevision: 2 },
        2_300,
      );

      applyCutover(database);

      expect(
        database
          .prepare(
            `
              SELECT text, revision
              FROM thread_drafts
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, pending.thread.id),
      ).toEqual({ text: "newer unsent draft", revision: 3 });
    } finally {
      database.close();
    }
  });

  it("retains per-automation occurrence-key uniqueness in the normalized schema", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      applyCutover(database);
      const uniqueIndexes = (
        database.pragma("index_list('automation_runs')") as Array<{
          readonly name: string;
          readonly unique: 0 | 1;
        }>
      )
        .filter((index) => index.unique === 1)
        .map((index) =>
          (
            database.pragma(`index_info('${index.name}')`) as Array<{
              readonly name: string;
            }>
          ).map((column) => column.name),
        );

      expect(uniqueIndexes).toContainEqual([
        "tenant_id",
        "owner_principal_id",
        "automation_id",
        "occurrence_key",
      ]);
    } finally {
      database.close();
    }
  });

  it("maps populated v9 state into scoped end-state structures", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/backend-normalization",
          displayName: "Normalization",
          availability: "available",
          trustState: "trusted",
        },
        1_000,
      );

      const draft = inventory.createThread(
        scope,
        { workspaceId: workspace.id, title: "Draft with stash" },
        2_000,
      );
      inventory.saveDraft(
        scope,
        draft.thread.id,
        { text: "stashed text", expectedRevision: 0 },
        2_100,
      );
      inventory.stashDraft(
        scope,
        draft.thread.id,
        { expectedDraftRevision: 1, mutationId: randomUUID() },
        2_200,
      );
      inventory.saveDraft(
        scope,
        draft.thread.id,
        { text: "current draft", expectedRevision: 2 },
        2_300,
      );

      const native = createNativeThread(
        inventory,
        database,
        scope,
        workspace.id,
        "Native anchor",
        "native-anchor",
        "/tmp/pi/native-anchor.jsonl",
        3_000,
      );
      inventory.recordAgentCompletion(
        scope,
        native.thread.id,
        "pi-completion-unseen",
        3_500,
      );
      inventory.transitionInventory(
        scope,
        native.thread.id,
        {
          expectedRevision: 1,
          mutationId: randomUUID(),
          change: { action: "settle" },
        },
        3_600,
      );
      insertRuntimeReceipt(database, scope, native.thread.id, {
        mutationKind: "native_send",
        resultCode: "accepted",
        createdAt: 3_400,
      });

      const prepared = createPendingThread(
        inventory,
        scope,
        workspace.id,
        "Prepared first send",
        "prepared prompt",
        "reserved-prepared",
        4_000,
      );
      const retrying = createPendingThread(
        inventory,
        scope,
        workspace.id,
        "Retrying first send",
        "retry prompt",
        "reserved-retry",
        5_000,
      );
      const retryAttemptId = inventory.getThread(scope, retrying.thread.id)
        .thread.materializationAttemptId!;
      const retryMutationId = randomUUID();
      const retryRequest = {
        attemptId: retryAttemptId,
        anchorEntryId: "pi-anchor-entry",
        anchorEntryCount: 4,
      };
      inventory.prepareMaterializationRetry(
        scope,
        retrying.thread.id,
        {
          ...retryRequest,
          mutationId: retryMutationId,
        },
        5_300,
      );
      inventory.completeNativeOperation(
        scope,
        retrying.thread.id,
        {
          mutationId: retryMutationId,
          kind: "materialization_retry",
          request: retryRequest,
        },
        5_301,
      );

      const unresolved = createPendingThread(
        inventory,
        scope,
        workspace.id,
        "Accepted but unresolved",
        "accepted prompt",
        "reserved-unresolved",
        6_000,
      );
      const unresolvedAttempt = inventory.getThread(scope, unresolved.thread.id)
        .thread.materializationAttemptId!;
      inventory.markSubmitting(
        scope,
        unresolved.thread.id,
        unresolvedAttempt,
        6_300,
      );
      inventory.bindNativeSession(
        scope,
        unresolved.thread.id,
        {
          attemptId: unresolvedAttempt,
          nativeSessionPath: "/tmp/pi/unresolved.jsonl",
          promptVerified: false,
        },
        6_400,
      );
      inventory.markAcceptedUnpersisted(
        scope,
        unresolved.thread.id,
        unresolvedAttempt,
        6_500,
      );

      const aborted = createPendingThread(
        inventory,
        scope,
        workspace.id,
        "Aborted first send",
        "aborted prompt",
        "reserved-aborted",
        7_000,
      );
      const abortedAttempt = inventory.getThread(scope, aborted.thread.id)
        .thread.materializationAttemptId!;
      inventory.markAbortedUnpersisted(
        scope,
        aborted.thread.id,
        abortedAttempt,
        7_300,
      );

      const child = createNativeThread(
        inventory,
        database,
        scope,
        workspace.id,
        "Native clone",
        "native-child",
        "/tmp/pi/native-child.jsonl",
        8_000,
      );
      seedCloneAutomation(database, scope, native.thread.id, child.thread.id);
      const automationPending = seedAutomationFirstSend(
        database,
        inventory,
        scope,
        workspace.id,
      );

      const countsBefore = tableCounts(database, [
        "application_threads",
        "automation_definitions",
        "automation_runs",
        "thread_drafts",
        "prompt_stashes",
      ]);
      applyCutover(database);

      expect(version(database)).toBe(13);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(tableCounts(database, Object.keys(countsBefore))).toEqual(
        countsBefore,
      );
      expect(
        database
          .prepare(
            `
              SELECT backing_state AS backingState,
                backend_instance_id AS backendInstanceId,
                connection_profile_id AS connectionProfileId
              FROM application_threads WHERE id = ?
            `,
          )
          .get(draft.thread.id),
      ).toMatchObject({
        backingState: "unbound",
        backendInstanceId: "configured-pi",
        connectionProfileId: expect.any(String),
      });
      expect(
        database
          .prepare(
            "SELECT 1 FROM conversation_bindings WHERE application_thread_id = ?",
          )
          .get(draft.thread.id),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            `
              SELECT backend_conversation_id AS backendConversationId
              FROM conversation_bindings WHERE application_thread_id = ?
            `,
          )
          .get(native.thread.id),
      ).toEqual({ backendConversationId: "native-anchor" });
      expect(
        database
          .prepare(
            `
              SELECT native_session_path AS path,
                opaque_binding_detail AS opaqueBindingDetail
              FROM pi_binding_details WHERE application_thread_id = ?
            `,
          )
          .get(native.thread.id),
      ).toEqual({
        path: "/tmp/pi/native-anchor.jsonl",
        opaqueBindingDetail: JSON.stringify({
          version: 1,
          backendConversationId: "native-anchor",
          sessionFile: "/tmp/pi/native-anchor.jsonl",
        }),
      });
      expect(
        database
          .prepare(
            `
              SELECT opaque_binding_detail AS opaqueBindingDetail,
                native_session_path AS nativeSessionPath
              FROM pi_creation_details
              WHERE application_thread_id = ? AND attempt_id = ?
            `,
          )
          .get(unresolved.thread.id, unresolvedAttempt),
      ).toEqual({
        opaqueBindingDetail: JSON.stringify({
          version: 1,
          backendConversationId: "reserved-unresolved",
          sessionFile: "/tmp/pi/unresolved.jsonl",
        }),
        nativeSessionPath: "/tmp/pi/unresolved.jsonl",
      });

      expect(
        database
          .prepare(
            `
              SELECT phase, initial_input_text AS initialInput,
                source_kind AS sourceKind,
                consumed_draft_revision AS consumedDraftRevision
              FROM conversation_creation_attempts
              WHERE application_thread_id = ?
            `,
          )
          .get(prepared.thread.id),
      ).toEqual({
        phase: "prepared",
        initialInput: "prepared prompt",
        sourceKind: "composer",
        consumedDraftRevision: expect.any(Number),
      });
      expect(
        database
          .prepare(
            `
              SELECT draft.text, draft.revision,
                attempt.consumed_draft_revision AS consumedDraftRevision
              FROM thread_drafts AS draft
              JOIN conversation_creation_attempts AS attempt
                ON attempt.tenant_id = draft.tenant_id
                AND attempt.owner_principal_id = draft.principal_id
                AND attempt.application_thread_id = draft.thread_id
              WHERE draft.thread_id = ?
            `,
          )
          .get(prepared.thread.id),
      ).toEqual({
        text: "",
        revision: expect.any(Number),
        consumedDraftRevision: expect.any(Number),
      });
      const consumedPreparedDraft = database
        .prepare(
          `
            SELECT draft.revision,
              attempt.consumed_draft_revision AS consumedDraftRevision
            FROM thread_drafts AS draft
            JOIN conversation_creation_attempts AS attempt
              ON attempt.tenant_id = draft.tenant_id
              AND attempt.owner_principal_id = draft.principal_id
              AND attempt.application_thread_id = draft.thread_id
            WHERE draft.thread_id = ?
          `,
        )
        .get(prepared.thread.id) as {
        revision: number;
        consumedDraftRevision: number;
      };
      expect(consumedPreparedDraft.revision).toBe(
        consumedPreparedDraft.consumedDraftRevision,
      );
      expect(
        database
          .prepare(
            `
              SELECT source_kind AS sourceKind,
                source_automation_id AS automationId,
                source_automation_run_id AS runId,
                initial_input_text AS initialInput
              FROM conversation_creation_attempts
              WHERE application_thread_id = ?
            `,
          )
          .get(automationPending),
      ).toEqual({
        sourceKind: "automation",
        automationId: "pending-automation",
        runId: "pending-automation-run",
        initialInput: "automation first prompt",
      });
      expect(
        database
          .prepare(
            `
              SELECT retry_anchor AS retryAnchor,
                retry_mutation_id AS retryMutationId,
                retry_reconciliation_token AS reconciliationToken
              FROM conversation_creation_attempts
              WHERE application_thread_id = ?
            `,
          )
          .get(retrying.thread.id),
      ).toMatchObject({
        retryAnchor: JSON.stringify({
          version: 1,
          entryId: "pi-anchor-entry",
          entryCount: 4,
        }),
        retryMutationId: expect.any(String),
        reconciliationToken: expect.any(String),
      });
      expect(
        database
          .prepare(
            "SELECT backing_state AS state FROM application_threads WHERE id = ?",
          )
          .get(unresolved.thread.id),
      ).toEqual({ state: "creation_unknown" });
      expect(
        database
          .prepare(
            "SELECT phase FROM conversation_creation_attempts WHERE application_thread_id = ?",
          )
          .get(unresolved.thread.id),
      ).toEqual({ phase: "accepted_unpersisted" });
      const unresolvedBinding = new ConversationBindingRepository(
        database,
      ).getBinding(scope, unresolved.thread.id)!;
      const unresolvedAcceptedAt = (
        database
          .prepare(
            `
              SELECT accepted_at AS acceptedAt
              FROM conversation_creation_attempts
              WHERE application_thread_id = ? AND attempt_id = ?
            `,
          )
          .get(unresolved.thread.id, unresolvedAttempt) as {
          acceptedAt: number;
        }
      ).acceptedAt;
      // This fixture intentionally stops at the schema-13 cutover. Exercise
      // its migrated recovery state directly rather than invoking the current
      // end-state repository against a historical partial schema.
      database.transaction(() => {
        database
          .prepare(
            `UPDATE conversation_creation_attempts
             SET phase = 'bound', reconciled_at = ?, retry_anchor = NULL
             WHERE application_thread_id = ? AND attempt_id = ?
               AND phase = 'accepted_unpersisted'`,
          )
          .run(unresolvedAcceptedAt, unresolved.thread.id, unresolvedAttempt);
        database
          .prepare(
            `UPDATE application_threads
             SET backing_state = 'bound', updated_at = ?, revision = revision + 1
             WHERE id = ? AND backing_state = 'creation_unknown'`,
          )
          .run(unresolvedAcceptedAt, unresolved.thread.id);
      })();
      expect(
        new ConversationBindingRepository(database).getBinding(
          scope,
          unresolved.thread.id,
        ),
      ).toEqual(unresolvedBinding);
      expect(
        database
          .prepare(
            `
              SELECT backing_state AS backingState
              FROM application_threads WHERE id = ?
            `,
          )
          .get(unresolved.thread.id),
      ).toEqual({ backingState: "bound" });
      expect(
        database
          .prepare(
            `
              SELECT phase
              FROM conversation_creation_attempts
              WHERE application_thread_id = ?
            `,
          )
          .get(unresolved.thread.id),
      ).toEqual({ phase: "bound" });
      expect(
        database
          .prepare(
            "SELECT backing_state AS state FROM application_threads WHERE id = ?",
          )
          .get(aborted.thread.id),
      ).toEqual({ state: "unbound" });

      expect(
        database
          .prepare(
            `
              SELECT checkpoint.opaque_reference AS reference,
                run.source_checkpoint_id AS checkpointId
              FROM automation_runs AS run
              JOIN backend_checkpoints AS checkpoint
                ON checkpoint.tenant_id = run.tenant_id
                AND checkpoint.owner_principal_id = run.owner_principal_id
                AND checkpoint.id = run.source_checkpoint_id
              WHERE run.id = 'clone-run'
            `,
          )
          .get(),
      ).toEqual({
        reference: "pi-source-leaf",
        checkpointId: "clone-run",
      });
      expect(
        database
          .prepare(
            `
              SELECT backend_correlation AS correlation,
                acknowledged_at AS acknowledgedAt
              FROM submission_completion_observations
              WHERE operation_id = ?
            `,
          )
          .get("migration-attention-" + native.thread.id),
      ).toEqual({
        correlation: "pi-completion-unseen",
        acknowledgedAt: null,
      });
      expect(
        database
          .prepare(
            `
              SELECT operation_kind AS operationKind, result_code AS resultCode,
                replayable,
                result_json AS resultJson
              FROM mutation_receipts WHERE mutation_id = 'runtime-receipt'
            `,
          )
          .get(),
      ).toEqual({
        operationKind: "conversation_input",
        resultCode: "accepted",
        replayable: 0,
        resultJson: "{}",
      });
      const inventoryReceipt = database
        .prepare(
          `
            SELECT result_json AS resultJson
            FROM mutation_receipts WHERE operation_kind = 'inventory'
          `,
        )
        .get() as { resultJson: string };
      expect(JSON.parse(inventoryReceipt.resultJson)).not.toHaveProperty(
        "latestAgentCompletionId",
      );
      expect(
        database.prepare("SELECT count(*) AS count FROM queued_inputs").get(),
      ).toEqual({ count: 0 });

      const insertRetryAttempt = database.prepare(`
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          initial_input_text, consumed_draft_revision,
          requested_backend_conversation_id,
          phase, prepared_at
        )
        SELECT
          tenant_id, owner_principal_id, id, ?, ?,
          backend_instance_id, connection_profile_id, environment_id,
          'first_input', 'composer', 'retry after terminal attempt',
          1, ?, 'prepared', 100000
        FROM application_threads WHERE id = ?
      `);
      expect(
        insertRetryAttempt.run(
          "replacement-attempt",
          "replacement-mutation",
          "replacement-native",
          aborted.thread.id,
        ).changes,
      ).toBe(1);
      expect(() =>
        insertRetryAttempt.run(
          "conflicting-active-attempt",
          "conflicting-active-mutation",
          "conflicting-native",
          aborted.thread.id,
        ),
      ).toThrow();

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(version(database)).toBe(latestBackendNormalizedVersion);
      expect(
        new ConversationOperationRepository(
          database,
        ).findUncertainThreadOperation(scope, native.thread.id),
      ).toBeUndefined();

      const columns = (
        database.pragma("table_info(application_threads)") as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(columns).not.toContain("reserved_native_session_id");
      expect(columns).not.toContain("native_session_path");
      expect(columns).not.toContain("tool_mode");
      expect(columns).not.toContain("attempt_phase");
      expect(
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('pending_first_sends', 'thread_start_preferences')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("fills missing Pi settings and clears unsupported legacy thinking levels", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/inconsistent-migration",
        displayName: "Inconsistent",
        availability: "available",
        trustState: "trusted",
      });
      const thread = inventory.createThread(scope, {
        workspaceId: workspace.id,
      });
      database
        .prepare(
          "DELETE FROM thread_start_preferences WHERE tenant_id = ? AND thread_id = ?",
        )
        .run(scope.tenantId, thread.thread.id);
      const invalid = inventory.createThread(scope, {
        workspaceId: workspace.id,
      });
      database
        .prepare(
          "UPDATE thread_start_preferences SET thinking_level = ? WHERE tenant_id = ? AND thread_id = ?",
        )
        .run("unsupported-legacy-level", scope.tenantId, invalid.thread.id);

      applyCutover(database);
      expect(version(database)).toBe(13);
      expect(
        database
          .prepare(
            "SELECT model_provider AS modelProvider, model_id AS modelId, thinking_level AS thinkingLevel, tool_mode AS toolMode, revision FROM pi_thread_settings WHERE tenant_id = ? AND application_thread_id = ?",
          )
          .get(scope.tenantId, thread.thread.id),
      ).toEqual({
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        toolMode: "read_only",
        revision: 0,
      });
      expect(
        database
          .prepare(
            "SELECT thinking_level AS thinkingLevel FROM pi_thread_settings WHERE tenant_id = ? AND application_thread_id = ?",
          )
          .get(scope.tenantId, invalid.thread.id),
      ).toEqual({ thinkingLevel: null });
    } finally {
      database.close();
    }
  });

  it("rejects a legacy Pi binding whose exact opaque detail exceeds its bound", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/oversized-pi-binding",
        displayName: "Oversized Pi binding",
        availability: "available",
        trustState: "trusted",
      });
      createNativeThread(
        inventory,
        database,
        scope,
        workspace.id,
        "Oversized binding",
        "oversized-binding",
        `/${"x".repeat(4_050)}`,
        1_000,
      );

      expect(() => applyCutover(database)).toThrow();
      expect(version(database)).toBe(9);
      expect(
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_binding_details'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("persists new automation claims and clone lineage only through neutral v10 IDs", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const inventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/v10-automation-lineage",
        displayName: "Automation lineage",
        availability: "available",
        trustState: "trusted",
      });
      const anchor = createNativeThread(
        inventory,
        database,
        scope,
        workspace.id,
        "Anchor",
        "anchor-backend-conversation",
        "/tmp/v10-automation-lineage/anchor.jsonl",
        1_000,
      );
      const beforeCutover = new AutomationRepository(database);
      beforeCutover.createDefinition(scope, {
        id: "neutral-clone",
        anchorThreadId: anchor.thread.id,
        name: "Neutral clone",
        prompt: "Review this branch",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: {
          kind: "interval",
          anchorAt: 1_000,
          everySeconds: 3_600,
        },
        misfirePolicy: "coalesce",
        nextRunAt: 5_000,
        now: 1_000,
      });
      applyCutover(database);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      const automations = new AutomationRepository(database);
      const claim = automations.createManualRun(scope, "neutral-clone", {
        runId: "neutral-clone-run",
        occurrenceKey: "manual:neutral-clone-run",
        scheduledFor: 90_100,
        claimToken: "claim-neutral",
        leaseExpiresAt: 100_000,
        dispatchMutationId: "dispatch-neutral",
        now: 90_100,
      });
      expect(claim.run).toMatchObject({
        childThreadId: null,
      });

      const checkpoint = new BackendCheckpointRepository(database).create(
        scope,
        anchor.thread.id,
        {
          id: "neutral-checkpoint",
          applicationTurnId: "neutral-turn",
          opaqueReference: "opaque-leaf-reference",
          now: 90_110,
        },
      );
      database
        .prepare(
          `
            INSERT INTO application_threads(
              tenant_id, id, owner_principal_id, environment_id, workspace_id,
              backend_instance_id, connection_profile_id, backing_state, title,
              availability, reconciliation_at, last_activity_at, revision,
              created_at, updated_at
            )
            SELECT tenant_id, 'neutral-child', owner_principal_id,
              environment_id, workspace_id, backend_instance_id,
              connection_profile_id, 'bound', 'Anchor', 'available', 90120,
              90120, 0, 90120, 90120
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, anchor.thread.id);
      database
        .prepare(
          `
            INSERT INTO conversation_bindings(
              tenant_id, owner_principal_id, application_thread_id,
              backend_instance_id, connection_profile_id,
              execution_environment_id, backend_conversation_id, created_at
            )
            SELECT tenant_id, owner_principal_id, id, backend_instance_id,
              connection_profile_id, environment_id,
              'neutral-child-backend-conversation', 90120
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND id = 'neutral-child'
          `,
        )
        .run(scope.tenantId, scope.principalId);
      database
        .prepare(
          `
            INSERT INTO thread_principal_state(
              tenant_id, principal_id, thread_id, inventory_state,
              state_changed_at, inventory_revision
            )
            VALUES (?, ?, 'neutral-child', 'active', 90120, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId);
      database
        .prepare(
          `
            INSERT INTO thread_drafts(
              tenant_id, principal_id, thread_id, text, updated_at, revision
            )
            VALUES (?, ?, 'neutral-child', '', 90120, 0)
          `,
        )
        .run(scope.tenantId, scope.principalId);

      expect(checkpoint).toMatchObject({
        id: "neutral-checkpoint",
        applicationTurnId: "neutral-turn",
      });
      expect(() =>
        automations.bindForkChild(scope, "neutral-clone", claim.run.id, {
          childThreadId: "neutral-child",
          now: 90_130,
        }),
      ).toThrow("does not match the automation anchor");
      expect(
        database
          .prepare("PRAGMA table_info(automation_runs)")
          .all()
          .map((column) => (column as { name: string }).name),
      ).not.toEqual(
        expect.arrayContaining([
          "source_leaf_entry_id",
          "lineage_metadata",
          "pi_user_entry_id",
          "source_checkpoint_id",
          "lineage_kind",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("preserves repurposed Pi threads while tombstoning their older aborted clone operations", async () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/legacy-pi-promotion",
        displayName: "Legacy Pi promotion",
        availability: "available",
        trustState: "trusted",
      });
      const anchor = createNativeThread(
        legacy,
        database,
        scope,
        workspace.id,
        "Anchor",
        "legacy-promotion-anchor",
        "/tmp/legacy-pi-promotion/anchor.jsonl",
        1_000,
      );
      applyCutover(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version < 20,
        ),
      );

      const bindings = new ConversationBindingRepository(database);
      const anchorDefinition = bindings.findThreadDefinition(
        scope,
        anchor.thread.id,
      )!;
      const child = bindings.createUnboundThread(scope, {
        id: "legacy-promoted-pi-thread",
        workspaceId: workspace.id,
        connectionProfileId: anchorDefinition.connectionProfileId,
        title: "Legacy promoted thread",
        initialText: "Hello",
        now: 90_090,
      });
      const automations = new AutomationRepository(database);
      automations.createDefinition(scope, {
        id: "repurposed-child-clone",
        anchorThreadId: anchor.thread.id,
        name: "Repurposed child clone",
        prompt: "Review",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: { kind: "date_time", runAt: 90_200 },
        misfirePolicy: "coalesce",
        nextRunAt: 90_200,
        now: 90_091,
      });
      const abortedRun = automations.createManualRun(
        scope,
        "repurposed-child-clone",
        {
          runId: "repurposed-child-clone-run",
          occurrenceKey: "manual:repurposed-child-clone-run",
          scheduledFor: 90_092,
          claimToken: "repurposed-child-claim",
          leaseExpiresAt: 100_000,
          dispatchMutationId: "repurposed-aborted-clone-operation",
          now: 90_092,
        },
      ).run;
      database
        .prepare(
          `
        UPDATE automation_runs SET child_thread_id = ?, updated_at = 90093
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND automation_id = 'repurposed-child-clone' AND id = ?
      `,
        )
        .run(child.id, scope.tenantId, scope.principalId, abortedRun.id);
      database
        .prepare(
          `
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          source_automation_id, source_automation_run_id, initial_input_text,
          consumed_draft_revision, requested_backend_conversation_id,
          phase, diagnostic, prepared_at
        ) VALUES (?, ?, ?, 'repurposed-aborted-clone-attempt', ?, ?, ?, ?,
          'automation_clone', 'automation', ?, ?, NULL, NULL,
          'repurposed-aborted-reservation', 'aborted_unpersisted', ?, 90094)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          "repurposed-aborted-clone-operation",
          child.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          child.target.executionEnvironmentId,
          "repurposed-child-clone",
          abortedRun.id,
          "The older clone was not created.",
        );
      database
        .prepare(
          `
        INSERT INTO pi_thread_settings(
          tenant_id, owner_principal_id, application_thread_id,
          tool_mode, revision
        ) VALUES (?, ?, ?, 'full', 2)
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      const backendConversationId = "legacy-promoted-pi-native";
      const nativeSessionPath = "/tmp/legacy-pi-promotion/promoted.jsonl";
      const opaqueBindingDetail = JSON.stringify({
        version: 1,
        backendConversationId,
        sessionFile: nativeSessionPath,
      });
      database
        .prepare(
          `
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          initial_input_text, consumed_draft_revision,
          requested_backend_conversation_id, phase,
          provisional_backend_conversation_id, prepared_at,
          external_call_started_at, accepted_at, reconciled_at
        ) VALUES (?, ?, ?, 'legacy-promoted-attempt',
          'legacy-promoted-operation', ?, ?, ?, 'first_input', 'composer',
          'Hello', 1, ?, 'bound', ?, 90101, 90102, 90103, 90104)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          child.target.executionEnvironmentId,
          backendConversationId,
          backendConversationId,
        );
      database
        .prepare(
          `
        INSERT INTO pi_creation_details(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          backend_instance_id, execution_environment_id,
          opaque_binding_detail, native_session_path
        ) VALUES (?, ?, ?, 'legacy-promoted-attempt', ?, ?, ?, ?)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          child.target.executionEnvironmentId,
          opaqueBindingDetail,
          nativeSessionPath,
        );
      database
        .prepare(
          `
        INSERT INTO conversation_bindings(
          tenant_id, owner_principal_id, application_thread_id,
          backend_instance_id, connection_profile_id,
          execution_environment_id, backend_conversation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 90104)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          child.target.executionEnvironmentId,
          backendConversationId,
        );
      database
        .prepare(
          `
        INSERT INTO pi_binding_details(
          tenant_id, owner_principal_id, application_thread_id,
          backend_instance_id, execution_environment_id,
          opaque_binding_detail, native_session_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          child.target.executionEnvironmentId,
          opaqueBindingDetail,
          nativeSessionPath,
        );
      database
        .prepare(
          `
        DELETE FROM pi_creation_details
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ?
          AND attempt_id = 'legacy-promoted-attempt'
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      database
        .prepare(
          `
        UPDATE application_threads SET backing_state = 'bound'
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      database
        .prepare(
          `
        UPDATE thread_drafts SET text = '', revision = 1, updated_at = 90104
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      expect(
        database
          .prepare(
            `
          SELECT 1 FROM pi_creation_details
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, child.id),
      ).toBeUndefined();

      const abortedFirstInputChild = bindings.createUnboundThread(scope, {
        id: "aborted-first-input-reused-child",
        workspaceId: workspace.id,
        connectionProfileId: anchorDefinition.connectionProfileId,
        title: "Aborted first-input reuse",
        initialText: "Retry draft",
        now: 90_105,
      });
      automations.createDefinition(scope, {
        id: "aborted-first-input-clone",
        anchorThreadId: child.id,
        name: "Aborted first-input clone",
        prompt: "Review",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: { kind: "date_time", runAt: 90_210 },
        misfirePolicy: "coalesce",
        nextRunAt: 90_210,
        now: 90_106,
      });
      const secondAbortedRun = automations.createManualRun(
        scope,
        "aborted-first-input-clone",
        {
          runId: "aborted-first-input-clone-run",
          occurrenceKey: "manual:aborted-first-input-clone-run",
          scheduledFor: 90_107,
          claimToken: "aborted-first-input-claim",
          leaseExpiresAt: 100_000,
          dispatchMutationId: "second-aborted-clone-operation",
          now: 90_107,
        },
      ).run;
      database
        .prepare(
          `
        UPDATE automation_runs SET child_thread_id = ?, updated_at = 90108
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND automation_id = 'aborted-first-input-clone' AND id = ?
      `,
        )
        .run(
          abortedFirstInputChild.id,
          scope.tenantId,
          scope.principalId,
          secondAbortedRun.id,
        );
      database
        .prepare(
          `
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          source_automation_id, source_automation_run_id, initial_input_text,
          consumed_draft_revision, requested_backend_conversation_id,
          phase, diagnostic, prepared_at
        ) VALUES (?, ?, ?, 'second-aborted-clone-attempt', ?, ?, ?, ?,
          'automation_clone', 'automation', ?, ?, NULL, NULL,
          'second-aborted-clone-reservation', 'aborted_unpersisted', ?, 90109)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          abortedFirstInputChild.id,
          "second-aborted-clone-operation",
          abortedFirstInputChild.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          abortedFirstInputChild.target.executionEnvironmentId,
          "aborted-first-input-clone",
          secondAbortedRun.id,
          "The older clone was not created.",
        );
      database
        .prepare(
          `
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          initial_input_text, consumed_draft_revision,
          requested_backend_conversation_id, phase, diagnostic, prepared_at
        ) VALUES (?, ?, ?, 'aborted-first-input-attempt',
          'aborted-first-input-operation', ?, ?, ?, 'first_input', 'composer',
          'Retry draft', NULL, 'aborted-first-input-native',
          'aborted_unpersisted', 'Provider rejected creation.', 90110)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          abortedFirstInputChild.id,
          abortedFirstInputChild.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          abortedFirstInputChild.target.executionEnvironmentId,
        );

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(database.pragma("foreign_key_check")).toEqual([]);
      const creation = new ConversationCreationRepository(database);
      expect(
        creation.get(scope, child.id, "legacy-promoted-attempt"),
      ).toMatchObject({
        phase: "bound",
        provisionalBackendConversationId: backendConversationId,
        provisionalOpaqueBindingDetail: opaqueBindingDetail,
      });
      expect(bindings.findThreadDefinition(scope, child.id)).toMatchObject({
        backingState: "bound",
      });
      expect(bindings.getBinding(scope, child.id)).toMatchObject({
        backendConversationId,
      });
      expect(
        database
          .prepare(
            `
          SELECT opaque_binding_detail AS opaqueBindingDetail
          FROM pi_binding_details
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, child.id),
      ).toEqual({ opaqueBindingDetail });
      expect(
        database
          .prepare(
            `
          SELECT tool_mode AS toolMode, revision FROM pi_thread_settings
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, child.id),
      ).toEqual({ toolMode: "full", revision: 2 });
      expect(
        database
          .prepare(
            `
          SELECT text, revision FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, child.id),
      ).toEqual({ text: "", revision: 1 });
      expect(
        creation.findByMutationId(scope, "repurposed-aborted-clone-operation"),
      ).toBeUndefined();
      const lineage = new ThreadLineageRepository(database);
      expect(
        lineage.findAbortedOperation(
          scope,
          "repurposed-aborted-clone-operation",
        ),
      ).toMatchObject({
        reservedChildThreadId: child.id,
        sourceThreadId: anchor.thread.id,
        sourceAutomationId: "repurposed-child-clone",
        sourceAutomationRunId: abortedRun.id,
        diagnostic: "The older clone was not created.",
      });
      expect(
        automations.getRun(scope, "repurposed-child-clone", abortedRun.id),
      ).toMatchObject({ childThreadId: null });
      expect(
        bindings.findThreadDefinition(scope, abortedFirstInputChild.id),
      ).toMatchObject({ backingState: "unbound" });
      expect(
        creation.get(
          scope,
          abortedFirstInputChild.id,
          "aborted-first-input-attempt",
        ),
      ).toMatchObject({
        phase: "aborted_unpersisted",
        initialInputText: "Retry draft",
      });
      expect(
        database
          .prepare(
            `
          SELECT text FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
          )
          .get(scope.tenantId, scope.principalId, abortedFirstInputChild.id),
      ).toEqual({ text: "Retry draft" });
      expect(
        lineage.findAbortedOperation(scope, "second-aborted-clone-operation"),
      ).toMatchObject({
        reservedChildThreadId: abortedFirstInputChild.id,
        sourceAutomationId: "aborted-first-input-clone",
        sourceAutomationRunId: secondAbortedRun.id,
      });
      expect(
        automations.getRun(
          scope,
          "aborted-first-input-clone",
          secondAbortedRun.id,
        ),
      ).toMatchObject({ childThreadId: null });

      const service = new ThreadForkService({
        database,
        targets: {
          actor: async () => {
            throw new Error("aborted fork replay must not acquire an actor");
          },
        } as never,
        actors: {} as never,
        backendPersistence: new Map(),
        bindings,
        creation,
        checkpoints: new BackendCheckpointRepository(database),
        lineage,
        inventory: new InventoryRepository(database),
        operations: new ConversationOperationRepository(database),
        outputArtifacts: { collectGarbage: async () => undefined },
        automations,
        automationExecutionPolicy: { assertCanAutomate: () => undefined },
        descendantSummaries: { listByIds: () => [] } as never,
        descendantTerminalSummaries: { summariesByThread: () => new Map() },
        lineageCursorSigningKey: Buffer.alloc(32, 6),
      });
      await expect(
        service.forkAutomation({
          scope,
          anchorThreadId: anchor.thread.id,
          automationId: "repurposed-child-clone",
          automationRunId: abortedRun.id,
          mutationId: "repurposed-aborted-clone-operation",
        }),
      ).resolves.toEqual({
        status: "aborted",
        childThreadId: child.id,
        diagnostic: "The older clone was not created.",
        // Legacy tombstones never recorded a deterministic failure.
        restartable: true,
      });
    } finally {
      database.close();
    }
  });

  it("migrates a legacy aborted automation clone to a stable tombstone and removes its reserved child", async () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/aborted-clone-migration",
        displayName: "Aborted clone migration",
        availability: "available",
        trustState: "trusted",
      });
      const anchor = createNativeThread(
        legacy,
        database,
        scope,
        workspace.id,
        "Anchor",
        "aborted-clone-anchor",
        "/tmp/aborted-clone-migration/anchor.jsonl",
        1_000,
      );
      applyCutover(database);
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          (migration) => migration.version < 20,
        ),
      );

      const bindings = new ConversationBindingRepository(database);
      const anchorDefinition = bindings.findThreadDefinition(
        scope,
        anchor.thread.id,
      )!;
      const child = bindings.createUnboundThread(scope, {
        id: "legacy-aborted-clone-child",
        workspaceId: workspace.id,
        connectionProfileId: anchorDefinition.connectionProfileId,
        title: "Aborted clone",
        now: 90_100,
      });
      const automations = new AutomationRepository(database);
      automations.createDefinition(scope, {
        id: "legacy-aborted-clone",
        anchorThreadId: anchor.thread.id,
        name: "Legacy aborted clone",
        prompt: "Review",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: { kind: "date_time", runAt: 90_200 },
        misfirePolicy: "coalesce",
        nextRunAt: 90_200,
        now: 90_100,
      });
      const run = automations.createManualRun(scope, "legacy-aborted-clone", {
        runId: "legacy-aborted-clone-run",
        occurrenceKey: "manual:legacy-aborted-clone-run",
        scheduledFor: 90_101,
        claimToken: "legacy-aborted-claim",
        leaseExpiresAt: 100_000,
        dispatchMutationId: "legacy-aborted-clone-operation",
        now: 90_101,
      }).run;
      database
        .prepare(
          `
        UPDATE automation_runs SET child_thread_id = ?, updated_at = 90102
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND automation_id = 'legacy-aborted-clone' AND id = ?
      `,
        )
        .run(child.id, scope.tenantId, scope.principalId, run.id);
      database
        .prepare(
          `
        INSERT INTO pi_thread_settings(
          tenant_id, owner_principal_id, application_thread_id,
          tool_mode, revision
        ) VALUES (?, ?, ?, 'full', 0)
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      database
        .prepare(
          `
        INSERT INTO prompt_stashes(
          tenant_id, principal_id, thread_id, id, text, created_at
        ) VALUES (?, ?, ?, 'legacy-stash', 'not submitted', 90103)
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      database
        .prepare(
          `
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          source_automation_id, source_automation_run_id, initial_input_text,
          consumed_draft_revision, requested_backend_conversation_id,
          phase, diagnostic, prepared_at
        ) VALUES (?, ?, ?, 'legacy-aborted-clone-attempt', ?, ?, ?, ?,
          'automation_clone', 'automation', ?, ?, NULL, NULL,
          'legacy-reserved-provider-id', 'aborted_unpersisted', ?, 90104)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          "legacy-aborted-clone-operation",
          child.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          child.target.executionEnvironmentId,
          "legacy-aborted-clone",
          run.id,
          "Legacy provider rejected the clone.",
        );
      database
        .prepare(
          `
        UPDATE application_threads SET backing_state = 'creating'
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
        )
        .run(scope.tenantId, scope.principalId, child.id);
      database
        .prepare(
          `
        INSERT INTO conversation_bindings(
          tenant_id, owner_principal_id, application_thread_id,
          backend_instance_id, connection_profile_id,
          execution_environment_id, backend_conversation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'legacy-provider-artifact', 90105)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          anchorDefinition.connectionProfileId,
          child.target.executionEnvironmentId,
        );
      database
        .prepare(
          `
        INSERT INTO pi_binding_details(
          tenant_id, owner_principal_id, application_thread_id,
          backend_instance_id, execution_environment_id,
          opaque_binding_detail, native_session_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          child.id,
          child.target.backendInstanceId,
          child.target.executionEnvironmentId,
          JSON.stringify({
            version: 1,
            backendConversationId: "legacy-provider-artifact",
            sessionFile: "/tmp/aborted-clone-migration/aborted.jsonl",
          }),
          "/tmp/aborted-clone-migration/aborted.jsonl",
        );

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(database.pragma("foreign_key_check")).toEqual([]);
      const lineage = new ThreadLineageRepository(database);
      expect(
        lineage.findAbortedOperation(scope, "legacy-aborted-clone-operation"),
      ).toMatchObject({
        reservedChildThreadId: child.id,
        sourceThreadId: anchor.thread.id,
        sourceKind: "automation",
        sourceAutomationId: "legacy-aborted-clone",
        sourceAutomationRunId: run.id,
        diagnostic: "Legacy provider rejected the clone.",
      });
      expect(bindings.findThreadDefinition(scope, child.id)).toBeUndefined();
      expect(
        new ConversationCreationRepository(database).findByMutationId(
          scope,
          "legacy-aborted-clone-operation",
        ),
      ).toBeUndefined();
      expect(
        automations.getRun(scope, "legacy-aborted-clone", run.id),
      ).toMatchObject({
        childThreadId: null,
      });
      for (const table of [
        "conversation_bindings",
        "pi_binding_details",
        "pi_thread_settings",
        "thread_drafts",
        "prompt_stashes",
        "thread_principal_state",
      ]) {
        expect(
          database
            .prepare(
              `SELECT count(*) AS count FROM ${table}
            WHERE ${
              table === "thread_principal_state" ||
              table === "thread_drafts" ||
              table === "prompt_stashes"
                ? "tenant_id = ? AND principal_id = ? AND thread_id"
                : "tenant_id = ? AND owner_principal_id = ? AND application_thread_id"
            } = ?`,
            )
            .get(scope.tenantId, scope.principalId, child.id),
        ).toEqual({ count: 0 });
      }

      const service = new ThreadForkService({
        database,
        targets: {
          actor: async () => {
            throw new Error("aborted fork replay must not acquire an actor");
          },
        } as never,
        actors: {} as never,
        backendPersistence: new Map(),
        bindings,
        creation: new ConversationCreationRepository(database),
        checkpoints: new BackendCheckpointRepository(database),
        lineage,
        inventory: new InventoryRepository(database),
        operations: new ConversationOperationRepository(database),
        outputArtifacts: { collectGarbage: async () => undefined },
        automations,
        automationExecutionPolicy: { assertCanAutomate: () => undefined },
        descendantSummaries: { listByIds: () => [] } as never,
        descendantTerminalSummaries: { summariesByThread: () => new Map() },
        lineageCursorSigningKey: Buffer.alloc(32, 5),
      });
      await expect(
        service.forkAutomation({
          scope,
          anchorThreadId: anchor.thread.id,
          automationId: "legacy-aborted-clone",
          automationRunId: run.id,
          mutationId: "legacy-aborted-clone-operation",
        }),
      ).resolves.toEqual({
        status: "aborted",
        childThreadId: child.id,
        diagnostic: "Legacy provider rejected the clone.",
        // Legacy tombstones never recorded a deterministic failure.
        restartable: true,
      });
    } finally {
      database.close();
    }
  });
});

function createNativeThread(
  inventory: ThreadInventoryService,
  database: Database.Database,
  scope: { tenantId: string; principalId: string },
  workspaceId: string,
  title: string,
  nativeId: string,
  nativePath: string,
  now: number,
) {
  const thread = inventory.createThread(scope, { workspaceId, title }, now);
  database
    .prepare(
      `
        UPDATE application_threads
        SET backing_state = 'native', reserved_native_session_id = ?,
          native_session_path = ?, reconciliation_at = ?, updated_at = ?,
          revision = revision + 1
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
    )
    .run(
      nativeId,
      nativePath,
      now,
      now,
      scope.tenantId,
      scope.principalId,
      thread.thread.id,
    );
  return inventory.getThread(scope, thread.thread.id);
}

function createPendingThread(
  inventory: ThreadInventoryService,
  scope: { tenantId: string; principalId: string },
  workspaceId: string,
  title: string,
  prompt: string,
  reservedNativeSessionId: string,
  now: number,
) {
  const thread = inventory.createThread(scope, { workspaceId, title }, now);
  inventory.saveDraft(
    scope,
    thread.thread.id,
    { text: prompt, expectedRevision: 0 },
    now + 100,
  );
  return inventory.prepareFirstSend(
    scope,
    thread.thread.id,
    {
      expectedDraftRevision: 1,
      mutationId: randomUUID(),
      reservedNativeSessionId,
    },
    now + 200,
  );
}

function insertRuntimeReceipt(
  database: Database.Database,
  scope: { tenantId: string; principalId: string },
  threadId: string,
  input: {
    mutationKind: string;
    resultCode: string;
    createdAt: number;
  },
): void {
  database
    .prepare(
      `
        INSERT INTO mutation_receipts(
          tenant_id, principal_id, thread_id, mutation_id, mutation_kind,
          request_fingerprint, result_code, result_json, created_at
        )
        VALUES (?, ?, ?, 'runtime-receipt', ?, ?, ?, '{}', ?)
      `,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      threadId,
      input.mutationKind,
      "0".repeat(64),
      input.resultCode,
      input.createdAt,
    );
}

function seedCloneAutomation(
  database: Database.Database,
  scope: { tenantId: string; principalId: string },
  anchorThreadId: string,
  childThreadId: string,
): void {
  const automations = new AutomationRepository(database);
  automations.createDefinition(scope, {
    id: "clone-automation",
    anchorThreadId,
    name: "Clone automation",
    prompt: "Review the clone",
    precheck: null,
    runMode: "clone",
    enabled: true,
    schedule: {
      kind: "interval",
      anchorAt: 8_000,
      everySeconds: 3_600,
    },
    misfirePolicy: "coalesce",
    nextRunAt: 9_000,
    now: 8_000,
  });
  database
    .prepare(
      `
        INSERT INTO automation_runs(
          tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
          scheduled_for, occurrence_key, definition_revision, coalesced_count,
          run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
          prompt_snapshot, dispatch_mutation_id, anchor_thread_id,
          child_thread_id, source_leaf_entry_id, lineage_kind,
          lineage_metadata, pi_user_entry_id, error_code, error_diagnostic,
          claimed_at, started_at, accepted_at, finished_at, created_at,
          updated_at, precheck_command_snapshot, precheck_timeout_seconds,
          precheck_include_stdout, precheck_status, precheck_started_at,
          precheck_finished_at, precheck_exit_code, precheck_duration_ms,
          precheck_stdout_bytes, precheck_stdout_included
        )
        VALUES (
          ?, ?, 'clone-automation', 'clone-run', 'scheduled', 8_100,
          'occurrence-1', 0, 0, 'clone', 'completed', NULL, NULL, 1, NULL,
          'clone-dispatch', ?, ?, 'pi-source-leaf', 'automation_clone',
          'legacy source metadata', 'pi-automation-user', NULL, NULL, 8_100,
          8_200, 8_300, 8_400, 8_100, 8_400, NULL, NULL, NULL,
          'not_configured', NULL, NULL, NULL, NULL, NULL, NULL
        )
      `,
    )
    .run(scope.tenantId, scope.principalId, anchorThreadId, childThreadId);
}

function seedAutomationFirstSend(
  database: Database.Database,
  inventory: ThreadInventoryService,
  scope: { tenantId: string; principalId: string },
  workspaceId: string,
): string {
  const thread = inventory.createThread(
    scope,
    { workspaceId, title: "Automation first send" },
    9_000,
  );
  const automations = new AutomationRepository(database);
  automations.createDefinition(scope, {
    id: "pending-automation",
    anchorThreadId: thread.thread.id,
    name: "Pending automation",
    prompt: "automation first prompt",
    precheck: null,
    runMode: "same_thread",
    enabled: true,
    schedule: {
      kind: "interval",
      anchorAt: 9_000,
      everySeconds: 3_600,
    },
    misfirePolicy: "coalesce",
    nextRunAt: 10_000,
    now: 9_000,
  });
  database
    .prepare(
      `
        INSERT INTO automation_runs(
          tenant_id, owner_principal_id, automation_id, id, occurrence_kind,
          scheduled_for, occurrence_key, definition_revision, coalesced_count,
          run_mode, state, claim_token, lease_expires_at, claim_attempt_count,
          prompt_snapshot, dispatch_mutation_id, anchor_thread_id,
          child_thread_id, source_leaf_entry_id, lineage_kind,
          lineage_metadata, pi_user_entry_id, error_code, error_diagnostic,
          claimed_at, started_at, accepted_at, finished_at, created_at,
          updated_at, precheck_command_snapshot, precheck_timeout_seconds,
          precheck_include_stdout, precheck_status, precheck_started_at,
          precheck_finished_at, precheck_exit_code, precheck_duration_ms,
          precheck_stdout_bytes, precheck_stdout_included
        )
        VALUES (
          ?, ?, 'pending-automation', 'pending-automation-run', 'scheduled',
          9_100, 'pending-occurrence', 0, 0, 'same_thread', 'claimed',
          'pending-claim', 20_000, 1, 'automation first prompt',
          'pending-automation-dispatch', ?, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, 9_100, NULL, NULL, NULL, 9_100, 9_100, NULL, NULL,
          NULL, 'not_configured', NULL, NULL, NULL, NULL, NULL, NULL
        )
      `,
    )
    .run(scope.tenantId, scope.principalId, thread.thread.id);
  inventory.prepareAutomationFirstSend(
    scope,
    thread.thread.id,
    {
      prompt: "automation first prompt",
      automationId: "pending-automation",
      automationRunId: "pending-automation-run",
      mutationId: "pending-automation-dispatch",
      reservedNativeSessionId: "pending-automation-session",
    },
    9_200,
  );
  return thread.thread.id;
}

function tableCounts(
  database: Database.Database,
  tables: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (
        database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    ]),
  );
}
