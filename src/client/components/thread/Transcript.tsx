import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ActivityDetailMode,
  ConversationItem,
  ConversationTurn,
  HistoryPage,
  ThreadRunState,
  UserMessageItem,
} from "../../../shared/index.js";
import {
  useThreadStore,
  type PendingComposerTransfer,
  type ThreadProjectionViewportAnchor,
  type ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { ConversationItemView } from "../conversation/ConversationItemView.js";
import {
  UserMessagePresentation,
  type UserMessagePresentationPart,
} from "../conversation/renderers/MessageRenderers.js";
import {
  defaultItemRenderContext,
  type ItemRenderContext,
} from "../conversation/types.js";
import { ArrowDown, Bookmark, LoaderCircle } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { SedesMark } from "../brand-icons.js";
import {
  recordSeekDiagnostic,
  type SeekDiagnosticDetails,
  type SeekDiagnosticEvent,
} from "../../app/diagnostics.js";
import { getDiagnosticCategoryEnabled } from "../../app/settings.js";
import { currentFailedTurn, TurnFailureDetails } from "./ThreadFailureNotice.js";
import { TurnForkDivider } from "./TurnForkDivider.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { useSmoothStreaming } from "../../app/use-smooth-streaming.js";
import {
  ChatHistoryRail,
  createChatHistoryEntries,
  type ChatHistoryEntry,
} from "./ChatHistoryRail.js";
import { ActivityGroup } from "./ActivityGroup.js";
import { ViewedImageGroup } from "./ViewedImageGroup.js";
import { isActivityItem, type ActivityItem } from "./activity-groups.js";
import { navigationScrollBehavior } from "./navigation-scroll.js";

/**
 * Armed by ThreadView when the composer delivers a message while the
 * "seek on send" setting is enabled. The exact client or authoritative row
 * for that operation consumes it; stale failed-send requests expire.
 */
export type TranscriptSeekRequest = {
  readonly requestedAt: number;
  readonly operationId: string;
};

export type TranscriptHistoryPresentation = {
  readonly entries: readonly ChatHistoryEntry[];
  readonly activeItemId?: string;
};

export type TranscriptHandle = {
  readonly beginHistoryScrub: () => string | undefined;
  readonly seekHistoryItem: (itemId: string) => void;
  readonly seekAdjacentHistoryItem: (direction: "previous" | "next") => void;
  /**
   * Seeks a turn that is already rendered in the ordinary transcript.
   * Returns false when the caller must fall back to targeted history lookup.
   */
  readonly seekTurn: (turnId: string) => boolean;
};

export type TranscriptProps = {
  readonly ref?: React.Ref<TranscriptHandle>;
  readonly store: ThreadClientStore;
  readonly seekRequest?: React.RefObject<TranscriptSeekRequest | null>;
  readonly focusTurnId?: string;
  readonly onReturnToLive?: () => void;
  readonly onHistoryPresentationChange?: (
    presentation: TranscriptHistoryPresentation,
  ) => void;
  readonly findContentRef?: RefObject<HTMLDivElement | null>;
  readonly findViewportRef?: RefObject<HTMLDivElement | null>;
};

const seekRequestTtlMilliseconds = 15_000;
const seekCompletionCheckMilliseconds = 1_000;
/** Breathing room between the viewport top and the pinned message. */
const seekTopOffset = 16;
/** Keys that express scroll intent on the focused viewport (End/Home have
    dedicated handling; these fall through to the browser's own scroll). */
const scrollIntentKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  " ",
]);

