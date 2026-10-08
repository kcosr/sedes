import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_PAYLOAD_BYTES,
  selectAssistantResult,
} from "../../src/server/domain/assistant-result-selection.js";
import type { ClassifiedAssistantResult } from "../../src/shared/protocol/completion-result.js";
import {
  selectedAssistantResultSchema,
  type NotificationAssistantResultPhase,
} from "../../src/shared/protocol/notification.js";
import type { BoundedText } from "../../src/shared/protocol/payload.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const result: ClassifiedAssistantResult = {
  provisional: { text: "Checking the build." },
  final: null,
  unclassified: { text: "Unlabelled text." },
};

describe("assistant result phase selection", () => {
  it.each<NotificationAssistantResultPhase[]>([
    ["provisional"], ["final"], ["unclassified"],
    ["unclassified", "provisional"], ["final", "unclassified"],
    ["provisional", "final", "unclassified"], [],
  ])("keeps only selected keys %j, preserving a selected null", (...phases) => {
    const selected = selectAssistantResult(result, phases);
    expect(selected).toEqual(Object.fromEntries(phases.map((phase) => [phase, result[phase]])));
    // Keys follow one fixed order whatever the selection order.
    expect(Object.keys(selected!)).toEqual(
      ["provisional", "final", "unclassified"].filter((phase) => phases.includes(phase as NotificationAssistantResultPhase)),
    );
    expect(selectedAssistantResultSchema.parse(selected)).toEqual(selected);
  });

  it("never reads unselected sections and detaches the selected text", () => {
    const final = { text: "Final answer" };
    const source = {
      get provisional(): BoundedText { throw new Error("must not read provisional"); },
      final,
      get unclassified(): BoundedText { throw new Error("must not read unclassified"); },
    };
    const selected = selectAssistantResult(source, ["final"]);
    final.text = "Changed after selection";
    expect(selected).toEqual({ final: { text: "Final answer" } });
    expect(selected!.final).not.toBe(final);
  });

  it("measures the result together with its envelope", () => {
    const text = "r".repeat(30_000);
    const source = { provisional: null, final: { text }, unclassified: null };
    expect(selectAssistantResult(source, ["final"])).toEqual({ final: { text } });

    const envelope = { message: "m".repeat(45_000) };
    const selected = selectAssistantResult(source, ["final"], envelope)!;
    expect(bytes({ ...envelope, assistantResult: selected })).toBeLessThanOrEqual(NOTIFICATION_PAYLOAD_BYTES);
    expect(selected.final!.text.endsWith("…")).toBe(true);
    expect(text.startsWith(selected.final!.text.slice(0, -1))).toBe(true);
    expect(selected.final!.truncation).toEqual({
      truncated: true,
      reason: "byte_limit",
      retainedBytes: Buffer.byteLength(selected.final!.text),
    });
    expect(source.final.text).toBe(text);
  });

  it("shortens unclassified, then provisional, text before final text", () => {
    const source = {
      provisional: { text: "p".repeat(40_000) },
      final: { text: "f".repeat(30_000) },
      unclassified: { text: "u".repeat(10_000) },
    };
    const all = ["provisional", "final", "unclassified"] as const;
    const selected = selectAssistantResult(source, all)!;
    expect(bytes({ assistantResult: selected })).toBeLessThanOrEqual(NOTIFICATION_PAYLOAD_BYTES);
    expect(selected.final).toEqual(source.final);
    expect(selected.unclassified).toEqual({ text: "", truncation: { truncated: true, retainedBytes: 0, reason: "byte_limit" } });
    expect(selected.provisional!.truncation).toMatchObject({ truncated: true, reason: "byte_limit" });
    expect(selected.provisional!.text.length).toBeGreaterThan(30_000);

    // Shortening stops at the first phase that makes the result fit.
    const smaller = selectAssistantResult({ ...source, provisional: { text: "p".repeat(20_000) }, unclassified: { text: "u".repeat(30_000) } }, all)!;
    expect(smaller.provisional).toEqual({ text: "p".repeat(20_000) });
    expect(smaller.final).toEqual(source.final);
    expect(smaller.unclassified!.truncation).toMatchObject({ truncated: true });
    expect(smaller.unclassified!.text.length).toBeGreaterThan(10_000);
  });

  it("returns nothing when even empty sections cannot fit beside the envelope", () => {
    const envelope = { message: "m".repeat(NOTIFICATION_PAYLOAD_BYTES - 20) };
    expect(selectAssistantResult(result, ["final", "unclassified"], envelope)).toBeUndefined();
  });
});
