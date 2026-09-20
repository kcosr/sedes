import { describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE_FILE_DOCUMENTS, workspaceFileDocumentIsDirty, workspaceFileDocumentKey, workspaceFileDocumentsReducer, type WorkspaceFileAddress } from "./workspace-file-editor-state.js";
import { workspaceFileSupplementalRootIdSchema } from "../../shared/index.js";

const primary: WorkspaceFileAddress = { rootId: "primary", path: "README.md" };
const context: WorkspaceFileAddress = { rootId: workspaceFileSupplementalRootIdSchema.parse("root-context"), path: "README.md" };
const loaded = (address: WorkspaceFileAddress, generation = 1) => ({ type: "loaded" as const, ...address, generation, revision: "r1", content: "one", editable: true, truncated: false });

describe("workspaceFileDocumentsReducer", () => {
  it("isolates identical relative paths by root", () => {
    let state = workspaceFileDocumentsReducer(EMPTY_WORKSPACE_FILE_DOCUMENTS, loaded(primary));
    state = workspaceFileDocumentsReducer(state, loaded(context));
    state = workspaceFileDocumentsReducer(state, { type: "changed", ...context, content: "context draft" });
    expect(state.size).toBe(2);
    expect(workspaceFileDocumentIsDirty(state.get(workspaceFileDocumentKey(primary)))).toBe(false);
    expect(workspaceFileDocumentIsDirty(state.get(workspaceFileDocumentKey(context)))).toBe(true);
  });

  it("ignores an in-flight save after the addressed document was discarded and reloaded", () => {
    let state = workspaceFileDocumentsReducer(EMPTY_WORKSPACE_FILE_DOCUMENTS, loaded(context, 1));
    state = workspaceFileDocumentsReducer(state, { type: "save_started", ...context, generation: 1 });
    state = workspaceFileDocumentsReducer(state, { type: "closed", ...context });
    state = workspaceFileDocumentsReducer(state, loaded(context, 2));
    const stale = workspaceFileDocumentsReducer(state, { type: "save_succeeded", ...context, generation: 1, revision: "stale", savedContent: "stale" });
    expect(stale).toBe(state);
    expect(stale.get(workspaceFileDocumentKey(context))?.revision).toBe("r1");
  });

  it("keeps edits made during a save dirty after the saved base advances", () => {
    let state = workspaceFileDocumentsReducer(EMPTY_WORKSPACE_FILE_DOCUMENTS, loaded(primary));
    state = workspaceFileDocumentsReducer(state, { type: "changed", ...primary, content: "two" });
    state = workspaceFileDocumentsReducer(state, { type: "save_started", ...primary, generation: 1 });
    state = workspaceFileDocumentsReducer(state, { type: "changed", ...primary, content: "three" });
    state = workspaceFileDocumentsReducer(state, { type: "save_succeeded", ...primary, generation: 1, revision: "r2", savedContent: "two" });
    const document = state.get(workspaceFileDocumentKey(primary));
    expect(document).toMatchObject({ baseContent: "two", content: "three", revision: "r2" });
    expect(workspaceFileDocumentIsDirty(document)).toBe(true);
  });
});
