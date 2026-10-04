import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * Maps a displayed diff line to the nearest line of the new file, so **Open
 * file** can open Browse where the reader was. New-side lines pass through.
 * An old-side line maps through the patch hunks: unchanged lines keep their
 * offset, a replaced line maps to its counterpart, and a purely deleted line
 * maps to the new line before the deletion. Returns `undefined` when an
 * old-side line can't be mapped because the patch isn't loaded.
 */
export function workspaceCompareNewSideLine(
  fileDiff: Pick<FileDiffMetadata, "hunks"> | undefined,
  lineNumber: number,
  side: "deletions" | "additions" | undefined,
): number | undefined {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
  if (side !== "deletions") return lineNumber;
  if (!fileDiff) return undefined;
  let delta = 0;
  for (const hunk of fileDiff.hunks) {
    // A zero-length range names the line before it: `-3,0` inserts after old
    // line 3, so the hunk's first old line would be 4.
    let oldLine =
      hunk.deletionCount === 0 ? hunk.deletionStart + 1 : hunk.deletionStart;
    let newLine =
      hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;
    if (lineNumber < oldLine) break;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        if (lineNumber < oldLine + content.lines)
          return newLine + (lineNumber - oldLine);
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      if (lineNumber < oldLine + content.deletions) {
        return content.additions > 0
          ? newLine + Math.min(lineNumber - oldLine, content.additions - 1)
          : Math.max(1, newLine - 1);
      }
      oldLine += content.deletions;
      newLine += content.additions;
    }
    delta = newLine - oldLine;
  }
  return Math.max(1, lineNumber + delta);
}
