import type { DatabaseMigration } from "../migrate.js";

/**
 * Fork publication now depends on provider-native lineage and the durable
 * Sedes creation attempt. The former model-visible boundary was auxiliary
 * state, so dropping it also makes pre-cutover pending/applying/unknown forks
 * recoverable without operator database edits.
 */
export const nativeForkLineageMigration: DatabaseMigration = {
  version: 70,
  name: "native-fork-lineage",
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER conversation_creation_attempts_boundary_pair_insert;
DROP TRIGGER conversation_creation_attempts_boundary_pair_update;
DROP TRIGGER conversation_creation_attempts_boundary_transition;
DROP TRIGGER conversation_creation_attempts_boundary_bound_insert;
DROP TRIGGER conversation_creation_attempts_boundary_bound_update;

ALTER TABLE conversation_creation_attempts
  DROP COLUMN fork_context_boundary_state;
ALTER TABLE conversation_creation_attempts
  DROP COLUMN fork_context_boundary_version;
`,
};
