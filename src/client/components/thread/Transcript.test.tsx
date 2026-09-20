// @vitest-environment jsdom
import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
import { getBlockingOperation } from "../../operations/blocking-operation.js";
vi.mock("../../operations/thread-readiness.js", () => ({
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
import { createRef } from "react";
import type {
  ConversationItem,
  HistoryPage,
  NormalizedThreadSnapshot,
  ThreadHistorySeekResult,
} from "../../../shared/index.js";
import type {
  PendingComposerTransfer,
  ThreadProjectionViewportAnchor,
  ThreadClientState,
  ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { setDiagnosticCategoryEnabled } from "../../app/settings.js";
import { clearDiagnostics, readDiagnostics } from "../../app/diagnostics.js";
import {
  Transcript,
  type TranscriptHandle,
  type TranscriptSeekRequest,
} from "./Transcript";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

let smoothStreamingEnabled = true;
vi.mock("../../app/use-smooth-streaming.js", () => ({
  isSmoothStreamingEffective: () => smoothStreamingEnabled,
  useSmoothStreaming: () => smoothStreamingEnabled,
}));

class FakeTranscriptStore {
  #listeners = new Set<() => void>();
  #state: ThreadClientState;
  #historyPages: NormalizedThreadSnapshot[];
  activityDetail: "full" | "summary" = "full";
  #activityDetailWillChangeListeners = new Set<
    (activityDetail: "full" | "summary") => void
  >();
  #projectionViewportAnchor?: ThreadProjectionViewportAnchor;
  beforePrepend?: () => void;
  forkTurn = vi.fn(async () => ({
    status: "created" as const,
    childThreadId: "child-thread",
  }));
  clearForkAttempt = vi.fn();
  setTurnBookmarked = vi.fn(async () => undefined);
  refreshTurnBookmarkPreview = vi.fn(async () => undefined);
  seekHistoryTurn = vi.fn(
    async (targetTurnId: string): Promise<ThreadHistorySeekResult> => ({
      status: "not_found",
      targetTurnId,
    }),
  );
  loadComposerAttachmentContent = vi.fn(
    async (_attachmentId: string, _signal?: AbortSignal) => new Blob(),
  );
  loadOutputArtifactContent = vi.fn(
    async (_artifactId: string, _signal?: AbortSignal) => new Blob(),
  );

  constructor(
    snapshot: NormalizedThreadSnapshot,
    historyPages: NormalizedThreadSnapshot[] = [
      makeSnapshot(["turn-1", "turn-2", "turn-3"], false),
    ],
  ) {
    this.#historyPages = [...historyPages];
    this.#state = {
      status: "ready",
      connection: "connected",
      authoritative: true,
      actionPending: false,
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
      pendingComposerTransfers: [],
      pendingQueuedSteers: [],
      snapshot,
      stashes: [],
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  subscribeActivityDetailWillChange = (
    listener: (activityDetail: "full" | "summary") => void,
  ): (() => void) => {
    this.#activityDetailWillChangeListeners.add(listener);
    return () => this.#activityDetailWillChangeListeners.delete(listener);
  };

  rememberProjectionViewportAnchor(
    anchor: ThreadProjectionViewportAnchor,
  ): void {
    this.#projectionViewportAnchor = anchor;
  }

  takeProjectionViewportAnchor(
    activityDetail: "full" | "summary",
  ): ThreadProjectionViewportAnchor | undefined {
    const anchor = this.#projectionViewportAnchor;
    if (!anchor || anchor.activityDetail !== activityDetail) return undefined;
    this.#projectionViewportAnchor = undefined;
    return anchor;
  }

  getSnapshot = (): ThreadClientState => this.#state;

  loadOlderHistory = vi.fn(async (): Promise<void> => {
    this.beforePrepend?.();
    const next = this.#historyPages.shift();
    if (!next) return;
    this.#state = {
      ...this.#state,
      snapshot: next,
    };
    for (const listener of this.#listeners) listener();
  });

  loadAllOlderHistory = vi.fn(async (): Promise<void> => {
    while (this.#historyPages.length > 0) {
      await this.loadOlderHistory();
      if (!this.#state.snapshot?.history.hasOlder) return;
    }
  });

  replaceSnapshot(snapshot: NormalizedThreadSnapshot): void {
    this.#state = { ...this.#state, snapshot };
    for (const listener of this.#listeners) listener();
  }

  replaceConnection(
    connection: ThreadClientState["connection"],
    authoritative: boolean,
  ): void {
    this.#state = { ...this.#state, connection, authoritative };
    for (const listener of this.#listeners) listener();
  }

  replaceProjection(
    activityDetail: "full" | "summary",
    snapshot?: NormalizedThreadSnapshot,
  ): void {
    for (const listener of this.#activityDetailWillChangeListeners) {
      listener(activityDetail);
    }
    this.activityDetail = activityDetail;
    this.#state = {
      ...this.#state,
      snapshot,
      authoritative: snapshot !== undefined,
      connection: snapshot ? "connected" : "reconnecting",
    };
    for (const listener of this.#listeners) listener();
  }

  replaceTransfers(transfers: readonly PendingComposerTransfer[]): void {
    this.#state = { ...this.#state, pendingComposerTransfers: transfers };
    for (const listener of this.#listeners) listener();
  }

  replaceBookmarkState(
    changes: Partial<
      Pick<
        ThreadClientState,
        "bookmarks" | "bookmarkStatus" | "pendingBookmarkTurnIds"
      >
    >,
  ): void {
    this.#state = { ...this.#state, ...changes };
    for (const listener of this.#listeners) listener();
  }

  replacePresentation(
    snapshot: NormalizedThreadSnapshot,
    transfers: readonly PendingComposerTransfer[],
  ): void {
    this.#state = {
      ...this.#state,
      snapshot,
      pendingComposerTransfers: transfers,
    };
    for (const listener of this.#listeners) listener();
  }
}

function makePendingSubmitTransfer(
  snapshot: NormalizedThreadSnapshot,
  overrides: Partial<PendingComposerTransfer> = {},
): PendingComposerTransfer {
  return {
    operationId: "33333333-3333-4333-8333-333333333333",
    mode: "submit",
    captured: {
      text: "Immediate prompt",
      selectedSkillId: "skill-review",
      contextExcerpts: [],
      attachments: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          kind: "file",
          fileName: "notes.txt",
          mediaType: "application/octet-stream",
          byteSize: 12,
        },
      ],
      taskReferences: [
        {
          taskId: "55555555-5555-4555-8555-555555555555",
          titleSnapshot: "Review the patch",
        },
      ],
      revision: snapshot.draft.revision,
    },
    capturedPresentation: { selectedSkillLabel: "Review" },
    startedAt: 1,
    presentationSequence: 1,
    baselineThreadRevision: snapshot.thread.threadRevision,
    baselineOrderedTurnIds: [...snapshot.orderedTurnIds],
    baselineTailTurnItemIds: [],
    acceptanceEvidence: "none",
    presentation: "transcript",
    requestState: "requesting",
    authorityState: "client_only",
    rollbackRequired: false,
    rollbackApplied: false,
    lateMaterializationRequiresComposerReconciliation: false,
    retainTombstoneAfterRollback: false,
    ...overrides,
  };
}

beforeEach(() => {
  render(<OperationOverlayHost />);
  smoothStreamingEnabled = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
});

afterEach(() => {
  getBlockingOperation()?.cancel();
  cleanup();
  clearDiagnostics();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Transcript history positioning", () => {
  function controllableAnimationFrames(): () => void {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        callbacks.delete(id);
      }),
    );
    return () => {
      let frames = 0;
      while (callbacks.size > 0 && frames++ < 50) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback(frames * 120);
      }
      expect(callbacks.size).toBe(0);
    };
  }

  it("shows compact read-only questions on a seek-only history page", async () => {
    const snapshot = userMessageSnapshot(["turn-3"]);
    const page = historyPage(["turn-1"]);
    page.itemsById["turn-1-message"] = asyncQuestionItem("turn-1");
    const fake = new FakeTranscriptStore(snapshot);
    fake.seekHistoryTurn.mockResolvedValueOnce({
      status: "found",
      targetTurnId: "turn-1",
      page,
    });

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );

    expect(
      await screen.findByTestId("question-transcript-disclosure"),
    ).toHaveTextContent("Which region?");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows compact read-only questions in focused history", () => {
    const snapshot = makeSnapshot(["turn-3"], false);
    snapshot.itemsById["turn-3-message"] = asyncQuestionItem("turn-3");
    const fake = new FakeTranscriptStore(snapshot);

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-3"
      />,
    );

    expect(
      screen.getByTestId("question-transcript-disclosure"),
    ).toHaveTextContent("Which region?");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fake.seekHistoryTurn).not.toHaveBeenCalled();
  });

  it("keeps a newer live question active after an earlier optimistic user row", () => {
    const baseline = makeSnapshot([], false);
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.itemsById["turn-1-message"] = asyncQuestionItem("turn-1");
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([makePendingSubmitTransfer(baseline)]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const optimistic = screen.getByText("Immediate prompt");
    const question = screen.getByTestId("question-transcript-disclosure");
    expect(
      optimistic.compareDocumentPosition(question) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "A later user message already follows these questions.",
      ),
    ).toBeNull();
  });

  it("keeps an attachment content request alive across capability-only snapshots", async () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.itemsById["turn-1-message"] = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [
        {
          kind: "attachment",
          attachment: {
            id: "attachment-image-1",
            fileName: "diagram.png",
            kind: "image",
            mediaType: "image/png",
            byteSize: 24,
          },
        },
      ],
    };
    const fake = new FakeTranscriptStore(snapshot);
    let requestSignal: AbortSignal | undefined;
    fake.loadComposerAttachmentContent.mockImplementation(
      async (_attachmentId, signal) => {
        requestSignal = signal;
        return await new Promise<Blob>(() => undefined);
      },
    );

    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    await waitFor(() =>
      expect(fake.loadComposerAttachmentContent).toHaveBeenCalledOnce(),
    );

    act(() =>
      fake.replaceSnapshot({
        ...snapshot,
        capabilities: {
          ...snapshot.capabilities,
          providerFeatures: [...snapshot.capabilities.providerFeatures],
        },
      }),
    );

    expect(fake.loadComposerAttachmentContent).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(false);
  });

  it("seeks a loaded turn in the ordinary transcript and dismisses its outline outside", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const fake = new FakeTranscriptStore(
      makeSnapshot(["turn-1", "turn-2"], false),
    );
    const transcript = createRef<TranscriptHandle>();
    render(
      <>
        <button type="button">Outside transcript</button>
        <Transcript
          ref={transcript}
          store={fake as unknown as ThreadClientStore}
        />
      </>,
    );
    const viewport = screen.getByRole("region", { name: "Messages" });
    const target = document.querySelector<HTMLElement>(
      '[data-turn-id="turn-1"]',
    )!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 240 }),
    });

    let found = false;
    act(() => {
      found = transcript.current!.seekTurn("turn-1");
    });
    expect(found).toBe(true);
    expect(viewport.scrollTo).toHaveBeenCalled();
    expect(target).toHaveClass("source-turn-highlight");
    expect(target).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Return to latest" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside transcript" }),
    );
    expect(target).not.toHaveClass("source-turn-highlight");

    act(() => {
      found = transcript.current!.seekTurn("turn-missing");
    });
    expect(found).toBe(false);
    expect(fake.seekHistoryTurn).not.toHaveBeenCalled();
  });

  it.each([
    { partial: "Partial response", complete: "Partial response completed.", completedPreview: "Partial response completed." },
    { partial: "See [the docs](https://example.invalid/partial", complete: "See [the docs](https://example.invalid/docs) for details", completedPreview: "See the docs for details" },
  ])("offers an active bookmark and refreshes its completed preview: $partial", ({ partial, complete, completedPreview }) => {
    const snapshot = userMessageSnapshot(["turn-1"]);
    snapshot.turnsById["turn-1"] = { ...snapshot.turnsById["turn-1"]!, status: "in_progress" };
    const fake = new FakeTranscriptStore(snapshot);
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    fireEvent.click(screen.getByRole("button", { name: "Bookmark turn" }));
    expect(fake.setTurnBookmarked).toHaveBeenLastCalledWith({
      turnId: "turn-1", bookmarked: true,
      preview: { userPreview: "Prompt turn-1", assistantPreview: null, responseState: "no_response" },
    });

    const thinking = structuredClone(snapshot);
    thinking.turnsById["turn-1"] = {
      ...thinking.turnsById["turn-1"]!,
      orderedItemIds: [...thinking.turnsById["turn-1"]!.orderedItemIds, "reasoning"],
    };
    thinking.itemsById.reasoning = {
      id: "reasoning",
      turnId: "turn-1",
      kind: "reasoning",
      status: "streaming",
      revision: 1,
      markdown: { text: "Thinking about the reply" },
    };
    act(() => fake.replaceSnapshot(thinking));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark turn" }));
    expect(fake.setTurnBookmarked).toHaveBeenLastCalledWith({
      turnId: "turn-1", bookmarked: true,
      preview: { userPreview: "Prompt turn-1", assistantPreview: null, responseState: "no_response" },
    });

    const replying = structuredClone(snapshot);
    replying.turnsById["turn-1"] = { ...replying.turnsById["turn-1"]!, orderedItemIds: [...replying.turnsById["turn-1"]!.orderedItemIds, "reply"] };
    replying.itemsById.reply = {
      id: "reply", turnId: "turn-1", kind: "assistant_message",
      status: "streaming", revision: 1, markdown: { text: partial },
    };
    act(() => fake.replaceSnapshot(replying));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark turn" }));
    expect(fake.setTurnBookmarked).toHaveBeenCalledWith({
      turnId: "turn-1", bookmarked: true,
      preview: { userPreview: "Prompt turn-1", assistantPreview: partial, responseState: "responded" },
    });
    act(() => fake.replaceBookmarkState({ bookmarks: [{
      turnId: "turn-1", userPreview: "Prompt turn-1", assistantPreview: partial,
      responseState: "responded", createdAt: 1,
    }] }));
    // An existing bookmark stays removable even if the active projection no
    // longer contains the reply that originally made the turn eligible.
    act(() => fake.replaceSnapshot(snapshot));
    fireEvent.click(screen.getByRole("button", { name: "Remove turn bookmark" }));
    expect(fake.setTurnBookmarked).toHaveBeenLastCalledWith({ turnId: "turn-1", bookmarked: false });
    expect(fake.refreshTurnBookmarkPreview).not.toHaveBeenCalled();

    const completed = structuredClone(replying);
    completed.turnsById["turn-1"] = { ...completed.turnsById["turn-1"]!, status: "completed" };
    completed.itemsById.reply = { ...replying.itemsById.reply!, status: "completed", markdown: { text: complete } } as ConversationItem;
    act(() => fake.replaceSnapshot(completed));
    expect(fake.refreshTurnBookmarkPreview).toHaveBeenCalledWith({
      turnId: "turn-1",
      preview: { userPreview: "Prompt turn-1", assistantPreview: completedPreview, responseState: "responded" },
    });
  });

  it.each(["interrupted", "failed"] as const)("keeps bookmarks available after a turn is %s", (status) => {
    const snapshot = userMessageSnapshot(["turn-1"]);
    snapshot.turnsById["turn-1"] = { ...snapshot.turnsById["turn-1"]!, status };
    const fake = new FakeTranscriptStore(snapshot);
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    fireEvent.click(screen.getByRole("button", { name: "Bookmark turn" }));
    expect(fake.setTurnBookmarked).toHaveBeenCalledWith({
      turnId: "turn-1", bookmarked: true,
      preview: { userPreview: "Prompt turn-1", assistantPreview: null, responseState: "no_response" },
    });
    act(() => fake.replaceBookmarkState({ bookmarks: [{
      turnId: "turn-1", userPreview: "Prompt turn-1", assistantPreview: "Earlier reply",
      responseState: "responded", createdAt: 1,
    }] }));
    expect(screen.getByRole("button", { name: "Remove turn bookmark" })).toBeEnabled();
    expect(fake.refreshTurnBookmarkPreview).not.toHaveBeenCalled();
  });

  it("refreshes a no-response bookmark when a finished turn loads its reply", () => {
    const snapshot = userMessageSnapshot(["turn-1"]);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: [...snapshot.turnsById["turn-1"]!.orderedItemIds, "reply"],
    };
    snapshot.itemsById.reply = {
      id: "reply",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "completed",
      revision: 1,
      markdown: { text: "Restored reply" },
    };
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceBookmarkState({ bookmarks: [{
      turnId: "turn-1", userPreview: "Prompt turn-1", assistantPreview: null,
      responseState: "no_response", createdAt: 1,
    }] });
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    expect(fake.refreshTurnBookmarkPreview).toHaveBeenCalledWith({
      turnId: "turn-1",
      preview: { userPreview: "Prompt turn-1", assistantPreview: "Restored reply", responseState: "responded" },
    });
  });

  it("does not refresh saved previews from a retained nonauthoritative projection", () => {
    const snapshot = userMessageSnapshot(["turn-1"]);
    const fake = new FakeTranscriptStore(snapshot);
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    act(() => fake.replaceProjection("summary"));
    act(() => fake.replaceBookmarkState({ bookmarks: [{
      turnId: "turn-1", userPreview: "Prompt turn-1", assistantPreview: "Saved reply",
      responseState: "responded", createdAt: 1,
    }] }));
    expect(fake.refreshTurnBookmarkPreview).not.toHaveBeenCalled();
  });

  it("does not schedule a reply refresh for only a different retained user preview", () => {
    const fake = new FakeTranscriptStore(userMessageSnapshot(["turn-1"]));
    fake.replaceBookmarkState({ bookmarks: [{
      turnId: "turn-1", userPreview: "Earlier saved prompt", assistantPreview: null,
      responseState: "no_response", createdAt: 1,
    }] });
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    expect(fake.refreshTurnBookmarkPreview).not.toHaveBeenCalled();
  });

  it("shows mutation progress only for the bookmark turn being changed", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.itemsById["turn-1-message"] = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "Save this turn" } }],
    };
    const fake = new FakeTranscriptStore(snapshot);
    const { container } = render(
      <Transcript store={fake as unknown as ThreadClientStore} />,
    );

    act(() => fake.replaceBookmarkState({ bookmarkStatus: "error" }));
    const toggle = screen.getByRole("button", { name: "Bookmark turn" });
    expect(toggle).toBeDisabled();
    expect(container.querySelector(".turn-bookmark-spinner")).toBeNull();

    act(() =>
      fake.replaceBookmarkState({
        bookmarkStatus: "ready",
        pendingBookmarkTurnIds: ["turn-1"],
      }),
    );
    expect(toggle).toBeDisabled();
    expect(container.querySelector(".turn-bookmark-spinner")).not.toBeNull();
  });

  it("restores a stable visible activity anchor across projection replacement", () => {
    const full = activitySnapshot("reasoning");
    const summary = activitySnapshot("activity_summary");
    const fake = new FakeTranscriptStore(full);
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
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    const originalViewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(originalViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    originalViewport.scrollTop = 400;
    fireEvent.scroll(originalViewport);
    fireEvent.scroll(originalViewport);

    act(() => fake.replaceProjection("summary"));
    act(() => fake.replaceProjection("summary", summary));

    const replacementViewport = screen.getByRole("region", {
      name: "Messages",
    });
    expect(replacementViewport).not.toBe(originalViewport);
    expect(replacementViewport.scrollTop).toBe(200);
    rect.mockRestore();
  });

  it("anchors an expanded activity group by its disclosure rather than a disappearing child", () => {
    const full = activitySnapshot("reasoning");
    const summary = activitySnapshot("activity_summary");
    const fake = new FakeTranscriptStore(full);
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("message-viewport")) {
          return { top: 0 } as DOMRect;
        }
        if (this.hasAttribute("data-activity-first-item-id")) {
          return {
            top: this.dataset.activityDetail === "summary" ? 250 : -120,
          } as DOMRect;
        }
        if (this.hasAttribute("data-item-id")) {
          return { top: 20 } as DOMRect;
        }
        return { top: -300 } as DOMRect;
      });
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    const originalViewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(originalViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    originalViewport.scrollTop = 400;
    fireEvent.scroll(originalViewport);
    fireEvent.scroll(originalViewport);

    act(() => fake.replaceProjection("summary"));
    act(() => fake.replaceProjection("summary", summary));

    const replacementViewport = screen.getByRole("region", {
      name: "Messages",
    });
    expect(replacementViewport.scrollTop).toBe(250);
    rect.mockRestore();
  });

  it("renders immutable task context with a stable task identity", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["task-message"],
    };
    snapshot.itemsById = {
      "task-message": {
        id: "task-message",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [
          {
            kind: "task_context",
            task: {
              id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
              scope: { kind: "global" },
              title: "Title captured at send",
              details: "Details captured at send",
              pinned: false,
              files: [],
              completedAt: null,
              revision: 4,
              createdAt: "2026-08-12T00:00:00.000Z",
              updatedAt: "2026-08-12T01:00:00.000Z",
            },
          },
        ],
      },
    };
    const fake = new FakeTranscriptStore(snapshot);

    const { container } = render(
      <Transcript store={fake as unknown as ThreadClientStore} />,
    );

    const card = container.querySelector(
      '[data-task-id="84f9a3b0-9c14-456d-b08d-58d325d869d0"]',
    );
    expect(card).toHaveTextContent("Title captured at send");
    expect(card).toHaveTextContent("Details captured at send");
    expect(card).toHaveTextContent("84f9a3b0-9c14-456d-b08d-58d325d869d0");
    expect(card).toHaveTextContent("4");
  });

  it("jumps from a rail preview to the matching user message", () => {
    const snapshot = makeSnapshot(["turn-1", "turn-2"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["turn-1-user", "turn-1-message"],
    };
    snapshot.turnsById["turn-2"] = {
      ...snapshot.turnsById["turn-2"]!,
      orderedItemIds: ["turn-2-user", "turn-2-message"],
    };
    snapshot.itemsById["turn-1-user"] = {
      id: "turn-1-user",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "First prompt" } }],
    };
    snapshot.itemsById["turn-2-user"] = {
      id: "turn-2-user",
      turnId: "turn-2",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "Second prompt" } }],
    };
    const fake = new FakeTranscriptStore(snapshot);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_500 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
    });
    viewport.scrollTop = 500;
    const firstMessage = document.querySelector<HTMLElement>(
      '[data-item-id="turn-1-user"]',
    )!;
    Object.defineProperty(firstMessage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 240 }),
    });
    const scrollTo = vi.fn();
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Jump to conversation message 1",
      }),
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 684, behavior: "smooth" });
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  function mountAdjacentHistoryNavigation() {
    const turnIds = ["turn-1", "turn-2", "turn-3"];
    const snapshot = makeSnapshot(turnIds, false);
    for (const turnId of turnIds) {
      const itemId = `${turnId}-user`;
      snapshot.turnsById[turnId] = {
        ...snapshot.turnsById[turnId]!,
        orderedItemIds: [itemId, `${turnId}-message`],
      };
      snapshot.itemsById[itemId] = {
        id: itemId,
        turnId,
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [{ kind: "text", text: { text: `${turnId} prompt` } }],
      };
    }
    const fake = new FakeTranscriptStore(snapshot);
    const ref = createRef<TranscriptHandle>();
    render(<Transcript ref={ref} store={fake as unknown as ThreadClientStore} />);
    const viewport = screen.getByRole("region", { name: "Messages" });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = Math.min(1_200, Math.max(0, top ?? 0));
    });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_500 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    turnIds.forEach((turnId, index) => {
      const row = document.querySelector<HTMLElement>(
        `[data-item-id="${turnId}-user"]`,
      )!;
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 40 + index * 500 - viewport.scrollTop }),
      });
    });
    return {
      viewport,
      scrollTo,
      seek: (direction: "previous" | "next") =>
        act(() => ref.current!.seekAdjacentHistoryItem(direction)),
    };
  }

  it("seeks adjacent prompts from the manually scrolled viewport", () => {
    const { viewport, scrollTo, seek } = mountAdjacentHistoryNavigation();
    viewport.scrollTop = 650;
    fireEvent.scroll(viewport);

    seek("previous");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 484, behavior: "auto" });
    expect(viewport.scrollTop).toBe(484);

    // A later reader scroll determines the next hop, even though the last
    // explicitly selected prompt was the second one.
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    seek("next");
    expect(viewport.scrollTop).toBe(484);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("supports repeated and reversed adjacent prompt navigation", () => {
    const { viewport, seek } = mountAdjacentHistoryNavigation();
    viewport.scrollTop = 0;
    seek("next");
    expect(viewport.scrollTop).toBe(484);
    seek("next");
    expect(viewport.scrollTop).toBe(984);
    seek("previous");
    expect(viewport.scrollTop).toBe(484);
    seek("previous");
    expect(viewport.scrollTop).toBe(0);
  });

  it("does not wrap at prompt boundaries and tolerates subpixel alignment", () => {
    const { viewport, scrollTo, seek } = mountAdjacentHistoryNavigation();
    viewport.scrollTop = 0;
    seek("previous");
    expect(scrollTo).not.toHaveBeenCalled();
    viewport.scrollTop = 984;
    seek("next");
    expect(scrollTo).not.toHaveBeenCalled();
    viewport.scrollTop = 484.5;
    seek("previous");
    expect(viewport.scrollTop).toBe(0);
  });

  it("renders authenticated callback provenance through the transcript user-message path", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["callback-result"],
    };
    snapshot.itemsById["callback-result"] = {
      id: "callback-result",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      deliveryOperationId: "callback-1",
      origin: {
        kind: "agent_result",
        callbackId: "callback-1",
        sourceThreadId: "worker-thread",
        sourceThreadLabel: { text: "Research worker" },
      },
      content: [{ kind: "text", text: { text: "Research finished" } }],
    };

    const { container } = render(
      <Transcript
        store={
          new FakeTranscriptStore(snapshot) as unknown as ThreadClientStore
        }
      />,
    );

    expect(screen.getByText("Agent result")).toBeInTheDocument();
    expect(screen.getByText("Research worker")).toBeInTheDocument();
    expect(screen.getAllByText("Research finished").length).toBeGreaterThan(0);
    expect(screen.queryByText("You", { selector: "header" })).toBeNull();
    expect(
      container.querySelector('[data-message-origin="agent_result"]'),
    ).not.toBeNull();
  });

  it("uses auto for a far rail target, including a long upward jump", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["turn-1-user", "turn-1-message"],
    };
    snapshot.itemsById["turn-1-user"] = {
      id: "turn-1-user",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "First prompt" } }],
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    render(
      <Transcript
        store={
          new FakeTranscriptStore(snapshot) as unknown as ThreadClientStore
        }
      />,
    );

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 3_000 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    viewport.scrollTop = 2_200;
    const target = document.querySelector<HTMLElement>(
      '[data-item-id="turn-1-user"]',
    )!;
    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: -1_960 }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to conversation message 1" }),
    );

    expect(viewport.scrollTo).toHaveBeenCalledWith({
      top: 184,
      behavior: "auto",
    });
  });

  it("uses smooth at the inclusive two-viewport rail threshold", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["turn-1-user", "turn-1-message"],
    };
    snapshot.itemsById["turn-1-user"] = {
      id: "turn-1-user",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "First prompt" } }],
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    render(
      <Transcript
        store={
          new FakeTranscriptStore(snapshot) as unknown as ThreadClientStore
        }
      />,
    );

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2_000 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    viewport.scrollTop = 1_000;
    const target = document.querySelector<HTMLElement>(
      '[data-item-id="turn-1-user"]',
    )!;
    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: -544 }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to conversation message 1" }),
    );

    expect(viewport.scrollTo).toHaveBeenCalledWith({
      top: 400,
      behavior: "smooth",
    });
  });

  it("uses distance-aware behavior for Jump to latest", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    const viewport = screen.getByRole("region", { name: "Messages" });
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    // The viewport acquires its real geometry after jsdom mounts it. Let the
    // resize reconciliation establish that baseline before simulating the
    // reader's scroll away from the live edge.
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_000,
      behavior: "smooth",
    });

    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 2_000,
      behavior: "auto",
    });
  });

  it("forces auto for near navigation when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["turn-1-user", "turn-1-message"],
    };
    snapshot.itemsById["turn-1-user"] = {
      id: "turn-1-user",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "First prompt" } }],
    };
    render(
      <Transcript
        store={
          new FakeTranscriptStore(snapshot) as unknown as ThreadClientStore
        }
      />,
    );
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 }),
      },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    viewport.scrollTop = 500;
    const target = document.querySelector<HTMLElement>(
      '[data-item-id="turn-1-user"]',
    )!;
    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 240 }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to conversation message 1" }),
    );
    expect(viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 684,
      behavior: "auto",
    });

    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 1_000,
      behavior: "auto",
    });
  });

  it("renders a focusable inclusive fork action after each completed turn", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.forkSource = {
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    };
    snapshot.forksByTurnId["turn-1"] = {
      sourceTurnId: "turn-1",
      expectedTurnRevision: 1,
      available: true,
    };
    const fake = new FakeTranscriptStore(snapshot);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const action = screen.getByRole("button", { name: /Fork from here/ });
    expect(action).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByText(/includes this completed turn/)).toHaveClass(
      "sr-only",
    );
    fireEvent.click(action);
    expect(fake.forkTurn).toHaveBeenCalledWith(
      snapshot.forksByTurnId["turn-1"],
      { restart: false },
    );
  });

  it("renders completed-turn footer with a disabled unavailable fork action", () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const action = screen.getByRole("button", { name: /Fork from here/ });
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("turn-fork-turn-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toBeInTheDocument();
  });

  it("keeps an earlier completed fork action while hiding the active turn footer", () => {
    const snapshot = makeSnapshot(["turn-1", "turn-2"], false);
    snapshot.forkSource = {
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    };
    snapshot.forksByTurnId["turn-1"] = {
      sourceTurnId: "turn-1",
      expectedTurnRevision: 1,
      available: true,
    };
    snapshot.turnsById["turn-2"] = {
      ...snapshot.turnsById["turn-2"]!,
      status: "in_progress",
      endedBy: undefined,
      completedAt: undefined,
    };
    snapshot.activeTurnId = "turn-2";
    snapshot.runState = "running";
    snapshot.thread = { ...snapshot.thread, runState: "running" };
    const fake = new FakeTranscriptStore(snapshot);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    expect(screen.getByTestId("turn-fork-turn-1")).toBeInTheDocument();
    expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveAttribute(
      "data-latest-completed-turn",
      "true",
    );
    expect(
      document.querySelector('[data-turn-id="turn-2"]'),
    ).not.toHaveAttribute("data-latest-completed-turn");
    expect(
      screen.getByRole("button", { name: /Fork from here/ }),
    ).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByTestId("turn-fork-turn-2")).toBeNull();
  });

  it("does not present an uncertain creation as ready", () => {
    const snapshot = makeSnapshot([], false);
    const fake = new FakeTranscriptStore({
      ...snapshot,
      thread: {
        ...snapshot.thread,
        backingState: "creation_unknown",
        runState: "failed",
      },
    });

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    expect(
      screen.getByRole("heading", { name: "Thread creation needs attention" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("This thread is ready")).not.toBeInTheDocument();
  });

  it("describes an empty read-only transcript without prompting a send", () => {
    const fake = new FakeTranscriptStore(makeSnapshot([], false));

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    expect(
      screen.getByText(
        "This imported thread has no conversation history to display.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Write a prompt/)).not.toBeInTheDocument();
  });

  it("keeps the first visible turn anchored when earlier turns are prepended", async () => {
    const fake = new FakeTranscriptStore(
      makeSnapshot(["turn-2", "turn-3"], true),
    );
    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    viewport.scrollTop = 240;

    const anchoredTurn = document.querySelector<HTMLElement>(
      '[data-turn-id="turn-2"]',
    );
    expect(anchoredTurn).not.toBeNull();
    let anchorOffset = 120;
    Object.defineProperty(anchoredTurn!, "offsetTop", {
      configurable: true,
      get: () => anchorOffset,
    });
    fake.beforePrepend = () => {
      anchorOffset = 360;
    };

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(
        document.querySelector('[data-turn-id="turn-1"]'),
      ).toBeInTheDocument();
    });
    expect(viewport.scrollTop).toBe(480);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("loads all older pages while preserving the reader's anchor", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true), [
      makeSnapshot(["turn-2", "turn-3"], true),
      makeSnapshot(["turn-1", "turn-2", "turn-3"], false),
    ]);
    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    viewport.scrollTop = 240;
    const anchoredTurn = document.querySelector<HTMLElement>(
      '[data-turn-id="turn-3"]',
    )!;
    let anchorOffset = 120;
    Object.defineProperty(anchoredTurn, "offsetTop", {
      configurable: true,
      get: () => anchorOffset,
    });
    fake.beforePrepend = () => {
      anchorOffset += 120;
    };

    fireEvent.click(screen.getByRole("button", { name: "Load all" }));

    await waitFor(() =>
      expect(
        document.querySelector('[data-turn-id="turn-1"]'),
      ).toBeInTheDocument(),
    );
    expect(fake.loadAllOlderHistory).toHaveBeenCalledOnce();
    expect(fake.loadOlderHistory).toHaveBeenCalledTimes(2);
    expect(viewport.scrollTop).toBeGreaterThan(240);
  });

  it("ignores scrolls during a selection drag but resumes once it releases", () => {
    const fake = new FakeTranscriptStore(
      makeSnapshot(["turn-2", "turn-3"], true),
    );
    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });

    // Mid-drag: pointer down with a growing selection. Edge auto-scrolls
    // from the drag must not read as reader scroll intent.
    const selection = vi
      .spyOn(document, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent(window, new Event("pointerdown"));
    fireEvent(document, new Event("selectionchange"));
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // Released: the selection itself persists, but the guard clears and the
    // viewport is re-measured directly — the drag's edge autoscroll moved it
    // off the live edge, so follow must not act on the stale flag.
    fireEvent(window, new Event("pointerup"));
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    selection.mockRestore();
  });

  it("loads older history to seek and highlight a normalized source turn", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    fake.seekHistoryTurn.mockResolvedValueOnce({
      status: "found",
      targetTurnId: "turn-1",
      page: historyPage(["turn-1", "turn-2"]),
    });

    const onReturnToLive = vi.fn();
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
        onReturnToLive={onReturnToLive}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveClass(
        "source-turn-highlight",
      );
    });
    expect(fake.seekHistoryTurn).toHaveBeenCalledOnce();
    expect(fake.loadOlderHistory).not.toHaveBeenCalled();
    expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveAttribute(
      "aria-label",
      "Selected turn",
    );
    fireEvent.click(screen.getByRole("button", { name: "Return to latest" }));
    expect(onReturnToLive).toHaveBeenCalledOnce();
  });

  it("invalidates a resolved source page and reloads it for a new activity projection", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    const detailedPage = activityHistoryPage("reasoning", "full detail");
    const summaryPage = activityHistoryPage("activity_summary");
    fake.seekHistoryTurn
      .mockResolvedValueOnce({
        status: "found",
        targetTurnId: "turn-1",
        page: detailedPage,
      })
      .mockResolvedValueOnce({
        status: "found",
        targetTurnId: "turn-1",
        page: summaryPage,
      });

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-activity-detail="full"]'),
      ).not.toBeNull(),
    );

    act(() => fake.replaceProjection("summary"));
    expect(document.querySelector('[data-activity-detail="full"]')).toBeNull();
    act(() =>
      fake.replaceProjection("summary", makeSnapshot(["turn-3"], true)),
    );

    await waitFor(() => expect(fake.seekHistoryTurn).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        document.querySelector('[data-activity-detail="summary"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector('[data-activity-detail="full"]')).toBeNull();
  });

  it("ignores an in-flight source page from the prior activity projection", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    let resolveDetailed!: (result: ThreadHistorySeekResult) => void;
    fake.seekHistoryTurn
      .mockImplementationOnce(
        () =>
          new Promise<ThreadHistorySeekResult>((resolve) => {
            resolveDetailed = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "found",
        targetTurnId: "turn-1",
        page: activityHistoryPage("activity_summary"),
      });
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );
    await waitFor(() => expect(fake.seekHistoryTurn).toHaveBeenCalledOnce());

    act(() => fake.replaceProjection("summary"));
    act(() =>
      fake.replaceProjection("summary", makeSnapshot(["turn-3"], true)),
    );
    await waitFor(() => expect(fake.seekHistoryTurn).toHaveBeenCalledTimes(2));
    act(() =>
      resolveDetailed({
        status: "found",
        targetTurnId: "turn-1",
        page: activityHistoryPage("reasoning", "stale full detail"),
      }),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-activity-detail="summary"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector('[data-activity-detail="full"]')).toBeNull();
  });

  it("forks a completed turn using the capability from a seek-only history page", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    const page = historyPage(["turn-1", "turn-2"]);
    page.forksByTurnId["turn-1"] = {
      sourceTurnId: "turn-1",
      expectedTurnRevision: 11,
      available: true,
    };
    fake.seekHistoryTurn.mockResolvedValueOnce({
      status: "found",
      targetTurnId: "turn-1",
      page,
    });

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveClass(
        "source-turn-highlight",
      );
    });
    const action = within(screen.getByTestId("turn-fork-turn-1")).getByRole(
      "button",
      { name: /Fork from here/ },
    );
    fireEvent.click(action);
    expect(fake.forkTurn).toHaveBeenCalledWith(page.forksByTurnId["turn-1"], {
      restart: false,
    });
  });

  it("reports when a requested source turn is outside bounded history", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-missing"
      />,
    );

    expect(
      await screen.findByText(
        "The selected turn is outside the available conversation history.",
      ),
    ).toBeInTheDocument();
    expect(fake.seekHistoryTurn).toHaveBeenCalledOnce();
  });

  it("reports a bounded or unsupported source lookup truthfully", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    fake.seekHistoryTurn.mockResolvedValueOnce({
      status: "unavailable",
      targetTurnId: "turn-deep",
      reason: {
        text: "The fork point is deeper than the bounded source search.",
      },
      retryable: false,
    });

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-deep"
      />,
    );

    expect(
      await screen.findByText(
        "The fork point is deeper than the bounded source search.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry selected turn lookup" }),
    ).toBeNull();
  });

  it("holds a failed source lookup until an explicit retry", async () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-3"], true));
    fake.seekHistoryTurn
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce({
        status: "found",
        targetTurnId: "turn-1",
        page: historyPage(["turn-1"]),
      });

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected turn could not be loaded.",
    );
    fake.replaceSnapshot(makeSnapshot(["turn-3"], true));
    await act(async () => undefined);
    expect(fake.seekHistoryTurn).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry selected turn lookup" }),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveClass(
        "source-turn-highlight",
      );
    });
    expect(fake.seekHistoryTurn).toHaveBeenCalledTimes(2);
  });

  it("does not refocus a resolved source turn after later snapshots", async () => {
    const flushFrames = controllableAnimationFrames();
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveClass(
        "source-turn-highlight",
      );
    });
    act(flushFrames);
    expect(document.querySelector('[data-turn-id="turn-1"]')).toHaveFocus();
    const scheduledFrames = vi.mocked(requestAnimationFrame).mock.calls.length;
    const replacement = makeSnapshot(["turn-1"], false);
    replacement.thread = { ...replacement.thread, threadRevision: 2 };
    fake.replaceSnapshot(replacement);
    await act(async () => undefined);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(scheduledFrames);
  });

  it("focuses a checkpoint's source turn once when live arrives before its animation frame", () => {
    const flushFrames = controllableAnimationFrames();
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    fake.replaceConnection("reconnecting", false);
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );
    const target = document.querySelector<HTMLElement>(
      '[data-turn-id="turn-1"]',
    )!;
    const focus = vi.spyOn(target, "focus");
    expect(target).not.toHaveFocus();

    // Checkpoint data has already rendered. Its separate thread-live marker
    // changes readiness before the pending source-focus frame can execute.
    act(() => fake.replaceConnection("connected", true));
    act(flushFrames);
    expect(target).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();

    act(() => fake.replaceSnapshot(makeSnapshot(["turn-1"], false)));
    act(flushFrames);
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("Transcript optimistic idle submission", () => {
  const operationId = "33333333-3333-4333-8333-333333333333";
  const makeTransfer = makePendingSubmitTransfer;

  it("treats an optimistic user row as a hard activity-group boundary", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["reason-1", "command-1"],
    };
    snapshot.itemsById = {
      "reason-1": {
        id: "reason-1",
        turnId: "turn-1",
        kind: "reasoning",
        status: "completed",
        revision: 1,
        markdown: { text: "Reason before the optimistic row" },
      },
      "command-1": {
        id: "command-1",
        turnId: "turn-1",
        kind: "command",
        status: "completed",
        revision: 1,
        phase: "completed",
        command: { text: "pwd" },
        output: { text: "/workspace" },
      },
    };
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([
      makeTransfer(snapshot, {
        baselineTailItemId: "reason-1",
        baselineTailTurnId: "turn-1",
        baselineTailTurnItemIds: ["reason-1"],
      }),
    ]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const groups = screen.getAllByTestId("activity-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("data-activity-reasoning-count", "1");
    expect(groups[0]).toHaveAttribute("data-activity-tool-count", "0");
    expect(groups[1]).toHaveAttribute("data-activity-reasoning-count", "0");
    expect(groups[1]).toHaveAttribute("data-activity-tool-count", "1");
    const optimistic = screen.getByText("Immediate prompt");
    expect(
      groups[0]!.compareDocumentPosition(optimistic) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      optimistic.compareDocumentPosition(groups[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a first idle Send immediately as an ordinary final-looking user message", () => {
    const snapshot = makeSnapshot([], false);
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([makeTransfer(snapshot)]);

    const { container } = render(
      <Transcript store={fake as unknown as ThreadClientStore} />,
    );

    expect(screen.queryByText("This thread is ready")).not.toBeInTheDocument();
    const row = container.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${operationId}"]`,
    );
    expect(row).toHaveAttribute("data-client-provisional", "true");
    expect(row).toHaveAttribute("data-message-role", "user");
    expect(row).toHaveTextContent("Immediate prompt");
    expect(row).toHaveTextContent("Review");
    expect(row).toHaveTextContent("notes.txt");
    expect(row).toHaveTextContent("Review the patch");
    const attachment = row?.querySelector(
      '[data-attachment-id="44444444-4444-4444-8444-444444444444"]',
    );
    const prompt = screen.getByText("Immediate prompt");
    expect(
      attachment!.compareDocumentPosition(prompt) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row).not.toHaveTextContent(/sending|pending|provisional/i);
    expect(
      screen.queryByRole("button", { name: /conversation message/i }),
    ).not.toBeInTheDocument();
  });

  it("renders one unanchored bubble beside an identity-only empty turn", () => {
    const snapshot = makeSnapshot(["turn-identity"], false);
    snapshot.turnsById["turn-identity"] = {
      ...snapshot.turnsById["turn-identity"]!,
      orderedItemIds: [],
    };
    delete snapshot.itemsById["turn-identity-message"];
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([makeTransfer(snapshot)]);

    const { container } = render(
      <Transcript store={fake as unknown as ThreadClientStore} />,
    );

    expect(
      container.querySelectorAll(
        `[data-delivery-operation-id="${operationId}"]`,
      ),
    ).toHaveLength(1);
    expect(screen.getAllByText("Immediate prompt")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Bookmark turn" })).toBeNull();
  });

  it("keeps anchored optimistic submissions ahead of later authoritative output in sequence order", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.turnsById["turn-1"] = {
      ...snapshot.turnsById["turn-1"]!,
      orderedItemIds: ["turn-1-message", "later-assistant"],
    };
    snapshot.itemsById["later-assistant"] = {
      id: "later-assistant",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "completed",
      revision: 1,
      markdown: { text: "Later output" },
    };
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([
      makeTransfer(snapshot, {
        baselineTailItemId: "turn-1-message",
        captured: { ...snapshot.draft, text: "First optimistic" },
      }),
      makeTransfer(snapshot, {
        operationId: "66666666-6666-4666-8666-666666666666",
        presentationSequence: 2,
        baselineTailItemId: "turn-1-message",
        captured: { ...snapshot.draft, text: "Second optimistic" },
      }),
    ]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const first = screen.getByText("First optimistic");
    const second = screen.getByText("Second optimistic");
    const later = screen.getByText("Later output");
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      second.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("uses captured tail topology when a replacement snapshot loses the item anchor", () => {
    const baseline = makeSnapshot(["turn-0", "turn-1"], false);
    const transfer = makeTransfer(baseline, {
      baselineTailItemId: "turn-1-message",
      baselineTailTurnId: "turn-1",
      baselineTailTurnItemIds: ["turn-1-message"],
    });
    const replacement = makeSnapshot(["turn-0", "turn-1"], false);
    replacement.turnsById["turn-1"] = {
      ...replacement.turnsById["turn-1"]!,
      orderedItemIds: ["replacement-assistant"],
    };
    delete replacement.itemsById["turn-1-message"];
    replacement.itemsById["replacement-assistant"] = {
      id: "replacement-assistant",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "completed",
      revision: 1,
      markdown: { text: "Output after the missing anchor" },
    };
    const fake = new FakeTranscriptStore(replacement);
    fake.replaceTransfers([transfer]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    const preceding = screen.getByText("Message for turn-0");
    const optimistic = screen.getByText("Immediate prompt");
    const later = screen.getByText("Output after the missing anchor");
    expect(
      preceding.compareDocumentPosition(optimistic) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      optimistic.compareDocumentPosition(later) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("records one bounded nonfatal diagnostic when no anchor boundary survives", async () => {
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const baseline = makeSnapshot(["turn-0"], false);
    const transfer = makeTransfer(baseline, {
      baselineTailItemId: "turn-0-message",
      baselineTailTurnId: "turn-0",
      baselineTailTurnItemIds: ["turn-0-message"],
    });
    const replacement = makeSnapshot([], false);
    const fake = new FakeTranscriptStore(replacement);
    fake.replaceTransfers([transfer]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    await waitFor(() => {
      expect(
        readDiagnostics().filter(
          ({ event }) => event === "optimistic_anchor_unresolved",
        ),
      ).toHaveLength(1);
    });
    expect(screen.getByText("Immediate prompt")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => fake.replaceTransfers([transfer]));
    expect(
      readDiagnostics().filter(
        ({ event }) => event === "optimistic_anchor_unresolved",
      ),
    ).toHaveLength(1);
  });

  it("replaces the exact optimistic row with one authoritative message without provisional semantics", () => {
    const snapshot = makeSnapshot([], false);
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([makeTransfer(snapshot)]);
    const { container } = render(
      <Transcript store={fake as unknown as ThreadClientStore} />,
    );
    expect(screen.getAllByText("Immediate prompt")).toHaveLength(1);

    const authoritative = makeSnapshot(["turn-1"], false);
    authoritative.itemsById["turn-1-message"] = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      deliveryOperationId: operationId,
      content: [{ kind: "text", text: { text: "Immediate prompt" } }],
    };
    act(() => fake.replacePresentation(authoritative, []));

    expect(screen.getAllByText("Immediate prompt")).toHaveLength(1);
    const row = container.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${operationId}"]`,
    );
    expect(row).toHaveAttribute("data-item-id", "turn-1-message");
    expect(row).not.toHaveAttribute("data-client-provisional");
    expect(row).toHaveAttribute("data-local-optimistic-handoff", "true");
    expect(row).toHaveAttribute("aria-live", "off");
  });

  it("does not suppress a correlated authoritative message without a local optimistic handoff", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    snapshot.itemsById["turn-1-message"] = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      deliveryOperationId: operationId,
      content: [{ kind: "text", text: { text: "Another client prompt" } }],
    };

    const { container } = render(
      <Transcript
        store={
          new FakeTranscriptStore(snapshot) as unknown as ThreadClientStore
        }
      />,
    );

    const row = container.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${operationId}"]`,
    );
    expect(row).not.toHaveAttribute("data-local-optimistic-handoff");
    expect(row).not.toHaveAttribute("aria-live");
  });

  it("does not render transcript presentation after queue ownership takes over", () => {
    const snapshot = makeSnapshot([], false);
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([
      makeTransfer(snapshot, { authorityState: "queue_owned" }),
    ]);

    render(<Transcript store={fake as unknown as ThreadClientStore} />);

    expect(screen.queryByText("Immediate prompt")).not.toBeInTheDocument();
    expect(screen.getByText("This thread is ready")).toBeInTheDocument();
  });

  it("excludes optimistic presentation from a historical turn view", () => {
    const snapshot = makeSnapshot(["turn-1"], false);
    const fake = new FakeTranscriptStore(snapshot);
    fake.replaceTransfers([
      makeTransfer(snapshot, { baselineTailItemId: "turn-1-message" }),
    ]);

    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        focusTurnId="turn-1"
      />,
    );

    expect(screen.queryByText("Immediate prompt")).not.toBeInTheDocument();
    expect(screen.getByText("Message for turn-1")).toBeInTheDocument();
  });
});

describe("Transcript seek-on-submit", () => {
  const sentOperationId = "11111111-1111-4111-8111-111111111111";
  const nextOperationId = "22222222-2222-4222-8222-222222222222";
  // Scheduling and the live-edge follower still use rAF. Native seek
  // movement and scrollend are driven separately by mockNativeScroll.
  let rafCallbacks = new Map<number, FrameRequestCallback>();
  let rafIdCounter = 0;
  let rafNow = 0;
  const stepRaf = (elapsed = 120) => {
    rafNow += elapsed;
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const callback of callbacks) callback(rafNow);
  };
  const flushRaf = () => {
    let guard = 0;
    while (rafCallbacks.size > 0 && guard++ < 50) stepRaf();
  };

  beforeEach(() => {
    rafCallbacks = new Map();
    rafIdCounter = 0;
    rafNow = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        rafIdCounter += 1;
        rafCallbacks.set(rafIdCounter, callback);
        return rafIdCounter;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        rafCallbacks.delete(id);
      }),
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  function mockNativeScroll(viewport: HTMLElement) {
    let pending: { from: number; to: number } | undefined;
    const scrollTo = vi.fn(({ top = 0, behavior }: ScrollToOptions) => {
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const to = Math.min(maximum, Math.max(0, top));
      if (behavior === "smooth" && to !== viewport.scrollTop) {
        pending = { from: viewport.scrollTop, to };
      } else {
        pending = undefined;
        viewport.scrollTop = to;
      }
    });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const advanceNativeScroll = (progress: number) => {
      if (!pending) throw new Error("No native smooth scroll is pending");
      viewport.scrollTop = pending.from + (pending.to - pending.from) * progress;
      fireEvent.scroll(viewport);
    };
    const finishNativeScroll = () => {
      if (!pending) return;
      viewport.scrollTop = pending.to;
      pending = undefined;
      fireEvent.scroll(viewport);
      fireEvent(viewport, new Event("scrollend"));
    };
    const finishSeek = () => {
      flushRaf();
      finishNativeScroll();
      flushRaf();
    };
    return { scrollTo, advanceNativeScroll, finishNativeScroll, finishSeek };
  }

  function mockSeekSpacer(viewport: HTMLElement) {
    const spacer = screen.getByTestId("seek-spacer");
    // jsdom's CSS parser corrupts max(..., calc(...cqh...)) serialization.
    // Preserve the assigned expression for this fixture's layout model.
    let specifiedHeight = spacer.style.height;
    Object.defineProperty(spacer.style, "height", {
      configurable: true,
      get: () => specifiedHeight,
      set: (height: string) => {
        specifiedHeight = height;
      },
    });
    Object.defineProperty(spacer, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const height = spacer.style.height;
        if (!height || /^\d+(?:\.\d+)?px$/.test(height)) {
          return { height: Number.parseFloat(height) || 0 };
        }
        // jsdom has no container-query layout. Model only the spacer's
        // known formula, including its resize before observer delivery.
        const expression = height.match(
          /^max\(0px, calc\(100cqh ([+-]) (-?[\d.]+)px\)\)$/,
        );
        if (!expression) {
          throw new Error(`Unexpected seek spacer height: ${height}`);
        }
        const offset = Number(expression[2]) * (expression[1] === "-" ? -1 : 1);
        return { height: Math.max(0, viewport.clientHeight + offset) };
      },
    });
    return spacer;
  }

  const measureSeekSpacer = () =>
    screen.getByTestId("seek-spacer").getBoundingClientRect().height;

  /**
   * Renders a one-turn transcript, mocks the viewport geometry (300px
   * viewport, 900px content, reader parked at the live edge), and returns
   * the pieces the seek scenarios drive.
   */
  function mountSeekHarness(seekRequest?: {
    current: TranscriptSeekRequest | null;
  }) {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    const ref = createRef<TranscriptHandle>();
    const view = render(
      <Transcript
        ref={ref}
        store={fake as unknown as ThreadClientStore}
        {...(seekRequest ? { seekRequest } : {})}
      />,
    );
    act(flushRaf);
    const viewport = screen.getByRole("region", { name: "Messages" });
    const spacer = mockSeekSpacer(viewport);
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: {
        configurable: true,
        get: () => 900 + spacer.getBoundingClientRect().height,
      },
    });
    viewport.scrollTop = 600;
    const nativeScroll = mockNativeScroll(viewport);
    return {
      fake,
      ref,
      viewport,
      ...nativeScroll,
      rerender: view.rerender,
      unmount: view.unmount,
    };
  }

  it("coalesces animated viewport height changes and preserves the live edge", () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly #callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
        }

        observe(target: Element): void {
          resizeCallbacks.set(target, this.#callback);
        }

        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const { viewport } = mountSeekHarness();
    const resizeViewport = () =>
      resizeCallbacks.get(viewport)?.([], {} as ResizeObserver);

    // Establish the post-layout baseline first, as the real observer does.
    act(resizeViewport);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(600);

    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 280,
    });
    act(resizeViewport);
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 240,
    });
    act(resizeViewport);

    expect(rafCallbacks.size).toBe(1);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(660);
    expect(rafCallbacks.size).toBe(0);

    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 24,
    });
    act(resizeViewport);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(876);
    expect(rafCallbacks.size).toBe(0);
  });

  it.each(["wheel", "touch"] as const)(
    "lets %s intent take ownership during an animated viewport resize",
    (intent) => {
      const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          readonly #callback: ResizeObserverCallback;
          constructor(callback: ResizeObserverCallback) {
            this.#callback = callback;
          }
          observe(target: Element): void {
            resizeCallbacks.set(target, this.#callback);
          }
          disconnect(): void {}
          unobserve(): void {}
        },
      );
      const { viewport } = mountSeekHarness();
      const resizeViewport = () =>
        resizeCallbacks.get(viewport)?.([], {} as ResizeObserver);

      Object.defineProperty(viewport, "clientHeight", {
        configurable: true,
        value: 280,
      });
      act(resizeViewport);
      if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
      else fireEvent.touchMove(viewport);
      Object.defineProperty(viewport, "clientHeight", {
        configurable: true,
        value: 240,
      });
      act(resizeViewport);
      act(flushRaf);

      expect(viewport.scrollTop).toBe(600);
      expect(
        screen.getByRole("button", { name: "Jump to latest" }),
      ).toBeInTheDocument();
    },
  );

  it("uses fresh history entries when a retained ResizeObserver synchronizes the rail", () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly #callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
        }
        observe(target: Element): void {
          resizeCallbacks.set(target, this.#callback);
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const first = userMessageSnapshot(["turn-1"]);
    const second = userMessageSnapshot(["turn-1", "turn-2"]);
    const fake = new FakeTranscriptStore(first);
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0 }),
      },
    });
    act(() => resizeCallbacks.get(viewport)?.([], {} as ResizeObserver));
    act(flushRaf);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    act(() => fake.replaceSnapshot(second));
    const messages = viewport.querySelectorAll<HTMLElement>(
      '[data-item-kind="user_message"]',
    );
    Object.defineProperty(messages[0], "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: -100 }),
    });
    Object.defineProperty(messages[1], "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100 }),
    });

    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 280,
    });
    act(() => resizeCallbacks.get(viewport)?.([], {} as ResizeObserver));
    act(flushRaf);

    expect(
      screen.getByRole("button", { name: "Jump to conversation message 2" }),
    ).toHaveAttribute("aria-current", "location");
  });

  it("reconciles a content-width change that overlaps a viewport resize frame", () => {
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly #callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
        }
        observe(target: Element): void {
          resizeCallbacks.set(target, this.#callback);
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const { viewport, scrollTo } = mountSeekHarness();
    const contentElement =
      viewport.querySelector<HTMLElement>(".message-content")!;
    let contentWidth = 400;
    Object.defineProperty(contentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: contentWidth }),
    });
    const resizeViewport = () =>
      resizeCallbacks.get(viewport)?.([], {} as ResizeObserver);
    const resizeContent = (width: number) =>
      resizeCallbacks.get(contentElement)?.(
        [{ contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    act(() => resizeContent(400));
    scrollTo.mockClear();

    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 260,
    });
    act(resizeViewport);
    contentWidth = 500;
    act(() => resizeContent(500));
    expect(scrollTo).not.toHaveBeenCalled();
    act(flushRaf);
    scrollTo.mockClear();

    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    act(() => resizeContent(500));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(1);
  });

  it("snaps to the live edge when the chat view is revealed again", () => {
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    const { rerender } = render(
      <ChatViewVisibilityContext.Provider value={false}>
        <Transcript store={fake as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );
    act(flushRaf);
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    viewport.scrollTop = 100;
    const scrollTo = vi.fn();
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    rerender(
      <ChatViewVisibilityContext.Provider value={true}>
        <Transcript store={fake as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
  });

  it("preserves explicit-auto End navigation", () => {
    const { viewport, scrollTo } = mountSeekHarness();
    viewport.scrollTop = 100;

    fireEvent.keyDown(viewport, { key: "End" });

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
  });

  /** turn-1 (assistant) plus a freshly appended user turn. */
  function withSentMessage(): NormalizedThreadSnapshot {
    const snapshot = makeSnapshot(["turn-1", "turn-2"], false);
    return {
      ...snapshot,
      itemsById: {
        ...snapshot.itemsById,
        "turn-2-message": {
          id: "turn-2-message",
          turnId: "turn-2",
          kind: "user_message",
          status: "completed",
          revision: 1,
          deliveryOperationId: sentOperationId,
          content: [{ kind: "text", text: { text: "Sent prompt" } }],
        },
      },
    };
  }

  /** The user turn again, now with a streaming assistant reply behind it. */
  function withStreamingReply(): NormalizedThreadSnapshot {
    const snapshot = withSentMessage();
    return {
      ...snapshot,
      turnsById: {
        ...snapshot.turnsById,
        "turn-2": {
          ...snapshot.turnsById["turn-2"]!,
          orderedItemIds: ["turn-2-message", "turn-2-reply"],
        },
      },
      itemsById: {
        ...snapshot.itemsById,
        "turn-2-reply": {
          id: "turn-2-reply",
          turnId: "turn-2",
          kind: "assistant_message",
          status: "streaming",
          revision: 1,
          markdown: { text: "Streaming reply" },
        },
      },
    };
  }

  it("pins the exact optimistic row immediately and keeps the operation target across replacement", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, viewport, finishSeek } = mountSeekHarness(seekRequest);
    const initial = fake.getSnapshot().snapshot!;
    act(() =>
      fake.replaceTransfers([
        makePendingSubmitTransfer(initial, {
          operationId: sentOperationId,
          baselineTailItemId: "turn-1-message",
        }),
      ]),
    );
    const optimistic = document.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${sentOperationId}"]`,
    );
    Object.defineProperty(optimistic!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(finishSeek);

    expect(seekRequest.current).toBeNull();
    expect(viewport.scrollTop).toBe(924);
    expect(optimistic).toHaveAttribute("data-client-provisional", "true");

    act(() => fake.replacePresentation(withSentMessage(), []));
    const authoritative = document.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${sentOperationId}"]`,
    );
    expect(authoritative).toHaveAttribute("data-item-id", "turn-2-message");
    expect(authoritative).not.toHaveAttribute("data-client-provisional");
    expect(measureSeekSpacer()).toBe(324);
  });

  it("does not synchronously measure height for same-order streaming revisions", () => {
    smoothStreamingEnabled = false;
    const { fake, viewport } = mountSeekHarness();
    act(() => fake.replaceSnapshot(withStreamingReply()));

    const heightReads = vi.fn(() => 900);
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: heightReads,
    });
    const revised = withStreamingReply();
    const reply = revised.itemsById["turn-2-reply"];
    if (!reply || reply.kind !== "assistant_message") {
      throw new Error("streaming reply fixture missing");
    }
    revised.itemsById["turn-2-reply"] = {
      ...reply,
      revision: 2,
      markdown: { text: "Streaming reply revision 2" },
    };

    act(() => fake.replaceSnapshot(revised));

    expect(screen.getByText("Streaming reply revision 2")).toBeInTheDocument();
    expect(heightReads).not.toHaveBeenCalled();
  });

  it("still consumes a pending seek on a same-order revision", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: null,
    };
    const { fake } = mountSeekHarness(seekRequest);
    act(() => fake.replaceSnapshot(withSentMessage()));
    seekRequest.current = {
      requestedAt: Date.now(),
      operationId: sentOperationId,
    };
    const revised = withSentMessage();
    revised.itemsById["turn-2-message"] = {
      ...revised.itemsById["turn-2-message"]!,
      revision: 2,
    };

    act(() => fake.replaceSnapshot(revised));

    expect(seekRequest.current).toBeNull();
  });

  it("pins the sent message with native smooth scroll and suppresses the FAB while pinned", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, viewport, scrollTo, finishSeek } = mountSeekHarness(seekRequest);

    act(() => fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    expect(sent).not.toBeNull();
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(flushRaf);

    // Reserve the reply space before asking the browser to animate to the
    // item top (940) minus the 16px breathing offset.
    expect(scrollTo).toHaveBeenCalledWith({ top: 924, behavior: "smooth" });
    expect(viewport.scrollTop).toBe(600);
    act(finishSeek);
    expect(viewport.scrollTop).toBe(924);
    scrollTo.mockClear();
    // Reservation: 924 + 300 viewport − 900 content = 324px of blank space.
    expect(measureSeekSpacer()).toBe(324);
    expect(seekRequest.current).toBeNull();
    // The pin marks the reader as away from the live edge, but the FAB is
    // suppressed while the pin holds — it must not pop in at send time.
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // The browser's scrollHeight includes the seek spacer. Model that before
    // scroll/resize reconciliation can ask the pin to recompute its reserve.
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () =>
        900 + measureSeekSpacer(),
    });

    // Scroll events at the padded bottom neither re-engage the live edge
    // nor reveal the FAB while the reservation is holding space.
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // A streaming reply appends without yanking the reader to the bottom.
    act(() => fake.replaceSnapshot(withStreamingReply()));
    act(flushRaf);
    expect(scrollTo).not.toHaveBeenCalled();

    // Scroll intent hands control to the reader and reveals the FAB, but it
    // does not destroy the reservation at gesture start.
    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    // Jump to latest explicitly dissolves the reservation and rejoins the
    // live edge. Behavior is measured only after the spacer is released:
    // the padded destination is far, while the natural destination is
    // exactly two viewports away and therefore smooth.
    viewport.scrollTop = 0;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () =>
        measureSeekSpacer() === 0 ? 900 : 1_224,
    });
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(measureSeekSpacer()).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "smooth" });
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("does not consume an unchanged historical user item before append", () => {
    const initial = makeSnapshot(["turn-1"], false);
    initial.itemsById["turn-1-message"] = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "Historical" } }],
    };
    const fake = new FakeTranscriptStore(initial);
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: {
        requestedAt: Date.now(),
        operationId: sentOperationId,
      },
    };
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        seekRequest={seekRequest}
      />,
    );
    act(flushRaf);
    expect(seekRequest.current).not.toBeNull();
    act(() => fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(flushRaf);
    expect(seekRequest.current).toBeNull();
  });

  /** Mounts a pinned seek with a capturable ResizeObserver callback. */
  function mountOutgrownPin() {
    let resizeCallback: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallback = callback;
        }
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const harness = mountSeekHarness(seekRequest);

    act(() => harness.fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(harness.finishSeek);
    harness.scrollTo.mockClear();
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    const outgrow = (scrollHeight = 1650) => {
      Object.defineProperty(harness.viewport, "scrollHeight", {
        configurable: true,
        value: scrollHeight,
      });
      act(() => resizeCallback?.());
    };
    return { ...harness, outgrow };
  }

  it("stream growth consumes blank space and rejoins the live edge", () => {
    const { viewport, scrollTo, outgrow } = mountOutgrownPin();
    outgrow();
    expect(rafCallbacks.size).toBe(1);
    act(flushRaf);
    expect(measureSeekSpacer()).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(1_350);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    // Later growth continues through the ordinary smoothed follower.
    outgrow(1700);
    expect(rafCallbacks.size).toBe(1);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(1_400);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("releases only when reader scrolling crosses the natural message bottom", () => {
    const { viewport, scrollTo, outgrow } = mountOutgrownPin();
    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    outgrow();
    expect(measureSeekSpacer()).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    // Content growth alone does not release. The natural content bottom is
    // at 1650 - 300 = 1350 in the stubbed post-growth geometry.
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    viewport.scrollTop = 1200;
    fireEvent.scroll(viewport);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    viewport.scrollTop = 1350;
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("cancels the seek animation the instant the reader wheels", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, viewport, scrollTo, advanceNativeScroll, finishNativeScroll } =
      mountSeekHarness(seekRequest);

    act(() => fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(flushRaf);
    act(() => advanceNativeScroll(0.5));
    const midFlight = viewport.scrollTop;
    expect(midFlight).toBeGreaterThan(600);
    expect(midFlight).toBeLessThan(924);

    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: midFlight,
      behavior: "instant",
    });
    act(finishNativeScroll);
    fireEvent(viewport, new Event("scrollend"));
    expect(viewport.scrollTop).toBe(midFlight);
    // Wheel counts as the reader scrolling away — the FAB appears.
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  function mountSeekWithHistoryMarkers() {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: null,
    };
    const harness = mountSeekHarness(seekRequest);
    const { fake, viewport } = harness;
    const initial = makeSnapshot(["turn-1"], false);
    const previousUserMessage: ConversationItem = {
      id: "turn-1-message",
      turnId: "turn-1",
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: "Earlier prompt" } }],
    };
    initial.itemsById["turn-1-message"] = previousUserMessage;
    act(() => fake.replaceSnapshot(initial));
    act(flushRaf);
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 40 }),
    });
    const measureUserRow = (itemId: string, top: number) => {
      const row = document.querySelector<HTMLElement>(
        `[data-item-id="${itemId}"]`,
      )!;
      const measure = vi.fn(() => ({ top: 40 + top - viewport.scrollTop }));
      Object.defineProperties(row, {
        offsetTop: { configurable: true, value: top },
        getBoundingClientRect: { configurable: true, value: measure },
      });
      return measure;
    };
    const previousRowMeasure = measureUserRow("turn-1-message", 600);
    fireEvent.scroll(viewport);
    act(flushRaf);
    expect(
      screen.getByRole("button", { name: "Jump to conversation message 1" }),
    ).toHaveAttribute("aria-current", "location");

    seekRequest.current = {
      requestedAt: Date.now(),
      operationId: sentOperationId,
    };
    const next = withSentMessage();
    next.itemsById["turn-1-message"] = previousUserMessage;
    act(() => fake.replaceSnapshot(next));
    const sentRowMeasure = measureUserRow("turn-2-message", 940);
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () =>
        900 +
        (measureSeekSpacer() || 0),
    });
    previousRowMeasure.mockClear();
    sentRowMeasure.mockClear();
    return { ...harness, previousRowMeasure, sentRowMeasure };
  }

  it("defers history row measurements during seek and reconciles the marker on arrival", () => {
    const { viewport, previousRowMeasure, sentRowMeasure, advanceNativeScroll } =
      mountSeekWithHistoryMarkers();

    act(flushRaf);
    act(() => advanceNativeScroll(0.25));
    act(() => advanceNativeScroll(0.5));
    expect(viewport.scrollTop).toBeGreaterThan(600);
    expect(viewport.scrollTop).toBeLessThan(924);
    expect(previousRowMeasure).not.toHaveBeenCalled();
    expect(sentRowMeasure).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Jump to conversation message 1" }),
    ).toHaveAttribute("aria-current", "location");

    // Even the final position's scroll event remains cheap; scrollend
    // reconciles the history marker once the browser finishes its motion.
    act(() => advanceNativeScroll(1));
    expect(previousRowMeasure).not.toHaveBeenCalled();
    expect(sentRowMeasure).not.toHaveBeenCalled();
    fireEvent(viewport, new Event("scrollend"));
    expect(viewport.scrollTop).toBe(924);
    expect(previousRowMeasure).toHaveBeenCalled();
    expect(sentRowMeasure).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Jump to conversation message 2" }),
    ).toHaveAttribute("aria-current", "location");
  });

  it.each(["wheel", "touch", "history scrub"] as const)(
    "reconciles the history marker when %s interrupts seek and resumes ordinary scroll tracking",
    (intent) => {
      const {
        ref,
        viewport,
        previousRowMeasure,
        sentRowMeasure,
        advanceNativeScroll,
        finishNativeScroll,
      } =
        mountSeekWithHistoryMarkers();
      act(flushRaf);
      act(() => advanceNativeScroll(0.5));
      const interruptedTop = viewport.scrollTop;
      expect(previousRowMeasure).not.toHaveBeenCalled();
      expect(sentRowMeasure).not.toHaveBeenCalled();

      if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
      else if (intent === "touch") fireEvent.touchMove(viewport);
      else {
        let activeItemId: string | undefined;
        act(() => {
          activeItemId = ref.current!.beginHistoryScrub();
        });
        expect(activeItemId).toBe("turn-2-message");
      }
      expect(
        screen.getByRole("button", { name: "Jump to conversation message 2" }),
      ).toHaveAttribute("aria-current", "location");
      act(finishNativeScroll);
      fireEvent(viewport, new Event("scrollend"));
      expect(viewport.scrollTop).toBe(interruptedTop);

      viewport.scrollTop = 500;
      fireEvent.scroll(viewport);
      expect(
        screen.getByRole("button", { name: "Jump to conversation message 1" }),
      ).toHaveAttribute("aria-current", "location");
    },
  );

  it.each(["wheel", "history scrub"] as const)(
    "lets %s take control before the scheduled seek begins",
    (intent) => {
      const { ref, viewport } = mountSeekWithHistoryMarkers();
      viewport.scrollTop = 500;
      const readerPosition = viewport.scrollTop;
      const reservedSpace = screen.getByTestId("seek-spacer").style.height;

      if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
      else {
        let activeItemId: string | undefined;
        act(() => {
          activeItemId = ref.current!.beginHistoryScrub();
        });
        expect(activeItemId).toBe("turn-1-message");
      }
      act(flushRaf);

      expect(viewport.scrollTop).toBe(readerPosition);
      expect(screen.getByTestId("seek-spacer").style.height).toBe(reservedSpace);
      expect(
        screen.getByRole("button", { name: "Jump to conversation message 1" }),
      ).toHaveAttribute("aria-current", "location");
    },
  );

  it("jumps instantly under prefers-reduced-motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, viewport, scrollTo } = mountSeekHarness(seekRequest);

    act(() => fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    // One frame (the pin engage) is enough: no animation frames follow.
    act(() => stepRaf());
    expect(scrollTo).toHaveBeenCalledWith({ top: 924, behavior: "instant" });
    expect(viewport.scrollTop).toBe(924);
    expect(rafCallbacks.size).toBe(0);
  });

  function mountNativeSourceFocus(sourceOffset = 224) {
    const harness = mountSeekHarness();
    const { fake, viewport, ref, rerender, scrollTo } = harness;
    act(() => fake.replaceSnapshot(withSentMessage()));
    act(flushRaf);
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 40 }),
    });
    const source = document.querySelector<HTMLElement>('[data-turn-id="turn-1"]')!;
    const other = document.querySelector<HTMLElement>('[data-turn-id="turn-2"]')!;
    Object.defineProperty(source, "offsetTop", {
      configurable: true,
      value: sourceOffset,
    });
    Object.defineProperties(other, {
      offsetTop: { configurable: true, value: 424 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 40 + 424 - viewport.scrollTop }),
      },
    });
    const row = document.querySelector<HTMLElement>('[data-item-id="turn-2-message"]')!;
    const measureRow = vi.fn(() => ({ top: 40 + 424 - viewport.scrollTop }));
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: measureRow,
    });
    fireEvent.scroll(viewport);
    act(flushRaf);
    scrollTo.mockClear();
    const focusSource = (turnId: string) => {
      rerender(
        <Transcript
          ref={ref}
          store={fake as unknown as ThreadClientStore}
          focusTurnId={turnId}
        />,
      );
      act(flushRaf);
    };
    return { ...harness, source, other, measureRow, focusSource };
  }

  it("settles a clamped source target immediately without waiting for scrollend", () => {
    const { source, scrollTo, viewport, measureRow, focusSource } =
      mountNativeSourceFocus(2_024);
    focusSource("turn-1");

    // The requested 2000px target clamps to the current 600px maximum.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(source).toHaveFocus();
    viewport.scrollTop = 300;
    measureRow.mockClear();
    fireEvent.scroll(viewport);
    expect(measureRow).toHaveBeenCalled();
  });

  it("recovers source focus and history tracking when scrollend is missing", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { source, viewport, measureRow, focusSource, advanceNativeScroll } =
      mountNativeSourceFocus();
    const focus = vi.spyOn(source, "focus");
    const idleTimerCount = vi.getTimerCount();
    focusSource("turn-1");
    act(() => advanceNativeScroll(0.5));
    measureRow.mockClear();

    // A slow animation must remain native and retain ownership until arrival.
    act(() => vi.advanceTimersByTime(1_000));
    expect(focus).not.toHaveBeenCalled();
    expect(measureRow).not.toHaveBeenCalled();
    act(() => advanceNativeScroll(1));
    act(() => vi.advanceTimersByTime(1_000));
    expect(source).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(measureRow).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(idleTimerCount);

    // A late native event cannot repeat completion, and ordinary scroll
    // tracking resumes after the guard releases ownership.
    fireEvent(viewport, new Event("scrollend"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(focus).toHaveBeenCalledOnce();
    measureRow.mockClear();
    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    expect(measureRow).toHaveBeenCalled();
  });

  it("clears the completion guard when native scrollend arrives", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { source, focusSource, finishNativeScroll } = mountNativeSourceFocus();
    const focus = vi.spyOn(source, "focus");
    const idleTimerCount = vi.getTimerCount();
    focusSource("turn-1");
    act(finishNativeScroll);
    expect(focus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(idleTimerCount);
    act(() => vi.advanceTimersByTime(2_000));
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(["reader interruption", "unmount"] as const)(
    "clears the completion guard on %s without late source focus",
    (reason) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { source, viewport, focusSource, advanceNativeScroll, unmount } =
        mountNativeSourceFocus();
      const focus = vi.spyOn(source, "focus");
      const idleTimerCount = vi.getTimerCount();
      focusSource("turn-1");
      act(() => advanceNativeScroll(0.5));
      if (reason === "unmount") unmount();
      else fireEvent.wheel(viewport, { deltaY: -1 });
      expect(vi.getTimerCount()).toBe(reason === "unmount" ? 0 : idleTimerCount);
      viewport.scrollTop = 200;
      act(() => vi.advanceTimersByTime(2_000));
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("replaces the completion guard without focusing the previous source", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { source, other, focusSource, advanceNativeScroll } =
      mountNativeSourceFocus();
    const focusFirst = vi.spyOn(source, "focus");
    const focusSecond = vi.spyOn(other, "focus");
    const idleTimerCount = vi.getTimerCount();
    focusSource("turn-1");
    act(() => vi.advanceTimersByTime(500));
    focusSource("turn-2");
    expect(vi.getTimerCount()).toBe(idleTimerCount + 1);
    act(() => advanceNativeScroll(1));
    act(() => vi.advanceTimersByTime(500));
    expect(focusSecond).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(focusFirst).not.toHaveBeenCalled();
    expect(focusSecond).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(idleTimerCount);
  });

  it("ignores a replaced source scrollend and focuses only the current destination", () => {
    const {
      source,
      other,
      scrollTo,
      viewport,
      focusSource,
      advanceNativeScroll,
      finishNativeScroll,
    } = mountNativeSourceFocus();
    const focusFirst = vi.spyOn(source, "focus");
    const focusSecond = vi.spyOn(other, "focus");
    focusSource("turn-1");
    act(() => advanceNativeScroll(0.25));
    const replacementPosition = viewport.scrollTop;
    focusSource("turn-2");
    expect(scrollTo).toHaveBeenCalledWith({
      top: replacementPosition,
      behavior: "instant",
    });

    // A completion queued for the previous destination cannot finish the
    // replacement motion or focus its source row.
    viewport.scrollTop = 200;
    fireEvent(viewport, new Event("scrollend"));
    expect(focusFirst).not.toHaveBeenCalled();
    expect(focusSecond).not.toHaveBeenCalled();
    act(finishNativeScroll);
    expect(viewport.scrollTop).toBe(400);
    expect(focusFirst).not.toHaveBeenCalled();
    expect(focusSecond).toHaveBeenCalledOnce();
  });

  it("accepts the current scroll limit after content shrinks during source seeking", () => {
    const { source, viewport, focusSource } = mountNativeSourceFocus();
    const focus = vi.spyOn(source, "focus");
    focusSource("turn-1");
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 400,
    });
    viewport.scrollTop = 100;

    fireEvent(source, new Event("scrollend", { bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    fireEvent(viewport, new Event("scrollend"));
    expect(focus).toHaveBeenCalledOnce();
  });

  it("cancels source seeking when another navigation takes over without a seek pin", () => {
    const {
      ref,
      source,
      other,
      scrollTo,
      viewport,
      measureRow,
      focusSource,
      advanceNativeScroll,
      finishNativeScroll,
    } = mountNativeSourceFocus();
    const focusOriginal = vi.spyOn(source, "focus");
    focusSource("turn-1");
    act(() => advanceNativeScroll(0.25));
    const interruptedTop = viewport.scrollTop;

    act(() => expect(ref.current!.seekTurn("turn-2")).toBe(true));
    expect(scrollTo).toHaveBeenCalledWith({
      top: interruptedTop,
      behavior: "instant",
    });
    act(finishNativeScroll);
    expect(focusOriginal).not.toHaveBeenCalled();
    expect(other).toHaveFocus();
    measureRow.mockClear();
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(measureRow).toHaveBeenCalled();
  });

  it("stops native source seeking on unmount without a late focus callback", () => {
    const {
      source,
      viewport,
      scrollTo,
      unmount,
      focusSource,
      advanceNativeScroll,
      finishNativeScroll,
    } = mountNativeSourceFocus();
    const focus = vi.spyOn(source, "focus");
    focusSource("turn-1");
    act(() => advanceNativeScroll(0.25));
    const interruptedTop = viewport.scrollTop;
    unmount();

    expect(scrollTo).toHaveBeenLastCalledWith({
      top: interruptedTop,
      behavior: "instant",
    });
    act(finishNativeScroll);
    fireEvent(viewport, new Event("scrollend"));
    expect(focus).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(interruptedTop);
  });

  it("pins the very first send of a brand-new thread", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const fake = new FakeTranscriptStore(makeSnapshot([], false));
    render(
      <Transcript
        store={fake as unknown as ThreadClientStore}
        seekRequest={seekRequest}
      />,
    );
    expect(screen.getByText("This thread is ready")).toBeInTheDocument();

    // The viewport's initial effect sees its real height when this first
    // message creates it; there is no intervening keyboard resize here.
    const measuredHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(300);
    const first = makeSnapshot(["turn-1"], false);
    act(() =>
      fake.replaceSnapshot({
        ...first,
        itemsById: {
          "turn-1-message": {
            id: "turn-1-message",
            turnId: "turn-1",
            kind: "user_message",
            status: "completed",
            revision: 1,
            deliveryOperationId: sentOperationId,
            content: [{ kind: "text", text: { text: "First prompt" } }],
          },
        },
      }),
    );

    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 360 },
    });
    measuredHeight.mockRestore();
    mockSeekSpacer(viewport);
    const { scrollTo, finishSeek } = mockNativeScroll(viewport);
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-1-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 28,
    });
    act(finishSeek);

    expect(seekRequest.current).toBeNull();
    // Native smooth scroll to the item top (28) minus the 16px offset.
    expect(scrollTo).toHaveBeenCalledWith({ top: 12, behavior: "smooth" });
    expect(viewport.scrollTop).toBe(12);
    // 12 + 300 viewport ≤ 360 content: geometry already provides the blank
    // space, so no reservation is added…
    expect(measureSeekSpacer()).toBe(0);
    // …but the pin still suppresses follow: the content bottom sits within
    // the 96px live-edge threshold, and without the pin the seek scroll's
    // own scroll events would re-engage follow immediately. The FAB stays
    // suppressed while the pin holds…
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    // …until the reader starts scrolling; its zero spacer is still retained
    // logically until that scroll reaches the natural bottom.
    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  /** The streaming reply from withStreamingReply(), settled. */
  function withSettledReply(): NormalizedThreadSnapshot {
    const snapshot = withStreamingReply();
    return {
      ...snapshot,
      itemsById: {
        ...snapshot.itemsById,
        "turn-2-reply": {
          id: "turn-2-reply",
          turnId: "turn-2",
          kind: "assistant_message",
          status: "completed",
          revision: 2,
          markdown: { text: "Streaming reply" },
        },
      },
    };
  }

  function withNextUserMessage(): NormalizedThreadSnapshot {
    const snapshot = withSettledReply();
    return {
      ...snapshot,
      orderedTurnIds: [...snapshot.orderedTurnIds, "turn-3"],
      turnsById: {
        ...snapshot.turnsById,
        "turn-3": {
          id: "turn-3",
          revision: 1,
          status: "in_progress",
          orderedItemIds: ["turn-3-message"],
        },
      },
      itemsById: {
        ...snapshot.itemsById,
        "turn-3-message": {
          id: "turn-3-message",
          turnId: "turn-3",
          kind: "user_message",
          status: "completed",
          revision: 1,
          deliveryOperationId: nextOperationId,
          content: [{ kind: "text", text: { text: "Next prompt" } }],
        },
      },
      forksByTurnId: {
        ...snapshot.forksByTurnId,
        "turn-3": {
          sourceTurnId: "turn-3",
          expectedTurnRevision: 1,
          available: false,
          unavailableReason: {
            text: "Forking is unavailable in this fixture.",
          },
        },
      },
    };
  }

  /**
   * Captures the content ResizeObserver callback (the seek spacer sync
   * driver) so a test can grow the content. Must run before mounting.
   */
  function captureResize() {
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    return (width?: number): void =>
      resizeCallback?.(
        width === undefined
          ? []
          : ([{ contentRect: { width } }] as ResizeObserverEntry[]),
        {} as ResizeObserver,
      );
  }

  it("preserves the seek range when viewport growth resizes reserved space before observer delivery", () => {
    const resize = captureResize();
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, viewport, advanceNativeScroll, finishNativeScroll } =
      mountSeekHarness(seekRequest);
    act(() => fake.replaceSnapshot(withSentMessage()));
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    )!;
    Object.defineProperty(sent, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(flushRaf);
    act(() => advanceNativeScroll(0.5));
    const midSeek = viewport.scrollTop;
    expect(measureSeekSpacer()).toBe(324);

    // CSS grows the reservation with the viewport, while the JavaScript
    // observer has not run yet. The browser's scroll limit stays stable.
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 450,
    });
    expect(measureSeekSpacer()).toBe(474);
    expect(viewport.scrollHeight - viewport.clientHeight).toBe(924);
    expect(viewport.scrollTop).toBe(midSeek);

    // Reconciliation must subtract the actual 474px reservation, not the
    // previous 324px, when determining how much message content exists.
    act(resize);
    expect(measureSeekSpacer()).toBe(474);
    expect(viewport.scrollHeight - viewport.clientHeight).toBe(924);
    act(finishNativeScroll);
    expect(viewport.scrollTop).toBe(924);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  function mountLiveEdgeFollower() {
    const resize = captureResize();
    const harness = mountSeekHarness();
    const setScrollHeight = (value: number) =>
      Object.defineProperty(harness.viewport, "scrollHeight", {
        configurable: true,
        value,
      });
    return { ...harness, resize, setScrollHeight };
  }

  it("eases content growth toward a moving live-edge target", () => {
    const { viewport, resize, setScrollHeight } = mountLiveEdgeFollower();

    setScrollHeight(1_000);
    act(resize);
    expect(rafCallbacks.size).toBe(1);
    act(() => {
      stepRaf();
      stepRaf();
    });
    expect(viewport.scrollTop).toBeGreaterThan(600);
    expect(viewport.scrollTop).toBeLessThan(700);
    expect(viewport.scrollTop).toBeCloseTo(
      600 + 100 * (1 - Math.exp(-64 / 120)),
      5,
    );

    // Intermediate programmatic scroll events retain logical ownership.
    fireEvent.scroll(viewport);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // The destination is read on every frame rather than captured at resize.
    setScrollHeight(1_100);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(800);
    expect(rafCallbacks.size).toBe(0);
  });

  it("snaps width reflow while preserving smooth same-width content growth", () => {
    const { viewport, scrollTo, resize, setScrollHeight } =
      mountLiveEdgeFollower();

    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });
    expect(rafCallbacks.size).toBe(1);

    setScrollHeight(1_100);
    act(() => resize(420));
    expect(rafCallbacks.size).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_100,
      behavior: "auto",
    });

    scrollTo.mockClear();
    setScrollHeight(1_200);
    act(() => resize(420));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(1);
  });

  it("follows content shrink upward with the same bounded loop", () => {
    const { viewport, resize, setScrollHeight } = mountLiveEdgeFollower();

    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });
    const growingPosition = viewport.scrollTop;
    expect(growingPosition).toBeGreaterThan(600);

    setScrollHeight(850);
    act(() => stepRaf());
    expect(viewport.scrollTop).toBeLessThan(growingPosition);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(550);
  });

  it.each(["wheel", "touch", "pointer", "keyboard"] as const)(
    "yields an active live-edge follower to %s intent",
    (intent) => {
      const { viewport, resize, setScrollHeight } = mountLiveEdgeFollower();
      setScrollHeight(1_000);
      act(resize);
      act(() => {
        stepRaf();
        stepRaf();
      });
      const readerPosition = viewport.scrollTop;

      if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
      else if (intent === "touch") fireEvent.touchMove(viewport);
      else if (intent === "pointer") fireEvent.pointerDown(viewport);
      else fireEvent.keyDown(viewport, { key: "ArrowUp" });

      expect(rafCallbacks.size).toBe(0);
      act(flushRaf);
      expect(viewport.scrollTop).toBe(readerPosition);
      expect(
        screen.getByRole("button", { name: "Jump to latest" }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["horizontal trackpad pan", { deltaX: 24, deltaY: 0 }],
    ["pinch zoom", { ctrlKey: true, deltaY: -24 }],
  ])("keeps live-edge ownership through a %s", (_label, wheel) => {
    const { viewport, resize, setScrollHeight } = mountLiveEdgeFollower();
    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });

    fireEvent.wheel(viewport, wheel);

    expect(rafCallbacks.size).toBe(1);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    act(flushRaf);
    expect(viewport.scrollTop).toBe(700);
  });

  it("yields to an active selection drag without treating content pointerdown alone as scroll intent", () => {
    const { viewport, resize, setScrollHeight } = mountLiveEdgeFollower();
    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });
    const readerPosition = viewport.scrollTop;
    const message = document.querySelector<HTMLElement>("[data-item-id]")!;

    fireEvent.pointerDown(message);
    expect(rafCallbacks.size).toBe(1);

    const selection = vi
      .spyOn(document, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent(document, new Event("selectionchange"));
    expect(rafCallbacks.size).toBe(0);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(readerPosition);
    fireEvent(window, new Event("pointerup"));
    selection.mockRestore();
  });

  it("keeps resize following immediate when smooth streaming is disabled", () => {
    smoothStreamingEnabled = false;
    const { viewport, scrollTo, resize, setScrollHeight } =
      mountLiveEdgeFollower();

    setScrollHeight(1_000);
    act(resize);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" });
    expect(rafCallbacks.size).toBe(0);
    expect(viewport.scrollTop).toBe(700);
  });

  it("finishes an owned live-edge follow immediately when smoothing is disabled", () => {
    const { fake, viewport, scrollTo, rerender, resize, setScrollHeight } =
      mountLiveEdgeFollower();
    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });
    expect(viewport.scrollTop).toBeGreaterThan(600);
    expect(viewport.scrollTop).toBeLessThan(700);

    smoothStreamingEnabled = false;
    rerender(<Transcript store={fake as unknown as ThreadClientStore} />);

    expect(rafCallbacks.size).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_000,
      behavior: "auto",
    });
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("cancels live-edge following for explicit End navigation", () => {
    const { viewport, scrollTo, resize, setScrollHeight } =
      mountLiveEdgeFollower();
    setScrollHeight(1_000);
    act(resize);
    act(() => {
      stepRaf();
      stepRaf();
    });

    fireEvent.keyDown(viewport, { key: "End" });

    expect(rafCallbacks.size).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1_000,
      behavior: "auto",
    });
  });

  it("cancels live-edge following before loading older history", () => {
    const resize = captureResize();
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-2"], true));
    render(<Transcript store={fake as unknown as ThreadClientStore} />);
    act(flushRaf);
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    viewport.scrollTop = 600;
    act(resize);
    expect(rafCallbacks.size).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(600);
  });

  it("cancels live-edge following when chat hides, focus navigation starts, or the transcript unmounts", () => {
    const resize = captureResize();
    const fake = new FakeTranscriptStore(makeSnapshot(["turn-1"], false));
    const view = render(
      <ChatViewVisibilityContext.Provider value={true}>
        <Transcript store={fake as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );
    act(flushRaf);
    const viewport = screen.getByRole("region", { name: "Messages" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    viewport.scrollTop = 600;
    act(resize);
    expect(rafCallbacks.size).toBe(1);

    view.rerender(
      <ChatViewVisibilityContext.Provider value={false}>
        <Transcript store={fake as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );
    expect(rafCallbacks.size).toBe(0);

    view.rerender(
      <ChatViewVisibilityContext.Provider value={true}>
        <Transcript
          store={fake as unknown as ThreadClientStore}
          focusTurnId="missing-turn"
        />
      </ChatViewVisibilityContext.Provider>,
    );
    // Reveal performs its explicit auto snap. Move away and start another
    // follower before focus cancellation is committed.
    viewport.scrollTop = 600;
    act(resize);
    expect(rafCallbacks.size).toBe(0);

    view.rerender(
      <ChatViewVisibilityContext.Provider value={true}>
        <Transcript store={fake as unknown as ThreadClientStore} />
      </ChatViewVisibilityContext.Provider>,
    );
    viewport.scrollTop = 600;
    act(resize);
    expect(rafCallbacks.size).toBe(1);
    view.unmount();
    expect(rafCallbacks.size).toBe(0);
  });

  /**
   * Mounts a running-thread pin with consistent scroller geometry: viewport
   * 300, content 900, pin target at 940 → pinned scrollTop 924, spacer 324,
   * total scrollHeight 1224 (content + reservation).
   */
  function mountRunningPin() {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const harness = mountSeekHarness(seekRequest);
    act(() =>
      harness.fake.replaceSnapshot({
        ...withSentMessage(),
        runState: "running",
      }),
    );
    const sent = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );
    Object.defineProperty(sent!, "offsetTop", {
      configurable: true,
      value: 940,
    });
    act(harness.finishSeek);
    harness.scrollTo.mockClear();
    expect(harness.viewport.scrollTop).toBe(924);
    expect(measureSeekSpacer()).toBe(324);
    // Keep the stubbed geometry consistent: the scroller now contains the
    // 900px content plus the 324px reservation.
    const setScrollHeight = (value: number) =>
      Object.defineProperty(harness.viewport, "scrollHeight", {
        configurable: true,
        value,
      });
    setScrollHeight(1224);
    act(() =>
      harness.fake.replaceSnapshot({
        ...withStreamingReply(),
        runState: "running",
      }),
    );
    act(flushRaf);
    return { ...harness, seekRequest, setScrollHeight };
  }

  it("run settle keeps the reservation until scrolling reaches the natural bottom", () => {
    const { fake, viewport, scrollTo } = mountRunningPin();

    // An approval pause is not a settle — the pin holds untouched.
    act(() =>
      fake.replaceSnapshot({
        ...withStreamingReply(),
        runState: "waiting_for_approval",
      }),
    );
    expect(viewport.scrollTop).toBe(924);
    expect(measureSeekSpacer()).toBe(324);

    act(() =>
      fake.replaceSnapshot({ ...withStreamingReply(), runState: "running" }),
    );
    // The run settles with blank reservation still on screen: keep it.
    // No eased settle, no spacer dissolve, no FAB flash.
    act(() =>
      fake.replaceSnapshot({ ...withSettledReply(), runState: "idle" }),
    );
    act(flushRaf);
    expect(viewport.scrollTop).toBe(924);
    expect(measureSeekSpacer()).toBe(324);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // Manual scroll intent alone retains the space. It dissolves only when
    // the natural 900px content bottom reaches the 300px viewport edge.
    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    expect(measureSeekSpacer()).toBe(324);
    viewport.scrollTop = 600;
    fireEvent.scroll(viewport);
    expect(measureSeekSpacer()).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("hands an untouched pin to live-edge follow once the reply consumes its reservation", () => {
    const resize = captureResize();
    const { viewport, scrollTo } = mountRunningPin();
    const spacer = screen.getByTestId("seek-spacer");
    let naturalContentHeight = 900;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () =>
        naturalContentHeight + spacer.getBoundingClientRect().height,
    });

    // The reply grows until it exactly consumes the reservation (content
    // 1224 = pinned top 924 + viewport 300). The pin dissolves at that
    // boundary without moving the viewport because it is already live.
    naturalContentHeight = 1_224;
    act(resize);
    expect(spacer.getBoundingClientRect().height).toBe(0);
    expect(viewport.scrollTop).toBe(924);
    expect(rafCallbacks.size).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // Further streaming growth now uses the ordinary smoothed live-edge
    // follower instead of leaving the reader parked above new content.
    naturalContentHeight = 1_300;
    act(resize);
    expect(rafCallbacks.size).toBe(1);
    act(flushRaf);
    expect(viewport.scrollTop).toBe(1_000);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("manual scroll away retains the pin; later run settle is a no-op", () => {
    const { fake, viewport, scrollTo } = mountRunningPin();

    fireEvent.wheel(viewport, { deltaY: -1 });
    viewport.scrollTop = 800;
    fireEvent.scroll(viewport);
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    act(() =>
      fake.replaceSnapshot({ ...withSettledReply(), runState: "idle" }),
    );
    act(flushRaf);
    expect(viewport.scrollTop).toBe(800);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("replaces the retained reservation when the next send is seek-armed", () => {
    const { fake, seekRequest } = mountRunningPin();
    seekRequest.current = {
      requestedAt: Date.now(),
      operationId: nextOperationId,
    };

    act(() => fake.replaceSnapshot(withNextUserMessage()));
    const next = document.querySelector<HTMLElement>(
      '[data-item-id="turn-3-message"]',
    );
    Object.defineProperty(next!, "offsetTop", {
      configurable: true,
      value: 1100,
    });
    act(flushRaf);

    expect(seekRequest.current).toBeNull();
    expect(measureSeekSpacer()).toBe(160);
  });

  it("clears the retained pin and restores follow for a non-armed next send", () => {
    const { fake, scrollTo } = mountRunningPin();

    act(() => fake.replaceSnapshot(withNextUserMessage()));
    act(flushRaf);

    expect(measureSeekSpacer()).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1224, behavior: "auto" });
  });

  it("does not treat pointer interaction with message content as scrolling", () => {
    mountRunningPin();
    const message = document.querySelector<HTMLElement>(
      '[data-item-id="turn-2-message"]',
    );

    fireEvent.pointerDown(message!);

    expect(measureSeekSpacer()).toBe(324);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("records geometry and lifecycle events without message content", () => {
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { fake } = mountRunningPin();

    act(() =>
      fake.replaceSnapshot({ ...withSettledReply(), runState: "idle" }),
    );

    const trace = readDiagnostics();
    expect(trace.map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        "seek_pin_engaged",
        "spacer_height_changed",
        "snapshot_committed",
      ]),
    );
    expect(JSON.stringify(trace)).not.toContain("Streaming reply");
    expect(
      trace.find(({ event }) => event === "seek_pin_engaged")?.details,
    ).toMatchObject({
      clientHeight: 300,
      scrollHeight: 1224,
      spacerHeight: 324,
      pinActive: true,
    });
  });

  it("attributes completion follow requests to their programmatic source", () => {
    const resize = captureResize();
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { fake, scrollTo } = mountSeekHarness();
    clearDiagnostics();

    act(() =>
      fake.replaceSnapshot({ ...withSettledReply(), runState: "idle" }),
    );
    act(flushRaf);
    act(resize);

    expect(scrollTo).toHaveBeenCalled();
    const trace = readDiagnostics();
    const appliedFollowEntries = trace.filter(
      ({ event }) => event === "scroll_to_latest_applied",
    );
    expect(appliedFollowEntries.length).toBeGreaterThanOrEqual(1);
    expect(
      appliedFollowEntries.every(({ details }) => details.behavior === "auto"),
    ).toBe(true);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "scroll_to_latest_requested",
          details: expect.objectContaining({
            reason: "appended_live_edge_follow",
            wasAtLiveEdge: true,
          }),
        }),
        expect.objectContaining({
          event: "viewport_resize_observer",
          details: expect.objectContaining({ action: "follow_live_edge" }),
        }),
      ]),
    );
  });

  it("cancels a pending seek before unmount", () => {
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: { requestedAt: Date.now(), operationId: sentOperationId },
    };
    const { fake, unmount } = mountSeekHarness(seekRequest);

    act(() => fake.replaceSnapshot(withSentMessage()));
    expect(rafCallbacks.size).toBeGreaterThan(0);
    unmount();
    const entriesAtUnmount = readDiagnostics().length;
    act(flushRaf);

    expect(rafCallbacks.size).toBe(0);
    expect(readDiagnostics()).toHaveLength(entriesAtUnmount);
    expect(
      readDiagnostics().some(({ event }) => event === "seek_pin_engaged"),
    ).toBe(false);
  });

  it("keeps today's follow-to-bottom when the setting is off", () => {
    const { fake, scrollTo } = mountSeekHarness();

    act(() => fake.replaceSnapshot(withSentMessage()));
    act(flushRaf);

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
    expect(screen.getByTestId("seek-spacer").style.height).toBe("");
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("expires a stale seek request instead of seeking a later message", () => {
    const seekRequest: { current: TranscriptSeekRequest | null } = {
      current: {
        requestedAt: Date.now() - 60_000,
        operationId: sentOperationId,
      },
    };
    const { fake, scrollTo } = mountSeekHarness(seekRequest);

    act(() => fake.replaceSnapshot(withSentMessage()));
    act(flushRaf);

    expect(seekRequest.current).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
    expect(screen.getByTestId("seek-spacer").style.height).toBe("");
  });
});

