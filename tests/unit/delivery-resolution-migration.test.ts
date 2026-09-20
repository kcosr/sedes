import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { deliveryResolutionMigration } from "../../src/server/db/migrations/078-delivery-resolution.js";

describe("delivery resolution migration", () => {
  it("backfills the resolved mode and exact Steer target for pre-078 queue rows", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE queued_inputs (
          id TEXT PRIMARY KEY,
          requested_delivery_mode TEXT,
          requested_steer_turn_id TEXT,
          steer_fallback_at INTEGER
        ) STRICT;

        INSERT INTO queued_inputs VALUES
          ('submit', 'submit', NULL, NULL),
          ('queue', 'queue', NULL, NULL),
          ('steer', 'queue', 'turn-active', NULL),
          ('steer-fallback', 'queue', 'turn-ended', 123);
      `);

      database.exec(deliveryResolutionMigration.sql);

      expect(
        database
          .prepare(
            `SELECT id,
                    resolved_delivery_mode AS resolvedDeliveryMode,
                    resolved_steer_turn_id AS resolvedSteerTurnId
             FROM queued_inputs
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "queue",
          resolvedDeliveryMode: "queue",
          resolvedSteerTurnId: null,
        },
        {
          id: "steer",
          resolvedDeliveryMode: "steer",
          resolvedSteerTurnId: "turn-active",
        },
        {
          id: "steer-fallback",
          resolvedDeliveryMode: "queue",
          resolvedSteerTurnId: null,
        },
        {
          id: "submit",
          resolvedDeliveryMode: "submit",
          resolvedSteerTurnId: null,
        },
      ]);
    } finally {
      database.close();
    }
  });
});
