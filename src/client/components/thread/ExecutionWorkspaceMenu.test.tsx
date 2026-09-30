// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import type { MenuPresentation } from "@client/components/ui/menu-sheet";
import {
  ExecutionWorkspaceDeleteDialog,
  type IsolatedWorkspace,
} from "./ExecutionWorkspaceActions.js";
import { ExecutionWorkspaceMenu } from "./ExecutionWorkspaceMenu.js";
import { dropdownMenuParts } from "./menu-parts.js";

// jsdom lacks the pointer-capture and scroll APIs the Radix menu primitives
// rely on.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  setClipboard(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClipboard(undefined);
});

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function workspace(
  overrides: Partial<IsolatedWorkspace> = {},
): IsolatedWorkspace {
  return {
    kind: "isolated",
    workspaceAccess: "writable_clone",
    state: "ready",
    allocationRevision: 1,
    networkProfile: "isolated",
    hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
    branch: "sedes/thread-1",
    gitStatus: { available: false, reason: "not inspected" },
    ...overrides,
  } as IsolatedWorkspace;
}

/**
 * The menu inside a real Thread actions DropdownMenu, with deletion handed
 * to the delete dialog the way the owning surfaces do.
 */
function OwningMenu({
  store,
  presentation = "menu",
  knownDirect = false,
}: {
  readonly store: ApplicationClientStore;
  readonly presentation?: MenuPresentation;
  readonly knownDirect?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState<IsolatedWorkspace>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <DropdownMenu
        presentation={presentation}
        open={open}
        onOpenChange={setOpen}
      >
        <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Thread actions">
          <ExecutionWorkspaceMenu
            parts={dropdownMenuParts}
            threadId="thread-1"
            store={store}
            active={open}
            knownDirect={knownDirect}
            onRequestDelete={(requested) => {
              setOpen(false);
              setTarget(requested);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ExecutionWorkspaceDeleteDialog
        workspace={target}
        open={target !== undefined}
        onOpenChange={(next) => {
          if (!next) setTarget(undefined);
        }}
        pending={pending}
        error={error}
        onDelete={() => {
          if (!target) return;
          setPending(true);
          void store
            .deleteThreadExecutionWorkspace("thread-1", target.allocationRevision)
            .then(() => setTarget(undefined))
            .catch((cause: Error) => setError(cause.message))
            .finally(() => setPending(false));
        }}
      />
    </>
  );
}

async function openWorkspaceMenu(): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Isolated workspace" }),
  );
  return await screen.findByRole("menu", { name: "Isolated workspace" });
}

function deletedResult(allocationRevision: number) {
  return {
    state: "deleted",
    allocationRevision,
    operationId: "10000000-0000-4000-8000-000000000001",
  };
}

