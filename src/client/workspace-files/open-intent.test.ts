import { describe, expect, it } from "vitest";
import { createWorkspaceFilesOpenIntent, isWorkspaceFilesOpenIntent } from "./open-intent.js";

describe("workspace Files open intents", () => {
  it("sequences repeated opens of the same root-qualified address", () => {
    const input = {
      workspaceId: "workspace-1",
      rootId: "primary" as const,
      path: "README.md",
      rootVisibility: "listed" as const,
      target: { kind: "source_line" as const, lineNumber: 27 },
    };
    const first = createWorkspaceFilesOpenIntent(input);
    const second = createWorkspaceFilesOpenIntent(input);
    expect(second.sequence).not.toBe(first.sequence);
    expect(first.target).toEqual({ kind: "source_line", lineNumber: 27 });
    expect(isWorkspaceFilesOpenIntent(first)).toBe(true);
    expect(isWorkspaceFilesOpenIntent(second)).toBe(true);
  });

  it("rejects malformed internal addresses", () => {
    expect(
      isWorkspaceFilesOpenIntent({
        kind: "open-workspace-file",
        workspaceId: "w",
        rootId: "primary",
        path: "../escape",
        rootVisibility: "listed",
        target: { kind: "file" },
        sequence: 1,
      }),
    ).toBe(false);
    expect(
      isWorkspaceFilesOpenIntent({
        kind: "open-workspace-file",
        workspaceId: "w",
        rootId: "primary",
        path: "ok",
        rootVisibility: "listed",
        target: { kind: "file" },
        sequence: 1.5,
      }),
    ).toBe(false);
    expect(
      isWorkspaceFilesOpenIntent({
        kind: "open-workspace-file",
        workspaceId: "w",
        rootId: "primary",
        path: "ok",
        rootVisibility: "hidden",
        target: { kind: "file" },
        sequence: 1,
      }),
    ).toBe(false);
    expect(
      isWorkspaceFilesOpenIntent({
        kind: "open-workspace-file",
        workspaceId: "w",
        rootId: "primary",
        path: "ok",
        rootVisibility: "listed",
        target: { kind: "source_line", lineNumber: 0 },
        sequence: 1,
      }),
    ).toBe(false);
  });
});