function makeSnapshot(
  orderedTurnIds: string[],
  hasOlder: boolean,
): NormalizedThreadSnapshot {
  const turnsById = Object.fromEntries(
    orderedTurnIds.map((turnId) => [
      turnId,
      {
        id: turnId,
        revision: 1,
        status: "completed" as const,
        endedBy: "agent_settled" as const,
        completedAt: "2026-07-30T15:00:00.000Z",
        orderedItemIds: [`${turnId}-message`],
      },
    ]),
  );
  const itemsById = Object.fromEntries(
    orderedTurnIds.map((turnId) => [
      `${turnId}-message`,
      {
        id: `${turnId}-message`,
        turnId,
        kind: "assistant_message" as const,
        status: "completed" as const,
        revision: 1,
        markdown: { text: `Message for ${turnId}` },
      },
    ]),
  );
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
    forksByTurnId: Object.fromEntries(
      orderedTurnIds.map((turnId) => [
        turnId,
        {
          sourceTurnId: turnId,
          expectedTurnRevision: 1,
          available: false,
          unavailableReason: {
            text: "Forking is unavailable in this fixture.",
          },
        },
      ]),
    ),
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 1,
      threadRevision: 1,
      runState: "idle",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-07-30T15:00:00.000Z",
      stateChangedAt: "2026-07-30T15:00:00.000Z",
      automation: null,
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
      text: "",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
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
    orderedTurnIds,
    turnsById,
    itemsById,
    history: hasOlder
      ? { hasOlder: true, olderCursor: "older-page" }
      : { hasOlder: false },
    runState: "idle",
    queue: [],
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
      revision: "capability-1",
      backend: { label: { text: "Assistant" } },
      interactionMode: "read_only",
      runState: "idle",
      operations: [],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      history: { available: true, paginated: true },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun: true,
      },
    },
    settings: { revision: 1, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}

