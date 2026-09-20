// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { ArchiveChoicesDialog } from "./ArchiveChoicesDialog.js";

afterEach(cleanup);

function makeThread(
  overrides: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    title: { text: "Review backend contract" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 2,
    pinned: false,
    pinRevision: 0,
    threadRevision: 4,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    available: true,
    lastActivityAt: "2026-07-30T15:00:00.000Z",
    stateChangedAt: "2026-07-30T15:00:00.000Z",
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
  } as NormalizedApplicationThreadSummary;
}

function emptyOpenTasks() {
  return {
    root: { items: [], total: 0, omitted: 0 },
    descendants: { items: [], total: 0, omitted: 0 },
  };
}

function makeStore(): ApplicationClientStore & {
  mutateInventory: ReturnType<typeof vi.fn>;
  archiveThreadFamily: ReturnType<typeof vi.fn>;
  getThreadArchiveImpact: ReturnType<typeof vi.fn>;
} {
  return {
    mutateInventory: vi.fn().mockResolvedValue(undefined),
    archiveThreadFamily: vi
      .fn()
      .mockResolvedValue(["thread-1", "thread-2", "thread-3"]),
    getThreadArchiveImpact: vi.fn().mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    }),
  } as unknown as ApplicationClientStore & {
    mutateInventory: ReturnType<typeof vi.fn>;
    archiveThreadFamily: ReturnType<typeof vi.fn>;
    getThreadArchiveImpact: ReturnType<typeof vi.fn>;
  };
}

