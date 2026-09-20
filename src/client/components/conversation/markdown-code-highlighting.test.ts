import { describe, expect, it } from "vitest";
import {
  highlightMarkdownCode,
  markdownSyntaxLanguage,
} from "./markdown-code-highlighting.js";

describe("markdown code highlighting", () => {
  it.each([
    ["language-js", "javascript"],
    ["language-ts", "typescript"],
    ["language-bash", "shellscript"],
    ["language-py", "python"],
    ["language-yml", "yaml"],
    ["language-patch", "diff"],
    ["extra language-C++", "cpp"],
  ] as const)("maps %s to the curated %s grammar", (className, expected) => {
    expect(markdownSyntaxLanguage(className)).toBe(expected);
  });

  it.each([undefined, "", "language-text", "language-brainfuck"])(
    "leaves unsupported fence class %s as plain text",
    (className) => {
      expect(markdownSyntaxLanguage(className)).toBeUndefined();
    },
  );

  it("produces React-safe tokens backed by application syntax variables", async () => {
    const lines = await highlightMarkdownCode(
      "const answer: number = 42;",
      "typescript",
    );

    expect(lines?.flatMap((line) => line.map((token) => token.content)).join(""))
      .toBe("const answer: number = 42;");
    expect(
      lines?.flatMap((line) => line).some((token) =>
        String(token.style.color).startsWith("var(--syntax-"),
      ),
    ).toBe(true);
  });

  it("declines oversized blocks before loading or tokenizing them", async () => {
    await expect(
      highlightMarkdownCode("x".repeat(100_001), "javascript"),
    ).resolves.toBeUndefined();
  });
});
