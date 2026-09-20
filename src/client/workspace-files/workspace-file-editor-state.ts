import type { WorkspaceFileRootId } from "../../shared/index.js";

export interface WorkspaceFileAddress {
  readonly rootId: WorkspaceFileRootId;
  readonly path: string;
}

export type WorkspaceFileDocumentKey = string & {
  readonly __workspaceFileDocumentKey: unique symbol;
};

/** Internal map identity. Paths cannot contain NUL and root ids are validated opaque ids. */
export function workspaceFileDocumentKey(
  address: WorkspaceFileAddress,
): WorkspaceFileDocumentKey {
  return `${address.rootId}\0${address.path}` as WorkspaceFileDocumentKey;
}

export function sameWorkspaceFileAddress(
  left: WorkspaceFileAddress | undefined,
  right: WorkspaceFileAddress | undefined,
): boolean {
  return left === right || (
    left !== undefined && right !== undefined &&
    left.rootId === right.rootId && left.path === right.path
  );
}

export type WorkspaceFileSaveState = "idle" | "saving" | "conflict" | "error";

export interface WorkspaceFileDocumentState extends WorkspaceFileAddress {
  readonly generation: number;
  readonly revision: string;
  readonly baseContent: string;
  readonly content: string;
  readonly editable: boolean;
  readonly truncated: boolean;
  readonly editing: boolean;
  readonly saveState: WorkspaceFileSaveState;
  readonly saveError?: string;
}

export type WorkspaceFileDocumentsState = ReadonlyMap<
  WorkspaceFileDocumentKey,
  WorkspaceFileDocumentState
>;

export const EMPTY_WORKSPACE_FILE_DOCUMENTS: WorkspaceFileDocumentsState = new Map();

type AddressAction = WorkspaceFileAddress;
export type WorkspaceFileDocumentAction =
  | { readonly type: "reset" }
  | ({ readonly type: "loaded"; readonly generation: number; readonly revision: string;
      readonly content: string; readonly editable: boolean; readonly truncated: boolean } & AddressAction)
  | ({ readonly type: "closed" } & AddressAction)
  | ({ readonly type: "changed"; readonly content: string } & AddressAction)
  | ({ readonly type: "set_editing"; readonly editing: boolean } & AddressAction)
  | ({ readonly type: "save_started"; readonly generation: number } & AddressAction)
  | ({ readonly type: "save_succeeded"; readonly generation: number;
      readonly revision: string; readonly savedContent: string } & AddressAction)
  | ({ readonly type: "save_conflicted"; readonly generation: number } & AddressAction)
  | ({ readonly type: "save_failed"; readonly generation: number; readonly message: string } & AddressAction);

export function workspaceFileDocumentsReducer(
  state: WorkspaceFileDocumentsState,
  action: WorkspaceFileDocumentAction,
): WorkspaceFileDocumentsState {
  if (action.type === "reset") return state.size === 0 ? state : EMPTY_WORKSPACE_FILE_DOCUMENTS;
  const key = workspaceFileDocumentKey(action);
  if (action.type === "loaded") {
    const next = new Map(state);
    next.set(key, {
      rootId: action.rootId, path: action.path, generation: action.generation,
      revision: action.revision, baseContent: action.content, content: action.content,
      editable: action.editable, truncated: action.truncated, editing: false, saveState: "idle",
    });
    return next;
  }
  if (action.type === "closed") {
    if (!state.has(key)) return state;
    const next = new Map(state); next.delete(key); return next;
  }
  const current = state.get(key);
  if (!current) return state;
  if ("generation" in action && action.generation !== current.generation) return state;
  const updated = documentTransition(current, action);
  if (updated === current) return state;
  const next = new Map(state); next.set(key, updated); return next;
}

function documentTransition(
  state: WorkspaceFileDocumentState,
  action: Exclude<WorkspaceFileDocumentAction, { type: "reset" | "loaded" | "closed" }>,
): WorkspaceFileDocumentState {
  switch (action.type) {
    case "changed": return { ...state, content: action.content,
      saveState: state.saveState === "saving" ? "saving" : "idle", saveError: undefined };
    case "set_editing": return state.editable && !state.truncated ? { ...state, editing: action.editing } : state;
    case "save_started": return { ...state, saveState: "saving", saveError: undefined };
    case "save_succeeded": return { ...state, revision: action.revision,
      baseContent: action.savedContent, saveState: "idle", saveError: undefined };
    case "save_conflicted": return { ...state, saveState: "conflict", saveError: undefined };
    case "save_failed": return { ...state, saveState: "error", saveError: action.message };
  }
}

export function workspaceFileDocumentIsDirty(
  document: WorkspaceFileDocumentState | undefined,
): boolean {
  return document !== undefined && document.content !== document.baseContent;
}
