import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainError } from "../../src/server/domain/errors.js";
import { projectRemovalAdmissionError } from "../../src/server/db/project-removal-errors.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import {
  InventoryRepository,
  ProjectRemovalBlockedError,
  type InventoryProjectAssignment,
  type InventoryWorkspaceRecord,
} from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

function domainError(code: DomainError["code"], message?: string) {
  return expect.objectContaining<Partial<DomainError>>(message === undefined ? { code } : { code, message });
}

function fixture() {
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => database.close());
  const inventory = new InventoryRepository(database);
  const local = inventory.getLocalEnvironment(scope);
  const remote = randomUUID();
  database.prepare(`INSERT INTO execution_environments(
      tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
      configuration_revision, configuration_fingerprint, created_at, updated_at
    )
    SELECT tenant_id, owner_principal_id, ?, 'ssh', 'Remote', availability, NULL, 0,
      configuration_revision, configuration_fingerprint, created_at, updated_at
    FROM execution_environments WHERE tenant_id = ? AND id = ?`)
    .run(remote, scope.tenantId, local.id);
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled = 1 LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const queue = new QueuedInputRepository(database);
  let clock = 1_000;
  const now = () => (clock += 10);
  const open = (canonicalPath: string, input: {
    readonly environmentId?: string;
    readonly project?: InventoryProjectAssignment;
    readonly restoreRemoved?: true;
  } = {}): InventoryWorkspaceRecord => inventory.upsertWorkspace(scope, {
    environmentId: input.environmentId ?? local.id,
    canonicalPath,
    displayName: path.basename(canonicalPath),
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: local.configurationRevision,
    now: now(),
    project: input.project ?? { kind: "new", name: path.basename(canonicalPath) },
    ...(input.restoreRemoved ? { restoreRemoved: true } : {}),
  });
  const revalidate = (workspace: InventoryWorkspaceRecord, available = true) => inventory.upsertWorkspace(scope, {
    id: workspace.id,
    environmentId: workspace.environmentId,
    canonicalPath: workspace.canonicalPath,
    displayName: workspace.displayName,
    available,
    trustState: workspace.trustState,
    environmentConfigurationRevision: workspace.environmentConfigurationRevision,
    now: now(),
  });
  const thread = (workspaceId: string): string => {
    const created = bindings.createUnboundThread(scope, { workspaceId, connectionProfileId: profile.id, title: "Thread", now: now() });
    bindings.bindDiscoveredConversation(scope, created.id, { backendConversationId: randomUUID(), now: now() });
    return created.id;
  };
  const enqueue = (threadId: string) => queue.enqueue(scope, threadId, {
    mutationId: randomUUID(), text: "Queued", contextExcerpts: [], attachmentIds: [], taskReferences: [],
    source: {
      kind: "agent_control", initiatingAgentThreadId: threadId,
      expectedThreadRevision: inventory.getThread(scope, threadId).thread.revision,
    },
    now: now(),
  });
  const schedule = (threadId: string) => new AutomationRepository(database).createDefinition(scope, {
    anchorThreadId: threadId, name: "Periodic", prompt: "Check", precheck: null, runMode: "same_thread", enabled: true,
    schedule: { kind: "date_time", runAt: 100_000 }, misfirePolicy: "coalesce", nextRunAt: 100_000, now: now(),
  });
  const terminal = (workspace: InventoryWorkspaceRecord, threadId: string) => database.prepare(`INSERT INTO terminals(
      tenant_id, owner_principal_id, terminal_id, thread_id, workspace_id, environment_id, environment_label,
      display_name, initial_cwd, lifecycle, lifecycle_revision, rows, columns, initial_rows, initial_columns,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Local', 'Shell', ?, 'running', 1, 24, 80, 24, 80, 1, 1)`)
    .run(scope.tenantId, scope.principalId, randomUUID(), threadId, workspace.id, workspace.environmentId, workspace.canonicalPath);
  const project = (projectId: string) => inventory.getProject(scope, projectId);
  const removeLocation = (workspaceId: string) => inventory.removeWorkspace(scope, workspaceId, {
    expectedRevision: inventory.getWorkspace(scope, workspaceId).revision,
    expectedThreadIds: inventory.listThreadIdsForWorkspace(scope, workspaceId),
    now: now(),
  });
  const removeProject = (projectId: string) => {
    const current = project(projectId);
    const inspection = inventory.inspectProjectRemoval(scope, projectId, {
      expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision,
    });
    return inventory.removeProject(scope, projectId, {
      expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision,
      expectedLocations: inspection.locations, now: now(),
    });
  };
  const projectCount = () => (database.prepare("SELECT count(*) AS count FROM projects").get() as { count: number }).count;
  return {
    database, scope, inventory, local, remote, open, revalidate, thread, enqueue, schedule, terminal,
    project, removeLocation, removeProject, projectCount, now,
  };
}

