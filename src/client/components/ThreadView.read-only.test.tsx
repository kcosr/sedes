// @vitest-environment jsdom
vi.mock("./thread/TurnUsageAction.js", () => ({ TurnUsageAction: () => null }));
import { OperationOverlayHost } from "../operations/OperationOverlay.js";
import { getBlockingOperation } from "../operations/blocking-operation.js";
vi.mock("../operations/thread-readiness.js", () => ({
  waitForOperationThreadReady: vi.fn(async () => undefined),
  setOperationThreadRegistry: vi.fn(),
}));

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
  ActivityDetailMode,
  AssociatedTask,
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import type {
  PendingComposerTransfer,
  ThreadProjectionViewportAnchor,
  ThreadClientState,
  ThreadClientStore,
} from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { clearDiagnostics, readDiagnostics } from "../app/diagnostics.js";
import { setDiagnosticCategoryEnabled } from "../app/settings.js";
import {
  beginThreadLoadAttempt,
  resetThreadLoadAttemptsForTests,
} from "../app/thread-load-diagnostics.js";
import { ThreadView } from "./ThreadView.js";
import {
  handleTaskDragStart,
  TaskDragProvider,
  useTaskDrag,
} from "../tasks/task-drag.js";

function TaskDragTestSource({ task }: { readonly task: AssociatedTask }) {
  const taskDrag = useTaskDrag();
  return (
    <button
      draggable
      onDragStart={(event) => handleTaskDragStart(taskDrag, task, event)}
    >
      Drag task
    </button>
  );
}

beforeEach(() => {
  render(<OperationOverlayHost />);
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
});

afterEach(() => {
  getBlockingOperation()?.cancel();
  cleanup();
  clearDiagnostics();
  resetThreadLoadAttemptsForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ThreadView load errors", () => {
  it("keeps session stats out of the error screen when a disabled backend has no snapshot", () => {
    const snapshot = makeSnapshot("interactive", "disconnected");
    const state = fixture(snapshot, [], { status: "error", connection: "disconnected", authoritative: false,
      snapshot: undefined, error: "This backend is disabled." });
    render(<ThreadView threadId={snapshot.thread.id} visible automationOpen={false} registry={state.registry} applicationStore={state.applicationStore} />);
    expect(screen.getByText("Couldn’t open this thread")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session stats" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to threads" })).toBeVisible();
    expect(state.registry.get(snapshot.thread.id).getSnapshot().snapshot).toBeUndefined();
  });
});

