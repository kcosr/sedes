import { useCallback, useSyncExternalStore } from "react";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";

// A web UI preference, not a native setting: native settings are a strict, versioned record shared with Android.
const prefix = "sedes-voice-bar-when-off:";
const storageKey = ({ profileId, serverOrigin, identity }: NativeVoiceStore["connection"]) => `${prefix}${JSON.stringify([profileId, serverOrigin, identity])}`;
/** The value each binding shows until a write or a storage event; a write storage refuses still holds for this session. */
const cache = new Map<string, boolean>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== null && !event.key.startsWith(prefix)) return;
  if (event.key === null) cache.clear(); else cache.delete(event.key);
  notify();
});

function read(key: string): boolean {
  let value = cache.get(key);
  if (value === undefined) {
    try { value = localStorage.getItem(key) === "true"; } catch { value = false; }
    cache.set(key, value);
  }
  return value;
}
function write(key: string, value: boolean): void {
  cache.set(key, value);
  try { if (value) localStorage.setItem(key, "true"); else localStorage.removeItem(key); } catch { /* The choice still applies in this session. */ }
  notify();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Device-local, per voice binding. Default false: Off hides the voice bar, as before. */
export function useShowVoiceBarWhenOff(store: NativeVoiceStore): readonly [boolean, (value: boolean) => void] {
  const key = storageKey(store.connection);
  const value = useSyncExternalStore(subscribe, () => read(key), () => false);
  const set = useCallback((next: boolean) => write(key, next), [key]);
  return [value, set] as const;
}
