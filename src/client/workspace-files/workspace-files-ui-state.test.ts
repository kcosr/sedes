import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILES_UI_STATE_VERSION,
  ancestorDirectoryPaths,
  createWorkspaceFilesUiStateCache,
  pruneWorkspaceFilesUiSnapshot,
} from "./workspace-files-ui-state.js";
import { workspaceFileRootIdSchema } from "../../shared/index.js";

const p = (rootId: string, path: string) => ({
  rootId: workspaceFileRootIdSchema.parse(rootId),
  path,
});
describe("workspace-files-ui-state", () => {
  it("derives relative ancestor directories", () =>
    expect(ancestorDirectoryPaths("src/client/app.ts")).toEqual([
      "src/",
      "src/client/",
    ]));

  it("prunes each root independently and retains dirty addressed files", () => {
    const result = pruneWorkspaceFilesUiSnapshot(
      {
        version: WORKSPACE_FILES_UI_STATE_VERSION,
        linkOnlyRootIds: [],
        tabs: {
          files: [
            p("primary", "same.md"),
            p("extra", "same.md"),
            p("extra", "dirty.md"),
          ],
          active: p("extra", "same.md"),
        },
        activeRootId: workspaceFileRootIdSchema.parse("extra"),
        treeOpen: false,
        expandedPathsByRoot: { primary: ["src/"], extra: ["docs/", "gone/"] },
      },
      new Map([
        [p("primary", "").rootId, ["same.md", "src/a.ts"]],
        [p("extra", "").rootId, ["dirty.md", "docs/a.md"]],
      ]),
      {
        retainFile: (file) =>
          file.rootId === "extra" && file.path === "dirty.md",
      },
    );
    expect(result.tabs.files).toEqual([
      p("primary", "same.md"),
      p("extra", "dirty.md"),
    ]);
    expect(result.tabs.active).toEqual(p("extra", "dirty.md"));
    expect(result.activeRootId).toBe("extra");
    expect(result.expandedPathsByRoot).toEqual({
      primary: ["src/"],
      extra: ["docs/"],
    });
  });

  it("caps root-qualified tabs and rejects obsolete cache versions", () => {
    const cache = createWorkspaceFilesUiStateCache({ maxTabs: 2 });
    cache.set("w", {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [],
      tabs: {
        files: [p("primary", "a"), p("extra", "a"), p("primary", "b")],
        active: p("primary", "a"),
      },
      activeRootId: workspaceFileRootIdSchema.parse("extra"),
      treeOpen: true,
      expandedPathsByRoot: {},
    });
    expect(cache.get("w")?.tabs).toEqual({
      files: [p("primary", "b"), p("primary", "a")],
      active: p("primary", "a"),
    });
    expect(cache.get("w")?.activeRootId).toBe("extra");
    cache.set("w", {
      version: 1,
      tabs: { files: [] },
      treeOpen: true,
      expandedPathsByRoot: {},
    } as never);
    expect(cache.get("w")).toBeUndefined();
  });

  it("never caps live tabs while the persisted cache remains bounded", () => {
    const files = Array.from({ length: 21 }, (_, index) =>
      p("primary", `file-${index}.ts`),
    );
    const result = pruneWorkspaceFilesUiSnapshot(
      {
        version: WORKSPACE_FILES_UI_STATE_VERSION,
        linkOnlyRootIds: [],
        tabs: { files, active: files[0] },
        activeRootId: workspaceFileRootIdSchema.parse("primary"),
        treeOpen: false,
        expandedPathsByRoot: {},
      },
      new Map([[p("primary", "").rootId, files.map(({ path }) => path)]]),
    );
    expect(result.tabs.files).toHaveLength(21);
    expect(result.tabs.active).toEqual(files[0]);
  });

  it("preserves expansions for partial roots and prunes only complete roots", () => {
    const result = pruneWorkspaceFilesUiSnapshot(
      {
        version: WORKSPACE_FILES_UI_STATE_VERSION,
        linkOnlyRootIds: [],
        tabs: { files: [] },
        activeRootId: workspaceFileRootIdSchema.parse("extra"),
        treeOpen: true,
        expandedPathsByRoot: {
          primary: ["src/", "gone/"],
          extra: ["docs/", "deep/"],
        },
      },
      new Map([
        [p("primary", "").rootId, ["src/a.ts"]],
        [p("extra", "").rootId, []],
      ]),
      { partialRootIds: new Set(["extra"]) },
    );
    expect(result.expandedPathsByRoot).toEqual({
      primary: ["src/"],
      extra: ["docs/", "deep/"],
    });
  });

  it("retains link-only roots only while one of their tabs is retained", () => {
    const linkRootId = p("link-sibling", "").rootId;
    const snapshot = {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      linkOnlyRootIds: [linkRootId, p("link-stale", "").rootId],
      tabs: {
        files: [p("primary", "README.md"), p("link-sibling", "src/file.ts")],
        active: p("link-sibling", "src/file.ts"),
      },
      activeRootId: p("primary", "").rootId,
      treeOpen: false,
      expandedPathsByRoot: {},
    } as const;
    const retained = pruneWorkspaceFilesUiSnapshot(
      snapshot,
      new Map([[p("primary", "").rootId, ["README.md"]]]),
      { partialRootIds: new Set([linkRootId]) },
    );
    expect(retained.tabs.files).toEqual(snapshot.tabs.files);
    expect(retained.linkOnlyRootIds).toEqual([linkRootId]);

    const pruned = pruneWorkspaceFilesUiSnapshot(
      snapshot,
      new Map([[p("primary", "").rootId, ["README.md"]]]),
    );
    expect(pruned.tabs.files).toEqual([p("primary", "README.md")]);
    expect(pruned.linkOnlyRootIds).toEqual([]);
  });
});
