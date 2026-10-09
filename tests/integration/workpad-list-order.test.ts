import { afterEach, describe, expect, it } from "vitest";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { WorkpadRepository, type WorkpadListAuthority } from "../../src/server/db/repositories/workpad-repository.js";
import type { ListWorkpadsRequest, Workpad, WorkpadListPage, WorkpadScope } from "../../src/shared/protocol/workpads.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const errorCode = (code: string) => expect.objectContaining({ code });

function fixture() {
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => database.close());
  const inventory = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  const workpads = new WorkpadRepository(database);
  const environmentId = (database.prepare("SELECT id FROM execution_environments WHERE tenant_id=? AND owner_principal_id=? LIMIT 1")
    .get(scope.tenantId, scope.principalId) as { id: string }).id;
  const profileId = (database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string }).id;
  let paths = 0;
  /** A new location, in a new project with this name or in an existing project. */
  const location = (project: { name: string } | { projectId: string }) => inventory.upsertWorkspace(scope, {
    environmentId, canonicalPath: `/tmp/workpad-order-${paths += 1}`, displayName: `Location ${paths}`,
    project: "name" in project ? { kind: "new", name: project.name } : { kind: "existing", projectId: project.projectId },
    available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 100,
  });
  const thread = (workspaceId: string, title: string) =>
    bindings.createUnboundThread(scope, { workspaceId, connectionProfileId: profileId, title, now: 100 }).id;
  const create = (title: string, target: WorkpadScope, now: number) => workpads.create(scope, { title, scope: target }, undefined, now);
  const removeLocation = (workspaceId: string) => inventory.removeWorkspace(scope, workspaceId, {
    expectedRevision: inventory.getWorkspace(scope, workspaceId).revision,
    expectedThreadIds: inventory.listThreadIdsForWorkspace(scope, workspaceId), now: 50_000,
  });
  const removeProject = (projectId: string) => {
    const project = inventory.getProject(scope, projectId);
    const expected = { expectedRevision: project.revision, expectedMembershipRevision: project.membershipRevision };
    const inspection = inventory.inspectProjectRemoval(scope, projectId, expected);
    inventory.removeProject(scope, projectId, { ...expected, expectedLocations: inspection.locations, now: 60_000 });
  };
  return { database, scope, inventory, workpads, environmentId, location, thread, create, removeLocation, removeProject };
}

/** Pages a list to its end, checking every cursor's bound. */
function readAll(list: (cursor?: string) => WorkpadListPage) {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = list(cursor);
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      expect(cursor.length).toBeLessThanOrEqual(1024);
      cursors.push(cursor);
    }
    pages += 1;
  } while (cursor !== undefined && pages < 100);
  expect(new Set(ids).size).toBe(ids.length);
  return { ids, pages, cursors };
}
/** SQLite's lower() folds ASCII letters only; text then compares by code point. */
const titleKey = (value: string) => value.replace(/[A-Z]/gu, letter => letter.toLowerCase());
const byCodePoint = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

/** Global; Beta (two locations) and alpha with threads; Gamma without. */
function groupedFixture() {
  const f = fixture();
  const beta = f.location({ name: "Beta" });
  const betaSecond = f.location({ projectId: beta.projectId });
  const alpha = f.location({ name: "alpha" });
  const gamma = f.location({ name: "Gamma" });
  const zeta = f.thread(beta.id, "zeta");
  const alphaThread = f.thread(betaSecond.id, "Alpha thread");
  const only = f.thread(alpha.id, "only");
  const ids = {
    betaId: beta.projectId, betaSecondLocationId: betaSecond.id, alphaId: alpha.projectId, gammaId: gamma.projectId,
    alphaLocationId: alpha.id, zeta, alphaThread, only,
  };
  // Titles ascend in creation order, which is the reverse of recently updated.
  const pads = {
    g1: f.create("01 global", { kind: "global" }, 1_000),
    g2: f.create("02 global", { kind: "global" }, 2_000),
    b1: f.create("03 beta keep", { kind: "project", projectId: ids.betaId }, 3_000),
    b2: f.create("04 beta", { kind: "project", projectId: ids.betaId }, 4_000),
    z1: f.create("05 zeta keep", { kind: "thread", threadId: zeta }, 5_000),
    z2: f.create("06 zeta", { kind: "thread", threadId: zeta }, 6_000),
    a1: f.create("07 alpha thread", { kind: "thread", threadId: alphaThread }, 7_000),
    p1: f.create("08 alpha project keep", { kind: "project", projectId: ids.alphaId }, 8_000),
    o1: f.create("09 only", { kind: "thread", threadId: only }, 9_000),
    o2: f.create("10 only keep", { kind: "thread", threadId: only }, 10_000),
    c1: f.create("11 gamma", { kind: "project", projectId: ids.gammaId }, 11_000),
  };
  const groupOf = new Map<string, string>([
    ...[pads.g1, pads.g2].map(pad => [pad.id, "global"] as const),
    ...[pads.b1, pads.b2].map(pad => [pad.id, "beta"] as const),
    ...[pads.z1, pads.z2].map(pad => [pad.id, "beta/zeta"] as const),
    [pads.a1.id, "beta/alpha-thread"],
    [pads.p1.id, "alpha"],
    ...[pads.o1, pads.o2].map(pad => [pad.id, "alpha/only"] as const),
    [pads.c1.id, "gamma"],
  ]);
  return { ...f, ...ids, pads, groupOf };
}
const all = { scope: { kind: "global" as const }, scopeMode: "subtree" as const };
/** Group keys must never return once the list has left them. */
function expectContiguous(ids: readonly string[], groupOf: ReadonlyMap<string, string>) {
  const runs = ids.map(id => groupOf.get(id)!).filter((group, index, groups) => index === 0 || groups[index - 1] !== group);
  expect(new Set(runs).size).toBe(runs.length);
}

