import { createTwoFilesPatch, diffLines } from "diff";
import { WorkspaceToolError, type WorkspaceToolEdit } from "./contracts.js";

export function stripBom(content: string): {
  readonly bom: string;
  readonly text: string;
} {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) return "\n";
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

export function normalizeToLf(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function restoreLineEndings(
  content: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? content.replace(/\n/gu, "\r\n") : content;
}

export function normalizeForFuzzyMatch(content: string): string {
  return content
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

interface Replacement {
  readonly index: number;
  readonly length: number;
  readonly text: string;
}

function occurrences(content: string, needle: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyNeedle = normalizeForFuzzyMatch(needle);
  if (!fuzzyNeedle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = fuzzyContent.indexOf(fuzzyNeedle, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, fuzzyNeedle.length);
  }
  return count;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/gu) ?? [];
}

function lineSpans(content: string): { start: number; end: number }[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(
  lines: readonly { start: number; end: number }[],
  replacement: Replacement,
): { startLine: number; endLine: number } {
  const start = replacement.index;
  const end = replacement.index + replacement.length;
  const startLine = lines.findIndex(
    (line) => start >= line.start && start < line.end,
  );
  if (startLine < 0)
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < end) endLine += 1;
  if (endLine >= lines.length)
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(
  content: string,
  replacements: readonly Replacement[],
  offset = 0,
): string {
  let result = content;
  for (const replacement of [...replacements].reverse()) {
    const index = replacement.index - offset;
    result =
      result.slice(0, index) +
      replacement.text +
      result.slice(index + replacement.length);
  }
  return result;
}

function applyReplacementsPreservingUnchangedLines(
  original: string,
  normalizedBase: string,
  replacements: readonly Replacement[],
): string {
  const originalLines = splitLinesWithEndings(original);
  const baseLines = lineSpans(normalizedBase);
  if (originalLines.length !== baseLines.length)
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  const groups: {
    startLine: number;
    endLine: number;
    replacements: Replacement[];
  }[] = [];
  for (const replacement of replacements) {
    const range = replacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const startOffset = baseLines[group.startLine]!.start;
    const endOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      normalizedBase.slice(startOffset, endOffset),
      group.replacements,
      startOffset,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

/** Pi 0.83-compatible all-at-once edit matching and fuzzy normalization. */
export function applyWorkspaceToolEdits(
  content: string,
  edits: readonly WorkspaceToolEdit[],
): {
  readonly content: string;
  readonly normalizedBefore: string;
  readonly normalizedAfter: string;
} {
  if (edits.length === 0)
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  const { bom, text } = stripBom(content);
  const ending = detectLineEnding(text);
  const normalizedBefore = normalizeToLf(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));
  if (normalizedEdits.some((edit) => edit.oldText.length === 0))
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  const fuzzy = normalizedEdits.some(
    (edit) => !normalizedBefore.includes(edit.oldText),
  );
  const base = fuzzy
    ? normalizeForFuzzyMatch(normalizedBefore)
    : normalizedBefore;
  const replacements: Replacement[] = normalizedEdits
    .map((edit) => {
      const needle = fuzzy
        ? normalizeForFuzzyMatch(edit.oldText)
        : edit.oldText;
      const count = occurrences(base, edit.oldText);
      if (count === 0)
        throw new WorkspaceToolError("workspace_tools_edit_no_match");
      if (count !== 1)
        throw new WorkspaceToolError("workspace_tools_edit_ambiguous_match");
      return {
        index: base.indexOf(needle),
        length: needle.length,
        text: edit.newText,
      };
    })
    .sort((left, right) => left.index - right.index);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1]!;
    if (previous.index + previous.length > replacements[index]!.index)
      throw new WorkspaceToolError("workspace_tools_edit_overlap");
  }
  const normalizedAfter = fuzzy
    ? applyReplacementsPreservingUnchangedLines(
        normalizedBefore,
        base,
        replacements,
      )
    : applyReplacements(base, replacements);
  if (normalizedAfter === normalizedBefore)
    throw new WorkspaceToolError("workspace_tools_edit_failed");
  return {
    content: bom + restoreLineEndings(normalizedAfter, ending),
    normalizedBefore,
    normalizedAfter,
  };
}

export function workspaceToolEditPresentation(
  path: string,
  before: string,
  after: string,
) {
  const parts = diffLines(before, after);
  let oldLine = 1;
  let newLine = 1;
  let firstChangedLine: number | undefined;
  const output: string[] = [];
  for (const part of parts) {
    const lines = part.value.endsWith("\n")
      ? part.value.slice(0, -1).split("\n")
      : part.value.split("\n");
    for (const line of lines) {
      if (part.added) {
        firstChangedLine ??= newLine;
        output.push(`+${newLine} ${line}`);
        newLine += 1;
      } else if (part.removed) {
        firstChangedLine ??= newLine;
        output.push(`-${oldLine} ${line}`);
        oldLine += 1;
      } else {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return {
    diff: output.join("\n"),
    patch: createTwoFilesPatch(
      path,
      path,
      before,
      after,
      undefined,
      undefined,
      { context: 4 },
    ),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}