describe("ThreadView loading header", () => {
  function loadingFixture() {
    const snapshot = {
      ...makeSnapshot("interactive", "idle"),
      interactions: [],
      queue: [],
    } satisfies NormalizedThreadSnapshot;
    const state = fixture(snapshot, [], {
      status: "loading",
      connection: "reconnecting",
      authoritative: false,
      snapshot: undefined,
    });
    const summary: NormalizedApplicationThreadSummary = {
      ...snapshot.thread,
      title: { text: "Loading inventory title" },
      terminalSummary: { runningCount: 0, retainedCount: 0 },
      pinned: false,
      pinRevision: 0,
      preferredWorktree: null,
      preferredWorktreeRevision: 0,
      bookmarkRevision: 0,
      turnBookmarkCount: 0,
      groupId: null,
      groupAssignmentRevision: 0,
      stashedPromptCount: 0,
      pendingQuestionCount: 0,
      attention: {
        wake: false,
        automationContext: null,
        unseenCompletion: false,
        queueFailure: false,
      },
    };
    const applicationSnapshot = state.applicationStore.getSnapshot().snapshot!;
    return { ...state, snapshot, summary, applicationSnapshot };
  }

  it("shows inventory context while loading and follows application updates without enabling thread actions", () => {
    const state = loadingFixture();
    state.updateApplicationSnapshot({
      ...state.applicationSnapshot,
      environments: [
        { ...state.snapshot.environment, kind: "ssh" },
        { ...state.snapshot.environment, id: "local-environment", label: { text: "Local" } },
      ],
      threads: [state.summary],
    });
    render(
      <ThreadView
        threadId={state.snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    const header = screen.getByRole("banner", { name: "Chat panel header" });
    expect(within(header).getByRole("heading", { name: "Loading inventory title" })).toBeInTheDocument();
    expect(within(header).getByText("Workspace · Machine")).toBeInTheDocument();
    expect(header).toHaveAttribute("data-environment-tint", "true");
    expect(within(header).getByText("Codex")).toBeInTheDocument();
    const loadingNotice = screen.getByRole("status");
    expect(loadingNotice).toHaveTextContent("Loading conversation…");
    expect(loadingNotice).toHaveClass("runtime-banner");
    expect(header.nextElementSibling).toBe(loadingNotice);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session stats" })).not.toBeInTheDocument();
    expect(state.registry.get(state.snapshot.thread.id).getSnapshot().snapshot).toBeUndefined();
    act(() => state.updateApplicationSnapshot({
      ...state.applicationSnapshot,
      threads: [{ ...state.summary, title: { text: "Updated inventory title" } }],
    }));
    expect(within(header).getByRole("heading", { name: "Updated inventory title" })).toBeInTheDocument();
    expect(screen.queryByText("Loading inventory title")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session stats" })).not.toBeInTheDocument();
  });

  it("uses a generic header until matching inventory arrives and does not leak the previous thread title", () => {
    const state = loadingFixture();
    const view = render(
      <ThreadView
        threadId={state.snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    expect(screen.getByRole("heading", { name: "Opening thread" })).toBeInTheDocument();
    act(() => state.updateApplicationSnapshot({
      ...state.applicationSnapshot,
      threads: [state.summary],
    }));
    expect(screen.getByRole("heading", { name: "Loading inventory title" })).toBeInTheDocument();
    view.rerender(
      <ThreadView
        threadId="another-thread"
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    expect(screen.getByRole("heading", { name: "Opening thread" })).toBeInTheDocument();
    expect(screen.queryByText("Loading inventory title")).not.toBeInTheDocument();
    act(() => state.updateApplicationSnapshot({
      ...state.applicationSnapshot,
      threads: [state.summary, { ...state.summary, id: "another-thread", title: { text: "Another thread" } }],
    }));
    expect(screen.getByRole("heading", { name: "Another thread" })).toBeInTheDocument();
    expect(screen.queryByText("Loading inventory title")).not.toBeInTheDocument();
  });

  it("shows a selected descendant summary outside the top-level inventory", () => {
    const state = loadingFixture();
    const applicationState: ApplicationClientState = {
      ...state.applicationStore.getSnapshot(),
      descendantPages: {
        "parent-thread": {
          loaded: true,
          loading: false,
          descendants: [{
            thread: state.summary,
            origin: {
              childThreadId: state.summary.id,
              sourceThreadId: "parent-thread",
              sourceTurnId: null,
              sourceTurnCompletedAt: null,
              boundaryKind: "provider_snapshot_at_acceptance",
              originKind: "user_fork",
              initiatingAgentThreadId: null,
              initiatingToolClientId: null,
              branchMethod: "provider_native",
              createdAt: "2026-07-30T15:00:00.000Z",
            },
            placement: {
              childThreadId: state.summary.id,
              mode: "nested_under_source",
              revision: 1,
              updatedAt: "2026-07-30T15:00:00.000Z",
            },
          }],
        },
      },
    };
    const applicationStore = {
      ...state.applicationStore,
      getSnapshot: () => applicationState,
    } as unknown as ApplicationClientStore;
    render(
      <ThreadView
        threadId={state.summary.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={applicationStore}
      />,
    );
    expect(screen.getByRole("heading", { name: "Loading inventory title" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps panel collapse, close, and docking controls available during loading", () => {
    const state = loadingFixture();
    const panelControls = { onCollapse: vi.fn(), onClose: vi.fn(), onDock: vi.fn() };
    render(
      <ThreadView
        threadId={state.snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
        panelControls={panelControls}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse Chat panel" }));
    expect(panelControls.onCollapse).toHaveBeenCalledOnce();
    const close = screen.getByRole("button", { name: "Close Chat panel" });
    fireEvent.click(close);
    expect(panelControls.onClose).toHaveBeenCalledWith(close);
    const menu = screen.getByRole("button", { name: "Chat panel actions" });
    expect(menu).toBeEnabled();
    fireEvent.keyDown(menu, { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Dock right" }));
    expect(panelControls.onDock).toHaveBeenCalledWith("right");
  });

  it("hands off to the real snapshot while preserving connection authority for the composer", () => {
    const state = loadingFixture();
    state.updateApplicationSnapshot({ ...state.applicationSnapshot, threads: [state.summary] });
    render(
      <ThreadView
        threadId={state.snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    act(() => state.updateThreadState({ status: "ready", snapshot: state.snapshot }));
    expect(screen.getByRole("heading", { name: state.snapshot.thread.title.text })).toBeInTheDocument();
    expect(screen.queryByText("Loading inventory title")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeDisabled();
    act(() => state.updateThreadState({ connection: "connected", authoritative: true }));
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeEnabled();
  });
});

describe("ThreadView background activity", () => {
  it("keeps ordinary Send available while showing work and marks browser reconnect uncertain", () => {
    const snapshot: NormalizedThreadSnapshot = {
      ...makeSnapshot("interactive", "idle"),
      interactions: [],
      queue: [],
      backgroundActivity: {
        state: "known", agents: 1, commands: 0, other: 0,
        description: { text: "Inspect tests" },
      },
    };
    const state = fixture(snapshot);
    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    expect(screen.getByTestId("background-activity-status")).toHaveTextContent("Waiting for subagent · Inspect tests");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
    act(() => state.updateThreadState({ connection: "reconnecting", authoritative: false }));
    expect(screen.getByTestId("background-activity-status")).toHaveTextContent("Checking background work…");
    act(() => state.updateThreadState({ connection: "connected", authoritative: true }));
    expect(screen.getByTestId("background-activity-status")).toHaveTextContent("Waiting for subagent");
    act(() => state.updateSnapshot({ ...snapshot, backgroundActivity: { state: "known", agents: 0, commands: 0, other: 0 } }));
    expect(screen.queryByTestId("background-activity-status")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});

describe("ThreadView message keyboard navigation", () => {
  function mount(visible = true) {
    const base = makeSnapshot("interactive", "idle");
    const snapshot: NormalizedThreadSnapshot = {
      ...base,
      interactions: [],
      queue: [],
      draft: { ...base.draft, text: "" },
      orderedTurnIds: ["navigation-turn"],
      turnsById: {
        "navigation-turn": {
          id: "navigation-turn",
          revision: 1,
          status: "completed",
          endedBy: "agent_settled",
          orderedItemIds: ["message-a", "message-b", "message-c"],
        },
      },
      itemsById: Object.fromEntries(
        ["a", "b", "c"].map((name) => [
          `message-${name}`,
          {
            id: `message-${name}`,
            turnId: "navigation-turn",
            kind: "user_message" as const,
            revision: 1,
            status: "completed" as const,
            content: [{ kind: "text" as const, text: { text: `Prompt ${name}` } }],
          },
        ]),
      ),
    };
    const state = fixture(snapshot);
    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible={visible}
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_500 },
    });
    viewport.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    const itemIds = ["message-a", "message-b", "message-c"];
    for (const [index, itemId] of itemIds.entries()) {
      const row = viewport.querySelector<HTMLElement>(
        `[data-item-id="${itemId}"]`,
      )!;
      row.getBoundingClientRect = () =>
        ({ top: 100 + index * 400 - viewport.scrollTop }) as DOMRect;
    }
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      viewport.scrollTop = options.top ?? viewport.scrollTop;
    });
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: scrollTo });
    viewport.scrollTop = 600;
    return {
      viewport,
      scrollTo,
      composer: screen.getByRole("textbox", { name: "Message Pi" }),
    };
  }

  it.each(["ctrlKey", "metaKey"] as const)(
    "seeks from actual scroll position with %s in chat and the empty composer",
    (modifier) => {
      const { viewport, composer, scrollTo } = mount();
      fireEvent.keyDown(viewport, { key: "ArrowUp", [modifier]: true });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 484, behavior: "auto" });
      composer.focus();
      fireEvent.keyDown(composer, { key: "ArrowDown", [modifier]: true });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 884, behavior: "auto" });
      expect(composer).toHaveFocus();
      viewport.scrollTop = 200;
      fireEvent.keyDown(composer, { key: "ArrowUp", [modifier]: true });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 84, behavior: "auto" });
    },
  );

  it("preserves draft editing, other fields, overlays, composition, and other modifier combinations", () => {
    const { viewport, composer, scrollTo } = mount();
    fireEvent.change(composer, { target: { value: "Keep editing this draft" } });
    fireEvent.keyDown(composer, { key: "ArrowUp", ctrlKey: true });
    expect(composer).toHaveValue("Keep editing this draft");
    for (const modifiers of [
      {},
      { ctrlKey: true, shiftKey: true },
      { metaKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: true, isComposing: true },
    ]) {
      fireEvent.keyDown(viewport, { key: "ArrowDown", ...modifiers });
    }
    const field = document.createElement("input");
    viewport.append(field);
    fireEvent.keyDown(field, { key: "ArrowUp", ctrlKey: true });
    field.remove();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    viewport.append(dialog);
    fireEvent.keyDown(button, { key: "ArrowUp", metaKey: true });
    dialog.remove();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not navigate a hidden thread", () => {
    const { viewport, scrollTo } = mount(false);
    fireEvent.keyDown(viewport, { key: "ArrowUp", ctrlKey: true });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("ThreadView backend interaction modes", () => {
  it("clears the thread move overlay when the composer copies a dragged task", async () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const state = fixture(snapshot);
    const task: AssociatedTask = {
      id: "task-composer-drop",
      scope: { kind: "global" },
      associatedWorkspaceId: null,
      title: "Attach me",
      details: "",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 2,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:00:00.000Z",
    };
    const applicationSnapshot = state.applicationStore.getSnapshot().snapshot!;
    applicationSnapshot.tasks = [task];
    Object.assign(state.applicationStore, { getTasks: () => [task] });
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      types,
      items: [],
      files: [],
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn((type: string) => values.get(type) ?? ""),
    } as unknown as DataTransfer;

    render(
      <TaskDragProvider
        store={state.applicationStore}
        snapshot={applicationSnapshot as NormalizedApplicationSnapshot}
      >
        <TaskDragTestSource task={task} />
        <ThreadView
          threadId={snapshot.thread.id}
          visible
          automationOpen={false}
          registry={state.registry}
          applicationStore={state.applicationStore}
        />
      </TaskDragProvider>,
    );

    fireEvent.dragStart(screen.getByRole("button", { name: "Drag task" }), {
      dataTransfer,
    });
    const threadView = screen.getByTestId("thread-view");
    fireEvent.dragEnter(threadView, { dataTransfer });
    expect(
      screen.getByText(`Move task to ${snapshot.thread.title.text}`),
    ).toBeInTheDocument();

    const composer = screen.getByTestId("composer");
    fireEvent.dragEnter(composer, { dataTransfer });
    expect(
      screen.queryByText(`Move task to ${snapshot.thread.title.text}`),
    ).not.toBeInTheDocument();
    expect(composer).toHaveClass("task-drag-active");

    fireEvent.dragOver(composer, { dataTransfer });
    expect(
      screen.queryByText(`Move task to ${snapshot.thread.title.text}`),
    ).not.toBeInTheDocument();

    fireEvent.drop(composer, { dataTransfer });

    await waitFor(() =>
      expect(
        screen.queryByText(`Move task to ${snapshot.thread.title.text}`),
      ).not.toBeInTheDocument(),
    );
    expect(composer).not.toHaveClass("task-drag-active");
  });

  it("shows an actionable classified cold-load failure", () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const state = fixture(snapshot, [], {
      status: "error",
      connection: "disconnected",
      authoritative: false,
      snapshot: undefined,
      error: "The workspace directory was moved or removed.",
      loadFailure: {
        format: "sedes-thread-load-error-v1",
        requestId: "request-missing-workspace",
        error: {
          code: "workspace_missing",
          message: "The workspace directory was moved or removed.",
          retryable: false,
        },
      },
    });

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );

    expect(screen.getByText("Couldn’t open this thread")).toBeInTheDocument();
    expect(
      screen.getByText("The workspace directory was moved or removed."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reference: request-missing-workspace"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.retryLoad).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Back to threads" }),
    ).toBeInTheDocument();
  });

  it("keeps cached history visible beneath a refresh failure alert", () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const state = fixture(snapshot, [], {
      status: "ready",
      connection: "disconnected",
      authoritative: false,
      error: "This thread is too large to display safely.",
      loadFailure: {
        format: "sedes-thread-load-error-v1",
        requestId: "request-too-large",
        error: {
          code: "backend_unavailable",
          message: "This thread is too large to display safely.",
          retryable: false,
        },
      },
    });

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );

    expect(screen.getByTestId("thread-view")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This thread is too large to display safely.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reference: request-too-large",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.retryLoad).toHaveBeenCalledOnce();
  });

  it("offers recovery when a cached stream fails protocol validation", () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const state = fixture(snapshot, [], {
      status: "ready",
      connection: "disconnected",
      authoritative: false,
      error: "Invalid normalized thread load error.",
      terminalLoadError: "Invalid normalized thread load error.",
    });

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );

    expect(screen.getByTestId("thread-view")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Invalid normalized thread load error.",
    );
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.retryLoad).toHaveBeenCalledOnce();
  });

  it("keeps automatic resnapshot recovery neutral during the connection grace", () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const state = fixture(snapshot, [], {
      status: "ready",
      connection: "reconnecting",
      authoritative: false,
      error: "Thread stream needs a new snapshot: generation_gap",
    });

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );

    expect(screen.queryByTitle("reconnecting")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Thread stream needs a new snapshot: generation_gap"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("shows neutral connecting guidance only after five seconds", () => {
    vi.useFakeTimers();
    try {
      const snapshot = makeSnapshot("interactive", "idle");
      const state = fixture(snapshot, [], {
        status: "ready",
        connection: "reconnecting",
        authoritative: false,
      });

      render(
        <ThreadView
          threadId={snapshot.thread.id}
          visible
          automationOpen={false}
          registry={state.registry}
          applicationStore={state.applicationStore}
        />,
      );

      expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(4_999));
      expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("status")).toHaveTextContent(
        "Connecting…Work may continue in the background.",
      );
      expect(
        screen.queryByText("Accepted work may still be running."),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a transcript anchor after the projection loading remount", () => {
    const full = activityProjectionSnapshot("reasoning");
    const summary = activityProjectionSnapshot("activity_summary");
    const state = fixture(full);
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("message-viewport")) {
          return { top: 0 } as DOMRect;
        }
        if (this.hasAttribute("data-activity-first-item-id")) {
          return {
            top: this.dataset.activityDetail === "summary" ? 300 : 100,
          } as DOMRect;
        }
        return { top: 600 } as DOMRect;
      });
    render(
      <ThreadView
        threadId={full.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    const originalViewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(originalViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    originalViewport.scrollTop = 400;
    fireEvent.scroll(originalViewport);
    fireEvent.scroll(originalViewport);

    act(() => state.beginActivityProjection("summary"));
    expect(screen.queryByRole("region", { name: "Messages" })).toBeNull();
    act(() => state.finishActivityProjection(summary));

    const replacementViewport = screen.getByRole("region", {
      name: "Messages",
    });
    expect(replacementViewport).not.toBe(originalViewport);
    expect(replacementViewport.scrollTop).toBe(200);
    rect.mockRestore();
  });

  it("opens at latest when the projection replacement no longer contains the anchor", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const full = activityProjectionSnapshot("reasoning");
    const summary = activityProjectionSnapshot(
      "activity_summary",
      "activity-2",
    );
    const state = fixture(full);
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("message-viewport")) {
          return { top: 0 } as DOMRect;
        }
        if (this.hasAttribute("data-activity-first-item-id")) {
          return { top: 100 } as DOMRect;
        }
        return { top: 600 } as DOMRect;
      });
    render(
      <ThreadView
        threadId={full.thread.id}
        visible
        automationOpen={false}
        registry={state.registry}
        applicationStore={state.applicationStore}
      />,
    );
    const originalViewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(originalViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    originalViewport.scrollTop = 400;
    fireEvent.scroll(originalViewport);
    fireEvent.scroll(originalViewport);

    act(() => state.beginActivityProjection("summary"));
    act(() => state.finishActivityProjection(summary));
    const replacementViewport = screen.getByRole("region", {
      name: "Messages",
    });
    Object.defineProperties(replacementViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    act(() => frames.splice(0).forEach((callback) => callback(16)));

    expect(replacementViewport.scrollTop).toBe(1_000);
    rect.mockRestore();
  });

  it("records the visible snapshot commit and a post-paint frame", () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const snapshot = makeSnapshot("interactive", "idle");
    const { applicationStore, registry, updateSnapshot } = fixture(snapshot);
    beginThreadLoadAttempt(snapshot.thread.id, "navigation");
    const view = render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible={false}
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );
    expect(
      readDiagnostics().some(
        ({ event }) => event === "react_snapshot_committed",
      ),
    ).toBe(false);

    view.rerender(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );
    expect(
      readDiagnostics().some(
        ({ event }) => event === "react_snapshot_committed",
      ),
    ).toBe(true);
    act(() =>
      updateSnapshot({
        ...snapshot,
        thread: { ...snapshot.thread, threadRevision: 1 },
      }),
    );
    const firstFrame = frames.splice(0);
    act(() => firstFrame.forEach((callback) => callback(16)));
    expect(
      readDiagnostics().some(({ event }) => event === "paint_frame_completed"),
    ).toBe(false);
    const secondFrame = frames.splice(0);
    act(() => secondFrame.forEach((callback) => callback(32)));
    expect(
      readDiagnostics().some(({ event }) => event === "paint_frame_completed"),
    ).toBe(true);
  });

  it("autofocuses chat only for a desktop fine-pointer thread view", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width: 820px) and (pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const snapshot = {
      ...makeSnapshot("interactive", "idle"),
      interactions: [],
    } as NormalizedThreadSnapshot;
    const { applicationStore, registry } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("keeps a hidden thread retained without acknowledging or focusing it", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width: 820px) and (pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const base = makeSnapshot("interactive", "idle");
    const snapshot: NormalizedThreadSnapshot = {
      ...base,
      interactions: [],
      attention: {
        unseenCompletion: {
          operationId: "operation-hidden",
          completedAt: "2026-08-10T12:00:00.000Z",
        },
      },
    };
    const fixtureState = fixture(snapshot);
    const view = render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible={false}
        automationOpen={false}
        registry={fixtureState.registry}
        applicationStore={fixtureState.applicationStore}
      />,
    );

    expect(fixtureState.retain).toHaveBeenCalledWith(snapshot.thread.id);
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).not.toHaveFocus();
    expect(fixtureState.acknowledgeVisibleCompletion).not.toHaveBeenCalled();

    view.rerender(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={fixtureState.registry}
        applicationStore={fixtureState.applicationStore}
      />,
    );

    await waitFor(() =>
      expect(fixtureState.acknowledgeVisibleCompletion).toHaveBeenCalledWith(
        "operation-hidden",
      ),
    );
  });

  it("retains a hidden interaction takeover without stealing focus", async () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const { applicationStore, registry } = fixture(snapshot);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const view = render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible={false}
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    const prompt = screen.getByRole("dialog", {
      name: "Approve filesystem access?",
    });
    expect(prompt).toBeInTheDocument();
    expect(outside).toHaveFocus();

    view.rerender(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );
    await waitFor(() =>
      expect(prompt.contains(document.activeElement)).toBe(true),
    );
    outside.remove();
  });

  it("does not steal focus for a mobile thread view", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const snapshot = {
      ...makeSnapshot("interactive", "idle"),
      interactions: [],
    } as NormalizedThreadSnapshot;
    const { applicationStore, registry } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    expect(screen.getByRole("textbox")).not.toHaveFocus();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("does not steal focus moved elsewhere while a desktop thread loads", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width: 820px) and (pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const snapshot = {
      ...makeSnapshot("interactive", "idle"),
      interactions: [],
    } as NormalizedThreadSnapshot;
    const ready = fixture(snapshot);
    let current: ThreadClientState = {
      status: "loading",
      connection: "reconnecting",
      authoritative: false,
      actionPending: false,
      pendingComposerTransfers: [],
      pendingQueuedSteers: [],
      historyLoading: false,
      forkAttempts: {},
      questionRequests: [],
      questionRevision: 0,
    questionStatuses: {},
      questionInboxOpenRevision: 0,
      questionInboxConsumedOpenRevision: 0,
      questionInboxClosedQuestionKeys: [],
      questionStatus: "ready",
      questionDrafts: {},
      pendingQuestionIds: [],
      pendingQuestionReplies: [],
      bookmarks: [],
      bookmarkRevision: 0,
      bookmarkStatus: "loading",
      pendingBookmarkTurnIds: [],
      stashes: [],
    };
    const listeners = new Set<() => void>();
    const readyStore = ready.registry.get(snapshot.thread.id);
    const delayedStore = {
      ...readyStore,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => current,
    } as unknown as ThreadClientStore;
    const registry = {
      get: () => delayedStore,
      retainCached: () => delayedStore,
      releaseCached: vi.fn(),
    } as unknown as ThreadStoreRegistry;
    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={ready.applicationStore}
      />,
    );
    const editor = document.createElement("textarea");
    editor.setAttribute("aria-label", "Workspace editor");
    document.body.append(editor);
    editor.focus();

    act(() => {
      current = readyStore.getSnapshot();
      for (const listener of listeners) listener();
    });

    await screen.findByRole("textbox", { name: "Message Pi" });
    expect(editor).toHaveFocus();
    editor.remove();
  });

  it("keeps a nonvisual reason on the disabled short Fork action", async () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const { applicationStore, registry } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const fork = await screen.findByRole("button", {
      name: "Fork",
    });
    const descriptionId = fork.getAttribute("aria-describedby");
    expect(fork).toBeDisabled();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "Forking is unavailable in this fixture.",
    );
  });

  it("offers the latest completed turn in the top thread menu", async () => {
    const base = makeSnapshot("interactive", "idle");
    const snapshot: NormalizedThreadSnapshot = {
      ...base,
      orderedTurnIds: ["turn-latest"],
      turnsById: {
        "turn-latest": {
          id: "turn-latest",
          revision: 6,
          status: "completed",
          endedBy: "agent_settled",
          completedAt: "2026-07-30T15:00:00.000Z",
          orderedItemIds: [],
        },
      },
      forksByTurnId: {
        "turn-latest": {
          sourceTurnId: "turn-latest",
          expectedTurnRevision: 6,
          available: true,
        },
      },
    };
    const { applicationStore, registry, forkTurn } = fixture(snapshot);
    forkTurn.mockResolvedValue({
      status: "created",
      childThreadId: "child-from-menu",
    });

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fork" }));
    expect(forkTurn).toHaveBeenCalledWith(
      snapshot.forksByTurnId["turn-latest"],
      { restart: false },
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe("/threads/child-from-menu"),
    );
  });

  it("hands healthy submit queue presentation back to the strip while a fork source is focused", () => {
    const base = makeSnapshot("interactive", "idle");
    const snapshot: NormalizedThreadSnapshot = {
      ...base,
      orderedTurnIds: ["turn-fork-source"],
      turnsById: {
        "turn-fork-source": {
          id: "turn-fork-source",
          revision: 1,
          status: "completed",
          endedBy: "agent_settled",
          completedAt: "2026-07-30T15:00:00.000Z",
          orderedItemIds: [],
        },
      },
    };
    const pendingSubmit = makePendingSubmit(snapshot, "queue-operation-1");
    const { applicationStore, registry } = fixture(snapshot, [pendingSubmit]);
    const view = render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    expect(screen.getByText("Immediate optimistic send")).toBeVisible();
    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();

    view.rerender(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        focusTurnId="turn-fork-source"
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    expect(
      screen.queryByText("Immediate optimistic send"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-delivery-operation-id="queue-operation-1"]',
      ),
    ).toHaveTextContent("Queued work");
  });

  it("focuses a labelled panel while keeping the composer mounted", () => {
    const snapshot = makeSnapshot("interactive", "idle");
    const { applicationStore, registry } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Approve filesystem access?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("thread-presentation-content"),
    ).not.toHaveAttribute("inert");
    expect(
      screen.getByTestId("thread-presentation-content"),
    ).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Pending inputs" }),
    ).not.toBeInTheDocument();
  });

  it("restores composer focus captured before the interaction panel opens", async () => {
    const interactionSnapshot = makeSnapshot("interactive", "idle");
    const idleSnapshot = { ...interactionSnapshot, interactions: [] };
    const { applicationStore, registry, updateSnapshot } =
      fixture(idleSnapshot);

    render(
      <ThreadView
        threadId={idleSnapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    composer.focus();

    act(() => updateSnapshot(interactionSnapshot));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    act(() => updateSnapshot(idleSnapshot));
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("renders and acknowledges a wake without reminder text", () => {
    const base = makeSnapshot("interactive", "idle");
    const snapshot: NormalizedThreadSnapshot = {
      ...base,
      attention: {
        wake: { wokeAt: "2026-07-30T15:01:00.000Z" },
      },
    };
    const { applicationStore, registry, dismissAttention } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen={false}
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    const wake = screen.getByTestId("wake-attention");
    expect(wake).toHaveTextContent("Woke");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissAttention).toHaveBeenCalledWith({
      kind: "wake",
      wokeAt: "2026-07-30T15:01:00.000Z",
    });
  });

  it("renders a bound read-only thread without provider mutation controls", async () => {
    const snapshot = makeSnapshot("read_only", "idle");
    const { applicationStore, registry } = fixture(snapshot);

    render(
      <ThreadView
        threadId={snapshot.thread.id}
        visible
        automationOpen
        registry={registry}
        applicationStore={applicationStore}
      />,
    );

    expect(screen.getByText("Read-only thread")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This imported thread has no conversation history to display.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Imported Codex thread" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Imported Codex thread" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /send message|queue|continue|approve/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Automation settings" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await waitFor(() =>
      expect(screen.getByText("Session stats")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Compact context")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Automate…|Automation settings…/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Approve filesystem access?"),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["disconnected", "Backend disconnected"],
    ["reconciling", "Reconciling thread…"],
  ] as const)(
    "keeps an interactive %s thread honest and non-mutable",
    (runState, banner) => {
      const snapshot = makeSnapshot("interactive", runState);
      const { applicationStore, registry } = fixture(snapshot);

      render(
        <ThreadView
          threadId={snapshot.thread.id}
          visible
          automationOpen={false}
          registry={registry}
          applicationStore={applicationStore}
        />,
      );

      expect(screen.getByText(banner)).toBeInTheDocument();
      expect(screen.queryByText("Read-only thread")).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          "This imported thread has no conversation history to display.",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: "Approve filesystem access?" }),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("thread-presentation-content"),
      ).not.toHaveAttribute("inert");
      expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(
        screen.getByText(/request will remain open|cannot be answered/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Imported Codex thread" }),
      ).toBeDisabled();
    },
  );
});

