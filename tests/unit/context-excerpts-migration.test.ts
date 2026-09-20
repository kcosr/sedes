import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { contextExcerptsMigration } from "../../src/server/db/migrations/038-context-excerpts.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function schemaObjects(
  database: ReturnType<typeof openOverlayDatabase>,
  table: string,
) {
  return database
    .prepare(
      `
        SELECT type, name
        FROM sqlite_master
        WHERE tbl_name = ? AND type IN ('index', 'trigger')
          AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY type, name
      `,
    )
    .all(table);
}

describe("context excerpts migration", () => {
  it("rebuilds schema 36 without losing indexes or triggers", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 100,
      });
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          ({ version }) => version < contextExcerptsMigration.version,
        ),
      );

      const before = Object.fromEntries(
        [
          "prompt_stashes",
          "queued_inputs",
          "conversation_creation_attempts",
          "automation_runs",
        ].map((table) => [table, schemaObjects(database, table)]),
      );
      const submissionForeignKeys = database.pragma(
        "foreign_key_list(pi_submission_details)",
      );
      const queueForeignKeys = database.pragma(
        "foreign_key_list(queued_inputs)",
      );

      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          ({ version }) => version <= contextExcerptsMigration.version,
        ),
      );

      for (const [table, objects] of Object.entries(before)) {
        expect(schemaObjects(database, table)).toEqual(
          expect.arrayContaining(objects),
        );
      }
      expect(contextExcerptsMigration.requiresForeignKeysDisabled).toBe(true);
      expect(
        database.pragma("foreign_key_list(pi_submission_details)"),
      ).toEqual(submissionForeignKeys);
      expect(database.pragma("foreign_key_list(queued_inputs)")).toEqual(
        queueForeignKeys,
      );
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("requires usable stash, queue, and first-input content", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 100,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      database.pragma("foreign_keys = OFF");

      const insertStash = database.prepare(`
        INSERT INTO prompt_stashes(
          tenant_id, principal_id, thread_id, id, text, created_at,
          selected_skill_id, context_excerpts_json
        ) VALUES ('tenant', 'principal', 'thread', ?, '', 1, ?, ?)
      `);
      expect(() => insertStash.run("empty", null, "[]")).toThrow();
      expect(() => insertStash.run("skill", "skill-id", "[]")).not.toThrow();
      expect(() =>
        insertStash.run("note", null, '[{"note":"explain this"}]'),
      ).not.toThrow();

      const insertQueue = database.prepare(`
        INSERT INTO queued_inputs(
          tenant_id, owner_principal_id, id, application_thread_id,
          sequence, mutation_id, text, state, created_at,
          context_excerpts_json
        ) VALUES ('tenant', 'principal', ?, 'thread', ?, ?, ?, 'pending', 1, ?)
      `);
      expect(() => insertQueue.run("empty", 1, "m1", "", "[]")).toThrow();
      expect(() =>
        insertQueue.run("blank", 2, "m2", "  ", '[{"note":"  "}]'),
      ).toThrow();
      expect(() =>
        insertQueue.run("note", 3, "m3", "", '[{"note":"why"}]'),
      ).not.toThrow();

      const heavilyEscaped = JSON.stringify([
        { note: "persist", text: '"'.repeat(600_000) },
      ]);
      expect(Buffer.byteLength(heavilyEscaped)).toBeGreaterThan(524_288);
      expect(Buffer.byteLength(heavilyEscaped)).toBeLessThan(4_194_304);
      expect(() =>
        insertQueue.run("escaped", 4, "m4", "", heavilyEscaped),
      ).not.toThrow();

      const insertAttempt = database.prepare(`
        INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          initial_input_text, consumed_draft_revision,
          backend_creation_correlation, phase, prepared_at,
          initial_context_excerpts_json
        ) VALUES (
          'tenant', 'principal', 'thread', ?, ?, 'backend', 'profile',
          'environment', 'first_input', 'composer', ?, 1,
          'correlation', 'prepared', 1, ?
        )
      `);
      expect(() => insertAttempt.run("empty", "a1", "", "[]")).toThrow();
      expect(() =>
        insertAttempt.run("note", "a2", "", '[{"note":"why"}]'),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });
});
