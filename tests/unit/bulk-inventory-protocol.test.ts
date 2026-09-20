import { describe, expect, it } from "vitest";
import {
  MAXIMUM_BULK_INVENTORY_TARGETS,
  SEDES_CLIENT_PROTOCOL_VERSION,
  bulkInventoryImpactRequestSchema,
  bulkInventoryImpactSchema,
  bulkInventoryMutationRequestSchema,
} from "../../src/shared/index.js";

const firstThreadId = "10000000-0000-4000-8000-000000000001";
const secondThreadId = "10000000-0000-4000-8000-000000000002";

describe("bulk inventory protocol", () => {
  it("advances the browser protocol fence", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(115);
  });

  it("accepts only strict, unique, bounded impact target sets", () => {
    expect(
      bulkInventoryImpactRequestSchema.parse({
        action: "settle",
        threadIds: [firstThreadId, secondThreadId],
      }),
    ).toEqual({
      action: "settle",
      threadIds: [firstThreadId, secondThreadId],
    });
    expect(() =>
      bulkInventoryImpactRequestSchema.parse({
        action: "settle",
        threadIds: [firstThreadId],
      }),
    ).toThrow();
    expect(() =>
      bulkInventoryImpactRequestSchema.parse({
        action: "archive",
        threadIds: [firstThreadId, firstThreadId],
      }),
    ).toThrow();
    expect(() =>
      bulkInventoryImpactRequestSchema.parse({
        action: "archive",
        threadIds: Array.from(
          { length: MAXIMUM_BULK_INVENTORY_TARGETS + 1 },
          (_, index) =>
            `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      }),
    ).toThrow();
    expect(() =>
      bulkInventoryImpactRequestSchema.parse({
        action: "unsettle",
        threadIds: [firstThreadId, secondThreadId],
        tenantId: "browser-selected",
      }),
    ).toThrow();
  });

  it("requires confirmed counts only for settle and archive mutations", () => {
    const targets = [
      { threadId: firstThreadId, expectedRevision: 1 },
      { threadId: secondThreadId, expectedRevision: 2 },
    ];
    expect(
      bulkInventoryMutationRequestSchema.parse({
        action: "unsettle",
        targets,
        mutationId: "20000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ action: "unsettle", targets });
    expect(() =>
      bulkInventoryMutationRequestSchema.parse({
        action: "settle",
        targets,
        mutationId: "20000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
    expect(
      bulkInventoryMutationRequestSchema.parse({
        action: "archive",
        targets,
        expectedStashedPromptCount: 3,
        expectedOpenTaskCount: 4,
        openTaskDisposition: "move_to_workspace",
        mutationId: "20000000-0000-4000-8000-000000000003",
      }),
    ).toMatchObject({ action: "archive", targets });
  });

  it("rejects inconsistent impact counts and availability", () => {
    const base = {
      action: "settle" as const,
      targets: [
        { threadId: firstThreadId, expectedRevision: 1 },
        { threadId: secondThreadId, expectedRevision: 2 },
      ],
      targetCount: 2,
      pendingQuestionCount: 0,
      affectedCount: 1,
      unchangedCount: 1,
      blockers: { items: [], total: 0, omitted: 0 },
      openTasks: { items: [], total: 0, omitted: 0 },
      stashedPromptCount: 0,
      available: true,
    };
    expect(bulkInventoryImpactSchema.parse(base)).toEqual(base);
    expect(() =>
      bulkInventoryImpactSchema.parse({ ...base, unchangedCount: 0 }),
    ).toThrow();
    expect(() =>
      bulkInventoryImpactSchema.parse({ ...base, available: false }),
    ).toThrow();
    expect(
      bulkInventoryImpactSchema.parse({
        ...base,
        affectedCount: 0,
        unchangedCount: 2,
        available: false,
      }),
    ).toMatchObject({ affectedCount: 0, available: false });
    expect(
      bulkInventoryImpactSchema.parse({
        ...base,
        openTasks: { items: [], total: 10_001, omitted: 10_001 },
        available: false,
      }),
    ).toMatchObject({ available: false, openTasks: { total: 10_001 } });
  });

  it("keeps a worst-case confirmed target list below the HTTP JSON limit", () => {
    const targets = Array.from(
      { length: MAXIMUM_BULK_INVENTORY_TARGETS },
      (_, index) => ({
        threadId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        expectedRevision: Number.MAX_SAFE_INTEGER,
      }),
    );
    const request = bulkInventoryMutationRequestSchema.parse({
      action: "archive",
      targets,
      expectedStashedPromptCount: Number.MAX_SAFE_INTEGER,
      expectedOpenTaskCount: 10_000,
      openTaskDisposition: "move_to_workspace",
      mutationId: "20000000-0000-4000-8000-000000000004",
    });
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(
      256 * 1_024,
    );
  });
});
