import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { forkContextBoundaryMigration } from "../../src/server/db/migrations/023-fork-context-boundary.js";

describe("fork context boundary migration", () => {
  it("requires schema-22 user forks to be quiescent", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE conversation_creation_attempts (
          id TEXT PRIMARY KEY,
          creation_kind TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          phase TEXT NOT NULL
        ) STRICT;
        INSERT INTO conversation_creation_attempts VALUES
          ('active-user', 'fork', 'user_fork', 'recovery_required');
      `);

      expect(() =>
        database.transaction(() => {
          database.exec(forkContextBoundaryMigration.sql);
        })(),
      ).toThrow(/Resolve active user forks/);
    } finally {
      database.close();
    }
  });

  it("leaves completed historical and automation attempts unversioned", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE conversation_creation_attempts (
          id TEXT PRIMARY KEY,
          creation_kind TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          phase TEXT NOT NULL
        ) STRICT;
        INSERT INTO conversation_creation_attempts VALUES
          ('bound-user', 'fork', 'user_fork', 'bound'),
          ('active-automation', 'fork', 'automation', 'recovery_required'),
          ('composer', 'first_input', 'composer', 'prepared');
      `);
      database.transaction(() => {
        database.exec(forkContextBoundaryMigration.sql);
      })();
      expect(
        database
          .prepare(
            `SELECT id, fork_context_boundary_version AS version,
              fork_context_boundary_state AS state
             FROM conversation_creation_attempts ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "active-automation", version: null, state: null },
        { id: "bound-user", version: null, state: null },
        { id: "composer", version: null, state: null },
      ]);
    } finally {
      database.close();
    }
  });
});
