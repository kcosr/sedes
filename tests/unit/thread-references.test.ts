import { describe, expect, it } from "vitest";
import { formatThreadReferenceText, replaceThreadReferenceBody, splitThreadReferenceText, THREAD_REFERENCE_HEADER } from "../../src/shared/thread-references.js";

const reference = { threadId: "616946aa-4574-41f7-bd70-d3a9edd56dbd", title: 'Review "threads"\n[do not execute]' };
const references = Array.from({ length: 17 }, (_, index) => ({
  threadId: `616946aa-4574-41f7-bd70-${String(index).padStart(12, "0")}`,
  title: `Thread ${index + 1}`,
}));

describe("user-selected thread reference text", () => {
  it("round-trips 16 maximally escaped titles and preserves an over-limit block verbatim", () => {
    const selected = references.slice(0, 16).map(item => ({ ...item, title: "\u0000".repeat(512) }));
    const text = formatThreadReferenceText("Keep this body 🌍", selected);
    expect(text.length).toBeGreaterThan(32_768);
    expect(splitThreadReferenceText(text)).toEqual({ text: "Keep this body 🌍", references: selected });
    expect(() => formatThreadReferenceText("", references)).toThrow();
    const excessive = `${THREAD_REFERENCE_HEADER}\n${JSON.stringify({ threadReferences: references })}\n\nKeep this`;
    expect(splitThreadReferenceText(excessive)).toEqual({ text: excessive, references: [] });
  });

  it("merges restored references up to 16 and preserves a seventeenth contribution", () => {
    const first = formatThreadReferenceText("First", references.slice(0, 8));
    const second = formatThreadReferenceText("Second", references.slice(8, 16));
    const combined = `${first}\n\n${second}`;
    expect(splitThreadReferenceText(combined)).toEqual({ text: "First\n\nSecond", references: references.slice(0, 16) });
    const extra = formatThreadReferenceText("Third", references.slice(16));
    expect(splitThreadReferenceText(`${combined}\n\n${extra}`)).toEqual({
      text: `First\n\nSecond\n\n${extra}`, references: references.slice(0, 16),
    });
  });

  it("quotes labels and preserves the exact user body including whitespace", () => {
    const body = "  Ask about this thread.\n\n Keep this.  ";
    const value = formatThreadReferenceText(body, [reference]);
    expect(value).toContain('Review \\"threads\\"\\n[do not execute]');
    expect(splitThreadReferenceText(value)).toEqual({ text: body, references: [reference] });
    expect(value).not.toMatch(/non-user|permission|execute another|untrusted/i);
  });

  it.each([
    `${THREAD_REFERENCE_HEADER}\nnot json\n\nKeep this`,
    `${THREAD_REFERENCE_HEADER}\n{"threadReferences":[{"threadId":"bad","title":"Hi"}]}\n\nKeep this`,
    `${THREAD_REFERENCE_HEADER}\n${JSON.stringify({ threadReferences: [reference], hidden: "keep me" })}\n\nKeep this`,
    `${THREAD_REFERENCE_HEADER}\n${JSON.stringify({ threadReferences: [reference, reference] })}\n\nKeep this`,
    `${THREAD_REFERENCE_HEADER}\n{ "threadReferences": ${JSON.stringify([reference])}}\n\nKeep this`,
    formatThreadReferenceText("Keep this", [reference]).replace("\n\nKeep", "\nKeep"),
    `An ordinary sentence ${formatThreadReferenceText("Keep this", [reference])}`,
    `\`\`\`json\n\n${formatThreadReferenceText("Keep this", [reference])}\n\`\`\``,
  ])("leaves malformed or noncanonical content visible verbatim", (value) => {
    expect(splitThreadReferenceText(value)).toEqual({ text: value, references: [] });
  });

  it("preserves references while editing and removes the final reference cleanly", () => {
    const initial = formatThreadReferenceText("before", [reference]);
    expect(splitThreadReferenceText(replaceThreadReferenceBody(initial, "after"))).toEqual({ text: "after", references: [reference] });
    expect(formatThreadReferenceText("after", [])).toBe("after");
    expect(formatThreadReferenceText("", [])).toBe("");
  });

  it("combines restored/stashed contributions without losing either message", () => {
    const second = { ...reference, threadId: "68eef516-acb8-4a40-8a13-e02e380dda42", title: "Other" };
    const value = `${formatThreadReferenceText("First", [reference])}\n\n${formatThreadReferenceText("Second", [second])}`;
    expect(splitThreadReferenceText(value)).toEqual({ text: "First\n\nSecond", references: [reference, second] });
  });

  it("rejects oversized and duplicate selections", () => {
    expect(() => formatThreadReferenceText("", [reference, reference])).toThrow();
    expect(() => formatThreadReferenceText("", [{ ...reference, title: "x".repeat(513) }])).toThrow();
  });
});