function fixture(
  snapshot: NormalizedThreadSnapshot,
  pendingComposerTransfers: readonly PendingComposerTransfer[] = [],
  initialState: Partial<ThreadClientState> = {},
): {
  readonly applicationStore: ApplicationClientStore;
  readonly registry: ThreadStoreRegistry;
  readonly forkTurn: ReturnType<typeof vi.fn>;
  readonly dismissAttention: ReturnType<typeof vi.fn>;
  readonly acknowledgeVisibleCompletion: ReturnType<typeof vi.fn>;
  readonly retain: ReturnType<typeof vi.fn>;
  readonly retryLoad: ReturnType<typeof vi.fn>;
  readonly beginActivityProjection: (
    activityDetail: ActivityDetailMode,
  ) => void;
  readonly finishActivityProjection: (
    snapshot: NormalizedThreadSnapshot,
  ) => void;
  readonly updateSnapshot: (snapshot: NormalizedThreadSnapshot) => void;
  readonly updateThreadState: (state: Partial<ThreadClientState>) => void;
  readonly updateApplicationSnapshot: (snapshot: NormalizedApplicationSnapshot) => void;
} {
  let threadState: ThreadClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    actionPending: false,
    pendingComposerTransfers,
    pendingQueuedSteers: [],
    historyLoading: false,
    forkAttempts: {},
    questionRequests: [],
    questionRevision: 0,
    questionStatuses: {},
    questionInboxOpenRevision: 0,
    questionInboxConsumedOpenRevision: 0,
    questionInboxClosedQuestionKeys: [],
    questionStatus: "ready",
    questionDrafts: {},
    pendingQuestionIds: [],
      pendingQuestionReplies: [],
    bookmarks: [],
    bookmarkRevision: 0,
    bookmarkStatus: "ready",
    pendingBookmarkTurnIds: [],
    snapshot,
    stashes: snapshot.stashes,
    ...initialState,
  };
  const forkTurn = vi.fn();
  const dismissAttention = vi.fn(async () => undefined);
  const acknowledgeVisibleCompletion = vi.fn(async () => undefined);
  const retryLoad = vi.fn();
  const listeners = new Set<() => void>();
  const activityDetailWillChangeListeners = new Set<
    (activityDetail: ActivityDetailMode) => void
  >();
  let activityDetail: ActivityDetailMode = "full";
  let projectionViewportAnchor: ThreadProjectionViewportAnchor | undefined;
  const threadStore = {
    get activityDetail() {
      return activityDetail;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeActivityDetailWillChange: (
      listener: (activityDetail: ActivityDetailMode) => void,
    ) => {
      activityDetailWillChangeListeners.add(listener);
      return () => activityDetailWillChangeListeners.delete(listener);
    },
    rememberProjectionViewportAnchor: (
      anchor: ThreadProjectionViewportAnchor,
    ) => {
      projectionViewportAnchor = anchor;
    },
    takeProjectionViewportAnchor: (expected: ActivityDetailMode) => {
      if (projectionViewportAnchor?.activityDetail !== expected) {
        return undefined;
      }
      const anchor = projectionViewportAnchor;
      projectionViewportAnchor = undefined;
      return anchor;
    },
    getSnapshot: () => threadState,
    normalized: { state: { notices: [] } },
    acknowledgeVisibleCompletion,
    observePublishedBookmarkRevision: vi.fn(),
    perform: vi.fn(async () => undefined),
    forkTurn,
    dismissAttention,
    clearActionError: vi.fn(),
    retryLoad,
    registerDraftFlush: () => () => undefined,
    saveDraft: vi.fn(
      async (draft: { text: string; revision: number }) => draft,
    ),
  } as unknown as ThreadClientStore;
  const retain = vi.fn(() => threadStore);
  const registry = {
    get: () => threadStore,
    retainCached: retain,
    releaseCached: vi.fn(),
  } as unknown as ThreadStoreRegistry;
  let applicationState: ApplicationClientState = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    providerPulseEnabled: false,
    search: "",
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    snapshot: {
      advisories: [],
      environments: [snapshot.environment],
      workspaces: [snapshot.workspace],
      threads: [],
      forkOrigins: [],
      lineagePlacements: [],
      groups: [],
      lineageFamilies: [],
      executionTargets: [],
      defaultNewThreadTargetId: null,
      counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
      tasks: [],
    },
    visibleThreads: [],
  };
  const applicationListeners = new Set<() => void>();
  const applicationStore = {
    subscribe: (listener: () => void) => {
      applicationListeners.add(listener);
      return () => applicationListeners.delete(listener);
    },
    getSnapshot: () => applicationState,
    mutateInventory: vi.fn(async () => undefined),
  } as unknown as ApplicationClientStore;
  return {
    applicationStore,
    registry,
    forkTurn,
    dismissAttention,
    acknowledgeVisibleCompletion,
    retain,
    retryLoad,
    beginActivityProjection: (nextActivityDetail) => {
      projectionViewportAnchor = undefined;
      activityDetailWillChangeListeners.forEach((listener) =>
        listener(nextActivityDetail),
      );
      activityDetail = nextActivityDetail;
      threadState = {
        ...threadState,
        status: "loading",
        connection: "reconnecting",
        authoritative: false,
        snapshot: undefined,
      };
      listeners.forEach((listener) => listener());
    },
    finishActivityProjection: (nextSnapshot) => {
      threadState = {
        ...threadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
        snapshot: nextSnapshot,
        stashes: nextSnapshot.stashes,
      };
      listeners.forEach((listener) => listener());
    },
    updateThreadState: (nextState) => {
      threadState = { ...threadState, ...nextState };
      listeners.forEach((listener) => listener());
    },
    updateApplicationSnapshot: (nextSnapshot) => {
      applicationState = { ...applicationState, snapshot: nextSnapshot };
      applicationListeners.forEach((listener) => listener());
    },
    updateSnapshot: (nextSnapshot) => {
      threadState = {
        ...threadState,
        snapshot: nextSnapshot,
        stashes: nextSnapshot.stashes,
      };
      listeners.forEach((listener) => listener());
    },
  };
}

