// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDiffRevisionDescriptor } from "../../shared/protocol/workspace-diffs.js";
import { WorkspaceRevisionPicker } from "./WorkspaceRevisionPicker.js";

afterEach(cleanup);
const revisions = [
  { revisionId: "main", kind: "local_branch", label: "main", commitHash: "a".repeat(40), shortHash: "aaaaaaa" },
  { revisionId: "feature", kind: "local_branch", label: "feature/layout", commitHash: "b".repeat(40), shortHash: "bbbbbbb", isCurrentBranch: true },
  { revisionId: "old", kind: "commit", label: "ccccccc", commitHash: "c".repeat(40), shortHash: "ccccccc", summary: "Old change", committedAt: "2026-09-19T11:00:00.000Z" },
  { revisionId: "new", kind: "commit", label: "ddddddd", commitHash: "d".repeat(40), shortHash: "ddddddd", summary: "Restore file reading position", committedAt: "2026-09-20T14:32:00.000Z" },
] as WorkspaceDiffRevisionDescriptor[];

function open() { fireEvent.click(screen.getByRole("button", { name: "Base revision" })); }

describe("WorkspaceRevisionPicker", () => {
  it("groups sources, prioritizes the current branch, and shows messages and dates newest first", () => {
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={vi.fn()} />);
    open();
    const branches = within(screen.getByRole("group", { name: "Local branches" })).getAllByRole("option");
    expect(branches[0]!.textContent).toContain("feature/layoutCurrent");
    const commits = within(screen.getByRole("group", { name: "Commits · newest first" })).getAllByRole("option");
    expect(commits[0]!.textContent).toContain("Restore file reading position");
    expect(commits[0]!.querySelector("time")?.dateTime).toBe("2026-09-20T14:32:00.000Z");
    expect(commits[0]!.textContent?.match(/ddddddd/gu)).toHaveLength(1);
    expect(commits[1]!.textContent).toContain("Old change");
    expect(screen.getByRole("option", { name: /Staged changes/ })).toBeTruthy();
  });

  it("searches messages and full hashes, selects an opaque revision, and restores trigger focus", () => {
    const onChange = vi.fn();
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={onChange} />);
    open();
    const search = screen.getByRole("textbox", { name: "Search base revisions" });
    fireEvent.change(search, { target: { value: "reading position" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("option"));
    expect(onChange).toHaveBeenCalledWith({ kind: "revision", revisionId: "new" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "c".repeat(40) } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Old change");
  });

  it("exposes branch-scoped and all-branch history, empty results and bounded catalog notice", () => {
    const onHistoryScopeChange = vi.fn();
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={vi.fn()} historyScope="head" onHistoryScopeChange={onHistoryScopeChange} truncated />);
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Base commit history" }), { target: { value: "all" } });
    expect(onHistoryScopeChange).toHaveBeenLastCalledWith("all");
    fireEvent.change(screen.getByRole("combobox", { name: "Base commit history" }), { target: { value: "revision:feature" } });
    expect(onHistoryScopeChange).toHaveBeenLastCalledWith("revision:feature");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "does not exist" } });
    expect(screen.getByRole("status").textContent).toBe("No revisions match this search.");
    expect(screen.getByText(/Showing a limited catalog/)).toBeTruthy();
  });
});
