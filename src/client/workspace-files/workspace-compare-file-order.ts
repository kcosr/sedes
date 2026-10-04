import type { WorkspaceDiffChangedFileSummary } from "../../shared/protocol/workspace-diffs.js";
import { workspaceCompareFilePath } from "./workspace-compare-state.js";

// Case-insensitive and numeric-aware like the Browse tree, with a fixed locale
// so every client orders the same comparison identically.
const segmentCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function compareSegments(left: string, right: string): number {
  return (
    segmentCollator.compare(left, right) ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}

function compareSegmentedPaths(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftDepth = left.length - 1;
  const rightDepth = right.length - 1;
  for (let index = 0; index < Math.min(leftDepth, rightDepth); index++) {
    const order = compareSegments(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  if (leftDepth !== rightDepth) return leftDepth - rightDepth;
  return compareSegments(left[leftDepth]!, right[rightDepth]!);
}

/**
 * The one changed-file order used by the navigator, the diff document,
 * previous/next, and patch loading. Root-level files come first; directories
 * then compare segment by segment, so `a/` sorts before `a/b/` and `a-b/`, and
 * a directory's own files precede its subdirectories; file names order files
 * within a directory. Every directory therefore forms one contiguous group.
 */
export function compareWorkspaceChangedFilePaths(
  left: string,
  right: string,
): number {
  return compareSegmentedPaths(left.split("/"), right.split("/"));
}

/** Returns a sorted copy; files with equal paths keep their incoming order. */
export function sortWorkspaceChangedFiles(
  files: readonly WorkspaceDiffChangedFileSummary[],
): readonly WorkspaceDiffChangedFileSummary[] {
  return files
    .map((file) => ({
      file,
      segments: workspaceCompareFilePath(file).split("/"),
    }))
    .sort((left, right) => compareSegmentedPaths(left.segments, right.segments))
    .map(({ file }) => file);
}
