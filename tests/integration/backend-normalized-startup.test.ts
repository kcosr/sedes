import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadBackendConfigurationFile } from "../../src/server/config/backend-configuration.js";
import { resolveBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import {
  openOverlayDatabase,
  openOverlayDatabaseConnection,
} from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
  migrateDatabase,
} from "../../src/server/db/migrate.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

const roots: string[] = [];

async function loadResolvedConfiguration(filename: string) {
  return resolveBackendConfiguration(
    await loadBackendConfigurationFile(filename),
  );
}

const configuration = {
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
      label: "Local Pi SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
} as const;

async function fixtureRoot(): Promise<{
  readonly root: string;
  readonly stateDirectory: string;
  readonly configurationPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-startup-"));
  roots.push(root);
  const stateDirectory = path.join(root, "state");
  const configurationPath = path.join(root, "sedes.json");
  await writeFile(configurationPath, JSON.stringify(configuration), "utf8");
  return { root, stateDirectory, configurationPath };
}

function version(database: Database.Database): number {
  return (
    database
      .prepare("SELECT max(version) AS version FROM schema_migrations")
      .get() as { readonly version: number }
  ).version;
}

function removeAgentToolCoreForOlderSchemaFixture(
  database: Database.Database,
): void {
  database.exec(`
    DELETE FROM schema_migrations WHERE version = 19;
    DELETE FROM schema_migrations WHERE version = 18;
    DROP TABLE provider_feature_mutation_receipts;
    DROP TABLE codex_execution_settings_snapshots;
    DROP TABLE codex_thread_execution_settings;
    DELETE FROM schema_migrations WHERE version = 17;
    DROP TRIGGER queued_inputs_retry_provenance_parent_update;
    DROP TRIGGER queued_inputs_trigger_provenance_update;
    DROP TRIGGER queued_inputs_trigger_provenance_insert;
    DROP TRIGGER automation_runs_queued_provenance_update;
    DROP TRIGGER automation_runs_queued_provenance_delete;
    DROP TABLE agent_tool_invocations;
    DROP TABLE agent_capability_entries;
    DROP TABLE agent_capability_grants;
    DROP TABLE agent_runs;
    DROP TABLE agent_executions;
    DROP INDEX application_threads_agent_execution_target;
    ALTER TABLE queued_inputs DROP COLUMN source_automation_run_id;
    ALTER TABLE queued_inputs DROP COLUMN source_automation_id;
    ALTER TABLE queued_inputs DROP COLUMN trigger_kind;
    DELETE FROM schema_migrations WHERE version = 16;
  `);
}

