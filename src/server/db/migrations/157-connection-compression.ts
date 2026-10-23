import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { DatabaseMigration } from "../migrate.js";

type StoredObject = Record<string, unknown>;

function object(value: unknown): StoredObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("connection_compression_migration_invalid_object");
  }
  return value as StoredObject;
}

/** Frozen conversion of the pre-157 configuration document and receipt shapes. */
function migrateDocument(value: unknown): void {
  const document = object(value);
  if (!Array.isArray(document.executionEnvironments)) {
    throw new Error("connection_compression_migration_invalid_environments");
  }
  for (const value of document.executionEnvironments) {
    const environment = object(value);
    if (environment.kind === "ssh" || environment.kind === "outbound") {
      if (environment.connectionCompression === undefined) environment.connectionCompression = true;
      else if (typeof environment.connectionCompression !== "boolean") {
        throw new Error("connection_compression_migration_invalid_policy");
      }
    }
  }
}

function migrateStoredJson(json: string, nesting: number): string {
  const value: unknown = JSON.parse(json);
  let document = value;
  for (let index = 0; index < nesting; index++) document = object(document).configuration;
  migrateDocument(document);
  return JSON.stringify(value);
}

export const connectionCompressionMigration: DatabaseMigration = {
  version: 157,
  name: "connection_compression",
  preflight(database) {
    database.function("sedes_connection_compression_157", { deterministic: true }, migrateStoredJson);
    database.function("sedes_configuration_fingerprint_157", { deterministic: true },
      (json: string) => configurationFingerprint(JSON.parse(json)));
  },
  sql: `
UPDATE principal_execution_configuration
SET configuration_json = sedes_connection_compression_157(configuration_json, 0);

UPDATE execution_configuration_receipts
SET request_json = sedes_connection_compression_157(request_json, 1),
    result_json = sedes_connection_compression_157(result_json, 1)
WHERE operation = 'save';

UPDATE execution_configuration_receipts
SET request_fingerprint = sedes_configuration_fingerprint_157(request_json)
WHERE operation = 'save';

-- Pairing requests contain no configuration; preserve their request digests.
UPDATE host_pairing_receipts
SET result_json = sedes_connection_compression_157(result_json, 2)
WHERE operation IN ('accept', 'revoke', 'reapprove');
`,
};
