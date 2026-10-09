import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { WorkpadRepository, type WorkpadListAuthority } from "../../src/server/db/repositories/workpad-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
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
      encode([...decoded.slice(0, 2), ["a"], ...decoded.slice(3)]),
      encode([...decoded.slice(0, 2), ["a", 1], ...decoded.slice(3)]),
      encode([...decoded.slice(0, 2), ["a", "b", "c"], ...decoded.slice(3)]),
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

  it("never skips an unchanged row when a boundary label carried as a prefix is renamed", () => {
    const f = fixture();
    const long = (character: string, last: string) => `${character.repeat(239)}${last}`;
    const titleSorted = { scope: { kind: "global" as const }, sort: "title" as const, limit: 1 };
    /** Pages from a cursor to the end of the list. */
    const rest = (request: ListWorkpadsRequest, cursor: string | undefined) => {
      const seen: string[] = [];
      for (let pages = 0; cursor !== undefined && pages < 100; pages += 1) {
        const page = f.workpads.list(f.scope, { ...request, cursor });
        seen.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      }
      return seen;
    };
    const retitle = (id: string, title: string) =>
      f.workpads.update(f.scope, id, { expectedRevision: f.workpads.get(f.scope, id).revision, title }, undefined, 40_000);

    // The reported case: a rename keeping the carried prefix must not skip its sibling.
    const a = f.create(long("漢", "a"), { kind: "global" }, 1_000);
    const b = f.create(long("漢", "b"), { kind: "global" }, 2_000);
    const page = f.workpads.list(f.scope, titleSorted);
    expect(page.items.map(item => item.id)).toEqual([a.id]);
    retitle(a.id, long("漢", "z"));
    expect(rest(titleSorted, page.nextCursor)).toEqual([b.id, a.id]);
    retitle(a.id, long("漢", "a"));
    // An unchanged boundary label resumes exactly, without repeats.
    expect(rest(titleSorted, f.workpads.list(f.scope, titleSorted).nextCursor)).toEqual([b.id]);

    // Every boundary, every rename: keeping or changing the prefix, earlier or later.
    const shared = "漢".repeat(236);
    const titles = [`${shared}c10`, `${shared}c20`, `${shared}c30`, `${shared}c40`, long("字", "x"), "plain"];
    const pads = [a, b, ...titles.map((title, index) => f.create(title, { kind: "global" }, 3_000 + index))];
    const renames = [`${shared}c00`, `${shared}c25`, `${shared}c99`, "aaa", "龍".repeat(10), long("漢", "a").toUpperCase()];
    for (const limit of [1, 2]) {
      const request = { ...titleSorted, limit };
      const order = readAll(cursor => f.workpads.list(f.scope, { ...request, ...(cursor ? { cursor } : {}) })).ids;
      expect(new Set(order)).toEqual(new Set(pads.map(item => item.id)));
      for (let boundary = limit; boundary < order.length; boundary += limit) {
        for (const title of renames) {
          let cursor: string | undefined;
          const seen: string[] = [];
          while (seen.length < boundary) {
            const next = f.workpads.list(f.scope, { ...request, ...(cursor ? { cursor } : {}) });
            seen.push(...next.items.map(item => item.id));
            cursor = next.nextCursor;
          }
          const renamed = seen.at(-1)!;
          const original = f.workpads.get(f.scope, renamed).title;
          retitle(renamed, title);
          const after = rest(request, cursor);
          expect(new Set([...seen, ...after]), `${renamed} -> ${title}`).toEqual(new Set(order));
          retitle(renamed, original);
        }
      }
    }
  });

  it("never skips an unchanged row when a grouped project or thread name is renamed at the boundary", () => {
    const f = fixture();
    const long = (character: string, last: string) => `${character.repeat(239)}${last}`;
    const grouped = { ...all, group: "project" as const, limit: 1 };
    const rest = (request: ListWorkpadsRequest, cursor: string | undefined) => {
      const seen: string[] = [];
      for (let pages = 0; cursor !== undefined && pages < 100; pages += 1) {
        const page = f.workpads.list(f.scope, { ...request, cursor });
        seen.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      }
      return seen;
    };
    const renameProject = (id: string, name: string) => f.database.prepare("UPDATE projects SET name=? WHERE id=?").run(name, id);
    const renameThread = (id: string, title: string) => f.database.prepare("UPDATE application_threads SET title=? WHERE id=?").run(title, id);

    // The reported case for each grouped label: project names, then thread titles.
    const first = f.location({ name: long("項", "a") });
    const second = f.location({ name: long("項", "b") });
    const firstPad = f.create("first", { kind: "project", projectId: first.projectId }, 1_000);
    const secondPad = f.create("second", { kind: "project", projectId: second.projectId }, 2_000);
    let page = f.workpads.list(f.scope, grouped);
    expect(page.items.map(item => item.id)).toEqual([firstPad.id]);
    renameProject(first.projectId, long("項", "z"));
    expect(rest(grouped, page.nextCursor)).toEqual([secondPad.id, firstPad.id]);
    renameProject(first.projectId, long("項", "a"));

    const third = f.location({ name: "zz third" });
    const threadA = f.thread(third.id, long("題", "a"));
    const threadB = f.thread(third.id, long("題", "b"));
    const threadPadA = f.create("thread a", { kind: "thread", threadId: threadA }, 3_000);
    const threadPadB = f.create("thread b", { kind: "thread", threadId: threadB }, 4_000);
    const thirdOnly = { scope: { kind: "project" as const, projectId: third.projectId }, scopeMode: "subtree" as const, group: "project" as const, limit: 1 };
    page = f.workpads.list(f.scope, thirdOnly);
    expect(page.items.map(item => item.id)).toEqual([threadPadA.id]);
    renameThread(threadA, long("題", "z"));
    expect(rest(thirdOnly, page.nextCursor)).toEqual([threadPadB.id, threadPadA.id]);
    renameThread(threadA, long("題", "a"));

    // Every boundary, every project or thread rename: rows outside the renamed group are never skipped.
    const shared = (character: string) => character.repeat(236);
    for (const [index, suffix] of ["c10", "c20", "c30"].entries()) {
      const location = f.location({ name: `${shared("項")}${suffix}` });
      f.create(`own ${suffix}`, { kind: "project", projectId: location.projectId }, 5_000 + index);
      const thread = f.thread(location.id, `${shared("題")}${suffix}`);
      f.create(`thread ${suffix} one`, { kind: "thread", threadId: thread }, 6_000 + index);
      f.create(`thread ${suffix} two`, { kind: "thread", threadId: thread }, 7_000 + index);
    }
    f.create("global", { kind: "global" }, 8_000);
    const renames = (character: string) => [`${shared(character)}c00`, `${shared(character)}c25`, `${shared(character)}c99`, "aaa", "龍".repeat(10)];
    for (const sort of ["updated", "title"] as const) {
      const request = { ...grouped, sort };
      const order = readAll(cursor => f.workpads.list(f.scope, { ...request, ...(cursor ? { cursor } : {}) })).ids;
      const pads = order.map(id => f.workpads.get(f.scope, id));
      const projectOf = (pad: Workpad) => pad.scope.kind === "project" ? pad.scope.projectId
        : pad.scope.kind === "thread" ? (f.database.prepare("SELECT w.project_id AS id FROM application_threads t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?").get(pad.scope.threadId) as { id: string }).id
        : null;
      for (let boundary = 1; boundary < order.length; boundary += 1) {
        const pad = pads[boundary - 1]!;
        const projectId = projectOf(pad);
        const targets: { kind: "project" | "thread"; id: string }[] = [
          ...(projectId ? [{ kind: "project" as const, id: projectId }] : []),
          ...(pad.scope.kind === "thread" ? [{ kind: "thread" as const, id: pad.scope.threadId }] : []),
        ];
        for (const target of targets) {
          for (const name of renames(target.kind === "project" ? "項" : "題")) {
            const read = f.workpads.list(f.scope, request);
            let cursor = read.nextCursor;
            const seen = read.items.map(item => item.id);
            while (seen.length < boundary) {
              const next = f.workpads.list(f.scope, { ...request, cursor });
              seen.push(...next.items.map(item => item.id));
              cursor = next.nextCursor;
            }
            const table = target.kind === "project" ? "projects" : "application_threads";
            const field = target.kind === "project" ? "name" : "title";
            const original = (f.database.prepare(`SELECT ${field} AS label FROM ${table} WHERE id=?`).get(target.id) as { label: string }).label;
            (target.kind === "project" ? renameProject : renameThread)(target.id, name);
            const after = new Set([...seen, ...rest(request, cursor)]);
            // Rows of the renamed group changed their own keys; every other row must appear.
            const unchanged = pads.filter(item => target.kind === "project" ? projectOf(item) !== target.id
              : !(item.scope.kind === "thread" && item.scope.threadId === target.id));
            for (const item of unchanged) expect(after.has(item.id), `${target.kind} ${target.id} -> ${name}: ${item.title}`).toBe(true);
            (target.kind === "project" ? renameProject : renameThread)(target.id, original);
          }
        }
      }
    }
  });

  it("counts visible workpads for every panel view and denies other scopes", () => {
    const f = groupedFixture();
    const { pads } = f;
    const counts = (threadId?: string, projectId?: string, scope: RequestScope = f.scope) =>
      f.workpads.counts(scope, { ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}) });
    const listed = (request: Omit<ListWorkpadsRequest, "limit" | "cursor">) =>
      readAll(cursor => f.workpads.list(f.scope, { ...request, limit: 100, ...(cursor ? { cursor } : {}) })).ids.length;
    /** Every count equals the length of the list it stands for. */
    const expectListLengths = (threadId: string, projectId: string) => {
      const result = counts(threadId, projectId);
      for (const archived of [false, true]) {
        expect(result[archived ? "archived" : "active"]).toEqual({
          thread: listed({ scope: { kind: "thread", threadId }, archived }),
          project: listed({ scope: { kind: "project", projectId }, archived }),
          projectWithThreads: listed({ scope: { kind: "project", projectId }, scopeMode: "subtree", archived }),
          global: listed({ scope: { kind: "global" }, archived }),
          all: listed({ ...all, archived }),
        });
      }
    };
    const none = { thread: 0, project: 0, projectWithThreads: 0, global: 0, all: 0 };
    expect(counts(f.zeta, f.betaId)).toEqual({
      active: { thread: 2, project: 2, projectWithThreads: 5, global: 2, all: 11 },
      archived: none,
    });
    expect(counts()).toEqual({
      active: { thread: null, project: null, projectWithThreads: null, global: 2, all: 11 },
      archived: { thread: null, project: null, projectWithThreads: null, global: 0, all: 0 },
    });
    expect(counts(f.only).active).toEqual({ thread: 2, project: null, projectWithThreads: null, global: 2, all: 11 });
    expect(counts(undefined, f.gammaId).active).toEqual({ thread: null, project: 1, projectWithThreads: 1, global: 2, all: 11 });
    expectListLengths(f.zeta, f.betaId);

    for (const pad of [pads.z1, pads.b1, pads.g1]) f.workpads.update(f.scope, pad.id, { expectedRevision: 0, archived: true }, undefined, 20_000);
    expect(counts(f.zeta, f.betaId)).toEqual({
      active: { thread: 1, project: 1, projectWithThreads: 3, global: 1, all: 8 },
      archived: { thread: 1, project: 1, projectWithThreads: 2, global: 1, all: 3 },
    });
    expectListLengths(f.zeta, f.betaId);

    // Removed locations and projects hide their workpads from every count.
    f.removeLocation(f.betaSecondLocationId);
    expect(counts(f.alphaThread, f.betaId).active).toEqual({ thread: 0, project: 1, projectWithThreads: 2, global: 1, all: 7 });
    expectListLengths(f.alphaThread, f.betaId);
    f.removeProject(f.alphaId);
    expect(() => counts(undefined, f.alphaId)).toThrow(errorCode("not_found"));
    expect(counts(f.zeta, f.betaId).active).toEqual({ thread: 1, project: 1, projectWithThreads: 2, global: 1, all: 4 });
    expectListLengths(f.zeta, f.betaId);

    // Unknown and other owners' threads and projects are not found; nothing leaks.
    expect(() => counts(randomUUID())).toThrow(errorCode("not_found"));
    expect(() => counts(undefined, randomUUID())).toThrow(errorCode("not_found"));
    expect(() => counts("not-a-thread-id")).toThrow(errorCode("bad_request"));
    const other = { ...f.scope, principalId: "another-owner" };
    expect(() => counts(f.zeta, undefined, other)).toThrow(errorCode("not_found"));
    expect(() => counts(undefined, f.betaId, other)).toThrow(errorCode("not_found"));
    expect(counts(undefined, undefined, other)).toEqual({
      active: { thread: null, project: null, projectWithThreads: null, global: 0, all: 0 },
      archived: { thread: null, project: null, projectWithThreads: null, global: 0, all: 0 },
    });
    expect(() => f.workpads.counts(f.scope, { threadId: "" })).toThrow(errorCode("bad_request"));
    expect(() => f.workpads.counts(f.scope, { scope: "global" } as never)).toThrow(errorCode("bad_request"));
  });
});