function historyPage(turnIds: string[]): HistoryPage {
  const snapshot = makeSnapshot(turnIds, false);
  return {
    orderedTurnIds: snapshot.orderedTurnIds,
    turnsById: snapshot.turnsById,
    forkSource: snapshot.forkSource,
    forksByTurnId: snapshot.forksByTurnId,
    itemsById: snapshot.itemsById,
  };
}

function activityHistoryPage(
  kind: "reasoning" | "activity_summary",
  text = "",
): HistoryPage {
  const page = historyPage(["turn-1"]);
  page.turnsById["turn-1"] = {
    ...page.turnsById["turn-1"]!,
    orderedItemIds: ["activity-1"],
  };
  page.itemsById = {
    "activity-1":
      kind === "reasoning"
        ? {
            id: "activity-1",
            turnId: "turn-1",
            kind,
            status: "completed",
            revision: 1,
            markdown: { text },
          }
        : {
            id: "activity-1",
            turnId: "turn-1",
            kind,
            activityKind: "reasoning",
            status: "completed",
            revision: 1,
          },
  };
  return page;
}

function activitySnapshot(
  kind: "reasoning" | "activity_summary",
): NormalizedThreadSnapshot {
  const snapshot = makeSnapshot(["turn-1"], false);
  const page = activityHistoryPage(kind, "detail");
  snapshot.turnsById = page.turnsById;
  snapshot.itemsById = page.itemsById;
  return snapshot;
}

function userMessageSnapshot(turnIds: string[]): NormalizedThreadSnapshot {
  const snapshot = makeSnapshot(turnIds, false);
  for (const turnId of turnIds) {
    const itemId = `${turnId}-user`;
    snapshot.turnsById[turnId] = {
      ...snapshot.turnsById[turnId]!,
      orderedItemIds: [itemId],
    };
    snapshot.itemsById[itemId] = {
      id: itemId,
      turnId,
      kind: "user_message",
      status: "completed",
      revision: 1,
      content: [{ kind: "text", text: { text: `Prompt ${turnId}` } }],
    };
  }
  return snapshot;
}

function asyncQuestionItem(turnId: string): ConversationItem {
  return {
    id: `${turnId}-message`,
    turnId,
    kind: "assistant_message",
    status: "completed",
    revision: 1,
    markdown: { text: "Which region?\n- us-east\n- eu-west" },
    nonblockingQuestions: {
      sourceItemId: `${turnId}-question`,
      questions: [{ title: "Which region?", options: ["us-east", "eu-west"] }],
    },
  };
}
