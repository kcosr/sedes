// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import {
  ExecutionWorkspaceActions,
  ExecutionWorkspaceDeleteDialog,
  ExecutionWorkspaceGitWarnings,
} from "./ExecutionWorkspaceActions.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("ExecutionWorkspaceActions", () => {
  it("returns focus to the owning surface after deletion is cancelled", async () => {
    function DeleteDialogHarness() {
      const [open, setOpen] = useState(true);
      const returnFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={returnFocusRef}>Thread actions</button>
          <ExecutionWorkspaceDeleteDialog
            workspace={{
              kind: "isolated",
              workspaceAccess: "writable_clone",
              state: "ready",
              allocationRevision: 1,
              networkProfile: "isolated",
              hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
              branch: "sedes/thread-1",
              gitStatus: { available: false, reason: "not inspected" },
            }}
            open={open}
            onOpenChange={setOpen}
            pending={false}
            onDelete={() => undefined}
            returnFocusRef={returnFocusRef}
          />
        </>
      );
    }

    render(<DeleteDialogHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Thread actions" }),
      ).toHaveFocus(),
    );
  });

  it("reports unavailable clipboard access and clears the pending copy", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        kind: "isolated",
        workspaceAccess: "writable_clone",
        state: "ready",
        allocationRevision: 1,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
        branch: "sedes/thread-1",
        gitStatus: { available: false, reason: "not inspected" },
      }),
    } as unknown as ApplicationClientStore;
    render(
      <ExecutionWorkspaceActions threadId="thread-1" store={store} active />,
    );

    const copy = await screen.findByRole("button", {
      name: "Copy workspace path",
    });
    await userEvent.click(copy);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Clipboard access is unavailable.",
    );
    await waitFor(() => expect(copy).toBeEnabled());
  });

  it("allows an incomplete workspace to be deleted after provisioning fails", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        kind: "isolated",
        workspaceAccess: "writable_clone",
        state: "provisioning_failed",
        allocationRevision: 6,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
        branch: null,
        gitStatus: {
          available: false,
          reason: "Provisioning failed before Git status became available.",
        },
      }),
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        state: "deleted",
        allocationRevision: 7,
        operationId: "10000000-0000-4000-8000-000000000001",
      }),
    } as unknown as ApplicationClientStore;
    render(
      <ExecutionWorkspaceActions threadId="thread-1" store={store} active />,
    );

    const deleteAction = await screen.findByRole("button", {
      name: "Delete isolated workspace…",
    });
    expect(deleteAction).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Provisioning failed");
    expect(
      screen.getByRole("button", { name: "Import branch" }),
    ).toBeDisabled();
    await userEvent.click(deleteAction);
    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(store.deleteThreadExecutionWorkspace).toHaveBeenCalledWith(
        "thread-1",
        6,
      ),
    );
  });

  it("never presents a clean no-upstream branch as verified safe to delete", () => {
    render(
      <ExecutionWorkspaceGitWarnings
        workspace={{
          kind: "isolated",
          workspaceAccess: "writable_clone",
          state: "ready",
          allocationRevision: 1,
          networkProfile: "isolated",
          hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
          branch: "sedes/thread-1",
          gitStatus: {
            available: true,
            trackedChangeCount: 0,
            untrackedFileCount: 0,
            upstream: null,
            aheadCount: null,
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "No upstream is configured; unpushed work cannot be verified.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Git reports no local or unpushed work."),
    ).not.toBeInTheDocument();
  });

  it("deletes only the private home for a read-only source mount", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        kind: "isolated",
        workspaceAccess: "read_only",
        state: "ready",
        allocationRevision: 4,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox/home", workspace: "/source/project" },
        branch: null,
        gitStatus: {
          available: false,
          reason: "Git branch safety checks do not apply to a read-only source mount.",
        },
      }),
    } as unknown as ApplicationClientStore;
    render(
      <ExecutionWorkspaceActions threadId="thread-1" store={store} active />,
    );

    await screen.findByRole("button", { name: "Copy workspace path" });
    expect(
      screen.queryByRole("button", { name: "Import branch" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retain for outside use" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete isolated workspace…" }),
    );
    expect(
      screen.getByText(/private writable home at \/sandbox\/home/),
    ).toBeVisible();
    expect(
      screen.getByText(/read-only project at \/source\/project is not deleted/),
    ).toBeVisible();
    expect(
      screen.getByText(/original project is mounted read-only and will not be deleted/i),
    ).toBeVisible();
  });

  it("offers an explicit deletion retry after a failed deletion", async () => {
    const store = {
      getThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        kind: "isolated",
        workspaceAccess: "writable_clone",
        state: "deletion_failed",
        allocationRevision: 11,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
        branch: "sedes/thread-1",
        gitStatus: { available: false, reason: "git status timed out" },
      }),
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        state: "deleted",
        allocationRevision: 12,
        operationId: "10000000-0000-4000-8000-000000000001",
      }),
    } as unknown as ApplicationClientStore;
    render(
      <ExecutionWorkspaceActions threadId="thread-1" store={store} active />,
    );

    const retry = await screen.findByRole("button", {
      name: "Retry deleting isolated workspace…",
    });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The previous deletion failed",
    );
    await userEvent.click(retry);
    expect(screen.getByText(/Git safety checks are unavailable/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
    const isolated = {
      kind: "isolated" as const,
      workspaceAccess: "writable_clone" as const,
      state: "ready" as const,
      allocationRevision: 8,
      networkProfile: "isolated" as const,
      hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
      branch: "sedes/thread-1",
      gitStatus: {
        available: true as const,
        trackedChangeCount: 1,
        untrackedFileCount: 2,
        upstream: null,
        aheadCount: null,
      },
    };
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
      deleteThreadExecutionWorkspace: vi.fn().mockResolvedValue({
        state: "deleted",
        allocationRevision: 10,
        operationId: "10000000-0000-4000-8000-000000000001",
      }),
    } as unknown as ApplicationClientStore;
    render(
      <ExecutionWorkspaceActions threadId="thread-1" store={store} active />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Copy workspace path" }),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith("/sandbox/repo");
    await userEvent.click(
      screen.getByRole("button", { name: "Import branch" }),
    );
    expect(store.importThreadExecutionWorkspace).toHaveBeenCalledWith(
      "thread-1",
      8,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retain for outside use" }),
    );
    expect(store.handoffThreadExecutionWorkspace).toHaveBeenCalledWith(
      "thread-1",
      8,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete isolated workspace…" }),
    );
    expect(
      screen.getByText("1 tracked change is not committed."),
    ).toBeVisible();
    expect(
      screen.getByText("2 untracked files will be deleted."),
    ).toBeVisible();
    expect(screen.getByText(/No upstream is configured/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(store.deleteThreadExecutionWorkspace).toHaveBeenCalledWith(
        "thread-1",
        8,
      ),
    );
  });
});
