import { isWithinRemoteRoot } from "./remote-path.js";

export type WorkspaceRootGrant = {
  readonly id: string;
  readonly path: string;
  readonly generation: number;
  /** Local grants use native path semantics, including literal POSIX backslashes. */
  readonly contains?: (canonicalPath: string) => boolean;
};

export function workspaceRootGrant(
  roots: readonly WorkspaceRootGrant[],
  canonicalPath: string,
  binding?: { readonly authorityRootId?: string; readonly authorityRevision: number },
): WorkspaceRootGrant | undefined {
  // The longest of the component-wise containing paths is the deepest root.
  let selected: WorkspaceRootGrant | undefined;
  for (const root of roots) {
    if (binding && (root.id !== binding.authorityRootId || root.generation !== binding.authorityRevision)) continue;
    if (!(root.contains?.(canonicalPath) ?? isWithinRemoteRoot(canonicalPath, root.path))) continue;
    if (!selected || root.path.length > selected.path.length ||
        (root.path.length === selected.path.length && root.id < selected.id)) selected = root;
  }
  return selected;
}
