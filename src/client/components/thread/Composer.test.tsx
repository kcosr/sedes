// @vitest-environment jsdom

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type {
  AssociatedTask,
  NormalizedDraft,
  NormalizedThreadSnapshot,
} from "../../../shared/index.js";
import { MAXIMUM_COMPOSER_INPUT_BYTES } from "../../../shared/index.js";
import type {
  PendingComposerTransfer,
  ThreadClientState,
  ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { DeliveryRecoveryRequiredError } from "../../stores/ThreadClientStore.js";
import { Composer } from "./Composer.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { CodexTuiTerminalControlContext } from "../../provider-features/codex-tui.js";
import {
  ComposerDraftCoordinator,
  ComposerDraftProvider,
  useComposerDraftStaging,
  useContextExcerptStaging,
} from "../../context-excerpts/coordinator.js";
import type { ContextExcerpt } from "../../../shared/index.js";
import {
  setDiagnosticCategoryEnabled,
  setPromptsPlacement,
  setMobileComposerRefocusAfterSend,
  setRightOptionFocusesComposer,
  setShowPromptsTab,
} from "../../app/settings.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { ApiError } from "../../api/ApiClient.js";
import {
  TASK_DRAG_MIME,
  TaskDragProvider,
  useTaskDrag,
} from "../../tasks/task-drag.js";
import type { NormalizedApplicationSnapshot } from "../../../shared/index.js";

import {
  clearDiagnostics,
  readDiagnostics,
  exportDiagnostics,
} from "../../app/diagnostics.js";

afterEach(() => {
  clearDiagnostics();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

class FakeComposerStore {
  state: ThreadClientState;
  readonly deliver = vi.fn(
    async (
      mode: "submit" | "steer" | "queue",
      draft: NormalizedDraft,
      operationId: string,
    ): Promise<NormalizedDraft> => ({
      ...(mode === "steer" ? this.markSteering(operationId) : {}),
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: draft.revision + 1,
      updatedAt: "2026-07-30T15:01:00.000Z",
    }),
  );
  readonly listSkills = vi.fn(async () => ({
    skills: [
      {
        id: "skill-review",
        name: { text: "review" },
        displayName: { text: "Review Changes" },
        reference: "$review",
        description: { text: "Review the current changes" },
      },
      {
        id: "skill-tests",
        name: { text: "tests" },
        reference: "$tests",
      },
    ],
  }));
  readonly saveDraft = vi.fn(
    async (draft: {
      text: string;
      selectedSkillId?: string;
      contextExcerpts: NormalizedDraft["contextExcerpts"];
      attachments: NormalizedDraft["attachments"];
      taskReferences: NormalizedDraft["taskReferences"];
      revision: number;
    }) => ({
      ...draft,
      revision: draft.revision + 1,
      updatedAt: "2026-07-30T15:01:00.000Z",
    }),
  );
  readonly registerDraftFlush = vi.fn(
    (_flush: () => Promise<NormalizedDraft | undefined>) => () => undefined,
  );
  readonly uploadComposerAttachment = vi.fn(
    async (id: string, file: File, _signal: AbortSignal) =>
      file.type === "image/png"
        ? {
            id,
            fileName: file.name,
            kind: "image" as const,
            mediaType: "image/png" as const,
            byteSize: file.size,
          }
        : {
            id,
            fileName: file.name,
            kind: "file" as const,
            mediaType: "application/octet-stream" as const,
            byteSize: file.size,
          },
  );
  readonly loadComposerAttachmentContent = vi.fn(
    async (_id: string, _signal?: AbortSignal) =>
      new Blob([], { type: "image/png" }),
  );
  readonly #listeners = new Set<() => void>();

  constructor(snapshot: NormalizedThreadSnapshot, draft: string) {
    this.state = {
      status: "ready",
      connection: "connected",
      authoritative: true,
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
      bookmarkStatus: "ready",
      pendingBookmarkTurnIds: [],
      snapshot: {
        ...snapshot,
        draft: {
          text: draft,
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 1,
        },
      },
      stashes: [],
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.state;
  stageComposerTransfer = vi.fn(
    (
      operationId: string,
      mode: "submit" | "steer" | "queue",
      draft: NormalizedDraft,
      capturedPresentation: PendingComposerTransfer["capturedPresentation"] = {},
    ) => {
      const transfer: PendingComposerTransfer = {
        operationId,
        mode,
        captured: draft,
        capturedPresentation,
        startedAt: Date.now(),
        presentationSequence: this.state.pendingComposerTransfers.length + 1,
        baselineThreadRevision:
          this.state.snapshot?.thread?.threadRevision ?? 0,
        baselineOrderedTurnIds: [],
        baselineTailTurnItemIds: [],
        acceptanceEvidence: "none",
        presentation:
          mode === "submit"
            ? "transcript"
            : mode === "steer"
              ? "pending_steer"
              : "pending_queue",
        requestState: "saving",
        authorityState: "client_only",
        ...(mode === "steer" ? { steerPhase: "sending" as const } : {}),
        rollbackRequired: false,
        rollbackApplied: false,
        lateMaterializationRequiresComposerReconciliation: false,
        retainTombstoneAfterRollback: false,
      };
      this.replace({
        pendingComposerTransfers: [
          ...this.state.pendingComposerTransfers,
          transfer,
        ],
      });
    },
  );
  abandonComposerTransfer = vi.fn((operationId: string) => {
    this.replace({
      pendingComposerTransfers: this.state.pendingComposerTransfers.filter(
        (transfer) => transfer.operationId !== operationId,
      ),
    });
  });
  acknowledgeComposerTransferRollback = vi.fn((operationId: string) => {
    const transfer = this.state.pendingComposerTransfers.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (transfer?.retainTombstoneAfterRollback) {
      this.updateTransfer(operationId, {
        rollbackRequired: false,
        rollbackApplied: true,
      });
    } else {
      this.abandonComposerTransfer(operationId);
    }
  });
  acknowledgeLateComposerTransferReconciliation = vi.fn(
    (operationId: string) => {
      this.abandonComposerTransfer(operationId);
    },
  );
  stash = vi.fn(async (_draft: NormalizedDraft): Promise<NormalizedDraft> => ({
    text: "",
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    revision: 2,
  }));
  restoreStash = vi.fn(async (): Promise<NormalizedDraft> => ({
    text: "restored",
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    revision: 2,
  }));
  restoreQueuedInput = vi.fn(
    async (
      _queuedInputId: string,
      draft: NormalizedDraft,
    ): Promise<NormalizedDraft> => ({
      text: "restored queued input",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: draft.revision + 1,
    }),
  );

  replace(next: Partial<ThreadClientState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.#listeners) listener();
  }

  updateTransfer(
    operationId: string,
    patch: Partial<PendingComposerTransfer>,
  ): void {
    this.replace({
      pendingComposerTransfers: this.state.pendingComposerTransfers.map(
        (transfer) =>
          transfer.operationId === operationId
            ? { ...transfer, ...patch }
            : transfer,
      ),
    });
  }

  private markSteering(operationId: string): Record<string, never> {
    const pendingComposerTransfers = this.state.pendingComposerTransfers.map(
      (transfer) =>
        transfer.operationId === operationId
          ? { ...transfer, steerPhase: "steering" as const }
          : transfer,
    );
    this.replace({ pendingComposerTransfers });
    return {};
  }

  replaceDraft(
    draft: Omit<
      NormalizedDraft,
      "contextExcerpts" | "attachments" | "taskReferences"
    > & {
      contextExcerpts?: NormalizedDraft["contextExcerpts"];
      attachments?: NormalizedDraft["attachments"];
      taskReferences?: NormalizedDraft["taskReferences"];
    },
  ): void {
    this.replace({
      snapshot: {
        ...this.state.snapshot!,
        draft: {
          ...draft,
          contextExcerpts: draft.contextExcerpts ?? [],
          attachments: draft.attachments ?? [],
          taskReferences: draft.taskReferences ?? [],
        },
      },
    });
  }
}

function type(text: string): void {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

function snapshot(
  runState: "idle" | "running" | "stopping" = "idle",
  submitAvailable = true,
): NormalizedThreadSnapshot {
  return {
    runState,
    draft: {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 1,
    },
    queue: [],
    composerCommands: [],
    usage: { context: { usedTokens: 0, windowTokens: 100 } },
    attention: {},
    capabilities: {
      backend: { label: { text: "Pi" } },
      interactionMode: "interactive",
      runState,
      revision: "composer-test",
      deliveryModes: [
        { id: "submit", steerTarget: null, label: { text: "Send" }, available: submitAvailable },
      ],
      operations: [],
      settings: [],
      composerActions: [],
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: { availability: "available" },
        nativeImage: { availability: "available" },
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
      interactions: [],
      providerFeatures: [],
      history: { available: true, paginated: false },
      automation: {
        available: false,
        canAttach: false,
        canRunNow: false,
        canCloneOnRun: false,
      },
    },
  } as unknown as NormalizedThreadSnapshot;
}

function pressEnter(store: FakeComposerStore): void {
  fireEvent.keyDown(screen.getByRole("textbox"), {
    key: "Enter",
    code: "Enter",
    shiftKey: false,
  });
}

const contextExcerpt: ContextExcerpt = {
  id: "523c40d9-da35-4e28-ae02-c858f03217f4",
  excerpt: "const answer = 42;",
  source: {
    kind: "workspace_file",
    rootId: "primary",
    path: "src/answer.ts",
    revision: "revision-1",
  },
  locator: { kind: "line_range", startLine: 7, endLine: 7 },
};

const consumedContextExcerpt: ContextExcerpt = {
  ...contextExcerpt,
  id: "24a715f8-2088-427b-b50d-246382a87211",
  excerpt: "const prior = 1;",
  source: {
    kind: "workspace_file",
    rootId: "primary",
    path: "src/prior.ts",
    revision: "revision-1",
  },
};

const conversationContextExcerpt: ContextExcerpt = {
  id: "8a45389e-dfd1-4bef-9615-1f9d06e3af5a",
  excerpt: "Use the earlier settled response.",
  source: {
    kind: "conversation_message",
    itemId: "normalized-assistant-item-1",
    itemRevision: 5,
  },
  locator: {
    kind: "text_quote",
    prefix: "Before ",
    suffix: " after.",
  },
};

function seedContextExcerpt(
  store: FakeComposerStore,
  excerpt: ContextExcerpt,
): void {
  store.state = {
    ...store.state,
    snapshot: {
      ...store.state.snapshot!,
      draft: {
        ...store.state.snapshot!.draft,
        contextExcerpts: [excerpt],
      },
    },
  };
}

function ContextExcerptFixture({
  note,
  excerpt = contextExcerpt,
}: {
  readonly note?: string;
  readonly excerpt?: ContextExcerpt;
}) {
  const staging = useContextExcerptStaging();
  return (
    <button
      type="button"
      onClick={() => staging?.stage({ ...excerpt, ...(note ? { note } : {}) })}
    >
      Attach fixture
    </button>
  );
}

function ImmediateContextExcerptFixture({
  excerpt,
}: {
  readonly excerpt: ContextExcerpt;
}) {
  const staging = useContextExcerptStaging();
  const [reason, setReason] = useState<string>();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const result = staging?.attachAndSubmit(excerpt);
          setReason(result && !result.ok ? result.reason : undefined);
        }}
      >
        Attach and send fixture
      </button>
      {reason && <span role="alert">{reason}</span>}
    </>
  );
}

function TaskReferenceFixture() {
  const staging = useComposerDraftStaging();
  return (
    <button
      type="button"
      onClick={() =>
        staging?.stageTaskReference({
          taskId: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
          titleSnapshot: "Fallback title",
        })
      }
    >
      Attach task fixture
    </button>
  );
}

function applicationStore(
  tasks: readonly Record<string, unknown>[],
  authoritative = true,
): ApplicationClientStore {
  const state = {
    status: "ready" as const,
    connection: "connected" as const,
    authoritative,
    search: "",
    visibleThreads: [],
    snapshot: { tasks },
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    getTasks: () => tasks,
  } as unknown as ApplicationClientStore;
}

function applicationStoreWithPrompts(): ApplicationClientStore {
  const applicationState = {
    status: "ready" as const,
    connection: "connected" as const,
    authoritative: true,
    search: "",
    visibleThreads: [],
    snapshot: { tasks: [] },
  };
  const promptState = {
    status: "ready" as const,
    library: {
      revision: 1,
      items: [
        {
          id: "cfa296f1-61a9-4072-9f10-f983a8b9475f",
          title: "Review changes",
          text: "Review the current changes.",
          position: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    updateAvailable: false,
    pendingMutation: false,
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => applicationState,
    refresh: vi.fn(async () => undefined),
    cannedPrompts: {
      subscribe: () => () => undefined,
      getSnapshot: () => promptState,
      load: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      revalidate: vi.fn(async () => undefined),
      applyAvailableUpdate: vi.fn(() => false),
    },
  } as unknown as ApplicationClientStore;
}

function refreshableApplicationStore(
  initialTasks: readonly Record<string, unknown>[],
  refreshedTasks: readonly Record<string, unknown>[],
): ApplicationClientStore & { refresh: ReturnType<typeof vi.fn> } {
  const listeners = new Set<() => void>();
  let state = {
    status: "ready" as const,
    connection: "connected" as const,
    authoritative: true,
    search: "",
    visibleThreads: [],
    snapshot: { tasks: initialTasks },
  };
  const refresh = vi.fn(async () => {
    state = { ...state, snapshot: { tasks: refreshedTasks } };
    for (const listener of listeners) listener();
  });
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    refresh,
  } as unknown as ApplicationClientStore & {
    refresh: ReturnType<typeof vi.fn>;
  };
}

function renderTaskComposerWithApplicationStore(
  store: FakeComposerStore,
  taskStore: ApplicationClientStore,
) {
  return render(
    <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
      <TaskReferenceFixture />
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={taskStore}
      />
    </ComposerDraftProvider>,
  );
}

function renderTaskComposer(
  store: FakeComposerStore,
  tasks: readonly Record<string, unknown>[],
  authoritative = true,
) {
  return render(
    <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
      <TaskReferenceFixture />
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStore(tasks, authoritative)}
      />
    </ComposerDraftProvider>,
  );
}

function renderComposerWithContext(
  store: FakeComposerStore,
  note?: string,
  excerpt?: ContextExcerpt,
): ReturnType<typeof render> {
  return render(
    <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
      <ContextExcerptFixture note={note} excerpt={excerpt} />
      <Composer store={store as unknown as ThreadClientStore} />
    </ComposerDraftProvider>,
  );
}

function dispatchWindowKeyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = createEvent.keyDown(window, init) as KeyboardEvent;
  fireEvent(window, event);
  return event;
}

function TaskDragTestSource({ task }: { readonly task: AssociatedTask }) {
  const taskDrag = useTaskDrag();
  return (
    <button
      type="button"
      draggable
      aria-label="Task drag source"
      onDragStart={(event) => taskDrag?.beginTaskDrag(task, event.dataTransfer)}
      onDragEnd={() => taskDrag?.endTaskDrag()}
    >
      Task
    </button>
  );
}

describe("task references", () => {
  const task: AssociatedTask = {
    id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
    scope: { kind: "global" },
    associatedWorkspaceId: null,
    title: "Current task title",
    details: "Current details",
    pinned: false,
    files: [],
    completedAt: null,
    revision: 2,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
  };

  it("copies a dragged task into the prompt without moving it", () => {
    const store = new FakeComposerStore(snapshot(), "keep this text");
    const taskStore = applicationStore([task]);
    const applicationSnapshot = {
      tasks: [task],
      threads: [],
      workspaces: [],
      environments: [],
      groups: [],
      forkOrigins: [],
      lineagePlacements: [],
      lineageFamilies: [],
      executionTargets: [],
      advisories: [],
      defaultNewThreadTargetId: null,
      counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
    } as unknown as NormalizedApplicationSnapshot;
    render(
      <TaskDragProvider store={taskStore} snapshot={applicationSnapshot}>
        <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
          <Composer
            store={store as unknown as ThreadClientStore}
            applicationStore={taskStore}
          />
        </ComposerDraftProvider>
      </TaskDragProvider>,
    );
    const encoded = JSON.stringify({
      version: 1,
      taskId: task.id,
      revision: task.revision,
    });
    const dataTransfer = {
      types: [TASK_DRAG_MIME],
      items: [],
      files: [],
      dropEffect: "none",
      getData: vi.fn((type: string) =>
        type === TASK_DRAG_MIME ? encoded : "",
      ),
    } as unknown as DataTransfer;
    const composer = screen.getByTestId("composer");

    fireEvent.dragEnter(composer, { dataTransfer });
    expect(composer).toHaveClass("task-drag-active");
    fireEvent.drop(composer, { dataTransfer });

    expect(screen.getByLabelText("Attached tasks")).toHaveTextContent(
      "Current task title",
    );
    expect(screen.getByRole("textbox")).toHaveValue("keep this text");
    expect(taskStore.moveTask).toBeUndefined();
  });

  it("clears its task drop treatment when a drag is cancelled", async () => {
    const store = new FakeComposerStore(snapshot(), "keep this text");
    const taskStore = applicationStore([task]);
    const applicationSnapshot = {
      tasks: [task],
      threads: [],
      workspaces: [],
      environments: [],
      groups: [],
      forkOrigins: [],
      lineagePlacements: [],
      lineageFamilies: [],
      executionTargets: [],
      advisories: [],
      defaultNewThreadTargetId: null,
      counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
    } as unknown as NormalizedApplicationSnapshot;
    render(
      <TaskDragProvider store={taskStore} snapshot={applicationSnapshot}>
        <TaskDragTestSource task={task} />
        <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
          <Composer
            store={store as unknown as ThreadClientStore}
            applicationStore={taskStore}
          />
        </ComposerDraftProvider>
      </TaskDragProvider>,
    );
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
    const source = screen.getByRole("button", { name: "Task drag source" });
    const composer = screen.getByTestId("composer");

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragEnter(composer, { dataTransfer });
    expect(composer).toHaveClass("task-drag-active");
    fireEvent.dragEnd(source, { dataTransfer });

    await waitFor(() => expect(composer).not.toHaveClass("task-drag-active"));
  });

  it("stages a task-only chip without changing text and sends it", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    renderTaskComposer(store, [task]);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByText("Current task title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalled());
    expect(store.deliver.mock.calls[0]?.[1].taskReferences).toEqual([
      {
        taskId: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
        titleSnapshot: "Fallback title",
      },
    ]);
  });

  it("shows an authoritative missing task and blocks delivery", () => {
    const store = new FakeComposerStore(snapshot(), "");
    renderTaskComposer(store, []);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );

    expect(screen.getByText("Fallback title")).toBeInTheDocument();
    expect(screen.getByText("Missing task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("uses live completion and checking states without replacing the draft snapshot", () => {
    const completedStore = new FakeComposerStore(snapshot(), "");
    const completedView = renderTaskComposer(completedStore, [
      {
        ...task,
        title: "Renamed after attachment",
        completedAt: "2026-08-03T10:00:00.000Z",
      },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );

    const completedChip = completedView.container.querySelector(
      '[aria-label="Attached tasks"] [data-state="completed"]',
    );
    expect(completedChip).toHaveTextContent("Renamed after attachment");
    expect(completedStore.state.snapshot?.draft.taskReferences).toEqual([]);

    completedView.unmount();
    const checkingStore = new FakeComposerStore(snapshot(), "");
    const checkingView = renderTaskComposer(checkingStore, [], false);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );
    expect(
      checkingView.container.querySelector(
        '[aria-label="Attached tasks"] [data-state="checking"]',
      ),
    ).toHaveTextContent("Fallback title");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("labels a task-only stash with its snapshot title and task count", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.replace({
      stashes: [
        {
          id: "task-stash",
          text: "",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [
            {
              taskId: task.id,
              titleSnapshot: "Task title at stash time",
            },
            {
              taskId: "22222222-2222-4222-8222-222222222222",
              titleSnapshot: "Second task title",
            },
          ],
          createdAt: "2026-08-03T10:00:00.000Z",
        },
        {
          id: "blank-title-task-stash",
          text: "",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [
            {
              taskId: "11111111-1111-4111-8111-111111111111",
              titleSnapshot: "   ",
            },
          ],
          createdAt: "2026-08-03T09:00:00.000Z",
        },
      ],
    });
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open 2 stashed prompts" }),
    );
    const stash = await screen.findByRole("menuitem", {
      name: /Task title at stash time/u,
    });
    expect(stash).toHaveTextContent("Task title at stash time");
    expect(stash).toHaveTextContent("2 tasks");
    expect(stash).not.toHaveTextContent("Empty prompt");
    expect(
      screen.getByRole("menuitem", { name: /^1 task/u }),
    ).not.toHaveTextContent("Empty prompt");
  });

  it("adopts a renamed server descriptor and consumes it by identity through stash", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.saveDraft.mockImplementationOnce(async (draft) => ({
      ...draft,
      taskReferences: [
        {
          taskId: task.id,
          titleSnapshot: "Canonical title after rename",
        },
      ],
      revision: draft.revision + 1,
      updatedAt: "2026-08-03T10:00:00.000Z",
    }));
    renderTaskComposer(store, [task]);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(store.stash).toHaveBeenCalledOnce());
    expect(store.stash.mock.calls[0]?.[0].taskReferences).toEqual([
      {
        taskId: task.id,
        titleSnapshot: "Canonical title after rename",
      },
    ]);
    expect(screen.queryByLabelText("Attached tasks")).not.toBeInTheDocument();
  });

  it("keeps a canonical rename clean through a retained delivery receipt", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.saveDraft.mockImplementationOnce(async (draft) => ({
      ...draft,
      taskReferences: [
        {
          taskId: task.id,
          titleSnapshot: "Canonical title after rename",
        },
      ],
      revision: draft.revision + 1,
      updatedAt: "2026-08-03T10:00:00.000Z",
    }));
    store.deliver.mockImplementationOnce(async (_mode, draft) => ({
      ...draft,
      revision: draft.revision + 1,
      updatedAt: "2026-08-03T10:01:00.000Z",
    }));
    const view = renderTaskComposer(store, [task]);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach task fixture" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledOnce();
  });

  it.each(["save", "delivery"] as const)(
    "refreshes stale task availability after unresolved %s",
    async (phase) => {
      const store = new FakeComposerStore(snapshot(), "");
      const taskStore = refreshableApplicationStore([task], []);
      const unresolved = new ApiError(
        409,
        "task_reference_unresolved",
        "The task no longer exists.",
        false,
      );
      if (phase === "save") {
        store.saveDraft.mockRejectedValueOnce(unresolved);
      } else {
        store.deliver.mockRejectedValueOnce(unresolved);
      }
      renderTaskComposerWithApplicationStore(store, taskStore);
      fireEvent.click(
        screen.getByRole("button", { name: "Attach task fixture" }),
      );
      expect(
        document.querySelector('[data-state="available"]'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => expect(taskStore.refresh).toHaveBeenCalledOnce());
      expect(screen.getByText("Missing task")).toBeInTheDocument();
      expect(
        screen.getByText("Remove the missing task before sending."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("This draft changed in another client"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    },
  );
});

describe("Composer textarea sizing", () => {
  it("remeasures wrapped text on width changes without looping on height changes", () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly entry: (typeof observers)[number];
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: new Set() };
          observers.push(this.entry);
        }
        observe(target: Element): void {
          this.entry.targets.add(target);
        }
        unobserve(target: Element): void {
          this.entry.targets.delete(target);
        }
        disconnect(): void {
          this.entry.targets.clear();
        }
      },
    );
    render(
      <Composer
        store={
          new FakeComposerStore(
            snapshot(),
            "A multiline draft that wraps as the panel narrows",
          ) as unknown as ThreadClientStore
        }
      />,
    );
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    let measuredScrollHeight = 80;
    const scrollHeight = vi.fn(() => measuredScrollHeight);
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: scrollHeight,
    });
    const observer = observers.find(({ targets }) => targets.has(input));
    expect(observer).toBeDefined();

    act(() => {
      observer!.callback(
        [
          {
            target: input,
            contentRect: { width: 320 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    expect(input.style.height).toBe("80px");
    expect(scrollHeight).toHaveBeenCalledTimes(1);

    measuredScrollHeight = 140;
    act(() => {
      observer!.callback(
        [
          {
            target: input,
            contentRect: { width: 320 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    expect(input.style.height).toBe("80px");
    expect(scrollHeight).toHaveBeenCalledTimes(1);

    act(() => {
      observer!.callback(
        [
          {
            target: input,
            contentRect: { width: 220 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    expect(input.style.height).toBe("140px");
    expect(scrollHeight).toHaveBeenCalledTimes(2);
  });
});

describe("Composer delivery guards", () => {
  it.each(["", "Send this once"])(
    "chooses and remembers Queue with draft %j",
    async (text) => {
      const active = snapshot("running");
      active.capabilities.deliveryModes = [
        { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
        { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
      ];
      const store = new FakeComposerStore(active, text);
      const view = render(
        <Composer store={store as unknown as ThreadClientStore} />,
      );
      fireEvent.keyDown(screen.getByRole("button", { name: "Delivery mode" }), {
        key: "ArrowDown",
      });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Queue" }));
      expect(localStorage.getItem("sedes-composer-delivery-mode")).toBe(
        "queue",
      );
      expect(store.deliver).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
        text,
      );
      if (text) {
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));
        await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
        expect(store.deliver.mock.calls[0]?.[0]).toBe("queue");
      } else {
        view.unmount();
        render(<Composer store={store as unknown as ThreadClientStore} />);
      }
      expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    },
  );

  it("preserves Steer through temporary unavailability and keeps Queue selectable", async () => {
    const active = { ...snapshot("running"), runState: "starting" as const };
    active.capabilities.deliveryModes = [
      { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: false },
      { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
    ];
    const store = new FakeComposerStore(active, "draft");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Delivery mode" }), {
      key: "ArrowDown",
    });
    expect(
      await screen.findByRole("menuitem", { name: "Queue" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Queue" }), {
      key: "Escape",
    });
    const running = {
      ...store.state.snapshot!,
      runState: "running" as const,
      capabilities: {
        ...active.capabilities,
        deliveryModes: active.capabilities.deliveryModes.map((mode) => ({
          ...mode,
          available: true,
        })),
      },
    };
    act(() => store.replace({ snapshot: running }));
    expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled();
    expect(localStorage.getItem("sedes-composer-delivery-mode")).toBeNull();
  });

  it("uses Queue when Steer is unsupported without replacing the saved preference", async () => {
    localStorage.setItem("sedes-composer-delivery-mode", "steer");
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
    ];
    const store = new FakeComposerStore(active, "draft");
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    expect(screen.getByRole("button", { name: "Queue" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Delivery mode" }), {
      key: "ArrowDown",
    });
    expect(
      await screen.findByRole("menuitem", { name: "Queue" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Steer" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("sedes-composer-delivery-mode")).toBe("steer");
    view.unmount();
    active.capabilities.deliveryModes.push({
      id: "steer",
      steerTarget: "turn" as const,
      label: { text: "Steer" },
      available: true,
    });
    render(
      <Composer
        store={
          new FakeComposerStore(active, "draft") as unknown as ThreadClientStore
        }
      />,
    );
    expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled();
  });

  it("preserves local typing and activity while run-state action capabilities catch up", () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [{ id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true }];
    const store = Object.assign(new FakeComposerStore(active, "draft"), { awaitingRunStateCapabilities: false });
    const { container } = render(<Composer store={store as unknown as ThreadClientStore} />);
    const input = screen.getByRole("textbox");
    input.focus();
    act(() => {
      store.awaitingRunStateCapabilities = true;
      store.replace({ authoritative: false });
    });
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    expect(container.querySelector(".input-activity-bar")).toHaveClass("visible");
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "kept typing" } });
    expect(input).toHaveValue("kept typing");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    act(() => {
      store.awaitingRunStateCapabilities = false;
      store.replace({ authoritative: true });
    });
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled();
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("shows activity optimistically from Send until the submitted message settles", () => {
    const store = new FakeComposerStore(snapshot("idle"), "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    const activityBar = container.querySelector(".input-activity-bar");
    expect(activityBar).not.toHaveClass("visible");
    const draft = { text: "Start", contextExcerpts: [], attachments: [], taskReferences: [], revision: 1 };
    act(() => store.stageComposerTransfer("submit-in-flight", "submit", draft));
    expect(activityBar).toHaveClass("visible");
    act(() => store.updateTransfer("submit-in-flight", { requestState: "request_failed" }));
    expect(activityBar).not.toHaveClass("visible");
    act(() => store.updateTransfer("submit-in-flight", { requestState: "receipt_received" }));
    expect(activityBar).toHaveClass("visible");
    act(() => store.updateTransfer("submit-in-flight", { authorityState: "materialized" }));
    expect(activityBar).not.toHaveClass("visible");
    // Queued input is waiting, not being worked on.
    act(() => store.stageComposerTransfer("queued", "queue", draft));
    expect(activityBar).not.toHaveClass("visible");
  });

  it("suppresses stale activity while reconnecting until live authority returns", () => {
    const store = new FakeComposerStore(snapshot("running"), "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    const activityBar = container.querySelector(".input-activity-bar");

    expect(activityBar).toHaveClass("visible");

    act(() => {
      store.replace({ connection: "reconnecting", authoritative: false });
    });
    expect(activityBar).not.toHaveClass("visible");

    act(() => store.replace({ connection: "connected" }));
    expect(activityBar).not.toHaveClass("visible");

    act(() => store.replace({ authoritative: true }));
    expect(activityBar).toHaveClass("visible");
  });

  it("keeps a healthy submit queue row visible while Codex TUI hides the transcript", () => {
    const queuedSnapshot: NormalizedThreadSnapshot = {
      ...snapshot(),
      queue: [
        {
          id: "queued-submit",
          deliveryOperationId: "submit-operation",
          sequence: 1,
          state: "dispatching",
          deliveryMode: "submit",
          resolvedDeliveryMode: "submit",
          origin: "user",
          isHead: true,
          preview: { text: "Immediate submit" },
          attachmentCount: 0,
          taskCount: 0,
          createdAt: "2026-08-08T01:00:00.000Z",
        },
      ],
    };
    const store = new FakeComposerStore(queuedSnapshot, "Immediate submit");
    store.stageComposerTransfer(
      "submit-operation",
      "submit",
      store.state.snapshot!.draft,
    );

    const view = render(
      <ChatViewVisibilityContext.Provider value={false}>
        <Composer store={store as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );

    expect(
      document.querySelector('[data-delivery-operation-id="submit-operation"]'),
    ).toHaveTextContent("Sending");

    view.rerender(
      <ChatViewVisibilityContext.Provider value>
        <Composer store={store as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );
    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();
  });

  it("persists an empty dirty draft, blocks same-tab edits, and installs a structured queued input", async () => {
    // A focus attempt made inside the restoration promise would run against a
    // disabled textarea and be lost before React commits the unlocked state.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    const queuedSnapshot: NormalizedThreadSnapshot = {
      ...snapshot(),
      queue: [
        {
          id: "queued-1",
          deliveryOperationId: "delivery-queued-1",
          sequence: 1,
          state: "pending",
          resolvedDeliveryMode: "queue",
          origin: "user",
          isHead: true,
          preview: { text: "Restore this prompt" },
          attachmentCount: 1,
          taskCount: 0,
          createdAt: "2026-08-08T01:00:00.000Z",
        },
      ],
    };
    const store = new FakeComposerStore(queuedSnapshot, "clear me");
    let releaseRestore!: (draft: NormalizedDraft) => void;
    store.restoreQueuedInput.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseRestore = resolve;
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);
    type("");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Restore queued input to composer: Restore this prompt",
      }),
    );

    await waitFor(() =>
      expect(store.restoreQueuedInput).toHaveBeenCalledWith(
        "queued-1",
        expect.objectContaining({
          text: "",
          contextExcerpts: [],
          attachments: [],
          revision: 2,
        }),
      ),
    );
    expect(store.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", revision: 1 }),
    );
    const textbox = screen.getByRole("textbox");
    expect(textbox).toBeDisabled();
    fireEvent.change(textbox, { target: { value: "must not be lost" } });
    expect(textbox).toHaveValue("");

    act(() => store.replace({ authoritative: false }));
    await act(async () =>
      releaseRestore({
        text: "restored with structure",
        selectedSkillId: "skill-review",
        contextExcerpts: [contextExcerpt],
        taskReferences: [],
        attachments: [
          {
            id: "d0739b85-4f1b-4c40-b364-51e5093f128b",
            fileName: "diagram.png",
            kind: "image",
            mediaType: "image/png",
            byteSize: 128,
          },
        ],
        revision: 3,
      }),
    );

    expect(textbox).toHaveValue("restored with structure");
    expect(textbox).toBeDisabled();
    expect(textbox).not.toHaveFocus();
    expect(screen.getByTestId("selected-skill")).toHaveTextContent(
      "Review Changes",
    );
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    act(() => store.replace({ authoritative: true }));
    expect(textbox).toBeEnabled();
    await waitFor(() => expect(textbox).toHaveFocus());
  });

  it("does not overwrite a retained pending-Steer recovery draft when Restore looks empty", () => {
    const queuedSnapshot: NormalizedThreadSnapshot = {
      ...snapshot("running"),
      queue: [
        {
          id: "queued-1",
          deliveryOperationId: "delivery-queued-1",
          sequence: 1,
          state: "pending",
          resolvedDeliveryMode: "queue",
          origin: "user",
          isHead: true,
          preview: { text: "Restore this prompt" },
          attachmentCount: 0,
          taskCount: 0,
          createdAt: "2026-08-08T01:00:00.000Z",
        },
      ],
    };
    const store = new FakeComposerStore(queuedSnapshot, "Retained by Pi");
    store.replaceDraft({
      text: "Retained by Pi",
      attachments: [
        {
          id: "d0739b85-4f1b-4c40-b364-51e5093f128b",
          fileName: "retained.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: 128,
        },
      ],
      revision: 1,
    });
    store.state = {
      ...store.state,
      pendingComposerTransfers: [
        {
          operationId: "pending-steer-1",
          mode: "steer",
          captured: store.state.snapshot!.draft,
          capturedPresentation: {},
          startedAt: Date.now(),
          presentationSequence: 1,
          baselineThreadRevision: 0,
          baselineOrderedTurnIds: [],
          baselineTailTurnItemIds: [],
          acceptanceEvidence: "accepted",
          presentation: "pending_steer",
          requestState: "receipt_received",
          authorityState: "client_only",
          steerPhase: "steering",
          rollbackRequired: false,
          rollbackApplied: false,
          lateMaterializationRequiresComposerReconciliation: false,
          retainTombstoneAfterRollback: false,
        },
      ],
    };

    render(<Composer store={store as unknown as ThreadClientStore} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
    const restore = screen.getByRole("button", {
      name: "Restore queued input to composer: Restore this prompt",
    });
    expect(restore).toBeDisabled();
    expect(restore).toHaveAttribute(
      "title",
      "Wait for the retained delivery draft to settle before restoring a queued input.",
    );
    fireEvent.click(restore);
    expect(store.saveDraft).not.toHaveBeenCalled();
    expect(store.restoreQueuedInput).not.toHaveBeenCalled();
    expect(store.state.snapshot?.draft.text).toBe("Retained by Pi");
    expect(store.state.snapshot?.draft.attachments).toHaveLength(1);
  });

  it("uploads a picked file before linking and delivering its durable reference", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    const file = new File(["payload"], "notes.bin", {
      type: "application/octet-stream",
    });

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await screen.findByText("notes.bin");
    await waitFor(() =>
      expect(store.uploadComposerAttachment).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    expect(store.deliver.mock.calls[0]![1].attachments).toEqual([
      expect.objectContaining({ fileName: "notes.bin", byteSize: file.size }),
    ]);
  });

  it("keeps the verified local thumbnail while draft linking is delayed", async () => {
    vi.useFakeTimers();
    try {
      const createObjectURL = vi.fn(() => "blob:composer-local-preview");
      vi.stubGlobal("URL", {
        ...URL,
        createObjectURL,
        revokeObjectURL: vi.fn(),
      });
      const store = new FakeComposerStore(snapshot(), "");
      let releaseSave!: () => void;
      store.saveDraft.mockImplementation(
        (draft) =>
          new Promise((resolve) => {
            releaseSave = () =>
              resolve({
                ...draft,
                revision: draft.revision + 1,
                updatedAt: "2026-07-30T15:01:00.000Z",
              });
          }),
      );
      const { container } = render(
        <Composer store={store as unknown as ThreadClientStore} />,
      );
      const file = new File(
        [
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
            0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
          ]),
        ],
        "preview.png",
        { type: "image/png" },
      );

      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [file] },
      });
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(store.uploadComposerAttachment).toHaveBeenCalledOnce();
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:composer-local-preview",
      );

      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:composer-local-preview",
      );
      expect(store.loadComposerAttachmentContent).not.toHaveBeenCalled();

      await act(async () => releaseSave());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an admitted native picker selection across stream suspension and orders Skill before Attach", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    const skillButton = screen.getByRole("button", { name: "Choose skill" });
    const attachmentButton = screen.getByRole("button", {
      name: "Attach files",
    });
    expect(
      skillButton.compareDocumentPosition(attachmentButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(attachmentButton);
    act(() => {
      store.replace({ connection: "reconnecting", authoritative: false });
    });
    expect(attachmentButton).toBeDisabled();

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["payload"], "resume.bin")] },
    });

    await screen.findByText("resume.bin");
    await waitFor(() =>
      expect(store.uploadComposerAttachment).toHaveBeenCalledOnce(),
    );
    expect(
      screen.queryByText("The message composer is unavailable."),
    ).not.toBeInTheDocument();
  });

  it("accepts focused paste and composer drop without replacing prompt text", async () => {
    const store = new FakeComposerStore(snapshot(), "keep this text");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    const input = screen.getByRole("textbox");

    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(["one"], "pasted.bin")],
      },
    });
    await screen.findByText("pasted.bin");

    fireEvent.drop(screen.getByTestId("composer"), {
      dataTransfer: {
        files: [new File(["two"], "dropped.bin")],
        items: [{ kind: "file" }],
      },
    });
    await screen.findByText("dropped.bin");

    expect(input).toHaveValue("keep this text");
    expect(store.uploadComposerAttachment).toHaveBeenCalledTimes(2);
  });

  it("rejects a fifth image before upload while retaining the four-image allowance", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    const files = Array.from(
      { length: 5 },
      (_, index) =>
        new File([`image-${index}`], `image-${index}.png`, {
          type: "image/png",
        }),
    );

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "at most 4 images",
    );
    await waitFor(() =>
      expect(store.uploadComposerAttachment).toHaveBeenCalledTimes(4),
    );
  });

  it("blocks delivery and stash until an upload is removed", async () => {
    let uploadSignal: AbortSignal | undefined;
    const store = new FakeComposerStore(snapshot(), "");
    store.replace({
      stashes: [
        {
          id: "stash-during-upload",
          text: "restore later",
          contextExcerpts: [],
          taskReferences: [],
          attachments: [],
          createdAt: "2026-07-30T14:00:00.000Z",
        },
      ],
    });
    store.uploadComposerAttachment.mockImplementation(
      async (_id, _file, signal) => {
        uploadSignal = signal;
        return await new Promise<never>(() => undefined);
      },
    );
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open 1 stashed prompts" }),
    );
    const restoreButton = await screen.findByRole("menuitem", {
      name: /restore later/u,
    });
    expect(restoreButton).toBeEnabled();
    type("send after removal");
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["data"], "pending.bin")] },
    });
    await screen.findByText("pending.bin");
    await waitFor(() => expect(uploadSignal).toBeDefined());

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Open 1 stashed prompts" }),
    ).toBeDisabled();
    expect(restoreButton).toBeDisabled();
    const registeredFlush = store.registerDraftFlush.mock.calls.at(-1)?.[0];
    expect(registeredFlush).toBeDefined();
    await expect(registeredFlush!()).rejects.toThrow(
      "Wait for attachment uploads to finish",
    );
    expect(store.saveDraft).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove attachment: pending.bin" }),
    );

    expect(uploadSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Open 1 stashed prompts" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: /restore later/u }),
    ).toBeEnabled();
  });

  it("stages context into the canonical draft and requires a request before send", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    type("Please explain this");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "Please explain this",
        contextExcerpts: [contextExcerpt],
        taskReferences: [],
        attachments: [],
        revision: 1,
      }),
    );
  });

  it("allows an annotated context-only request and removes attached context", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    renderComposerWithContext(store, "Explain the behavior");

    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove answer.ts" }));
    expect(screen.queryByText("answer.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it.each(["submit", "steer", "queue"] as const)("merges a noted excerpt with the draft and uses the composer %s action", async (mode) => {
    const active = snapshot(mode === "submit" ? "idle" : "running");
    if (mode !== "submit") localStorage.setItem("sedes-composer-delivery-mode", mode);
    active.capabilities.deliveryModes = mode === "submit"
      ? [{ id: "submit", steerTarget: null, label: { text: "Send" }, available: true }]
      : [
          { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
          { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
        ];
    const store = new FakeComposerStore(active, "Review this draft");
    store.replaceDraft({
      text: "Review this draft",
      contextExcerpts: [consumedContextExcerpt],
      revision: 1,
    });
    const immediateExcerpt = {
      ...contextExcerpt,
      note: "Explain this selection.",
    };
    render(
      <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
        <ImmediateContextExcerptFixture excerpt={immediateExcerpt} />
        <Composer store={store as unknown as ThreadClientStore} />
      </ComposerDraftProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Attach and send fixture" }),
    );
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    expect(store.deliver.mock.calls[0]?.[0]).toBe(mode);
    expect(store.deliver.mock.calls[0]?.[1]).toMatchObject({
      text: "Review this draft",
      contextExcerpts: [consumedContextExcerpt, immediateExcerpt],
    });
    expect(screen.queryByText("answer.ts")).not.toBeInTheDocument();
  });

  it("keeps the context-excerpt consumer registered while typing", () => {
    const registerConsumer = vi.spyOn(
      ComposerDraftCoordinator.prototype,
      "registerConsumer",
    );
    const store = new FakeComposerStore(snapshot(), "");
    renderComposerWithContext(store);

    expect(registerConsumer).toHaveBeenCalledOnce();
    type("Keep this registration stable");
    expect(registerConsumer).toHaveBeenCalledOnce();
  });

  it("rejects an unavailable active-thread delivery without staging or clearing the draft", () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: false },
    ];
    const store = new FakeComposerStore(active, "Keep this draft");
    const immediateExcerpt = {
      ...contextExcerpt,
      note: "Explain this selection.",
    };
    render(
      <ComposerDraftProvider threadId="thread-1" workspaceId="workspace-1">
        <ImmediateContextExcerptFixture excerpt={immediateExcerpt} />
        <Composer store={store as unknown as ThreadClientStore} />
      </ComposerDraftProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Attach and send fixture" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The composer’s current send action is unavailable for this thread.",
    );
    expect(store.deliver).not.toHaveBeenCalled();
    expect(screen.queryByText("answer.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "Keep this draft",
    );
  });

  it("keeps context staged while an earlier delivery is in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
            });
        }),
    );
    const view = renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    expect(screen.getByText("answer.ts")).toBeInTheDocument();

    await act(async () => releaseDeliver());
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "",
      contextExcerpts: [contextExcerpt],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("stages Steer feedback and clears atomically before draft persistence", async () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
    ];
    const store = new FakeComposerStore(active, "");
    let releaseSave!: () => void;
    store.saveDraft.mockImplementationOnce(
      (draft) =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ...draft,
              revision: draft.revision + 1,
              updatedAt: "2026-07-30T15:01:00.000Z",
            });
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    type("Steer while the tool runs");
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(screen.getByText("Sending steer")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(store.deliver).not.toHaveBeenCalled();

    await waitFor(() => expect(store.saveDraft).toHaveBeenCalledOnce());
    await act(async () => releaseSave());
    await waitFor(() => expect(screen.getByText("Steering")).toBeVisible());
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("stages idle Send with one operation ID and clears before draft persistence", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    let releaseSave!: () => void;
    store.saveDraft.mockImplementationOnce(
      (draft) =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ...draft,
              revision: draft.revision + 1,
              updatedAt: "2026-08-13T20:00:00.000Z",
            });
        }),
    );
    const onImmediateSend = vi.fn();
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        onImmediateSend={onImmediateSend}
      />,
    );

    type("instant message");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(store.stageComposerTransfer).toHaveBeenCalledOnce();
    expect(store.state.pendingComposerTransfers[0]?.captured.text).toBe(
      "instant message",
    );
    const operationId = store.state.pendingComposerTransfers[0]!.operationId;
    expect(onImmediateSend).toHaveBeenCalledWith(operationId);
    expect(store.deliver).not.toHaveBeenCalled();

    await waitFor(() => expect(store.saveDraft).toHaveBeenCalledOnce());
    await act(async () => releaseSave());
    await waitFor(() =>
      expect(store.deliver).toHaveBeenCalledWith(
        "submit",
        expect.objectContaining({ text: "instant message" }),
        operationId,
      ),
    );
  });

  it("discards late dictation without copying content or changing focus", async () => {
    setDiagnosticCategoryEnabled("composer_input", true);
    const store = new FakeComposerStore(snapshot(), "private dictated message");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.compositionStart(input, { data: "private dictated message" });
    const send = screen.getByRole("button", { name: "Send message" });
    fireEvent.pointerDown(send);
    fireEvent.click(send);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    fireEvent.compositionEnd(input, { data: "private late sentence" });
    fireEvent.input(input, {
      target: { value: "private late sentence" },
      data: "private late sentence",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    const events = readDiagnostics().map(({ event }) => event);
    expect(events).toEqual(
      expect.arrayContaining([
        "focus",
        "compositionstart",
        "send_pointerdown",
        "send_click",
        "send_captured",
        "send_cleared",
        "send_refocus",
        "compositionend",
        "input",
        "composition_update_discarded",
      ]),
    );
    expect(events.indexOf("send_cleared")).toBeLessThan(
      events.indexOf("input"),
    );
    expect(
      readDiagnostics().find(({ event }) => event === "send_cleared")?.details
        .domTextCharacters,
    ).toBe(0);
    expect(exportDiagnostics()).not.toContain("private");
    setDiagnosticCategoryEnabled("composer_input", false);
    const count = readDiagnostics().length;
    fireEvent.input(input, { target: { value: "another message" } });
    expect(readDiagnostics()).toHaveLength(count);
  });

  it("preserves typing and paste during the guard and accepts composition at 250 ms", async () => {
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const store = new FakeComposerStore(snapshot(), "send this");
      render(<Composer store={store as unknown as ThreadClientStore} />);
      const input = screen.getByRole("textbox");
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      fireEvent.input(input, {
        target: { value: "new" },
        inputType: "insertText",
      });
      fireEvent.input(input, {
        target: { value: "new paste" },
        inputType: "insertFromPaste",
      });
      now += 249;
      fireEvent.input(input, {
        target: { value: "stale correction" },
        inputType: "insertCompositionText",
        isComposing: true,
      });
      expect(input).toHaveValue("new paste");
      expect(input).toHaveFocus();
      now += 1;
      fireEvent.input(input, {
        target: { value: "new dictation" },
        inputType: "insertCompositionText",
        isComposing: true,
      });
      expect(input).toHaveValue("new dictation");
      await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
      expect(input).toHaveValue("new dictation");
    } finally {
      clock.mockRestore();
    }
  });

  it("makes post-send mobile composer refocus browser-configurable", () => {
    const refocusingStore = new FakeComposerStore(snapshot(), "first");
    const firstView = render(
      <Composer store={refocusingStore as unknown as ThreadClientStore} />,
    );
    const firstTextbox = screen.getByRole("textbox");
    const firstSend = screen.getByRole("button", { name: "Send message" });
    firstSend.focus();
    fireEvent.click(firstSend);
    expect(firstTextbox).toHaveFocus();

    firstView.unmount();
    setMobileComposerRefocusAfterSend(false);
    const nonRefocusingStore = new FakeComposerStore(snapshot(), "second");
    render(
      <Composer store={nonRefocusingStore as unknown as ThreadClientStore} />,
    );
    const secondTextbox = screen.getByRole("textbox");
    const secondSend = screen.getByRole("button", { name: "Send message" });
    secondSend.focus();
    fireEvent.click(secondSend);
    expect(secondTextbox).not.toHaveFocus();
  });

  it("preserves desktop post-send refocus when the mobile preference is off", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    setMobileComposerRefocusAfterSend(false);
    const store = new FakeComposerStore(snapshot(), "desktop");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    const textbox = screen.getByRole("textbox");
    const send = screen.getByRole("button", { name: "Send message" });
    send.focus();
    fireEvent.click(send);
    expect(textbox).toHaveFocus();
  });

  it("snapshots the truthful skill fallback before the catalog resolves", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.state = {
      ...store.state,
      snapshot: {
        ...store.state.snapshot!,
        draft: {
          ...store.state.snapshot!.draft,
          selectedSkillId: "skill-review",
        },
      },
    };
    store.listSkills.mockImplementationOnce(() => new Promise(() => undefined));
    render(<Composer store={store as unknown as ThreadClientStore} />);

    expect(screen.getByText("Skill selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(store.stageComposerTransfer).toHaveBeenCalledWith(
      expect.any(String),
      "submit",
      expect.objectContaining({ selectedSkillId: "skill-review" }),
      { selectedSkillLabel: "Skill selected" },
    );
  });

  it("stages explicit Queue and clears it in the same committed render", async () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
    ];
    const store = new FakeComposerStore(active, "");
    let releaseSave!: () => void;
    store.saveDraft.mockImplementationOnce(
      (draft) =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ...draft,
              revision: draft.revision + 1,
              updatedAt: "2026-08-13T20:00:00.000Z",
            });
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    type("queue immediately");
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByText("queue immediately")).toBeVisible();
    expect(store.stageComposerTransfer).toHaveBeenCalledWith(
      expect.any(String),
      "queue",
      expect.objectContaining({ text: "queue immediately" }),
      {},
    );
    expect(store.deliver).not.toHaveBeenCalled();
    await waitFor(() => expect(store.saveDraft).toHaveBeenCalledOnce());
    await act(async () => releaseSave());
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
  });

  it("rolls a failed draft save ahead of post-clear text with one exact blank line", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    let rejectSave!: () => void;
    store.saveDraft.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = () => reject(new Error("save failed"));
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    type("submitted\n");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    type("next");
    await waitFor(() => expect(store.saveDraft).toHaveBeenCalledOnce());
    await act(async () => rejectSave());

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("submitted\n\n\nnext"),
    );
    expect(store.abandonComposerTransfer).toHaveBeenCalledOnce();
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("subtracts only unchanged restored IDs after late materialization", async () => {
    const store = new FakeComposerStore(snapshot(), "send with context");
    seedContextExcerpt(store, consumedContextExcerpt);
    let rejectDelivery!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, _draft, operationId) =>
        new Promise((_resolve, reject) => {
          rejectDelivery = () => {
            store.updateTransfer(operationId, {
              requestState: "request_failed",
              authorityState: "rolled_back_tombstone",
              rollbackRequired: true,
              retainTombstoneAfterRollback: true,
            });
            reject(new Error("request failed after admission was uncertain"));
          };
        }),
    );
    const first = renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    await act(async () => rejectDelivery());
    await waitFor(() => expect(screen.getByText("prior.ts")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    expect(screen.getByText("answer.ts")).toBeVisible();
    const operationId = store.state.pendingComposerTransfers[0]!.operationId;
    first.unmount();
    renderComposerWithContext(store);
    expect(screen.getByText("prior.ts")).toBeVisible();
    expect(screen.getByText("answer.ts")).toBeVisible();
    act(() => {
      store.updateTransfer(operationId, {
        authorityState: "materialized",
        lateMaterializationRequiresComposerReconciliation: true,
      });
    });

    await waitFor(() =>
      expect(screen.queryByText("prior.ts")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("answer.ts")).toBeVisible();
    expect(
      store.acknowledgeLateComposerTransferReconciliation,
    ).toHaveBeenCalledWith(operationId);
  });

  it("does not mask authority that advances while an unconfirmed Steer draft is retained", async () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
    ];
    const store = new FakeComposerStore(active, "uncertain steer");
    store.deliver.mockImplementationOnce(async (_mode, _draft, operationId) => {
      store.updateTransfer(operationId, {
        requestState: "request_failed",
        steerPhase: "unconfirmed",
      });
      throw new Error("connection lost");
    });
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() =>
      expect(screen.getByText("Steer unconfirmed")).toBeVisible(),
    );
    type("draft created after clear");
    first.unmount();

    act(() => {
      store.replaceDraft({ text: "new server authority", revision: 2 });
    });
    render(<Composer store={store as unknown as ThreadClientStore} />);

    expect(screen.getByRole("textbox")).toHaveValue(
      "draft created after clear",
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This draft changed in another client",
      ),
    );
  });

  it("protects a mounted ambiguous rollback until exact materialization", async () => {
    const store = new FakeComposerStore(snapshot(), "restore after failure");
    let rejectDelivery!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, _draft, operationId) =>
        new Promise((_resolve, reject) => {
          rejectDelivery = () => {
            store.updateTransfer(operationId, {
              requestState: "request_failed",
              authorityState: "rolled_back_tombstone",
              rollbackRequired: true,
              retainTombstoneAfterRollback: true,
            });
            reject(new Error("delivery failed"));
          };
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    await act(async () => rejectDelivery());
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("restore after failure"),
    );
    const operationId = store.state.pendingComposerTransfers[0]!.operationId;

    act(() => {
      store.replaceDraft({ text: "", revision: 2 });
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("restore after failure"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This draft changed in another client",
    );
    act(() => {
      store.updateTransfer(operationId, {
        authorityState: "materialized",
        lateMaterializationRequiresComposerReconciliation: true,
      });
    });

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    type("can deliver after reconciliation");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(
      store.acknowledgeLateComposerTransferReconciliation,
    ).toHaveBeenCalledWith(operationId);
  });

  it("protects a remounted ambiguous rollback until exact materialization", async () => {
    const store = new FakeComposerStore(snapshot(), "restore after remount");
    let rejectDelivery!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, _draft, operationId) =>
        new Promise((_resolve, reject) => {
          rejectDelivery = () => {
            store.updateTransfer(operationId, {
              requestState: "request_failed",
              authorityState: "rolled_back_tombstone",
              rollbackRequired: true,
              retainTombstoneAfterRollback: true,
            });
            reject(new Error("delivery response lost"));
          };
        }),
    );
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    await act(async () => rejectDelivery());
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("restore after remount"),
    );
    const operationId = store.state.pendingComposerTransfers[0]!.operationId;
    first.unmount();
    act(() => {
      store.replaceDraft({ text: "", revision: 2 });
    });
    render(<Composer store={store as unknown as ThreadClientStore} />);

    expect(screen.getByRole("textbox")).toHaveValue("restore after remount");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This draft changed in another client",
      ),
    );
    act(() => {
      store.updateTransfer(operationId, {
        authorityState: "materialized",
        lateMaterializationRequiresComposerReconciliation: true,
      });
    });

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    type("can deliver after remount reconciliation");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(
      store.acknowledgeLateComposerTransferReconciliation,
    ).toHaveBeenCalledWith(operationId);
  });

  it("drops clean-rejection inverse bookkeeping before ordinary remount authority", async () => {
    const store = new FakeComposerStore(snapshot(), "clean rejection");
    store.deliver.mockImplementationOnce(async (_mode, _draft, operationId) => {
      store.updateTransfer(operationId, {
        requestState: "request_failed",
        authorityState: "rolled_back_tombstone",
        rollbackRequired: true,
        retainTombstoneAfterRollback: false,
      });
      throw new ApiError(
        400,
        "invalid_delivery",
        "Delivery was rejected.",
        false,
      );
    });
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("clean rejection"),
    );
    expect(store.state.pendingComposerTransfers).toEqual([]);
    type("ordinary draft after rejection");
    first.unmount();

    act(() => {
      store.replaceDraft({ text: "new server authority", revision: 2 });
    });
    render(<Composer store={store as unknown as ThreadClientStore} />);

    expect(screen.getByRole("textbox")).toHaveValue("new server authority");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains S plus N when a clean rejection settles after unmount", async () => {
    const store = new FakeComposerStore(snapshot(), "pending clean rejection");
    let rejectDelivery!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, _draft, operationId) =>
        new Promise((_resolve, reject) => {
          rejectDelivery = () => {
            store.updateTransfer(operationId, {
              requestState: "request_failed",
              authorityState: "rolled_back_tombstone",
              rollbackRequired: true,
              retainTombstoneAfterRollback: false,
            });
            reject(
              new ApiError(
                400,
                "invalid_delivery",
                "Delivery was rejected.",
                false,
              ),
            );
          };
        }),
    );
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    type("next draft");
    first.unmount();
    await act(async () => rejectDelivery());

    render(<Composer store={store as unknown as ThreadClientStore} />);
    expect(screen.getByRole("textbox")).toHaveValue(
      "pending clean rejection\n\nnext draft",
    );
  });

  it("retains late inverse state when ambiguous Submit settles after unmount", async () => {
    const store = new FakeComposerStore(snapshot(), "possibly accepted");
    let rejectDelivery!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, _draft, operationId) =>
        new Promise((_resolve, reject) => {
          rejectDelivery = () => {
            store.updateTransfer(operationId, {
              requestState: "request_failed",
              authorityState: "rolled_back_tombstone",
              rollbackRequired: true,
              retainTombstoneAfterRollback: true,
            });
            reject(new Error("response dropped"));
          };
        }),
    );
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    type("next draft");
    first.unmount();
    await act(async () => rejectDelivery());

    render(<Composer store={store as unknown as ThreadClientStore} />);
    expect(screen.getByRole("textbox")).toHaveValue(
      "possibly accepted\n\nnext draft",
    );
    const operationId = store.state.pendingComposerTransfers[0]!.operationId;
    act(() => {
      store.updateTransfer(operationId, {
        authorityState: "materialized",
        lateMaterializationRequiresComposerReconciliation: true,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("next draft"),
    );
  });

  it("keeps an ambiguous Steer out of the composer and blocks its next-draft autosave", async () => {
    vi.useFakeTimers();
    try {
      const active = snapshot("running");
      active.capabilities.deliveryModes = [
        { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
      ];
      const store = new FakeComposerStore(active, "uncertain steer");
      store.deliver.mockImplementationOnce(
        async (_mode, _draft, operationId) => {
          store.updateTransfer(operationId, {
            requestState: "request_failed",
            steerPhase: "unconfirmed",
          });
          throw new Error("connection lost");
        },
      );
      const first = render(
        <Composer store={store as unknown as ThreadClientStore} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Steer" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Steer unconfirmed")).toBeVisible();
      expect(screen.getByRole("textbox")).toHaveValue("");

      type("new draft while uncertain");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveValue(
        "new draft while uncertain",
      );
      expect(screen.queryByDisplayValue(/uncertain steer/u)).toBeNull();

      const operationId = store.state.pendingComposerTransfers[0]!.operationId;
      first.unmount();
      render(<Composer store={store as unknown as ThreadClientStore} />);
      expect(screen.getByRole("textbox")).toHaveValue(
        "new draft while uncertain",
      );
      expect(store.saveDraft).not.toHaveBeenCalled();
      act(() => {
        store.updateTransfer(operationId, {
          authorityState: "rolled_back_tombstone",
          rollbackRequired: true,
        });
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("textbox")).toHaveValue(
        "uncertain steer\n\nnew draft while uncertain",
      );
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledTimes(1);
      expect(store.saveDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "uncertain steer\n\nnew draft while uncertain",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Pi's retained draft as the sync base while remounting a blank composer", async () => {
    const active = snapshot("running");
    active.capabilities.deliveryModes = [
      { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
    ];
    const store = new FakeComposerStore(active, "Retained by Pi");
    store.deliver.mockImplementationOnce(async (_mode, draft, operationId) => {
      store.updateTransfer(operationId, { steerPhase: "steering" });
      return draft;
    });
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(store.state.snapshot?.draft.text).toBe("Retained by Pi");
    const savesBeforeRemount = store.saveDraft.mock.calls.length;

    first.unmount();
    render(<Composer store={store as unknown as ThreadClientStore} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(store.saveDraft).toHaveBeenCalledTimes(savesBeforeRemount);

    store.replace({
      pendingComposerTransfers: store.state.pendingComposerTransfers.map(
        (transfer) => ({
          ...transfer,
          steerPhase: "unconfirmed" as const,
        }),
      ),
    });
    expect(screen.getByRole("textbox")).toHaveValue("");

    type("The next draft remains editable");
    expect(screen.getByRole("textbox")).toHaveValue(
      "The next draft remains editable",
    );
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
  });

  it("removes sent context but keeps a newly staged excerpt in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "send this");
    seedContextExcerpt(store, consumedContextExcerpt);
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
            });
        }),
    );
    const view = renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    await act(async () => releaseDeliver());

    expect(screen.queryByText("prior.ts")).not.toBeInTheDocument();
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "",
      contextExcerpts: [contextExcerpt],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("uses a recovery draft receipt without resurrecting submitted context", async () => {
    const store = new FakeComposerStore(snapshot(), "recover this");
    seedContextExcerpt(store, consumedContextExcerpt);
    let releaseRecovery!: () => void;
    store.deliver.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((_resolve, reject) => {
          releaseRecovery = () =>
            reject(
              new DeliveryRecoveryRequiredError(false, {
                text: "",
                contextExcerpts: [],
                taskReferences: [],
                attachments: [],
                revision: 2,
              }),
            );
        }),
    );
    const view = renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    await act(async () => releaseRecovery());

    expect(screen.queryByText("prior.ts")).not.toBeInTheDocument();
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "",
      contextExcerpts: [contextExcerpt],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("removes stashed context but keeps a newly staged excerpt in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "stash this");
    seedContextExcerpt(store, consumedContextExcerpt);
    let releaseStash!: () => void;
    store.stash.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseStash = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: 2,
            });
        }),
    );
    const view = renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));
    await waitFor(() => expect(store.stash).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    await act(async () => releaseStash());

    expect(screen.queryByText("prior.ts")).not.toBeInTheDocument();
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "",
      contextExcerpts: [contextExcerpt],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("rejects staging when the full composer aggregate would exceed its bound", () => {
    const store = new FakeComposerStore(snapshot(), "x".repeat(262_140));
    renderComposerWithContext(store);

    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    expect(screen.queryByText("answer.ts")).not.toBeInTheDocument();
  });
  it("focuses the text input when its desktop host requests autofocus", () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer store={store as unknown as ThreadClientStore} autoFocus />,
    );

    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it.each(["", "keep this draft"])(
    "lets an unhandled Escape blur the composer with draft %j",
    (draft) => {
      const store = new FakeComposerStore(snapshot(), draft);
      render(
        <Composer store={store as unknown as ThreadClientStore} autoFocus />,
      );
      const composer = screen.getByRole("textbox", { name: "Message Pi" });
      expect(composer).toHaveFocus();

      expect(fireEvent.keyDown(composer, { key: "Escape" })).toBe(false);
      expect(composer).not.toHaveFocus();
    },
  );

  it("keeps composer focus when an open overlay owns Escape", () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer store={store as unknown as ThreadClientStore} autoFocus />,
    );
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);

    expect(fireEvent.keyDown(composer, { key: "Escape" })).toBe(true);
    expect(composer).toHaveFocus();
  });

  it("advertises sidebar navigation only while the whole composer is empty", () => {
    const emptyStore = new FakeComposerStore(snapshot(), "");
    const emptyView = render(
      <Composer store={emptyStore as unknown as ThreadClientStore} />,
    );
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveAttribute(
      "data-sidebar-navigation-when-empty",
      "true",
    );

    emptyView.unmount();
    const draftStore = new FakeComposerStore(snapshot(), "keep this draft");
    render(<Composer store={draftStore as unknown as ThreadClientStore} />);
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).not.toHaveAttribute("data-sidebar-navigation-when-empty");
  });

  it.each([
    ["AltGraph", { key: "AltGraph" }],
    [
      "right-key location",
      {
        key: "Alt",
        location: KeyboardEvent.DOM_KEY_LOCATION_RIGHT,
      },
    ],
    ["AltRight code", { key: "Unidentified", code: "AltRight" }],
  ] as const)(
    "focuses the composer on the initial %s keydown when enabled",
    (_label, init) => {
      setRightOptionFocusesComposer(true);
      const store = new FakeComposerStore(snapshot(), "");
      render(
        <>
          <input aria-label="Other editor" />
          <Composer store={store as unknown as ThreadClientStore} />
        </>,
      );
      screen.getByLabelText("Other editor").focus();

      const event = dispatchWindowKeyDown({
        bubbles: true,
        cancelable: true,
        ...init,
      });

      expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveFocus();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it("retains the draft without consuming right Option while the workspace is inactive", () => {
    setRightOptionFocusesComposer(true);
    const store = new FakeComposerStore(snapshot(), "retained draft");
    const content = (active: boolean) => <><input aria-label="Settings field" />
      <Composer active={active} store={store as unknown as ThreadClientStore} /></>;
    const view = render(content(true));
    const draft = screen.getByRole("textbox", { name: "Message Pi" });
    view.rerender(content(false));
    const settings = screen.getByLabelText("Settings field");
    settings.focus();
    const event = dispatchWindowKeyDown({ key: "Alt", code: "AltRight", cancelable: true });
    expect(event.defaultPrevented).toBe(false);
    expect(settings).toHaveFocus();
    view.rerender(content(true));
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBe(draft);
    expect(draft).toHaveValue("retained draft");
    dispatchWindowKeyDown({ key: "Alt", code: "AltRight" });
    expect(draft).toHaveFocus();
  });

  it("applies the right-Option setting immediately without a remount", () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <>
        <input aria-label="Other editor" />
        <Composer store={store as unknown as ThreadClientStore} />
      </>,
    );
    const other = screen.getByLabelText("Other editor");
    other.focus();

    const disabledEvent = dispatchWindowKeyDown({
      key: "Alt",
      code: "AltRight",
      bubbles: true,
      cancelable: true,
    });
    expect(other).toHaveFocus();
    expect(disabledEvent.defaultPrevented).toBe(false);

    setRightOptionFocusesComposer(true);
    dispatchWindowKeyDown({ key: "Alt", code: "AltRight" });
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveFocus();
  });

  it.each([
    ["a repeated right Alt", { key: "Alt", code: "AltRight", repeat: true }],
    [
      "left Alt",
      {
        key: "Alt",
        code: "AltLeft",
        location: KeyboardEvent.DOM_KEY_LOCATION_LEFT,
      },
    ],
  ] as const)("ignores %s", (_label, init) => {
    setRightOptionFocusesComposer(true);
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <>
        <input aria-label="Other editor" />
        <Composer store={store as unknown as ThreadClientStore} />
      </>,
    );
    const other = screen.getByLabelText("Other editor");
    other.focus();

    const event = dispatchWindowKeyDown({
      bubbles: true,
      cancelable: true,
      ...init,
    });

    expect(other).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not focus or consume right Alt when the composer is disabled", () => {
    setRightOptionFocusesComposer(true);
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <>
        <input aria-label="Other editor" />
        <Composer store={store as unknown as ThreadClientStore} disabled />
      </>,
    );
    const other = screen.getByLabelText("Other editor");
    other.focus();

    const event = dispatchWindowKeyDown({
      key: "Alt",
      code: "AltRight",
      bubbles: true,
      cancelable: true,
    });

    expect(other).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeDisabled();
    expect(event.defaultPrevented).toBe(false);
  });


  it.each([false, true])("opens mobile skills for browsing, with keyboard search override %s", async (keyboard) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const store = new FakeComposerStore(snapshot(), "");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    const trigger = screen.getByRole("button", { name: "Choose skill" });
    if (keyboard) fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Choose a skill" });
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    await waitFor(() => expect(keyboard ? search : dialog).toHaveFocus());
    search.focus();
    fireEvent.change(search, { target: { value: "rev" } });
    expect(search).toHaveFocus();
    expect(await screen.findByRole("button", { name: /Review Changes/u })).toBeInTheDocument();
  });

  it("selects and persists a skill independently from the prompt body", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose skill" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Review Changes/u }),
    );

    expect(screen.getByTestId("selected-skill")).toHaveTextContent(
      "Review Changes",
    );
    expect(screen.queryByText("$review")).not.toBeInTheDocument();
    type("please inspect");
    pressEnter(store);

    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "please inspect",
        selectedSkillId: "skill-review",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      }),
    );
    await waitFor(() =>
      expect(store.deliver).toHaveBeenCalledWith(
        "submit",
        expect.objectContaining({
          text: "please inspect",
          selectedSkillId: "skill-review",
          revision: 2,
        }),
        expect.any(String),
      ),
    );
  });

  it("sends a selected skill without requiring prompt text", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose skill" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Review Changes/u }),
    );
    pressEnter(store);

    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "",
        selectedSkillId: "skill-review",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      }),
    );
    await waitFor(() =>
      expect(store.deliver).toHaveBeenCalledWith(
        "submit",
        expect.objectContaining({
          text: "",
          selectedSkillId: "skill-review",
          revision: 2,
        }),
        expect.any(String),
      ),
    );
  });

  it.each(["steer", "queue"] as const)(
    "offers skill-only %s delivery while a turn is active",
    async (mode) => {
      const active = snapshot("running");
      active.capabilities.deliveryModes = [
        {
          id: mode,
          steerTarget: mode === "steer" ? "turn" : null,
          label: { text: mode === "steer" ? "Steer" : "Queue" },
          available: true,
        },
      ];
      const store = new FakeComposerStore(active, "");
      render(<Composer store={store as unknown as ThreadClientStore} />);

      fireEvent.click(screen.getByRole("button", { name: "Choose skill" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Review Changes/u }),
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: mode === "steer" ? "Steer" : "Queue",
        }),
      );

      await waitFor(() =>
        expect(store.deliver).toHaveBeenCalledWith(
          mode,
          expect.objectContaining({
            text: "",
            selectedSkillId: "skill-review",
          }),
          expect.any(String),
        ),
      );
    },
  );

  it.each(["steer", "queue"] as const)(
    "preserves conversation-message context through %s delivery",
    async (mode) => {
      const active = snapshot("running");
      active.capabilities.deliveryModes = [
        {
          id: mode,
          steerTarget: mode === "steer" ? "turn" : null,
          label: { text: mode === "steer" ? "Steer" : "Queue" },
          available: true,
        },
      ];
      const store = new FakeComposerStore(active, "");
      renderComposerWithContext(store, undefined, conversationContextExcerpt);

      fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
      type("Use the selected message");
      fireEvent.click(
        await screen.findByRole("button", {
          name: mode === "steer" ? "Steer" : "Queue",
        }),
      );

      await waitFor(() =>
        expect(store.deliver).toHaveBeenCalledWith(
          mode,
          expect.objectContaining({
            text: "Use the selected message",
            contextExcerpts: [conversationContextExcerpt],
          }),
          expect.any(String),
        ),
      );
    },
  );

  it.each([false, true])("opens skill search from the normalized /skill picker trigger, mobile %s", async (mobile) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const store = new FakeComposerStore(snapshot(), "");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    type("/skill rev");

    expect(
      await screen.findByRole("searchbox", { name: "Search skills" }),
    ).toHaveValue("rev");
    expect(screen.getByRole("searchbox", { name: "Search skills" })).toHaveFocus();
    expect(
      await screen.findByRole("button", { name: /Review Changes/u }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /tests.*\$tests/i }),
    ).not.toBeInTheDocument();
  });

  it("shares the fail-closed predicate across Enter and the send path", async () => {
    const onImmediateSend = vi.fn();
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        onImmediateSend={onImmediateSend}
      />,
    );

    pressEnter(store);
    expect(store.deliver).not.toHaveBeenCalled();
    expect(onImmediateSend).not.toHaveBeenCalled();

    type("eligible");
    act(() => store.replace({ actionPending: true }));
    pressEnter(store);

    act(() =>
      store.replace({
        actionPending: false,
        snapshot: snapshot("idle", false),
      }),
    );
    pressEnter(store);

    act(() => store.replace({ snapshot: snapshot("stopping", true) }));
    pressEnter(store);
    expect(store.deliver).not.toHaveBeenCalled();
    expect(onImmediateSend).not.toHaveBeenCalled();

    act(() => store.replace({ snapshot: snapshot() }));
    pressEnter(store);
    // The send path persists the composer-local draft first, then delivers
    // with the revision the server acknowledged.
    await waitFor(() =>
      expect(store.deliver).toHaveBeenCalledWith(
        "submit",
        expect.objectContaining({ text: "eligible", revision: 2 }),
        expect.any(String),
      ),
    );
    expect(onImmediateSend).toHaveBeenCalledTimes(1);
  });

  it("stashes the current prompt without opening the stash popover", async () => {
    const store = new FakeComposerStore(snapshot(), "Save this for later");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() =>
      expect(store.stash).toHaveBeenCalledWith({
        text: "Save this for later",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Stashed prompts" }),
    ).not.toBeInTheDocument();
  });

  it("admits only one stash mutation while the first request is pending", async () => {
    const store = new FakeComposerStore(snapshot(), "Save this once");
    let releaseStash!: (value: NormalizedDraft) => void;
    store.stash.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseStash = resolve;
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    const stashButton = screen.getByRole("button", { name: "Stash prompt" });
    fireEvent.click(stashButton);
    fireEvent.click(stashButton);

    await waitFor(() => expect(store.stash).toHaveBeenCalledOnce());
    await act(async () =>
      releaseStash({
        text: "",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 2,
      }),
    );
  });

  it("merges a restore with the persisted draft without regressing a newer revision or losing new typing", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.replace({
      stashes: [
        {
          id: "stash-1",
          text: "restored",
          contextExcerpts: [],
          taskReferences: [],
          attachments: [],
          createdAt: "2026-07-30T14:00:00.000Z",
        },
      ],
    });
    let releaseRestore!: (value: NormalizedDraft) => void;
    store.restoreStash.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseRestore = resolve;
        }),
    );
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open 1 stashed prompts" }),
    );
    const restoreButton = await screen.findByRole("menuitem", {
      name: /restored/u,
    });
    type("existing");
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);

    await waitFor(() =>
      expect(store.restoreStash).toHaveBeenCalledWith(
        "stash-1",
        expect.objectContaining({ text: "existing", revision: 2 }),
      ),
    );
    expect(store.restoreStash).toHaveBeenCalledOnce();

    type("next idea");
    act(() =>
      store.replaceDraft({ text: "existing\n\nrestored", revision: 4 }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () =>
      releaseRestore({
        text: "existing\n\nrestored",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 3,
      }),
    );
    expect(screen.getByRole("textbox")).toHaveValue("next idea");

    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "next idea",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
      revision: 4,
    });
  });

  it("keeps restored context and context staged while the restore is in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    store.replace({
      stashes: [
        {
          id: "stash-1",
          text: "restore selection",
          contextExcerpts: [consumedContextExcerpt],
          taskReferences: [],
          attachments: [],
          createdAt: "2026-07-30T14:00:00.000Z",
        },
      ],
    });
    let releaseRestore!: (value: NormalizedDraft) => void;
    store.restoreStash.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseRestore = resolve;
        }),
    );
    const view = renderComposerWithContext(store);

    fireEvent.click(
      screen.getByRole("button", { name: "Open 1 stashed prompts" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /restore selection/u }),
    );
    await waitFor(() => expect(store.restoreStash).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Attach fixture" }));
    await act(async () =>
      releaseRestore({
        text: "restore selection",
        contextExcerpts: [consumedContextExcerpt],
        taskReferences: [],
        attachments: [],
        revision: 2,
      }),
    );

    expect(screen.getByText("prior.ts")).toBeInTheDocument();
    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "restore selection",
      contextExcerpts: [consumedContextExcerpt, contextExcerpt],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("keeps keystrokes out of the store and autosaves after two idle seconds", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "");
      render(<Composer store={store as unknown as ThreadClientStore} />);
      const notify = vi.fn();
      store.subscribe(notify);

      type("hello");
      type("hello world");

      // Typing is composer-local: no store writes, no subscriber churn, no
      // immediate persistence.
      expect(notify).not.toHaveBeenCalled();
      expect(store.saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_999);
      });
      expect(store.saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(store.saveDraft).toHaveBeenCalledOnce();
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "hello world",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      });
      // Autosave is silent: still no store state churn.
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the typed draft on unmount instead of waiting for the debounce", () => {
    const store = new FakeComposerStore(snapshot(), "");
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    type("unsent thought");
    expect(store.saveDraft).not.toHaveBeenCalled();

    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledOnce();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "unsent thought",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
      revision: 1,
    });
  });

  it("adopts server draft changes while the composer is clean", async () => {
    const store = new FakeComposerStore(snapshot(), "original");
    render(<Composer store={store as unknown as ThreadClientStore} />);
    expect(screen.getByRole("textbox")).toHaveValue("original");

    act(() => store.replaceDraft({ text: "remote edit", revision: 2 }));

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("remote edit"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the conflict banner when the server draft changes while dirty and resolves both ways", async () => {
    const store = new FakeComposerStore(snapshot(), "original");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    type("local work");
    act(() => store.replaceDraft({ text: "remote edit", revision: 2 }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      "This draft changed in another client. Your local draft is still here.",
    );
    // Local text is preserved while the banner is up.
    expect(screen.getByRole("textbox")).toHaveValue("local work");

    // Use latest: adopt the server's text and drop the local edit.
    fireEvent.click(screen.getByRole("button", { name: "Use latest" }));
    expect(screen.getByRole("textbox")).toHaveValue("remote edit");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(store.saveDraft).not.toHaveBeenCalled();

    // Keep mine: persist the local text at the server's latest revision.
    type("mine instead");
    act(() => store.replaceDraft({ text: "remote v2", revision: 3 }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "mine instead",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 3,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox")).toHaveValue("mine instead");
  });

  it("does not flag our own autosave echo as a conflict", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "original");
      render(<Composer store={store as unknown as ThreadClientStore} />);

      type("local work");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "local work",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      });

      // The reader keeps typing, then our own save's draft_changed echo
      // lands: it must advance the base revision silently.
      type("local work plus more");
      act(() => store.replaceDraft({ text: "local work", revision: 2 }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("local work plus more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flag an autosave echo that beats its own PUT response", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "original");
      let releaseSave!: (value: {
        text: string;
        contextExcerpts: NormalizedDraft["contextExcerpts"];
        taskReferences: NormalizedDraft["taskReferences"];
        attachments: NormalizedDraft["attachments"];
        revision: number;
        updatedAt: string;
      }) => void;
      store.saveDraft.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseSave = resolve;
          }),
      );
      render(<Composer store={store as unknown as ThreadClientStore} />);

      type("local work");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "local work",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      });

      // The reader keeps typing while the PUT is in flight, then the
      // broadcast of our own save arrives BEFORE the PUT response: it must
      // read as ours, not as a remote change.
      type("local work plus more");
      act(() => store.replaceDraft({ text: "local work", revision: 2 }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () => {
        releaseSave({
          text: "local work",
          contextExcerpts: [],
          taskReferences: [],
          attachments: [],
          revision: 2,
          updatedAt: new Date().toISOString(),
        });
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("local work plus more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves text typed while a delivery is in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
              updatedAt: "2026-07-30T15:01:00.000Z",
            });
        }),
    );
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());

    // The reader starts the next message while the deliver round-trip is
    // still in flight.
    type("next message");
    await act(async () => {
      releaseDeliver();
    });

    // The in-flight text is not wiped, and it stays dirty so the autosave
    // (or an unmount flush) persists it.
    expect(screen.getByRole("textbox")).toHaveValue("next message");

    // The post-delivery empty-draft echo must not raise a spurious conflict.
    act(() => store.replaceDraft({ text: "", revision: 2 }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("next message");

    view.unmount();
    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "next message",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 2,
      }),
    );
  });

  it("explains an invalid next-draft merge after successful delivery without losing local edits", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
              updatedAt: "2026-07-30T15:01:00.000Z",
            });
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());

    const oversizedNextMessage = "x".repeat(MAXIMUM_COMPOSER_INPUT_BYTES + 1);
    type(oversizedNextMessage);
    await act(async () => releaseDeliver());

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Your message was sent, but edits made while it was sending exceed the draft limits.",
    );
    expect(alert).toHaveTextContent(
      "Shorten it or remove attached context, then choose Keep mine.",
    );
    expect(alert).not.toHaveTextContent("changed in another client");
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value.length,
    ).toBe(MAXIMUM_COMPOSER_INPUT_BYTES + 1);
  });

  it("preserves delivery uncertainty when a recovery draft cannot merge with local edits", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseRecovery!: () => void;
    store.deliver.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((_resolve, reject) => {
          releaseRecovery = () =>
            reject(
              new DeliveryRecoveryRequiredError(false, {
                text: "",
                contextExcerpts: [],
                taskReferences: [],
                attachments: [],
                revision: 2,
              }),
            );
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    type("x".repeat(MAXIMUM_COMPOSER_INPUT_BYTES + 1));
    await act(async () => releaseRecovery());

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Delivery could not be confirmed");
    expect(alert).not.toHaveTextContent("Your message was sent");
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value.length,
    ).toBe(MAXIMUM_COMPOSER_INPUT_BYTES + 1);
  });

  it("serializes draft PUTs and coalesces waiting autosaves to the newest text", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "");
      let releaseFirst!: (value: {
        text: string;
        contextExcerpts: NormalizedDraft["contextExcerpts"];
        taskReferences: NormalizedDraft["taskReferences"];
        attachments: NormalizedDraft["attachments"];
        revision: number;
        updatedAt: string;
      }) => void;
      let active = 0;
      let maximumActive = 0;
      store.saveDraft.mockImplementation(async (draft) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (store.saveDraft.mock.calls.length === 1) {
          const result = await new Promise<{
            text: string;
            contextExcerpts: NormalizedDraft["contextExcerpts"];
            taskReferences: NormalizedDraft["taskReferences"];
            attachments: NormalizedDraft["attachments"];
            revision: number;
            updatedAt: string;
          }>((resolve) => {
            releaseFirst = resolve;
          });
          active -= 1;
          return result;
        }
        active -= 1;
        return {
          ...draft,
          revision: draft.revision + 1,
          updatedAt: "2026-07-30T15:01:00.000Z",
        };
      });
      render(<Composer store={store as unknown as ThreadClientStore} />);

      type("first");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledOnce();

      type("superseded");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      type("newest");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledOnce();

      await act(async () => {
        releaseFirst({
          text: "first",
          contextExcerpts: [],
          taskReferences: [],
          attachments: [],
          revision: 2,
          updatedAt: "2026-07-30T15:01:00.000Z",
        });
        await Promise.resolve();
      });

      expect(store.saveDraft).toHaveBeenCalledTimes(2);
      expect(store.saveDraft).toHaveBeenLastCalledWith({
        text: "newest",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 2,
      });
      expect(maximumActive).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops queued persistence after a revision conflict until it is resolved", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "original");
      const conflict = Object.assign(new Error("revision conflict"), {
        status: 409,
      });
      store.saveDraft.mockRejectedValue(conflict);
      render(<Composer store={store as unknown as ThreadClientStore} />);

      type("local edit");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This draft changed in another client",
      );

      type("local edit after conflict");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(store.saveDraft).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue(
        "local edit after conflict",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds next-message autosave until delivery's authoritative clear revision", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeComposerStore(snapshot(), "");
      let releaseDeliver!: () => void;
      store.deliver.mockImplementation(
        (_mode, draft) =>
          new Promise<NormalizedDraft>((resolve) => {
            releaseDeliver = () =>
              resolve({
                text: "",
                contextExcerpts: [],
                taskReferences: [],
                attachments: [],
                revision: draft.revision + 1,
                updatedAt: "2026-07-30T15:01:00.000Z",
              });
          }),
      );
      render(<Composer store={store as unknown as ThreadClientStore} />);

      type("first message");
      pressEnter(store);
      await act(async () => Promise.resolve());
      expect(store.saveDraft).toHaveBeenCalledWith({
        text: "first message",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 1,
      });
      await act(async () => Promise.resolve());
      expect(store.deliver).toHaveBeenCalledOnce();

      type("next message");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      await act(async () => releaseDeliver());
      // The HTTP receipt advances the queue without depending on an SSE echo.
      await act(async () => Promise.resolve());
      expect(store.saveDraft).toHaveBeenLastCalledWith({
        text: "next message",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flag the empty-draft echo that arrives before the deliver response resolves", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
              updatedAt: "2026-07-30T15:01:00.000Z",
            });
        }),
    );
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());

    // The reader starts the next message, and the server's empty-draft echo
    // wins the race against the deliver HTTP response.
    type("next message");
    act(() => store.replaceDraft({ text: "", revision: 2 }));

    // The early echo must read as our own clear — no spurious conflict —
    // and the in-flight text survives once the deliver resolves.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      releaseDeliver();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("next message");

    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "next message",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it.each([
    ["submit", "idle", "Send message"],
    ["queue", "running", "Queue"],
    ["steer", "running", "Steer"],
  ] as const)(
    "retains the expected %s clear echo across an in-flight remount",
    async (mode, runState, buttonName) => {
      const active = snapshot(runState);
      active.capabilities.deliveryModes = [
        { id: mode, steerTarget: mode === "steer" ? "turn" : null, label: { text: buttonName }, available: true },
      ];
      const store = new FakeComposerStore(active, "first message");
      let releaseDeliver!: () => void;
      store.deliver.mockImplementationOnce(
        (_mode, draft) =>
          new Promise<NormalizedDraft>((resolve) => {
            releaseDeliver = () =>
              resolve({
                text: "",
                contextExcerpts: [],
                taskReferences: [],
                attachments: [],
                revision: draft.revision + 1,
                updatedAt: "2026-08-14T12:00:00.000Z",
              });
          }),
      );
      const first = render(
        <Composer store={store as unknown as ThreadClientStore} />,
      );

      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
      first.unmount();
      render(<Composer store={store as unknown as ThreadClientStore} />);

      act(() => store.replaceDraft({ text: "", revision: 2 }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("");
      await act(async () => releaseDeliver());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("lets a rapid second send's own draft-save echo beat retained transfer protection", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    await act(async () => Promise.resolve());
    // Model exact first-operation materialization. The coordinator handoff
    // intentionally remains until its next mounted synchronization.
    act(() => store.replace({ pendingComposerTransfers: [] }));

    let releaseSecondSave!: () => void;
    store.saveDraft.mockImplementationOnce(
      (draft) =>
        new Promise((resolve) => {
          releaseSecondSave = () =>
            resolve({
              ...draft,
              revision: draft.revision + 1,
              updatedAt: "2026-08-14T12:01:00.000Z",
            });
        }),
    );
    type("second message");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.saveDraft).toHaveBeenCalledOnce());

    // This is the broadcast of this same client's second draft PUT, arriving
    // before its HTTP response while the second optimistic transfer is staged.
    act(() => store.replaceDraft({ text: "second message", revision: 3 }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    await act(async () => releaseSecondSave());
    await waitFor(() => expect(store.deliver).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still flags a nonmatching remote draft during a retained optimistic send", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementationOnce(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
              updatedAt: "2026-08-14T12:02:00.000Z",
            });
        }),
    );
    const first = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    first.unmount();
    render(<Composer store={store as unknown as ThreadClientStore} />);

    act(() =>
      store.replaceDraft({ text: "other client's draft", revision: 2 }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This draft changed in another client",
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
    await act(async () => releaseDeliver());
  });

  it("still clears the composer when nothing was typed during the delivery", async () => {
    const store = new FakeComposerStore(snapshot(), "first message");
    let releaseDeliver!: () => void;
    store.deliver.mockImplementation(
      (_mode, draft) =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseDeliver = () =>
            resolve({
              text: "",
              contextExcerpts: [],
              taskReferences: [],
              attachments: [],
              revision: draft.revision + 1,
              updatedAt: "2026-07-30T15:01:00.000Z",
            });
        }),
    );
    render(<Composer store={store as unknown as ThreadClientStore} />);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.deliver).toHaveBeenCalledOnce());
    await act(async () => {
      releaseDeliver();
    });

    expect(screen.getByRole("textbox")).toHaveValue("");

    // The post-delivery echo reads as our own clear — no banner, and the
    // composer stays clean for the next remote edit.
    act(() => store.replaceDraft({ text: "", revision: 2 }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("preserves text typed while a stash is in flight", async () => {
    const store = new FakeComposerStore(snapshot(), "stash this");
    let releaseStash!: (value: NormalizedDraft) => void;
    store.stash.mockImplementation(
      () =>
        new Promise<NormalizedDraft>((resolve) => {
          releaseStash = resolve;
        }),
    );
    const view = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));
    await waitFor(() => expect(store.stash).toHaveBeenCalledOnce());

    type("new idea");
    await act(async () => {
      releaseStash({
        text: "",
        contextExcerpts: [],
        taskReferences: [],
        attachments: [],
        revision: 2,
      });
    });

    // The stash cleared the server draft, but the newer in-flight typing is
    // kept — and still dirty, so the unmount flush persists it against the
    // post-stash revision.
    expect(screen.getByRole("textbox")).toHaveValue("new idea");
    view.unmount();
    expect(store.saveDraft).toHaveBeenCalledWith({
      text: "new idea",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
      revision: 2,
    });
  });

  it("renders composer_action provider features in the composer only", () => {
    const goalRef = { featureId: "codex.goal", schemaVersion: 1 } as const;
    const base = snapshot();
    const withFeatures = {
      ...base,
      capabilities: {
        ...base.capabilities,
        providerFeatures: [
          {
            ref: goalRef,
            revision: 3,
            label: { text: "Goal" },
            availability: "available",
            operations: [
              {
                actionId: "clear",
                label: { text: "Clear" },
                effects: {
                  application: "write",
                  modelUsage: "none",
                  external: "durable_side_effect",
                },
                confirmation: "none",
                execution: "durable",
              },
            ],
            presentationSlots: ["composer_action"],
          },
          {
            ref: { featureId: "codex.execution", schemaVersion: 1 },
            revision: 1,
            label: { text: "Execution" },
            availability: "available",
            operations: [],
            presentationSlots: ["thread_details"],
          },
          {
            ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
            revision: 5,
            label: { text: "Fast mode" },
            description: {
              text: "Fast mode: about 1.5x speed, higher usage",
            },
            availability: "available",
            operations: [
              {
                actionId: "enable",
                label: { text: "Enable" },
                effects: {
                  application: "write",
                  modelUsage: "none",
                  external: "none",
                },
                confirmation: "none",
                execution: "inline",
              },
            ],
            presentationSlots: ["composer_action"],
          },
        ],
      },
      providerFeatures: [
        {
          ref: goalRef,
          revision: 3,
          state: {
            kind: "object",
            entries: [
              { key: { text: "state" }, value: { text: "set" } },
              { key: { text: "objective" }, value: { text: "Ship it" } },
              { key: { text: "status" }, value: { text: "active" } },
            ],
          },
        },
        {
          ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
          revision: 5,
          state: {
            kind: "object",
            entries: [
              { key: { text: "desired" }, value: { text: "standard" } },
              { key: { text: "effective" }, value: { text: "standard" } },
              {
                key: { text: "applicationState" },
                value: { text: "applied" },
              },
            ],
          },
        },
      ],
    } as unknown as NormalizedThreadSnapshot;
    const store = new FakeComposerStore(withFeatures, "");
    const { container } = render(
      <Composer store={store as unknown as ThreadClientStore} />,
    );

    const indicator = screen.getByRole("button", {
      name: "Goal, Active: Ship it",
    });
    expect(indicator).toBeInTheDocument();
    // thread_details-slotted features do not render inside the composer.
    expect(
      screen.queryByText(/Execution is unavailable in this client version/),
    ).not.toBeInTheDocument();

    // Placement: the indicator lives in the composer footer send-group,
    // immediately to the left of the context usage meter.
    const sendGroup = container.querySelector(".send-group");
    expect(sendGroup).not.toBeNull();
    const meter = sendGroup!.querySelector(".context-usage-meter");
    expect(meter).not.toBeNull();
    expect(sendGroup!.contains(indicator)).toBe(true);
    const fastMode = screen.getByRole("button", { name: "Fast mode, off" });
    expect(sendGroup!.contains(fastMode)).toBe(true);
    expect(
      indicator.compareDocumentPosition(meter!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Feature registry order is Goal, Fast mode, then the meter.
    const goalSlot = indicator.closest(".provider-feature-composer-slot");
    const fastModeSlot = fastMode.closest(".provider-feature-composer-slot");
    expect(goalSlot?.nextElementSibling).toBe(fastModeSlot);
    expect(fastModeSlot?.nextElementSibling).toBe(meter);

    // Composer passes its canonical narrow/coarse layout result to provider
    // features instead of forcing their desktop presentation.
    fireEvent.click(indicator);
    expect(screen.getByRole("dialog", { name: "Goal" })).toHaveClass(
      "codex-goal-mobile-card",
    );
  });

  it("updates the goal indicator when a fresh feature-state envelope arrives without a message send", () => {
    const store = new FakeComposerStore(goalSnapshot("active", 3), "");
    render(<Composer store={store as unknown as ThreadClientStore} />);

    const before = screen.getByRole("button", {
      name: "Goal, Active: Ship it",
    });
    expect(before.className).toBe("codex-goal-indicator set status-active");
    expect(before).toHaveAttribute("title", "Goal: Active");

    // Simulate the store receiving an atomic capability/state projection
    // (server-side goal transition) — no message send, no remount.
    act(() => {
      store.replace({ snapshot: goalSnapshot("complete", 4) });
    });

    const after = screen.getByRole("button", {
      name: "Goal, Complete: Ship it",
    });
    expect(after.className).toBe("codex-goal-indicator set status-complete");
    expect(after).toHaveAttribute("title", "Goal: Complete");
  });
});

