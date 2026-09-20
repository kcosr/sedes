/**
 * Minimal unified-diff parser for the inline file_change diff block.
 *
 * Input is the (possibly truncated) patch string transported on
 * `FileChangeItem.diff.text`. Parsing is strict: if the text does not look
 * like a unified diff, `parseUnifiedDiff` returns `undefined` so callers can
 * fall back to raw text rendering (truncated patches may be cut mid-hunk).
 */

export type DiffRowKind = "context" | "add" | "del";

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** One-based line number on the old-file side; absent for added rows. */
  readonly oldLine?: number;
  /** One-based line number on the new-file side; absent for removed rows. */
  readonly newLine?: number;
  /** Line content with the leading +/-/space marker stripped. */
  readonly text: string;
}

export interface DiffHunk {
  /** Raw @@ header line, e.g. "@@ -240,3 +240,4 @@ context". */
  readonly header: string;
  readonly rows: readonly DiffRow[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function looksLikePatchHeader(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("Binary files")
  );
}

/**
 * Mid-hunk fallback trigger: only letter-prefixed metadata markers are
 * unambiguous here. `---`/`+++` are excluded deliberately — inside a hunk
 * they collide with legitimate rows (deleting a line that starts with `--`,
 * adding one that starts with `++`). Real multi-file patches lead each file
 * section with `diff --git`, which this check catches instead.
 */
function looksLikeMidHunkMetadata(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("Binary files")
  );
}

/**
 * Parse a unified diff into hunks of typed rows. Returns `undefined` when the
 * input contains no hunk header or a hunk row violates the patch shape (for
 * example a truncated final hunk cut mid-line is still fine; garbage is not).
 */
export function parseUnifiedDiff(text: string): DiffHunk[] | undefined {
  // Normalize CRLF (countUnifiedDiff accepts it) and drop a single trailing
  // newline so it cannot become a phantom blank context row.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = normalized.split("\n");
  const hunks: DiffHunk[] = [];
  let rows: DiffRow[] | undefined;
  let oldLine = 0;
  let newLine = 0;
  let sawHunk = false;

  const flush = (): void => {
    if (rows !== undefined) {
      const header = hunks[hunks.length - 1]?.header;
      if (header !== undefined) {
        hunks[hunks.length - 1] = { header, rows: Object.freeze(rows) };
      }
      rows = undefined;
    }
  };

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      sawHunk = true;
      flush();
      hunks.push({ header: line, rows: [] });
      rows = [];
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }
    if (rows === undefined) {
      // Pre-hunk metadata (---/+++/diff/index/...) is presentation noise.
      if (line === "" || looksLikePatchHeader(line)) continue;
      return undefined;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" marker: keep the previous row as-is.
      continue;
    }
    if (looksLikeMidHunkMetadata(line)) {
      // Patch metadata arriving mid-hunk (e.g. the next file's diff header
      // in a concatenated multi-file patch) is not row content; bail to raw.
      return undefined;
    }
    const marker = line.charAt(0);
    const content = line.slice(1);
    if (marker === "+") {
      rows.push({ kind: "add", newLine: newLine++, text: content });
    } else if (marker === "-") {
      rows.push({ kind: "del", oldLine: oldLine++, text: content });
    } else if (marker === " " || line === "") {
      rows.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: marker === " " ? content : line,
      });
    } else {
      return undefined;
    }
  }
  flush();

  if (!sawHunk) return undefined;
  return hunks;
}
