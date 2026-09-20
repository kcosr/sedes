import { useEffect, useId, useRef, useState } from "react";
import type { ChatHistoryEntry } from "./ChatHistoryRail.js";

const holdDelayMilliseconds = 240;
const scrubDeadZonePixels = 6;
const historyEntryHeightPixels = 28;
const historyRailInsetPixels = 16;

export function historyScrubIndex(
  startIndex: number,
  displacementY: number,
  entryCount: number,
  pixelsPerEntry: number,
): number {
  if (entryCount < 1) return 0;
  const adjustedDisplacement =
    Math.sign(displacementY) *
    Math.max(0, Math.abs(displacementY) - scrubDeadZonePixels);
  const offset =
    Math.sign(adjustedDisplacement) *
    Math.round(Math.abs(adjustedDisplacement) / Math.max(0.25, pixelsPerEntry));
  return Math.max(0, Math.min(entryCount - 1, Math.round(startIndex) + offset));
}

export function historyRailNaturalHeight(entryCount: number): number {
  return Math.max(
    44,
    Math.max(0, entryCount - 1) * historyEntryHeightPixels +
      historyRailInsetPixels * 2,
  );
}

export function historyRailPixelsPerEntry(
  entryCount: number,
  railHeight: number,
): number {
  return Math.max(
    0.25,
    (railHeight - historyRailInsetPixels * 2) / Math.max(1, entryCount - 1),
  );
}

export function historyRailPosition(index: number, entryCount: number): number {
  if (entryCount < 2) return 0.5;
  return Math.max(0, Math.min(entryCount - 1, index)) / (entryCount - 1);
}