function goalSnapshot(
  status: "active" | "paused" | "blocked" | "complete",
  revision: number,
): NormalizedThreadSnapshot {
  const goalRef = { featureId: "codex.goal", schemaVersion: 1 } as const;
  const base = snapshot();
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      providerFeatures: [
        {
          ref: goalRef,
          revision,
          label: { text: "Goal" },
          availability: "available",
          operations: [
            {
              actionId: "clear",
              label: { text: "Clear" },
              effects: {
                application: "write",
                modelUsage: "none",
                external: "durable_side_effect",
              },
              confirmation: "none",
              execution: "durable",
            },
          ],
          presentationSlots: ["composer_action"],
        },
      ],
    },
    providerFeatures: [
      {
        ref: goalRef,
        revision,
        state: {
          kind: "object",
          entries: [
            { key: { text: "state" }, value: { text: "set" } },
            { key: { text: "objective" }, value: { text: "Ship it" } },
            { key: { text: "status" }, value: { text: status } },
          ],
        },
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

function tuiControl(
  overrides: {
    readonly active?: boolean;
    readonly inputAvailable?: boolean;
    readonly sendKey?: (data: string) => boolean;
    readonly focusTerminal?: () => void;
    readonly blurTerminal?: () => void;
    readonly isTerminalFocused?: () => boolean;
  } = {},
) {
  return {
    active: true,
    inputAvailable: true,
    sendKey: vi.fn(() => true),
    focusTerminal: vi.fn(),
    blurTerminal: vi.fn(),
    isTerminalFocused: vi.fn(() => false),
    ...overrides,
  };
}

describe("saved prompt composer integration", () => {
  it("renders the desktop prompt trigger above the composer by default", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open saved prompts",
    });
    expect(trigger).toHaveClass("composer-prompt-tab");
    expect(trigger.closest(".composer-prompt-rail")).not.toBeNull();
  });

  it("renders the icon-only saved prompt trigger before stashed prompts when toolbar placement is configured", () => {
    setPromptsPlacement("toolbar");
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: fine)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open saved prompts",
    });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(trigger).toHaveClass("composer-prompt-toolbar");
    expect(trigger.querySelector("span")).toBeNull();
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.closest(".send-group")).not.toBeNull();
    expect(trigger.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Stash prompt" }),
    );
    expect(trigger.compareDocumentPosition(send)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(document.querySelector(".composer-prompt-rail")).toBeNull();
  });

  it("keeps the mobile prompt rail above a connected pending-input stack", () => {
    const store = new FakeComposerStore(snapshot("running"), "");
    store.stageComposerTransfer(
      "pending-steer",
      "steer",
      store.state.snapshot!.draft,
    );
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open saved prompts",
    });
    const rail = trigger.closest(".composer-prompt-rail");
    const stack = rail?.closest(".composer-stack");
    const surface = stack?.querySelector(".composer-surface-stack");
    const pending = surface?.querySelector(".pending-input-strip");
    const composer = surface?.querySelector(".composer");

    expect(trigger).toHaveClass("composer-prompt-tab");
    expect(stack?.firstElementChild).toBe(rail);
    expect(surface?.firstElementChild).toBe(pending);
    expect(pending?.nextElementSibling).toBe(composer);
  });

  it("uses the icon-only toolbar placement on mobile when configured", () => {
    setPromptsPlacement("toolbar");
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open saved prompts",
    });
    expect(trigger).toHaveClass("composer-prompt-toolbar");
    expect(trigger.querySelector("span")).toBeNull();
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Stash prompt" }),
    );
    expect(document.querySelector(".composer-prompt-rail")).toBeNull();
  });

  it("sends a prompt from a pristine idle composer", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Send prompt: Review changes",
      }),
    );

    await waitFor(() => expect(store.deliver).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveFocus(),
    );
    expect(store.deliver.mock.calls[0]?.[0]).toBe("submit");
    expect(store.deliver.mock.calls[0]?.[1].text).toBe(
      "Review the current changes.",
    );
  });

  it("disables prompt-row Send while stopping but leaves Add available", async () => {
    const store = new FakeComposerStore(snapshot("stopping"), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    expect(
      await screen.findByRole("button", {
        name: "Add prompt to composer: Review changes",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Send prompt: Review changes" }),
    ).toBeDisabled();
  });

  it("uses the current active-thread delivery mode for a pristine composer", async () => {
    const activeSnapshot = snapshot("running", false);
    const store = new FakeComposerStore(
      {
        ...activeSnapshot,
        capabilities: {
          ...activeSnapshot.capabilities,
          deliveryModes: [
            { id: "submit", steerTarget: null, label: { text: "Send" }, available: false },
            { id: "steer", steerTarget: "turn" as const, label: { text: "Steer" }, available: true },
            { id: "queue", steerTarget: null, label: { text: "Queue" }, available: true },
          ],
        },
      },
      "",
    );
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Send prompt: Review changes",
      }),
    );

    await waitFor(() => expect(store.deliver).toHaveBeenCalled());
    expect(store.deliver.mock.calls[0]?.[0]).toBe("steer");
  });

  it("appends to an empty draft without sending", async () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add prompt to composer: Review changes",
      }),
    );

    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "Review the current changes.",
    );
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("appends at the caret without sending when the aggregate draft is dirty", async () => {
    const store = new FakeComposerStore(snapshot(), "before after");
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    composer.focus();
    (composer as HTMLTextAreaElement).setSelectionRange(7, 7);

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add prompt to composer: Review changes",
      }),
    );

    expect(composer).toHaveValue(
      "before \n\nReview the current changes.\n\nafter",
    );
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("sends the prompt combined with the current dirty aggregate", async () => {
    const store = new FakeComposerStore(snapshot(), "before after");
    store.replaceDraft({
      text: "before after",
      contextExcerpts: [contextExcerpt],
      revision: 1,
    });
    render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStoreWithPrompts()}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Message Pi" });
    composer.focus();
    (composer as HTMLTextAreaElement).setSelectionRange(7, 7);

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Send prompt: Review changes",
      }),
    );

    await waitFor(() => expect(store.deliver).toHaveBeenCalled());
    expect(store.deliver.mock.calls[0]?.[1].text).toBe(
      "before \n\nReview the current changes.\n\nafter",
    );
    expect(store.deliver.mock.calls[0]?.[1].contextExcerpts).toEqual([
      contextExcerpt,
    ]);
    expect(composer).toHaveValue("");
  });

  it("follows the one client-local visibility toggle", () => {
    setShowPromptsTab(false);
    const store = new FakeComposerStore(snapshot(), "");
    const applicationStore = applicationStoreWithPrompts();
    const { rerender } = render(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStore}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open saved prompts" }),
    ).toBeNull();

    setShowPromptsTab(true);
    rerender(
      <Composer
        store={store as unknown as ThreadClientStore}
        applicationStore={applicationStore}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open saved prompts" }),
    ).toBeVisible();
  });

  it("does not show the prompt tab while the managed TUI composer is active", () => {
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl()}>
        <Composer
          store={store as unknown as ThreadClientStore}
          applicationStore={applicationStoreWithPrompts()}
        />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(
      screen.queryByRole("button", { name: "Open saved prompts" }),
    ).toBeNull();
  });
});

