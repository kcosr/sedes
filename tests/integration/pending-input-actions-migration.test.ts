import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { pendingInputActionsMigration } from "../../src/server/db/migrations/042-pending-input-actions.js";

describe("pending-input actions migration", () => {
  it("stamps existing delivery state and migrates v3 draft Steer receipts to strict v4", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE queued_inputs (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          application_thread_id TEXT NOT NULL,
          state TEXT NOT NULL
        );
        CREATE TABLE mutation_receipts (
          operation_kind TEXT NOT NULL,
          result_json TEXT NOT NULL
        );
        INSERT INTO queued_inputs VALUES
          ('tenant', 'principal', 'pending', 'thread', 'pending'),
          ('tenant', 'principal', 'active', 'thread', 'dispatching'),
          ('tenant', 'principal', 'unknown', 'thread', 'uncertain');
      `);
      const v3 = {
        version: 3,
        applicationOperationId: "steer-operation",
        reconciliationToken: "steer-operation",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        selectedSkillId: null,
        contextExcerpts: [],
        expectedActiveTurnId: null,
      };
      database
        .prepare(
          "INSERT INTO mutation_receipts(operation_kind, result_json) VALUES ('conversation_steer', ?)",
        )
        .run(JSON.stringify(v3));

      database.exec(pendingInputActionsMigration.sql);

      expect(
        database
          .prepare(
            "SELECT id, delivery_mode AS deliveryMode FROM queued_inputs ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "active", deliveryMode: "submit" },
        { id: "pending", deliveryMode: null },
        { id: "unknown", deliveryMode: "submit" },
      ]);
      expect(
        JSON.parse(
          (
            database
              .prepare(
                "SELECT result_json AS resultJson FROM mutation_receipts",
              )
              .get() as { resultJson: string }
          ).resultJson,
        ),
      ).toEqual({ ...v3, version: 4, source: "draft" });
      expect(() =>
        database
          .prepare(
            "UPDATE queued_inputs SET delivery_mode = NULL WHERE id = 'active'",
          )
          .run(),
      ).toThrow("Queued input delivery mode is invalid");
      expect(() =>
        database
          .prepare(
            "UPDATE queued_inputs SET delivery_mode = 'steer' WHERE id = 'pending'",
          )
          .run(),
      ).toThrow("Queued input delivery mode is invalid");
      expect(
        backendNormalizedMigrations.find(
          ({ version }) => version === pendingInputActionsMigration.version,
        ),
      ).toBe(pendingInputActionsMigration);
    } finally {
      database.close();
    }
  });
});
