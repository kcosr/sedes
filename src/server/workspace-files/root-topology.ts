import { pathIsWithin } from "../path-containment.js";

export type WorkspaceFileRootMatch = {
  readonly canonicalPath: string;
  readonly primary: boolean;
};

/** Two roots overlap when either canonical directory contains the other. */
export function workspaceFileRootsOverlap(
  left: string,
  right: string,
): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

/**
 * A supplemental root may contain or sit beneath Primary. This permits both
 * broader context directories and nested repositories with their own Compare
 * view, without changing the project's cwd. Only an exact duplicate conflicts.
 */
export function supplementalRootConflictsWithPrimary(
  primaryCanonicalPath: string,
  supplementalCanonicalPath: string,
): boolean {
  return primaryCanonicalPath === supplementalCanonicalPath;
}

/**
 * Selects the unique deepest root from one containment chain. Unrelated roots
 * that both claim a match remain ambiguous and fail closed. The primary root
 * wins only an otherwise-exact canonical-path tie.
 */
export function mostSpecificWorkspaceFileRootMatch<
  Match extends WorkspaceFileRootMatch,
>(matches: readonly Match[]): Match | undefined {
  const deepest = matches.filter((candidate) =>
    matches.every((other) =>
      pathIsWithin(other.canonicalPath, candidate.canonicalPath),
    ),
  );
  if (deepest.length === 1) return deepest[0];
  const primary = deepest.filter((candidate) => candidate.primary);
  return primary.length === 1 ? primary[0] : undefined;
}
