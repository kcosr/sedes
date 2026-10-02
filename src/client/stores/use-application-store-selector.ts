import { useCallback, useRef, useSyncExternalStore } from "react";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "./ApplicationClientStore.js";

/**
 * Derives one value from the application store and re-renders only when that
 * value changes.
 *
 * The application store publishes a new state object for every event, and its
 * normalized snapshot is re-parsed, so entity identities are not preserved
 * between events. A selector therefore receives its previous selection and
 * may return it (or reuse parts of it) when nothing it renders changed;
 * `isEqual` then decides whether a freshly built selection is equivalent to
 * the previous one. An equal selection keeps the previous reference, so
 * `useSyncExternalStore` skips the render.
 *
 * Pass a stable `selector` and `isEqual` (module-level functions or memoized
 * callbacks): a different selector or equality re-derives the selection on
 * the next read.
 */
export function useApplicationStoreSelector<Selection>(
  store: Pick<ApplicationClientStore, "subscribe" | "getSnapshot">,
  selector: (
    state: ApplicationClientState,
    previous: Selection | undefined,
  ) => Selection,
  isEqual: (previous: Selection, next: Selection) => boolean = Object.is,
): Selection {
  const cache = useRef<
    | {
        readonly state: ApplicationClientState;
        readonly selector: typeof selector;
        readonly isEqual: typeof isEqual;
        readonly selection: Selection;
      }
    | undefined
  >(undefined);
  const getSelection = useCallback((): Selection => {
    const state = store.getSnapshot();
    const cached = cache.current;
    if (
      cached &&
      cached.state === state &&
      cached.selector === selector &&
      cached.isEqual === isEqual
    ) {
      return cached.selection;
    }
    const next = selector(state, cached?.selection);
    const selection =
      cached !== undefined && isEqual(cached.selection, next)
        ? cached.selection
        : next;
    cache.current = { state, selector, isEqual, selection };
    return selection;
  }, [isEqual, selector, store]);
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