async function initializeSchema19Fixture(
  stateDirectory: string,
  parsedConfiguration: Awaited<ReturnType<typeof loadResolvedConfiguration>>,
): Promise<Database.Database> {
  await mkdir(stateDirectory, { recursive: true });
  const database = openOverlayDatabaseConnection(
    path.join(stateDirectory, "overlay.sqlite"),
  );
  migrateDatabase(database);
  applyBackendNormalizationMigration(database, {
    configuration: parsedConfiguration,
    quiescentCutoverConfirmed: true,
    appliedAt: 1_800_000_000_024,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter((migration) => migration.version < 20),
  );
  return database;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("backend-normalized startup maintenance", () => {
  it("validates configuration before creating a database", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const databasePath = path.join(stateDirectory, "overlay.sqlite");

    const relativePath = path.relative(process.cwd(), configurationPath);
    await expect(loadBackendConfigurationFile(relativePath)).rejects.toThrow(
      "Server configuration filename must be an absolute path",
    );
    await expect(access(databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(configurationPath, "not json", "utf8");
    await expect(
      loadBackendConfigurationFile(configurationPath),
    ).rejects.toThrow("is not valid JSON");
    await expect(access(databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prepares a fresh database without cutover confirmation or an empty backup", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const parsedConfiguration =
      await loadResolvedConfiguration(configurationPath);
    const result = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: parsedConfiguration, sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: false,
      now: 1_800_000_000_000,
    });
    try {
      expect(version(result.database)).toBe(latestBackendNormalizedVersion);
      expect(new ConfigurationRepository(result.database).get(new SingleUserIdentityProvider(result.database).getScope()).configuration.defaultTargetId).toBe("local-primary");
      expect(result.database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(result.backupPath).toBeNull();
      expect(result.prunedBackupPaths).toEqual([]);
      const scope = new SingleUserIdentityProvider(result.database).getScope();
      const environmentId = parsedConfiguration.executionEnvironments[0]!.id;
      result.database
        .prepare(
          `
            INSERT INTO agent_backend_instances(
              tenant_id, owner_principal_id, id, kind, label, enabled, configuration_revision,
              protocol_release, created_at, updated_at
            )
            VALUES (?, ?, 'codex-persistence-probe', 'codex_app_server',
              'Codex persistence probe', 0, 0, 'future-pin', 1, 1)
          `,
        )
        .run(scope.tenantId, scope.principalId);
      result.database
        .prepare(
          `
            INSERT INTO agent_connection_profiles(
              tenant_id, owner_principal_id, id, template_id,
              backend_instance_id, backend_kind, execution_environment_id,
              kind, label, enabled, configuration_revision, created_at,
              updated_at
            )
            VALUES (?, ?, 'codex-profile-probe', 'codex-target-probe',
              'codex-persistence-probe', 'codex_app_server', ?,
              'codex_app_server',
              'Codex target probe', 0, 0, 1, 1)
          `,
        )
        .run(scope.tenantId, scope.principalId, environmentId);
      expect(() =>
        result
          .database!.prepare(
            `
              INSERT INTO agent_backend_instances(
                tenant_id, owner_principal_id, id, kind, label, enabled, configuration_revision,
                protocol_release, created_at, updated_at
              )
              VALUES (?, ?, 'future-pi-release', 'pi', 'Future Pi', 0, 0,
                'wrong-release', 1, 1)
            `,
          )
          .run(scope.tenantId, scope.principalId),
      ).not.toThrow();
      expect(() =>
        result
          .database!.prepare(
            `
              INSERT INTO agent_backend_instances(
                tenant_id, owner_principal_id, id, kind, label, enabled, configuration_revision,
                protocol_release, created_at, updated_at
              )
              VALUES (?, ?, 'empty-protocol-release', 'pi', 'Empty release',
                0, 0, '', 1, 1)
            `,
          )
          .run(scope.tenantId, scope.principalId),
      ).toThrow();
      expect(() =>
        result
          .database!.prepare(
            `
              INSERT INTO agent_connection_profiles(
                tenant_id, owner_principal_id, id, template_id,
                backend_instance_id, backend_kind, execution_environment_id,
                kind, label, enabled, configuration_revision, created_at,
                updated_at
              )
              VALUES (?, ?, 'invalid-kind-profile', 'invalid-kind-target',
                'pi-primary', 'pi', ?, 'codex_app_server', 'Invalid', 0, 0,
                1, 1)
            `,
          )
          .run(scope.tenantId, scope.principalId, environmentId),
      ).toThrow();
      expect(result.database.pragma("foreign_key_check")).toEqual([]);
      expect(
        result.database
          .prepare(
            `
              SELECT label, configuration_revision AS revision
              FROM agent_backend_instances
              WHERE tenant_id = ? AND id = 'pi-primary'
            `,
          )
          .get(scope.tenantId),
      ).toEqual({ label: "Primary Pi", revision: 0 });
    } finally {
      result.database.close();
    }
  });

  it("backs up schema 14 before adding configuration fingerprints", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const parsedConfiguration =
      await loadResolvedConfiguration(configurationPath);
    const initialized = await initializeSchema19Fixture(
      stateDirectory,
      parsedConfiguration,
    );
    removeAgentToolCoreForOlderSchemaFixture(initialized);
    initialized.exec(`
      ALTER TABLE agent_backend_instances
        DROP COLUMN configuration_fingerprint;
      ALTER TABLE agent_connection_profiles
        DROP COLUMN configuration_fingerprint;
      DELETE FROM schema_migrations WHERE version = 15;
    `);
    expect(version(initialized)).toBe(14);
    initialized.close();

    const upgraded = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: parsedConfiguration, sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: false,
      now: 1_800_000_000_026,
    });
    try {
      expect(version(upgraded.database)).toBe(latestBackendNormalizedVersion);
      expect(upgraded.backupPath).toMatch(
        /backups\/overlay-schema-v14-1800000000026-/,
      );
      const backup = new Database(upgraded.backupPath!, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(version(backup)).toBe(14);
        expect(
          backup.pragma("table_info('agent_backend_instances')") as Array<{
            readonly name: string;
          }>,
        ).not.toContainEqual(
          expect.objectContaining({ name: "configuration_fingerprint" }),
        );
      } finally {
        backup.close();
      }
      expect(
        upgraded.database
          .prepare(
            `
              SELECT configuration_fingerprint AS fingerprint
              FROM agent_backend_instances
              WHERE id = 'pi-primary'
            `,
          )
          .get(),
      ).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    } finally {
      upgraded.database.close();
    }
  });

  it("resumes startup from a committed v11 migration after a crash before later migrations", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const databasePath = path.join(stateDirectory, "overlay.sqlite");
    const interrupted = await initializeSchema19Fixture(
      stateDirectory,
      await loadResolvedConfiguration(configurationPath),
    );
    removeAgentToolCoreForOlderSchemaFixture(interrupted);
    interrupted.exec(`
      DELETE FROM schema_migrations WHERE version = 15;
      DELETE FROM schema_migrations WHERE version = 14;
      DROP INDEX automation_runs_application_summary_latest;
      DELETE FROM schema_migrations WHERE version = 13;
      DROP INDEX automation_runs_occurrence_key_unique;
      DELETE FROM schema_migrations WHERE version = 12;
      CREATE TABLE startup_v11_probe(value TEXT NOT NULL) STRICT;
      INSERT INTO startup_v11_probe VALUES ('survives resumed migration');
    `);
    expect(version(interrupted)).toBe(11);
    interrupted.close();

    const resumed = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: false,
      now: 1_800_000_000_060,
    });
    try {
      expect(version(resumed.database)).toBe(latestBackendNormalizedVersion);
      expect(resumed.backupPath).not.toBeNull();
      expect(resumed.prunedBackupPaths).toEqual([]);
      const backup = new Database(resumed.backupPath!, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(version(backup)).toBe(11);
        expect(
          backup.prepare("SELECT value FROM startup_v11_probe").get(),
        ).toEqual({ value: "survives resumed migration" });
      } finally {
        backup.close();
      }
      expect(
        resumed.database.prepare("SELECT value FROM startup_v11_probe").get(),
      ).toEqual({ value: "survives resumed migration" });
      expect(
        resumed.database
          .prepare(
            `
              SELECT 1
              FROM sqlite_master
              WHERE type = 'table'
                AND name = 'agent_connection_setting_preferences'
            `,
          )
          .get(),
      ).toEqual({ "1": 1 });
    } finally {
      resumed.database.close();
    }
  });

  it("backs up v9 before explicit import and ignores later file edits on restart", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const databasePath = path.join(stateDirectory, "overlay.sqlite");
    const deployed = openOverlayDatabase(databasePath);
    deployed.exec(`
      CREATE TABLE startup_probe(value TEXT NOT NULL) STRICT;
      INSERT INTO startup_probe VALUES ('survives startup migration');
    `);
    deployed.close();

    const first = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: true,
      now: 1_800_000_000_100,
    });
    expect(version(first.database)).toBe(latestBackendNormalizedVersion);
    expect(first.backupPath).not.toBeNull();
    const backupPath = first.backupPath!;
    first.database.close();

    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(version(backup)).toBe(9);
      expect(backup.prepare("SELECT value FROM startup_probe").get()).toEqual({
        value: "survives startup migration",
      });
    } finally {
      backup.close();
    }

    const changedConfiguration = {
      ...configuration,
      backends: [
        {
          ...configuration.backends[0],
          label: "Renamed Primary Pi",
        },
      ],
      targets: [
        {
          ...configuration.targets[0],
          label: "Renamed Local Pi SDK",
        },
      ],
    };
    await writeFile(
      configurationPath,
      JSON.stringify(changedConfiguration),
      "utf8",
    );
    await expect(prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true, quiescentCutoverConfirmed: true,
    })).rejects.toThrow("different source");
    const restarted = await prepareBackendNormalizedDatabase({
      stateDirectory, locksHeld: true, quiescentCutoverConfirmed: false,
      now: 1_800_000_000_200,
    });
    try {
      const scope = new SingleUserIdentityProvider(restarted.database).getScope();
      expect(restarted.backupPath).toBeNull();
      expect(restarted.prunedBackupPaths).toEqual([]);
      expect(
        restarted.database
          .prepare(
            `
              SELECT label, configuration_revision AS revision
              FROM agent_backend_instances
              WHERE tenant_id = ? AND id = 'pi-primary'
            `,
          )
          .get(scope.tenantId),
      ).toEqual({ label: "Primary Pi", revision: 1 });
      expect(
        restarted.database
          .prepare(
            `
              SELECT label, configuration_revision AS revision
              FROM agent_connection_profiles
              WHERE tenant_id = ?
                AND owner_principal_id = ?
                AND template_id = 'local-primary'
            `,
          )
          .get(scope.tenantId, scope.principalId),
      ).toEqual({ label: "Local Pi SDK", revision: 0 });
    } finally {
      restarted.database.close();
    }
  });

  it("backs up an older schema before applying any intermediate migration", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const databasePath = path.join(stateDirectory, "overlay.sqlite");
    const deployed = openOverlayDatabaseConnection(databasePath);
    applyDatabaseMigrations(deployed, deployedMigrations.slice(0, 3));
    deployed.exec(`
      CREATE TABLE startup_v3_probe(value TEXT NOT NULL) STRICT;
      INSERT INTO startup_v3_probe VALUES ('preserved before migration');
    `);
    deployed.close();

    const result = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: true,
      now: 1_800_000_000_300,
    });
    try {
      expect(version(result.database)).toBe(latestBackendNormalizedVersion);
      expect(result.backupPath).toMatch(
        /backups\/overlay-schema-v3-1800000000300-/,
      );
      const backup = new Database(result.backupPath!, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(version(backup)).toBe(3);
        expect(
          backup.prepare("SELECT value FROM startup_v3_probe").get(),
        ).toEqual({ value: "preserved before migration" });
        expect(
          backup
            .prepare(
              `
                SELECT 1
                FROM schema_migrations
                WHERE version > 3
              `,
            )
            .get(),
        ).toBeUndefined();
      } finally {
        backup.close();
      }
    } finally {
      result.database.close();
    }
  });

  it("requires explicit quiescent confirmation only for an existing pre-v10 database", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    const databasePath = path.join(stateDirectory, "overlay.sqlite");
    const deployed = openOverlayDatabase(databasePath);
    deployed.close();

    await expect(
      prepareBackendNormalizedDatabase({
        stateDirectory,
        legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
        locksHeld: true,
        quiescentCutoverConfirmed: false,
      }),
    ).rejects.toThrow("quiescent old server");
    const unchanged = openOverlayDatabaseConnection(databasePath);
    expect(version(unchanged)).toBe(9);
    unchanged.close();

    const migrated = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: true,
    });
    migrated.database.close();

    const restarted = await prepareBackendNormalizedDatabase({
      stateDirectory,
      legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
      locksHeld: true,
      quiescentCutoverConfirmed: false,
    });
    try {
      expect(version(restarted.database)).toBe(latestBackendNormalizedVersion);
      expect(restarted.backupPath).toBeNull();
    } finally {
      restarted.database.close();
    }
  });

  it("does not open SQLite when the maintenance boundary is unconfirmed", async () => {
    const { stateDirectory, configurationPath } = await fixtureRoot();
    await expect(
      prepareBackendNormalizedDatabase({
        stateDirectory,
        legacyImport: { localWorkspaceRoots: [stateDirectory], configuration: await loadResolvedConfiguration(configurationPath), sourceLabel: "test fixture" },
        locksHeld: false as true,
        quiescentCutoverConfirmed: true,
      }),
    ).rejects.toThrow(/lock/);
    await expect(
      access(path.join(stateDirectory, "overlay.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(configurationPath, "utf8")).toContain("pi-primary");
  });
});