describe("Workpad list order", () => {
  it("sorts by recently updated, newest and title, paging each sort through ties", () => {
    const f = fixture();
    const titles = ["beta", "Alpha", "alpha", "ALPHA", "gamma", "Beta", "delta"];
    const created = [1_000, 2_000, 2_000, 3_000, 3_000, 4_000, 5_000];
    let pads: Workpad[] = titles.map((title, index) => f.create(title, { kind: "global" }, created[index]!));
    // Equal update times tie three documents; the others keep their creation time.
    for (const index of [0, 2, 4]) pads[index] = f.workpads.update(f.scope, pads[index]!.id, { expectedRevision: 0, edit: { kind: "replace", content: "changed" } }, undefined, 9_000);
    pads = pads.map(pad => f.workpads.get(f.scope, pad.id));
    const byId = (left: Workpad, right: Workpad) => byCodePoint(left.id, right.id);
    const expected = {
      updated: [...pads].sort((left, right) => byCodePoint(right.updatedAt, left.updatedAt) || byId(left, right)).map(pad => pad.id),
      newest: [...pads].sort((left, right) => byCodePoint(right.createdAt, left.createdAt) || byId(left, right)).map(pad => pad.id),
      title: [...pads].sort((left, right) => byCodePoint(titleKey(left.title), titleKey(right.title)) || byId(left, right)).map(pad => pad.id),
    };
    expect(expected.updated).not.toEqual(expected.newest);
    for (const sort of ["updated", "newest", "title"] as const) {
      const read = readAll(cursor => f.workpads.list(f.scope, { ...all, sort, limit: 2, ...(cursor ? { cursor } : {}) }));
      expect(read.ids).toEqual(expected[sort]);
      expect(read.pages).toBe(4);
    }
    // Callers that name no sort, including agent tools, keep recently updated.
    expect(readAll(cursor => f.workpads.list(f.scope, { ...all, limit: 3, ...(cursor ? { cursor } : {}) })).ids).toEqual(expected.updated);
    const agent: WorkpadListAuthority = { environmentIds: [f.environmentId], continuationKey: "agent" };
    expect(readAll(cursor => f.workpads.list(f.scope, { ...all, limit: 3, ...(cursor ? { cursor } : {}) }, agent)).ids).toEqual(expected.updated);
  });

  it("groups by project: Global, the lead project, other projects by name, own workpads before each thread's", () => {
    const f = groupedFixture();
    const { pads } = f;
    const grouped = (request: Partial<ListWorkpadsRequest>, authority?: WorkpadListAuthority) => readAll(cursor =>
      f.workpads.list(f.scope, { ...all, group: "project", limit: 3, ...request, ...(cursor ? { cursor } : {}) } as ListWorkpadsRequest, authority));
    const withLead = grouped({ leadProjectId: f.betaId });
    expect(withLead.ids).toEqual([pads.g2, pads.g1, pads.b2, pads.b1, pads.a1, pads.z2, pads.z1, pads.p1, pads.o2, pads.o1, pads.c1].map(pad => pad.id));
    expect(withLead.pages).toBe(4);
    expectContiguous(withLead.ids, f.groupOf);
    // Without a lead, projects order by name, case-insensitively.
    expect(grouped({}).ids).toEqual([pads.g2, pads.g1, pads.p1, pads.o2, pads.o1, pads.b2, pads.b1, pads.a1, pads.z2, pads.z1, pads.c1].map(pad => pad.id));
    // An unknown lead only orders; it matches nothing.
    expect(grouped({ leadProjectId: "unknown-project" }).ids).toEqual(grouped({}).ids);
    // The sort applies within each group and subgroup.
    for (const limit of [1, 2, 4]) {
      const titled = grouped({ leadProjectId: f.betaId, sort: "title", limit });
      expect(titled.ids).toEqual([pads.g1, pads.g2, pads.b1, pads.b2, pads.a1, pads.z1, pads.z2, pads.p1, pads.o1, pads.o2, pads.c1].map(pad => pad.id));
      expectContiguous(titled.ids, f.groupOf);
    }
    expect(grouped({ leadProjectId: f.betaId, sort: "newest", limit: 2 }).ids).toEqual(withLead.ids);
    // Other scopes group the same way.
    expect(grouped({ scope: { kind: "project", projectId: f.betaId }, scopeMode: "subtree", limit: 2 }).ids)
      .toEqual([pads.b2, pads.b1, pads.a1, pads.z2, pads.z1].map(pad => pad.id));
    expect(grouped({ scope: { kind: "thread", threadId: f.zeta }, scopeMode: "exact" }).ids).toEqual([pads.z2.id, pads.z1.id]);
    // Search narrows the groups without reordering them.
    expect(grouped({ leadProjectId: f.betaId, query: "keep", limit: 1 }).ids).toEqual([pads.b1, pads.z1, pads.p1, pads.o2].map(pad => pad.id));
    // A thread's current title places its group.
    f.database.prepare("UPDATE application_threads SET title='Aardvark' WHERE id=?").run(f.zeta);
    expect(grouped({ scope: { kind: "project", projectId: f.betaId }, scopeMode: "subtree" }).ids)
      .toEqual([pads.b2, pads.b1, pads.z2, pads.z1, pads.a1].map(pad => pad.id));
    f.database.prepare("UPDATE application_threads SET title='zeta' WHERE id=?").run(f.zeta);

    // Archived workpads list on their own, in the same grouped order.
    for (const pad of [pads.o1, pads.b1, pads.g1]) f.workpads.update(f.scope, pad.id, { expectedRevision: 0, archived: true }, undefined, pad.id === pads.g1.id ? 20_000 : 21_000);
    expect(grouped({ leadProjectId: f.betaId, archived: true, limit: 1 }).ids).toEqual([pads.g1, pads.b1, pads.o1].map(pad => pad.id));
    expect(grouped({ leadProjectId: f.betaId }).ids).toEqual([pads.g2, pads.b2, pads.a1, pads.z2, pads.z1, pads.p1, pads.o2, pads.c1].map(pad => pad.id));

    // A removed location hides its threads' workpads; the project's own stay.
    f.removeLocation(f.betaSecondLocationId);
    expect(grouped({ leadProjectId: f.betaId }).ids).toEqual([pads.g2, pads.b2, pads.z2, pads.z1, pads.p1, pads.o2, pads.c1].map(pad => pad.id));
    // A removed project hides its own workpads and those of its threads.
    f.removeProject(f.alphaId);
    expect(grouped({ leadProjectId: f.betaId, limit: 2 }).ids).toEqual([pads.g2, pads.b2, pads.z2, pads.z1, pads.c1].map(pad => pad.id));

    // The agent authority filter still applies to a grouped list.
    expect(grouped({ leadProjectId: f.betaId }, { environmentIds: [], continuationKey: "none" }).ids).toEqual([pads.g2.id]);
    expect(grouped({ leadProjectId: f.betaId }, { environmentIds: [f.environmentId], continuationKey: "local" }).ids)
      .toEqual([pads.g2, pads.b2, pads.z2, pads.z1, pads.c1].map(pad => pad.id));
  });

  it("binds a cursor to its sort, grouping, lead project, query and owner", () => {
    const f = groupedFixture();
    const first = f.workpads.list(f.scope, { ...all, limit: 2 });
    const cursor = first.nextCursor!;
    expect(f.workpads.list(f.scope, { ...all, limit: 2, sort: "updated", group: "none", cursor }).items).toHaveLength(2);
    for (const changed of [{ sort: "newest" }, { sort: "title" }, { group: "project" }, { query: "keep" }, { archived: true }] as const) {
      expect(() => f.workpads.list(f.scope, { ...all, limit: 2, ...changed, cursor })).toThrow(errorCode("cursor_invalid"));
    }
    // An ungrouped list ignores the lead project.
    expect(f.workpads.list(f.scope, { ...all, limit: 2, leadProjectId: f.betaId, cursor }).items).toHaveLength(2);

    const grouped = { ...all, group: "project" as const, leadProjectId: f.betaId, limit: 2 };
    const groupedCursor = f.workpads.list(f.scope, grouped).nextCursor!;
    expect(f.workpads.list(f.scope, { ...grouped, cursor: groupedCursor }).items).toHaveLength(2);
    for (const changed of [{ leadProjectId: f.alphaId }, { leadProjectId: undefined }, { group: "none" as const }, { sort: "title" as const }]) {
      expect(() => f.workpads.list(f.scope, { ...grouped, ...changed, cursor: groupedCursor })).toThrow(errorCode("cursor_invalid"));
    }
    expect(() => f.workpads.list({ ...f.scope, principalId: "another-owner" }, { ...grouped, cursor: groupedCursor })).toThrow(errorCode("cursor_invalid"));

    // Malformed and altered cursors are refused, never interpreted.
    const decoded = JSON.parse(Buffer.from(groupedCursor, "base64url").toString()) as unknown[];
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const forged of [
      "not-a-cursor",
      encode({ key: decoded[0], updatedAt: "2026-01-01T00:00:00.000Z", id: "x" }),
      encode(decoded.slice(0, -1)),
      encode([decoded[0], 7, ...decoded.slice(2)]),
      encode([decoded[0], 1.5, ...decoded.slice(2)]),
      encode([decoded[0], "1", ...decoded.slice(2)]),
      encode([...decoded.slice(0, 2), 42, ...decoded.slice(3)]),
      encode([...decoded.slice(0, 2), ["a", "b"], ...decoded.slice(3)]),
      encode(["0".repeat(22), ...decoded.slice(1)]),
    ]) {
      expect(() => f.workpads.list(f.scope, { ...grouped, cursor: forged })).toThrow(errorCode("cursor_invalid"));
    }
  });

  it("keeps cursors within bound for the longest names and titles and resumes in place", () => {
    const f = fixture();
    // Each label is 240 characters, sharing all but its last with its siblings.
    const long = (character: string, last: string) => `${character.repeat(239)}${last}`;
    const first = f.location({ name: long("項", "1") });
    const second = f.location({ name: long("項", "2") });
    const threadA = f.thread(first.id, long("題", "a"));
    const threadB = f.thread(first.id, long("題", "b"));
    let clock = 1_000;
    const pad = (last: string, target: WorkpadScope) => f.create(long("漢", last), target, clock += 1_000);
    const expected = [
      pad("1", { kind: "global" }),
      pad("1", { kind: "project", projectId: first.projectId }), pad("2", { kind: "project", projectId: first.projectId }),
      pad("1", { kind: "thread", threadId: threadA }), pad("2", { kind: "thread", threadId: threadA }),
      pad("1", { kind: "thread", threadId: threadB }),
      pad("1", { kind: "project", projectId: second.projectId }),
    ].map(item => item.id);
    for (const limit of [1, 2]) {
      const read = readAll(cursor => f.workpads.list(f.scope, { ...all, group: "project", sort: "title", limit, ...(cursor ? { cursor } : {}) }));
      expect(read.ids).toEqual(expected);
      // The labels themselves do not fit; the cursors carry prefixes of them.
      expect(read.cursors.every(cursor => cursor.length > 256)).toBe(true);
    }

    // A long title alone also fits, including characters JSON escapes.
    const escaped = ["\u0001", "\u0002", "\u0003"].map((character, index) => f.create(`${"\u0001".repeat(237)}${character}${index}`, { kind: "global" }, 100 + index));
    const escapedOrder = readAll(cursor => f.workpads.list(f.scope, { scope: { kind: "global" }, sort: "title", limit: 1, ...(cursor ? { cursor } : {}) }));
    expect(escapedOrder.ids.slice(0, 3)).toEqual(escaped.map(item => item.id));

    // A renamed boundary row resumes at its old title's prefix, not its new title.
    const page = f.workpads.list(f.scope, { scope: { kind: "project", projectId: first.projectId }, sort: "title", limit: 1 });
    expect(page.items.map(item => item.id)).toEqual([expected[1]]);
    f.workpads.update(f.scope, expected[1]!, { expectedRevision: 0, title: "zzz" }, undefined, 30_000);
    expect(f.workpads.list(f.scope, { scope: { kind: "project", projectId: first.projectId }, sort: "title", limit: 1, cursor: page.nextCursor }).items.map(item => item.id))
      .toEqual([expected[2]]);
  });
});