export function Transcript({
  ref,
  store,
  seekRequest,
  focusTurnId,
  onReturnToLive,
  onHistoryPresentationChange,
  findContentRef,
  findViewportRef,
}: TranscriptProps): React.JSX.Element {
  const {
    snapshot,
    pendingComposerTransfers,
    historyLoading,
    connection,
    authoritative,
    forkAttempts,
    bookmarks,
    bookmarkStatus,
    pendingBookmarkTurnIds,
  } = useThreadStore(store);
  const activityDetail = store.activityDetail;
  const ownedViewport = useRef<HTMLDivElement>(null);
  const ownedContent = useRef<HTMLDivElement>(null);
  const viewport = findViewportRef ?? ownedViewport;
  const content = findContentRef ?? ownedContent;
  const presentedOptimisticOperations = useRef({
    store,
    operationIds: new Set<string>(),
  });
  const reportedUnanchoredOperations = useRef({
    store,
    operationIds: new Set<string>(),
  });
  if (presentedOptimisticOperations.current.store !== store) {
    presentedOptimisticOperations.current = {
      store,
      operationIds: new Set<string>(),
    };
  }
  if (reportedUnanchoredOperations.current.store !== store) {
    reportedUnanchoredOperations.current = {
      store,
      operationIds: new Set<string>(),
    };
  }
  const opened = useRef(false);
  const wasAtLiveEdge = useRef(true);
  const previousIds = useRef<string[]>([]);
  const previousTurnIds = useRef<string[]>([]);
  const previousHeight = useRef(0);
  const prependAnchor = useRef<
    { readonly turnId: string; readonly offsetTop: number } | undefined
  >(undefined);
  const seekSpacer = useRef<HTMLDivElement>(null);
  const seekPin = useRef<
    | {
        readonly itemId: string;
        readonly operationId?: string;
        readerScrolled: boolean;
        readerBottomSide?: -1 | 0 | 1;
      }
    | undefined
  >(undefined);
  const seekScroll = useRef<
    { readonly element: HTMLElement; readonly cleanup: () => void } | undefined
  >(undefined);
  const seekBeginFrame = useRef<number | undefined>(undefined);
  const deferredFollowFrames = useRef(new Set<number>());
  const liveEdgeFollowFrame = useRef<number | undefined>(undefined);
  const liveEdgeFollowLastTime = useRef<number | undefined>(undefined);
  const liveEdgeFollowOwned = useRef(false);
  const observedViewportHeight = useRef<number | undefined>(undefined);
  const viewportResizeFrame = useRef<number | undefined>(undefined);
  const viewportResizeSettleFrame = useRef<number | undefined>(undefined);
  const viewportResizeActive = useRef(false);
  const viewportResizeReaderOwned = useRef(false);
  const viewportResizeFollowIntent = useRef(false);
  const observedContentWidth = useRef<number | undefined>(undefined);
  const selectionPointerDown = useRef(false);
  const selectionDragActive = useRef(false);
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [activeHistoryItemId, setActiveHistoryItemId] = useState<string>();
  // Mirrors the seek pin's engage/release as renderable state so the
  // "Jump to latest" FAB stays hidden while the pin holds the viewport
  // (the pin itself already forces atLiveEdge=false). The ref remains the
  // source of truth for the scroll math; this only flips on engage, on
  // release, and when the reader scrolls on their own — React bails out of
  // same-value sets, so there is no per-scroll re-render churn.
  const [seekPinHeld, setSeekPinHeld] = useState(false);
  const [historyLoadIntent, setHistoryLoadIntent] = useState<
    "more" | "all" | undefined
  >();
  const [focusStatus, setFocusStatus] = useState<
    "idle" | "loading" | "found" | "not_found" | "unavailable" | "error"
  >("idle");
  const [focusDiagnostic, setFocusDiagnostic] = useState<string>();
  const [focusRetryable, setFocusRetryable] = useState(false);
  const [focusPage, setFocusPage] = useState<
    | {
        readonly targetTurnId: string;
        readonly activityDetail: ActivityDetailMode;
        readonly page: HistoryPage;
      }
    | undefined
  >();
  const [focusRetryNonce, setFocusRetryNonce] = useState(0);
  const [locallySelectedTurnId, setLocallySelectedTurnId] = useState<string>();
  const focusAttemptTarget = useRef<string | undefined>(undefined);
  const handledFocusTarget = useRef<string | undefined>(undefined);
  const selectedFocusPage =
    focusPage &&
    focusPage.targetTurnId === focusTurnId &&
    focusPage.activityDetail === activityDetail
      ? focusPage.page
      : undefined;
  const currentFailureTurnId = snapshot ? currentFailedTurn(snapshot)?.id : undefined;
  const viewTurnsById = selectedFocusPage?.turnsById ?? snapshot?.turnsById;
  const viewForksByTurnId =
    selectedFocusPage?.forksByTurnId ?? snapshot?.forksByTurnId;
  const viewItemsById = selectedFocusPage?.itemsById ?? snapshot?.itemsById;
  const turnIds =
    selectedFocusPage?.orderedTurnIds ?? snapshot?.orderedTurnIds ?? [];
  const latestCompletedTurnId = [...turnIds]
    .reverse()
    .find((turnId) => viewTurnsById?.[turnId]?.status === "completed");
  const itemIds = turnIds.flatMap(
    (turnId) => viewTurnsById?.[turnId]?.orderedItemIds ?? [],
  );
  const optimisticTransfers =
    focusTurnId || selectedFocusPage
      ? []
      : pendingComposerTransfers
          .filter(isVisibleOptimisticSubmit)
          .sort(
            (left, right) =>
              left.presentationSequence - right.presentationSequence,
          );
  const optimisticByPlacement = optimisticTransfersByPlacement(
    optimisticTransfers,
    pendingComposerTransfers,
    new Set(itemIds),
    turnIds,
    viewTurnsById,
  );
  const unanchoredOptimisticTransfers =
    optimisticByPlacement.get(optimisticStartPlacement) ?? [];
  const presentationItemIds = [
    ...unanchoredOptimisticTransfers.map((transfer) =>
      provisionalItemId(transfer.operationId),
    ),
    ...turnIds.flatMap((turnId) => [
      ...(viewTurnsById?.[turnId]?.orderedItemIds ?? []).flatMap((itemId) => [
        ...(
          optimisticByPlacement.get(optimisticBeforeItemPlacement(itemId)) ?? []
        ).map((transfer) => provisionalItemId(transfer.operationId)),
        itemId,
        ...(
          optimisticByPlacement.get(optimisticAfterItemPlacement(itemId)) ?? []
        ).map((transfer) => provisionalItemId(transfer.operationId)),
      ]),
      ...(
        optimisticByPlacement.get(optimisticAfterTurnPlacement(turnId)) ?? []
      ).map((transfer) => provisionalItemId(transfer.operationId)),
    ]),
  ];
  const hasItems = presentationItemIds.length > 0;
  useLayoutEffect(() => {
    for (const transfer of optimisticTransfers) {
      presentedOptimisticOperations.current.operationIds.add(
        transfer.operationId,
      );
    }
  }, [optimisticTransfers]);
  useEffect(() => {
    for (const transfer of optimisticTransfers) {
      if (
        reportedUnanchoredOperations.current.operationIds.has(
          transfer.operationId,
        ) ||
        !hasIrreduciblyMissingAnchor(transfer, turnIds, viewTurnsById)
      ) {
        continue;
      }
      reportedUnanchoredOperations.current.operationIds.add(
        transfer.operationId,
      );
      recordSeekDiagnostic("optimistic_anchor_unresolved", {
        reason: "baseline_topology_unavailable",
        itemCount: itemIds.length,
        turnCount: turnIds.length,
      });
    }
  }, [itemIds.length, optimisticTransfers, turnIds, viewTurnsById]);
  // Stable render context: a fresh inline object per render would defeat
  // ConversationItemView's memoization.
  const assistantLabel = snapshot?.capabilities.backend.label.text;
  const providerFeatureCapabilities = snapshot?.capabilities.providerFeatures;
  const loadAttachmentContent = useCallback(
    (attachmentId: string, signal: AbortSignal) =>
      store.loadComposerAttachmentContent(attachmentId, signal),
    [store],
  );
  const loadOutputArtifactContent = useCallback(
    (artifactId: string, signal: AbortSignal) =>
      store.loadOutputArtifactContent(artifactId, signal),
    [store],
  );
  const itemRenderContext = useMemo(
    () =>
      assistantLabel && providerFeatureCapabilities
        ? {
            assistantLabel,
            loadAttachmentContent,
            loadOutputArtifactContent,
            providerFeatureCapabilities,
          }
        : undefined,
    [
      assistantLabel,
      loadAttachmentContent,
      loadOutputArtifactContent,
      providerFeatureCapabilities,
    ],
  );
  const historyEntries = useMemo(
    () =>
      createChatHistoryEntries(
        turnIds,
        viewTurnsById,
        viewItemsById,
        new Set(bookmarks.map((bookmark) => bookmark.turnId)),
      ),
    [bookmarks, turnIds, viewItemsById, viewTurnsById],
  );
  const bookmarkedTurnIds = useMemo(
    () => new Set(bookmarks.map((bookmark) => bookmark.turnId)),
    [bookmarks],
  );
  const pendingBookmarkTurnIdSet = useMemo(
    () => new Set(pendingBookmarkTurnIds),
    [pendingBookmarkTurnIds],
  );
  const historyEntriesByItemId = useMemo(
    () => new Map(historyEntries.map((entry) => [entry.itemId, entry])),
    [historyEntries],
  );
  useEffect(() => {
    if (!authoritative || bookmarkStatus !== "ready") return;
    for (const bookmark of bookmarks) {
      const turn = viewTurnsById?.[bookmark.turnId];
      if (!turn || turn.status === "in_progress") continue;
      const firstUserItemId = turn.orderedItemIds.find(
        (itemId) => viewItemsById?.[itemId]?.kind === "user_message",
      );
      const entry = firstUserItemId
        ? historyEntriesByItemId.get(firstUserItemId)
        : undefined;
      if (!entry) continue;
      // Bounded history may omit replies. Missing text must not erase a saved
      // response preview from a more complete projection.
      if (entry.responseState !== "available" && bookmark.assistantPreview !== null) {
        continue;
      }
      const preview = {
        userPreview: bookmark.userPreview,
        assistantPreview:
          entry.responseState === "available" ? entry.assistantPreview : null,
        responseState:
          entry.responseState === "available"
            ? ("responded" as const)
            : ("no_response" as const),
      };
      if (
        bookmark.userPreview === preview.userPreview &&
        bookmark.assistantPreview === preview.assistantPreview &&
        bookmark.responseState === preview.responseState
      ) {
        continue;
      }
      void store
        .refreshTurnBookmarkPreview({ turnId: turn.id, preview })
        .catch(() => undefined);
    }
  }, [
    authoritative,
    bookmarkStatus,
    bookmarks,
    historyEntriesByItemId,
    store,
    viewItemsById,
    viewTurnsById,
  ]);
  const historyEntriesRef = useRef(historyEntries);
  historyEntriesRef.current = historyEntries;
  const historyEntryKey = historyEntries
    .map((entry) => entry.itemId)
    .join("\u0000");
  const historyEntryIdsRef = useRef(
    new Set(historyEntries.map((entry) => entry.itemId)),
  );
  historyEntryIdsRef.current = new Set(
    historyEntries.map((entry) => entry.itemId),
  );
  const runState = snapshot?.runState ?? "idle";
  const readOnly = snapshot?.capabilities.interactionMode === "read_only";
  const diagnosticState = useRef({ runState, itemCount: itemIds.length });
  diagnosticState.current = { runState, itemCount: itemIds.length };
  const smoothStreaming = useSmoothStreaming();
  const smoothStreamingRef = useRef(smoothStreaming);
  smoothStreamingRef.current = smoothStreaming;
  const chatViewVisible = useContext(ChatViewVisibilityContext);
  const chatViewVisibleRef = useRef(chatViewVisible);
  chatViewVisibleRef.current = chatViewVisible;
  const focusTurnIdRef = useRef(focusTurnId);
  focusTurnIdRef.current = focusTurnId;

  const traceSeek = (
    event: SeekDiagnosticEvent,
    details: SeekDiagnosticDetails = {},
  ) => {
    if (!getDiagnosticCategoryEnabled("seek")) return;
    const element = viewport.current;
    // Scroll samples must not force layout while measuring the animation.
    if (event === "viewport_scrolled") {
      recordSeekDiagnostic(event, {
        animationActive: seekScroll.current !== undefined,
        scrollTop: element?.scrollTop ?? null,
      });
      return;
    }
    const contentElement = content.current;
    const spacerElement = seekSpacer.current;
    const pin = seekPin.current;
    const target = element && pin ? findSeekTarget(element, pin) : null;
    const viewportRect = element?.getBoundingClientRect();
    const contentRect = contentElement?.getBoundingClientRect();
    const spacerRect = spacerElement?.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    const viewportStyle = element ? getComputedStyle(element) : undefined;
    const contentStyle = contentElement
      ? getComputedStyle(contentElement)
      : undefined;
    const spacerStyle = spacerElement
      ? getComputedStyle(spacerElement)
      : undefined;
    const visualViewport = window.visualViewport;
    const rounded = (value: number | undefined): number | null =>
      value === undefined ? null : Math.round(value * 10) / 10;
    recordSeekDiagnostic(event, {
      runState: diagnosticState.current.runState,
      itemCount: diagnosticState.current.itemCount,
      pinActive: pin !== undefined,
      wasAtLiveEdge: wasAtLiveEdge.current,
      readerScrolled: pin?.readerScrolled ?? false,
      readerBottomSide: pin?.readerBottomSide ?? null,
      animationActive: seekScroll.current !== undefined,
      spacerHeight: rounded(measureSeekSpacerHeight()),
      scrollTop: rounded(element?.scrollTop),
      scrollLeft: rounded(element?.scrollLeft),
      scrollHeight: rounded(element?.scrollHeight),
      scrollWidth: rounded(element?.scrollWidth),
      clientHeight: rounded(element?.clientHeight),
      clientWidth: rounded(element?.clientWidth),
      naturalBottomDistance: element
        ? rounded(
            element.scrollHeight -
              measureSeekSpacerHeight() -
              element.scrollTop -
              element.clientHeight,
          )
        : null,
      viewportTop: rounded(viewportRect?.top),
      viewportBottom: rounded(viewportRect?.bottom),
      viewportHeight: rounded(viewportRect?.height),
      viewportOverflowAnchor: viewportStyle?.overflowAnchor ?? null,
      viewportOverflowY: viewportStyle?.overflowY ?? null,
      viewportScrollBehavior: viewportStyle?.scrollBehavior ?? null,
      contentTop: rounded(contentRect?.top),
      contentBottom: rounded(contentRect?.bottom),
      contentHeight: rounded(contentRect?.height),
      contentOverflowAnchor: contentStyle?.overflowAnchor ?? null,
      spacerTop: rounded(spacerRect?.top),
      spacerBottom: rounded(spacerRect?.bottom),
      spacerComputedHeight: spacerStyle?.height ?? null,
      targetOffsetTop: rounded(target?.offsetTop),
      targetTop: rounded(targetRect?.top),
      targetBottom: rounded(targetRect?.bottom),
      windowInnerWidth: window.innerWidth,
      windowInnerHeight: window.innerHeight,
      visualViewportWidth: rounded(visualViewport?.width),
      visualViewportHeight: rounded(visualViewport?.height),
      visualViewportOffsetTop: rounded(visualViewport?.offsetTop),
      ...details,
    });
  };

  useLayoutEffect(() => {
    traceSeek("snapshot_committed", {
      hasActiveTurn: snapshot?.activeTurnId !== undefined,
    });
  }, [snapshot]);

  useEffect(() => {
    traceSeek("snapshot_painted", {
      hasActiveTurn: snapshot?.activeTurnId !== undefined,
    });
  }, [snapshot]);

  const measureLiveEdge = () => {
    const element = viewport.current;
    if (!element) return true;
    // While a seek-on-submit pin is active the bottom is not a live edge —
    // the pin's own eased scroll (and the padded reservation) would
    // otherwise read as "reader at the bottom" and re-engage follow. Follow
    // resumes through "Jump to latest"/End, a reader scroll that reaches the
    // natural content bottom, or a later send.
    if (seekPin.current) return false;
    return (
      element.scrollHeight - element.scrollTop - element.clientHeight <= 96
    );
  };

  const measureSeekSpacerHeight = () =>
    seekSpacer.current?.getBoundingClientRect().height ?? 0;

  const setSeekSpacerHeight = (height: number) => {
    const previous = measureSeekSpacerHeight();
    if (seekSpacer.current) {
      // Keep the scroll range stable in the same layout as a keyboard/viewport
      // resize. A pixel height updated in a later observer frame lets the
      // browser clamp the in-flight scroll backward before space catches up.
      seekSpacer.current.style.height =
        height > 0
          ? `max(0px, calc(100cqh + ${height - (viewport.current?.clientHeight ?? 0)}px))`
          : "0px";
    }
    if (previous !== height) {
      traceSeek("spacer_height_changed", {
        previousSpacerHeight: previous,
        nextSpacerHeight: height,
      });
    }
  };

  const syncHistoryRailActive = (): string | undefined => {
    // Intermediate history markers are decorative during an owned seek.
    // Reconcile at completion or when reader input takes over instead.
    if (seekScroll.current !== undefined) return;
    const element = viewport.current;
    const currentHistoryEntries = historyEntriesRef.current;
    if (!element || currentHistoryEntries.length === 0) return;
    // At the live edge, the newest message is the active history boundary
    // even when compact or collapsed activity makes an earlier user row sit
    // closer to the viewport's reading line. This also keeps the mobile
    // thumbstick anchored to its newest tick across responsive reflow.
    if (measureLiveEdge()) {
      const latestId = currentHistoryEntries.at(-1)!.itemId;
      setActiveHistoryItemId((current) =>
        current === latestId ? current : latestId,
      );
      return latestId;
    }
    const viewportRect = element.getBoundingClientRect();
    const readingLine = viewportRect.top + element.clientHeight * 0.34;
    let nearestId = currentHistoryEntries[0]!.itemId;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const targets = element.querySelectorAll<HTMLElement>(
      '[data-item-kind="user_message"]',
    );
    for (const target of targets) {
      const itemId = target.dataset.itemId;
      if (!itemId || !historyEntryIdsRef.current.has(itemId)) continue;
      const distance = Math.abs(
        target.getBoundingClientRect().top - readingLine,
      );
      if (distance >= nearestDistance) continue;
      nearestId = itemId;
      nearestDistance = distance;
    }
    setActiveHistoryItemId((current) =>
      current === nearestId ? current : nearestId,
    );
    return nearestId;
  };

  const cancelSeekScroll = (reason = "cancelled") => {
    const active = seekScroll.current;
    if (!active) return;
    seekScroll.current = undefined;
    active.cleanup();
    // A new instant scroll aborts the browser's ongoing smooth scroll.
    active.element.scrollTo({
      top: active.element.scrollTop,
      behavior: "instant",
    });
    traceSeek("seek_animation_cancelled", { reason });
    if (reason !== "replaced" && reason !== "transcript_unmounted")
      return syncHistoryRailActive();
  };

  const cancelLiveEdgeFollow = () => {
    if (liveEdgeFollowFrame.current !== undefined) {
      cancelAnimationFrame(liveEdgeFollowFrame.current);
      liveEdgeFollowFrame.current = undefined;
    }
    liveEdgeFollowLastTime.current = undefined;
    liveEdgeFollowOwned.current = false;
  };

  const canFollowLiveEdge = (element: HTMLElement): boolean =>
    viewport.current === element &&
    smoothStreamingRef.current &&
    chatViewVisibleRef.current &&
    focusTurnIdRef.current === undefined &&
    wasAtLiveEdge.current &&
    seekPin.current === undefined &&
    seekScroll.current === undefined &&
    seekBeginFrame.current === undefined &&
    deferredFollowFrames.current.size === 0 &&
    !selectionDragActive.current;

  const startLiveEdgeFollow = () => {
    const element = viewport.current;
    if (!element || !canFollowLiveEdge(element)) return;
    if (liveEdgeFollowOwned.current) return;
    const initialTarget = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
    if (Math.abs(initialTarget - element.scrollTop) <= 0.5) {
      element.scrollTop = initialTarget;
      return;
    }

    liveEdgeFollowOwned.current = true;
    liveEdgeFollowLastTime.current = undefined;
    const step = (now: number) => {
      liveEdgeFollowFrame.current = undefined;
      if (!canFollowLiveEdge(element)) {
        cancelLiveEdgeFollow();
        return;
      }
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = target - element.scrollTop;
      if (Math.abs(distance) <= 0.5) {
        element.scrollTop = target;
        liveEdgeFollowLastTime.current = undefined;
        liveEdgeFollowOwned.current = false;
        return;
      }
      const previous = liveEdgeFollowLastTime.current;
      liveEdgeFollowLastTime.current = now;
      if (previous !== undefined) {
        const elapsed = Math.min(64, Math.max(0, now - previous));
        const alpha = 1 - Math.exp(-elapsed / 120);
        element.scrollTop += distance * alpha;
      }
      liveEdgeFollowFrame.current = requestAnimationFrame(step);
    };
    liveEdgeFollowFrame.current = requestAnimationFrame(step);
  };

  /**
   * Reserve space first, then let the browser animate scrolling independently
   * of React updates on the main thread. Ownership suppresses live following
   * and intermediate history scans until scrollend or reader interruption.
   * `onSettled` fires when the target is reached (immediately for zero
   * distance or reduced motion) — never when the animation is cancelled.
   */
  const animateSeekScroll = (
    element: HTMLElement,
    to: number,
    onSettled?: () => void,
  ) => {
    cancelLiveEdgeFollow();
    cancelSeekScroll("replaced");
    const target = Math.max(
      0,
      Math.min(to, element.scrollHeight - element.clientHeight),
    );
    const from = element.scrollTop;
    const distance = target - from;
    // Clamped/no-op scrolls do not emit scrollend. Allow pixel rounding too.
    if (Math.abs(distance) <= 1) {
      traceSeek("seek_animation_settled", { mode: "already_at_target" });
      syncHistoryRailActive();
      onSettled?.();
      return;
    }
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reducedMotion) {
      element.scrollTo({ top: target, behavior: "instant" });
      traceSeek("seek_animation_settled", { mode: "reduced_motion" });
      syncHistoryRailActive();
      onSettled?.();
      return;
    }
    traceSeek("seek_animation_started", {
      from,
      to: target,
      distance,
      mode: "native",
    });
    const settleIfAtDestination = () => {
      if (seekScroll.current !== active) return;
      // A replaced scroll can have an already-queued scrollend. Only the
      // current destination (including a resized scroll range) may settle us.
      const destination = Math.max(
        0,
        Math.min(target, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - destination) > 1) return;
      seekScroll.current = undefined;
      active.cleanup();
      traceSeek("seek_animation_settled", { mode: "native" });
      syncHistoryRailActive();
      onSettled?.();
    };
    const onScrollEnd = (event: Event) => {
      if (event.target === element) settleIfAtDestination();
    };
    let completionCheck: number;
    const active = {
      element,
      cleanup: () => {
        element.removeEventListener("scrollend", onScrollEnd);
        window.clearInterval(completionCheck);
      },
    };
    seekScroll.current = active;
    element.addEventListener("scrollend", onScrollEnd);
    // Some browsers can finish scrolling without delivering scrollend. This
    // low-frequency check only releases ownership/focus after arrival; it
    // never drives motion or scans history while the browser is still moving.
    completionCheck = window.setInterval(
      settleIfAtDestination,
      seekCompletionCheckMilliseconds,
    );
    element.scrollTo({ top: target, behavior: "smooth" });
  };

  const releaseSeekPin = (reason: string) => {
    // Source-turn navigation owns an animation without reserving space.
    cancelSeekScroll(reason);
    if (!seekPin.current) return;
    traceSeek("seek_pin_releasing", { reason });
    seekPin.current = undefined;
    setSeekPinHeld(false);
    setSeekSpacerHeight(0);
    traceSeek("seek_pin_released", { reason });
  };

  const scrollToHistoryItem = (
    itemId: string,
    requestedBehavior?: ScrollBehavior,
  ) => {
    const element = viewport.current;
    if (!element) return;
    const target = element.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(itemId)}"]`,
    );
    if (!target) return;
    setLocallySelectedTurnId(undefined);
    viewportResizeFollowIntent.current = false;
    cancelLiveEdgeFollow();
    releaseSeekPin("history_rail_navigation");
    const viewportRect = element.getBoundingClientRect();
    const targetTop =
      element.scrollTop + target.getBoundingClientRect().top - viewportRect.top;
    const destination = Math.max(0, targetTop - seekTopOffset);
    element.scrollTo({
      top: destination,
      behavior: navigationScrollBehavior(element, destination, requestedBehavior),
    });
    setActiveHistoryItemId(itemId);
    wasAtLiveEdge.current = false;
    setAtLiveEdge(false);
  };

  const seekAdjacentHistoryItem = (direction: "previous" | "next") => {
    const element = viewport.current;
    if (!element) return;
    const readingLine = element.getBoundingClientRect().top + seekTopOffset;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    let nearestItemId: string | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const target of element.querySelectorAll<HTMLElement>(
      '[data-item-kind="user_message"]',
    )) {
      const itemId = target.dataset.itemId;
      if (!itemId || !historyEntryIdsRef.current.has(itemId)) continue;
      const destination = Math.min(
        maximum,
        Math.max(
          0,
          element.scrollTop + target.getBoundingClientRect().top - readingLine,
        ),
      );
      const distance =
        (destination - element.scrollTop) *
        (direction === "previous" ? -1 : 1);
      // Treat subpixel alignment as already reached, including rows whose
      // requested position is clamped at either end of the transcript.
      if (distance <= 1 || distance >= nearestDistance) continue;
      nearestItemId = itemId;
      nearestDistance = distance;
    }
    if (nearestItemId) {
      // Complete each keyboard hop immediately so repeats and reversals use
      // the new viewport position rather than an in-flight smooth scroll.
      scrollToHistoryItem(nearestItemId, "auto");
    }
  };

  const seekLoadedTurn = (turnId: string): boolean => {
    const element = viewport.current;
    const target = element?.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(turnId)}"]`,
    );
    if (!element || !target) return false;
    viewportResizeFollowIntent.current = false;
    cancelLiveEdgeFollow();
    releaseSeekPin("bookmark_navigation");
    const viewportRect = element.getBoundingClientRect();
    const targetTop =
      element.scrollTop + target.getBoundingClientRect().top - viewportRect.top;
    const destination = Math.max(0, targetTop - seekTopOffset);
    element.scrollTo({
      top: destination,
      behavior: navigationScrollBehavior(element, destination),
    });
    setLocallySelectedTurnId(turnId);
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    wasAtLiveEdge.current = false;
    setAtLiveEdge(false);
    return true;
  };

  useImperativeHandle(
    ref,
    () => ({
      beginHistoryScrub: () => {
        return yieldSeekToReader("history_scrub") ?? syncHistoryRailActive();
      },
      seekHistoryItem: scrollToHistoryItem,
      seekAdjacentHistoryItem,
      seekTurn: seekLoadedTurn,
    }),
    [scrollToHistoryItem, seekAdjacentHistoryItem, seekLoadedTurn],
  );

  useEffect(() => {
    if (focusTurnId) setLocallySelectedTurnId(undefined);
  }, [focusTurnId, store]);

  useEffect(() => {
    if (!locallySelectedTurnId) return;
    const dismissOutsideTurn = (event: PointerEvent) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Element)) return;
      const containingTurn = eventTarget.closest<HTMLElement>("[data-turn-id]");
      if (containingTurn?.dataset.turnId !== locallySelectedTurnId) {
        setLocallySelectedTurnId(undefined);
      }
    };
    document.addEventListener("pointerdown", dismissOutsideTurn, true);
    return () =>
      document.removeEventListener("pointerdown", dismissOutsideTurn, true);
  }, [locallySelectedTurnId]);

  useEffect(() => {
    onHistoryPresentationChange?.({
      entries: historyEntries,
      ...(activeHistoryItemId ? { activeItemId: activeHistoryItemId } : {}),
    });
  }, [activeHistoryItemId, historyEntries, onHistoryPresentationChange]);

  useEffect(
    () => () => onHistoryPresentationChange?.({ entries: [] }),
    [onHistoryPresentationChange],
  );

  const naturalBottomSide = (element: HTMLElement): -1 | 0 | 1 => {
    const distance =
      element.scrollHeight -
      measureSeekSpacerHeight() -
      element.scrollTop -
      element.clientHeight;
    return distance > 1 ? 1 : distance < -1 ? -1 : 0;
  };

  // A text selection owns the viewport only while the reader is actively
  // dragging it out (pointer still down). Selections persist after the
  // gesture, so a plain "selection exists" check would keep suppressing
  // scroll intent afterwards — with follow engaged, every streamed resize
  // would snap the viewport back to the bottom with no way to scroll out.
  useEffect(() => {
    const pointerDown = () => {
      selectionPointerDown.current = true;
      selectionDragActive.current = false;
    };
    const dragEnded = () => {
      selectionPointerDown.current = false;
      if (!selectionDragActive.current) return;
      selectionDragActive.current = false;
      // The browser's edge autoscroll may have moved the viewport while
      // onScroll was suppressed; re-measure so follow acts on the real
      // position instead of a stale live-edge flag.
      const live = measureLiveEdge();
      wasAtLiveEdge.current = live;
      setAtLiveEdge(live);
    };
    const selectionChanged = () => {
      if (!selectionPointerDown.current) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) {
        selectionDragActive.current = true;
        cancelLiveEdgeFollow();
      }
    };
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", dragEnded, true);
    window.addEventListener("pointercancel", dragEnded, true);
    // A native context menu (right-click word select) or a focus loss can
    // swallow the matching pointerup; without these resets the drag flag
    // would suppress scroll handling until the next in-page pointerdown.
    window.addEventListener("contextmenu", dragEnded, true);
    window.addEventListener("blur", dragEnded);
    document.addEventListener("selectionchange", selectionChanged);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", dragEnded, true);
      window.removeEventListener("pointercancel", dragEnded, true);
      window.removeEventListener("contextmenu", dragEnded, true);
      window.removeEventListener("blur", dragEnded);
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, []);

  const hasActiveTextSelection = () => selectionDragActive.current;

  /** Reader input cancels the owned animation but keeps the reservation. */
  const yieldSeekToReader = (reason: string) => {
    if (seekBeginFrame.current !== undefined) {
      cancelAnimationFrame(seekBeginFrame.current);
      seekBeginFrame.current = undefined;
    }
    viewportResizeFollowIntent.current = false;
    if (viewportResizeActive.current) {
      viewportResizeReaderOwned.current = true;
      wasAtLiveEdge.current = false;
      setAtLiveEdge(false);
    }
    const followerWasActive = liveEdgeFollowOwned.current;
    cancelLiveEdgeFollow();
    if (hasActiveTextSelection()) return;
    const historyItemId = cancelSeekScroll(reason);
    const element = viewport.current;
    const pin = seekPin.current;
    if (!element) return historyItemId;
    if (!pin) {
      if (followerWasActive) {
        wasAtLiveEdge.current = false;
        setAtLiveEdge(false);
      }
      return historyItemId;
    }
    if (!pin.readerScrolled) {
      pin.readerScrolled = true;
      pin.readerBottomSide = naturalBottomSide(element);
    }
    traceSeek("reader_took_scroll_control", { reason });
    setSeekPinHeld(false);
    wasAtLiveEdge.current = false;
    setAtLiveEdge(false);
    return historyItemId;
  };

  /**
   * Once the reader has taken over, retain the spacer until their scroll
   * reaches (or crosses) the natural content bottom. At that point the last
   * message meets the composer edge, so removing the reservation cannot hide
   * unread content or yank the reader away from their chosen position.
   */
  const releaseSeekAtNaturalBottom = (): boolean => {
    const element = viewport.current;
    const pin = seekPin.current;
    if (!element || !pin?.readerScrolled) return false;
    const side = naturalBottomSide(element);
    if (
      pin.readerBottomSide !== 0 &&
      side !== 0 &&
      side === pin.readerBottomSide
    ) {
      return false;
    }
    releaseSeekPin("natural_bottom_reached");
    wasAtLiveEdge.current = true;
    setAtLiveEdge(true);
    return true;
  };

  /**
   * Keeps the seek reservation exactly large enough that the pinned message
   * can sit at the viewport top: as the streaming reply grows, the spacer
   * shrinks by the same amount (total scroll height stays put, so the reader
   * sees the reply fill the blank space without any scrollbar churn). Once an
   * untouched reply consumes the reservation, hand ownership back to the live
   * edge so later growth follows normally. A reader who already scrolled keeps
   * control and retains the existing natural-bottom release lifecycle.
   */
  const syncSeekSpacer = () => {
    const element = viewport.current;
    const pin = seekPin.current;
    if (!element || !pin) return;
    const target = findSeekTarget(element, pin);
    if (!target) {
      releaseSeekPin("pinned_item_missing");
      return;
    }
    traceSeek("content_resize_observed");
    const spacerHeight = measureSeekSpacerHeight();
    const contentHeight = element.scrollHeight - spacerHeight;
    const top = Math.max(0, target.offsetTop - seekTopOffset);
    const needed = Math.max(0, top + element.clientHeight - contentHeight);
    if (needed !== spacerHeight) setSeekSpacerHeight(needed);
    traceSeek("seek_spacer_synchronized", { neededSpacerHeight: needed });
    if (needed === 0 && !pin.readerScrolled) {
      releaseSeekPin("reservation_consumed");
      wasAtLiveEdge.current = true;
      setAtLiveEdge(true);
      if (smoothStreamingRef.current) {
        startLiveEdgeFollow();
      } else {
        scrollToLatest("auto", "seek_reservation_consumed");
      }
      return;
    }
    // Streaming growth can move the natural-bottom boundary across the
    // stationary viewport. That is not reader progress, so reset the side
    // from which their next actual scroll must reach the boundary.
    if (pin.readerScrolled) {
      pin.readerBottomSide = naturalBottomSide(element);
    }
  };

  /**
   * A docked mobile keyboard animates the transcript through many small
   * height changes. Coalesce them to one reconciliation per paint so the
   * keyboard animation cannot repeatedly restart the streaming follower.
   */
  const scheduleViewportResizeReconciliation = (): boolean => {
    const element = viewport.current;
    if (!element) return false;
    const nextHeight = element.clientHeight;
    const previous = observedViewportHeight.current;
    observedViewportHeight.current = nextHeight;
    if (previous === undefined || Math.abs(nextHeight - previous) < 0.5) {
      return false;
    }
    viewportResizeActive.current = true;
    if (viewportResizeSettleFrame.current !== undefined) {
      cancelAnimationFrame(viewportResizeSettleFrame.current);
      viewportResizeSettleFrame.current = undefined;
    }
    if (
      !viewportResizeReaderOwned.current &&
      !seekPin.current &&
      wasAtLiveEdge.current
    ) {
      viewportResizeFollowIntent.current = true;
    }
    if (viewportResizeFrame.current === undefined) {
      viewportResizeFrame.current = requestAnimationFrame(() => {
        viewportResizeFrame.current = undefined;
        const activeViewport = viewport.current;
        if (!activeViewport) return;
        observedViewportHeight.current = activeViewport.clientHeight;
        const activeContent = content.current;
        if (activeContent) {
          const nextContentWidth = activeContent.getBoundingClientRect().width;
          const previousContentWidth = observedContentWidth.current;
          observedContentWidth.current = nextContentWidth;
          if (
            previousContentWidth !== undefined &&
            Math.abs(nextContentWidth - previousContentWidth) >= 0.5 &&
            !viewportResizeReaderOwned.current &&
            !seekPin.current &&
            wasAtLiveEdge.current
          ) {
            viewportResizeFollowIntent.current = true;
          }
        }
        if (seekPin.current) {
          syncSeekSpacer();
        } else if (
          !viewportResizeReaderOwned.current &&
          viewportResizeFollowIntent.current &&
          !hasActiveTextSelection()
        ) {
          cancelLiveEdgeFollow();
          activeViewport.scrollTop = Math.max(
            0,
            activeViewport.scrollHeight - activeViewport.clientHeight,
          );
          wasAtLiveEdge.current = true;
          setAtLiveEdge(true);
        }
        viewportResizeFollowIntent.current = false;
        syncHistoryRailActive();
        previousHeight.current = activeViewport.scrollHeight;
        viewportResizeSettleFrame.current = requestAnimationFrame(() => {
          viewportResizeSettleFrame.current = undefined;
          viewportResizeActive.current = false;
          viewportResizeReaderOwned.current = false;
        });
      });
    }
    return true;
  };

  const scrollToLatest = (
    requestedBehavior?: ScrollBehavior,
    reason = "jump_button",
  ) => {
    const element = viewport.current;
    if (!element) return;
    cancelLiveEdgeFollow();
    traceSeek("scroll_to_latest_requested", {
      reason,
      targetScrollTop: element.scrollHeight,
    });
    // Re-engaging the live edge dissolves any seek-on-submit reservation.
    releaseSeekPin(`scroll_to_latest:${reason}`);
    const naturalMaximum = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
    const behavior = navigationScrollBehavior(
      element,
      naturalMaximum,
      requestedBehavior,
    );
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
    traceSeek("scroll_to_latest_applied", {
      behavior,
      reason,
      targetScrollTop: element.scrollHeight,
    });
    wasAtLiveEdge.current = true;
    setAtLiveEdge(true);
  };

  // Revealing the chat view (switching back from the managed TUI) always
  // snaps to the live edge: sends made while the terminal view was active
  // move scroll state inside the hidden panel, so position from before the
  // switch is stale. Re-engaging also dissolves any pending seek pin.
  const wasChatViewVisible = useRef(chatViewVisible);
  useLayoutEffect(() => {
    const was = wasChatViewVisible.current;
    wasChatViewVisible.current = chatViewVisible;
    if (!chatViewVisible) {
      cancelLiveEdgeFollow();
      cancelSeekScroll("chat_view_hidden");
      return;
    }
    if (was) return;
    scrollToLatest("auto", "chat_view_revealed");
  }, [chatViewVisible]);

  useLayoutEffect(() => {
    if (!smoothStreaming) {
      const followerWasActive = liveEdgeFollowOwned.current;
      cancelLiveEdgeFollow();
      if (followerWasActive && chatViewVisible && focusTurnId === undefined) {
        scrollToLatest("auto", "smooth_streaming_disabled");
      }
      return;
    }
    if (focusTurnId !== undefined) {
      cancelLiveEdgeFollow();
    }
  }, [chatViewVisible, focusTurnId, smoothStreaming]);

  const scheduleScrollToLatest = (behavior: ScrollBehavior, reason: string) => {
    cancelLiveEdgeFollow();
    const scheduledViewport = viewport.current;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      deferredFollowFrames.current.delete(frame);
      if (viewport.current !== scheduledViewport) return;
      scrollToLatest(behavior, reason);
    });
    deferredFollowFrames.current.add(frame);
  };

  /**
   * Seek-on-submit: pin the just-sent message to the viewport top, reserving
   * blank space below for the reply. Reuses the reader-intent machinery —
   * the pin marks the reader as "away from the live edge", so the existing
   * follow-to-bottom stays suppressed until they re-engage it.
   */
  const beginSeek = (targetIdentity: {
    readonly itemId: string;
    readonly operationId: string;
  }) => {
    const element = viewport.current;
    if (!element) return;
    cancelLiveEdgeFollow();
    traceSeek("seek_requested");
    for (const frame of deferredFollowFrames.current) {
      cancelAnimationFrame(frame);
    }
    deferredFollowFrames.current.clear();
    if (seekBeginFrame.current !== undefined) {
      cancelAnimationFrame(seekBeginFrame.current);
    }
    seekBeginFrame.current = requestAnimationFrame(() => {
      seekBeginFrame.current = undefined;
      if (viewport.current !== element) return;
      const target = findSeekTarget(element, targetIdentity);
      if (!target) {
        traceSeek("seek_target_missing");
        return;
      }
      releaseSeekPin("next_seek");
      const top = Math.max(0, target.offsetTop - seekTopOffset);
      seekPin.current = { ...targetIdentity, readerScrolled: false };
      setSeekPinHeld(true);
      const contentHeight = element.scrollHeight - measureSeekSpacerHeight();
      setSeekSpacerHeight(
        Math.max(0, top + element.clientHeight - contentHeight),
      );
      traceSeek("seek_pin_engaged", { seekTop: top, contentHeight });
      animateSeekScroll(element, top);
      wasAtLiveEdge.current = false;
      setAtLiveEdge(false);
    });
  };

  /**
   * Consumes the pending seek request only when its exact operation appears
   * as either the optimistic row or authoritative user item. Requests expire
   * rather than ever seeking to an unrelated message.
   */
  const takeSeekTarget = ():
    { readonly itemId: string; readonly operationId: string } | undefined => {
    const request = seekRequest?.current;
    if (!request || !seekRequest) return undefined;
    if (Date.now() - request.requestedAt > seekRequestTtlMilliseconds) {
      traceSeek("seek_request_expired");
      seekRequest.current = null;
      return undefined;
    }
    const authoritativeItem = itemIds
      .map((itemId) => snapshot?.itemsById[itemId])
      .find(
        (item): item is UserMessageItem =>
          item?.kind === "user_message" &&
          item.deliveryOperationId === request.operationId,
      );
    const optimisticTransfer = optimisticTransfers.find(
      (transfer) => transfer.operationId === request.operationId,
    );
    const itemId =
      authoritativeItem?.id ??
      (optimisticTransfer
        ? provisionalItemId(optimisticTransfer.operationId)
        : undefined);
    if (!itemId) return undefined;
    seekRequest.current = null;
    traceSeek("seek_request_consumed");
    return { itemId, operationId: request.operationId };
  };

  useLayoutEffect(
    () =>
      store.subscribeActivityDetailWillChange((nextActivityDetail) => {
        const element = viewport.current;
        if (!element) return;
        if (wasAtLiveEdge.current) {
          store.rememberProjectionViewportAnchor({
            kind: "live",
            activityDetail: nextActivityDetail,
          });
          return;
        }
        const viewportTop = element.getBoundingClientRect().top;
        const attributes = [
          "data-activity-first-item-id",
          "data-item-id",
          "data-turn-id",
        ] as const;
        let nearest:
          | {
              readonly attribute: (typeof attributes)[number];
              readonly id: string;
              readonly viewportOffset: number;
              readonly distance: number;
            }
          | undefined;
        for (const attribute of attributes) {
          for (const candidate of element.querySelectorAll<HTMLElement>(
            `[${attribute}]`,
          )) {
            if (
              attribute !== "data-activity-first-item-id" &&
              candidate.closest("[data-activity-first-item-id]")
            ) {
              // Expanded activity children disappear when the new projection
              // mounts collapsed. Only the group's outer disclosure is a
              // stable anchor across that replacement.
              continue;
            }
            const id = candidate.getAttribute(attribute);
            if (!id) continue;
            const measuredOffset =
              candidate.getBoundingClientRect().top - viewportTop;
            const viewportOffset =
              attribute === "data-activity-first-item-id" &&
              measuredOffset < 0 &&
              candidate.querySelector('[aria-expanded="true"]')
                ? 0
                : measuredOffset;
            const distance = Math.abs(viewportOffset);
            if (!nearest || distance < nearest.distance) {
              nearest = { attribute, id, viewportOffset, distance };
            }
          }
        }
        if (nearest) {
          const anchor: ThreadProjectionViewportAnchor = {
            kind: "element",
            activityDetail: nextActivityDetail,
            attribute: nearest.attribute,
            id: nearest.id,
            viewportOffset: nearest.viewportOffset,
          };
          store.rememberProjectionViewportAnchor(anchor);
        }
      }),
    [store],
  );

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !snapshot) return;
    const anchor = store.takeProjectionViewportAnchor(activityDetail);
    if (!anchor) return;
    if (anchor.kind === "live") {
      // A replacement projection remounts Transcript through ThreadLoading.
      // A successfully resolved anchor owns that opening and suppresses the
      // ordinary first-open jump that would overwrite the restoration.
      opened.current = true;
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight,
      );
      wasAtLiveEdge.current = true;
      setAtLiveEdge(true);
      return;
    }
    const target = element.querySelector<HTMLElement>(
      `[${anchor.attribute}="${CSS.escape(anchor.id)}"]`,
    );
    // Older prepended history may not be present in the replacement window.
    // Leave this as a first open so the ordinary latest-position fallback
    // runs instead of stranding the remounted viewport at the top.
    if (!target) return;
    opened.current = true;
    const viewportTop = element.getBoundingClientRect().top;
    const nextOffset = target.getBoundingClientRect().top - viewportTop;
    element.scrollTop += nextOffset - anchor.viewportOffset;
    wasAtLiveEdge.current = false;
    setAtLiveEdge(false);
    previousHeight.current = element.scrollHeight;
  }, [activityDetail, snapshot, store]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (
      !element ||
      opened.current ||
      presentationItemIds.length === 0 ||
      (focusTurnId !== undefined && !viewTurnsById?.[focusTurnId])
    )
      return;
    opened.current = true;
    requestAnimationFrame(() => {
      // A seek pin from the thread's very first send takes precedence over
      // the default open-at-latest-anchor positioning.
      if (seekPin.current) {
        wasAtLiveEdge.current = false;
        setAtLiveEdge(false);
        return;
      }
      // Open at the bottom so a reloaded thread lands on the live edge and
      // follow stays engaged for running threads.
      element.scrollTop = element.scrollHeight;
      const live = measureLiveEdge();
      wasAtLiveEdge.current = live;
      setAtLiveEdge(live);
    });
  }, [focusTurnId, presentationItemIds.length, viewTurnsById]);

  useLayoutEffect(() => {
    if (historyEntries.length === 0) {
      setActiveHistoryItemId(undefined);
      return;
    }
    setActiveHistoryItemId((current) =>
      current && historyEntries.some((entry) => entry.itemId === current)
        ? current
        : historyEntries.at(-1)?.itemId,
    );
  }, [historyEntryKey]);

  useEffect(() => {
    focusAttemptTarget.current = undefined;
    handledFocusTarget.current = undefined;
    setFocusPage(undefined);
    setFocusDiagnostic(undefined);
    setFocusRetryable(false);
    setFocusStatus(focusTurnId ? "loading" : "idle");
  }, [activityDetail, focusTurnId, store]);

  useEffect(() => {
    if (!focusTurnId || !snapshot) {
      setFocusStatus("idle");
      return;
    }
    const targetTurn = viewTurnsById?.[focusTurnId];
    if (targetTurn) {
      setFocusStatus("found");
      const handlingKey = `${activityDetail}:${focusTurnId}:${focusRetryNonce}`;
      if (handledFocusTarget.current === handlingKey) return;
      const frame = requestAnimationFrame(() => {
        const element = viewport.current;
        const target = element?.querySelector<HTMLElement>(
          `[data-turn-id="${CSS.escape(focusTurnId)}"]`,
        );
        if (!element || !target) return;
        handledFocusTarget.current = handlingKey;
        releaseSeekPin("source_turn_focus");
        const top = Math.max(0, target.offsetTop - 24);
        animateSeekScroll(element, top, () =>
          target.focus({ preventScroll: true }),
        );
        wasAtLiveEdge.current = false;
        setAtLiveEdge(false);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (connection !== "connected" || !authoritative) {
      setFocusStatus("loading");
      return;
    }
    const attemptKey = `${activityDetail}:${focusTurnId}:${focusRetryNonce}`;
    if (focusAttemptTarget.current === attemptKey) return;
    focusAttemptTarget.current = attemptKey;
    setFocusStatus("loading");
    void store.seekHistoryTurn(focusTurnId).then(
      (result) => {
        if (focusAttemptTarget.current !== attemptKey) return;
        if (result.status === "found") {
          setFocusPage({
            targetTurnId: focusTurnId,
            activityDetail,
            page: result.page,
          });
        } else if (result.status === "not_found") {
          setFocusStatus("not_found");
        } else {
          setFocusDiagnostic(result.reason.text);
          setFocusRetryable(result.retryable);
          setFocusStatus("unavailable");
        }
      },
      () => {
        if (focusAttemptTarget.current === attemptKey) {
          setFocusStatus("error");
        }
      },
    );
  }, [
    activityDetail,
    authoritative,
    connection,
    focusRetryNonce,
    focusTurnId,
    snapshot,
    store,
    viewTurnsById,
  ]);

  useLayoutEffect(() => {
    // TEMPORARY DIAGNOSTIC (localStorage sedes.debug.client=1): per-delta
    // layout cost on large transcripts.
    const layoutStart =
      typeof localStorage !== "undefined" &&
      localStorage.getItem("sedes.debug.client") === "1"
        ? performance.now()
        : 0;
    const element = viewport.current;
    if (
      !element ||
      (previousIds.current.length === 0 && previousTurnIds.current.length === 0)
    ) {
      previousIds.current = presentationItemIds;
      previousTurnIds.current = turnIds;
      if (element) {
        previousHeight.current = element.scrollHeight;
        // A brand-new thread fills 0 → N when its first send lands, which
        // bypasses the append detection below — but that send may have armed
        // a seek request, and it should pin like any other send.
        const seekTarget = takeSeekTarget();
        if (seekTarget) beginSeek(seekTarget);
      }
      return;
    }
    const prior = previousIds.current;
    const priorTurns = previousTurnIds.current;
    const itemOrderUnchanged =
      presentationItemIds.length === prior.length &&
      prior.every((id, index) => presentationItemIds[index] === id);
    const turnOrderUnchanged =
      turnIds.length === priorTurns.length &&
      priorTurns.every((id, index) => turnIds[index] === id);
    const appended =
      presentationItemIds.length > prior.length &&
      prior.every((id, index) => presentationItemIds[index] === id);
    const appendedUserItemId = appended
      ? presentationItemIds
          .slice(prior.length)
          .find((id) =>
            id.startsWith("client-delivery:")
              ? true
              : snapshot?.itemsById[id]?.kind === "user_message",
          )
      : undefined;
    const prepended =
      presentationItemIds.length > prior.length &&
      prior.every(
        (id, index) =>
          presentationItemIds[
            presentationItemIds.length - prior.length + index
          ] === id,
      );
    const turnsPrepended =
      turnIds.length > priorTurns.length &&
      priorTurns.every(
        (id, index) =>
          turnIds[turnIds.length - priorTurns.length + index] === id,
      );
    previousIds.current = presentationItemIds;
    previousTurnIds.current = turnIds;
    if (
      itemOrderUnchanged &&
      turnOrderUnchanged &&
      prependAnchor.current === undefined
    ) {
      // Streaming revisions replace item content without changing transcript
      // topology. ResizeObserver owns content-growth following and refreshes
      // previousHeight, so synchronously reading scrollHeight here would force
      // layout on every flushed delta. A send can become seekable on one of
      // these revision ticks, so preserve that check before returning.
      const seekTarget = takeSeekTarget();
      if (seekTarget) beginSeek(seekTarget);
      return;
    }
    let restoredExplicitAnchor = false;
    if (turnsPrepended && prependAnchor.current) {
      const anchor = [
        ...element.querySelectorAll<HTMLElement>("[data-turn-id]"),
      ].find(
        (candidate) =>
          candidate.dataset.turnId === prependAnchor.current?.turnId,
      );
      if (anchor) {
        element.scrollTop += anchor.offsetTop - prependAnchor.current.offsetTop;
        restoredExplicitAnchor = true;
      }
      prependAnchor.current = undefined;
    }
    if (prepended && !restoredExplicitAnchor && !wasAtLiveEdge.current) {
      element.scrollTop += Math.max(
        0,
        element.scrollHeight - previousHeight.current,
      );
    } else {
      // Appended batches AND same-length revision batches both check for a
      // pending seek: the send's user message can become resolvable on a
      // revision tick after its append tick (see takeSeekTarget).
      const seekTarget = takeSeekTarget();
      if (seekTarget) beginSeek(seekTarget);
      else if (appendedUserItemId && seekPin.current) {
        const readerScrolled = seekPin.current.readerScrolled;
        releaseSeekPin("non_armed_next_send");
        if (!readerScrolled) {
          scheduleScrollToLatest("auto", "non_armed_next_send");
        }
      } else if (
        appended &&
        wasAtLiveEdge.current &&
        !hasActiveTextSelection()
      ) {
        scheduleScrollToLatest("auto", "appended_live_edge_follow");
      }
    }
    previousHeight.current = element.scrollHeight;
    if (layoutStart) {
      const ms = performance.now() - layoutStart;
      if (ms > 8) {
        console.warn(
          `[client-delta] transcript layout ms=${ms.toFixed(1)} items=${itemIds.length}`,
        );
      }
    }
  }, [presentationItemIds, turnIds]);

  useEffect(() => {
    const contentElement = content.current;
    const viewportElement = viewport.current;
    if (!contentElement || !viewportElement) return;
    observedViewportHeight.current = viewportElement.clientHeight;
    const viewportObserver = new ResizeObserver(() => {
      scheduleViewportResizeReconciliation();
    });
    viewportObserver.observe(viewportElement);
    observedContentWidth.current = contentElement.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const nextContentWidth =
        entries?.[0]?.contentRect.width ?? contentElement.clientWidth;
      const previousContentWidth = observedContentWidth.current;
      const widthChanged =
        previousContentWidth !== undefined &&
        Math.abs(nextContentWidth - previousContentWidth) >= 0.5;
      const viewportResizePending = viewportResizeFrame.current !== undefined;
      const action = viewportResizePending
        ? "hold_viewport_resize"
        : seekPin.current
          ? "sync_seek_spacer"
          : hasActiveTextSelection()
            ? "hold_selection_drag"
            : widthChanged && wasAtLiveEdge.current
              ? "snap_width_reflow_live_edge"
              : wasAtLiveEdge.current
                ? "follow_live_edge"
                : "hold_reader_position";
      traceSeek("viewport_resize_observer", { action });
      if (viewportResizePending) {
        previousHeight.current = viewportElement.scrollHeight;
        return;
      }
      observedContentWidth.current = nextContentWidth;
      if (seekPin.current) syncSeekSpacer();
      else if (wasAtLiveEdge.current && !hasActiveTextSelection()) {
        // Divider drags repeatedly rewrap every message. Chasing that moving
        // target with the streaming easing loop makes the transcript and
        // focused composer appear to oscillate. Width reflow preserves the
        // live edge synchronously; same-width content growth keeps easing.
        if (widthChanged)
          scrollToLatest("auto", "content_width_reflow_live_edge_follow");
        else if (smoothStreamingRef.current) startLiveEdgeFollow();
        else scrollToLatest("auto", "content_resize_live_edge_follow");
      }
      previousHeight.current = viewportElement.scrollHeight;
    });
    observer.observe(contentElement);
    previousHeight.current = viewportElement.scrollHeight;
    return () => {
      viewportObserver.disconnect();
      observer.disconnect();
      if (viewportResizeFrame.current !== undefined) {
        cancelAnimationFrame(viewportResizeFrame.current);
        viewportResizeFrame.current = undefined;
      }
      observedViewportHeight.current = undefined;
      observedContentWidth.current = undefined;
      viewportResizeFollowIntent.current = false;
      viewportResizeActive.current = false;
      viewportResizeReaderOwned.current = false;
      if (viewportResizeSettleFrame.current !== undefined) {
        cancelAnimationFrame(viewportResizeSettleFrame.current);
        viewportResizeSettleFrame.current = undefined;
      }
      if (seekBeginFrame.current !== undefined) {
        cancelAnimationFrame(seekBeginFrame.current);
        seekBeginFrame.current = undefined;
      }
      for (const frame of deferredFollowFrames.current) {
        cancelAnimationFrame(frame);
      }
      deferredFollowFrames.current.clear();
      cancelLiveEdgeFollow();
      cancelSeekScroll("transcript_unmounted");
    };
  }, [hasItems]);

  const loadHistory = (intent: "more" | "all") => {
    cancelLiveEdgeFollow();
    const element = viewport.current;
    const firstTurnId = turnIds[0];
    const anchor =
      element && firstTurnId
        ? [...element.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
            (candidate) => candidate.dataset.turnId === firstTurnId,
          )
        : undefined;
    if (anchor && firstTurnId) {
      prependAnchor.current = {
        turnId: firstTurnId,
        offsetTop: anchor.offsetTop,
      };
    }
    wasAtLiveEdge.current = false;
    setAtLiveEdge(false);
    setHistoryLoadIntent(intent);
    const operation =
      intent === "all" ? store.loadAllOlderHistory() : store.loadOlderHistory();
    void operation
      .catch(() => {
        prependAnchor.current = undefined;
      })
      .finally(() => setHistoryLoadIntent(undefined));
  };

  if (!snapshot || !hasItems) {
    const starting =
      snapshot?.thread.backingState === "creating" || runState === "starting";
    const creationUnknown =
      snapshot?.thread.backingState === "creation_unknown";
    return (
      <div className="empty-transcript">
        <div className="empty-transcript-icon">
          <SedesMark size={48} />
        </div>
        <h2>
          {starting
            ? "Assistant is starting"
            : creationUnknown
              ? "Thread creation needs attention"
              : "This thread is ready"}
        </h2>
        <p>
          {starting
            ? "Preparing the conversation and submitting your first message…"
            : creationUnknown
              ? "This thread cannot accept input until its creation state is resolved. Review the notice above for details."
              : runState === "disconnected"
                ? "Conversation history is temporarily unavailable while the backend is disconnected."
                : runState === "reconciling"
                  ? "Conversation history is being reconciled with the backend."
                  : readOnly
                    ? "This imported thread has no conversation history to display."
                    : "Write a prompt below, or stash it for later. Nothing is sent until you press Send."}
        </p>
      </div>
    );
  }

  return (
    <div className="message-scroller">
      {focusTurnId && focusStatus !== "found" && focusStatus !== "idle" && (
        <div
          className={`source-turn-status ${focusStatus}`}
          role={focusStatus === "error" ? "alert" : "status"}
        >
          {focusStatus === "loading"
            ? "Locating the selected turn…"
            : focusStatus === "not_found"
              ? "The selected turn is outside the available conversation history."
              : focusStatus === "unavailable"
                ? (focusDiagnostic ??
                  "The selected turn is temporarily unavailable.")
                : "The selected turn could not be loaded."}
          {(focusStatus === "error" ||
            (focusStatus === "unavailable" && focusRetryable)) && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                focusAttemptTarget.current = undefined;
                handledFocusTarget.current = undefined;
                setFocusPage(undefined);
                setFocusRetryNonce((current) => current + 1);
              }}
            >
              Retry selected turn lookup
            </Button>
          )}
        </div>
      )}
      {focusTurnId && focusStatus === "found" && (
        <div className="source-turn-status found" role="status">
          <span>Viewing a selected completed turn.</span>
          <Button
            variant="outline"
            size="xs"
            data-workspace-primary-focus="preferred"
            onClick={onReturnToLive}
          >
            Return to latest
          </Button>
        </div>
      )}
      <div className="message-viewport-frame">
        <ChatHistoryRail
          entries={historyEntries}
          activeItemId={activeHistoryItemId}
          assistantLabel={assistantLabel ?? "Assistant"}
          onSelect={scrollToHistoryItem}
        />
        <div
          ref={viewport}
          className="message-viewport"
          role="region"
          aria-label="Messages"
          data-workspace-primary-focus="fallback"
          tabIndex={0}
          onScroll={() => {
            traceSeek("viewport_scrolled");
            syncHistoryRailActive();
            if (scheduleViewportResizeReconciliation()) return;
            if (hasActiveTextSelection()) return;
            if (releaseSeekAtNaturalBottom()) return;
            if (liveEdgeFollowOwned.current) return;
            const live = measureLiveEdge();
            wasAtLiveEdge.current = live;
            setAtLiveEdge(live);
          }}
          onWheel={(event) => {
            traceSeek("reader_scroll_intent", {
              source: "wheel",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
            // Horizontal trackpad pans and ctrl+wheel pinch zoom do not move
            // the transcript vertically, so they must not surrender an owned
            // live-edge follow or manufacture a reader-away state.
            if (event.deltaY === 0 || event.ctrlKey) return;
            setLocallySelectedTurnId(undefined);
            yieldSeekToReader("wheel");
          }}
          onTouchMove={() => {
            traceSeek("reader_scroll_intent", { source: "touch_move" });
            setLocallySelectedTurnId(undefined);
            yieldSeekToReader("touch_move");
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            traceSeek("reader_scroll_intent", { source: "viewport_pointer" });
            yieldSeekToReader("viewport_pointer");
            if (!measureLiveEdge()) wasAtLiveEdge.current = false;
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "End") {
              event.preventDefault();
              setLocallySelectedTurnId(undefined);
              if (focusTurnId) onReturnToLive?.();
              else scrollToLatest("auto", "key_end");
            } else if (event.key === "Home") {
              event.preventDefault();
              setLocallySelectedTurnId(undefined);
              traceSeek("reader_scroll_intent", { source: "key_home" });
              yieldSeekToReader("key_home");
              event.currentTarget.scrollTo({ top: 0, behavior: "auto" });
              wasAtLiveEdge.current = false;
              setAtLiveEdge(false);
            } else {
              if (scrollIntentKeys.has(event.key)) {
                setLocallySelectedTurnId(undefined);
                traceSeek("reader_scroll_intent", {
                  source: `key_${event.key}`,
                });
                yieldSeekToReader(`key_${event.key}`);
              }
              if (!measureLiveEdge()) wasAtLiveEdge.current = false;
            }
          }}
        >
          <div
            ref={content}
            className="message-content"
            role="log"
            aria-relevant="additions"
            aria-busy={isActiveRun(runState)}
          >
            {!selectedFocusPage &&
              snapshot.history.hasOlder &&
              snapshot.capabilities.history.available &&
              snapshot.capabilities.history.paginated && (
                <div className="history-loader">
                  <Button
                    variant="secondary"
                    disabled={historyLoading}
                    onClick={() => loadHistory("more")}
                  >
                    {historyLoading && historyLoadIntent === "more"
                      ? "Loading…"
                      : "Load more"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={historyLoading}
                    onClick={() => loadHistory("all")}
                  >
                    {historyLoading && historyLoadIntent === "all"
                      ? "Loading…"
                      : "Load all"}
                  </Button>
                </div>
              )}
            {unanchoredOptimisticTransfers.map((transfer) => (
              <TranscriptUserMessage
                key={`delivery:${transfer.operationId}`}
                transfer={transfer}
                context={itemRenderContext}
              />
            ))}
            {turnIds.map((turnId, turnIndex) => {
              const turn = viewTurnsById?.[turnId];
              if (!turn) return null;
              const lastItemId = turn.orderedItemIds.at(-1);
              const firstUserItemId = turn.orderedItemIds.find(
                (itemId) => viewItemsById?.[itemId]?.kind === "user_message",
              );
              const bookmarkEntry = firstUserItemId
                ? historyEntriesByItemId.get(firstUserItemId)
                : undefined;
              const selected =
                (turn.id === focusTurnId && focusStatus === "found") ||
                turn.id === locallySelectedTurnId;
              return (
                <section
                  key={turn.id}
                  className={`conversation-turn${
                    selected ? " source-turn-highlight" : ""
                  }`}
                  data-turn-id={turn.id}
                  data-turn-status={turn.status}
                  data-latest-completed-turn={
                    turn.id === latestCompletedTurnId ? "true" : undefined
                  }
                  tabIndex={selected ? -1 : undefined}
                  aria-label={selected ? "Selected turn" : undefined}
                >
                  {(() => {
                    const presentation: ReactNode[] = [];
                    let activityItems: ActivityItem[] = [];
                    const flushActivity = () => {
                      if (activityItems.length === 0) return;
                      const items = activityItems;
                      activityItems = [];
                      presentation.push(
                        <ActivityGroup
                          key={`activity:${items[0]!.id}`}
                          items={items}
                          threadId={store.threadId}
                          {...(itemRenderContext
                            ? { context: itemRenderContext }
                            : {})}
                        />,
                      );
                    };
                    const appendTransfer = (
                      transfer: PendingComposerTransfer,
                    ) => {
                      flushActivity();
                      presentation.push(
                        <TranscriptUserMessage
                          key={`delivery:${transfer.operationId}`}
                          transfer={transfer}
                          context={itemRenderContext}
                        />,
                      );
                    };

                    // A viewed image's captured image directly follows it.
                    const disclosedImageIds = new Set<string>();
                    turn.orderedItemIds.forEach((itemId, itemIndex) => {
                      const item = viewItemsById?.[itemId];
                      if (!item) return;
                      const precedingTransfers =
                        optimisticByPlacement.get(
                          optimisticBeforeItemPlacement(itemId),
                        ) ?? [];
                      precedingTransfers.forEach(appendTransfer);

                      if (disclosedImageIds.has(item.id)) {
                        // Rendered inside its viewed-image disclosure.
                      } else if (item.kind === "viewed_image") {
                        const next = viewItemsById?.[
                          turn.orderedItemIds[itemIndex + 1] ?? ""
                        ];
                        const image = next?.kind === "image" ? next : undefined;
                        if (image) disclosedImageIds.add(image.id);
                        flushActivity();
                        presentation.push(
                          <ViewedImageGroup
                            key={`viewed-image:${item.id}`}
                            item={item}
                            {...(image ? { image } : {})}
                            {...(itemRenderContext
                              ? { context: itemRenderContext }
                              : {})}
                          />,
                        );
                      } else if (isActivityItem(item)) {
                        activityItems.push(item);
                      } else {
                        flushActivity();
                        presentation.push(
                          item.kind === "user_message" ? (
                            <TranscriptUserMessage
                              key={
                                item.deliveryOperationId
                                  ? `delivery:${item.deliveryOperationId}`
                                  : item.id
                              }
                              item={item}
                              suppressLiveAnnouncement={
                                item.deliveryOperationId !== undefined &&
                                presentedOptimisticOperations.current.operationIds.has(
                                  item.deliveryOperationId,
                                )
                              }
                              context={itemRenderContext}
                              {...(firstUserItemId === item.id &&
                              bookmarkEntry
                                ? {
                                    bookmarkTurnId: turn.id,
                                    bookmarkBookmarked: bookmarkedTurnIds.has(
                                      turn.id,
                                    ),
                                    bookmarkDisabled:
                                      bookmarkStatus !== "ready",
                                    bookmarkPending:
                                      pendingBookmarkTurnIdSet.has(turn.id),
                                    bookmarkUserPreview:
                                      bookmarkEntry.userPreview,
                                    bookmarkAssistantPreview:
                                      bookmarkEntry.responseState ===
                                      "available"
                                        ? bookmarkEntry.assistantPreview
                                        : null,
                                    bookmarkResponseState:
                                      bookmarkEntry.responseState,
                                    bookmarkStore: store,
                                  }
                                : {})}
                            />
                          ) : (
                            <ConversationItemView
                              key={item.id}
                              item={item}
                              {...(itemRenderContext
                                ? { context: itemRenderContext }
                                : {})}
                            />
                          ),
                        );
                      }

                      const anchoredTransfers =
                        itemIndex === turn.orderedItemIds.length - 1
                          ? []
                          : (optimisticByPlacement.get(
                              optimisticAfterItemPlacement(itemId),
                            ) ?? []);
                      anchoredTransfers.forEach(appendTransfer);
                    });
                    flushActivity();
                    return presentation;
                  })()}
                  {currentFailureTurnId !== turn.id && <TurnFailureDetails turn={turn} />}
                  <TurnForkDivider
                    turn={turn}
                    copyText={
                      turn.orderedItemIds
                        .flatMap((itemId) => {
                          const item = viewItemsById?.[itemId];
                          return item?.kind === "assistant_message" &&
                            item.status === "completed"
                            ? [item.markdown.text]
                            : [];
                        })
                        .filter((text) => text.length > 0)
                        .join("\n\n") || undefined
                    }
                    turnNumber={
                      !selectedFocusPage && !snapshot.history.hasOlder
                        ? turnIndex + 1
                        : undefined
                    }
                    capability={viewForksByTurnId?.[turn.id]}
                    attempt={forkAttempts[turn.id]}
                    connected={connection === "connected"}
                    authoritative={authoritative}
                    store={store}
                  />
                  {lastItemId &&
                    (
                      optimisticByPlacement.get(
                        optimisticAfterItemPlacement(lastItemId),
                      ) ?? []
                    ).map((transfer) => (
                      <TranscriptUserMessage
                        key={`delivery:${transfer.operationId}`}
                        transfer={transfer}
                        context={itemRenderContext}
                      />
                    ))}
                  {(
                    optimisticByPlacement.get(
                      optimisticAfterTurnPlacement(turn.id),
                    ) ?? []
                  ).map((transfer) => (
                    <TranscriptUserMessage
                      key={`delivery:${transfer.operationId}`}
                      transfer={transfer}
                      context={itemRenderContext}
                    />
                  ))}
                </section>
              );
            })}
            {runState === "starting" && (
              <div className="status-marker" role="status">
                <span className="comet-spinner mini-spinner" /> Starting…
              </div>
            )}
          </div>
          {/* Seek-on-submit reservation: viewport size is resolved by CSS;
              content growth updates the remaining space. Kept outside the
              content node so its ResizeObserver never sees the reservation. */}
          <div
            ref={seekSpacer}
            className="seek-spacer"
            data-testid="seek-spacer"
            aria-hidden="true"
          />
        </div>
      </div>
      {/* Suppressed while the seek pin holds the viewport: the pin sets
          atLiveEdge=false at send time, and the FAB popping in mid-seek is
          jarring. It appears once the pin releases (reply outgrew the
          reservation) or the reader scrolls away themselves. */}
      {!focusTurnId && !atLiveEdge && !seekPinHeld && (
        <button
          className="jump-latest"
          onClick={() => {
            setLocallySelectedTurnId(undefined);
            scrollToLatest();
          }}
        >
          <ArrowDown size={16} strokeWidth={1.8} /> Jump to latest
        </button>
      )}
    </div>
  );
}