describe("ArchiveChoicesDialog", () => {
  it("allows deleting failed provisioning but not active provisioning", async () => {
    const workspace = {
      kind: "isolated" as const,
      state: "provisioning" as const,
      allocationRevision: 4,
      networkProfile: "isolated" as const,
      hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
      branch: null,
      gitStatus: { available: false as const, reason: "Still provisioning." },
    };
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: workspace,
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const first = render(
      <ArchiveChoicesDialog
        open
        onOpenChange={() => undefined}
        thread={makeThread()}
        store={store}
        descendantCount={0}
      />,
    );

    expect(await screen.findByRole("radio", { name: "Delete" })).toBeDisabled();
    first.unmount();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: {
        ...workspace,
        state: "provisioning_failed",
        gitStatus: {
          available: false,
          reason: "Provisioning failed before Git status became available.",
        },
      },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={() => undefined}
        thread={makeThread()}
        store={store}
        descendantCount={0}
      />,
    );

    expect(await screen.findByRole("radio", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Provisioning failed");
  });

  it("keeps an isolated workspace by default and sends an explicit delete choice", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: {
        kind: "isolated",
        workspaceAccess: "writable_clone",
        state: "ready",
        allocationRevision: 7,
        networkProfile: "isolated",
        hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
        branch: "sedes/thread-1",
        gitStatus: {
          available: true,
          trackedChangeCount: 2,
          untrackedFileCount: 1,
          upstream: "origin/main",
          aheadCount: 3,
        },
      },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={() => undefined}
        thread={makeThread()}
        store={store}
        descendantCount={0}
      />,
    );

    const handling = await screen.findByRole("radiogroup", {
      name: "Isolated workspace handling",
    });
    expect(
      within(handling).getByRole("radio", { name: "Keep" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(
      within(handling).getByRole("radio", { name: "Delete" }),
    );
    expect(
      screen.getByText("2 tracked changes are not committed."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(store.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: {
          kind: "delete",
          expectedRevision: 7,
          operationId: expect.any(String),
        },
      },
    );
  });

  it("archives a single thread with single-thread wording", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    const onArchived = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={onOpenChange}
        thread={makeThread()}
        store={store}
        descendantCount={0}
        onArchived={onArchived}
      />,
    );

    const archiveOnly = await screen.findByRole("button", {
      name: "Archive",
    });
    const actions = archiveOnly.closest(".dialog-actions");
    expect(actions).not.toBeNull();
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(archiveOnly.querySelector("svg")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Archive thread and/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(archiveOnly).not.toBeDisabled());
    await userEvent.click(archiveOnly);

    expect(store.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onArchived).toHaveBeenCalledWith("only", ["thread-1"]);
  });

  it("hides the descendant choice when preflight finds only archived descendants", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 0,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );

    await screen.findByRole("button", { name: "Archive" });
    await waitFor(() =>
      expect(
        screen.queryByRole("checkbox", {
          name: "Archive child and descendant forks",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("archives the whole family when descendant archiving is selected", async () => {
    const store = makeStore();
    const onArchived = vi.fn();
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={2}
        onArchived={onArchived}
      />,
    );

    const archiveAll = await screen.findByRole("button", { name: "Archive" });
    const checkbox = screen.getByRole("checkbox", {
      name: "Archive child and descendant forks",
    });
    expect(checkbox).not.toBeChecked();
    expect(store.getThreadArchiveImpact).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(archiveAll).not.toBeDisabled());
    await userEvent.click(checkbox);
    await userEvent.click(archiveAll);

    expect(store.archiveThreadFamily).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
    await waitFor(() =>
      expect(onArchived).toHaveBeenCalledWith("all", [
        "thread-1",
        "thread-2",
        "thread-3",
      ]),
    );
  });

  it("archives only the thread by default when descendants exist", async () => {
    const store = makeStore();
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "Archive child and descendant forks",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled(),
    );
    expect(checkbox).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(store.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      {
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
    expect(store.archiveThreadFamily).not.toHaveBeenCalled();
  });

  it("updates the stash warning and confirmed count with the descendant choice", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 2, descendants: 3 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );

    expect(await screen.findByText("2 stashed prompts")).toBeVisible();
    expect(
      screen.getByText(/remain attached to the archived thread/),
    ).toBeVisible();

    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );

    expect(
      screen.getByText("5 stashed prompts, including 3 on descendants"),
    ).toBeVisible();
    expect(
      screen.getByText(/remain attached to the archived threads/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(store.archiveThreadFamily).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      {
        expectedStashedPromptCount: 5,
        executionWorkspaceDisposition: { kind: "keep" },
      },
    );
  });

  it("shows bounded duplicate task summaries and updates the set with the descendant choice", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact.mockResolvedValue({
      descendantCount: 2,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: {
        root: {
          items: [
            {
              id: "task-root-1",
              title: "Duplicate task",
              threadId: "thread-1",
            },
            {
              id: "task-root-2",
              title: "Duplicate task",
              threadId: "thread-1",
            },
          ],
          total: 3,
          omitted: 1,
        },
        descendants: {
          items: [
            {
              id: "task-child-1",
              title: "Descendant task",
              threadId: "thread-2",
            },
          ],
          total: 2,
          omitted: 1,
        },
      },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );

    const rootTasks = await screen.findByRole("region", {
      name: "3 open tasks affected by this archive",
    });
    expect(within(rootTasks).getAllByText("Duplicate task")).toHaveLength(2);
    expect(within(rootTasks).getByText("1 more task not shown")).toBeVisible();
    expect(screen.queryByText("Descendant task")).not.toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: "Archive child and descendant forks",
      }),
    );

    const familyTasks = screen.getByRole("region", {
      name: "5 open tasks affected by this archive",
    });
    expect(within(familyTasks).getAllByText("Duplicate task")).toHaveLength(2);
    expect(within(familyTasks).getByText("Descendant task")).toBeVisible();
    expect(within(familyTasks).getByText("Thread thread-2")).toBeVisible();
    expect(
      within(familyTasks).getByText("2 more tasks not shown"),
    ).toBeVisible();
  });

  it("shows only progress until the impact check completes and ignores passive dismissal", async () => {
    const store = makeStore();
    const impact = await store.getThreadArchiveImpact("thread-1");
    let resolve!: (value: typeof impact) => void;
    store.getThreadArchiveImpact.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={onOpenChange}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );
    expect(screen.getByText("Checking thread activity…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("dialog-overlay"));
    expect(onOpenChange).not.toHaveBeenCalled();
    resolve(impact);
    expect(
      await screen.findByRole("button", { name: "Archive" }),
    ).toBeEnabled();
    expect(screen.queryByText("Checking thread activity…")).toBeNull();
    expect(screen.getByRole("checkbox")).toBeVisible();
  });

  it("starts a fresh check after cancel and ignores the previous opening's response", async () => {
    const store = makeStore();
    const impact = await store.getThreadArchiveImpact("thread-1");
    let resolveOld!: (value: typeof impact) => void;
    let resolveNew!: (value: typeof impact) => void;
    store.getThreadArchiveImpact
      .mockReturnValueOnce(
        new Promise((done) => {
          resolveOld = done;
        }),
      )
      .mockReturnValueOnce(
        new Promise((done) => {
          resolveNew = done;
        }),
      );
    const props = {
      onOpenChange: vi.fn(),
      thread: makeThread(),
      store,
      descendantCount: 0,
    };
    const view = render(<ArchiveChoicesDialog {...props} open />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    view.rerender(<ArchiveChoicesDialog {...props} open={false} />);
    view.rerender(<ArchiveChoicesDialog {...props} open />);
    resolveOld(impact);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    resolveNew({ ...impact, descendantCount: 0 });
    expect(
      await screen.findByRole("button", { name: "Archive" }),
    ).toBeEnabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("surfaces a mutation error and retries the activity check", async () => {
    const store = makeStore();
    store.getThreadArchiveImpact
      .mockResolvedValueOnce({
        descendantCount: 0,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 1, descendants: 0 },
        openTasks: emptyOpenTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      })
      .mockResolvedValueOnce({
        descendantCount: 0,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 2, descendants: 0 },
        openTasks: emptyOpenTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      })
      .mockResolvedValue({
        descendantCount: 0,
        pendingQuestions: { root: 0, descendants: 0 },
        stashedPrompts: { root: 2, descendants: 0 },
        openTasks: emptyOpenTasks(),
        executionWorkspace: { kind: "direct" },
        archiveOnly: { available: true },
        archiveAll: { available: true },
      });
    store.mutateInventory.mockRejectedValueOnce(new Error("Revision conflict"));
    render(
      <ArchiveChoicesDialog
        open
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={store}
        descendantCount={0}
      />,
    );

    const archiveOnly = await screen.findByRole("button", { name: "Archive" });
    await waitFor(() => expect(archiveOnly).not.toBeDisabled());
    await userEvent.click(archiveOnly);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict",
    );
    expect(screen.getByText("2 stashed prompts")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    // The failed mutation already refreshed the impact once (open load +
    // post-error refresh), so Retry performs the third read.
    await waitFor(() =>
      expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2),
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(3),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });
});
