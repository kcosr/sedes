import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import type { ClientOrigin } from "../../shared/protocol/thread-input.js";
import { FullPageLoading } from "../components/LoadingStates.js";
import { navigate, threadPath } from "../app/router.js";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import { hasNativeVoice, nativeVoice } from "./native-voice-plugin.js";

const VoiceContext = createContext<NativeVoiceStore | null>(null);
const OriginContext = createContext<ClientOrigin | undefined>(undefined);
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
  if (hasNativeVoice() && profileId && identity) return <AndroidVoiceProvider key={JSON.stringify([profileId, serverOrigin, identity])}
    profileId={profileId} serverOrigin={serverOrigin} identity={identity}>{children}</AndroidVoiceProvider>;
  return <BrowserOriginProvider profileId={profileId} serverOrigin={serverOrigin} identity={identity}>{children}</BrowserOriginProvider>;
}
function BrowserOriginProvider({ profileId, serverOrigin, identity, children }: {
  profileId?: string; serverOrigin: string; identity?: string; children: ReactNode;
}) {
  const origin = useMemo(() => browserOrigin(profileId, serverOrigin, identity), [profileId, serverOrigin, identity]);
  return <OriginContext.Provider value={origin}>{children}</OriginContext.Provider>;
}
function AndroidVoiceProvider({ profileId, serverOrigin, identity, children }: { profileId: string; serverOrigin: string; identity: string; children: ReactNode }) {
  const [store, setStore] = useState<NativeVoiceStore>();
  useEffect(() => {
    const next = new NativeVoiceStore(nativeVoice, { profileId, serverOrigin, identity }, id => navigate(threadPath(id)));
    setStore(next);
    void next.initialize();
    const refresh = () => { if (document.visibilityState !== "hidden") void next.refresh().catch(() => undefined); };
    document.addEventListener("visibilitychange", refresh);
    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) refresh(); });
    return () => { document.removeEventListener("visibilitychange", refresh); void listener.then(handle => handle.remove()); next.dispose(); };
  }, [profileId, serverOrigin, identity]);
  if (!store) return <FullPageLoading />;
  return <HydratedVoice store={store}>{children}</HydratedVoice>;
}
function HydratedVoice({ store, children }: { store: NativeVoiceStore; children: ReactNode }) {
  const state = useVoiceState(store);
  const clientId = state.native?.originClientId;
  const origin = useMemo(() => clientId ? { clientId } : undefined, [clientId]);
  if (state.loading) return <FullPageLoading />;
  return <VoiceContext.Provider value={store}><OriginContext.Provider value={origin}>{children}</OriginContext.Provider></VoiceContext.Provider>;
}
