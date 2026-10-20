import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

/**
 * Keyboard navigation shared by the scoped lists (Tasks, Workpads). A list's
 * stops are its rows' titles and its section headings, marked with
 * `data-list-nav="<key>"`; one of them is the list's tab stop (`rovingKey`),
 * and ↑/↓/Home/End move between them. Other controls of a row, such as its
 * ⋯, carry `data-list-nav-for="<key>"` so focus on them counts as being on
 * the row.
 */
export const listNavSelector = (key: string): string =>
  `[data-list-nav="${CSS.escape(key)}"]`;

export interface ScopedListNav {
  /** The stop that takes the list's tab stop: the last one focused, else the first. */
  readonly rovingKey: string | undefined;
  /** Makes a stop the tab stop, such as a revealed row. */
  readonly setActiveKey: (key: string) => void;
  /** Forgets the focused row, when something replaces the list (a phone detail). */
  readonly forgetFocus: () => void;
  /** The stop after `key`, else the one before, else the list's fallback. */
  readonly neighbour: (key: string) => HTMLElement | null;
  /** Spread on the element that holds the list. */
  readonly listProps: {
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
    readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
}

export function useScopedListNav({
  keys,
  listRef,
  fallback,
}: {
  /** The stops in order: rows, then each section heading and, while it is open, its rows. */
  readonly keys: readonly string[];
  readonly listRef: RefObject<HTMLElement | null>;
  /** Where focus goes when the list has no stop left, such as the add row. */
  readonly fallback: () => HTMLElement | null | undefined;
}): ScopedListNav {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const lastFocused = useRef<{ key: string; element: HTMLElement } | null>(null);
  const lastOrder = useRef<readonly string[]>([]);
  const rovingKey = activeKey !== null && keys.includes(activeKey) ? activeKey : keys[0];
  const find = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(listNavSelector(key)) ?? null;

  // A row the user was on can leave the list (completed into a collapsed
  // section, archived, moved, deleted). Keep keyboard focus in the list: the
  // same row where it went, else its neighbour, else the fallback. Focus that
  // moved elsewhere on its own is left alone.
  useLayoutEffect(() => {
    const focused = lastFocused.current;
    const region = listRef.current;
    if (focused && region && !focused.element.isConnected) {
      lastFocused.current = null;
      const active = document.activeElement;
      if (active === null || active === document.body) {
        const index = lastOrder.current.indexOf(focused.key);
        const neighbour = keys[Math.min(Math.max(index, 0), keys.length - 1)];
        (find(focused.key) ?? (neighbour ? find(neighbour) : null) ?? fallback())?.focus();
      }
    }
    lastOrder.current = keys;
  });

  return {
    rovingKey,
    setActiveKey,
    forgetFocus: () => {
      lastFocused.current = null;
    },
    neighbour: (key) => {
      const index = keys.indexOf(key);
      const next = keys[index + 1] ?? keys[index - 1];
      return (next ? find(next) : null) ?? fallback() ?? null;
    },
    listProps: {
      onKeyDown: (event) => {
        const target = event.target as HTMLElement;
        if (!event.currentTarget.contains(target) || !target.dataset.listNav) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-list-nav]")];
        const index = stops.indexOf(target);
        const next =
          event.key === "ArrowDown"
            ? stops[Math.min(index + 1, stops.length - 1)]
            : event.key === "ArrowUp"
              ? stops[Math.max(index - 1, 0)]
              : event.key === "Home"
                ? stops[0]
                : event.key === "End"
                  ? stops.at(-1)
                  : undefined;
        if (!next) return;
        event.preventDefault();
        next.focus();
      },
      onFocus: (event) => {
        const element = event.target as HTMLElement;
        const key = element.dataset.listNav ?? element.dataset.listNavFor;
        if (!key) return;
        lastFocused.current = { key, element };
        setActiveKey(key);
      },
      onBlur: (event) => {
        const element = event.target as HTMLElement;
        const list = event.currentTarget;
        const next = event.relatedTarget as Node | null;
        if (next && list.contains(next)) return;
        // A menu opened from the row returns focus to it; focus that went
        // elsewhere is let go and never pulled back.
        requestAnimationFrame(() => {
          if (!element.isConnected || lastFocused.current?.element !== element) return;
          const menuOpen = element.hasAttribute("aria-haspopup") && element.getAttribute("aria-expanded") === "true";
          if (list.contains(document.activeElement) || menuOpen) return;
          lastFocused.current = null;
        });
      },
    },
  };
}

/** ←/→ on a collapsible section heading closes or opens it, as on a tree item. */
export function onListHeadingKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  if ((event.key === "ArrowRight") !== expanded) {
    event.preventDefault();
    event.currentTarget.click();
  }
}
