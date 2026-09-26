import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { navigate, threadPath, threadTurnPath } from "../app/router.js";
import { getSeekOnSubmit } from "../app/settings.js";
import { matchesKeyboardShortcut } from "../app/keyboard-shortcuts.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import {
  useThreadStore,
  type ThreadClientStore,
} from "../stores/ThreadClientStore.js";
import { ThreadLoadingView } from "./thread/ThreadLoadingView.js";
import { ThreadAutomationDialog } from "./ThreadAutomationDialog.js";
import { ChatAtmosphere } from "./thread/ChatAtmosphere.js";
import { Composer } from "./thread/Composer.js";
import {
  QuestionInboxProvider,
  QuestionInboxNotice,
} from "./thread/QuestionInbox.js";
import { InteractionPrompt } from "./thread/InteractionPrompt.js";
import { BackgroundActivityStatus } from "./thread/BackgroundActivityStatus.js";
import { ReasoningSummaryStatus } from "./thread/ReasoningSummaryStatus.js";
import { ThreadFailureNotice } from "./thread/ThreadFailureNotice.js";
import { ThreadHeader } from "./thread/ThreadHeader.js";
import { ThreadFindBar } from "./thread/ThreadFindBar.js";
import { ThreadRecoveryCallout } from "./thread/ThreadRecoveryCallout.js";
import {
  Transcript,
  type TranscriptHandle,
  type TranscriptHistoryPresentation,
  type TranscriptSeekRequest,
} from "./thread/Transcript.js";
import { Button } from "@client/components/ui/button";
import { CodexTuiThreadPresentation } from "../provider-features/codex-tui.js";
import { useMediaQuery } from "../app/use-media-query.js";
import {
  currentThreadLoadAttempt,
  recordThreadLoadDiagnostic,
} from "../app/thread-load-diagnostics.js";
import type { PanelChromeControls } from "../workspace-panels/PanelChrome.js";
import { useTaskDrag } from "../tasks/task-drag.js";

const DESKTOP_CHAT_AUTOFOCUS_QUERY = "(min-width: 820px) and (pointer: fine)";
const CONNECTING_BANNER_DELAY_MS = 5_000;

