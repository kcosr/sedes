import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import type { ClientOrigin } from "../../shared/protocol/thread-input.js";
import { configuredPanelPresentation, openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import { hasNativeVoice, nativeVoice } from "./native-voice-plugin.js";

/** Reads the advisory client origin when a request is sent. Its identity is stable, so consumers never rebuild when the origin arrives or changes. */
export type ClientOriginSource = () => ClientOrigin | undefined;
const noOrigin: ClientOriginSource = () => undefined;
const VoiceContext = createContext<NativeVoiceStore | null>(null);
const OriginContext = createContext<ClientOriginSource>(noOrigin);
export const useNativeVoice = () => useContext(VoiceContext);
export const useClientOrigin = () => useContext(OriginContext);
export const useVoiceState = (store: NativeVoiceStore) => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

function browserOrigin(profileId: string | undefined, serverOrigin: string, identity: string | undefined): ClientOrigin | undefined {
  if (!identity) return undefined;
  const key = `sedes-client-origin:${JSON.stringify([profileId ?? "browser", serverOrigin, identity])}`;
  try {
    let clientId = localStorage.getItem(key);
    if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(clientId)) {
      clientId = crypto.randomUUID();
      localStorage.setItem(key, clientId);
    }
    return { clientId };
  } catch { return undefined; }
}

/** Authenticate first; the Android bridge obtains the same identity using its stored credential. */
export function VoiceProvider({ profileId, serverOrigin, identity, children }: {
  profileId?: string; serverOrigin: string; identity?: string; children: ReactNode;
}): React.JSX.Element {
  if (!hasNativeVoice()) return <BrowserOriginProvider profileId={profileId} serverOrigin={serverOrigin} identity={identity}>{children}</BrowserOriginProvider>;
  // Android shares exactly one origin ID with native. Without a native binding the WebView sends none rather than inventing its own.
  if (!profileId || !identity) return <>{children}</>;
  return <AndroidVoiceProvider key={JSON.stringify([profileId, serverOrigin, identity])}
    profileId={profileId} serverOrigin={serverOrigin} identity={identity}>{children}</AndroidVoiceProvider>;
}
function BrowserOriginProvider({ profileId, serverOrigin, identity, children }: {
  profileId?: string; serverOrigin: string; identity?: string; children: ReactNode;
}) {
  const origin = useMemo<ClientOriginSource>(() => { const value = browserOrigin(profileId, serverOrigin, identity); return () => value; }, [profileId, serverOrigin, identity]);
  return <OriginContext.Provider value={origin}>{children}</OriginContext.Provider>;
}
function createStore(profileId: string, serverOrigin: string, identity: string): NativeVoiceStore {
  return new NativeVoiceStore(nativeVoice, { profileId, serverOrigin, identity }, id => openThreadRoute(id, configuredPanelPresentation()));
}
/** The application renders at once; voice hydrates beside it and the origin is absent until native connects. */
function AndroidVoiceProvider({ profileId, serverOrigin, identity, children }: { profileId: string; serverOrigin: string; identity: string; children: ReactNode }) {
  const [store, setStore] = useState(() => createStore(profileId, serverOrigin, identity));
  const active = useRef(store);
  const [origin] = useState<ClientOriginSource>(() => () => {
    const clientId = active.current.getSnapshot().native?.originClientId;
    return clientId ? { clientId } : undefined;
  });
  useEffect(() => {
    // An effect replay (StrictMode) replaces the store it disposed instead of reviving it.
    if (store.disposed) { setStore(createStore(profileId, serverOrigin, identity)); return; }
    active.current = store;
    void store.initialize();
    const foreground = () => { if (document.visibilityState !== "hidden") store.foreground(); };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", foreground);
    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) foreground(); });
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", foreground);
      void listener.then(handle => handle.remove()).catch(() => undefined);
      store.dispose();
    };
  }, [store, profileId, serverOrigin, identity]);
  return <VoiceContext.Provider value={store}><OriginContext.Provider value={origin}>{children}</OriginContext.Provider></VoiceContext.Provider>;
}
