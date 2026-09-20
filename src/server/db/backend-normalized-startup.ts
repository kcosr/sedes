import path from "node:path";
import type Database from "better-sqlite3";
import { convertLegacyConfiguration, type LegacyConfigurationImport } from "../config/legacy-configuration-import.js";
import { ConfigurationRepository } from "../configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../configuration-admin/configuration-projection.js";
import { SingleUserIdentityProvider } from "../identity/identity-provider.js";
import { compiledBackendModuleCatalog } from "../backends/compiled-module-catalog.js";
import { openOverlayDatabaseConnection } from "./database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
  migrateDatabase,
  initializeEmptyBackendNormalizedDatabase,
} from "./migrate.js";
import {
  createPreMigrationBackup,
  prunePreMigrationBackups,
} from "./pre-migration-backup.js";

const DEPLOYED_SCHEMA_VERSION = deployedMigrations.at(-1)!.version;
const NORMALIZED_SCHEMA_VERSION = backendNormalizedMigrations.at(-1)!.version;

export interface BackendNormalizedStartupInput {
  /** The caller holds exclusive installation state ownership. */
  readonly stateDirectory: string;
  readonly locksHeld: true;
  readonly quiescentCutoverConfirmed: boolean;
  /** Only the explicit offline import command supplies file configuration. */
  readonly legacyImport?: LegacyConfigurationImport;
  readonly now?: number;
}

export interface BackendNormalizedStartupResult {
  readonly database: Database.Database;
  readonly backupPath: string | null;
  readonly prunedBackupPaths: readonly string[];
}

function latestAppliedVersion(database: Database.Database): number {
  const migrationsTable = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!migrationsTable) return 0;
  return (
    database
      .prepare(
        "SELECT coalesce(max(version), 0) AS version FROM schema_migrations",
      )
      .get() as { readonly version: number }
  ).version;
}

/** Migrates schema under exclusive ownership; never reconciles a file on restart. */
export async function prepareBackendNormalizedDatabase(
  input: BackendNormalizedStartupInput,
): Promise<BackendNormalizedStartupResult> {
  if (input.locksHeld !== true) {
    throw new Error(
      "Backend-normalized startup requires the Sedes state lock.",
    );
  }
  if (!path.isAbsolute(input.stateDirectory)) {
    throw new Error("The Sedes state directory must be an absolute path.");
  }

  // Validate before opening/mutating state, including unsupported topology consent.
  const converted = input.legacyImport ? convertLegacyConfiguration(input.legacyImport) : undefined;
  const databasePath = path.join(
    path.resolve(input.stateDirectory),
    "overlay.sqlite",
  );
  const database = openOverlayDatabaseConnection(databasePath);
  const now = input.now ?? Date.now();
  let backupPath: string | null = null;
  let prunedBackupPaths: readonly string[] = [];

  try {
    const initialVersion = latestAppliedVersion(database);
    if (initialVersion > NORMALIZED_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${initialVersion} is newer than supported version ${NORMALIZED_SCHEMA_VERSION}.`,
      );
    }

    if (
      initialVersion > 0 &&
      initialVersion <= DEPLOYED_SCHEMA_VERSION &&
      input.quiescentCutoverConfirmed !== true
    ) {
      throw new Error(
        "Backend-normalized startup requires a quiescent old server with an empty in-memory Pi queue.",
      );
    }
    if (initialVersion > 0 && initialVersion < NORMALIZED_SCHEMA_VERSION) {
      backupPath = await createPreMigrationBackup({
        database,
        stateDirectory: input.stateDirectory,
        sourceSchemaVersion: initialVersion,
        now,
      });
      prunedBackupPaths = await prunePreMigrationBackups(input.stateDirectory, {
        now,
      });
    }
    if (initialVersion === 0) {
      initializeEmptyBackendNormalizedDatabase(database);
    } else if (initialVersion <= DEPLOYED_SCHEMA_VERSION) {
      if (!input.legacyImport) throw new Error("Legacy state requires an explicit configuration:import with --quiescent-cutover-confirmed before startup.");
      migrateDatabase(database);
      applyBackendNormalizationMigration(database, {
        configuration: input.legacyImport.configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: now,
      });
    }
    // Schema 010 requires transaction-local cutover context and reaches the
    // prior normalized schema. Later ordinary migrations, including migrations
    // that must temporarily disable foreign-key enforcement before beginning
    // their own transaction, run only after that cutover has committed.
    applyDatabaseMigrations(database, backendNormalizedMigrations);

    if (latestAppliedVersion(database) !== NORMALIZED_SCHEMA_VERSION) {
      throw new Error(
        `Backend-normalized startup did not reach schema version ${NORMALIZED_SCHEMA_VERSION}.`,
      );
    }
    if (!converted && database.prepare("SELECT 1 FROM agent_backend_instances WHERE owner_principal_id IS NULL LIMIT 1").get()) {
      throw new Error("Existing execution configuration requires an explicit configuration:import before startup. Database history is retained; no file is loaded automatically.");
    }
    if (converted && input.legacyImport) {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const repository = new ConfigurationRepository(database, () => now);
      const catalog = compiledBackendModuleCatalog;
      const projection = new ConfigurationProjection(database, {
        pi: catalog.protocolReleaseForBackendKind("pi"),
        codex_app_server: catalog.protocolReleaseForBackendKind("codex_app_server"),
        claude_agent_sdk: catalog.protocolReleaseForBackendKind("claude_agent_sdk"),
        grok_build: catalog.protocolReleaseForBackendKind("grok_build"),
      }, () => now);
      repository.initialize(scope, converted.document, { sourceFingerprint: converted.sourceFingerprint, sourceLabel: input.legacyImport.sourceLabel }, () => {
        projection.adoptLegacyOwnership(scope);
        projection.project(scope, converted.document);
        for (const backend of converted.document.backends) {
          if (backend.kind !== "codex_app_server") continue;
          const connection = backend.moduleConfiguration.connection;
          if (connection.ownership !== "external" || connection.channel.type !== "tcp_websocket") continue;
          const target = converted.document.targets.find(candidate => candidate.backendInstanceId === backend.id)!;
          repository.approveSecret(scope, target.executionEnvironmentId, connection.channel.authentication.secret);
        }
      });
    }
    return {
      database,
      backupPath,
      prunedBackupPaths,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
