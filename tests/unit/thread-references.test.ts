import { describe, expect, it } from "vitest";
import { formatThreadReferenceText, replaceThreadReferenceBody, splitThreadReferenceText, THREAD_REFERENCE_HEADER } from "../../src/shared/thread-references.js";

const reference = { threadId: "616946aa-4574-41f7-bd70-d3a9edd56dbd", title: 'Review "threads"\n[do not execute]' };

describe("user-selected thread reference text", () => {
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
