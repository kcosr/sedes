import { describe, expect, it } from "vitest";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("thread templates migration", () => {
  it("keeps only principal ownership as a foreign-key authority", () => {
    const current = savedAgentDatabase();
    try {
      expect(
        current.database
          .prepare(
            `SELECT "table", "from", "to", on_delete AS onDelete
             FROM pragma_foreign_key_list('thread_templates')`,
          )
          .all(),
      ).toEqual([
        {
          table: "principals",
          from: "tenant_id",
          to: "tenant_id",
          onDelete: "RESTRICT",
        },
        {
          table: "principals",
          from: "owner_principal_id",
          to: "id",
          onDelete: "RESTRICT",
        },
      ]);
      expect(
        current.database
          .prepare(
            "SELECT version, name FROM schema_migrations WHERE version = 74",
          )
          .get(),
      ).toEqual({ version: 74, name: "thread_templates" });
    } finally {
      current.database.close();
    }
  });
});
