import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

/** A table rebuild must preserve unrelated commit-time admission guards. */
describe("Steer target migration", () => {
  it("preserves the existing queue indexes and triggers when rebuilding schema 100", () => {
    const { database } = savedAgentDatabase(100);
    try {
      const objects = () => database.prepare(`SELECT name, type FROM sqlite_schema
        WHERE tbl_name = 'queued_inputs' AND type IN ('trigger', 'index') AND sql IS NOT NULL
        ORDER BY type, name`).all();
      const before = objects();
      expect(before).toContainEqual({ name: "queued_inputs_project_admission", type: "trigger" });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(objects()).toEqual(before);
    } finally { database.close(); }
  });
});
