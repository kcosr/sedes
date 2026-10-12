import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { htmlPagesMigration } from "../../src/server/db/migrations/140-html-pages.js";
import { PageRepository } from "../../src/server/db/repositories/page-repository.js";
import { PageService } from "../../src/server/pages/page-service.js";
import { MAXIMUM_NORMALIZED_TIMELINE_ITEMS } from "../../src/shared/protocol/conversation.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(database => database.close()); vi.restoreAllMocks(); });
const scope = { tenantId: "tenant", principalId: "principal" };
function fixture() {
  const database = new Database(":memory:"); databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE principals(tenant_id TEXT,id TEXT,PRIMARY KEY(tenant_id,id));
    CREATE TABLE application_threads(tenant_id TEXT,owner_principal_id TEXT,id TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    INSERT INTO principals VALUES('tenant','principal');
    INSERT INTO application_threads VALUES('tenant','principal','thread'),('tenant','principal','other');`);
  database.exec(htmlPagesMigration.sql);
  return { database, repository: new PageRepository(database) };
}
function input(html = "<html><body>first</body></html>", invocationId = "first") {
  return { title: "Preview", viewport: { width: 390 }, path: "/work/page.html", invocationId,
    anchor: { turnId: "turn1", afterItemId: "tool1" },
    prepared: { sourceHtml: html, escapedHtml: JSON.stringify(html).slice(1, -1).replaceAll("<", "\\u003c"), bootstrapOffset: 0,
      sha256: createHash("sha256").update(html).digest("hex"), byteSize: Buffer.byteLength(html) } };
}
function serviceFor(repository: PageRepository, readAbsoluteFile: ConstructorParameters<typeof PageService>[0]["files"]["readAbsoluteFile"], onPublished?: ConstructorParameters<typeof PageService>[0]["onPublished"]) {
  return new PageService({ repository, files: { readAbsoluteFile }, onPublished, inventory: {
    getThread: () => ({ thread: { workspaceId: "workspace" } }),
    getWorkspace: () => ({ id: "workspace", environmentId: "environment", canonicalPath: "/work", availability: "available" }),
    getEnvironment: () => ({ availability: "available", configurationRevision: 1, operationsConfigurationRevision: 1 }),
  } as never });
}

describe("immutable thread HTML pages", () => {
  it("stores all queried metadata before large text and indexes exact turn associations", () => {
    const { database, repository } = fixture();
    const columns = database.pragma("table_info(html_page_revisions)") as { name: string; cid: number }[];
    const position = (name: string) => columns.find(column => column.name === name)!.cid;
    for (const field of ["descriptor_json", "invocation_id", "anchor_turn_id", "anchor_json"]) {
      expect(position(field)).toBeLessThan(position("source_html"));
      expect(position(field)).toBeLessThan(position("escaped_html"));
    }
    expect(position("bootstrap_offset")).toBeLessThan(position("source_html"));
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM html_page_revisions WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND anchor_turn_id=?")
      .all(scope.tenantId, scope.principalId, "thread", "turn1") as { detail: string }[];
    expect(plan.some(row => row.detail.includes("html_page_revision_turn") && row.detail.includes("anchor_turn_id=?"))).toBe(true);
    repository.publish(scope, "thread", input("large".repeat(200_000)));
    expect(repository.publications(scope, "thread", ["turn1"])).toHaveLength(1);
    expect(repository.publications(scope, "thread", ["another-turn"])).toEqual([]);
  });
  it("bounds projection reads in SQL and preserves all metadata in the paginated library", () => {
    const { repository, database } = fixture();
    const first = repository.publish(scope, "thread", input("first", "first"), 1000);
    const second = repository.publish(scope, "thread", input("second", "second"), 1000);
    const prepare = vi.spyOn(database, "prepare");
    const publications = repository.publications(scope, "thread", ["turn1"]);
    expect(publications.map(value => value.page.pageId)).toEqual([first.page.pageId, second.page.pageId]);
    const query = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("SELECT descriptor_json,invocation_id,anchor_json"));
    expect(query).toContain(`ORDER BY rowid LIMIT ${MAXIMUM_NORMALIZED_TIMELINE_ITEMS}`);
    expect(query).not.toContain("SELECT *");
    const firstLibraryPage = repository.list(scope, "thread", { limit: 1 });
    const nextLibraryPage = repository.list(scope, "thread", { limit: 1, cursor: firstLibraryPage.nextCursor });
    expect(new Set([...firstLibraryPage.items, ...nextLibraryPage.items].map(value => value.pageId)))
      .toEqual(new Set([first.page.pageId, second.page.pageId]));
  });
  it("creates a stable page with immutable revisions, no-op detection and optimistic conflict protection", () => {
    const { repository } = fixture();
    const first = repository.publish(scope, "thread", input(), 1000);
    expect(first.changed).toBe(true); expect(first.page.revision).toBe(1);
    const same = repository.publish(scope, "thread", { ...input(undefined, "noop"), pageId: first.page.pageId, expectedRevision: 1 }, 2000);
    expect(same).toEqual({ page: first.page, changed: false });
    const next = repository.publish(scope, "thread", { ...input("<html>second</html>", "next"), pageId: first.page.pageId, expectedRevision: 1 }, 3000);
    expect(next.page.revision).toBe(2); expect(next.page.pageId).toBe(first.page.pageId);
    expect(repository.content(scope, "thread", first.page.pageId, 1).escapedHtml).toContain("first");
    expect(repository.content(scope, "thread", first.page.pageId, 2).escapedHtml).toContain("second");
    expect(() => repository.publish(scope, "thread", { ...input("stale", "stale"), pageId: first.page.pageId, expectedRevision: 1 })).toThrow("page changed");
    expect(repository.publications(scope, "thread", ["turn1"])).toHaveLength(2);
    expect(repository.publications(scope, "thread", ["another-turn"])).toEqual([]);
  });

  it("denies wrong principal/thread access and cascades thread deletion", () => {
    const { repository, database } = fixture();
    const { page } = repository.publish(scope, "thread", input());
    expect(() => repository.get({ ...scope, principalId: "other" }, "thread", page.pageId)).toThrow("not found");
    expect(() => repository.get(scope, "other", page.pageId)).toThrow("not found");
    expect(() => database.prepare("UPDATE html_page_revisions SET escaped_html='changed'").run()).toThrow("immutable");
    database.prepare("DELETE FROM application_threads WHERE id='thread'").run();
    expect(database.prepare("SELECT COUNT(*) AS n FROM html_page_revisions").get()).toEqual({ n: 0 });
  });

  it("checks publication authority inside the transaction and keeps pagination scoped", () => {
    const { repository } = fixture();
    expect(() => repository.publish(scope, "thread", { ...input(), assertCurrent: () => { throw new Error("retired"); } })).toThrow("retired");
    expect(repository.list(scope, "thread").items).toEqual([]);
    for (let i = 0; i < 3; i += 1) repository.publish(scope, "thread", input(String(i), `inv-${i}`), i + 1000);
    const first = repository.list(scope, "thread", { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(repository.list(scope, "thread", { cursor: first.nextCursor, limit: 2 }).items).toHaveLength(1);
    expect(() => repository.list(scope, "other", { cursor: first.nextCursor })).toThrow("cursor");
  });

  it("continues page and revision lists without duplicates when publications arrive between requests", () => {
    const { repository } = fixture();
    const old = repository.publish(scope, "thread", input("old", "old"), 1000).page;
    const middle = repository.publish(scope, "thread", input("middle", "middle"), 2000).page;
    const recent = repository.publish(scope, "thread", input("recent", "recent"), 3000).page;
    const first = repository.list(scope, "thread", { limit: 1 });
    expect(first.items.map(page => page.pageId)).toEqual([recent.pageId]);
    repository.publish(scope, "thread", { ...input("old updated", "old-updated"), pageId: old.pageId, expectedRevision: 1 }, 4000);
    repository.publish(scope, "thread", input("new", "new"), 5000);
    const continuation = repository.list(scope, "thread", { limit: 2, cursor: first.nextCursor });
    expect(continuation.items.map(page => page.pageId)).toEqual([middle.pageId, old.pageId]);
    expect(continuation.items[1]?.revision).toBe(2);
    const revisions = repository.revisions(scope, "thread", old.pageId, { limit: 1 });
    expect(revisions.items[0]?.revision).toBe(2);
    repository.publish(scope, "thread", { ...input("old third", "old-third"), pageId: old.pageId, expectedRevision: 2 }, 6000);
    expect(repository.revisions(scope, "thread", old.pageId, { limit: 1, cursor: revisions.nextCursor }).items.map(page => page.revision)).toEqual([1]);
  });

  it("reports capture deadlines and root retirement as retryable domain failures, preserving caller cancellation", async () => {
    const { repository } = fixture();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const service = serviceFor(repository, async (_scope, _thread, _path, _max, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      if (signal!.aborted) reject(signal!.reason);
    }));
    const pending = service.prepare(scope, "thread", { path: "/work/page.html" });
    deadline.abort(new DOMException("capture deadline", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true, message: expect.stringContaining("timed out") });
    vi.restoreAllMocks();
    const retired = serviceFor(repository, async () => { throw new Error("page_source_root_retired"); });
    await expect(retired.prepare(scope, "thread", { path: "/work/page.html" })).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true, message: expect.stringContaining("root changed") });
    const caller = new AbortController(); const reason = new Error("caller stopped"); caller.abort(reason);
    await expect(service.prepare(scope, "thread", { path: "/work/page.html" }, caller.signal)).rejects.toBe(reason);
  });

  it("returns committed publications while the live-refresh callback remains pending", async () => {
    const { repository } = fixture();
    let completeRefresh!: () => void;
    const callback = new Promise<void>(resolve => { completeRefresh = resolve; });
    const onPublished = vi.fn(() => callback);
    const service = serviceFor(repository, async () => Buffer.from("<p>Preview</p>"), onPublished);
    const result = await service.publish(scope, "thread", { path: "/work/page.html", title: "Page" }, { invocationId: "detached" });
    expect(result.changed).toBe(true);
    expect(onPublished).toHaveBeenCalledOnce();
    completeRefresh();
  });

  it("fences environment changes during asynchronous file capture before publication", async () => {
    const { repository } = fixture();
    let environmentRevision = 1;
    const service = new PageService({ repository, files: { readAbsoluteFile: async () => {
      environmentRevision = 2;
      return Buffer.from("<html>captured</html>");
    } }, inventory: {
      getThread: () => ({ thread: { workspaceId: "workspace" } }),
      getWorkspace: () => ({ id: "workspace", environmentId: "environment", canonicalPath: "/work", availability: "available" }),
      getEnvironment: () => ({ availability: "available", configurationRevision: environmentRevision, operationsConfigurationRevision: 1 }),
    } as never });
    await expect(service.publish(scope, "thread", { path: "/work/page.html", title: "Page" }, { invocationId: "new" })).rejects.toThrow("environment changed");
    expect(repository.list(scope, "thread").items).toEqual([]);
  });

  it("does not report a committed publication failed when live notification throws", async () => {
    const { repository } = fixture();
    const service = new PageService({ repository, files: { readAbsoluteFile: async () => Buffer.from("<html>captured</html>") },
      inventory: {
        getThread: () => ({ thread: { workspaceId: "workspace" } }),
        getWorkspace: () => ({ id: "workspace", environmentId: "environment", canonicalPath: "/work", availability: "available" }),
        getEnvironment: () => ({ availability: "available", configurationRevision: 1, operationsConfigurationRevision: 1 }),
      } as never,
      onPublished: () => { throw new Error("temporarily offline"); },
    });
    const result = await service.publish(scope, "thread", { path: "/work/page.html", title: "Page" }, { invocationId: "new", anchor: { turnId: "turn" } });
    expect(result.changed).toBe(true);
    expect(repository.publications(scope, "thread", ["turn"])).toHaveLength(1);
  });

  it("publishes inline HTML without inventing or reading a filesystem path", async () => {
    const { repository } = fixture();
    const service = new PageService({ repository, files: { readAbsoluteFile: async () => { throw new Error("must not read"); } },
      inventory: {
        getThread: () => ({ thread: { workspaceId: "workspace" } }),
        getWorkspace: () => ({ id: "workspace", environmentId: "environment", canonicalPath: "/work", availability: "available" }),
        getEnvironment: () => ({ availability: "available", configurationRevision: 1, operationsConfigurationRevision: 1 }),
      } as never,
    });
    const result = await service.publish(scope, "thread", { html: "<h1>Inline</h1>", title: "Inline" }, { invocationId: "inline" });
    expect(repository.source(scope, "thread", result.page.pageId)).toEqual({ html: "<h1>Inline</h1>" });
    expect(repository.content(scope, "thread", result.page.pageId, 1).escapedHtml).toContain("Inline");
  });
});
