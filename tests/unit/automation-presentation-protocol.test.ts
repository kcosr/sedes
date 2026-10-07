import { describe, expect, it } from "vitest";
import {
  createAutomationRequestSchema,
  listAutomationRunsQuerySchema,
  previewAutomationScheduleRequestSchema,
  resolveAutomationRunRequestSchema,
} from "../../src/shared/protocol/api.js";
import {
  threadAutomationDefinitionSchema,
  threadAutomationRunPageSchema,
  threadAutomationRunResolutionSchema,
  threadAutomationRunSchema,
  threadAutomationSummarySchema,
} from "../../src/shared/protocol/automation-presentation.js";
import { normalizedThreadSummarySchema } from "../../src/shared/protocol/conversation.js";

describe("normalized automation protocol", () => {
  it("previews from an optional instant, given as an ISO date-time", () => {
    const schedule = { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" } as const;
    expect(previewAutomationScheduleRequestSchema.parse({ schedule })).toEqual({ schedule, count: 5 });
    expect(
      previewAutomationScheduleRequestSchema.parse({ schedule, count: 3, after: "2026-10-08T00:00:00.000Z" }),
    ).toEqual({ schedule, count: 3, after: "2026-10-08T00:00:00.000Z" });
    expect(previewAutomationScheduleRequestSchema.safeParse({ schedule, after: "tomorrow" }).success).toBe(false);
  });

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
      runsRevision: 5,
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
    const { runsRevision: _runsRevision, ...withoutRunsRevision } = automation;
    expect(
      threadAutomationSummarySchema.safeParse(withoutRunsRevision).success,
    ).toBe(false);
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

  it("projects schedule detail and a bounded prompt preview on thread summaries", () => {
    const automation =
      normalizedThreadSummarySchema.shape.automation.unwrap();
    const projected = {
      status: "enabled",
      runMode: "clone",
      scheduleKind: "cron",
      schedule: {
        kind: "cron",
        expression: "15 3 * * 1-5",
        timeZone: "America/Chicago",
      },
      misfirePolicy: "skip",
      promptPreview: "Review the repository and summarize…",
      revision: 4,
      runsRevision: 5,
      hasPrecheck: true,
    } as const;

    expect(automation.parse(projected)).toEqual(projected);
    for (const field of [
      "schedule",
      "misfirePolicy",
      "promptPreview",
      "runsRevision",
    ] as const) {
      const { [field]: _omitted, ...missing } = projected;
      expect(automation.safeParse(missing).success).toBe(false);
    }
    expect(
      automation.safeParse({ ...projected, runsRevision: -1 }).success,
    ).toBe(false);
    expect(
      automation.safeParse({ ...projected, promptPreview: "x".repeat(161) })
        .success,
    ).toBe(false);
    // A prompt with no printable text has an empty preview.
    expect(
      automation.safeParse({ ...projected, promptPreview: "" }).success,
    ).toBe(true);
    // The full prompt stays behind the automation route.
    expect(
      automation.safeParse({ ...projected, prompt: "Review" }).success,
    ).toBe(false);
  });

  it("presents run detail, filtered pages with counts, and resolutions", () => {
    const run = {
      id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      occurrence: "scheduled",
      scheduledFor: new Date(10_000).toISOString(),
      state: "skipped",
      runMode: "same_thread",
      definitionRevision: 3,
      coalescedCount: 0,
      finishedAt: new Date(11_000).toISOString(),
      forceResetAt: new Date(12_000).toISOString(),
      precheck: {
        status: "skipped",
        command: "git diff --quiet",
        timeoutSeconds: 15,
        durationMilliseconds: 40,
        stdoutBytes: 0,
        stdoutIncluded: false,
        exitCode: 1,
      },
    } as const;

    expect(threadAutomationRunSchema.parse(run)).toEqual(run);
    const { definitionRevision: _revision, ...withoutRevision } = run;
    expect(threadAutomationRunSchema.safeParse(withoutRevision).success).toBe(
      false,
    );
    const { command: _command, ...precheckWithoutCommand } = run.precheck;
    expect(
      threadAutomationRunSchema.safeParse({
        ...run,
        precheck: precheckWithoutCommand,
      }).success,
    ).toBe(false);

    const counts = { all: 4, problems: 2, skipped: 1 };
    expect(
      threadAutomationRunPageSchema.parse({
        items: [run],
        nextCursor: null,
        counts,
      }),
    ).toMatchObject({ counts });
    expect(
      threadAutomationRunPageSchema.parse({ items: [], nextCursor: "next" }),
    ).not.toHaveProperty("counts");
    expect(
      threadAutomationRunPageSchema.safeParse({
        items: [],
        nextCursor: null,
        counts: { ...counts, failed: 1 },
      }).success,
    ).toBe(false);

    expect(listAutomationRunsQuerySchema.parse({})).toEqual({
      pageSize: 50,
      filter: "all",
    });
    expect(
      listAutomationRunsQuerySchema.parse({ filter: "problems", pageSize: "25" }),
    ).toEqual({ filter: "problems", pageSize: 25 });
    expect(
      listAutomationRunsQuerySchema.safeParse({ filter: "failed" }).success,
    ).toBe(false);

    expect(
      resolveAutomationRunRequestSchema.parse({ action: "mark_failed" }),
    ).toEqual({ action: "mark_failed", resume: false });
    expect(
      resolveAutomationRunRequestSchema.safeParse({
        action: "mark_failed",
        resume: "yes",
      }).success,
    ).toBe(false);
    expect(
      threadAutomationRunResolutionSchema.parse({ run, automation: null }),
    ).toEqual({ run, automation: null });
    expect(threadAutomationRunResolutionSchema.safeParse({ run }).success).toBe(
      false,
    );
  });

  it("describes a settled run turn and the last run's turn outcome strictly", () => {
    const run = {
      id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      occurrence: "scheduled",
      scheduledFor: new Date(10_000).toISOString(),
      state: "completed",
      runMode: "same_thread",
      definitionRevision: 3,
      coalescedCount: 0,
      finishedAt: new Date(11_000).toISOString(),
    } as const;
    const turn = {
      id: "turn_settled",
      outcome: "failed",
      settledAt: new Date(13_000).toISOString(),
      startedAt: new Date(11_000).toISOString(),
      endedAt: new Date(12_900).toISOString(),
    } as const;
    expect(threadAutomationRunSchema.parse({ ...run, turn })).toEqual({
      ...run,
      turn,
    });
    const { startedAt: _startedAt, endedAt: _endedAt, ...untimed } = turn;
    expect(threadAutomationRunSchema.parse({ ...run, turn: untimed })).toEqual(
      { ...run, turn: untimed },
    );
    for (const invalid of [
      { ...turn, outcome: "cancelled" },
      { ...turn, steeredBy: "you" },
      { outcome: "completed", settledAt: turn.settledAt },
    ]) {
      expect(
        threadAutomationRunSchema.safeParse({ ...run, turn: invalid }).success,
      ).toBe(false);
    }

    const lastRun = {
      id: run.id,
      state: "completed",
      occurrence: "scheduled",
      scheduledFor: run.scheduledFor,
      turn: { outcome: "interrupted", endedAt: turn.endedAt },
    } as const;
    const summary = {
      status: "enabled",
      runMode: "same_thread",
      scheduleKind: "date_time",
      revision: 2,
      runsRevision: 5,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(2_000).toISOString(),
      hasPrecheck: false,
      lastRun,
    } as const;
    expect(threadAutomationSummarySchema.parse(summary)).toEqual(summary);
    expect(
      threadAutomationSummarySchema.safeParse({
        ...summary,
        lastRun: { ...lastRun, turn: { ...lastRun.turn, id: turn.id } },
      }).success,
    ).toBe(false);
    const projected = {
      ...summary,
      schedule: { kind: "date_time", runAt: new Date(10_000).toISOString() },
      misfirePolicy: "coalesce",
      promptPreview: "Review",
    } as const;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...summaryOnly } =
      projected;
    const automation = normalizedThreadSummarySchema.shape.automation.unwrap();
    expect(automation.parse(summaryOnly)).toEqual(summaryOnly);
    expect(
      automation.safeParse({
        ...summaryOnly,
        lastRun: { ...lastRun, turn: { outcome: "cancelled" } },
      }).success,
    ).toBe(false);
  });
});
