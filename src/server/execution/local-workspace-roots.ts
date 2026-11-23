import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathIsWithin } from "../path-containment.js";
import type { WorkspaceRootGrant } from "./workspace-root-grant.js";

export type LocalWorkspaceRootGrant = WorkspaceRootGrant & {readonly declaredPath: string};

export function canonicalLocalRootPath(declaredPath: string): string | undefined {
  try {
    const path = realpathSync.native(declaredPath);
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

export function isWithinLocalWorkspaceRoot(candidate: string, root: string): boolean {
  return path.isAbsolute(candidate) && path.normalize(candidate) === candidate && pathIsWithin(root, candidate);
}

/** Preserve the configured grant identity across the lexical and canonical
 * spellings of a local directory. Missing roots confer no filesystem access. */
export function canonicalLocalWorkspaceRoots(roots: readonly WorkspaceRootGrant[]): readonly LocalWorkspaceRootGrant[] {
  return roots.flatMap(root => {
    const path = canonicalLocalRootPath(root.path);
    return path ? [{ ...root, path, declaredPath: root.path, contains: (candidate: string) => isWithinLocalWorkspaceRoot(candidate, path) }] : [];
  });
}
