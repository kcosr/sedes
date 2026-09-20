import { describe, expect, it } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { removeInteractionTimersMigration } from "../../src/server/db/migrations/041-remove-interaction-timers.js";

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

function resultJson(
  operationId: string,
  resolution: "explicit" | "auto",
): string {
  return JSON.stringify({
    version: 1,
    applicationOperationId: operationId,
    interactionId: `browser-${operationId}`,
    response: {
      kind: "questionnaire",
      answers: [
        {
          questionId: "browser-question",
          answer: { kind: "unanswered" },
        },
      ],
    },
    backendResponse: {
      applicationOperationId: operationId,
      interactionId: `backend-${operationId}`,
      kind: "questionnaire",
      resolution,
      answers: [
        {
          questionId: "backend-question",
          answer: { kind: "unanswered" },
        },
      ],
    },
  });
}

describe("remove interaction timers migration", () => {
  it("preserves explicit recovery and retires synthetic auto-responses", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 100,
      });
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(({ version }) => version < 41),
      );
      database.pragma("foreign_keys = OFF");

      const insert = database.prepare(`
        INSERT INTO mutation_receipts(
          tenant_id, principal_id, thread_id, mutation_id, operation_kind,
          request_fingerprint, result_code, result_json, replayable, created_at
        ) VALUES (
          'tenant', 'principal', 'thread', ?,
          'conversation_interaction_response', ?, ?, ?, ?, 1
        )
      `);
      insert.run(
        "explicit-response",
        "a".repeat(64),
        "prepared",
        resultJson("explicit-response", "explicit"),
        1,
      );
      insert.run(
        "auto-response",
        "b".repeat(64),
        "uncertain",
        resultJson("auto-response", "auto"),
        0,
      );

      // This focused fixture intentionally inserts orphan receipts with
      // foreign-key enforcement disabled, so apply only its subject migration.
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(
          ({ version }) => version <= removeInteractionTimersMigration.version,
        ),
      );

      const rows = database
        .prepare(
          `
          SELECT mutation_id AS mutationId, result_code AS resultCode,
            result_json AS resultJson, replayable
          FROM mutation_receipts
          ORDER BY mutation_id
        `,
        )
        .all() as Array<{
        mutationId: string;
        resultCode: string;
        resultJson: string;
        replayable: number;
      }>;

      expect(
        rows.map((row) => ({
          ...row,
          resultJson: JSON.parse(row.resultJson) as unknown,
        })),
      ).toEqual([
        {
          mutationId: "auto-response",
          resultCode: "accepted",
          resultJson: {
            version: 1,
            applicationOperationId: "auto-response",
            interactionId: "browser-auto-response",
          },
          replayable: 1,
        },
        {
          mutationId: "explicit-response",
          resultCode: "prepared",
          resultJson: {
            version: 1,
            applicationOperationId: "explicit-response",
            interactionId: "browser-explicit-response",
            response: {
              kind: "questionnaire",
              answers: [
                {
                  questionId: "browser-question",
                  answer: { kind: "unanswered" },
                },
              ],
            },
            backendResponse: {
              applicationOperationId: "explicit-response",
              interactionId: "backend-explicit-response",
              kind: "questionnaire",
              answers: [
                {
                  questionId: "backend-question",
                  answer: { kind: "unanswered" },
                },
              ],
            },
          },
          replayable: 1,
        },
      ]);

      // This focused legacy fixture deliberately inserted orphan receipts with
      // foreign keys disabled. Remove them after validating migration 41 so
      // migration 47 can perform its full-database integrity check.
      database.prepare("DELETE FROM mutation_receipts").run();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
    } finally {
      database.close();
    }
  });
});