function isActiveRun(runState: ThreadRunState): boolean {
  return [
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "stopping",
  ].includes(runState);
}

const provisionalItemId = (operationId: string): string =>
  `client-delivery:${operationId}`;

function isVisibleOptimisticSubmit(transfer: PendingComposerTransfer): boolean {
  return (
    transfer.mode === "submit" &&
    transfer.presentation === "transcript" &&
    transfer.authorityState === "client_only"
  );
}

const optimisticStartPlacement = "start";
const optimisticBeforeItemPlacement = (itemId: string): string =>
  `before-item:${itemId}`;
const optimisticAfterItemPlacement = (itemId: string): string =>
  `after-item:${itemId}`;
const optimisticAfterTurnPlacement = (turnId: string): string =>
  `after-turn:${turnId}`;

function optimisticTransfersByPlacement(
  visibleTransfers: readonly PendingComposerTransfer[],
  allTransfers: readonly PendingComposerTransfer[],
  authoritativeItemIds: ReadonlySet<string>,
  orderedTurnIds: readonly string[],
  turnsById: Readonly<Record<string, ConversationTurn>> | undefined,
): Map<string, PendingComposerTransfer[]> {
  const result = new Map<string, PendingComposerTransfer[]>();
  for (const transfer of visibleTransfers) {
    let anchor = transfer.baselineTailItemId;
    for (const predecessor of allTransfers) {
      if (
        predecessor.mode !== "submit" ||
        predecessor.presentationSequence >= transfer.presentationSequence ||
        predecessor.baselineTailItemId !== transfer.baselineTailItemId ||
        !predecessor.materializedItemId ||
        !authoritativeItemIds.has(predecessor.materializedItemId)
      ) {
        continue;
      }
      anchor = predecessor.materializedItemId;
    }
    let placement: string;
    if (anchor !== undefined && authoritativeItemIds.has(anchor)) {
      placement = optimisticAfterItemPlacement(anchor);
    } else {
      placement = missingAnchorPlacement(transfer, orderedTurnIds, turnsById);
    }
    const anchored = result.get(placement);
    if (anchored) anchored.push(transfer);
    else result.set(placement, [transfer]);
  }
  return result;
}

