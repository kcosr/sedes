import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("sends explicit skill refresh intent %s without HTTP caching", async (refresh) => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ skills: [] }));
  vi.stubGlobal("fetch", fetch);
  await expect(new ApiClient().listSkills("thread/one", { refresh })).resolves.toEqual({ skills: [] });
  expect(fetch.mock.calls[0]![0]).toBe(`/api/threads/thread%2Fone/skills?refresh=${refresh}`);
  expect(fetch.mock.calls[0]![1].cache).toBe("no-store");
});