export function ThreadView({
  threadId,
  visible,
  automationOpen,
  focusTurnId,
  registry,
  applicationStore,
  panelControls,
}: {
  threadId: string;
  /** Whether this retained singleton is currently presented in the layout. */
  visible: boolean;
  automationOpen: boolean;
  focusTurnId?: string;
  registry: ThreadStoreRegistry;
  applicationStore: ApplicationClientStore;
  panelControls?: PanelChromeControls;
}): React.JSX.Element {
  const store = useMemo<ThreadClientStore>(
    () => registry.get(threadId),
    [registry, threadId],
  );
  const state = useThreadStore(store);
  const desktopChatAutofocus = useMediaQuery(DESKTOP_CHAT_AUTOFOCUS_QUERY);
  const taskDrag = useTaskDrag();
  const focusAtThreadOpen = useRef(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const interactionReturnFocus = useRef<HTMLElement | null>(null);
  const threadView = useRef<HTMLElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const findViewport = useRef<HTMLDivElement>(null);
  const findContent = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const [taskDropActive, setTaskDropActive] = useState(false);
  useEffect(() => {
    // Child drop surfaces such as the composer stop propagation because they
    // copy rather than move. The shared drag session still ends, so clear the
    // parent move overlay from that authoritative transition.
    if (taskDrag?.activeTaskId === undefined) setTaskDropActive(false);
  }, [taskDrag?.activeTaskId]);
  // Seek-on-submit signal from the composer to the transcript. A ref (not
  // state): arming it must not re-render, and the transcript consumes it
  // imperatively when the sent message shows up.
  const seekRequest = useRef<TranscriptSeekRequest | null>(null);
  const transcript = useRef<TranscriptHandle>(null);
  const [historyPresentation, setHistoryPresentation] =
    useState<TranscriptHistoryPresentation>({ entries: [] });
  const lastLoadCommitAttemptId = useRef<string | undefined>(undefined);
  const completedLoadPaintAttemptId = useRef<string | undefined>(undefined);
  const scheduledLoadPaintAttemptId = useRef<string | undefined>(undefined);
  const firstLoadPaintFrame = useRef<number | undefined>(undefined);
  const secondLoadPaintFrame = useRef<number | undefined>(undefined);
  const updateHistoryPresentation = useCallback(
    (next: TranscriptHistoryPresentation) => setHistoryPresentation(next),
    [],
  );
  const seekHistoryItem = useCallback(
    (itemId: string) => transcript.current?.seekHistoryItem(itemId),
    [],
  );
  const seekBookmarkTurn = useCallback(
    (turnId: string) => {
      if (!focusTurnId && transcript.current?.seekTurn(turnId)) return true;
      navigate(threadTurnPath(threadId, turnId));
      return false;
    },
    [focusTurnId, threadId],
  );

  useEffect(() => {
    registry.retainCached(threadId);
    return () => registry.releaseCached(threadId);
  }, [registry, threadId]);

  useEffect(() => setHistoryPresentation({ entries: [] }), [threadId]);

  useEffect(() => {
    if (!visible) setFindOpen(false);
  }, [visible]);

  useEffect(
    () => () => {
      if (firstLoadPaintFrame.current !== undefined) {
        cancelAnimationFrame(firstLoadPaintFrame.current);
      }
      if (secondLoadPaintFrame.current !== undefined) {
        cancelAnimationFrame(secondLoadPaintFrame.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const snapshot = state.snapshot;
    const cancelScheduledPaint = () => {
      if (firstLoadPaintFrame.current !== undefined) {
        cancelAnimationFrame(firstLoadPaintFrame.current);
      }
      if (secondLoadPaintFrame.current !== undefined) {
        cancelAnimationFrame(secondLoadPaintFrame.current);
      }
      firstLoadPaintFrame.current = undefined;
      secondLoadPaintFrame.current = undefined;
      scheduledLoadPaintAttemptId.current = undefined;
    };
    if (!visible || !snapshot) {
      cancelScheduledPaint();
      return;
    }
    const attempt = currentThreadLoadAttempt(threadId);
    if (!attempt) return;
    const itemCount = Object.keys(snapshot.itemsById).length;
    if (lastLoadCommitAttemptId.current !== attempt.id) {
      lastLoadCommitAttemptId.current = attempt.id;
      recordThreadLoadDiagnostic(attempt, "react_snapshot_committed", {
        turnCount: snapshot.orderedTurnIds.length,
        itemCount,
        hasActiveTurn: snapshot.activeTurnId !== undefined,
      });
    }
    if (
      completedLoadPaintAttemptId.current === attempt.id ||
      scheduledLoadPaintAttemptId.current === attempt.id
    ) {
      return;
    }
    cancelScheduledPaint();
    scheduledLoadPaintAttemptId.current = attempt.id;
    firstLoadPaintFrame.current = requestAnimationFrame(() => {
      firstLoadPaintFrame.current = undefined;
      secondLoadPaintFrame.current = requestAnimationFrame(() => {
        secondLoadPaintFrame.current = undefined;
        scheduledLoadPaintAttemptId.current = undefined;
        completedLoadPaintAttemptId.current = attempt.id;
        recordThreadLoadDiagnostic(attempt, "paint_frame_completed", {
          turnCount: snapshot.orderedTurnIds.length,
          itemCount,
        });
      });
    });
  }, [state.snapshot, threadId, visible]);

  useEffect(() => {
    if (state.connection !== "reconnecting") {
      setShowReconnectBanner(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowReconnectBanner(true),
      CONNECTING_BANNER_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.connection]);

  const visibleCompletionOperationId =
    state.snapshot?.attention.unseenCompletion?.operationId;
  useEffect(() => {
    if (
      !visible ||
      state.connection !== "connected" ||
      !state.authoritative ||
      !visibleCompletionOperationId
    ) {
      return;
    }
    void store
      .acknowledgeVisibleCompletion(visibleCompletionOperationId)
      .catch(() => undefined);
  }, [
    state.authoritative,
    state.connection,
    store,
    visible,
    visibleCompletionOperationId,
  ]);

  if (state.status === "loading") return (
    <ThreadLoadingView
      threadId={threadId}
      applicationStore={applicationStore}
      panelControls={panelControls}
    />
  );
  if (state.status === "error" || !state.snapshot) {
    return (
      <section className="thread-fatal">
        <p className="eyebrow">Thread unavailable</p>
        <h1>Couldn’t open this thread</h1>
        <p>{state.error ?? "The server returned an incomplete thread."}</p>
        {state.loadFailure && (
          <small className="thread-load-reference">
            Reference: {state.loadFailure.requestId}
          </small>
        )}
        <div className="thread-fatal-actions">
          <Button onClick={() => store.retryLoad()}>Try again</Button>
          <Button variant="outline" onClick={() => navigate("/")}>
            Back to threads
          </Button>
        </div>
      </section>
    );
  }

  const snapshot = state.snapshot;
  const readOnly = snapshot.capabilities.interactionMode === "read_only";
  const backendTransitioning =
    snapshot.runState === "disconnected" || snapshot.runState === "reconciling";
  const interaction = snapshot.interactions[0];
  const interactionCapability = interaction
    ? snapshot.capabilities.interactions.find(
        ({ kind }) => kind === interaction.kind,
      )
    : undefined;
  const recoverOperation = snapshot.capabilities.operations.find(
    ({ id }) => id === "recover_uncertain",
  );
  const discardForkOperation = snapshot.capabilities.operations.find(
    ({ id }) => id === "discard_fork",
  );
  const composerDisabled =
    !snapshot.thread.available ||
    backendTransitioning ||
    snapshot.thread.inventoryState === "archived" ||
    Boolean(snapshot.recovery) ||
    Boolean(focusTurnId);
  const disabled =
    composerDisabled ||
    state.connection !== "connected" ||
    !state.authoritative;
  const activeElement =
    typeof document === "undefined" ? null : document.activeElement;
  const shouldAutofocusChat =
    visible &&
    desktopChatAutofocus &&
    (activeElement === document.body ||
      activeElement === focusAtThreadOpen.current);
  const showInteractionTakeover =
    interaction !== undefined &&
    !readOnly &&
    !focusTurnId &&
    snapshot.thread.inventoryState !== "archived";
  if (visible && showInteractionTakeover) {
    interactionReturnFocus.current ??=
      activeElement instanceof HTMLElement ? activeElement : null;
  } else if (!showInteractionTakeover) {
    interactionReturnFocus.current = null;
  }
  const interactionUnavailable =
    showInteractionTakeover && (!interactionCapability?.available || disabled);
  const interactionUnavailableReason =
    interactionCapability?.unavailableReason?.text ??
    (state.connection !== "connected"
      ? "Reconnect to answer this request."
      : backendTransitioning
        ? "The backend is reconnecting. This request will remain open."
        : snapshot.recovery
          ? "Resolve the uncertain operation before answering this request."
          : !snapshot.thread.available
            ? "This thread is currently unavailable."
            : "This request cannot be answered right now.");

  return (
    <QuestionInboxProvider key={threadId} store={store} visible={visible}>
      <section
        ref={threadView}
        className="thread-view"
        data-testid="thread-view"
        data-task-drop-active={taskDropActive || undefined}
        aria-label={`Thread: ${snapshot.thread.title.text}`}
        onKeyDown={(event) => {
          if (!visible || event.defaultPrevented || event.nativeEvent.isComposing)
            return;
          const direction = matchesKeyboardShortcut(event, {
            key: "ArrowUp",
            modifiers: ["primary"],
          })
            ? "previous"
            : matchesKeyboardShortcut(event, {
                  key: "ArrowDown",
                  modifiers: ["primary"],
                })
              ? "next"
              : undefined;
          if (!direction || !transcript.current) return;
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !event.currentTarget.contains(target)
          )
            return;
          if (
            target.closest(
              '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-slot="popover-content"]',
            )
          )
            return;
          const editable = target.closest(
            'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
          );
          if (
            editable &&
            !(
              editable instanceof HTMLTextAreaElement &&
              editable.closest('[data-task-drop-surface="composer"]') &&
              editable.value.length === 0 &&
              editable.getAttribute("aria-expanded") !== "true"
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          transcript.current.seekAdjacentHistoryItem(direction);
        }}
        onDragEnterCapture={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('[data-task-drop-surface="composer"]') !== null
          ) {
            setTaskDropActive(false);
          }
        }}
        onDragOverCapture={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          const target = event.target;
          const overComposer =
            target instanceof Element &&
            target.closest('[data-task-drop-surface="composer"]') !== null;
          setTaskDropActive(!overComposer);
        }}
        onDragEnter={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          event.preventDefault();
          setTaskDropActive(true);
        }}
        onDragOver={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDragLeave={(event) => {
          if (
            taskDrag?.isTaskDrag(event.dataTransfer) &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setTaskDropActive(false);
          }
        }}
        onDrop={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          event.preventDefault();
          setTaskDropActive(false);
          const task = taskDrag.resolveDraggedTask(event.dataTransfer);
          taskDrag.endTaskDrag();
          if (!task) {
            taskDrag.announce(
              "That task changed before it could be moved. Review it and try again.",
              true,
            );
            return;
          }
          void taskDrag.requestMove(task, {
            threadId,
            threadTitle: snapshot.thread.title.text,
            workspaceId: snapshot.thread.workspaceId,
            workspaceLabel: snapshot.workspace.label.text,
          });
        }}
      >
        {taskDropActive && (
          <div className="thread-task-drop-indicator" aria-hidden="true">
            Move task to {snapshot.thread.title.text}
          </div>
        )}
        <ThreadHeader
          active={visible}
          store={store}
          applicationStore={applicationStore}
          snapshot={snapshot}
          connection={state.connection}
          authoritative={state.authoritative}
          forkAttempts={state.forkAttempts}
          actionPending={state.actionPending}
          panelControls={panelControls}
          findOpen={findOpen}
          findButtonRef={findButton}
          onFindOpenChange={setFindOpen}
          bookmarks={state.bookmarks}
          bookmarkStatus={state.bookmarkStatus}
          bookmarkRevision={state.bookmarkRevision}
          bookmarkError={state.bookmarkError}
          pendingBookmarkTurnIds={state.pendingBookmarkTurnIds}
          onSelectBookmarkTurn={seekBookmarkTurn}
        />
        <ThreadFindBar
          id={`thread-find-${threadId}`}
          open={findOpen}
          visible={visible}
          onOpenChange={setFindOpen}
          triggerRef={findButton}
          scopeRef={threadView}
          contentRef={findContent}
          viewportRef={findViewport}
        />
        {state.loadFailure && (
          <div className="runtime-banner error" role="alert">
            <strong>Couldn’t refresh this thread.</strong>
            <span>{state.loadFailure.error.message}</span>
            <small>Reference: {state.loadFailure.requestId}</small>
            <Button
              className="thread-load-retry"
              variant="outline"
              size="xs"
              onClick={() => store.retryLoad()}
            >
              {state.loadFailure.error.retryable ? "Try now" : "Try again"}
            </Button>
          </div>
        )}
        {!state.loadFailure && state.terminalLoadError && (
          <div className="runtime-banner error" role="alert">
            <strong>Couldn’t refresh this thread.</strong>
            <span>{state.terminalLoadError}</span>
            <Button
              className="thread-load-retry"
              variant="outline"
              size="xs"
              onClick={() => store.retryLoad()}
            >
              Try again
            </Button>
          </div>
        )}
        {!state.loadFailure &&
          !state.terminalLoadError &&
          (state.connection === "disconnected" || showReconnectBanner) && (
            <div className={`runtime-banner ${state.connection}`} role="status">
              <strong>
                {state.connection === "reconnecting"
                  ? "Connecting…"
                  : "Disconnected"}
              </strong>
              <span>
                {state.connection === "reconnecting"
                  ? "Work may continue in the background."
                  : "Accepted work may still be running."}
              </span>
            </div>
          )}
        {state.connection === "connected" &&
          snapshot.runState === "disconnected" && (
            <div className="runtime-banner disconnected" role="status">
              <strong>Backend disconnected</strong>
              <span>
                History remains visible, but backend actions are unavailable.
              </span>
            </div>
          )}
        {state.connection === "connected" &&
          snapshot.runState === "reconciling" && (
            <div className="runtime-banner reconnecting" role="status">
              <strong>Reconciling thread…</strong>
              <span>
                Refreshing authoritative backend state; actions are temporarily
                unavailable.
              </span>
            </div>
          )}
        {!snapshot.environment.available && (
          <div className="runtime-banner error" role="alert">
            <strong>{snapshot.environment.label.text} is unavailable.</strong>
            <span>
              {snapshot.environment.diagnostic?.text ??
                "Reconnect the execution environment to continue."}
            </span>
          </div>
        )}
        {!snapshot.workspace.available && (
          <div className="runtime-banner error" role="alert">
            <strong>{snapshot.workspace.label.text} is unavailable.</strong>
            <span>Reopen this workspace from the navigation to continue.</span>
          </div>
        )}
        {snapshot.recovery && (
          <ThreadRecoveryCallout
            recovery={snapshot.recovery}
            operation={recoverOperation}
            discardOperation={discardForkOperation}
            pending={state.actionPending}
            onRecover={() =>
              void store.recoverUncertain().catch(() => undefined)
            }
            onDiscard={() => void store.discardFork().catch(() => undefined)}
          />
        )}
        <QuestionInboxNotice />
        {snapshot.attention.wake && (
          <aside
            className="thread-attention wake-attention"
            data-testid="wake-attention"
          >
            <p>{snapshot.attention.wake.text?.text ?? "Woke"}</p>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void store
                  .dismissAttention({
                    kind: "wake",
                    wokeAt: snapshot.attention.wake!.wokeAt,
                  })
                  .catch(() => undefined)
              }
            >
              Dismiss
            </Button>
          </aside>
        )}
        {snapshot.attention.automationContext && (
          <aside className="thread-attention automation-context">
            <p>
              {snapshot.attention.automationContext.outcome === "failed"
                ? "This scheduled run failed."
                : "This thread was triggered by an automation."}
            </p>
            {snapshot.attention.automationContext.diagnostic && (
              <small>
                {snapshot.attention.automationContext.diagnostic.text}
              </small>
            )}
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void store
                  .dismissAttention({
                    kind: "automation_context",
                    runId: snapshot.attention.automationContext!.runId,
                  })
                  .catch(() => undefined)
              }
            >
              Dismiss
            </Button>
          </aside>
        )}
        <ThreadFailureNotice snapshot={snapshot} />
        {store.normalized.state.notices.map((notice) => (
          <div
            className={`thread-notice ${notice.tone}`}
            key={notice.id}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.message.text}
          </div>
        ))}
        <CodexTuiThreadPresentation
          threadId={threadId}
          visible={visible}
          snapshot={snapshot}
          store={store}
          api={applicationStore.api}
          historicalFocus={Boolean(focusTurnId)}
          mobileHistory={{
            ...historyPresentation,
            assistantLabel: snapshot.capabilities.backend.label.text,
            onSelect: seekHistoryItem,
            onBeginInteraction: () => transcript.current?.beginHistoryScrub(),
          }}
          chat={
            <>
              <ChatAtmosphere />
              <div className="thread-conversation-pane">
                <Transcript
                  ref={transcript}
                  store={store}
                  findContentRef={findContent}
                  findViewportRef={findViewport}
                  seekRequest={seekRequest}
                  focusTurnId={focusTurnId}
                  onHistoryPresentationChange={updateHistoryPresentation}
                  onReturnToLive={() =>
                    navigate(threadPath(threadId), { replace: true })
                  }
                />
              </div>
              {readOnly && (
                <div className="runtime-banner" role="status">
                  <strong>Read-only thread</strong>
                  <span>
                    This backend is available for history and live status only.
                  </span>
                </div>
              )}
              {state.actionError && !showInteractionTakeover && (
                <div className="action-error" role="alert">
                  <span>{state.actionError}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => store.clearActionError()}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </>
          }
          composer={
            !readOnly ? (
              // Keyed by thread: the composer owns its draft locally, so a thread
              // switch must remount it — reseeding from the new thread's snapshot
              // and flushing the old thread's unsaved text on unmount. Rendered
              // below both Chat and TUI panels so a view switch never remounts it.
              // TUI reuses this durable composer but redirects its final submit
              // into the terminal instead of the normalized delivery API.
              <Composer
                active={visible}
                key={threadId}
                store={store}
                applicationStore={applicationStore}
                disabled={composerDisabled}
                hidePendingInputs={showInteractionTakeover}
                optimisticTranscriptPresentationVisible={
                  focusTurnId === undefined
                }
                autoFocus={shouldAutofocusChat}
                onImmediateSend={(operationId) => {
                  if (getSeekOnSubmit()) {
                    seekRequest.current = {
                      requestedAt: Date.now(),
                      operationId,
                    };
                  }
                }}
              />
            ) : undefined
          }
          status={
            !readOnly ? (
              <>
                <ReasoningSummaryStatus
                  key={threadId}
                  snapshot={snapshot}
                  livePresentation={focusTurnId === undefined}
                  interactionTakeover={showInteractionTakeover}
                />
                <BackgroundActivityStatus
                  snapshot={snapshot}
                  current={
                    state.connection === "connected" && state.authoritative
                  }
                  livePresentation={focusTurnId === undefined}
                  interactionTakeover={showInteractionTakeover}
                />
              </>
            ) : undefined
          }
          takeover={
            showInteractionTakeover ? (
              <InteractionPrompt
                request={interaction!}
                store={store}
                queueLength={snapshot.interactions.length}
                externallyPending={state.actionPending}
                actionError={state.actionError}
                onDismissError={() => store.clearActionError()}
                canInterrupt={snapshot.capabilities.operations.some(
                  ({ id, available }) => id === "interrupt" && available,
                )}
                unavailable={interactionUnavailable}
                unavailableReason={interactionUnavailableReason}
                returnFocusTarget={interactionReturnFocus.current}
                visible={visible}
              />
            ) : undefined
          }
        />
        {visible && automationOpen && snapshot.capabilities.automation.available && (
          <ThreadAutomationDialog
            store={applicationStore}
            threadId={threadId}
            threadTitle={snapshot.thread.title.text}
            automationSummary={snapshot.thread.automation}
            snoozed={snapshot.thread.inventoryState === "snoozed"}
            canCloneOnRun={snapshot.capabilities.automation.canCloneOnRun}
            onClose={() => navigate(threadPath(threadId), { replace: true })}
          />
        )}
      </section>
    </QuestionInboxProvider>
  );
}
