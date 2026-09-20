import type { FileChangeItem } from "../../../shared/index.js";
import type { PierreFileChangeCandidate } from "../../lib/pierre-patch-candidate.js";

export interface FileOperationNavigation {
  readonly path: string;
  readonly lineNumber: number;
}

/** Maps a historical file change to the file version that should exist now. */
export function fileChangeNavigation(
  item: FileChangeItem,
  pierreCandidate?: PierreFileChangeCandidate,
): FileOperationNavigation | undefined {
  if (item.operation === "delete" && item.effect === "applied") {
    return undefined;
  }
  const postChange = item.effect === "applied";
  const path =
    postChange && item.destinationPath
      ? item.destinationPath.text
      : item.path.text;
  if (
    pierreCandidate?.source.kind === "whole_file_write" ||
    (item.operation === "write" && !item.diff)
  ) {
    return { path, lineNumber: 1 };
  }
  // Normalized replacement previews contain no real file offset. Files uses
  // the explicit top-of-file fallback instead of presenting a snippet offset.
  if (pierreCandidate?.source.kind === "replacement_preview") {
    return { path, lineNumber: 1 };
  }
  const patch =
    pierreCandidate?.source.kind === "unified_patch"
      ? pierreCandidate.source.text
      : item.diff?.text.text;
  const hunk = patch ? firstHunkLines(patch) : undefined;
  return {
    path,
    lineNumber:
      (postChange ? hunk?.newLine : hunk?.oldLine) ??
      item.range?.startLine ??
      1,
  };
}

function firstHunkLines(
  patch: string,
): { readonly oldLine: number; readonly newLine: number } | undefined {
  const match = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/m.exec(
    patch,
  );
  if (!match) return undefined;
  const oldLine = Number(match[1]);
  const newLine = Number(match[2]);
  if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine)) {
    return undefined;
  }
  return { oldLine: Math.max(1, oldLine), newLine: Math.max(1, newLine) };
}
