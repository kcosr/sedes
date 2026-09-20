import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { piToolAccessAskMigration } from "../../src/server/db/migrations/019-pi-tool-access-ask.js";

describe("Pi tool-access ask migration", () => {
  it("rebuilds populated pi_thread_settings and accepts ask mode", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      database.exec(`
        CREATE TABLE application_threads (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, owner_principal_id, id)
        ) STRICT;
        INSERT INTO application_threads VALUES
          ('tenant', 'principal', 'full-thread'),
          ('tenant', 'principal', 'read-only-thread');
        CREATE TABLE pi_thread_settings (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          application_thread_id TEXT NOT NULL,
          model_provider TEXT,
          model_id TEXT,
          thinking_level TEXT CHECK (
            thinking_level IS NULL OR thinking_level IN (
              'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
            )
          ),
          tool_mode TEXT NOT NULL CHECK (tool_mode IN ('read_only', 'full')),
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
          FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
            REFERENCES application_threads(
              tenant_id, owner_principal_id, id
            ) ON DELETE RESTRICT,
          CHECK ((model_provider IS NULL) = (model_id IS NULL))
        ) STRICT;
        INSERT INTO pi_thread_settings VALUES
          ('tenant', 'principal', 'full-thread', 'openai', 'gpt', 'low', 'full', 3),
          ('tenant', 'principal', 'read-only-thread', NULL, NULL, NULL, 'read_only', 1);
      `);

      database.transaction(() => {
        database.exec(piToolAccessAskMigration.sql);
      })();

      expect(
        database
          .prepare(
            `
              SELECT application_thread_id AS threadId,
                model_provider AS modelProvider,
                model_id AS modelId,
                thinking_level AS thinkingLevel,
                tool_mode AS toolMode,
                revision
              FROM pi_thread_settings
              ORDER BY application_thread_id
            `,
          )
          .all(),
      ).toEqual([
        {
          threadId: "full-thread",
          modelProvider: "openai",
          modelId: "gpt",
          thinkingLevel: "low",
          toolMode: "full",
          revision: 3,
        },
        {
          threadId: "read-only-thread",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          toolMode: "read_only",
          revision: 1,
        },
      ]);

      database
        .prepare(
          `
            UPDATE pi_thread_settings
            SET tool_mode = 'ask', revision = revision + 1
            WHERE application_thread_id = 'full-thread'
          `,
        )
        .run();
      expect(
        database
          .prepare(
            `
              SELECT tool_mode AS toolMode, revision
              FROM pi_thread_settings
              WHERE application_thread_id = 'full-thread'
            `,
          )
          .get(),
      ).toEqual({ toolMode: "ask", revision: 4 });

      expect(() =>
        database
          .prepare(
            `
              UPDATE pi_thread_settings
              SET tool_mode = 'untrusted'
              WHERE application_thread_id = 'full-thread'
            `,
          )
          .run(),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      database.close();
    }
  });
});
