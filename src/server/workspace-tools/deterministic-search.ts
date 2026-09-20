export class SearchBudgetExceededError extends Error {
  readonly diagnosticCode = "search_budget_exceeded" as const;

  constructor() {
    super("search_budget_exceeded");
    this.name = "SearchBudgetExceededError";
  }
}

export interface FindScanEvidence {
  readonly paths: string[];
  readonly completed: boolean;
  readonly scannedEntries: number;
  readonly scannedBytes: number;
  readonly durationMilliseconds: number;
}

export interface FindSearchLimits {
  readonly maximumScannedEntries: number;
  readonly maximumScannedBytes: number;
  readonly maximumDurationMilliseconds: number;
  readonly maximumResults: number;
  readonly maximumResultBytes: number;
}

export interface DeterministicFindResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly scannedEntries: number;
  readonly scannedBytes: number;
}

/**
 * Normalize a completed fd scan. Arrival order never affects which bounded
 * result survives: the complete scan is ordered first, then presentation caps
 * are applied. An incomplete or over-budget scan never returns a partial set.
 */
export function normalizeDeterministicFind(
  scan: FindScanEvidence,
  limits: FindSearchLimits,
): DeterministicFindResult {
  assertPositiveIntegerLimits({ ...limits });
  if (
    !Number.isSafeInteger(scan.scannedEntries) ||
    scan.scannedEntries < 0 ||
    !Number.isSafeInteger(scan.scannedBytes) ||
    scan.scannedBytes < 0 ||
    !Number.isFinite(scan.durationMilliseconds) ||
    scan.durationMilliseconds < 0
  ) {
    throw new SearchBudgetExceededError();
  }
  if (
    !scan.completed ||
    scan.scannedEntries !== scan.paths.length ||
    scan.scannedEntries > limits.maximumScannedEntries ||
    scan.scannedBytes > limits.maximumScannedBytes ||
    scan.durationMilliseconds > limits.maximumDurationMilliseconds
  ) {
    throw new SearchBudgetExceededError();
  }
  for (const candidate of scan.paths)
    assertWorkspaceRelativeSearchPath(candidate);

  const ordered = [...scan.paths].sort(compareUtf8Lexically);
  const paths: string[] = [];
  let retainedBytes = 0;
  for (const candidate of ordered) {
    if (paths.length === limits.maximumResults) break;
    const encodedBytes = Buffer.byteLength(candidate, "utf8") + 1;
    if (retainedBytes + encodedBytes > limits.maximumResultBytes) break;
    paths.push(candidate);
    retainedBytes += encodedBytes;
  }
  return {
    paths,
    truncated: paths.length !== ordered.length,
    scannedEntries: scan.scannedEntries,
    scannedBytes: scan.scannedBytes,
  };
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface DeterministicGrepResult {
  readonly matches: readonly GrepMatch[];
  readonly truncated: boolean;
}

export function sortDeterministicGrepMatches(
  matches: readonly GrepMatch[],
): readonly GrepMatch[] {
  for (const match of matches) {
    assertWorkspaceRelativeSearchPath(match.path);
    if (!Number.isSafeInteger(match.line) || match.line < 1) {
      throw new Error("search_grep_line_invalid");
    }
    if (!Number.isSafeInteger(match.column) || match.column < 1) {
      throw new Error("search_grep_column_invalid");
    }
  }
  return [...matches].sort(
    (left, right) =>
      compareUtf8Lexically(left.path, right.path) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

/** Apply grep presentation bounds only after canonical path/line/column order. */
export function normalizeDeterministicGrep(
  matches: readonly GrepMatch[],
  limits: {
    readonly maximumResults: number;
    readonly maximumResultBytes: number;
  },
): DeterministicGrepResult {
  assertPositiveIntegerLimits(limits);
  const ordered = sortDeterministicGrepMatches(matches);
  const retained: GrepMatch[] = [];
  let retainedBytes = 0;
  for (const match of ordered) {
    if (retained.length === limits.maximumResults) break;
    // This is the stable plain-text presentation shape consumed by the Pi
    // adapter. Include separators and the terminating newline in the budget.
    const bytes = Buffer.byteLength(
      `${match.path}:${match.line}:${match.column}:${match.text}\n`,
      "utf8",
    );
    if (retainedBytes + bytes > limits.maximumResultBytes) break;
    retained.push(match);
    retainedBytes += bytes;
  }
  return { matches: retained, truncated: retained.length !== ordered.length };
}

export function compareUtf8Lexically(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertWorkspaceRelativeSearchPath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("search_path_invalid");
  }
}

function assertPositiveIntegerLimits(
  limits: Readonly<Record<string, number>>,
): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("search_limits_invalid");
    }
  }
}
