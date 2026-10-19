// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDiffChangedFileSummary } from "../../shared/protocol/workspace-diffs.js";
import { WorkspaceChangedFileNavigator } from "./WorkspaceChangedFileNavigator.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubDensity(touch: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: touch,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const files = Array.from({ length: 3 }, (_, index) => ({
  fileId: `file-${index + 1}`,
  changeKind: "modified",
  oldPath: `src/file-${index + 1}.ts`,
  newPath: `src/file-${index + 1}.ts`,
  additions: 1,
  deletions: 1,
  binary: false,
})) as WorkspaceDiffChangedFileSummary[];

function renderNavigator() {
  render(
    <WorkspaceChangedFileNavigator
      files={files}
      reviewedFileIds={new Set()}
      commentCounts={new Map()}
      filter=""
      onFilterChange={() => undefined}
      collapsedDirectories={[]}
      onCollapsedDirectoriesChange={() => undefined}
      onNavigate={() => undefined}
      loading={false}
      truncated={false}
    />,
  );
  return screen.getAllByRole("treeitem");
}

describe("WorkspaceChangedFileNavigator", () => {
  it("lays out 32px rows at desktop density", () => {
    stubDensity(false);
    const rows = renderNavigator();
    expect(rows.map((row) => row.style.top)).toEqual([
      "0px",
      "32px",
      "64px",
      "96px",
    ]);
    expect(rows.every((row) => row.style.height === "32px")).toBe(true);
  });

  it("lays out 44px rows under touch density", () => {
    stubDensity(true);
    const rows = renderNavigator();
    expect(rows.map((row) => row.style.top)).toEqual([
      "0px",
      "44px",
      "88px",
      "132px",
    ]);
    expect(rows.every((row) => row.style.height === "44px")).toBe(true);
    expect(rows[0]!.parentElement!.style.height).toBe(`${4 * 44}px`);
  });
});