describe("project and location repository", () => {
  it("admits locations into new or existing projects and bumps membership on every add", () => {
    const f = fixture();
    const first = f.open("/srv/sedes");
    expect(first.projectId).not.toBe(first.id);
    expect(f.project(first.projectId)).toEqual({
      tenantId: f.scope.tenantId, ownerPrincipalId: f.scope.principalId, id: first.projectId, name: "sedes",
      revision: 1, membershipRevision: 1, removedAt: null, createdAt: first.createdAt, updatedAt: first.createdAt,
      locations: [{
        id: first.id, environmentId: f.local.id, environmentLabel: "Local", displayName: "sedes",
        canonicalPath: "/srv/sedes", available: true, removedAt: null, removedWithProject: false,
        revision: 0, threadCount: 0,
      }],
    });
    const remote = f.open("/home/me/sedes", { environmentId: f.remote, project: { kind: "existing", projectId: first.projectId } });
    expect(remote.projectId).toBe(first.projectId);
    expect(f.project(first.projectId)).toMatchObject({ revision: 2, membershipRevision: 2 });
    expect(f.project(first.projectId).locations.map(({ id }) => id)).toEqual([first.id, remote.id]);

    // An existing location keeps its project; a new-project request only applies to new rows.
    const projects = f.projectCount();
    expect(f.open("/srv/sedes", { project: { kind: "new", name: "Elsewhere" } }).projectId).toBe(first.projectId);
    expect(f.open("/srv/sedes", { project: { kind: "existing", projectId: first.projectId } }).projectId).toBe(first.projectId);
    expect(f.projectCount()).toBe(projects);
    expect(f.project(first.projectId).membershipRevision).toBe(2);

    // Revalidation needs no assignment for a known location.
    expect(f.revalidate(first, false)).toMatchObject({ id: first.id, projectId: first.projectId, availability: "unavailable" });
    expect(f.inventory.listWorkspaces(f.scope).map(({ projectId }) => projectId)).toEqual([first.projectId, first.projectId]);
  });

  it("rejects implicit moves, unknown or removed projects, invalid names, and revalidation inserts", () => {
    const f = fixture();
    const a = f.open("/srv/a");
    const b = f.open("/srv/b");
    expect(() => f.open("/srv/a", { project: { kind: "existing", projectId: b.projectId } })).toThrow(domainError("conflict"));
    expect(f.inventory.getWorkspace(f.scope, a.id).projectId).toBe(a.projectId);
    expect(() => f.open("/srv/c", { project: { kind: "existing", projectId: randomUUID() } })).toThrow(domainError("not_found"));
    expect(() => f.open("/srv/c", { project: { kind: "new", name: " \t" } })).toThrow(domainError("bad_request"));
    expect(() => f.open("/srv/c", { project: { kind: "new", name: "x".repeat(241) } })).toThrow(domainError("bad_request"));
    const astral = "\u{1F600}".repeat(240);
    expect(f.project(f.open("/srv/c", { project: { kind: "new", name: astral } }).projectId).name).toBe(astral);

    f.removeLocation(b.id);
    f.removeProject(b.projectId);
    const projects = f.projectCount();
    expect(() => f.open("/srv/d", { project: { kind: "existing", projectId: b.projectId } }))
      .toThrow(domainError("invalid_transition", "The project was removed. Restore it before adding locations to it."));
    expect(f.inventory.listWorkspaces(f.scope).map(({ canonicalPath }) => canonicalPath).sort()).toEqual(["/srv/a", "/srv/c"]);
    expect(f.projectCount()).toBe(projects);

    // Revalidation never inserts a location or a project.
    expect(() => f.revalidate({ ...a, id: randomUUID(), canonicalPath: "/srv/missing" })).toThrow(domainError("not_found"));
    expect(() => f.revalidate({ ...a, id: randomUUID() })).toThrow(domainError("conflict"));
    expect(f.projectCount()).toBe(projects);
  });

  it("removes one location while its project stays active and restores it only into an active project", () => {
    const f = fixture();
    const a = f.open("/srv/a");
    const threadId = f.thread(a.id);
    f.removeLocation(a.id);
    expect(f.project(a.projectId)).toMatchObject({
      removedAt: null, revision: 2, membershipRevision: 2,
      locations: [{ id: a.id, removedAt: expect.any(Number), removedWithProject: false, threadCount: 1 }],
    });
    expect(f.inventory.listWorkspaces(f.scope)).toEqual([]);
    expect(() => f.revalidate(a)).toThrow(/removed/);

    const restored = f.open("/srv/a", { restoreRemoved: true });
    expect(restored).toMatchObject({ id: a.id, projectId: a.projectId });
    expect(f.project(a.projectId)).toMatchObject({ membershipRevision: 3, locations: [{ removedAt: null, removedWithProject: false }] });
    expect(f.inventory.listThreadIdsForWorkspace(f.scope, a.id)).toEqual([threadId]);

    f.removeProject(a.projectId);
    expect(() => f.open("/srv/a", { restoreRemoved: true }))
      .toThrow(domainError("invalid_transition", "The project was removed. Restore it before restoring its locations."));
    // The commit-time trigger is the backstop for writes that skip the repository check.
    let rejected: unknown;
    try {
      f.database.prepare("UPDATE workspaces SET removed_at = NULL, removed_with_project = 0 WHERE tenant_id = ? AND id = ?")
        .run(f.scope.tenantId, a.id);
    } catch (error) { rejected = error; }
    expect(projectRemovalAdmissionError(rejected)).toMatchObject({
      code: "invalid_transition", message: "The project was removed. Restore it before adding or restoring its locations.",
    });
    expect(f.inventory.isWorkspaceRemoved(f.scope, a.id)).toBe(true);
  });

  it("lists every project with its locations and thread counts within the principal", () => {
    const f = fixture();
    const beta = f.open("/srv/beta");
    const alphaLocal = f.open("/srv/Alpha");
    const alphaRemote = f.open("/home/me/alpha", { environmentId: f.remote, project: { kind: "existing", projectId: alphaLocal.projectId } });
    f.thread(alphaLocal.id);
    f.thread(alphaLocal.id);
    f.removeLocation(alphaRemote.id);
    const projects = f.inventory.listProjects(f.scope);
    expect(projects.map(({ name }) => name)).toEqual(["Alpha", "beta"]);
    expect(projects[0]!.locations).toEqual([
      expect.objectContaining({ id: alphaLocal.id, environmentLabel: "Local", threadCount: 2, removedAt: null }),
      expect.objectContaining({ id: alphaRemote.id, environmentLabel: "Remote", threadCount: 0, removedAt: expect.any(Number) }),
    ]);
    expect(projects[1]!.locations.map(({ id }) => id)).toEqual([beta.id]);
    expect(f.inventory.getProject(f.scope, beta.projectId)).toEqual(projects[1]);

    const stranger: RequestScope = { ...f.scope, principalId: randomUUID() };
    expect(f.inventory.listProjects(stranger)).toEqual([]);
    expect(() => f.inventory.getProject(stranger, beta.projectId)).toThrow(domainError("not_found"));
    expect(() => f.inventory.renameProject(stranger, beta.projectId, { name: "Taken", expectedRevision: 1, now: f.now() }))
      .toThrow(domainError("not_found"));
    expect(() => f.inventory.moveWorkspaceToProject(stranger, beta.id, {
      target: { kind: "new", name: "Taken" }, expectedRevision: 0, expectedThreadIds: [], now: f.now(),
    })).toThrow(domainError("not_found"));
    expect(() => f.inventory.mergeProject(stranger, beta.projectId, {
      targetProjectId: alphaLocal.projectId, expectedSourceMembershipRevision: 1,
      expectedTargetMembershipRevision: 3, expectedThreadIds: [], now: f.now(),
    })).toThrow(domainError("not_found"));
    expect(() => f.inventory.inspectProjectRemoval(stranger, beta.projectId, { expectedRevision: 1, expectedMembershipRevision: 1 }))
      .toThrow(domainError("not_found"));
    expect(() => f.inventory.restoreProject(stranger, beta.projectId, { expectedRevision: 1, now: f.now() }))
      .toThrow(domainError("not_found"));
    expect(f.inventory.listProjects(f.scope)).toEqual(projects);
  });

  it("renames an active project with a revision check", () => {
    const f = fixture();
    const a = f.open("/srv/a");
    const before = f.project(a.projectId);
    expect(() => f.inventory.renameProject(f.scope, a.projectId, { name: "Renamed", expectedRevision: 0, now: f.now() }))
      .toThrow(domainError("conflict"));
    expect(() => f.inventory.renameProject(f.scope, a.projectId, { name: "", expectedRevision: before.revision, now: f.now() }))
      .toThrow(domainError("bad_request"));
    const renamed = f.inventory.renameProject(f.scope, a.projectId, { name: "Renamed", expectedRevision: before.revision, now: f.now() });
    expect(renamed).toMatchObject({ name: "Renamed", revision: before.revision + 1, membershipRevision: before.membershipRevision });
    expect(f.inventory.getWorkspace(f.scope, a.id).displayName).toBe("a");
    expect(f.inventory.renameProject(f.scope, a.projectId, { name: "Renamed", expectedRevision: renamed.revision, now: f.now() }))
      .toEqual(renamed);
    f.removeLocation(a.id);
    const removed = f.removeProject(a.projectId);
    expect(() => f.inventory.renameProject(f.scope, a.projectId, { name: "Again", expectedRevision: removed.revision, now: f.now() }))
      .toThrow(domainError("invalid_transition"));
  });

  it("moves a location into another project after checking revision, threads, destination, and durable work", () => {
    const f = fixture();
    const busy = f.open("/srv/busy");
    const busyThread = f.thread(busy.id);
    const quiet = f.open("/srv/quiet", { project: { kind: "existing", projectId: busy.projectId } });
    const quietThread = f.thread(quiet.id);
    const destination = f.open("/srv/destination");
    const move = (workspace: InventoryWorkspaceRecord, target: InventoryProjectAssignment, overrides: {
      readonly expectedRevision?: number; readonly expectedThreadIds?: readonly string[];
    } = {}) => f.inventory.moveWorkspaceToProject(f.scope, workspace.id, {
      target,
      expectedRevision: overrides.expectedRevision ?? f.inventory.getWorkspace(f.scope, workspace.id).revision,
      expectedThreadIds: overrides.expectedThreadIds ?? f.inventory.listThreadIdsForWorkspace(f.scope, workspace.id),
      now: f.now(),
    });
    const into = { kind: "existing", projectId: destination.projectId } as const;
    expect(() => move(quiet, into, { expectedRevision: 7 })).toThrow(domainError("conflict"));
    expect(() => move(quiet, into, { expectedThreadIds: [] })).toThrow(domainError("conflict"));
    expect(() => move(quiet, { kind: "existing", projectId: busy.projectId })).toThrow(domainError("bad_request"));
    expect(() => move(quiet, { kind: "new", name: "" })).toThrow(domainError("bad_request"));
    f.enqueue(busyThread);
    expect(() => move(busy, into)).toThrow(domainError("invalid_transition"));

    const source = f.project(busy.projectId);
    const target = f.project(destination.projectId);
    const moved = move(quiet, into);
    expect(moved).toMatchObject({ id: quiet.id, projectId: destination.projectId, revision: quiet.revision + 1 });
    expect(f.project(busy.projectId)).toMatchObject({ membershipRevision: source.membershipRevision + 1, removedAt: null });
    expect(f.project(destination.projectId)).toMatchObject({ membershipRevision: target.membershipRevision + 1 });
    expect(f.inventory.listThreadIdsForWorkspace(f.scope, quiet.id)).toEqual([quietThread]);

    // A split creates a project; the emptied source stays active.
    const split = move(quiet, { kind: "new", name: "Split" });
    expect(f.project(split.projectId)).toMatchObject({ name: "Split", membershipRevision: 1, locations: [{ id: quiet.id }] });
    expect(f.project(destination.projectId).locations.map(({ id }) => id)).toEqual([destination.id]);

    // A removed location may move into an active project; it stays removed.
    f.removeLocation(destination.id);
    f.removeProject(destination.projectId);
    expect(() => move(quiet, into)).toThrow(domainError("invalid_transition"));
    const removedLocation = move(destination, { kind: "existing", projectId: split.projectId });
    expect(f.inventory.isWorkspaceRemoved(f.scope, removedLocation.id)).toBe(true);
    expect(f.project(split.projectId).locations).toContainEqual(expect.objectContaining({
      id: destination.id, removedAt: expect.any(Number), removedWithProject: false,
    }));
  });

  it("merges every location into the target and deletes the source", () => {
    const f = fixture();
    const target = f.open("/srv/target");
    const active = f.open("/srv/active");
    const activeThread = f.thread(active.id);
    const removed = f.open("/home/me/removed", { environmentId: f.remote, project: { kind: "existing", projectId: active.projectId } });
    f.removeLocation(removed.id);
    const merge = (sourceProjectId: string, targetProjectId: string, overrides: {
      readonly source?: number; readonly target?: number; readonly threadIds?: readonly string[];
    } = {}) => f.inventory.mergeProject(f.scope, sourceProjectId, {
      targetProjectId,
      expectedSourceMembershipRevision: overrides.source ?? f.project(sourceProjectId).membershipRevision,
      expectedTargetMembershipRevision: overrides.target ?? f.project(targetProjectId).membershipRevision,
      expectedThreadIds: overrides.threadIds ?? f.inventory.listActiveThreadIdsForProject(f.scope, sourceProjectId),
      now: f.now(),
    });
    expect(f.inventory.listActiveThreadIdsForProject(f.scope, active.projectId)).toEqual([activeThread]);
    expect(() => merge(active.projectId, active.projectId)).toThrow(domainError("bad_request"));
    expect(() => merge(active.projectId, target.projectId, { source: 0 })).toThrow(domainError("conflict"));
    expect(() => merge(active.projectId, target.projectId, { target: 0 })).toThrow(domainError("conflict"));
    expect(() => merge(active.projectId, target.projectId, { threadIds: [] })).toThrow(domainError("conflict"));

    const before = f.project(target.projectId);
    const merged = merge(active.projectId, target.projectId);
    expect(merged).toMatchObject({ id: target.projectId, membershipRevision: before.membershipRevision + 1, removedAt: null });
    expect(merged.locations.map(({ id }) => id).sort()).toEqual([active.id, removed.id, target.id].sort());
    expect(merged.locations.find(({ id }) => id === removed.id)).toMatchObject({ removedAt: expect.any(Number) });
    expect(f.inventory.getWorkspace(f.scope, active.id)).toMatchObject({ projectId: target.projectId, revision: active.revision + 1 });
    expect(() => f.inventory.getProject(f.scope, active.projectId)).toThrow(domainError("not_found"));
    expect(f.database.prepare("SELECT count(*) AS count FROM projects WHERE id = ?").get(active.projectId)).toEqual({ count: 0 });

    // A removed source merges its removed locations; a removed target is rejected.
    const retired = f.open("/srv/retired");
    f.removeLocation(retired.id);
    f.removeProject(retired.projectId);
    expect(() => merge(target.projectId, retired.projectId)).toThrow(domainError("invalid_transition"));
    expect(merge(retired.projectId, target.projectId).locations).toContainEqual(expect.objectContaining({
      id: retired.id, removedAt: expect.any(Number), removedWithProject: false,
    }));

    // Durable work in an active source location blocks the merge.
    const busy = f.open("/srv/busy");
    f.enqueue(f.thread(busy.id));
    expect(() => merge(busy.projectId, target.projectId)).toThrow(domainError("invalid_transition"));
    expect(f.inventory.getWorkspace(f.scope, busy.id).projectId).toBe(busy.projectId);
  });

  it("collects every removal blocker across active locations and refuses to commit while any remain", () => {
    const f = fixture();
    const queued = f.open("/srv/queued");
    const queuedThread = f.thread(queued.id);
    f.enqueue(queuedThread);
    f.schedule(queuedThread);
    const terminalLocation = f.open("/srv/terminal", { project: { kind: "existing", projectId: queued.projectId } });
    const terminalThread = f.thread(terminalLocation.id);
    f.terminal(terminalLocation, terminalThread);
    const remote = f.open("/home/me/remote", { environmentId: f.remote, project: { kind: "existing", projectId: queued.projectId } });
    const retired = f.open("/srv/retired", { project: { kind: "existing", projectId: queued.projectId } });
    f.removeLocation(retired.id);
    const current = f.project(queued.projectId);
    const expected = { expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision };
    expect(() => f.inventory.inspectProjectRemoval(f.scope, queued.projectId, { ...expected, expectedRevision: 0 }))
      .toThrow(domainError("conflict"));
    expect(() => f.inventory.inspectProjectRemoval(f.scope, queued.projectId, { ...expected, expectedMembershipRevision: 0 }))
      .toThrow(domainError("conflict"));

    const inspection = f.inventory.inspectProjectRemoval(f.scope, queued.projectId, expected);
    const byId = <T extends { readonly workspaceId: string }>(values: readonly T[]) =>
      [...values].sort((left, right) => left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0);
    expect(inspection.locations).toEqual(byId([
      { workspaceId: queued.id, environmentId: f.local.id, threadIds: [queuedThread] },
      { workspaceId: terminalLocation.id, environmentId: f.local.id, threadIds: [terminalThread] },
      { workspaceId: remote.id, environmentId: f.remote, threadIds: [] },
    ]));
    const blockers = [
      { workspaceId: queued.id, environmentId: f.local.id, kind: "durable_work", threadIds: [queuedThread] },
      { workspaceId: queued.id, environmentId: f.local.id, kind: "enabled_schedule", threadIds: [queuedThread] },
      { workspaceId: terminalLocation.id, environmentId: f.local.id, kind: "live_terminal", threadIds: [terminalThread] },
    ];
    expect(inspection.blockers).toHaveLength(3);
    expect(inspection.blockers).toEqual(expect.arrayContaining(blockers));

    let rejected: unknown;
    try {
      f.inventory.removeProject(f.scope, queued.projectId, { ...expected, expectedLocations: inspection.locations, now: f.now() });
    } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(ProjectRemovalBlockedError);
    expect(rejected).toMatchObject({ code: "invalid_transition", blockers: inspection.blockers });
    expect(f.project(queued.projectId)).toEqual(current);

    // Single-location removal still reports only its first blocker.
    expect(() => f.removeLocation(queued.id)).toThrow(domainError("invalid_transition", "Resolve running, queued, or uncertain work before removing this project."));
    expect(() => f.removeLocation(terminalLocation.id)).toThrow(domainError("invalid_transition", "End live or interrupted terminals before removing this project."));
  });

  it("removes a project with its active locations and restores only the project", () => {
    const f = fixture();
    const a = f.open("/srv/a");
    f.thread(a.id);
    const b = f.open("/home/me/a", { environmentId: f.remote, project: { kind: "existing", projectId: a.projectId } });
    const earlier = f.open("/srv/earlier", { project: { kind: "existing", projectId: a.projectId } });
    f.removeLocation(earlier.id);
    const current = f.project(a.projectId);
    const expected = { expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision };
    const inspection = f.inventory.inspectProjectRemoval(f.scope, a.projectId, expected);
    expect(inspection.blockers).toEqual([]);
    expect(inspection.locations.map(({ workspaceId }) => workspaceId).sort()).toEqual([a.id, b.id].sort());

    // A thread created after the precheck changes the location set.
    f.thread(a.id);
    expect(() => f.inventory.removeProject(f.scope, a.projectId, { ...expected, expectedLocations: inspection.locations, now: f.now() }))
      .toThrow(domainError("conflict"));
    const fresh = f.inventory.inspectProjectRemoval(f.scope, a.projectId, expected);
    const removed = f.inventory.removeProject(f.scope, a.projectId, { ...expected, expectedLocations: fresh.locations, now: f.now() });
    expect(removed).toMatchObject({
      removedAt: expect.any(Number), revision: current.revision + 1, membershipRevision: current.membershipRevision + 1,
    });
    const location = (id: string) => removed.locations.find((candidate) => candidate.id === id)!;
    expect(location(a.id)).toMatchObject({ removedAt: removed.removedAt, removedWithProject: true });
    expect(location(b.id)).toMatchObject({ removedAt: removed.removedAt, removedWithProject: true });
    expect(location(earlier.id)).toMatchObject({ removedWithProject: false });
    expect(f.inventory.listWorkspaces(f.scope)).toEqual([]);
    expect(f.inventory.removeProject(f.scope, a.projectId, {
      expectedRevision: removed.revision, expectedMembershipRevision: removed.membershipRevision, expectedLocations: [], now: f.now(),
    })).toEqual(removed);

    expect(() => f.inventory.restoreProject(f.scope, a.projectId, { expectedRevision: current.revision, now: f.now() }))
      .toThrow(domainError("conflict"));
    const restored = f.inventory.restoreProject(f.scope, a.projectId, { expectedRevision: removed.revision, now: f.now() });
    expect(restored).toMatchObject({ removedAt: null, revision: removed.revision + 1, membershipRevision: removed.membershipRevision });
    expect(restored.locations.filter(({ removedWithProject }) => removedWithProject).map(({ id }) => id).sort())
      .toEqual([a.id, b.id].sort());
    expect(f.inventory.restoreProject(f.scope, a.projectId, { expectedRevision: restored.revision, now: f.now() })).toEqual(restored);

    f.open("/srv/a", { restoreRemoved: true });
    expect(f.project(a.projectId)).toMatchObject({ membershipRevision: restored.membershipRevision + 1 });
    expect(f.project(a.projectId).locations.find(({ id }) => id === a.id)).toMatchObject({ removedAt: null, removedWithProject: false });
    expect(f.inventory.listThreadIdsForWorkspace(f.scope, a.id)).toHaveLength(2);
  });

  it("marks only the latest removal's locations after a partial restore", () => {
    const f = fixture();
    const a = f.open("/srv/a");
    const b = f.open("/home/me/a", { environmentId: f.remote, project: { kind: "existing", projectId: a.projectId } });
    const marked = () => f.project(a.projectId).locations
      .filter(({ removedWithProject }) => removedWithProject).map(({ id }) => id).sort();
    f.removeProject(a.projectId);
    expect(marked()).toEqual([a.id, b.id].sort());
    const removedB = f.project(a.projectId).locations.find(({ id }) => id === b.id)!;

    // Restore the project and only A; B stays removed with its old mark.
    f.inventory.restoreProject(f.scope, a.projectId, { expectedRevision: f.project(a.projectId).revision, now: f.now() });
    f.open("/srv/a", { restoreRemoved: true });
    expect(marked()).toEqual([b.id]);

    const removed = f.removeProject(a.projectId);
    expect(marked()).toEqual([a.id]);
    // B keeps its original removal time; only its mark changed.
    expect(removed.locations.find(({ id }) => id === b.id)).toMatchObject({
      removedAt: removedB.removedAt, removedWithProject: false, revision: removedB.revision + 1,
    });
    const restored = f.inventory.restoreProject(f.scope, a.projectId, { expectedRevision: removed.revision, now: f.now() });
    expect(restored.locations.filter(({ removedWithProject }) => removedWithProject).map(({ id }) => id)).toEqual([a.id]);
  });
});
