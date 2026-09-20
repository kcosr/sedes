import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { MAXIMUM_CONTEXT_EXCERPT_BYTES } from "../../shared/index.js";

export type PierreSelectionFailureReason =
  | "invalid_range"
  | "empty_excerpt"
  | "excerpt_too_large"
  | "unresolved_diff_range"
  | "cross_hunk_range";

export type PierreSelectionCapture<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PierreSelectionFailureReason };

export interface CapturedFileLineSelection {
  readonly excerpt: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface CapturedDiffLineSelection {
  readonly excerpt: string;
  readonly start: { readonly side: "old" | "new"; readonly line: number };
  readonly end: { readonly side: "old" | "new"; readonly line: number };
}

export function captureFileLineSelection(
  content: string,
  range: SelectedLineRange,
): PierreSelectionCapture<CapturedFileLineSelection> {
  if (
    range.side !== undefined ||
    range.endSide !== undefined ||
    !validLineNumber(range.start) ||
    !validLineNumber(range.end)
  ) {
    return { ok: false, reason: "invalid_range" };
  }
  const offsets = computeLineOffsets(content);
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  if (endLine > offsets.length) {
    return { ok: false, reason: "invalid_range" };
  }
  const excerpt = content.slice(
    offsets[startLine - 1],
    offsets[endLine] ?? content.length,
  );
  if (excerpt.length === 0) {
    return { ok: false, reason: "empty_excerpt" };
  }
  if (utf8Bytes(excerpt) > MAXIMUM_CONTEXT_EXCERPT_BYTES) {
    return { ok: false, reason: "excerpt_too_large" };
  }
  return { ok: true, value: { excerpt, startLine, endLine } };
}

interface DiffRow {
  readonly hunkIndex: number;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export function captureUnifiedDiffLineSelection(
  diff: FileDiffMetadata,
  range: SelectedLineRange,
): PierreSelectionCapture<CapturedDiffLineSelection> {
  const start = diffEndpoint(range.start, range.side);
  const end = diffEndpoint(range.end, range.endSide ?? range.side);
  if (!start || !end) return { ok: false, reason: "invalid_range" };

  const rows = unifiedRows(diff);
  const startIndex = rows.findIndex((row) => rowContains(row, start));
  const endIndex = rows.findIndex((row) => rowContains(row, end));
  if (startIndex < 0 || endIndex < 0) {
    return { ok: false, reason: "unresolved_diff_range" };
  }
  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  if (rows[first]!.hunkIndex !== rows[last]!.hunkIndex) {
    return { ok: false, reason: "cross_hunk_range" };
  }
  const excerpt = rows
    .slice(first, last + 1)
    .map((row) => row.text)
    .join("");
  if (excerpt.length === 0) {
    return { ok: false, reason: "empty_excerpt" };
  }
  if (utf8Bytes(excerpt) > MAXIMUM_CONTEXT_EXCERPT_BYTES) {
    return { ok: false, reason: "excerpt_too_large" };
  }
  const locatorStart =
    start.side === end.side && start.line > end.line ? end : start;
  const locatorEnd =
    start.side === end.side && start.line > end.line ? start : end;
  return {
    ok: true,
    value: { excerpt, start: locatorStart, end: locatorEnd },
  };
}

function unifiedRows(diff: FileDiffMetadata): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index++) {
          const text = diff.additionLines[content.additionLineIndex + index];
          if (text === undefined) continue;
          rows.push({ hunkIndex, text, oldLine, newLine });
          oldLine++;
          newLine++;
        }
        continue;
      }
      for (let index = 0; index < content.deletions; index++) {
        const text = diff.deletionLines[content.deletionLineIndex + index];
        if (text === undefined) continue;
        rows.push({ hunkIndex, text, oldLine });
        oldLine++;
      }
      for (let index = 0; index < content.additions; index++) {
        const text = diff.additionLines[content.additionLineIndex + index];
        if (text === undefined) continue;
        rows.push({ hunkIndex, text, newLine });
        newLine++;
      }
    }
  });
  return rows;
}

function diffEndpoint(
  line: number,
  side: SelectedLineRange["side"],
): CapturedDiffLineSelection["start"] | undefined {
  if (!validLineNumber(line) || side === undefined) return undefined;
  return { side: side === "deletions" ? "old" : "new", line };
}

function rowContains(
  row: DiffRow,
  point: CapturedDiffLineSelection["start"],
): boolean {
  return point.side === "old"
    ? row.oldLine === point.line
    : row.newLine === point.line;
}

function validLineNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function computeLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index++) {
    const char = content.charCodeAt(index);
    if (char !== 10 && char !== 13) continue;
    if (char === 13 && content.charCodeAt(index + 1) === 10) index++;
    offsets.push(index + 1);
  }
  return offsets;
}
