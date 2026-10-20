import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAXIMUM_CACHED_STATEMENTS_PER_CONNECTION,
  prepareCached,
} from "../../src/server/db/prepared-statements.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const release of cleanup.splice(0)) release();
});

function open(filename = ":memory:") {
  const database = new Database(filename);
  cleanup.push(() => { if (database.open) database.close(); });
  database.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  return database;
}

describe("per-connection prepared statements", () => {
  it("prepares static SQL once per connection and binds parameters on every execution", () => {
    const database = open();
    const prepare = vi.spyOn(database, "prepare");
    const insert = "INSERT INTO entries (value) VALUES (?)";
    const select = "SELECT value FROM entries WHERE id = ?";
    prepareCached(database, insert).run("first");
    prepareCached(database, insert).run("second");
    expect(prepareCached(database, select).get(1)).toEqual({ value: "first" });
    expect(prepareCached(database, select).get(2)).toEqual({ value: "second" });
    expect(prepareCached(database, select)).toBe(prepareCached(database, select));
    expect(prepare).toHaveBeenCalledTimes(2);

    // Reads inside a transaction observe its uncommitted writes and its rollback.
    const transaction = database.transaction(() => {
      prepareCached(database, insert).run("rolled back");
      expect(prepareCached(database, select).get(3)).toEqual({ value: "rolled back" });
      throw new Error("rollback");
    });
    expect(transaction).toThrow("rollback");
    expect(prepareCached(database, select).get(3)).toBeUndefined();
  });

  it("keeps statements with their own connection across reopen and close", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sedes-prepared-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "state.sqlite");
    const sql = "SELECT count(*) AS count FROM entries";
    const first = open(filename);
    const firstStatement = prepareCached(first, sql);
    first.prepare("INSERT INTO entries (value) VALUES ('kept')").run();
    first.close();
    expect(() => prepareCached(first, sql)).toThrow(/not open/);

    const reopened = open(filename);
    const reopenedStatement = prepareCached(reopened, sql);
    expect(reopenedStatement).not.toBe(firstStatement);
    expect(reopenedStatement.get()).toEqual({ count: 1 });
    const other = open();
    expect(prepareCached(other, sql)).not.toBe(reopenedStatement);
    expect(prepareCached(other, sql).get()).toEqual({ count: 0 });
  });

  it("stops caching beyond the per-connection bound", () => {
    const database = open();
    for (let index = 0; index < MAXIMUM_CACHED_STATEMENTS_PER_CONNECTION; index += 1) {
      prepareCached(database, `SELECT ${index} AS value`);
    }
    const beyond = "SELECT 'beyond' AS value";
    expect(prepareCached(database, beyond)).not.toBe(prepareCached(database, beyond));
    expect(prepareCached(database, beyond).get()).toEqual({ value: "beyond" });
    expect(prepareCached(database, "SELECT 0 AS value")).toBe(prepareCached(database, "SELECT 0 AS value"));
  });
});
