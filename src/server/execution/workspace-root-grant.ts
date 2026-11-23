import { isWithinRemoteRoot } from "./remote-path.js";

export type WorkspaceRootGrant = {
  readonly id: string;
  readonly path: string;
  readonly generation: number;
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
    if (!isWithinRemoteRoot(canonicalPath, root.path)) continue;
    if (!selected || root.path.length > selected.path.length ||
        (root.path.length === selected.path.length && root.id < selected.id)) selected = root;
  }
  return selected;
}
