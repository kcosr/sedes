import { UsageService } from "../../src/server/usage/usage-service.js";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { WorkpadService } from "../../src/server/domain/workpad-service.js";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";

function fixture() {
  const { database, scope } = savedAgentDatabase();
  let activeScope = scope;
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const app = createNormalizedApp({
    usage: new UsageService(database),
    questions: {} as never,
    cannedPrompts: {} as never,
    workpads: new WorkpadService(
      new WorkpadRepository(database),
      { publishWorkpadChange: vi.fn().mockResolvedValue(undefined) },
    ),
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/canned-prompts-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
    },
    csrfToken: "canned-prompts-csrf",
    identity: { resolve: async () => activeScope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: {} as never,
    threadTemplates: {} as never,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: { handoffThreadChange: vi.fn() } as never,
    threads: { snapshot: unused } as never,
    history: { loadOlder: unused } as never,
    threadRuntimes: { quiet: unused } as never,
    threadSnapshots: { publish: unused } as never,
    lifecycle: { createServerDraft: unused } as never,
    inventory: {} as never,
    threadGroups: {} as never,
    tasks: {} as never,
    workspaceFiles: {} as never,
    threadArchives: {} as never,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets: {} as never,
    attention: {} as never,
    execution: {} as never,
    automations: {} as never,
    automationPrechecks: {} as never,
    agentTools: unavailableAgentToolRouterDependencies(),
    lineage: {
      forkManual: unused,
      updatePlacement: unused,
      listDescendants: unused,
    },
  });
  const get = (path: string) => request(app).get(path).set("Host", "127.0.0.1:4783");
  const mutate = (method: "post" | "put" | "patch" | "delete", path: string) =>
    request(app)[method](path).set("Host", "127.0.0.1:4783").set("X-CSRF-Token", "canned-prompts-csrf");
  return { database, app, get, mutate, changeOwner: () => { activeScope = { ...scope, principalId: "another-user" }; } };
}

describe("Workpads HTTP", () => {
  it("persists revisions and shared drafts, rejects stale writes, and protects history by current ownership", async () => {
    const f = fixture();
    try {
      const created = await f.mutate("post", "/api/workpads").send({ title: "Integration", scope: { kind: "global" }, content: "Use 30 minutes.\nKeep the basket." }).expect(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const pad = created.body.workpad;
      const path = `/api/workpads/${pad.id}`;
      const list = await f.get("/api/workpads?scopeKind=global").expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([pad.id]);
      const draft = (await f.get(`${path}/draft`).expect(200)).body.draft;
      const saved = (await f.mutate("put", `${path}/draft`).send({ expectedRevision: draft.revision, baseRevision: pad.revision, content: "Use 15 minutes.\nKeep the basket." }).expect(200)).body.draft;
      const agentChange = (await f.mutate("patch", path).send({ expectedRevision: pad.revision, edit: { kind: "append", text: "\nRetry payments safely." } }).expect(200)).body.workpad;
      await f.mutate("post", `${path}/draft/commit`).send({ expectedRevision: pad.revision, expectedDraftRevision: saved.revision }).expect(409);
      expect((await f.get(`${path}/draft`)).body.draft.content).toBe(saved.content);
      await f.mutate("patch", path).send({ expectedRevision: pad.revision, edit: { kind: "replace", content: "stale" } }).expect(409);
      const resolved = (await f.mutate("put", `${path}/draft`).send({ expectedRevision: saved.revision, baseRevision: agentChange.revision, content: "Use 15 minutes.\nKeep the basket.\nRetry payments safely." }).expect(200)).body.draft;
      const committed = (await f.mutate("post", `${path}/draft/commit`).send({ expectedRevision: agentChange.revision, expectedDraftRevision: resolved.revision }).expect(200)).body;
      expect(committed.workpad.content).toContain("15 minutes");
      expect(committed.draft.baseRevision).toBe(committed.workpad.revision);
      const original = (await f.get(`${path}/revisions/${pad.revision}`).expect(200)).body.revision;
      expect(original.content).toBe(pad.content);
      const history = (await f.get(`${path}/revisions`).expect(200)).body.items;
      expect(history).toHaveLength(3);
      await f.mutate("patch", path).send({ expectedRevision: committed.workpad.revision, archived: true }).expect(200);
      expect((await f.get("/api/workpads?scopeKind=global")).body.items).toEqual([]);
      expect((await f.get("/api/workpads?scopeKind=global&archived=true")).body.items).toHaveLength(1);
      f.changeOwner();
      await f.get(path).expect(404);
      await f.get(`${path}/revisions/${pad.revision}`).expect(404);
      await f.get(`${path}/draft`).expect(404);
      expect((await f.get("/api/workpads?scopeKind=global")).body.items).toEqual([]);
    } finally { f.database.close(); }
  });

  it("validates scope queries, authors, patch batches, and request security", async () => {
    const f = fixture();
    try {
      await request(f.app).post("/api/workpads").set("Host", "127.0.0.1:4783").send({ title: "Denied", scope: { kind: "global" } }).expect(403);
      await f.mutate("post", "/api/workpads").send({ title: "Forged", scope: { kind: "global" }, author: { kind: "agent", threadId: "fake" } }).expect(400);
      await f.get("/api/workpads?scopeKind=global&threadId=wrong").expect(400);
      await f.get("/api/workpads?scopeKind=thread").expect(400);
      await f.get("/api/workpads?scopeKind=global&limit=NaN").expect(400);
      const { workpad: pad } = (await f.mutate("post", "/api/workpads").send({ title: "Atomic", scope: { kind: "global" }, content: "one two two" }).expect(201)).body;
      await f.mutate("patch", `/api/workpads/${pad.id}`).send({ expectedRevision: pad.revision, edit: { kind: "patch", edits: [{ oldText: "one", newText: "changed" }, { oldText: "two", newText: "ambiguous" }] } }).expect(409);
      expect((await f.get(`/api/workpads/${pad.id}`).expect(200)).body.workpad).toEqual(pad);
    } finally { f.database.close(); }
  });
});
