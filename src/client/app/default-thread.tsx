import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceStore } from "../voice/NativeVoiceStore.js";
import { nativeThreadTitle } from "../voice/native-voice-plugin.js";
import { connectionScopeKey, type ConnectionScope } from "./connection-scope.js";
import { ApiError } from "../api/ApiClient.js";
import { useApplicationStore, type ApplicationClientStore } from "../stores/ApplicationClientStore.js";

export function defaultThreadStorageKey(scope: ConnectionScope): string {
  return `sedes.default-thread.v1:${connectionScopeKey(scope)}`;
}
export function canUseDefaultThread(thread: NormalizedApplicationThreadSummary): boolean {
  return thread.available && (thread.inventoryState === "active" || thread.inventoryState === "settled");
}
interface DefaultThreadControls {
  readonly threadId: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly thread?: NormalizedApplicationThreadSummary;
  readonly resolving?: boolean;
  setThread(thread: NormalizedApplicationThreadSummary | null): Promise<void>;
}
const Context = createContext<DefaultThreadControls | null>(null);
const ScopeContext = createContext("");
export const useDefaultThread = () => useContext(Context);

/** Resolve a saved ID outside the bounded bootstrap without attaching its backend. */
export function DefaultThreadResolutionProvider({ store, children }: { store: ApplicationClientStore; children: ReactNode }) {
  const selection = useDefaultThread();
  const scopeKey = useContext(ScopeContext);
  const application = useApplicationStore(store);
  const threadId = selection?.threadId;
  const inventoryThread = application.snapshot?.threads.find(thread => thread.id === threadId);
  const hasInventoryThread = inventoryThread !== undefined;
  const [refresh, setRefresh] = useState(0);
  const [resolution, setResolution] = useState<{
    store: ApplicationClientStore; scopeKey: string; id: string;
    thread?: NormalizedApplicationThreadSummary; pending: boolean; error?: string;
  }>();
  useEffect(() => {
    if (!threadId) return;
    const refresh = () => { if (document.visibilityState !== "hidden") setRefresh(value => value + 1); };
    const unsubscribe = store.normalized.subscribeThreadSummaryChanges(changed => {
      if (changed === undefined || changed === threadId) setRefresh(value => value + 1);
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [store, scopeKey, threadId]);
  useEffect(() => {
    if (!threadId || hasInventoryThread) {
      setResolution(undefined);
      return;
    }
    if (application.status !== "ready" || !application.authoritative || application.connection !== "connected") return;
    const controller = new AbortController();
    const matches = (current: typeof resolution) => current?.store === store && current.scopeKey === scopeKey && current.id === threadId;
    setResolution(current => ({ store, scopeKey, id: threadId, thread: matches(current) ? current!.thread : undefined, pending: true }));
    void store.api.readThreadSummary(threadId, controller.signal).then(thread => {
      if (!controller.signal.aborted) setResolution({ store, scopeKey, id: threadId, thread, pending: false });
    }).catch(error => {
      if (controller.signal.aborted) return;
      const inaccessible = error instanceof ApiError && [401, 403, 404].includes(error.status);
      setResolution(current => ({ store, scopeKey, id: threadId,
        thread: !inaccessible && matches(current) ? current!.thread : undefined,
        pending: false,
        error: inaccessible ? "The default thread is unavailable." : "Could not refresh the default thread.",
      }));
    });
    return () => controller.abort();
  }, [store, scopeKey, threadId, hasInventoryThread, application.status, application.authoritative, application.connection, refresh]);
  if (!selection) return children;
  const current = resolution?.store === store && resolution.scopeKey === scopeKey && resolution.id === threadId ? resolution : undefined;
  return <Context.Provider value={{ ...selection,
    thread: inventoryThread ?? current?.thread,
    resolving: Boolean(threadId && !inventoryThread && (!current || current.pending)),
    error: selection.error ?? current?.error ?? null,
  }}>{children}</Context.Provider>;
}

export function defaultThreadChoices(threads: readonly NormalizedApplicationThreadSummary[], selected?: NormalizedApplicationThreadSummary): readonly NormalizedApplicationThreadSummary[] {
  return selected && !threads.some(thread => thread.id === selected.id) ? [selected, ...threads] : threads;
}

/** One choice per authenticated connection on this device. Android's native
 * binding record remains the single authority, also read by background voice.
 * Desktop/browser never mirror another device's selection or a voice setting.
 */
export function DefaultThreadProvider({ scope, native, children }: {
  scope: ConnectionScope; native?: NativeVoiceStore; children: ReactNode;
}) {
  return <ScopeContext.Provider value={connectionScopeKey(scope)}>{native
    ? <NativeDefaultThread native={native}>{children}</NativeDefaultThread>
    : <LocalDefaultThread key={defaultThreadStorageKey(scope)} scope={scope}>{children}</LocalDefaultThread>}</ScopeContext.Provider>;
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
function LocalDefaultThread({ scope, children }: { scope: ConnectionScope; children: ReactNode }) {
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
