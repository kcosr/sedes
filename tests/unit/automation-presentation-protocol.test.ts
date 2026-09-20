import { describe, expect, it } from "vitest";
import { createAutomationRequestSchema } from "../../src/shared/protocol/api.js";
import {
  threadAutomationDefinitionSchema,
  threadAutomationSummarySchema,
} from "../../src/shared/protocol/automation-presentation.js";

describe("normalized automation protocol", () => {
  it("bounds prompts by persisted UTF-8 bytes, not JavaScript length", () => {
    const request = {
      runMode: "same_thread",
      schedule: {
        kind: "date_time",
        runAt: new Date(10_000).toISOString(),
      },
      misfirePolicy: "coalesce",
      precheck: null,
      mutationId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    } as const;

    expect(
      createAutomationRequestSchema.safeParse({
        ...request,
        prompt: "a".repeat(65_536),
      }).success,
    ).toBe(true);
    expect(
      createAutomationRequestSchema.safeParse({
        ...request,
        prompt: "🙂".repeat(20_000),
      }).success,
    ).toBe(false);
    expect(
      createAutomationRequestSchema.safeParse({
        ...request,
        prompt: "Review this thread",
        anchorThreadId: "550e8400-e29b-41d4-a716-446655440000",
        name: "Legacy public identity",
      }).success,
    ).toBe(false);
  });

  it("keeps automation identity on its owning thread presentation", () => {
    const createdAt = new Date(10_000).toISOString();
    const automation = {
      status: "enabled",
      runMode: "same_thread",
      scheduleKind: "date_time",
      nextRunAt: new Date(30_000).toISOString(),
      revision: 2,
      createdAt,
      updatedAt: new Date(20_000).toISOString(),
      hasPrecheck: false,
    } as const;

    expect(threadAutomationSummarySchema.parse(automation)).toEqual(automation);
    expect(
      threadAutomationSummarySchema.safeParse({
        ...automation,
        threadId: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(false);
    const { createdAt: _createdAt, ...withoutCreatedAt } = automation;
    expect(threadAutomationSummarySchema.safeParse(withoutCreatedAt).success).toBe(
      false,
    );
    expect(
      threadAutomationDefinitionSchema.parse({
        ...automation,
        prompt: "Review this thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(30_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
      }),
    ).toMatchObject({ createdAt });
  });
});
