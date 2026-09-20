import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executionEnvironmentOperationsConfigurationMigration } from "../../src/server/db/migrations/045-execution-environment-operations-configuration.js";

const DISABLED_OPERATIONS_FINGERPRINT =
  "c7fe75f8261071c4c1bc7a9219514e59501c1102c43ba064f2d062d975409a68";

describe("execution-environment operations configuration migration", () => {
  it("seeds a disabled independent operations generation with strict bounds", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE execution_environments (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
          label TEXT NOT NULL,
          availability TEXT NOT NULL,
          diagnostic_code TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          configuration_revision INTEGER NOT NULL DEFAULT 0,
          configuration_fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;

        INSERT INTO execution_environments VALUES
          ('tenant', 'principal', 'local', 'local', 'Local', 'available',
           NULL, 4, 7,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           1, 1),
          ('tenant', 'principal', 'ssh', 'ssh', 'srv', 'unavailable',
           'ssh_environment_not_validated', 3, 9,
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           1, 1);
      `);

      database.exec(executionEnvironmentOperationsConfigurationMigration.sql);

      expect(
        database
          .prepare(
            `SELECT id,
              operations_configuration_revision AS revision,
              operations_configuration_fingerprint AS fingerprint
             FROM execution_environments ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "local",
          revision: 0,
          fingerprint: DISABLED_OPERATIONS_FINGERPRINT,
        },
        {
          id: "ssh",
          revision: 0,
          fingerprint: DISABLED_OPERATIONS_FINGERPRINT,
        },
      ]);

      expect(() =>
        database
          .prepare(
            `UPDATE execution_environments
             SET operations_configuration_revision = -1
             WHERE id = 'ssh'`,
          )
          .run(),
      ).toThrow(/constraint/i);
      expect(() =>
        database
          .prepare(
            `UPDATE execution_environments
             SET operations_configuration_fingerprint = ?
             WHERE id = 'ssh'`,
          )
          .run("A".repeat(64)),
      ).toThrow(/constraint/i);
      expect(() =>
        database
          .prepare(
            `UPDATE execution_environments
             SET operations_configuration_fingerprint = ?
             WHERE id = 'ssh'`,
          )
          .run("a".repeat(63)),
      ).toThrow(/constraint/i);
    } finally {
      database.close();
    }
  });
});
