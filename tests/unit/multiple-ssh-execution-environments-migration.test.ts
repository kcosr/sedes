import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { multipleSshExecutionEnvironmentsMigration } from "../../src/server/db/migrations/031-multiple-ssh-execution-environments.js";

describe("multiple SSH execution-environments migration", () => {
  it("allows more than one SSH environment per principal after rebuild", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = OFF");
    try {
      database.exec(`
        CREATE TABLE principals (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        CREATE TABLE execution_environments (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
          label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
          availability TEXT NOT NULL
            CHECK (availability IN ('available', 'unavailable')),
          diagnostic_code TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          configuration_revision INTEGER NOT NULL DEFAULT 0,
          configuration_fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, id),
          UNIQUE (tenant_id, owner_principal_id, id),
          UNIQUE (tenant_id, owner_principal_id, kind)
        ) STRICT;
        INSERT INTO principals VALUES ('tenant', 'principal');
        INSERT INTO execution_environments VALUES (
          'tenant', 'principal', 'local-env', 'local', 'Local', 'available',
          NULL, 0, 0,
          'd3f0bfcd1798ce2a4629a58cc83841b244beae89f2c868938fd77ce439649708',
          1, 1
        );
        INSERT INTO execution_environments VALUES (
          'tenant', 'principal', 'ssh-a', 'ssh', 'srv', 'available',
          NULL, 0, 0,
          '0d42706dd2444fb204f6caf4e28ebceb8a948d63a49907d82509a06cbfa681b1',
          1, 1
        );
      `);
      expect(() =>
        database
          .prepare(
            `
              INSERT INTO execution_environments VALUES (
                'tenant', 'principal', 'ssh-b', 'ssh', 'other', 'available',
                NULL, 0, 0,
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                1, 1
              )
            `,
          )
          .run(),
      ).toThrow(/UNIQUE|constraint/i);

      database.exec(multipleSshExecutionEnvironmentsMigration.sql);

      database
        .prepare(
          `
            INSERT INTO execution_environments VALUES (
              'tenant', 'principal', 'ssh-b', 'ssh', 'other', 'available',
              NULL, 0, 0,
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              1, 1
            )
          `,
        )
        .run();
      const rows = database
        .prepare(
          `
            SELECT id, kind FROM execution_environments
            WHERE tenant_id = 'tenant' AND owner_principal_id = 'principal'
            ORDER BY id
          `,
        )
        .all();
      expect(rows).toEqual([
        { id: "local-env", kind: "local" },
        { id: "ssh-a", kind: "ssh" },
        { id: "ssh-b", kind: "ssh" },
      ]);
    } finally {
      database.close();
    }
  });
});
