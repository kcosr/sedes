// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationThreadSummary,
  WorkspaceFileRootDescriptor,
} from "../../../shared/index.js";
import { workspaceFileLinkedWorktreeRootIdSchema } from "../../../shared/index.js";
import { ThreadWorktreePicker } from "./ThreadWorktreePicker.js";

const primary = {
  kind: "primary",
  rootId: "primary",
  displayLabel: "Primary",
  displayPath: { text: "/work/sedes" },
  availability: "available",
  watchable: true,
  sortOrder: 0,
  revision: 0,
} as const satisfies WorkspaceFileRootDescriptor;

function linked({
  id,
  branch,
  provenance = "unmerged",
  availability = "available",
  removalStatus = availability === "available" ? "allowed" : "forget",
  ahead = 2,
  behind = 3,
}: {
  id: string;
  branch: string;
  provenance?: "same" | "contained" | "unmerged" | "unknown";
  availability?: "available" | "unavailable";
  removalStatus?: "allowed" | "forget" | "unavailable";
  ahead?: number | null;
  behind?: number | null;
}): WorkspaceFileRootDescriptor {
  const common = {
    kind: "linked_worktree" as const,
    rootId: id,
    branch,
    head: "a".repeat(40),
    displayLabel: branch,
    displayPath: { text: `/work/${branch.replaceAll("/", "-")}` },
    sortOrder: 1,
    revision: 4,
    provenance: { kind: provenance, ahead, behind },
    removal:
      removalStatus === "allowed"
        ? {
            status: "allowed" as const,
            displayPath: { text: `/checkout/${branch.replaceAll("/", "-")}` },
          }
        : { status: removalStatus },
  };
  return availability === "available"
    ? { ...common, availability, watchable: true }
    : {
        ...common,
        availability,
        watchable: false,
        diagnosticCode: "workspace_file_root_missing",
      };
}

function thread(
  overrides: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    ...overrides,
  } as unknown as NormalizedApplicationThreadSummary;
}

