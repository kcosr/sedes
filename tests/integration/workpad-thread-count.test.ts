import { afterEach, describe, expect, it, vi } from "vitest";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { DatabaseApplicationLineageSummaryReader } from "../../src/server/application/database-application-lineage-summary-reader.js";
import { ApplicationSnapshotPublicationBoundary, ApplicationSnapshotService } from "../../src/server/application/application-snapshot-service.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { WorkpadService } from "../../src/server/domain/workpad-service.js";
import { NormalizedApplicationStore } from "../../src/client/stores/NormalizedApplicationStore.js";
import type { ApplicationEventEnvelope, NormalizedApplicationSnapshot } from "../../src/shared/protocol/application.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

function fixture() {
  const { database, scope } = savedAgentDatabase();
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id, canonicalPath: "/tmp/workpad-count", displayName: "Workpad count",
    project: { kind: "new", name: "Workpad count" }, available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 200,
  });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled = 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const [first, second, third] = ["First", "Second", "Third"].map(title => bindings.createUnboundThread(scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title, now: 300,
  }));
  const ids = [first!.id, second!.id, third!.id];
  const summaries = new DatabaseApplicationThreadSummaryReader({
    inventory, queue: new QueuedInputRepository(database), completion: new SubmissionCompletionRepository(database),
  });
  const application = new ApplicationSnapshotService(
    inventory, summaries, { captureLoadedState: async () => undefined },
    {
      read: async () => ({
        executionTargets: [{
          id: profile.id, environmentId: environment.id, label: { text: "Local Pi" },
          backend: { label: { text: "Primary Pi" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" }, available: true,
        }],
        defaultTargetId: profile.id,
      }),
      requireSelectable: async () => undefined,
    },
    new DatabaseApplicationLineageSummaryReader(new ThreadLineageRepository(database)),
    new TaskRepository(database), new ThreadGroupRepository(database), () => "unavailable",
    { summariesByThread: () => new Map() },
  );
  const boundary = new ApplicationSnapshotPublicationBoundary(application, new ScopedApplicationEventHubs());
  const repository = new WorkpadRepository(database);
  const workpads = new WorkpadService(repository, boundary);
  const hub = boundary.hub(scope);
  const events: ApplicationEventEnvelope[] = [];
  hub.subscribe(event => events.push(event));
  const counts = (snapshot: NormalizedApplicationSnapshot) => ids.map(id =>
    snapshot.threads.find(thread => thread.id === id)?.nonArchivedWorkpadCount,
  );
  cleanups.push(async () => { await boundary.close(); database.close(); });
  return { database, scope, inventory, environment, workspace, ids, summaries, application, boundary, repository, workpads, hub, events, counts };
}

describe("thread workpad counts", () => {
  it("counts exact non-archived membership with scoped index reads in snapshots and targeted summaries", async () => {
    const f = fixture();
    const [first, second] = f.ids as [string, string, string];
    const create = (threadId: string) => f.repository.create(f.scope, { title: "Notes", scope: { kind: "thread", threadId } });
    let retained = create(first);
    f.repository.update(f.scope, retained.id, { expectedRevision: retained.revision, archived: true });
    f.repository.create(f.scope, { title: "Global", scope: { kind: "global" } });
    f.repository.create(f.scope, { title: "Project", scope: { kind: "project", projectId: f.workspace.projectId } });
    f.database.transaction(() => { for (let count = 0; count < 101; count++) retained = create(first); })();
    create(second);

    // Deliberately colliding thread references under other owners must never
    // contribute to the authorized principal's count.
    f.database.prepare("INSERT INTO tenants(id, created_at) VALUES ('another-tenant', 1)").run();
    for (const owner of [
      { tenantId: f.scope.tenantId, principalId: "another-principal" },
      { tenantId: "another-tenant", principalId: f.scope.principalId },
    ]) {
      f.database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 1)")
        .run(owner.tenantId, owner.principalId);
      f.database.prepare(`INSERT INTO workpads(tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id,
        title, revision, archived_at, created_at, updated_at, document_json)
        SELECT ?, ?, id, scope_kind, project_id, thread_id, title, revision, archived_at, created_at, updated_at, document_json
        FROM workpads WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(owner.tenantId, owner.principalId, f.scope.tenantId, f.scope.principalId, retained.id);
      expect(f.summaries.listByIds(owner, [first])).toEqual([]);
      await expect(f.workpads.update(owner, retained.id, {
        expectedRevision: 0, scope: { kind: "thread", threadId: second },
      })).rejects.toMatchObject({ code: "not_found" });
    }

    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const prepare = f.database.prepare.bind(f.database);
    const spy = vi.spyOn(f.database, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("WITH requested_threads")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
          queries.push({ sql, parameters });
          return all(...parameters);
        });
      }
      return statement;
    });
    expect(f.summaries.listByIds(f.scope, [first])[0]?.nonArchivedWorkpadCount).toBe(101);
    expect(f.counts(await f.application.capture(f.scope))).toEqual([101, 1, 0]);
    spy.mockRestore();
    expect(queries).toHaveLength(2);
    for (const { sql, parameters } of queries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
      expect(plan.map(row => row.detail)).toEqual(expect.arrayContaining([
        expect.stringMatching(/SEARCH workpad USING COVERING INDEX workpads_scope \(tenant_id=\? AND owner_principal_id=\? AND scope_kind=\? AND project_id=\? AND thread_id=\? AND archived_at=\?\)/u),
      ]));
      expect(plan.some(row => /^SCAN workpad(?: |$)/u.test(row.detail))).toBe(false);
      expect(sql).not.toContain("document_json");
    }
  });

  it("publishes committed membership changes without publishing counts for content, draft, or rejected writes", async () => {
    const f = fixture();
    const [threadId] = f.ids as [string, string, string];
    await f.boundary.checkpoint(f.scope, f.hub);
    const handoff = vi.spyOn(f.boundary, "handoffThreadChange");
    const membership = f.repository.nonArchivedThreadId.bind(f.repository);
    vi.spyOn(f.repository, "nonArchivedThreadId").mockImplementation((scope, id) => {
      expect(f.database.inTransaction).toBe(true);
      return membership(scope, id);
    });
    let pad = await f.workpads.create(f.scope, { title: "Notes", content: "- [ ] Task", scope: { kind: "thread", threadId } });
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([1, 0, 0]);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(f.scope, threadId);
    handoff.mockClear();
    pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, title: "Renamed" });
    pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, edit: { kind: "replace", content: "- [x] Task" } });
    pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, scope: pad.scope, archived: false });
    const draft = await f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: f.workpads.getDraft(f.scope, pad.id).revision, baseRevision: pad.revision, content: "Draft" });
    pad = await f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: draft.revision, expectedRevision: pad.revision });
    await f.workpads.discardDraft(f.scope, pad.id, f.workpads.getDraft(f.scope, pad.id).revision);
    await expect(f.workpads.update(f.scope, pad.id, { expectedRevision: 0, archived: true })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.workpads.update({ ...f.scope, principalId: "wrong-owner" }, pad.id, { expectedRevision: pad.revision, archived: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(f.workpads.update({ ...f.scope, tenantId: "wrong-tenant" }, pad.id, { expectedRevision: pad.revision, archived: true })).rejects.toMatchObject({ code: "not_found" });
    await f.boundary.flush();
    expect(handoff).not.toHaveBeenCalled();
    expect(f.events.filter(({ event }) => event.type === "thread_upsert")).toHaveLength(1);

    pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, archived: true });
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 0, 0]);
    pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, archived: false });
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([1, 0, 0]);
    expect(handoff.mock.calls).toEqual([[f.scope, threadId], [f.scope, threadId]]);
  });

  it("updates both move endpoints and handles global, project, and combined archive changes", async () => {
    const f = fixture();
    const [first, second] = f.ids as [string, string, string];
    await f.boundary.checkpoint(f.scope, f.hub);
    const handoff = vi.spyOn(f.boundary, "handoffThreadChange");
    let pad = await f.workpads.create(f.scope, { title: "Notes", scope: { kind: "global" } });
    expect(handoff).not.toHaveBeenCalled();
    const move = async (scope: typeof pad.scope, archived?: boolean) => {
      handoff.mockClear();
      pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, scope, ...(archived === undefined ? {} : { archived }) });
      await f.boundary.flush();
      return handoff.mock.calls.map(([, id]) => id);
    };
    expect(await move({ kind: "thread", threadId: first })).toEqual([first]);
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([1, 0, 0]);
    expect(await move({ kind: "thread", threadId: second })).toEqual([first, second]);
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 1, 0]);
    expect(await move({ kind: "project", projectId: f.workspace.projectId })).toEqual([second]);
    expect(await move({ kind: "thread", threadId: first })).toEqual([first]);
    expect(await move({ kind: "thread", threadId: second }, true)).toEqual([first]);
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 0, 0]);
    expect(await move({ kind: "thread", threadId: first })).toEqual([]);
    expect(await move({ kind: "thread", threadId: second }, false)).toEqual([second]);
    expect(await move({ kind: "global" })).toEqual([second]);
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 0, 0]);
  });

  it("retains all move endpoints while a replacement snapshot is awaiting publication", async () => {
    const f = fixture();
    const [first, second, third] = f.ids as [string, string, string];
    let pad = f.repository.create(f.scope, { title: "Moving", scope: { kind: "thread", threadId: first } });
    await f.boundary.checkpoint(f.scope, f.hub);
    const before = await f.application.capture(f.scope);
    let finish!: (snapshot: NormalizedApplicationSnapshot) => void;
    const delayed = new Promise<NormalizedApplicationSnapshot>(resolve => { finish = resolve; });
    const capture = vi.spyOn(f.application, "capture").mockImplementationOnce(() => delayed);
    const targeted = vi.spyOn(f.summaries, "listByIds");
    await f.boundary.publishAuthoritativeReplacement(f.scope);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    try {
      pad = await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, scope: { kind: "thread", threadId: second } });
      await f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, scope: { kind: "thread", threadId: third } });
      expect(targeted).not.toHaveBeenCalled();
    } finally { finish(before); }
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 0, 1]);
    expect(targeted.mock.calls.flatMap(([, ids]) => ids).sort()).toEqual([...f.ids].sort());
  });

  it("recovers count publication failures from durable state without failing the committed write", async () => {
    const f = fixture();
    const [threadId] = f.ids as [string, string, string];
    const pad = f.repository.create(f.scope, { title: "Notes", scope: { kind: "thread", threadId } });
    await f.boundary.checkpoint(f.scope, f.hub);
    vi.spyOn(f.summaries, "listByIds").mockImplementationOnce(() => { throw new Error("summary read interrupted"); });
    await expect(f.workpads.update(f.scope, pad.id, { expectedRevision: 0, archived: true })).resolves.toMatchObject({ revision: 1 });
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([0, 0, 0]);
    expect(f.events.filter(({ event }) => event.type === "snapshot")).toHaveLength(2);
  });

  it("reconciles count changes through replay and a new stream generation", async () => {
    const f = fixture();
    const [threadId] = f.ids as [string, string, string];
    const client = new NormalizedApplicationStore();
    const live = f.hub.subscribe(envelope => { expect(client.apply(envelope)).toEqual({ kind: "applied" }); });
    await f.boundary.checkpoint(f.scope, f.hub);
    const pad = await f.workpads.create(f.scope, { title: "Notes", scope: { kind: "thread", threadId } });
    await f.boundary.flush();
    expect(f.counts(client.state.snapshot!)).toEqual([1, 0, 0]);
    live.close();
    await f.workpads.update(f.scope, pad.id, { expectedRevision: 0, archived: true });
    await f.boundary.flush();
    const resumed = f.hub.subscribe(() => undefined, client.replayCursor);
    expect(resumed.replay.some(({ event }) => event.type === "thread_upsert")).toBe(true);
    for (const envelope of resumed.replay) expect(client.apply(envelope)).toEqual({ kind: "applied" });
    expect(f.counts(client.state.snapshot!)).toEqual([0, 0, 0]);
    resumed.close();
    f.hub.close();
    f.repository.create(f.scope, { title: "Offline notes", scope: { kind: "thread", threadId } });
    const next = f.boundary.hub(f.scope);
    next.subscribe(envelope => { expect(client.apply(envelope)).toEqual({ kind: "applied" }); });
    await f.boundary.checkpoint(f.scope, next);
    expect(f.counts(client.state.snapshot!)).toEqual([1, 0, 0]);
  });

  it("hides a removed location's counts and restores them with the retained thread", async () => {
    const f = fixture();
    const [threadId] = f.ids as [string, string, string];
    f.repository.create(f.scope, { title: "Retained", scope: { kind: "thread", threadId } });
    await f.boundary.checkpoint(f.scope, f.hub);
    f.inventory.removeWorkspace(f.scope, f.workspace.id, {
      expectedRevision: f.workspace.revision,
      expectedThreadIds: f.inventory.listThreadIdsForWorkspace(f.scope, f.workspace.id), now: 500,
    });
    await f.boundary.publishAuthoritativeReplacement(f.scope);
    await f.boundary.flush();
    expect(f.hub.currentCheckpoint()!.event.snapshot.threads).toEqual([]);
    expect(f.summaries.listByIds(f.scope, [threadId])).toEqual([]);
    expect(f.repository.list(f.scope, { scope: { kind: "thread", threadId } }).items).toEqual([]);
    f.inventory.upsertWorkspace(f.scope, {
      ...f.workspace, project: { kind: "new", name: "Workpad count" },
      available: true, restoreRemoved: true, now: 600,
    });
    await f.boundary.publishAuthoritativeReplacement(f.scope);
    await f.boundary.flush();
    expect(f.counts(f.hub.currentCheckpoint()!.event.snapshot)).toEqual([1, 0, 0]);
  });
});
