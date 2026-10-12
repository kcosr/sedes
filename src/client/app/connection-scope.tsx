import { createContext, useContext, type ReactNode } from "react";
import { ELECTRON_LOCAL_CONNECTION_PROFILE_ID } from "./electron-connections.js";

/** Durable client state belongs to one configured connection and authenticated identity. */
export interface ConnectionScope {
  readonly profileId: string;
  readonly serverKey: string;
  readonly identity: string;
}

/** Managed Local chooses a new transport port on launch, while its identity remains stable. */
export function connectionScope(profileId: string, serverOrigin: string, identity: string): ConnectionScope {
  return {
    profileId,
    serverKey: profileId === ELECTRON_LOCAL_CONNECTION_PROFILE_ID ? "electron-managed-local" : serverOrigin,
    identity,
  };
}

export function connectionScopeKey(scope: ConnectionScope): string {
  return JSON.stringify([scope.profileId, scope.serverKey, scope.identity]);
}

const Context = createContext<ConnectionScope | null>(null);

export function ConnectionScopeProvider({ scope, children }: { scope: ConnectionScope; children: ReactNode }) {
  return <Context.Provider value={scope}>{children}</Context.Provider>;
}

export function useConnectionScope(): ConnectionScope {
  const scope = useContext(Context);
  if (!scope) throw new Error("The authenticated application connection scope is unavailable.");
  return scope;
}
