import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { DatabaseMigration } from "../migrate.js";

/** Frozen schema-93 identity conversion, applied once while startup is offline. */
function migrateIdentity(configuration: string, id: string, stored: string): string {
  const document = JSON.parse(configuration) as {
    backends: { id: string; kind: string; moduleConfiguration?: { connection: {
      channel: { type: string; codexHome?: string; socketPath?: string; url?: string };
    } } }[];
    targets: { backendInstanceId: string; executionEnvironmentId: string }[];
  };
  const backend = document.backends.find(candidate => candidate.id === id);
  if (backend?.kind !== "codex_app_server") return stored;
  const connection = backend.moduleConfiguration?.connection;
  if (!connection) throw new Error("codex_configuration_identity_migration_invalid_definition");
  const environmentId = document.targets.find(target => target.backendInstanceId === id)?.executionEnvironmentId ?? null;
  const previous = configurationFingerprint({ kind: backend.kind, environmentId, nativeIdentity: connection });
  if (previous !== stored) throw new Error("codex_configuration_identity_migration_conflict");
  const channel = connection.channel;
  const nativeIdentity = channel.type === "process_stdio" ? { type: "process_stdio", codexHome: channel.codexHome ?? null }
    : channel.type === "unix_websocket" ? { type: "unix_websocket", socketPath: channel.socketPath }
    : channel.type === "tcp_websocket" ? { type: "tcp_websocket", url: channel.url } : undefined;
  if (!nativeIdentity) throw new Error("codex_configuration_identity_migration_invalid_channel");
  return configurationFingerprint({ kind: backend.kind, environmentId, nativeIdentity });
}

export const codexConfigurationStoreIdentityMigration: DatabaseMigration = {
  version: 96,
  name: "codex_configuration_store_identity",
  preflight(database) {
    database.function("sedes_codex_store_identity_096", { deterministic: true }, migrateIdentity);
  },
  sql: `
-- Require proof of the old complete-connection fingerprint before narrowing it.
-- Removed definitions remain permanently reserved: their native identity cannot
-- be reconstructed from a digest and must never be guessed during migration.
UPDATE execution_configuration_identities AS identity
SET identity_fingerprint = sedes_codex_store_identity_096(
  (SELECT configuration_json FROM principal_execution_configuration AS configuration
   WHERE configuration.tenant_id = identity.tenant_id
     AND configuration.owner_principal_id = identity.owner_principal_id),
  identity.resource_id, identity.identity_fingerprint)
WHERE resource_kind = 'backend' AND EXISTS (
  SELECT 1 FROM principal_execution_configuration AS configuration
  WHERE configuration.tenant_id = identity.tenant_id
    AND configuration.owner_principal_id = identity.owner_principal_id
);
`,
};
