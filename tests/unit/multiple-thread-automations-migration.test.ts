import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const compactSql = (sql: string) => sql.replace(/[\s"]/g, "");

function tableChecks(sql: string): string[] {
  const checks: string[] = [];
  for (const match of sql.matchAll(/CHECK\s*\(/gi)) {
    let depth = 1;
    let end = match.index! + match[0].length;
    for (; depth > 0 && end < sql.length; end++) {
      if (sql[end] === "(") depth++;
      else if (sql[end] === ")") depth--;
    }
    const check = sql.slice(match.index, end);
    if (!check.includes("automation_context_")) checks.push(compactSql(check));
  }
  return checks.sort();
}

function principalStateSchema(database: Database.Database) {
  const columns = database.pragma("table_info(thread_principal_state)") as {
    cid: number;
    name: string;
  }[];
  const objects = database
    .prepare(
      `SELECT type,name,sql FROM sqlite_schema
       WHERE tbl_name='thread_principal_state' ORDER BY type,name`,
    )
    .all() as { type: string; name: string; sql: string | null }[];
  const table = objects.find(({ type }) => type === "table")!;
  const foreignKeys = database.pragma(
    "foreign_key_list(thread_principal_state)",
  ) as { id: number; from: string }[];
  const obsoleteKeyIds = new Set(
    foreignKeys
      .filter((key) => key.from.startsWith("automation_context_"))
      .map(({ id }) => id),
  );
  const externalForeignKeys = (
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).flatMap(({ name }) =>
    (database.pragma(`foreign_key_list(${name})`) as { table: string }[])
      .filter((key) => key.table === "thread_principal_state")
      .map((key) => ({ name, ...key })),
  );
  return {
    columns: columns
      .filter(({ name }) => !name.startsWith("automation_context_"))
      .map(({ cid: _cid, ...column }) => column),
    checks: tableChecks(table.sql!),
    objects: objects
      .filter(({ type }) => type !== "table")
      .map((object) => ({
        ...object,
        sql: object.sql === null ? null : compactSql(object.sql),
      })),
    foreignKeys: foreignKeys
      .filter(({ id }) => !obsoleteKeyIds.has(id))
      .map(({ id: _id, ...key }) => key),
    externalForeignKeys,
  };
}

describe("multiple thread automations migration", () => {
  it("removes only legacy principal attention state and preserves its schema dependencies", () => {
    const { database } = savedAgentDatabase(145);
    try {
      const prior = principalStateSchema(database);
      expect(prior.columns).toHaveLength(18);
      expect(
        prior.objects.filter(({ type }) => type === "trigger"),
      ).toHaveLength(3);
      expect(
        new Set(prior.externalForeignKeys.map(({ name }) => name)).size,
      ).toBe(11);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      expect(principalStateSchema(database)).toEqual(prior);
      expect(
        database.pragma("table_info(thread_principal_state)"),
      ).toHaveLength(18);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("legacy_alter_table", { simple: true })).toBe(0);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%_v146%'")
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});
