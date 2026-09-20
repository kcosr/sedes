import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { terminalEndCleanupPhaseMigration } from "../../src/server/db/migrations/081-terminal-end-cleanup-phase.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("terminal End cleanup phase migration", () => {
  it("conservatively treats existing End markers as intent-only and Remove markers as ready", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE terminals(
        terminal_id TEXT PRIMARY KEY,
        delete_mutation_id TEXT,
        delete_operation_kind TEXT
      ) STRICT;
      INSERT INTO terminals VALUES ('end', 'mutation-end', 'terminal_end');
      INSERT INTO terminals VALUES ('remove', 'mutation-remove', 'terminal_delete');
      INSERT INTO terminals VALUES ('active', NULL, NULL);
    `);

    database.exec(terminalEndCleanupPhaseMigration.sql);

    expect(
      database.prepare(
        `SELECT terminal_id AS terminalId,
                delete_cleanup_confirmed AS cleanupConfirmed
         FROM terminals ORDER BY terminal_id`,
      ).all(),
    ).toEqual([
      { terminalId: "active", cleanupConfirmed: null },
      { terminalId: "end", cleanupConfirmed: 0 },
      { terminalId: "remove", cleanupConfirmed: 1 },
    ]);
  });
});
