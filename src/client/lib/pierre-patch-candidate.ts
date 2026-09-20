import type { BoundedText, FileChangeItem } from "../../shared/index.js";

/**
 * Cheap static gate for whether a file_change diff *might* be worth loading
 * the Pierre chunk. Must not import `@pierre/diffs`.
 *
 * Real unified patches always carry `@@` hunk headers. Exact replacement
 * previews use their own normalized before/after carrier.
 */
export function isPierrePatchCandidate(text: string): boolean {
  return /^@@ /m.test(text);
}

export type PierreFileChangeSource =
  | { readonly kind: "unified_patch"; readonly text: string }
  | { readonly kind: "whole_file_write"; readonly content: string }
  | {
      readonly kind: "replacement_preview";
      readonly oldContent: string;
      readonly newContent: string;
    };

export interface PierreFileChangeCandidate {
  readonly source: PierreFileChangeSource;
  readonly value: BoundedText;
  readonly additions?: number;
  readonly deletions?: number;
}

/**
 * Select only explicit normalized file-change carriers. Whole-file writes use
 * exactly one carrier: Pi's content preview or Codex Add's normalized diff
 * payload. Contradictory shapes fail closed instead of guessing from text.
 */
export function selectPierreFileChangeCandidate(
  item: FileChangeItem,
): PierreFileChangeCandidate | undefined {
  if (item.operation !== "write") {
    if (item.replacement !== undefined) {
      if (
        item.operation !== "edit" ||
        item.path.truncation !== undefined ||
        !isSafeWholeFilePatchPath(item.path.text) ||
        item.destinationPath !== undefined ||
        item.range !== undefined ||
        item.diff !== undefined ||
        item.contentPreview !== undefined ||
        item.replacement.before.truncation !== undefined ||
        item.replacement.after.truncation !== undefined ||
        item.replacement.before.text === item.replacement.after.text
      ) {
        return undefined;
      }
      return {
        source: {
          kind: "replacement_preview",
          oldContent: item.replacement.before.text,
          newContent: item.replacement.after.text,
        },
        value: item.replacement.after,
        additions: item.additions,
        deletions: item.deletions,
      };
    }
    const value = item.diff?.text;
    if (!value) return undefined;
    if (isPierrePatchCandidate(value.text)) {
      return {
        source: { kind: "unified_patch", text: value.text },
        value,
      };
    }
    return undefined;
  }

  if (
    item.destinationPath !== undefined ||
    item.range !== undefined ||
    item.path.truncation !== undefined ||
    !isSafeWholeFilePatchPath(item.path.text) ||
    (item.deletions !== undefined && item.deletions !== 0)
  ) {
    return undefined;
  }

  const preview = item.contentPreview;
  const diff = item.diff?.text;
  if ((preview === undefined) === (diff === undefined)) return undefined;

  const value = preview ?? diff!;
  const additions = countWholeFileLines(value.text);
  if (
    item.additions !== undefined &&
    value.truncation === undefined &&
    item.additions !== additions
  ) {
    return undefined;
  }

  return {
    source: { kind: "whole_file_write", content: value.text },
    value,
    additions:
      item.additions ??
      (value.truncation === undefined ? additions : undefined),
    deletions: 0,
  };
}

export function countWholeFileLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = content.endsWith("\n") ? 0 : 1;
  for (const character of content) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

export function isSafeWholeFilePatchPath(path: string): boolean {
  return (
    path.length > 0 &&
    path !== "/dev/null" &&
    path.trim() === path &&
    !/[\0-\x1f\x7f]/.test(path)
  );
}