export function MobileChatHistoryThumbstick({
  entries,
  getActiveItemId,
  assistantLabel,
  onSelect,
}: {
  readonly entries: readonly ChatHistoryEntry[];
  readonly getActiveItemId: () => string | undefined;
  readonly assistantLabel: string;
  readonly onSelect: (itemId: string) => void;
}): React.JSX.Element | null {
  const previewId = useId();
  const entriesRef = useRef(entries);
  const getActiveItemIdRef = useRef(getActiveItemId);
  const onSelectRef = useRef(onSelect);
  const trackRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const pointer = useRef<
    | {
        readonly pointerId: number;
        readonly startY: number;
        readonly pixelsPerEntry: number;
        lastY: number;
        activated: boolean;
      }
    | undefined
  >(undefined);
  const interactionKind = useRef<"pointer" | "keyboard" | undefined>(undefined);
  const selectedIndexRef = useRef(0);
  const selectedItemIdRef = useRef<string | undefined>(undefined);
  const scrubOriginItemIdRef = useRef<string | undefined>(undefined);
  const [active, setActive] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  entriesRef.current = entries;
  getActiveItemIdRef.current = getActiveItemId;
  onSelectRef.current = onSelect;

  const clearHoldTimer = () => {
    if (holdTimer.current === undefined) return;
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  };

  const resolveActiveIndex = () => {
    const activeItemId = getActiveItemIdRef.current();
    const index = entriesRef.current.findIndex(
      ({ itemId }) => itemId === activeItemId,
    );
    return index >= 0 ? index : Math.max(0, entriesRef.current.length - 1);
  };

  const updateSelectedIndex = (next: number) => {
    const bounded = Math.max(0, Math.min(entriesRef.current.length - 1, next));
    selectedIndexRef.current = bounded;
    selectedItemIdRef.current = entriesRef.current[bounded]?.itemId;
    setSelectedIndex(bounded);
  };

  const beginInteraction = (kind: "pointer" | "keyboard") => {
    interactionKind.current = kind;
    updateSelectedIndex(resolveActiveIndex());
    scrubOriginItemIdRef.current = selectedItemIdRef.current;
    setActive(true);
  };

  const updatePointerScrub = (current: NonNullable<typeof pointer.current>) => {
    const entries = entriesRef.current;
    const originIndex = scrubOriginItemIdRef.current
      ? entries.findIndex(
          ({ itemId }) => itemId === scrubOriginItemIdRef.current,
        )
      : -1;
    const startIndex = originIndex >= 0 ? originIndex : resolveActiveIndex();
    const displacementY = current.lastY - current.startY;
    const nextIndex = historyScrubIndex(
      startIndex,
      displacementY,
      entries.length,
      current.pixelsPerEntry,
    );
    updateSelectedIndex(nextIndex);
  };

  const beginPointerScrub = () => {
    const current = pointer.current;
    if (!current) return;
    current.activated = true;
    beginInteraction("pointer");
    updatePointerScrub(current);
  };

  const closeInteraction = (commit: boolean) => {
    clearHoldTimer();
    const entry = entriesRef.current[selectedIndexRef.current];
    interactionKind.current = undefined;
    scrubOriginItemIdRef.current = undefined;
    setActive(false);
    if (commit && entry) onSelectRef.current(entry.itemId);
  };

  useEffect(
    () => () => {
      clearHoldTimer();
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const selectedId = selectedItemIdRef.current;
    const retainedIndex = selectedId
      ? entries.findIndex(({ itemId }) => itemId === selectedId)
      : -1;
    updateSelectedIndex(
      retainedIndex >= 0
        ? retainedIndex
        : Math.min(selectedIndexRef.current, entries.length - 1),
    );
  }, [active, entries]);

  if (entries.length === 0) return null;
  const selectedEntry = entries[selectedIndex];
  return (
    <div
      className="mobile-chat-history-thumbstick"
      data-active={active ? "true" : "false"}
      data-testid="mobile-chat-history-thumbstick"
    >
      <div
        ref={trackRef}
        className="mobile-chat-history-thumbstick-track"
        aria-hidden="true"
        style={{ height: `${historyRailNaturalHeight(entries.length)}px` }}
      >
        <ol className="mobile-chat-history-thumbstick-ticks">
          {entries.map(({ itemId, bookmarked }, index) => (
            <li
              key={itemId}
              className="chat-history-entry"
              data-active={index === selectedIndex ? "true" : "false"}
              data-bookmarked={bookmarked ? "true" : undefined}
              style={{
                top: `${historyRailPosition(index, entries.length) * 100}%`,
              }}
            >
              <span className="chat-history-target">
                <span className="chat-history-tick" />
              </span>
            </li>
          ))}
        </ol>
      </div>
      <button
        type="button"
        className="mobile-chat-history-thumbstick-target"
        aria-label="Tap to jump to the latest user message; hold to scrub conversation history"
        aria-expanded={active}
        aria-describedby={active ? previewId : undefined}
        onClick={(event) => {
          if (event.detail !== 0) return;
          if (active && interactionKind.current === "keyboard") {
            closeInteraction(true);
          } else if (!active) {
            beginInteraction("keyboard");
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (
            !["ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(
              event.key,
            )
          ) {
            return;
          }
          event.preventDefault();
          if (event.key === "Escape") {
            if (active) closeInteraction(false);
            return;
          }
          if (!active) beginInteraction("keyboard");
          if (event.key === "ArrowUp") {
            updateSelectedIndex(selectedIndexRef.current - 1);
          } else if (event.key === "ArrowDown") {
            updateSelectedIndex(selectedIndexRef.current + 1);
          } else if (event.key === "Home") {
            updateSelectedIndex(0);
          } else {
            updateSelectedIndex(entriesRef.current.length - 1);
          }
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || pointer.current) return;
          if (active) closeInteraction(false);
          const entryCount = entriesRef.current.length;
          const trackHeight =
            trackRef.current?.offsetHeight ||
            historyRailNaturalHeight(entryCount);
          pointer.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            pixelsPerEntry: historyRailPixelsPerEntry(entryCount, trackHeight),
            lastY: event.clientY,
            activated: false,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          holdTimer.current = window.setTimeout(() => {
            holdTimer.current = undefined;
            beginPointerScrub();
          }, holdDelayMilliseconds);
        }}
        onPointerMove={(event) => {
          const current = pointer.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.lastY = event.clientY;
          if (current.activated) updatePointerScrub(current);
        }}
        onPointerUp={(event) => {
          const current = pointer.current;
          if (!current || current.pointerId !== event.pointerId) return;
          pointer.current = undefined;
          const commit = current.activated;
          closeInteraction(commit);
          if (!commit) {
            const latestEntry = entriesRef.current.at(-1);
            if (latestEntry) onSelectRef.current(latestEntry.itemId);
          }
        }}
        onPointerCancel={(event) => {
          if (pointer.current?.pointerId !== event.pointerId) return;
          pointer.current = undefined;
          closeInteraction(false);
        }}
        onLostPointerCapture={(event) => {
          if (pointer.current?.pointerId !== event.pointerId) return;
          pointer.current = undefined;
          closeInteraction(false);
        }}
      >
        <span
          className="mobile-chat-history-thumbstick-dot"
          aria-hidden="true"
        />
      </button>
      {active && selectedEntry && (
        <article
          id={previewId}
          className="mobile-chat-history-thumbstick-preview"
          data-response-state={selectedEntry.responseState}
          role="status"
          aria-live={interactionKind.current === "keyboard" ? "polite" : "off"}
        >
          <div className="mobile-chat-history-thumbstick-position">
            Message {selectedIndex + 1} of {entries.length}
            <span>Release to jump</span>
          </div>
          <p className="mobile-chat-history-thumbstick-user-preview">
            <span className="sr-only">
              {selectedEntry.userLabel ?? "You"}:{" "}
            </span>
            {selectedEntry.userPreview}
          </p>
          <p className="mobile-chat-history-thumbstick-assistant-preview">
            <span className="sr-only">{assistantLabel}: </span>
            {selectedEntry.assistantPreview}
          </p>
        </article>
      )}
    </div>
  );
}
