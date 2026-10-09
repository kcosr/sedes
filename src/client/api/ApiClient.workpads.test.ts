// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

const counts = {
  active: { thread: 2, project: 1, projectWithThreads: 4, global: 3, all: 9 },
  archived: { thread: 0, project: 0, projectWithThreads: 1, global: 0, all: 1 },
};

/** Records each request's URL and answers with `body`. */
function serve(body: unknown) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    urls.push(new URL(String(input), "http://sedes.test"));
    return Response.json(body);
  }));
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient workpads", () => {
  it("sends a list's scope and sort, leaving the server's default sort implicit", async () => {
    const urls = serve({ items: [] });
    const api = new ApiClient();
    await api.listWorkpads({ scope: { kind: "global" }, scopeMode: "subtree", sort: "title" });
    await api.listWorkpads({ scope: { kind: "project", projectId: "project-1" }, scopeMode: "exact", sort: "updated" });
    await api.listWorkpads({ scope: { kind: "thread", threadId: "thread-1" }, archived: true, sort: "newest", cursor: "next" });
    expect(urls.map(url => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual([
      ["/api/workpads", { scopeKind: "global", scopeMode: "subtree", sort: "title" }],
      // Most recently updated is what the server does unasked.
      ["/api/workpads", { scopeKind: "project", projectId: "project-1", scopeMode: "exact" }],
      ["/api/workpads", { scopeKind: "thread", threadId: "thread-1", archived: "true", cursor: "next", sort: "newest" }],
    ]);
  });

  it("reads the counts of a thread and its project", async () => {
    const urls = serve(counts);
    const api = new ApiClient();
    await expect(api.getWorkpadCounts({ threadId: "thread-1", projectId: "project-1" })).resolves.toEqual(counts);
    await expect(api.getWorkpadCounts({})).resolves.toEqual(counts);
    expect(urls.map(url => `${url.pathname}${url.search}`)).toEqual([
      "/api/workpads/counts?threadId=thread-1&projectId=project-1",
      "/api/workpads/counts",
    ]);
  });

  it("rejects counts outside the contract", async () => {
    serve({ ...counts, active: { ...counts.active, all: -1 } });
    await expect(new ApiClient().getWorkpadCounts({})).rejects.toThrow();
  });
});