function missingAnchorPlacement(
  transfer: PendingComposerTransfer,
  orderedTurnIds: readonly string[],
  turnsById: Readonly<Record<string, ConversationTurn>> | undefined,
): string {
  if (transfer.baselineTailTurnId) {
    const currentTailTurn = turnsById?.[transfer.baselineTailTurnId];
    if (currentTailTurn) {
      const baselineItems = new Set(transfer.baselineTailTurnItemIds);
      const firstNewItemId = currentTailTurn.orderedItemIds.find(
        (itemId) => !baselineItems.has(itemId),
      );
      if (firstNewItemId) {
        return optimisticBeforeItemPlacement(firstNewItemId);
      }
    }
  }

  const baselineTurns = new Set(transfer.baselineOrderedTurnIds);
  const firstNewTurnIndex = orderedTurnIds.findIndex(
    (turnId) => !baselineTurns.has(turnId),
  );
  if (firstNewTurnIndex === 0) return optimisticStartPlacement;
  if (firstNewTurnIndex > 0) {
    return placementAfterTurnBoundary(
      orderedTurnIds[firstNewTurnIndex - 1]!,
      turnsById,
    );
  }

  const lastRetainedBaselineTurnId = [...orderedTurnIds]
    .reverse()
    .find((turnId) => baselineTurns.has(turnId));
  return lastRetainedBaselineTurnId
    ? placementAfterTurnBoundary(lastRetainedBaselineTurnId, turnsById)
    : optimisticStartPlacement;
}