describe("terminal key bar", () => {
  it("keeps the normal durable composer visible and preserves its draft across Chat and TUI", () => {
    const store = new FakeComposerStore(snapshot(), "draft for both views");
    const { rerender } = render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl()}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(screen.getByTestId("composer")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
      "draft for both views",
    );
    expect(
      screen.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeVisible();
    expect(screen.getByTestId("terminal-key-bar")).toBeVisible();

    rerender(
      <CodexTuiTerminalControlContext.Provider
        value={tuiControl({ active: false, inputAvailable: false })}
      >
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(screen.getByTestId("composer")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "draft for both views",
    );
    expect(screen.queryByTestId("terminal-key-bar")).toBeNull();
  });

  it("keeps the draft editable but disables terminal submission until input is accepted", () => {
    const store = new FakeComposerStore(snapshot(), "keep editing");
    render(
      <CodexTuiTerminalControlContext.Provider
        value={tuiControl({ inputAvailable: false })}
      >
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Focus terminal keyboard" }),
    ).toBeDisabled();
  });

  it("does not render the key bar on a desktop viewport", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl()}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(screen.queryByTestId("terminal-key-bar")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeVisible();
    expect(screen.getByTestId("composer")).toBeVisible();
  });

  it("sends quick keys to the terminal from the pinned bar", () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    const bar = screen.getByTestId("terminal-key-bar");
    expect(bar).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(sendKey).toHaveBeenCalledWith("\u001b");
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    expect(sendKey).toHaveBeenCalledWith("\t");
    fireEvent.click(
      screen.getByRole("button", { name: "Send Ctrl+C to terminal" }),
    );
    expect(sendKey).toHaveBeenCalledWith("\u0003");
    fireEvent.click(
      screen.getByRole("button", { name: "Send up arrow to terminal" }),
    );
    expect(sendKey).toHaveBeenCalledWith("\u001b[A");
    fireEvent.click(
      screen.getByRole("button", { name: "Send down arrow to terminal" }),
    );
    expect(sendKey).toHaveBeenCalledWith("\u001b[B");
    fireEvent.click(
      screen.getByRole("button", { name: "Send left arrow to terminal" }),
    );
    expect(sendKey).toHaveBeenCalledWith("\u001b[D");
    fireEvent.click(
      screen.getByRole("button", { name: "Send right arrow to terminal" }),
    );
    expect(sendKey).toHaveBeenCalledWith("\u001b[C");
    expect(
      screen.getByRole("button", { name: "Stage draft in terminal" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Focus terminal keyboard" }),
    ).toHaveClass("terminal-key-focus");
    expect(bar.lastElementChild).toHaveAttribute(
      "aria-label",
      "Stage draft in terminal",
    );
    expect(
      screen
        .getByTestId("terminal-key-bar")
        .querySelector('[aria-label="Send enter to terminal"]'),
    ).toBeNull();
  });

  it("toggles type-into-TUI from the terminal icon", () => {
    let terminalFocused = false;
    const focusTerminal = vi.fn(() => {
      terminalFocused = true;
    });
    const blurTerminal = vi.fn(() => {
      terminalFocused = false;
    });
    const isTerminalFocused = vi.fn(() => terminalFocused);
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <CodexTuiTerminalControlContext.Provider
        value={tuiControl({
          focusTerminal,
          blurTerminal,
          isTerminalFocused,
        })}
      >
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    const toggle = screen.getByRole("button", {
      name: "Focus terminal keyboard",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(focusTerminal).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(blurTerminal).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveFocus();
  });

  it("resynchronizes the terminal toggle when another key takes focus", () => {
    let terminalFocused = false;
    const focusTerminal = vi.fn(() => {
      terminalFocused = true;
    });
    const blurTerminal = vi.fn(() => {
      terminalFocused = false;
    });
    const isTerminalFocused = vi.fn(() => terminalFocused);
    const store = new FakeComposerStore(snapshot(), "");
    render(
      <CodexTuiTerminalControlContext.Provider
        value={tuiControl({
          focusTerminal,
          blurTerminal,
          isTerminalFocused,
        })}
      >
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    const toggle = screen.getByRole("button", {
      name: "Focus terminal keyboard",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    terminalFocused = false;
    fireEvent.focus(screen.getByRole("button", { name: "Esc" }));
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(focusTerminal).toHaveBeenCalledTimes(2);
    expect(blurTerminal).not.toHaveBeenCalled();
  });

  it("stages the durable draft without sending the final submit Enter", async () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "inspect this prompt");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stage draft in terminal" }),
    );

    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith(
      "\u001b[200~inspect this prompt\u001b[201~",
    );
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
      "",
    );
    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "", revision: 1 }),
      ),
    );
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("submits an explicit terminal paste followed by one Enter", async () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "explain the failure mode");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));

    expect(sendKey).toHaveBeenCalledWith(
      "\u001b[200~explain the failure mode\u001b[201~\r",
    );
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
      "",
    );
    await waitFor(() =>
      expect(store.saveDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "", revision: 1 }),
      ),
    );
    expect(store.deliver).not.toHaveBeenCalled();
    expect(store.stageComposerTransfer).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send draft to TUI" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));
    expect(sendKey).toHaveBeenLastCalledWith("\r");
    expect(sendKey).toHaveBeenCalledTimes(2);
  });

  it("neutralizes embedded bracketed-paste boundaries before submission", () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(
      snapshot(),
      "before\u001b[201~after\u001b[200~done",
    );
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));

    expect(sendKey).toHaveBeenCalledWith(
      "\u001b[200~before[201~after[200~done\u001b[201~\r",
    );
  });

  it("keeps oversized drafts and directs them to Chat", () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "x".repeat(64 * 1_024));
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(
      screen.getByText(
        "The TUI accepts at most 64 KiB per composer submission. Shorten the draft or switch to Chat.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Stage draft in terminal" }),
    ).toBeDisabled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
      "x".repeat(64 * 1_024),
    );
  });

  it("preserves the durable draft when the terminal rejects submission", () => {
    const sendKey = vi.fn(() => false);
    const store = new FakeComposerStore(snapshot(), "keep this command");
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));

    expect(sendKey).toHaveBeenCalledWith(
      "\u001b[200~keep this command\u001b[201~\r",
    );
    expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
      "keep this command",
    );
    expect(store.saveDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "The TUI did not accept the input. Your draft was kept.",
      ),
    ).toBeVisible();
  });

  it("restores the captured draft when the terminal accepts it but clearing fails", async () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "review this twice");
    store.saveDraft.mockRejectedValueOnce(new Error("clear failed"));
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));

    expect(sendKey).toHaveBeenCalledWith(
      "\u001b[200~review this twice\u001b[201~\r",
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Send to TUI" })).toHaveValue(
        "review this twice",
      ),
    );
    expect(
      screen.getByText(
        "Input reached the TUI, but Sedes could not clear the draft. Review it before sending again.",
      ),
    ).toBeVisible();
    expect(store.deliver).not.toHaveBeenCalled();
  });

  it("blocks TUI submission while structured Chat-only draft data is present", () => {
    const sendKey = vi.fn(() => true);
    const store = new FakeComposerStore(snapshot(), "use the selected context");
    store.replaceDraft({
      text: "use the selected context",
      contextExcerpts: [contextExcerpt],
      revision: 2,
    });
    render(
      <CodexTuiTerminalControlContext.Provider value={tuiControl({ sendKey })}>
        <Composer store={store as unknown as ThreadClientStore} />
      </CodexTuiTerminalControlContext.Provider>,
    );

    expect(
      screen.getByText("Switch to Chat to send context excerpts."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send draft to TUI" }));
    expect(sendKey).not.toHaveBeenCalled();
  });
});
