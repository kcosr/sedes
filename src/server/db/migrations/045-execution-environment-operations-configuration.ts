import type { DatabaseMigration } from "../migrate.js";

/**
 * Gives optional execution-environment operations their own durable generation
 * fence. Existing rows begin with the explicit disabled-policy fingerprint so
 * enabling a sidecar cannot advance workspace or backend-channel authority.
 */
export const executionEnvironmentOperationsConfigurationMigration: DatabaseMigration =
  {
    version: 45,
    name: "execution-environment-operations-configuration",
    sql: `
ALTER TABLE execution_environments
  ADD COLUMN operations_configuration_revision INTEGER NOT NULL DEFAULT 0
  CHECK (operations_configuration_revision >= 0);

ALTER TABLE execution_environments
  ADD COLUMN operations_configuration_fingerprint TEXT NOT NULL
  DEFAULT 'c7fe75f8261071c4c1bc7a9219514e59501c1102c43ba064f2d062d975409a68'
  CHECK (
    length(operations_configuration_fingerprint) = 64
    AND operations_configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  );
`,
  } as const;
