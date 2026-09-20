import { describe, expect, it } from "vitest";
import {
  mostSpecificWorkspaceFileRootMatch,
  supplementalRootConflictsWithPrimary,
  workspaceFileRootsOverlap,
} from "../../src/server/workspace-files/root-topology.js";

describe("workspace file-root topology", () => {
  it("allows supplemental ancestors and descendants but rejects primary equality", () => {
    expect(
      supplementalRootConflictsWithPrimary(
        "/home/person/project",
        "/home/person",
      ),
    ).toBe(false);
    expect(
      supplementalRootConflictsWithPrimary(
        "/home/person/project",
        "/home/person/project",
      ),
    ).toBe(true);
    expect(
      supplementalRootConflictsWithPrimary(
        "/home/person/project",
        "/home/person/project/context",
      ),
    ).toBe(false);
    expect(
      workspaceFileRootsOverlap(
        "/home/person/context",
        "/home/person/context/nested",
      ),
    ).toBe(true);
  });

  it("selects the unique deepest match and gives primary an exact tie", () => {
    const ancestor = {
      id: "home",
      canonicalPath: "/home/person",
      primary: false,
    };
    const primary = {
      id: "primary",
      canonicalPath: "/home/person/project",
      primary: true,
    };
    expect(
      mostSpecificWorkspaceFileRootMatch([ancestor, primary]),
    ).toEqual(primary);
    expect(
      mostSpecificWorkspaceFileRootMatch([
        { ...ancestor, canonicalPath: primary.canonicalPath },
        primary,
      ]),
    ).toEqual(primary);
  });

  it("rejects unrelated roots that both claim a match", () => {
    expect(
      mostSpecificWorkspaceFileRootMatch([
        { canonicalPath: "/one", primary: true },
        { canonicalPath: "/two", primary: false },
      ]),
    ).toBeUndefined();
  });
});
