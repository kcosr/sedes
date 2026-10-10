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
      expect(cursor.length).toBeLessThanOrEqual(256);
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
function scopedFixture() {
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
  return { ...f, ...ids, pads };
}
const all = { scope: { kind: "global" as const }, scopeMode: "subtree" as const };

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

  it("binds a cursor to its sort, filters and owner and refuses altered cursors", () => {
    const f = scopedFixture();
    const cursor = f.workpads.list(f.scope, { ...all, limit: 2 }).nextCursor!;
    expect(f.workpads.list(f.scope, { ...all, limit: 2, sort: "updated", cursor }).items).toHaveLength(2);
    for (const changed of [{ sort: "newest" }, { sort: "title" }, { query: "keep" }, { archived: true }, { limit: 3 }, { scopeMode: "exact" }] as const) {
      expect(() => f.workpads.list(f.scope, { ...all, limit: 2, ...changed, cursor })).toThrow(errorCode("cursor_invalid"));
    }
    expect(() => f.workpads.list({ ...f.scope, principalId: "another-owner" }, { ...all, limit: 2, cursor })).toThrow(errorCode("cursor_invalid"));
    expect(() => f.workpads.list(f.scope, { ...all, limit: 2, cursor }, { environmentIds: [f.environmentId], continuationKey: "agent" })).toThrow(errorCode("cursor_invalid"));
    expect(() => f.workpads.list(f.scope, { ...all, cursor: "a".repeat(257) })).toThrow(errorCode("bad_request"));

    // Malformed and altered cursors are refused, never interpreted.
    const titled = { ...all, sort: "title" as const, limit: 2 };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const [fingerprint, key, id] = JSON.parse(Buffer.from(f.workpads.list(f.scope, titled).nextCursor!, "base64url").toString()) as [string, string, string];
    expect(f.workpads.list(f.scope, { ...titled, cursor: encode([fingerprint, key, id]) }).items).toHaveLength(2);
    for (const forged of [
      "not-a-cursor",
      encode({ key: fingerprint, updatedAt: "2026-01-01T00:00:00.000Z", id }),
      encode([fingerprint, key]),
      encode([fingerprint, key, id, "extra"]),
      encode([fingerprint, 7, id]),
      encode([fingerprint, key, 7]),
      encode([fingerprint, ["a"], id]),
      encode([fingerprint, ["a", 1], id]),
      encode([fingerprint, ["a", "b", "c"], id]),
      encode(["0".repeat(22), key, id]),
    ]) {
      expect(() => f.workpads.list(f.scope, { ...titled, cursor: forged })).toThrow(errorCode("cursor_invalid"));
    }
    // Only a title travels as a prefix and digest.
    const [updatedFingerprint, , updatedId] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string, string];
    expect(() => f.workpads.list(f.scope, { ...all, limit: 2, cursor: encode([updatedFingerprint, ["2026", "digest"], updatedId]) })).toThrow(errorCode("cursor_invalid"));
  });

  it("keeps cursors within bound for the longest titles and resumes in place", () => {
    const f = fixture();
    // Each title is 240 characters, sharing all but its last with its siblings.
    const long = (character: string, last: string) => `${character.repeat(239)}${last}`;
    const expected = ["1", "2", "3"].map((last, index) => f.create(long("漢", last), { kind: "global" }, 1_000 + index).id);
    for (const limit of [1, 2]) {
      const read = readAll(cursor => f.workpads.list(f.scope, { scope: { kind: "global" }, sort: "title", limit, ...(cursor ? { cursor } : {}) }));
      expect(read.ids).toEqual(expected);
      // The titles themselves do not fit; the cursors carry a prefix and digest.
      for (const cursor of read.cursors) {
        expect(Array.isArray((JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown[])[1])).toBe(true);
      }
    }
    // Characters JSON escapes shrink the prefix further.
    const escaped = ["\u0001", "\u0002", "\u0003"].map((character, index) => f.create(`${"\u0001".repeat(237)}${character}${index}`, { kind: "global" }, 100 + index));
    const escapedOrder = readAll(cursor => f.workpads.list(f.scope, { scope: { kind: "global" }, sort: "title", limit: 1, ...(cursor ? { cursor } : {}) }));
    expect(escapedOrder.ids).toEqual([...escaped.map(item => item.id), ...expected]);
  });

  it("never skips an unchanged row when a boundary title carried as a prefix is renamed", () => {
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

  it("counts visible workpads for every panel view and denies other scopes", () => {
    const f = scopedFixture();
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
