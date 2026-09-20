import { describe, expect, it } from "vitest";
import {
  directoryBrowseRequestSchema,
  directoryBrowseResultSchema,
} from "../../src/shared/protocol/directory-browser.js";

describe("directory browser protocol", () => {
  it("accepts only bounded normalized absolute browse requests", () => {
    expect(
      directoryBrowseRequestSchema.parse({
        location: { kind: "directory", path: "/srv/worktrees/project" },
      }),
    ).toEqual({
      location: { kind: "directory", path: "/srv/worktrees/project" },
      pageSize: 50,
    });
    expect(
      directoryBrowseRequestSchema.parse({
        location: { kind: "directory", path: "C:\\Users\\operator\\project" },
      }),
    ).toEqual({
      location: { kind: "directory", path: "C:\\Users\\operator\\project" },
      pageSize: 50,
    });
    expect(
      directoryBrowseRequestSchema.safeParse({
        location: { kind: "directory", path: "\\\\server\\share\\repo" },
      }).success,
    ).toBe(true);
    for (const path of [
      "relative",
      "/srv//project",
      "/srv/../project",
      "/srv/./project",
      "/srv/project/",
      "/srv\\project",
      "/srv/project\nname",
      "C:/Users/operator/project",
      "C:\\Users\\\\project",
      "C:\\Users\\..\\project",
      "C:\\Users\\project\\",
    ]) {
      expect(() =>
        directoryBrowseRequestSchema.parse({
          location: { kind: "directory", path },
        }),
      ).toThrow();
    }
    expect(() =>
      directoryBrowseRequestSchema.parse({
        location: { kind: "roots" },
        pageSize: 201,
      }),
    ).toThrow();
    expect(() =>
      directoryBrowseRequestSchema.parse({
        location: { kind: "roots" },
        unexpected: true,
      }),
    ).toThrow();
  });

  it("keeps pagination and scan truncation as independent bounded facts", () => {
    expect(
      directoryBrowseResultSchema.parse({
        location: {
          kind: "directory",
          path: "/srv/worktrees",
          parentPath: "/srv",
        },
        entries: [{ name: "project", path: "/srv/worktrees/project" }],
        nextCursor: "opaque-next-page",
        truncated: false,
      }),
    ).toEqual({
      location: {
        kind: "directory",
        path: "/srv/worktrees",
        parentPath: "/srv",
      },
      entries: [{ name: "project", path: "/srv/worktrees/project" }],
      nextCursor: "opaque-next-page",
      truncated: false,
    });
    expect(() =>
      directoryBrowseResultSchema.parse({
        location: { kind: "roots" },
        entries: [{ name: "bad/name", path: "/srv/worktrees" }],
        truncated: false,
      }),
    ).toThrow();
  });
});
