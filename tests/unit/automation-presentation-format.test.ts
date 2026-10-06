import { describe, expect, it } from "vitest";
import {
  automationCloneThreadTitle,
  automationCloneTitleSuffix,
  automationPromptPreview,
  decodeAutomationPromptHead,
  presentAutomationSchedule,
} from "../../src/server/domain/automation-presentation.js";

describe("automation prompt preview", () => {
  it("collapses whitespace and keeps short prompts whole", () => {
    expect(automationPromptPreview("Review\n\n  the\trepository.")).toBe(
      "Review the repository.",
    );
  });

  it("truncates to 140 units with an ellipsis", () => {
    const preview = automationPromptPreview(`${"word ".repeat(40)}end`);
    expect(preview).toBe(`${"word ".repeat(28).trimEnd()}…`);
    expect(preview.length).toBeLessThanOrEqual(141);
    expect(automationPromptPreview("a".repeat(140))).toBe("a".repeat(140));
    expect(automationPromptPreview("a".repeat(141))).toBe(
      `${"a".repeat(140)}…`,
    );
  });

  it("never splits a surrogate pair and stays within the schema bound", () => {
    const preview = automationPromptPreview("🙂".repeat(100));
    expect(preview).toBe(`${"🙂".repeat(70)}…`);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("marks a bounded source prefix as continuing", () => {
    expect(automationPromptPreview("Short head", true)).toBe("Short head…");
  });

  it("treats control characters, NUL included, as separators", () => {
    expect(automationPromptPreview("\u0000Review\u0000the\u0007repo")).toBe(
      "Review the repo",
    );
    expect(automationPromptPreview("\u0000\u0000")).toBe("");
  });

  it("drops a multi-byte character cut by the byte prefix", () => {
    const bytes = new TextEncoder().encode("Fix 🙂");
    expect(decodeAutomationPromptHead(bytes.subarray(0, 6), true)).toBe("Fix ");
    expect(decodeAutomationPromptHead(bytes, false)).toBe("Fix 🙂");
  });
});

describe("automation clone result titles", () => {
  const runAt = Date.UTC(2026, 9, 6, 8, 15);

  it("formats the run time in the cron schedule's zone", () => {
    expect(
      automationCloneTitleSuffix(runAt, {
        kind: "cron",
        expression: "15 3 * * *",
        timeZone: "America/Chicago",
      }),
    ).toBe(" · Oct 6, 3:15 AM");
  });

  it("labels UTC for interval and one-time schedules", () => {
    expect(
      automationCloneTitleSuffix(runAt, {
        kind: "interval",
        anchorAt: 0,
        everySeconds: 3_600,
      }),
    ).toBe(" · Oct 6, 8:15 AM UTC");
    expect(
      automationCloneTitleSuffix(Date.UTC(2026, 9, 6, 15, 5), {
        kind: "date_time",
        runAt,
      }),
    ).toBe(" · Oct 6, 3:05 PM UTC");
  });

  it("appends the suffix and shortens long anchor titles to stay valid", () => {
    expect(automationCloneThreadTitle("Nightly review", " · Oct 6, 3:15 AM")).toBe(
      "Nightly review · Oct 6, 3:15 AM",
    );
    const suffix = " · Oct 6, 3:15 AM UTC";
    const title = automationCloneThreadTitle("x".repeat(240), suffix);
    expect(title).toHaveLength(240);
    expect(title.endsWith(`x…${suffix}`)).toBe(true);
  });
});

describe("automation schedule presentation", () => {
  it("presents stored instants as ISO timestamps", () => {
    expect(
      presentAutomationSchedule({
        kind: "interval",
        anchorAt: Date.UTC(2026, 9, 6),
        everySeconds: 86_400,
      }),
    ).toEqual({
      kind: "interval",
      anchorAt: "2026-10-06T00:00:00.000Z",
      everySeconds: 86_400,
    });
    expect(
      presentAutomationSchedule({ kind: "date_time", runAt: 0 }),
    ).toEqual({ kind: "date_time", runAt: "1970-01-01T00:00:00.000Z" });
  });
});
