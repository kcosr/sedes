import { realpathSync, statSync } from "node:fs";
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

/** Preserve the configured grant identity across the lexical and canonical
 * spellings of a local directory. Missing roots confer no filesystem access. */
export function canonicalLocalWorkspaceRoots(roots: readonly WorkspaceRootGrant[]): readonly LocalWorkspaceRootGrant[] {
  return roots.flatMap(root => {
    const path = canonicalLocalRootPath(root.path);
    return path ? [{ ...root, path, declaredPath: root.path }] : [];
  });
}
