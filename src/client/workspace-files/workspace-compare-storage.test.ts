import { describe, expect, it } from "vitest";
import { createWorkspaceCompareStorage } from "./workspace-compare-storage.js";
import type { WorkspaceCompareNavigation } from "./workspace-compare-navigation.js";
const navigation: WorkspaceCompareNavigation = {
  repository: { repositoryKey: "repo", displayName: "project" }, base: { kind: "commit", commitHash: "a".repeat(40) },
  head: { kind: "working_tree" }, mode: "direct", filter: "src", navigatorWidth: 258,
  collapsedDirectories: ["tests"], preferences: { diffStyle: "split", overflow: "scroll" },
  file: { newPath: "src/a.ts", changeKind: "modified", side: "additions", line: 40, offset: 2 },
};
describe("scoped Files navigation storage", () => {
  it("restores semantic anchors across clients without sharing server, principal, workspace or root state", () => {
    const map = new Map<string,string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key,value); } };
    createWorkspaceCompareStorage(storage).set("server-a/principal-a", "workspace", "primary", { mode: "compare", navigation });
    const next = createWorkspaceCompareStorage(storage);
    expect(next.get("server-a/principal-a", "workspace", "primary")?.navigation).toEqual(navigation);
    for (const [scope, workspace, root] of [["server-b/principal-a","workspace","primary"],["server-a/principal-b","workspace","primary"],["server-a/principal-a","other","primary"],["server-a/principal-a","workspace","other"]]) {
      expect(next.get(scope,workspace,root!)).toBeUndefined();
    }
    expect(next.get(undefined,"workspace","primary")).toBeUndefined();
    expect([...map.values()][0]).not.toContain("revisionId");
  });
  it("bounds retained workspaces and retains navigation if browser storage throws", () => {
    const store = createWorkspaceCompareStorage({ getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("quota"); } });
    for (let i=0;i<40;i++) store.set("scope", String(i), "primary", { mode: "compare", navigation });
    expect(store.get("scope","0","primary")).toBeUndefined();
    expect(store.get("scope","39","primary")?.navigation).toEqual(navigation);
  });
  it("returns only state fields so copying preferences cannot override the destination root", () => {
    const store = createWorkspaceCompareStorage();
    store.set("scope", "first", "primary", { mode: "compare", navigation });
    const state = store.get("scope", "first", "primary")!;
    expect(state).not.toHaveProperty("workspaceId");
    expect(state).not.toHaveProperty("rootId");
    store.set("scope", "second", "other", state);
    expect(store.get("scope", "second", "other")?.navigation).toEqual(navigation);
  });
  it("keeps encoded records within the reload limit and preserves state against oversized input", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    const store = createWorkspaceCompareStorage(storage);
    const large = { ...navigation, collapsedDirectories: Array.from({ length: 200 }, (_, index) => `${index}/${"a".repeat(2000)}`) };
    for (let i = 0; i < 4; i++) store.set("scope", String(i), "primary", { mode: "compare", navigation: large });
    expect([...map.values()][0]!.length).toBeLessThanOrEqual(1_000_000);
    expect(createWorkspaceCompareStorage(storage).get("scope", "3", "primary")?.navigation).toEqual(large);
    store.set("scope", "3", "primary", { mode: "compare", navigation: { ...navigation, collapsedDirectories: Array(2000).fill("a".repeat(2000)) } });
    expect(store.get("scope", "3", "primary")?.navigation).toEqual(large);
  });
  it("discards obsolete, malformed, and authority-bearing records", () => {
    for (const raw of ['{', JSON.stringify({ version: 0, entries: [] }), JSON.stringify({ version: 1, entries: [{workspaceId:"w",rootId:"primary",mode:"compare",navigation:{...navigation,revisionId:"untrusted"}}] })]) {
      const store = createWorkspaceCompareStorage({ getItem: () => raw, setItem: () => {} });
      expect(store.get("scope","w","primary")).toBeUndefined();
    }
  });
});