describe("ExecutionWorkspaceMenu", () => {
  it("reports unavailable clipboard access and clears the pending copy", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(workspace()),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const menu = await openWorkspaceMenu();
    const copy = within(menu).getByRole("menuitem", {
      name: "Copy workspace path",
    });
    await userEvent.click(copy);

    // The submenu stays open with the failure beside the row.
    expect(await within(menu).findByRole("alert")).toHaveTextContent(
      "Clipboard access is unavailable.",
    );
    await waitFor(() => expect(copy).not.toHaveAttribute("data-disabled"));
    expect(menu).toBeVisible();
  });

  it("allows an incomplete workspace to be deleted after provisioning fails", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(
        workspace({
          state: "provisioning_failed",
          allocationRevision: 6,
          branch: null,
          gitStatus: {
            available: false,
            reason: "Provisioning failed before Git status became available.",
          },
        }),
      ),
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue(deletedResult(7)),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const menu = await openWorkspaceMenu();
    const deleteAction = within(menu).getByRole("menuitem", {
      name: "Delete isolated workspace…",
    });
    expect(deleteAction).not.toHaveAttribute("data-disabled");
    expect(within(menu).getByRole("alert")).toHaveTextContent(
      "Provisioning failed",
    );
    // Disabled rows show a short visual reason; the title carries the
    // full one and the accessible name stays the row's label.
    for (const name of ["Import branch", "Retain for outside use"]) {
      const row = within(menu).getByRole("menuitem", { name });
      expect(row).toHaveAttribute("data-disabled");
      expect(row).toHaveTextContent("Unavailable");
      expect(row).toHaveAttribute(
        "title",
        "Unavailable while the isolated workspace is not ready",
      );
    }
    await userEvent.click(deleteAction);
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(store.deleteThreadExecutionWorkspace).toHaveBeenCalledWith(
        "thread-1",
        6,
      ),
    );
  });

  it("deletes only the private home for a read-only source mount", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(
        workspace({
          workspaceAccess: "read_only",
          allocationRevision: 4,
          hostPaths: { home: "/sandbox/home", workspace: "/source/project" },
          branch: null,
          gitStatus: {
            available: false,
            reason: "Git branch safety checks do not apply to a read-only source mount.",
          },
        }),
      ),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const menu = await openWorkspaceMenu();
    expect(
      within(menu).getByRole("menuitem", { name: "Copy workspace path" }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Import branch" }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Retain for outside use" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Delete isolated workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete isolated workspace?",
    });
    expect(
      within(dialog).getByText(/private writable home at \/sandbox\/home/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /read-only project at \/source\/project is not deleted/,
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /original project is mounted read-only and will not be deleted/i,
      ),
    ).toBeVisible();
  });

  it("offers an explicit deletion retry after a failed deletion", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(
        workspace({
          state: "deletion_failed",
          allocationRevision: 11,
          gitStatus: { available: false, reason: "git status timed out" },
        }),
      ),
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue(deletedResult(12)),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const menu = await openWorkspaceMenu();
    const retry = within(menu).getByRole("menuitem", {
      name: "Retry deleting isolated workspace…",
    });
    expect(retry).not.toHaveAttribute("data-disabled");
    expect(within(menu).getByRole("alert")).toHaveTextContent(
      "The previous deletion failed",
    );
    await userEvent.click(retry);
    const dialog = await screen.findByRole("dialog", {
      name: "Delete isolated workspace?",
    });
    expect(
      within(dialog).getByText(/Git safety checks are unavailable/),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(store.deleteThreadExecutionWorkspace).toHaveBeenCalledWith(
        "thread-1",
        11,
      ),
    );
  });

  it("copies, imports, retains, and confirms deletion with Git warnings", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    setClipboard(clipboard);
    const isolated = workspace({
      allocationRevision: 8,
      gitStatus: {
        available: true,
        trackedChangeCount: 1,
        untrackedFileCount: 2,
        upstream: null,
        aheadCount: null,
      },
    });
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(isolated),
      importThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        branch: "sedes/thread-1",
        headOid: "a".repeat(40),
        sourceRepositoryPath: "/repo",
      }),
      handoffThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        state: "retained",
        allocationRevision: 9,
        workspacePath: "/sandbox/repo",
        branch: "sedes/thread-1",
      }),
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue(deletedResult(10)),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const menu = await openWorkspaceMenu();
    // Each result stays readable in the open submenu.
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Copy workspace path" }),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith("/sandbox/repo");
    expect(await within(menu).findByRole("status")).toHaveTextContent(
      "Workspace path copied.",
    );
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Import branch" }),
    );
    expect(store.importThreadExecutionWorkspace).toHaveBeenCalledWith(
      "thread-1",
      8,
    );
    await waitFor(() =>
      expect(within(menu).getByRole("status")).toHaveTextContent(
        "Imported sedes/thread-1 at aaaaaaaa into /repo.",
      ),
    );
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Retain for outside use" }),
    );
    expect(store.handoffThreadExecutionWorkspace).toHaveBeenCalledWith(
      "thread-1",
      8,
    );
    await waitFor(() =>
      expect(within(menu).getByRole("status")).toHaveTextContent(
        "Retained sedes/thread-1 at /sandbox/repo.",
      ),
    );
    // Retaining reloads the workspace state.
    expect(store.getThreadExecutionWorkspace).toHaveBeenCalledTimes(2);
    expect(menu).toBeVisible();

    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Delete isolated workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete isolated workspace?",
    });
    expect(
      within(dialog).getByText("1 tracked change is not committed."),
    ).toBeVisible();
    expect(
      within(dialog).getByText("2 untracked files will be deleted."),
    ).toBeVisible();
    expect(within(dialog).getByText(/No upstream is configured/)).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(store.deleteThreadExecutionWorkspace).toHaveBeenCalledWith(
        "thread-1",
        8,
      ),
    );
  });

  it("offers no workspace rows for a direct workspace or a known direct-only target", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue({ kind: "direct" }),
    } as unknown as ApplicationClientStore;
    const { unmount } = render(<OwningMenu store={store} />);
    await waitFor(() =>
      expect(store.getThreadExecutionWorkspace).toHaveBeenCalledWith("thread-1"),
    );
    expect(
      within(screen.getByRole("menu", { name: "Thread actions" })).queryAllByRole(
        "menuitem",
      ),
    ).toHaveLength(0);
    unmount();

    vi.mocked(store.getThreadExecutionWorkspace).mockClear();
    render(<OwningMenu store={store} knownDirect />);
    expect(screen.getByRole("menu", { name: "Thread actions" })).toBeVisible();
    expect(store.getThreadExecutionWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("offers a retry row when the workspace details cannot be loaded", async () => {
    const store = {
      getThreadExecutionWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new Error("Workspace service unavailable."))
        .mockResolvedValueOnce(workspace()),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} />);

    const retry = await screen.findByRole("menuitem", {
      name: /^Retry workspace details/,
    });
    expect(within(retry).getByRole("alert")).toHaveTextContent(
      "Workspace details unavailable. Workspace service unavailable.",
    );
    await userEvent.click(retry);
    // The menu stays open and the workspace submenu replaces the retry row.
    expect(
      await screen.findByRole("menuitem", { name: "Isolated workspace" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: /^Retry workspace details/ }),
    ).not.toBeInTheDocument();
    expect(store.getThreadExecutionWorkspace).toHaveBeenCalledTimes(2);
  });

  it("drills into the rows on the sheet and keeps the sheet open with the result", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    setClipboard(clipboard);
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue(workspace()),
    } as unknown as ApplicationClientStore;
    render(<OwningMenu store={store} presentation="sheet" />);

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Isolated workspace" }),
    );
    const copy = await screen.findByRole("menuitem", {
      name: "Copy workspace path",
    });
    await userEvent.click(copy);
    expect(clipboard.writeText).toHaveBeenCalledWith("/sandbox/repo");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Workspace path copied.",
    );
    expect(copy).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
