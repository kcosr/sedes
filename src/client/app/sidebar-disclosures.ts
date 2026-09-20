import { useCallback, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";

const storagePrefix = "sedes-sidebar-disclosures@1:";
const changedEvent = "sedes-sidebar-disclosures-changed";
type DisclosureState = Record<string, boolean>;
const empty: DisclosureState = {};
const cache = new Map<string, { raw: string | null; state: DisclosureState }>();

function read(category: string): DisclosureState {
  try {
    const raw = localStorage.getItem(storagePrefix + category);
    const previous = cache.get(category);
    if (previous?.raw === raw) return previous.state;
    let parsed: unknown = {};
    try {
      parsed = raw === null ? {} : JSON.parse(raw);
    } catch {
      // Ignore invalid persisted presentation data.
    }
    const state = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "boolean"))
      : {};
    cache.set(category, { raw, state });
    return state;
  } catch {
    return cache.get(category)?.state ?? empty;
  }
}

/** Client-local presentation only; entity keys use canonical workspace/thread/group IDs. */
export function useSidebarDisclosures(
  category: string,
): [DisclosureState, Dispatch<SetStateAction<DisclosureState>>] {
  const subscribe = useCallback((listener: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === storagePrefix + category) listener();
    };
    window.addEventListener(changedEvent, listener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(changedEvent, listener);
      window.removeEventListener("storage", onStorage);
    };
  }, [category]);
  const snapshot = useCallback(() => read(category), [category]);
  const state = useSyncExternalStore(subscribe, snapshot, () => empty);
  const update = useCallback<Dispatch<SetStateAction<DisclosureState>>>((action) => {
    const current = read(category);
    const next = typeof action === "function" ? action(current) : action;
    if (next === current) return;
    const raw = JSON.stringify(next);
    try {
      localStorage.setItem(storagePrefix + category, raw);
      cache.set(category, { raw, state: next });
    } catch {
      // Keep disclosures usable when persistent storage is unavailable.
      cache.set(category, { raw: cache.get(category)?.raw ?? null, state: next });
    }
    window.dispatchEvent(new Event(changedEvent));
  }, [category]);
  return [state, update];
}

export function useSidebarDisclosure(
  category: string,
  id: string,
  defaultOpen: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [states, setStates] = useSidebarDisclosures(category);
  const open = states[id] ?? defaultOpen;
  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>((action) => {
    setStates((current) => ({
      ...current,
      [id]: typeof action === "function" ? action(current[id] ?? defaultOpen) : action,
    }));
  }, [defaultOpen, id, setStates]);
  return [open, setOpen];
}
