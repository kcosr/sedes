/**
 * Keyboard cursor for dense lists: j/k move, Enter opens, o opens
 * externally. Suppressed while typing or while a blocking layer is open. When
 * an item is open (a drawer), moving the cursor follows with it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { hasBlockingLayer, isTypingTarget, tabbableIn } from "./layers";

/** Attribute ListRow puts on each row so the cursor can find it. */
export const ROW_ID_ATTR = "data-wb-row";

/** The row element for `id` (within `root`, default the document). */
export function findRow(
  id: string,
  root: ParentNode | null = typeof document === "undefined" ? null : document,
): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>(`[${ROW_ID_ATTR}="${CSS.escape(id)}"]`) ??
    null
  );
}

/**
 * The row's primary link/button (what Tab reaches), for focus return: the
 * `.wb-row-link`, else the row's first Tab stop, else the row itself if it
 * is focusable; null when nothing in the row can take focus (callers then
 * fall back, e.g. the drawer to its opener).
 */
export function findRowTarget(
  id: string,
  root?: ParentNode | null,
): HTMLElement | null {
  const row = findRow(id, root);
  if (!row) return null;
  return (
    row.querySelector<HTMLElement>(".wb-row-link") ??
    tabbableIn(row)[0] ??
    (row.hasAttribute("tabindex") ? row : null)
  );
}

const INTERACTIVE =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"], [role="combobox"], [role="textbox"], [role="slider"], [role="spinbutton"], [role="option"], [role="tab"], [role="separator"], [contenteditable="true"]';

export interface ListCursorOptions {
  /** Row ids in rendered order. */
  ids: readonly string[];
  /** The open item (drawer), if any. The cursor snaps to it. */
  activeId?: string | null | undefined;
  /** Enter on the cursor row. Also used to follow when `activeId` is set and `onFollow` is not. */
  onOpen: (id: string) => void;
  /** Cursor moved while an item is open (typically a history-replace navigation). */
  onFollow?: ((id: string) => void) | undefined;
  /** "o": open the item elsewhere (new tab, external system). */
  onExternal?: ((id: string) => void) | undefined;
  /** Reset the cursor when this changes (filters, sort). */
  resetKey?: unknown;
  enabled?: boolean | undefined;
  /** Where rows live (default document). */
  rootRef?: RefObject<HTMLElement | null> | undefined;
}

export interface ListCursor {
  cursorId: string | null;
  setCursorId: (id: string | null) => void;
  isCursor: (id: string) => boolean;
}

export function useListCursor(options: ListCursorOptions): ListCursor {
  const { ids, activeId = null, resetKey, enabled = true } = options;
  const [cursorId, setCursorId] = useState<string | null>(null);

  const latest = useRef(options);
  const cursorRef = useRef(cursorId);
  useLayoutEffect(() => {
    latest.current = options;
    cursorRef.current = cursorId;
  });

  // Reset on filter changes (declared first so the snap below wins on mount).
  useEffect(() => {
    setCursorId(null);
  }, [resetKey]);

  // Keep the cursor on the open item (when it opens, or once it is loaded),
  // and bring it into view (deep links to an item further down).
  const activeListed = activeId !== null && ids.includes(activeId);
  useEffect(() => {
    if (!activeListed || activeId === null) return;
    setCursorId(activeId);
    const root = latest.current.rootRef?.current ?? document;
    findRow(activeId, root)?.scrollIntoView({ block: "nearest" });
  }, [activeId, activeListed]);

  // A cursor row that left the list (removed, filtered out) is no cursor.
  // Checked against the queued value, so a snap to a new open row made in
  // the same commit (above) survives.
  const cursorListed = cursorId !== null && ids.includes(cursorId);
  useEffect(() => {
    if (cursorId === null || cursorListed) return;
    setCursorId((c) => (c !== null && !ids.includes(c) ? null : c));
  }, [cursorId, cursorListed, ids]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const opts = latest.current;
      const list = opts.ids;
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        list.length === 0 ||
        hasBlockingLayer() ||
        isTypingTarget(document.activeElement)
      )
        return;
      const current = cursorRef.current;
      const index = current === null ? -1 : list.indexOf(current);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next =
          index < 0
            ? 0
            : Math.max(
                0,
                Math.min(list.length - 1, index + (e.key === "j" ? 1 : -1)),
              );
        const id = list[next];
        if (id === undefined) return;
        cursorRef.current = id;
        setCursorId(id);
        const root = opts.rootRef?.current ?? document;
        findRow(id, root)?.scrollIntoView({
          block: "nearest",
        });
        // Focus on a row's primary link/button (e.g. returned there by a
        // closing drawer) moves with the cursor, so Enter opens the
        // highlighted row rather than the focused one.
        const focused = document.activeElement;
        if (
          focused instanceof HTMLElement &&
          focused.classList.contains("wb-row-link") &&
          focused.closest(`[${ROW_ID_ATTR}]`)
        ) {
          findRowTarget(id, root)?.focus({ preventScroll: true });
        }
        if (opts.activeId != null && opts.activeId !== id) {
          (opts.onFollow ?? opts.onOpen)(id);
        }
      } else if (e.key === "Enter" && index >= 0) {
        // Enter on a focused control belongs to that control.
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest(INTERACTIVE)) return;
        const id = list[index];
        if (id === undefined) return;
        e.preventDefault();
        opts.onOpen(id);
      } else if (
        e.key === "o" &&
        !e.shiftKey &&
        index >= 0 &&
        opts.onExternal
      ) {
        const id = list[index];
        if (id === undefined) return;
        e.preventDefault();
        opts.onExternal(id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);

  const current = cursorListed ? cursorId : null;
  const isCursor = useCallback((id: string) => current === id, [current]);
  return { cursorId: current, setCursorId, isCursor };
}
