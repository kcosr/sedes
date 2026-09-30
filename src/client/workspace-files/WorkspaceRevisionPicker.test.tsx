// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDiffRevisionDescriptor } from "../../shared/protocol/workspace-diffs.js";
import { WorkspaceRevisionPicker } from "./WorkspaceRevisionPicker.js";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const revisions = [
  { revisionId: "main", kind: "local_branch", label: "main", commitHash: "a".repeat(40), shortHash: "aaaaaaa" },
  { revisionId: "feature", kind: "local_branch", label: "feature/layout", commitHash: "b".repeat(40), shortHash: "bbbbbbb", isCurrentBranch: true },
  { revisionId: "old", kind: "commit", label: "ccccccc", commitHash: "c".repeat(40), shortHash: "ccccccc", summary: "Old change", committedAt: "2026-09-19T11:00:00.000Z" },
  { revisionId: "new", kind: "commit", label: "ddddddd", commitHash: "d".repeat(40), shortHash: "ddddddd", summary: "Restore file reading position", committedAt: "2026-09-20T14:32:00.000Z" },
] as WorkspaceDiffRevisionDescriptor[];
const formatted = (date: string) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));

function trigger() { return screen.getByRole("combobox", { name: "Base revision" }); }
function open() { fireEvent.click(trigger()); }

describe("WorkspaceRevisionPicker", () => {
  it("groups sources, prioritizes the current branch, and shows messages and dates newest first", () => {
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={vi.fn()} />);
    // The Field label names the endpoint; the trigger is the shared picker.
    expect(screen.getByText("Base", { selector: "label" })).toHaveAttribute("for", trigger().id);
    open();
    const dialog = screen.getByRole("dialog", { name: "Choose base revision" });
    expect(within(dialog).getAllByRole("group").map((group) => group.getAttribute("aria-labelledby") && document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent))
      .toEqual(["Workspace", "Local branches", "Commits · newest first"]);
    const branches = within(screen.getByRole("group", { name: "Local branches" })).getAllByRole("option");
    expect(branches[0]!.textContent).toContain("feature/layout");
    expect(branches[0]!.textContent).toContain("Current · bbbbbbb");
    expect(branches[1]!.textContent).not.toContain("Current");
    const commits = within(screen.getByRole("group", { name: "Commits · newest first" })).getAllByRole("option");
    expect(commits[0]!.textContent).toContain("Restore file reading position");
    expect(commits[0]!.textContent).toContain(`${formatted("2026-09-20T14:32:00.000Z")} · ddddddd`);
    expect(commits[0]!.textContent?.match(/ddddddd/gu)).toHaveLength(1);
    expect(commits[1]!.textContent).toContain("Old change");
    expect(screen.getByRole("option", { name: /Staged changes/ })).toBeTruthy();
    // Every row carries an icon so the labels align.
    for (const option of screen.getAllByRole("option")) expect(option.querySelector("svg")).not.toBeNull();
  });

  it("searches messages and full hashes, selects an opaque revision by keyboard, and restores trigger focus", async () => {
    const onChange = vi.fn();
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={onChange} />);
    open();
    const search = screen.getByRole("combobox", { name: "Search base revisions" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "reading position" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option").id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ kind: "revision", revisionId: "new" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger()).toHaveFocus());
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Search base revisions" }), { target: { value: "c".repeat(40) } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Old change");
  });

  it("marks the selection with a trailing check and shows it on the trigger", () => {
    render(<WorkspaceRevisionPicker label="Base" selection={{ kind: "revision", revisionId: revisions[3]!.revisionId }} revisions={revisions} onChange={vi.fn()} />);
    expect(trigger()).toHaveTextContent("Restore file reading position · ddddddd");
    open();
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.textContent).toContain("Restore file reading position");
    expect(selected.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1);
  });

  it("reports loading, empty results and the bounded catalog notice", () => {
    render(<WorkspaceRevisionPicker label="Base" revisions={revisions} onChange={vi.fn()} loading truncated />);
    open();
    expect(screen.getByRole("status")).toHaveTextContent("Loading revisions…");
    expect(screen.getByText(/Showing a limited catalog/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Search base revisions" }), { target: { value: "does not exist" } });
    expect(screen.getAllByRole("status").map((status) => status.textContent)).toEqual(
      ["No revisions match this search.", "Loading revisions…"],
    );
  });
});
