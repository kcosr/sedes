import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { DatabaseMigration } from "../migrate.js";

export const forkEnvironmentFingerprintsMigration: DatabaseMigration = {
  version: 108,
  name: "fork_environment_fingerprints",
  verifyDatabaseIntegrity: true,
  preflight(database) {
    // An aborted fork has lost its child snapshot; a hash alone cannot recover
    // its original overrides. Preserve that receipt rather than inventing them.
    const unresolved = database.prepare(`SELECT 1 FROM aborted_thread_forks a
      JOIN environment_variable_fork_requests r ON r.tenant_id = a.tenant_id
        AND r.owner_principal_id = a.owner_principal_id
        AND r.mutation_id = a.creation_operation_id LIMIT 1`).get();
    if (unresolved) throw new Error("Cannot migrate an aborted fork with retained environment overrides.");
    database.function("sedes_thread_environment_fingerprint_108", { deterministic: true }, value => {
      if (typeof value !== "string") throw new Error("Missing thread environment snapshot.");
      const snapshot = JSON.parse(value);
      return configurationFingerprint(snapshot.layers.thread);
    });
  },
  sql: `
ALTER TABLE conversation_creation_attempts ADD COLUMN environment_variables_fingerprint TEXT NOT NULL
  DEFAULT '${configurationFingerprint({})}';
ALTER TABLE aborted_thread_forks ADD COLUMN environment_variables_fingerprint TEXT NOT NULL
  DEFAULT '${configurationFingerprint({})}';
UPDATE conversation_creation_attempts AS attempt
SET environment_variables_fingerprint = (
  SELECT sedes_thread_environment_fingerprint_108(thread.environment_variables_json)
  FROM application_threads AS thread
  WHERE thread.tenant_id = attempt.tenant_id
    AND thread.owner_principal_id = attempt.owner_principal_id
    AND thread.id = attempt.application_thread_id
)
WHERE attempt.creation_kind = 'fork' AND EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id = attempt.tenant_id
    AND thread.owner_principal_id = attempt.owner_principal_id
    AND thread.id = attempt.application_thread_id
    AND json_extract(thread.environment_variables_json, '$.layers.thread') <> '{}'
);
DROP TABLE environment_variable_fork_requests;
`,
};