function hasIrreduciblyMissingAnchor(
  transfer: PendingComposerTransfer,
  orderedTurnIds: readonly string[],
  turnsById: Readonly<Record<string, ConversationTurn>> | undefined,
): boolean {
  if (
    !transfer.baselineTailItemId ||
    orderedTurnIds.some((turnId) =>
      turnsById?.[turnId]?.orderedItemIds.includes(
        transfer.baselineTailItemId!,
      ),
    )
  ) {
    return false;
  }
  if (transfer.baselineTailTurnId) {
    const tailTurn = turnsById?.[transfer.baselineTailTurnId];
    const baselineItems = new Set(transfer.baselineTailTurnItemIds);
    if (tailTurn?.orderedItemIds.some((itemId) => !baselineItems.has(itemId))) {
      return false;
    }
  }
  const baselineTurns = new Set(transfer.baselineOrderedTurnIds);
  if (orderedTurnIds.some((turnId) => !baselineTurns.has(turnId))) return false;
  return !orderedTurnIds.some((turnId) => baselineTurns.has(turnId));
}

function placementAfterTurnBoundary(
  turnId: string,
  turnsById: Readonly<Record<string, ConversationTurn>> | undefined,
): string {
  const lastItemId = turnsById?.[turnId]?.orderedItemIds.at(-1);
  return lastItemId
    ? optimisticAfterItemPlacement(lastItemId)
    : optimisticAfterTurnPlacement(turnId);
}