function fixture(roots: readonly WorkspaceFileRootDescriptor[]) {
  const api = {
    listWorkspaceFileRoots: vi.fn(async () => ({ roots })),
    updateThreadPreferredWorktree: vi.fn(async (_threadId, request) => ({
      preference: {
        rootId: request.rootId,
        revision: request.expectedRevision + 1,
      },
    })),
    deleteLinkedWorktree: vi.fn(async (_workspaceId, rootId) => ({
      rootId,
      outcome: "removed" as const,
      clearedThreadIds: [],
    })),
  };
  return api;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "mutation-1") });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadWorktreePicker", () => {
  it.each([false, true])("opens the mobile picker for browsing, with keyboard search override %s", async (keyboard) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    render(<ThreadWorktreePicker api={fixture([primary]) as never} thread={thread()} workspaceId="workspace-1" />);
    const trigger = screen.getByRole("button", { name: "Thread worktree: Primary" });
    if (keyboard) fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Thread worktree" });
    const search = within(dialog).getByRole("searchbox", { name: "Search worktrees" });
    await waitFor(() => expect(keyboard ? search : dialog).toHaveFocus());
    search.focus();
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--thread-settings-keyboard-inset")).toBe("300px");
    fireEvent.change(search, { target: { value: "absent" } });
    expect(search).toHaveFocus();
    await screen.findByText("No matching worktrees.");
  });

  it("returns focus to the desktop trigger after dismissing removal confirmation", async () => {
    const worktree = linked({ id: "linked-1", branch: "feature/desktop" });
    const api = fixture([primary, worktree]);
    render(<ThreadWorktreePicker api={api as never} thread={thread()} workspaceId="workspace-1" />);
    const trigger = screen.getByRole("button", { name: "Thread worktree: Primary" });
    fireEvent.click(trigger);
    const remove = await screen.findByRole("button", { name: "Remove feature/desktop" });
    remove.focus();
    fireEvent.click(remove);
    const confirmation = await screen.findByRole("dialog", { name: "Remove linked worktree?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.deleteLinkedWorktree).not.toHaveBeenCalled();
  });
  it("closes the mobile bottom card before confirming worktree removal", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          query.includes("pointer: coarse") ||
          query.includes("max-width: 819px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const worktree = linked({ id: "linked-1", branch: "feature/mobile" });
    const api = fixture([primary, worktree]);
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );

    const sheet = await screen.findByRole("dialog", {
      name: "Thread worktree",
    });
    expect(sheet).toHaveClass("thread-settings-sheet", "thread-worktree-sheet");
    expect(within(sheet).getByRole("list", { name: "Worktrees" })).toBeVisible();
    expect(document.querySelector(".thread-worktree-popover")).toBeNull();
    fireEvent.click(
      await within(sheet).findByRole("button", { name: "Remove feature/mobile" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Remove linked worktree?",
    });
    expect(document.querySelector(".thread-settings-sheet")).toBeNull();
    expect(document.querySelector(".thread-settings-sheet-overlay")).toBeNull();
    expect(api.deleteLinkedWorktree).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(api.deleteLinkedWorktree).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Thread worktree: Primary" })).toHaveFocus());

    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove feature/mobile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    await waitFor(() => expect(api.deleteLinkedWorktree).toHaveBeenCalledWith(
      "workspace-1", "linked-1",
      { expectedRevision: 4, mutationId: "mutation-1", confirmation: true },
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Thread worktree: Primary" })).toHaveFocus());
  });

  it("uses cached thread presentation without discovering until opened", async () => {
    const api = fixture([primary]);
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread({
          preferredWorktree: {
            rootId: workspaceFileLinkedWorktreeRootIdSchema.parse("linked-1"),
            displayLabel: "feature/worktrees",
            branch: "feature/worktrees",
            availability: "available",
          },
        })}
        workspaceId="workspace-1"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Thread worktree: feature/worktrees",
    });
    expect(trigger).toBeVisible();
    expect(trigger).toHaveAttribute(
      "title",
      "Change thread worktree (feature/worktrees)",
    );
    expect(trigger.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(api.listWorkspaceFileRoots).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Thread worktree: feature/worktrees",
      }),
    );
    await waitFor(() =>
      expect(api.listWorkspaceFileRoots).toHaveBeenCalledOnce(),
    );
  });

  it("searches and presents calm provenance labels while keeping counts in titles", async () => {
    const merged = linked({
      id: "merged",
      branch: "feature/merged",
      provenance: "contained",
      ahead: 0,
      behind: 5,
    });
    const unmerged = linked({
      id: "unmerged",
      branch: "feature/unmerged",
      ahead: 4,
      behind: 2,
    });
    const missing = linked({
      id: "missing",
      branch: "feature/missing",
      availability: "unavailable",
      provenance: "unknown",
      ahead: null,
      behind: null,
    });
    const api = fixture([primary, merged, unmerged, missing]);
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );

    const picker = await screen.findByRole("list", { name: "Worktrees" });
    expect(within(picker).getByText("Merged")).toBeVisible();
    expect(within(picker).getByText("Unmerged")).toBeVisible();
    expect(within(picker).getByText("Missing")).toBeVisible();
    expect(picker).not.toHaveTextContent("4 ahead");
    expect(
      within(picker).getByRole("button", { name: "Select feature/unmerged" }),
    ).toHaveAttribute("title", "Compared with Primary: 4 ahead, 2 behind");
    expect(
      within(picker).getByRole("button", { name: "Select feature/unmerged" }),
    ).toHaveAccessibleDescription("/work/feature-unmerged Unmerged");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search worktrees" }),
      {
        target: { value: "merged" },
      },
    );
    expect(within(picker).getByText("feature/merged")).toBeVisible();
    expect(within(picker).queryByText("feature/missing")).toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search worktrees" }),
      { target: { value: "primary" } },
    );
    expect(
      within(picker).getByRole("button", { name: "Select Primary" }),
    ).toBeVisible();
  });

  it("selects a linked worktree and clears back to Primary", async () => {
    const worktree = linked({ id: "linked-1", branch: "feature/worktrees" });
    const api = fixture([primary, worktree]);
    const { rerender } = render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select feature/worktrees" }),
    );
    expect(api.updateThreadPreferredWorktree).toHaveBeenCalledWith("thread-1", {
      rootId: "linked-1",
      expectedRevision: 0,
      mutationId: "mutation-1",
    });

    rerender(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread({
          preferredWorktreeRevision: 1,
          preferredWorktree: {
            rootId: workspaceFileLinkedWorktreeRootIdSchema.parse("linked-1"),
            displayLabel: "feature/worktrees",
            branch: "feature/worktrees",
            availability: "available",
          },
        })}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Thread worktree: feature/worktrees",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select Primary" }),
    );
    expect(api.updateThreadPreferredWorktree).toHaveBeenLastCalledWith(
      "thread-1",
      {
        rootId: null,
        expectedRevision: 1,
        mutationId: "mutation-1",
      },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Thread worktree: Primary" }),
      ).toBeVisible(),
    );
  });

  it("accepts a newer published preference over an optimistic selection", async () => {
    const worktree = linked({ id: "linked-1", branch: "feature/worktrees" });
    const api = fixture([primary, worktree]);
    const { rerender } = render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select feature/worktrees" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Thread worktree: feature/worktrees",
      }),
    ).toBeVisible();

    rerender(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread({ preferredWorktreeRevision: 2 })}
        workspaceId="workspace-1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Thread worktree: Primary" }),
      ).toBeVisible(),
    );
  });

  it("offers retry without showing an empty state when discovery fails", async () => {
    const api = fixture([primary]);
    api.listWorkspaceFileRoots.mockRejectedValueOnce(
      new Error("Worktrees could not be refreshed."),
    );
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Worktrees could not be refreshed.");
    expect(screen.queryByText("No linked worktrees.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Select Primary" }),
    ).toBeVisible();
    expect(api.listWorkspaceFileRoots).toHaveBeenCalledTimes(2);
  });

  it("confirms remove and forget operations and keeps failures actionable", async () => {
    const available = linked({ id: "linked-1", branch: "feature/clean" });
    const missing = linked({
      id: "linked-2",
      branch: "feature/missing",
      availability: "unavailable",
    });
    const api = fixture([primary, available, missing]);
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove feature/clean" }),
    );
    const removeDialog = screen.getByRole("dialog", {
      name: "Remove linked worktree?",
    });
    expect(removeDialog).toHaveTextContent("branch and commits are kept");
    expect(removeDialog).toHaveTextContent("/checkout/feature-clean");
    api.deleteLinkedWorktree.mockRejectedValueOnce(
      new Error("Worktree has local changes."),
    );
    fireEvent.click(
      within(removeDialog).getByRole("button", { name: "Remove worktree" }),
    );
    expect(await within(removeDialog).findByRole("alert")).toHaveTextContent(
      "Worktree has local changes.",
    );
    fireEvent.click(
      within(removeDialog).getByRole("button", { name: "Cancel" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Forget feature/missing" }),
    );
    const forgetDialog = screen.getByRole("dialog", {
      name: "Forget missing worktree?",
    });
    fireEvent.click(
      within(forgetDialog).getByRole("button", { name: "Forget worktree" }),
    );
    await waitFor(() =>
      expect(api.deleteLinkedWorktree).toHaveBeenLastCalledWith(
        "workspace-1",
        "linked-2",
        {
          expectedRevision: 4,
          mutationId: "mutation-1",
          confirmation: true,
        },
      ),
    );
  });

  it("keeps transiently unavailable worktrees nondestructive", async () => {
    const unavailableRemoval = linked({
      id: "linked-1",
      branch: "feature/external",
      availability: "unavailable",
      removalStatus: "unavailable",
    });
    const api = fixture([primary, unavailableRemoval]);
    render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Select feature/external" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Remove feature/external" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Forget feature/external" }),
    ).toBeNull();
  });

  it("keeps preference conflicts visible and resets discovery for another thread", async () => {
    const worktree = linked({ id: "linked-1", branch: "feature/worktrees" });
    const api = fixture([primary, worktree]);
    api.updateThreadPreferredWorktree.mockRejectedValueOnce(
      new Error("The thread worktree changed. Refresh and try again."),
    );
    const { rerender } = render(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread()}
        workspaceId="workspace-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select feature/worktrees" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The thread worktree changed.",
    );

    rerender(
      <ThreadWorktreePicker
        api={api as never}
        thread={thread({ id: "thread-2" })}
        workspaceId="workspace-1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Worktrees" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Thread worktree: Primary" }),
    ).toBeVisible();
  });
});
