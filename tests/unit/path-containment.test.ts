import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathIsWithin } from "../../src/server/path-containment.js";

describe("pathIsWithin", () => {
  it.each([
    ["/srv/policy", "/srv/policy", true],
    ["/srv/policy", "/srv/policy/workspace", true],
    ["/srv/policy", "/srv/policy/..name/workspace", true],
    ["/srv/policy", "/srv/policy-sibling", false],
    ["/srv/policy", "/srv", false],
    ["/", "/", true],
    ["/", "/srv/workspace", true],
  ])("POSIX %s contains %s: %s", (root, candidate, expected) => {
    expect(pathIsWithin(root, candidate, path.posix)).toBe(expected);
  });

  it.each([
    ["C:\\", "C:\\", true],
    ["C:\\", "C:\\workspace", true],
    ["C:\\", "D:\\workspace", false],
    ["C:\\policy", "C:\\policy\\workspace", true],
    ["C:\\policy", "c:\\POLICY\\workspace", true],
    ["C:\\policy", "C:\\policy-sibling", false],
    ["C:\\policy", "D:\\elsewhere\\ws", false],
    ["C:\\policy", "D:\\policy\\workspace", false],
  ])("Windows %s contains %s: %s", (root, candidate, expected) => {
    expect(pathIsWithin(root, candidate, path.win32)).toBe(expected);
  });
});
