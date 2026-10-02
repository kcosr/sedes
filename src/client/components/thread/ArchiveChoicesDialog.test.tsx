// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { ThreadArchiveOperationHost } from "../../operations/ThreadArchiveOperationHost.js";
import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
import { getBlockingOperation } from "../../operations/blocking-operation.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import {
  ArchiveChoicesDialog,
  useArchiveChoicesOpen,
  useArchiveThreadAction,
} from "./ArchiveChoicesDialog.js";

afterEach(() => {
  getBlockingOperation()?.dismiss();
  cleanup();
});

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
    familySnapshot: "b".repeat(64),
    root: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
    descendants: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
  };
}

function makeStore(): ApplicationClientStore & {
  mutateInventory: ReturnType<typeof vi.fn>;
  archiveThreadFamily: ReturnType<typeof vi.fn>;
  getThreadArchiveImpact: ReturnType<typeof vi.fn>;
} {
  const state = { connection: "connected", authoritative: true, snapshot: { threads: [] } };
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
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
  render(<ThreadArchiveOperationHost store={store} />);
  return store;
}

/** The dialog as the archive action opens it: with the impact its check found. */
async function renderChoices(
  store: ReturnType<typeof makeStore>,
  props: Omit<
    Partial<React.ComponentProps<typeof ArchiveChoicesDialog>>,
    "initialImpact"
  > & { readonly descendantCount: number },
) {
  const initialImpact = await store.getThreadArchiveImpact("thread-1");
  return render(
    <ArchiveChoicesDialog
      onOpenChange={vi.fn()}
      thread={makeThread()}
      store={store}
      initialImpact={initialImpact}
      {...props}
    />,
  );
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
    const first = await renderChoices(store, { descendantCount: 0 });

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
    await renderChoices(store, { descendantCount: 0 });

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
    await renderChoices(store, { descendantCount: 0 });

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
    await renderChoices(store, { onOpenChange, descendantCount: 0, onArchived });

    const archiveOnly = await screen.findByRole("button", {
      name: "Archive",
    });
    const actions = archiveOnly.closest('[data-slot="dialog-footer"]');
    expect(actions).not.toBeNull();
    expect(
      [...actions!.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Cancel", "Archive"]);
    // Archiving is reversible: a neutral primary, not the destructive style.
    expect(archiveOnly).toHaveAttribute("data-variant", "default");
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
    await renderChoices(store, { descendantCount: 2 });

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
    await renderChoices(store, { descendantCount: 2, onArchived });

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
    await renderChoices(store, { descendantCount: 2 });

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
    await renderChoices(store, { descendantCount: 2 });

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
        familySnapshot: "b".repeat(64),
        root: {
          snapshot: "a".repeat(64),
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
          snapshot: "a".repeat(64),
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
    await renderChoices(store, { descendantCount: 2 });

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
    await renderChoices(store, { descendantCount: 0 });

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
  it.each([false, true])(
    "completes the selected archive scope (include descendants: %s)",
    async (includeDescendants) => {
      const store = makeStore();
      const initial = await store.getThreadArchiveImpact("thread-1");
      const root = {
        snapshot: "c".repeat(64),
        items: [{ id: "task-root", title: "Root task", threadId: "thread-1" }],
        total: 1,
        omitted: 0,
      };
      const descendants = {
        snapshot: "d".repeat(64),
        items: [{ id: "task-child", title: "Child task", threadId: "thread-2" }],
        total: 1,
        omitted: 0,
      };
      store.getThreadArchiveImpact.mockResolvedValue({
        ...initial,
        openTasks: { root, descendants, familySnapshot: "e".repeat(64) },
      });
      await renderChoices(store, { descendantCount: 2 });
      await screen.findByText("Root task");
      if (includeDescendants) {
        await userEvent.click(
          screen.getByRole("checkbox", {
            name: "Archive child and descendant forks",
          }),
        );
        expect(screen.getByText("Child task")).toBeVisible();
      } else {
        expect(screen.queryByText("Child task")).not.toBeInTheDocument();
      }
      await userEvent.click(screen.getByRole("radio", { name: "Complete all" }));
      await userEvent.click(screen.getByRole("button", { name: "Archive" }));
      const confirmation = {
        expectedStashedPromptCount: 0,
        openTaskDisposition: "complete",
        expectedOpenTaskSnapshot: (includeDescendants ? "e" : "c").repeat(64),
        executionWorkspaceDisposition: { kind: "keep" },
      };
      if (includeDescendants) {
        expect(store.archiveThreadFamily).toHaveBeenCalledWith(
          makeThread(),
          confirmation,
        );
        expect(store.mutateInventory).not.toHaveBeenCalled();
      } else {
        expect(store.mutateInventory).toHaveBeenCalledWith(
          makeThread(),
          "archive",
          confirmation,
        );
        expect(store.archiveThreadFamily).not.toHaveBeenCalled();
      }
    },
  );

  it("refreshes an archive completion conflict before the next confirmation", async () => {
    const store = makeStore();
    const initial = await store.getThreadArchiveImpact("thread-1");
    const taskImpact = (snapshot: string, title: string) => ({
      ...initial,
      openTasks: {
        ...emptyOpenTasks(),
        root: {
          snapshot,
          items: [{ id: "task-root", title, threadId: "thread-1" }],
          total: 1,
          omitted: 0,
        },
      },
    });
    store.getThreadArchiveImpact
      .mockResolvedValueOnce(taskImpact("c".repeat(64), "Old task title"))
      .mockResolvedValueOnce(taskImpact("d".repeat(64), "New task title"));
    store.mutateInventory.mockRejectedValueOnce(new Error("Open tasks changed."));
    await renderChoices(store, { descendantCount: 2 });
    await screen.findByText("Old task title");
    await userEvent.click(screen.getByRole("radio", { name: "Complete all" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("New task title")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Open tasks changed.");
    expect(store.mutateInventory).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(store.mutateInventory).toHaveBeenLastCalledWith(
      makeThread(),
      "archive",
      expect.objectContaining({
        openTaskDisposition: "complete",
        expectedOpenTaskSnapshot: "d".repeat(64),
      }),
    );
  });
});

describe("ArchiveChoicesDialog as a form dialog", () => {
  const impact = {
    descendantCount: 2,
    pendingQuestions: { root: 0, descendants: 0 },
    stashedPrompts: { root: 0, descendants: 0 },
    openTasks: emptyOpenTasks(),
    executionWorkspace: { kind: "direct" as const },
    archiveOnly: { available: true as const },
    archiveAll: { available: true as const },
  };

  it("opens as a medium card with focus on the first choice and the X last", async () => {
    render(
      <ArchiveChoicesDialog
        initialImpact={impact}
        onOpenChange={vi.fn()}
        thread={makeThread()}
        store={makeStore()}
        descendantCount={2}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Archive this thread" });
    expect(dialog).toHaveAttribute("data-size", "md");
    expect(dialog).toHaveAttribute("data-layout", "modal");
    expect(dialog).not.toHaveAttribute("data-blocking-operation");
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Archive child and descendant forks" }),
      ).toHaveFocus(),
    );
    const footer = screen
      .getByRole("button", { name: "Archive" })
      .closest('[data-slot="dialog-footer"]')!;
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Cancel",
      "Archive",
    ]);
  });

  it("dismisses with Escape and outside clicks unless an archive is pending", async () => {
    const onOpenChange = vi.fn();
    const store = makeStore();
    let finish!: () => void;
    store.mutateInventory.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <ArchiveChoicesDialog
        initialImpact={impact}
        onOpenChange={onOpenChange}
        thread={makeThread()}
        store={store}
        descendantCount={2}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("dialog-overlay"));
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    cleanup();
    const dismiss = vi.fn();
    render(
      <ArchiveChoicesDialog
        initialImpact={impact}
        onOpenChange={dismiss}
        thread={makeThread()}
        store={makeStore()}
        descendantCount={2}
      />,
    );
    await userEvent.keyboard("{Escape}");
    expect(dismiss).toHaveBeenCalledWith(false);
    dismiss.mockClear();
    await userEvent.click(screen.getByTestId("dialog-overlay"));
    expect(dismiss).toHaveBeenCalledWith(false);
  });
});

describe("useArchiveThreadAction", () => {
  function ArchiveAction({
    store,
    onArchived,
    onPendingChange,
  }: {
    readonly store: ReturnType<typeof makeStore>;
    readonly onArchived: (choice: "only" | "all", ids: readonly string[]) => void;
    readonly onPendingChange?: (pending: boolean) => void;
  }) {
    const archive = useArchiveThreadAction({
      thread: makeThread(),
      store,
      descendantCount: 0,
      onArchived,
      onPendingChange,
    });
    const choicesOpen = useArchiveChoicesOpen(store, "thread-1");
    return (
      <>
        <button type="button" onClick={archive.start}>
          Archive…
        </button>
        <output aria-label="Choices open">{String(choicesOpen)}</output>
      </>
    );
  }

  it("archives at once when nothing needs choosing", async () => {
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
    render(<ArchiveAction store={store} onArchived={onArchived} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith("only", ["thread-1"]));
    expect(store.mutateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1" }),
      "archive",
      { expectedStashedPromptCount: 0 },
    );
    expect(screen.queryByRole("dialog", { name: "Archive this thread" })).toBeNull();
  });

  it("opens the choices with the checked impact when there is something to choose", async () => {
    const store = makeStore();
    const onArchived = vi.fn();
    render(<ArchiveAction store={store} onArchived={onArchived} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(within(dialog).getByRole("checkbox", { name: "Archive child and descendant forks" })).not.toBeChecked();
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(1);
    expect(store.mutateInventory).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith("only", ["thread-1"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archive this thread" })).toBeNull());
  });

  it("starts a fresh check with default choices after Cancel", async () => {
    const store = makeStore();
    render(<ArchiveAction store={store} onArchived={vi.fn()} />);
    const open = screen.getByRole("status", { name: "Choices open" });
    expect(open).toHaveTextContent("false");
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    let dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(open).toHaveTextContent("true");
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Archive child and descendant forks" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(open).toHaveTextContent("false");

    store.getThreadArchiveImpact.mockResolvedValueOnce({
      descendantCount: 1,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 0, descendants: 0 },
      openTasks: emptyOpenTasks(),
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: { available: true },
    });
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2);
    expect(
      within(dialog).getByRole("checkbox", { name: "Archive child and descendant forks" }),
    ).not.toBeChecked();
  });

  it("reopens dismissed progress for the same check and hands off required choices", async () => {
    const store = makeStore();
    const impact = await store.getThreadArchiveImpact("thread-1");
    let answer!: (value: typeof impact) => void;
    store.getThreadArchiveImpact.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const onPendingChange = vi.fn();
    render(<OperationOverlayHost />);
    render(
      <ArchiveAction
        store={store}
        onArchived={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("dialog", { name: "Archiving thread…" })).toBeVisible();
    answer(impact);
    await act(async () => {});
    expect(await screen.findByRole("dialog", { name: "Archive this thread" })).toBeVisible();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByLabelText("Choices open")).toHaveTextContent("true");
  });
  it("shows an archive failure after dismissed progress was reopened", async () => {
    const store = makeStore();
    let fail!: (error: Error) => void;
    store.getThreadArchiveImpact.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    render(<OperationOverlayHost />);
    render(<ArchiveAction store={store} onArchived={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    act(() => getBlockingOperation()!.dismiss());
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    expect(await screen.findByRole("dialog", { name: "Archiving thread…" })).toBeVisible();
    await act(async () => { fail(new Error("The server is unavailable.")); });
    const dialog = await screen.findByRole("dialog", { name: "Could not archive thread" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The server is unavailable.");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not expose one connection's dismissed results in another connection", async () => {
    const first = makeStore();
    let fail!: (error: Error) => void;
    first.getThreadArchiveImpact.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const source = render(<ArchiveAction store={first} onArchived={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    act(() => getBlockingOperation()!.dismiss());
    source.unmount();
    cleanup();
    const second = makeStore();
    render(<ArchiveAction store={second} onArchived={vi.fn()} />);
    await act(async () => { fail(new Error("Old connection failure")); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Old connection failure")).toBeNull();
  });

  it("re-renders only the surfaces whose thread's choices open or close", async () => {
    const store = makeStore();
    const renders = { other: 0, unsubscribed: 0 };
    function Observer({
      threadId,
      enabled,
      count,
    }: {
      readonly threadId: string;
      readonly enabled?: boolean;
      readonly count: keyof typeof renders;
    }) {
      renders[count] += 1;
      const open = useArchiveChoicesOpen(store, threadId, enabled);
      return <output aria-label={`${count} open`}>{String(open)}</output>;
    }
    render(
      <>
        <ArchiveAction store={store} onArchived={vi.fn()} />
        <Observer threadId="thread-2" count="other" />
        <Observer threadId="thread-1" enabled={false} count="unsubscribed" />
      </>,
    );
    const initial = { ...renders };

    await userEvent.click(screen.getByRole("button", { name: "Archive…" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive this thread" });
    expect(screen.getByLabelText("Choices open")).toHaveTextContent("true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    expect(renders).toEqual(initial);
    expect(screen.getByLabelText("other open")).toHaveTextContent("false");
    expect(screen.getByLabelText("unsubscribed open")).toHaveTextContent("false");
  });
});
