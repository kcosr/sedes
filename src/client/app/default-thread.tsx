import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceStore } from "../voice/NativeVoiceStore.js";
import { nativeThreadTitle } from "../voice/native-voice-plugin.js";

export interface DefaultThreadScope { profileId: string; serverOrigin: string; identity: string }
export function defaultThreadStorageKey(scope: DefaultThreadScope): string {
  return `sedes.default-thread.v1:${JSON.stringify([scope.profileId, scope.serverOrigin, scope.identity])}`;
}
export function canUseDefaultThread(thread: NormalizedApplicationThreadSummary): boolean {
  return thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled");
}
interface DefaultThreadControls {
  readonly threadId: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  setThread(thread: NormalizedApplicationThreadSummary | null): Promise<void>;
}
const Context = createContext<DefaultThreadControls | null>(null);
export const useDefaultThread = () => useContext(Context);

/** One choice per authenticated connection on this device. Android's native
 * binding record remains the single authority, also read by background voice.
 * Desktop/browser never mirror another device's selection or a voice setting.
 */
export function DefaultThreadProvider({ scope, native, children }: {
  scope: DefaultThreadScope; native?: NativeVoiceStore; children: ReactNode;
}) {
  return native
    ? <NativeDefaultThread native={native}>{children}</NativeDefaultThread>
    : <LocalDefaultThread key={defaultThreadStorageKey(scope)} scope={scope}>{children}</LocalDefaultThread>;
}
function NativeDefaultThread({ native, children }: { native: NativeVoiceStore; children: ReactNode }) {
  const state = useSyncExternalStore(native.subscribe, native.getSnapshot, native.getSnapshot);
  const value = useMemo<DefaultThreadControls>(() => ({
    threadId: state.native?.settings.voiceThreadId ?? null,
    pending: state.pending || !state.native,
    error: state.error ?? null,
    async setThread(thread) {
      if (thread && !canUseDefaultThread(thread)) throw new Error("This thread is unavailable.");
      await native.update({ voiceThreadId: thread?.id ?? null, voiceThreadTitle: thread ? nativeThreadTitle(thread.title.text) : null });
    },
  }), [native, state]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function LocalDefaultThread({ scope, children }: { scope: DefaultThreadScope; children: ReactNode }) {
  const key = defaultThreadStorageKey(scope);
  const [threadId, setThreadId] = useState<string | null>(() => {
    try { return localStorage.getItem(key) || null; } catch { return null; }
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const receive = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) setThreadId(event.key === null ? null : event.newValue || null); };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [key]);
  const value = useMemo<DefaultThreadControls>(() => ({ threadId, pending: false, error,
    async setThread(thread) {
      if (thread && !canUseDefaultThread(thread)) throw new Error("This thread is unavailable.");
      try {
        if (thread) localStorage.setItem(key, thread.id); else localStorage.removeItem(key);
        setThreadId(thread?.id ?? null); setError(null);
      } catch (cause) { setError("Could not save the default thread on this device."); throw cause; }
    },
  }), [error, key, threadId]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
