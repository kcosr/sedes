// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseRoute, routePath, settingsPath, type Route } from "./router.js";
import { parseSettingsResource, settingsResourceParent, settingsResourceSuffix } from "./settings-route.js";

describe("settings resource routes", () => {
  const cases: ReadonlyArray<readonly [string, Route]> = [
    ["/settings/environments/10000000-0000-4000-8000-000000000001",
      { name: "settings", page: "environments", mode: "view", resourceId: "10000000-0000-4000-8000-000000000001" }],
    ["/settings/environments/10000000-0000-4000-8000-000000000001/edit",
      { name: "settings", page: "environments", mode: "edit", resourceId: "10000000-0000-4000-8000-000000000001" }],
    ["/settings/environments/new", { name: "settings", page: "environments", mode: "new" }],
    ["/settings/environments/new/ssh", { name: "settings", page: "environments", mode: "new", resourceId: "ssh" }],
    ["/settings/environments/new/local", { name: "settings", page: "environments", mode: "new", resourceId: "local" }],
    ["/settings/environments/new/pair", { name: "settings", page: "environments", mode: "new", resourceId: "pair" }],
    ["/settings/environments/pending/reg-1", { name: "settings", page: "environments", mode: "pending", resourceId: "reg-1" }],
    ["/settings/backends/codex-stdio-e2e", { name: "settings", page: "backends", mode: "view", resourceId: "codex-stdio-e2e" }],
    ["/settings/backends/codex-stdio-e2e/edit", { name: "settings", page: "backends", mode: "edit", resourceId: "codex-stdio-e2e" }],
    ["/settings/backends/new", { name: "settings", page: "backends", mode: "new" }],
  ];

  it.each(cases)("round-trips %s", (pathname, route) => {
    expect(parseRoute(pathname)).toEqual(route);
    expect(routePath(route)).toBe(pathname);
  });

  it("encodes identifiers that are not path-safe and decodes them back", () => {
    const route: Route = { name: "settings", page: "backends", mode: "edit", resourceId: "a b/c" };
    expect(routePath(route)).toBe("/settings/backends/a%20b%2Fc/edit");
    expect(parseRoute("/settings/backends/a%20b%2Fc/edit")).toEqual(route);
  });

  it("keeps the list URL for an inventory page without a selection", () => {
    expect(settingsPath("environments")).toBe("/settings/environments");
    expect(settingsPath("environments", {})).toBe("/settings/environments");
    expect(settingsPath("backends", { mode: "view", resourceId: "pi" })).toBe("/settings/backends/pi");
    // Pages without entity routes ignore a resource.
    expect(settingsPath("general", { mode: "view", resourceId: "pi" })).toBe("/settings/general");
  });

  it.each([
    "/settings/environments/",
    "/settings/environments/new/",
    "/settings/environments/new/outbound",
    "/settings/environments/pending",
    "/settings/environments/pending/",
    "/settings/environments/abc/",
    "/settings/environments/abc/delete",
    "/settings/environments/abc/edit/extra",
    "/settings/environments/%E0%A4%A",
    "/settings/backends/new/ssh",
    "/settings/backends/pending/reg-1",
    "/settings/general/abc",
    "/settings/projects/abc",
  ])("rejects the unknown entity URL %s", pathname => {
    expect(parseRoute(pathname)).toEqual({ name: "home" });
  });

  it("never treats the reserved words as entity ids", () => {
    expect(parseSettingsResource("environments", ["new", "edit"])).toBeUndefined();
    expect(parseSettingsResource("backends", ["pending", "x"])).toBeUndefined();
    expect(parseSettingsResource("environments", ["%6Eew"])).toBeUndefined();
    expect(parseSettingsResource("environments", ["x".repeat(161)])).toBeUndefined();
  });

  it("names one level up from each entity route, as its ‹ link does", () => {
    expect(settingsResourceParent({ mode: "edit", resourceId: "e1" })).toEqual({ mode: "view", resourceId: "e1" });
    expect(settingsResourceParent({ mode: "view", resourceId: "e1" })).toEqual({});
    expect(settingsResourceParent({ mode: "new", resourceId: "ssh" })).toEqual({ mode: "new" });
    expect(settingsResourceParent({ mode: "new" })).toEqual({});
    expect(settingsResourceParent({ mode: "pending", resourceId: "r1" })).toEqual({});
    expect(settingsResourceParent({})).toEqual({});
  });

  it("serializes only complete resource routes", () => {
    expect(settingsResourceSuffix({})).toBe("");
    expect(settingsResourceSuffix({ mode: "view" })).toBe("");
    expect(settingsResourceSuffix({ mode: "pending", resourceId: "r" })).toBe("/pending/r");
    expect(settingsResourceSuffix({ mode: "new", resourceId: "pair" })).toBe("/new/pair");
  });
});
