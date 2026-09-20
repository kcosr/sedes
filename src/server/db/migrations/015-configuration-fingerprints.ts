export const configurationFingerprintsMigration = {
  version: 15,
  name: "configuration_fingerprints",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE agent_backend_instances
ADD COLUMN configuration_fingerprint TEXT NOT NULL
  DEFAULT 'f471c5e060149174c084464b55b3b5d9165e7569b2b0df609df732ced3cd06c7'
  CHECK (
    length(configuration_fingerprint) = 64
    AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  );

ALTER TABLE agent_connection_profiles
ADD COLUMN configuration_fingerprint TEXT NOT NULL
  DEFAULT 'f471c5e060149174c084464b55b3b5d9165e7569b2b0df609df732ced3cd06c7'
  CHECK (
    length(configuration_fingerprint) = 64
    AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'
  );
`,
} as const;
