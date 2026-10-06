import { useSyncExternalStore } from "react";

// A web UI preference, not a native setting: native settings are a strict, versioned record shared with Android.
const storageKey = "sedes-device-voice-bar-when-off";
/** The value this device shows until a write or a storage event; a write storage refuses still holds for this session. */
let cachedValue: boolean | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== null && event.key !== storageKey) return;
  cachedValue = undefined;
  notify();
});

function read(): boolean {
  if (cachedValue === undefined) {
    try { cachedValue = localStorage.getItem(storageKey) === "true"; } catch { cachedValue = false; }
  }
  return cachedValue;
}
function write(value: boolean): void {
  cachedValue = value;
  try { if (value) localStorage.setItem(storageKey, "true"); else localStorage.removeItem(storageKey); } catch { /* The choice still applies in this session. */ }
  notify();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Device-local across Sedes connections. Default false: Off hides the voice bar, as before. */
export function useShowVoiceBarWhenOff(): readonly [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, read, () => false);
  return [value, write] as const;
}