function makePendingSubmit(
  snapshot: NormalizedThreadSnapshot,
  operationId: string,
): PendingComposerTransfer {
  return {
    operationId,
    mode: "submit",
    captured: {
      text: "Immediate optimistic send",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: snapshot.draft.revision,
    },
    capturedPresentation: {},
    startedAt: 1,
    presentationSequence: 1,
    baselineThreadRevision: snapshot.thread.threadRevision,
    baselineOrderedTurnIds: [...snapshot.orderedTurnIds],
    ...(snapshot.orderedTurnIds.at(-1)
      ? { baselineTailTurnId: snapshot.orderedTurnIds.at(-1)! }
      : {}),
    baselineTailTurnItemIds: [],
    acceptanceEvidence: "none",
    presentation: "transcript",
    requestState: "requesting",
    authorityState: "client_only",
    rollbackRequired: false,
    rollbackApplied: false,
    lateMaterializationRequiresComposerReconciliation: false,
    retainTombstoneAfterRollback: false,
  };
}

function activityProjectionSnapshot(
  kind: "reasoning" | "activity_summary",
  itemId = "activity-1",
): NormalizedThreadSnapshot {
  const base = makeSnapshot("interactive", "idle");
  return {
    ...base,
    interactions: [],
    queue: [],
    orderedTurnIds: ["turn-activity"],
    turnsById: {
      "turn-activity": {
        id: "turn-activity",
        revision: 1,
        status: "completed",
        endedBy: "agent_settled",
        completedAt: "2026-07-30T15:00:00.000Z",
        orderedItemIds: [itemId],
      },
    },
    itemsById: {
      [itemId]:
        kind === "reasoning"
          ? {
              id: itemId,
              turnId: "turn-activity",
              kind,
              status: "completed",
              revision: 1,
              markdown: { text: "Detailed reasoning" },
            }
          : {
              id: itemId,
              turnId: "turn-activity",
              kind,
              activityKind: "reasoning",
              status: "completed",
              revision: 1,
            },
    },
  };
}

