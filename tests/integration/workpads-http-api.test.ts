import { UsageService } from "../../src/server/usage/usage-service.js";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
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
    usage: new UsageService(database, {enabled: true}),
    questions: {} as never,
    cannedPrompts: {} as never,
    workpads: new WorkpadService(
      new WorkpadRepository(database),
      { publishWorkpadChange: vi.fn().mockResolvedValue(undefined), handoffThreadChange: vi.fn() },
    ),
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true,
      experimentalUsageEnabled: false,
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
  return { database, scope, app, get, mutate, changeOwner: () => { activeScope = { ...scope, principalId: "another-user" }; } };
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
      // The former workspace scope has no alias; a project scope names its project.
      await f.get("/api/workpads?scopeKind=workspace&workspaceId=x").expect(400);
      await f.get("/api/workpads?scopeKind=global&projectId=x").expect(400);
      await f.get("/api/workpads?scopeKind=global&limit=NaN").expect(400);
      const { workpad: pad } = (await f.mutate("post", "/api/workpads").send({ title: "Atomic", scope: { kind: "global" }, content: "one two two" }).expect(201)).body;
      await f.mutate("patch", `/api/workpads/${pad.id}`).send({ expectedRevision: pad.revision, edit: { kind: "patch", edits: [{ oldText: "one", newText: "changed" }, { oldText: "two", newText: "ambiguous" }] } }).expect(409);
      expect((await f.get(`/api/workpads/${pad.id}`).expect(200)).body.workpad).toEqual(pad);
    } finally { f.database.close(); }
  });

  it("deletes active and archived workpads permanently for their owner only", async () => {
    const f = fixture();
    try {
      const create = async (title: string) => (await f.mutate("post", "/api/workpads").send({ title, scope: { kind: "global" }, content: "Text" }).expect(201)).body.workpad as { id: string; revision: number };
      const active = await create("Active");
      const archived = await create("Archived");
      await f.mutate("patch", `/api/workpads/${archived.id}`).send({ expectedRevision: archived.revision, archived: true }).expect(200);
      const foreign = await create("Foreign");
      await request(f.app).delete(`/api/workpads/${active.id}`).set("Host", "127.0.0.1:4783").expect(403);
      await f.mutate("delete", `/api/workpads/${"x".repeat(129)}`).expect(400);
      await f.mutate("delete", `/api/workpads/${randomUUID()}`).expect(404);

      for (const pad of [active, archived]) {
        const deleted = await f.mutate("delete", `/api/workpads/${pad.id}`).expect(204);
        expect(deleted.text).toBe("");
        expect(deleted.headers["cache-control"]).toBe("no-store");
        const path = `/api/workpads/${pad.id}`;
        for (const read of [path, `${path}/revisions`, `${path}/revisions/0`, `${path}/draft`]) await f.get(read).expect(404);
        await f.mutate("delete", path).expect(404);
      }
      expect((await f.get("/api/workpads/counts").expect(200)).body).toEqual({
        active: { thread: null, project: null, projectWithThreads: null, global: 1, all: 1 },
        archived: { thread: null, project: null, projectWithThreads: null, global: 0, all: 0 },
      });
      f.changeOwner();
      await f.mutate("delete", `/api/workpads/${foreign.id}`).expect(404);
      expect(f.database.prepare("SELECT title FROM workpads WHERE id = ?").get(foreign.id)).toEqual({ title: "Foreign" });
    } finally { f.database.close(); }
  });

  it("lists by sort across pages and counts each panel view", async () => {
    const f = fixture();
    try {
      const environmentId = (f.database.prepare("SELECT id FROM execution_environments LIMIT 1").get() as { id: string }).id;
      const profileId = (f.database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string }).id;
      const location = new InventoryRepository(f.database).upsertWorkspace(f.scope, {
        environmentId, canonicalPath: "/tmp/workpads-http", displayName: "Workpads HTTP", project: { kind: "new", name: "Workpads HTTP" },
        available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 100,
      });
      const projectId = location.projectId;
      const threadId = new ConversationBindingRepository(f.database).createUnboundThread(f.scope, { workspaceId: location.id, connectionProfileId: profileId, title: "HTTP thread", now: 100 }).id;
      const create = async (title: string, scope: unknown) => (await f.mutate("post", "/api/workpads").send({ title, scope }).expect(201)).body.workpad as { id: string; revision: number };
      const global = await create("b global", { kind: "global" });
      const thread = await create("c thread", { kind: "thread", threadId });
      const project = await create("a project", { kind: "project", projectId });
      const ids = (response: { body: { items: { id: string }[] } }) => response.body.items.map(item => item.id);
      const readAll = async (path: string) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await f.get(`${path}${cursor ? `&cursor=${cursor}` : ""}`).expect(200);
          seen.push(...ids(page));
          cursor = page.body.nextCursor;
          expect(cursor?.length ?? 0).toBeLessThanOrEqual(256);
        } while (cursor);
        return seen;
      };

      expect(ids(await f.get("/api/workpads?scopeKind=global&scopeMode=subtree").expect(200))).toEqual([project.id, thread.id, global.id]);
      expect(ids(await f.get("/api/workpads?scopeKind=global&scopeMode=subtree&sort=title").expect(200))).toEqual([project.id, global.id, thread.id]);
      expect(ids(await f.get("/api/workpads?scopeKind=global&scopeMode=subtree&sort=newest").expect(200))).toEqual([project.id, thread.id, global.id]);
      expect(await readAll("/api/workpads?scopeKind=global&scopeMode=subtree&sort=title&limit=1")).toEqual([project.id, global.id, thread.id]);
      const first = await f.get("/api/workpads?scopeKind=global&scopeMode=subtree&sort=title&limit=1").expect(200);
      expect((await f.get(`/api/workpads?scopeKind=global&scopeMode=subtree&limit=1&cursor=${first.body.nextCursor}`).expect(409)).body.error.code).toBe("cursor_invalid");
      await f.get("/api/workpads?scopeKind=global&sort=oldest").expect(400);
      // Lists are not grouped; there is no grouping or lead project parameter.
      await f.get("/api/workpads?scopeKind=global&group=project").expect(400);
      await f.get(`/api/workpads?scopeKind=global&leadProjectId=${projectId}`).expect(400);
      await f.get(`/api/workpads?scopeKind=global&cursor=${"a".repeat(257)}`).expect(400);
      await f.get(`/api/workpads?scopeKind=global&cursor=${"a".repeat(256)}`).expect(409);
      // The longest titles still page within the 256-character cursor bound.
      const long = [await create(`${"漢".repeat(239)}1`, { kind: "global" }), await create(`${"漢".repeat(239)}2`, { kind: "global" })];
      for (const limit of [1, 2]) {
        expect(await readAll(`/api/workpads?scopeKind=global&sort=title&limit=${limit}`)).toEqual([global.id, ...long.map(pad => pad.id)]);
      }

      await f.mutate("patch", `/api/workpads/${thread.id}`).send({ expectedRevision: thread.revision, archived: true }).expect(200);
      const counts = await f.get(`/api/workpads/counts?threadId=${threadId}&projectId=${projectId}`).expect(200);
      expect(counts.headers["cache-control"]).toBe("no-store");
      expect(counts.body).toEqual({
        active: { thread: 0, project: 1, projectWithThreads: 1, global: 3, all: 4 },
        archived: { thread: 1, project: 0, projectWithThreads: 1, global: 0, all: 1 },
      });
      expect((await f.get("/api/workpads/counts").expect(200)).body).toEqual({
        active: { thread: null, project: null, projectWithThreads: null, global: 3, all: 4 },
        archived: { thread: null, project: null, projectWithThreads: null, global: 0, all: 1 },
      });
      await f.get(`/api/workpads/counts?threadId=${randomUUID()}`).expect(404);
      await f.get(`/api/workpads/counts?projectId=${randomUUID()}`).expect(404);
      for (const query of ["threadId=", "threadId=not-a-thread", "scopeKind=global", `threadId=${threadId}&threadId=${threadId}`]) {
        await f.get(`/api/workpads/counts?${query}`).expect(400);
      }
      f.changeOwner();
      await f.get(`/api/workpads/counts?threadId=${threadId}`).expect(404);
      await f.get(`/api/workpads/counts?projectId=${projectId}`).expect(404);
      expect((await f.get("/api/workpads/counts").expect(200)).body.active).toEqual({ thread: null, project: null, projectWithThreads: null, global: 0, all: 0 });
    } finally { f.database.close(); }
  });
});
