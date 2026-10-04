import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import type { RegisteredClient } from "../../shared/protocol/client-controls.js";
import { ClientControlConnection } from "./ClientControlConnection.js";
import { configuredPanelPresentation, openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import { hasNativeVoice, nativeVoice } from "./native-voice-plugin.js";

/** Reads the registered client connection when a request is sent. Its identity is stable, so consumers never rebuild when the origin arrives or changes. */
export type ClientOriginSource = () => RegisteredClient | undefined;
const noOrigin: ClientOriginSource = () => undefined;
const VoiceContext = createContext<NativeVoiceStore | null>(null);
const OriginContext = createContext<ClientOriginSource>(noOrigin);
export const useNativeVoice = () => useContext(VoiceContext);
export const useClientOrigin = () => useContext(OriginContext);
export const useVoiceState = (store: NativeVoiceStore) => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

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
  const current = useRef<ClientControlConnection | null>(null);
  const [origin] = useState<ClientOriginSource>(() => () => current.current?.registration);
  useEffect(() => {
    if (!identity) return;
    const connection = new ClientControlConnection({ baseUrl: serverOrigin }, id => openThreadRoute(id, configuredPanelPresentation()));
    current.current = connection;
    void connection.run();
    return () => { connection.close(); if (current.current === connection) current.current = null; };
  }, [profileId, serverOrigin, identity]);
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
    const state = active.current.getSnapshot().native;
    return state?.originClientId && state.clientConnectionToken
      ? { clientId: state.originClientId, connectionToken: state.clientConnectionToken } : undefined;
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