function optimisticUserContent(
  transfer: PendingComposerTransfer,
): readonly UserMessagePresentationPart[] {
  const content: UserMessagePresentationPart[] = [];
  const skillLabel = transfer.capturedPresentation.selectedSkillLabel;
  if (skillLabel) {
    content.push({ kind: "skill", name: { text: skillLabel } });
  }
  content.push(
    ...transfer.captured.attachments.map((attachment) => ({
      kind: "attachment" as const,
      attachment,
    })),
    ...transfer.captured.taskReferences.map((reference) => ({
      kind: "task_reference" as const,
      reference,
    })),
    ...transfer.captured.contextExcerpts.map((excerpt) => ({
      kind: "context_excerpt" as const,
      excerpt,
    })),
  );
  if (transfer.captured.text.length > 0) {
    content.push({ kind: "text", text: { text: transfer.captured.text } });
  }
  return content;
}

const TranscriptUserMessage = memo(function TranscriptUserMessage({
  item,
  transfer,
  suppressLiveAnnouncement = false,
  context = defaultItemRenderContext,
  bookmarkTurnId,
  bookmarkBookmarked = false,
  bookmarkDisabled = false,
  bookmarkPending = false,
  bookmarkUserPreview,
  bookmarkAssistantPreview,
  bookmarkResponseState,
  bookmarkStore,
}: {
  readonly item?: UserMessageItem;
  readonly transfer?: PendingComposerTransfer;
  readonly suppressLiveAnnouncement?: boolean;
  readonly context?: ItemRenderContext;
  readonly bookmarkTurnId?: string;
  readonly bookmarkBookmarked?: boolean;
  readonly bookmarkDisabled?: boolean;
  readonly bookmarkPending?: boolean;
  readonly bookmarkUserPreview?: string;
  readonly bookmarkAssistantPreview?: string | null;
  readonly bookmarkResponseState?: ChatHistoryEntry["responseState"];
  readonly bookmarkStore?: ThreadClientStore;
}): React.JSX.Element | null {
  if (!item && !transfer) return null;
  const operationId = item?.deliveryOperationId ?? transfer?.operationId;
  const provisional = transfer !== undefined;
  return (
    <div
      className="conversation-item"
      data-item-id={item?.id ?? provisionalItemId(transfer!.operationId)}
      data-item-kind="user_message"
      data-item-status={item?.status ?? "completed"}
      data-message-role="user"
      data-delivery-operation-id={operationId}
      data-client-provisional={provisional ? "true" : undefined}
      data-local-optimistic-handoff={
        !provisional && suppressLiveAnnouncement ? "true" : undefined
      }
      aria-live={!provisional && suppressLiveAnnouncement ? "off" : undefined}
    >
      <div className="bookmarked-user-message-wrap">
        <UserMessagePresentation
          content={item?.content ?? optimisticUserContent(transfer!)}
          context={context}
          origin={item?.origin}
          {...(item
            ? {
                selection: {
                  enabled: item.status !== "streaming",
                  itemId: item.id,
                  itemRevision: item.revision,
                },
              }
            : {})}
        />
        {bookmarkTurnId &&
          bookmarkStore &&
          bookmarkUserPreview !== undefined &&
          bookmarkResponseState !== undefined && (
            <button
              type="button"
              className="turn-bookmark-toggle"
              aria-label={
                bookmarkBookmarked ? "Remove turn bookmark" : "Bookmark turn"
              }
              aria-pressed={bookmarkBookmarked}
              title={bookmarkBookmarked ? "Remove bookmark" : "Bookmark turn"}
              disabled={bookmarkDisabled || bookmarkPending}
              onClick={() => {
                void bookmarkStore
                  .setTurnBookmarked(
                    bookmarkBookmarked
                      ? { turnId: bookmarkTurnId, bookmarked: false }
                      : {
                          turnId: bookmarkTurnId,
                          bookmarked: true,
                          preview: {
                            userPreview: bookmarkUserPreview,
                            assistantPreview: bookmarkAssistantPreview ?? null,
                            responseState:
                              bookmarkResponseState === "available"
                                ? "responded"
                                : "no_response",
                          },
                        },
                  )
                  .catch(() => undefined);
              }}
            >
              {bookmarkPending ? (
                <LoaderCircle
                  className="turn-bookmark-spinner"
                  size={16}
                  aria-hidden="true"
                />
              ) : (
                <Bookmark
                  size={16}
                  fill={bookmarkBookmarked ? "currentColor" : "none"}
                  aria-hidden="true"
                />
              )}
            </button>
          )}
      </div>
    </div>
  );
});

function findSeekTarget(
  element: HTMLElement,
  identity: { readonly itemId: string; readonly operationId?: string },
): HTMLElement | null {
  if (identity.operationId) {
    const byOperation = element.querySelector<HTMLElement>(
      `[data-delivery-operation-id="${CSS.escape(identity.operationId)}"]`,
    );
    if (byOperation) return byOperation;
  }
  return element.querySelector<HTMLElement>(
    `[data-item-id="${CSS.escape(identity.itemId)}"]`,
  );
}