function makeSnapshot(
  interactionMode: "interactive" | "read_only",
  runState: "idle" | "disconnected" | "reconciling",
): NormalizedThreadSnapshot {
  const interactive = interactionMode === "interactive";
  const transitioning =
    runState === "disconnected" || runState === "reconciling";
  return {
    executionWorkspace: { kind: "direct" },
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
    },
    forksByTurnId: {},
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Imported Codex thread" },
      backend: { label: { text: "Codex" }, brand: "codex" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 1,
      threadRevision: 1,
      runState,
      queuedInputCount: 1,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: {
        status: "enabled",
        runMode: "same_thread",
        scheduleKind: "interval",
        revision: 1,
        hasPrecheck: false,
      },
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Workspace" },
      displayPath: { text: "/workspace" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Machine" },
      available: true,
      directoryBrowsing: "unavailable" as const,
    },
    draft: {
      text: "queued draft",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "cli", mode: "progressive" },
      presentationOptions: [
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    history: { hasOlder: false },
    runState,
    queue: [
      {
        id: "queue-1",
        deliveryOperationId: "queue-operation-1",
        resolvedDeliveryMode: "queue",
        sequence: 1,
        state: "pending",
        origin: "user",
        isHead: true,
        preview: { text: "Queued work" },
        attachmentCount: 0,
        taskCount: 0,
        createdAt: "2026-07-30T15:00:00.000Z",
      },
    ],
    capabilities: {
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        nativeImage: {
          availability: "unavailable",
          reason: { text: "Unavailable." },
        },
        policy: {
          maximumAttachments: 8,
          maximumImages: 4,
          maximumAggregateBytes: 67_108_864,
          maximumFileBytes: 26_214_400,
          maximumImageBytes: 16_777_216,
          maximumImagePixels: 40_000_000,
          maximumImageDimension: 16_384,
          imageMediaTypes: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ],
        },
      },
      revision: `capability-${interactionMode}-${runState}`,
      backend: { label: { text: interactive ? "Pi" : "Codex" } },
      interactionMode,
      runState,
      operations: interactive
        ? [
            {
              id: "rename",
              label: { text: "Rename" },
              destructive: false,
              available: !transitioning,
              parameters: {
                kind: "text",
                field: "title",
                required: true,
                maximumLength: 240,
              },
            },
          ]
        : [],
      deliveryModes: interactive
        ? [
            {
              id: "submit",
              steerTarget: null,
              label: { text: "Send" },
              available: !transitioning,
            },
          ]
        : [],
      settings: [],
      composerActions: [],
      interactions: interactive
        ? [
            {
              kind: "confirmation",
              available: !transitioning,
            },
          ]
        : [],
      providerFeatures: [],
      history: { available: true, paginated: true },
      automation: {
        available: false,
        canAttach: false,
        canRunNow: false,
        canCloneOnRun: false,
      },
    },
    settings: { revision: 1, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [
      {
        id: "interaction-1",
        threadId: "thread-1",
        sourceLabel: { text: "Tool" },
        title: { text: "Approve filesystem access?" },
        kind: "confirmation",
        message: { text: "Allow this action?" },
        confirmLabel: { text: "Approve" },
        openedAt: "2026-07-30T15:00:00.000Z",
        secret: false,
        destructive: true,
        cancellable: true,
      },
    ],
    attention: {},
  };
}
