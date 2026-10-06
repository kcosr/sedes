import { describe, expect, it } from "vitest";
import {
  automationPromptPreview,
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
