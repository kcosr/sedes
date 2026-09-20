import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { nativeForkLineageMigration } from "../../src/server/db/migrations/070-native-fork-lineage.js";

describe("native fork lineage migration", () => {
  it.each(["pending", "applying", "applied", "unknown"] as const)(
    "removes obsolete %s boundary state without blocking the creation attempt",
    (state) => {
      const database = new Database(":memory:");
      try {
        database.exec(`
          CREATE TABLE conversation_creation_attempts (
            id TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            provisional_backend_conversation_id TEXT,
            fork_context_boundary_version INTEGER,
            fork_context_boundary_state TEXT
          ) STRICT;
          INSERT INTO conversation_creation_attempts VALUES
            ('fork', 'recovery_required', 'native-child', 1, '${state}');

          CREATE TRIGGER conversation_creation_attempts_boundary_pair_insert
            BEFORE INSERT ON conversation_creation_attempts BEGIN SELECT 1; END;
          CREATE TRIGGER conversation_creation_attempts_boundary_pair_update
            BEFORE UPDATE ON conversation_creation_attempts BEGIN SELECT 1; END;
          CREATE TRIGGER conversation_creation_attempts_boundary_transition
            BEFORE UPDATE ON conversation_creation_attempts BEGIN SELECT 1; END;
          CREATE TRIGGER conversation_creation_attempts_boundary_bound_insert
            BEFORE INSERT ON conversation_creation_attempts BEGIN SELECT 1; END;
          CREATE TRIGGER conversation_creation_attempts_boundary_bound_update
            BEFORE UPDATE ON conversation_creation_attempts BEGIN SELECT 1; END;
        `);

        database.exec(nativeForkLineageMigration.sql);

        expect(
          database
            .prepare(
              `SELECT id, phase,
                provisional_backend_conversation_id AS backendConversationId
               FROM conversation_creation_attempts`,
            )
            .get(),
        ).toEqual({
          id: "fork",
          phase: "recovery_required",
          backendConversationId: "native-child",
        });
        expect(
          database
            .prepare(`PRAGMA table_info(conversation_creation_attempts)`)
            .all()
            .map((column) => (column as { readonly name: string }).name),
        ).not.toEqual(
          expect.arrayContaining([
            "fork_context_boundary_version",
            "fork_context_boundary_state",
          ]),
        );
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'trigger' AND name LIKE '%boundary%'`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        database.close();
      }
    },
  );
});
