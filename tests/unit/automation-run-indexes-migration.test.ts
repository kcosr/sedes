import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function indexShape(database: Database.Database, table: string, name: string) {
  const listed = (
    database.prepare(`PRAGMA index_list(${table})`).all() as {
      name: string;
      unique: number;
      partial: number;
    }[]
  ).find((index) => index.name === name);
  const sql = (
    database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get(name) as { sql: string } | undefined
  )?.sql;
  return {
    unique: listed?.unique,
    partial: listed?.partial,
    columns: database.prepare(`PRAGMA index_xinfo(${name})`).all(),
    where: sql?.slice(sql.indexOf(" WHERE ")).replace(/\s+/g, " "),
  };
}

function plan(database: Database.Database, sql: string): string {
  const parameters = sql.match(/\?/g)?.length ?? 0;
  return (
    database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: parameters }, () => "x")) as {
      detail: string;
    }[]
  )
    .map(({ detail }) => detail)
    .join("\n");
}

describe("automation run index migration", () => {
  it("drops only an exactly duplicated one-per-thread index", () => {
    const { database } = savedAgentDatabase(134);
    try {
      const live = indexShape(
        database,
        "automation_definitions",
        "automation_definitions_one_per_thread",
      );
      const duplicate = indexShape(
        database,
        "automation_definitions",
        "automation_definitions_v10_one_per_thread",
      );
      expect(live).toMatchObject({ unique: 1, partial: 1 });
      expect(live.where).toBe(" WHERE deleted_at IS NULL");
      expect(duplicate).toEqual(live);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      const names = (
        database
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'index'
               AND tbl_name IN ('automation_definitions', 'automation_runs')
               AND sql IS NOT NULL
             ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map(({ name }) => name);
      expect(names).toContain("automation_definitions_one_per_thread");
      expect(names).toContain("automation_runs_anchor_state");
      expect(names).toContain("automation_runs_state_history");
      expect(names).not.toContain("automation_definitions_v10_one_per_thread");
      expect(names).not.toContain("automation_runs_application_summary_latest");
      expect(
        indexShape(
          database,
          "automation_definitions",
          "automation_definitions_one_per_thread",
        ),
      ).toEqual(live);
    } finally {
      database.close();
    }
  });

  it("serves anchor checks, run filters, counts and the latest run from indexes", () => {
    const { database } = savedAgentDatabase();
    try {
      // Archive and snooze admission checks.
      expect(
        plan(
          database,
          `SELECT 1 FROM automation_runs
           WHERE tenant_id = ? AND owner_principal_id = ? AND anchor_thread_id = ?
             AND state IN ('claimed', 'dispatching', 'queued', 'running', 'uncertain')
           LIMIT 1`,
        ),
      ).toContain("USING COVERING INDEX automation_runs_anchor_state");
      // A single-state filter pages in index order without sorting.
      const skipped = plan(
        database,
        `SELECT id FROM automation_runs
         WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ?
           AND state = ?
         ORDER BY created_at DESC, id DESC LIMIT 26`,
      );
      expect(skipped).toContain("automation_runs_state_history");
      expect(skipped).not.toContain("TEMP B-TREE");
      // First-page counts read only the index.
      expect(
        plan(
          database,
          `SELECT count(*), sum(state = 'skipped') FROM automation_runs
           WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ?`,
        ),
      ).toContain("USING COVERING INDEX automation_runs_state_history");
      // The correlated latest-run lookup follows the history order.
      expect(
        plan(
          database,
          `SELECT id FROM automation_runs
           WHERE tenant_id = ? AND owner_principal_id = ? AND automation_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        ),
      ).toContain("USING COVERING INDEX automation_runs_history");
    } finally {
      database.close();
    }
  });
});
