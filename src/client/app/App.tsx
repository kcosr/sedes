import { authenticatedFetch } from "../authentication/auth-transport.js";
import { authenticationStatusSchema } from "../../shared/authentication.js";
import { AuthenticationGate } from "../authentication/AuthenticationGate.js";
import { getCredential, removeProfileCredentials } from "./client-credentials.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { ApiClient } from "../api/ApiClient.js";
import { BrowserEventStreamTransport } from "../api/EventStreamTransport.js";
import { ApplicationShell } from "../components/ApplicationShell.js";
import { ElectronConnectionLanding } from "../components/ElectronConnectionLanding.js";
import type { ElectronConnectionSettingsControls } from "../components/ElectronConnectionSettings.js";
import { FullPageError, FullPageLoading } from "../components/LoadingStates.js";
import {
  ServerSettingsForm,
  type ServerSettingsControls,
} from "../components/ServerSettingsForm.js";
import {
  ApplicationClientStore,
  useApplicationStore,
} from "../stores/ApplicationClientStore.js";
import { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { PanelLayoutStore } from "../workspace-panels/panel-state.js";
import {
  workspacePanelTenants,
  type WorkspacePanelTenantRegistry,
} from "../workspace-panels/registry.js";
import { navigate } from "./router.js";
import "./workspace-file-download-plugin.js";
import {
  configuredSedesServer,
  sameOriginSedesServer,
  type SedesServerEndpoint,
} from "./server-endpoint.js";
import {
  emptyPackagedConnections,
  loadPackagedConnections,
  savePackagedConnections,
  type PackagedConnectionPreferences,
} from "./server-preferences.js";
import {
  isAndroidClient,
  isElectronClient,
  isPackagedClient,
} from "./client-platform.js";
import {
  availableElectronConnectionPreferences,
  createElectronConnectionProfile,
  commitElectronConnectionProfileSelection,
  deleteElectronConnectionProfile,
  ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
  listElectronConnectionProfiles,
  resetElectronConnectionProfiles,
  setElectronConnectionAutoConnectAtStartup,
  updateElectronConnectionProfile,
  type ElectronConnectionPreferences,
  type ElectronConnectionProfile,
  type ElectronConnectionProfileInput,
} from "./electron-connections.js";
import {
  electronConnectionRuntime,
  type ElectronConnectionRuntimeCapabilities,
  type ElectronConnectionRuntimeConnection,
  type ElectronConnectionRuntimeStateChange,
} from "./electron-connection-runtime-plugin.js";
import { Button } from "../components/ui/button.js";
import { OperationOverlayHost } from "../operations/OperationOverlay.js";

export function App({
  panelTenants = workspacePanelTenants,
}: {
  readonly panelTenants?: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  if (isElectronClient()) {
    return <ElectronApp panelTenants={panelTenants} />;
  }
  if (!isPackagedClient()) {
    return (
      <AuthenticatedApp
        endpoint={sameOriginSedesServer}
        panelTenants={panelTenants}
      />
    );
  }
  return <AndroidApp panelTenants={panelTenants} />;
}

function AndroidApp({ panelTenants }: { readonly panelTenants: WorkspacePanelTenantRegistry }): React.JSX.Element {
  const [connections, setConnections] = useState<PackagedConnectionPreferences | null>(null);
  const [storageError, setStorageError] = useState<string>();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  useEffect(() => { let alive = true; void loadPackagedConnections().then((value) => { if (alive) setConnections(value); }).catch((error: unknown) => { if (alive) { setStorageError(messageFrom(error)); setConnections(emptyPackagedConnections()); } }); return () => { alive = false; }; }, []);
  if (!connections) return <FullPageLoading />;
  const save = async (next: PackagedConnectionPreferences) => {
    setConnections(await savePackagedConnections(next)); setStorageError(undefined); navigate("/", { replace: true });
  };
  const controls: ServerSettingsControls = {
    connections, storageError,
    save: async (profile) => { await save({ ...connections, profiles: [...connections.profiles.filter((entry) => entry.id !== profile.id), profile], selectedProfileId: profile.id }); setConnectionEpoch((epoch) => epoch + 1); },
    connect: async (profileId) => { await save({ ...connections, selectedProfileId: profileId }); setConnectionEpoch((epoch) => epoch + 1); },
    remove: async (profileId) => {
      const profile = connections.profiles.find((entry) => entry.id === profileId);
      if (profile) await removeProfileCredentials(profile.id);
      await save({ ...connections, profiles: connections.profiles.filter((entry) => entry.id !== profileId), selectedProfileId: connections.selectedProfileId === profileId ? null : connections.selectedProfileId });
    },
  };
  const profile = connections.profiles.find((entry) => entry.id === connections.selectedProfileId);
  if (!profile) return <FullPageError eyebrow="Sedes server" title="Connect to Sedes" message="Add or select a Sedes server connection." settings={<ServerSettingsForm controls={controls} />} />;
  return <AuthenticatedApp key={profile.id + profile.baseUrl + connectionEpoch} endpoint={configuredSedesServer(profile.baseUrl)} credentialProfileId={profile.id} serverSettings={controls} panelTenants={panelTenants} />;
}

interface ActiveElectronConnection {
  readonly profile: ElectronConnectionProfile;
  readonly authenticationRequired?: boolean;
  readonly endpoint: SedesServerEndpoint;
  readonly resource?: {
    readonly kind: "local" | "ssh";
    readonly connectionId: string;
  };
}

interface CandidateElectronConnection extends ActiveElectronConnection {
  readonly generation: number;
}

const ELECTRON_BOOTSTRAP_TIMEOUT_MILLISECONDS = 15_000;

function ElectronApp({
  panelTenants,
}: {
  readonly panelTenants: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  const [preferences, setPreferences] =
    useState<ElectronConnectionPreferences | null>(null);
  const [capabilities, setCapabilities] = useState<ElectronConnectionRuntimeCapabilities>({ localServer: false });
  const capabilitiesRef = useRef<ElectronConnectionRuntimeCapabilities>({ localServer: false });
  const availablePreferences = preferences ? availableElectronConnectionPreferences(preferences, capabilities) : null;
  const [storageError, setStorageError] = useState<string>();
  const [nativeError, setNativeError] = useState<string>();
  const [profileErrors, setProfileErrors] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(
    null,
  );
  const [switchingConnection, setSwitchingConnection] = useState(false);
  const [finalizingConnection, setFinalizingConnection] = useState(false);
  const [switchFailure, setSwitchFailure] = useState<string>();
  const [active, setActive] = useState<ActiveElectronConnection | null>(null);
  const [retainedLocal, setRetainedLocal] =
    useState<ActiveElectronConnection | null>(null);
  const mountedRef = useRef(false);
  const initializedRef = useRef(false);
  const autoConnectStartedRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const attemptAbortRef = useRef<AbortController | undefined>(undefined);
  const activeRef = useRef<ActiveElectronConnection | null>(null);
  const retainedLocalRef = useRef<ActiveElectronConnection | null>(null);
  const candidateRef = useRef<CandidateElectronConnection | null>(null);
  const pendingResourceRef = useRef<{
    readonly generation: number;
    readonly connectionId: string;
  } | null>(null);
  const listenerRemovalRef = useRef<(() => void) | undefined>(undefined);
  const runtimeListenerReadyRef = useRef(false);

  const disconnectResource = useCallback(async (
    connection: ActiveElectronConnection | CandidateElectronConnection,
  ): Promise<void> => {
    if (!connection.resource) return;
    await electronConnectionRuntime.disconnect({
      connectionId: connection.resource.connectionId,
    });
  }, []);

  const connect = useCallback(
    async (
      profile: ElectronConnectionProfile,
      adopted?: ElectronConnectionRuntimeConnection & { authenticationRequired?: boolean },
    ): Promise<void> => {
      if (profile.kind === "local" && !capabilitiesRef.current.localServer) throw new Error("Local is unavailable in this Sedes client distribution.");
      const generation = ++attemptGenerationRef.current;
      attemptAbortRef.current?.abort();
      const abort = new AbortController();
      attemptAbortRef.current = abort;
      setConnectingProfileId(profile.id);
      setSwitchFailure(undefined);
      setProfileErrors((current) => ({ ...current, [profile.id]: undefined }));

      if (
        profile.kind === "local" &&
        retainedLocalRef.current?.profile.kind === "local"
      ) {
        const restored = retainedLocalRef.current;
        retainedLocalRef.current = null;
        setRetainedLocal(null);
        activeRef.current = restored;
        setActive(restored);
        setConnectingProfileId(null);
        attemptAbortRef.current = undefined;
        return;
      }

      let candidate: CandidateElectronConnection | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (profile.kind !== "direct" && !runtimeListenerReadyRef.current) {
          throw new Error(
            "The desktop connection service is unavailable. " +
              "Restart Sedes and try again.",
          );
        }
        const connectionId = adopted?.connectionId ?? crypto.randomUUID();
        if (profile.kind !== "direct") {
          pendingResourceRef.current = { generation, connectionId };
        }
        const nativeConnection = adopted ??
          (profile.kind === "local"
            ? await electronConnectionRuntime.startLocal({ connectionId })
            : profile.kind === "ssh"
              ? await electronConnectionRuntime.connectSsh({
                  profileId: profile.id,
                  connectionId,
                  hostAlias: profile.sshHost,
                  remotePort: profile.remotePort,
                })
              : undefined);
        const endpoint = configuredSedesServer(
          profile.kind === "direct" ? profile.baseUrl : nativeConnection!.baseUrl,
        );
        candidate = {
          profile,
          ...(nativeConnection && "authenticationRequired" in nativeConnection && typeof nativeConnection.authenticationRequired === "boolean" ? { authenticationRequired: nativeConnection.authenticationRequired } : {}),
          endpoint,
          generation,
          ...(profile.kind === "direct"
            ? {}
            : {
                resource: {
                  kind: profile.kind,
                  connectionId: nativeConnection!.connectionId,
                },
              }),
        };
        if (pendingResourceRef.current?.generation === generation) {
          pendingResourceRef.current = null;
        }
        candidateRef.current = candidate;
        if (
          generation !== attemptGenerationRef.current ||
          abort.signal.aborted
        ) {
          await disconnectResource(candidate);
          return;
        }

        timeout = setTimeout(
          () => abort.abort(),
          ELECTRON_BOOTSTRAP_TIMEOUT_MILLISECONDS,
        );
        const statusResponse = await authenticatedFetch(endpoint, "/api/auth/status", { signal: abort.signal }, null);
        if (!statusResponse.ok) throw new Error("Could not check server authentication.");
        const authentication = authenticationStatusSchema.parse(await statusResponse.json());
        const credential = authentication.required
          ? await getCredential(profile.id, endpoint.baseUrl!)
          : null;
        try { await new ApiClient(endpoint, credential ?? null).session({ signal: abort.signal }); }
        catch (error) { if (!(error instanceof Error && "status" in error && error.status === 401)) throw error; }
        clearTimeout(timeout);
        timeout = undefined;
        if (
          generation !== attemptGenerationRef.current ||
          abort.signal.aborted
        ) {
          await disconnectResource(candidate);
          return;
        }

        const selected = await commitElectronConnectionProfileSelection(
          profile.id,
          abort.signal,
        );
        if (
          generation !== attemptGenerationRef.current ||
          abort.signal.aborted
        ) {
          await disconnectResource(candidate);
          return;
        }

        const fallback = retainedLocalRef.current;
        if (fallback) {
          setFinalizingConnection(true);
          try {
            await disconnectResource(fallback);
          } catch (stopError) {
            await disconnectResource(candidate).catch(() => undefined);
            await commitElectronConnectionProfileSelection(
              ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
              new AbortController().signal,
            );
            activeRef.current = fallback;
            setActive(fallback);
            const message = `Could not stop Local. ${messageFrom(stopError)}`;
            setSwitchFailure(message);
            throw new Error(message, { cause: stopError });
          } finally {
            setFinalizingConnection(false);
          }
          retainedLocalRef.current = null;
          setRetainedLocal(null);
        }

        const nextActive: ActiveElectronConnection = candidate;
        candidateRef.current = null;
        activeRef.current = nextActive;
        setPreferences(selected);
        setActive(nextActive);
      } catch (error) {
        if (candidate) await disconnectResource(candidate).catch(() => undefined);
        if (candidateRef.current?.generation === generation) {
          candidateRef.current = null;
        }
        if (pendingResourceRef.current?.generation === generation) {
          pendingResourceRef.current = null;
        }
        if (generation !== attemptGenerationRef.current) return;
        const message = abort.signal.aborted
          ? "The connection attempt timed out or was cancelled."
          : messageFrom(error);
        setProfileErrors((current) => ({ ...current, [profile.id]: message }));
        const fallback = retainedLocalRef.current;
        if (fallback) {
          retainedLocalRef.current = null;
          setRetainedLocal(null);
          activeRef.current = fallback;
          setActive(fallback);
          setSwitchFailure(
            abort.signal.aborted
              ? undefined
              : `Couldn’t switch to ${profile.name}. ` +
                `Local is still running. ${message}`,
          );
        }
        throw new Error(message, { cause: error });
      } finally {
        if (timeout) clearTimeout(timeout);
        if (generation === attemptGenerationRef.current) {
          attemptAbortRef.current = undefined;
          setConnectingProfileId(null);
        }
      }
    },
    [disconnectResource],
  );

  const handleRuntimeStateChange = useCallback(
    (event: ElectronConnectionRuntimeStateChange): void => {
      if (!event.error) return;
      const current = activeRef.current;
      if (current?.resource?.connectionId === event.connectionId) {
        ++attemptGenerationRef.current;
        attemptAbortRef.current?.abort();
        attemptAbortRef.current = undefined;
        candidateRef.current = null;
        pendingResourceRef.current = null;
        setConnectingProfileId(null);
        setFinalizingConnection(false);
        activeRef.current = null;
        setActive(null);
        setProfileErrors((errors) => ({
          ...errors,
          [current.profile.id]: event.error?.message,
        }));
        return;
      }
      const fallback = retainedLocalRef.current;
      if (fallback?.resource?.connectionId === event.connectionId) {
        retainedLocalRef.current = null;
        setRetainedLocal(null);
        setProfileErrors((errors) => ({
          ...errors,
          [fallback.profile.id]: event.error?.message,
        }));
        return;
      }
      const candidate = candidateRef.current;
      if (candidate?.resource?.connectionId !== event.connectionId) return;
      ++attemptGenerationRef.current;
      attemptAbortRef.current?.abort();
      attemptAbortRef.current = undefined;
      candidateRef.current = null;
      pendingResourceRef.current = null;
      setConnectingProfileId(null);
      setFinalizingConnection(false);
      setProfileErrors((errors) => ({
        ...errors,
        [candidate.profile.id]: event.error?.message,
      }));
      const restoredLocal = retainedLocalRef.current;
      if (restoredLocal) {
        retainedLocalRef.current = null;
        setRetainedLocal(null);
        activeRef.current = restoredLocal;
        setActive(restoredLocal);
        setSwitchFailure(
          `Couldn’t switch to ${candidate.profile.name}. ` +
            `Local is still running. ${event.error.message}`,
        );
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => {
      if (!mountedRef.current || initializedRef.current) return;
      initializedRef.current = true;
      void (async () => {
        try {
          const nativeCapabilities = await electronConnectionRuntime.getCapabilities();
          if (!mountedRef.current) return;
          capabilitiesRef.current = nativeCapabilities;
          setCapabilities(nativeCapabilities);
          const handle = await electronConnectionRuntime.addListener(
            handleRuntimeStateChange,
          );
          runtimeListenerReadyRef.current = true;
          listenerRemovalRef.current = () => void handle.remove();
          if (!mountedRef.current) listenerRemovalRef.current();
        } catch (error) {
          if (mountedRef.current) setNativeError(messageFrom(error));
        }
        try {
          const loaded = await listElectronConnectionProfiles();
          if (!mountedRef.current) return;
          setPreferences(loaded);
          const selected = availableElectronConnectionPreferences(loaded, capabilitiesRef.current).profiles.find(
            ({ id }) => id === loaded.selectedProfileId,
          );
          if (
            loaded.autoConnectAtStartup &&
            selected &&
            !autoConnectStartedRef.current
          ) {
            autoConnectStartedRef.current = true;
            let adopted: (ElectronConnectionRuntimeConnection & { authenticationRequired?: boolean }) | undefined;
            if (selected.kind !== "direct") {
              const status = await electronConnectionRuntime.getStatus();
              const owned =
                selected.kind === "local"
                  ? status.local.status === "connected"
                    ? status.local
                    : undefined
                  : status.ssh.status === "connected" &&
                      status.ssh.hostAlias === selected.sshHost &&
                      status.ssh.remotePort === selected.remotePort
                    ? status.ssh
                    : undefined;
              if (owned) {
                adopted = {
                  connectionId: owned.connectionId,
                  baseUrl: owned.baseUrl,
                  ...("authenticationRequired" in owned ? { authenticationRequired: owned.authenticationRequired } : {}),
                };
              }
            }
            void connect(selected, adopted).catch(() => undefined);
          }
        } catch (error) {
          if (!mountedRef.current) return;
          setPreferences({
            profiles: [],
            selectedProfileId: null,
            autoConnectAtStartup: true,
          });
          setStorageError(messageFrom(error));
        }
      })();
    });
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        ++attemptGenerationRef.current;
        attemptAbortRef.current?.abort();
        listenerRemovalRef.current?.();
        listenerRemovalRef.current = undefined;
        runtimeListenerReadyRef.current = false;
        const resources = [
          candidateRef.current,
          retainedLocalRef.current,
          activeRef.current,
        ].filter((value): value is ActiveElectronConnection => Boolean(value));
        candidateRef.current = null;
        const pendingResource = pendingResourceRef.current;
        pendingResourceRef.current = null;
        retainedLocalRef.current = null;
        activeRef.current = null;
        for (const resource of resources) {
          void disconnectResource(resource).catch(() => undefined);
        }
        if (pendingResource) {
          void electronConnectionRuntime
            .disconnect({ connectionId: pendingResource.connectionId })
            .catch(() => undefined);
        }
      });
    };
  }, [connect, disconnectResource, handleRuntimeStateChange]);

  const cancelConnect = async (): Promise<void> => {
    ++attemptGenerationRef.current;
    attemptAbortRef.current?.abort();
    attemptAbortRef.current = undefined;
    setConnectingProfileId(null);
    const candidate = candidateRef.current;
    candidateRef.current = null;
    if (candidate) await disconnectResource(candidate);
    const pendingResource = pendingResourceRef.current;
    pendingResourceRef.current = null;
    if (pendingResource) {
      await electronConnectionRuntime.disconnect({
        connectionId: pendingResource.connectionId,
      });
    }
    const fallback = retainedLocalRef.current;
    if (fallback) {
      retainedLocalRef.current = null;
      setRetainedLocal(null);
      activeRef.current = fallback;
      setActive(fallback);
    }
  };

  const switchConnection = async (): Promise<void> => {
    ++attemptGenerationRef.current;
    attemptAbortRef.current?.abort();
    const current = activeRef.current;
    setSwitchingConnection(true);
    setActive(null);
    setConnectingProfileId(null);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (current?.profile.kind === "local") {
        activeRef.current = null;
        retainedLocalRef.current = current;
        setRetainedLocal(current);
      } else {
        activeRef.current = null;
        if (current) await disconnectResource(current);
      }
    } catch (error) {
      setNativeError(messageFrom(error));
      throw error;
    } finally {
      setSwitchingConnection(false);
    }
  };

  if (active) {
    const electronConnectionSettings: ElectronConnectionSettingsControls = {
      activeProfile: active.profile,
      authenticationRequired: active.authenticationRequired,
      switchConnection,
    };
    return <>
      <AuthenticatedApp
        key={active.profile.id + active.endpoint.baseUrl}
        endpoint={active.endpoint}
        credentialProfileId={active.profile.id}
        panelTenants={panelTenants}
        electronConnectionSettings={electronConnectionSettings}
      />
      {switchFailure ? (
        <div className="electron-switch-failure" role="alert">
          <span>{switchFailure}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSwitchFailure(undefined)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </>;
  }

  return (
    <ElectronConnectionLanding
      profiles={availablePreferences?.profiles ?? []}
      autoConnectAtStartup={preferences?.autoConnectAtStartup ?? true}
      loading={preferences === null || switchingConnection}
      globalError={storageError ?? nativeError}
      profileErrors={profileErrors}
      connectingProfileId={connectingProfileId}
      connectionFinalizing={finalizingConnection}
      currentProfileId={retainedLocal?.profile.id ?? null}
      onReturnToCurrent={
        retainedLocal
          ? async () => {
              activeRef.current = retainedLocal;
              retainedLocalRef.current = null;
              setRetainedLocal(null);
              setActive(retainedLocal);
            }
          : undefined
      }
      onConnect={async (profileId) => {
        const profile = availablePreferences?.profiles.find(
          ({ id }) => id === profileId,
        );
        if (!profile)
          throw new Error("The connection profile no longer exists.");
        await connect(profile);
      }}
      onCancelConnect={cancelConnect}
      onAutoConnectAtStartupChange={async (autoConnectAtStartup) => {
        setPreferences(
          await setElectronConnectionAutoConnectAtStartup(
            autoConnectAtStartup,
          ),
        );
        setStorageError(undefined);
      }}
      onSaveAndConnect={async (
        input: ElectronConnectionProfileInput,
        profileId,
      ) => {
        const profile = profileId
          ? await updateElectronConnectionProfile(profileId, input)
          : await createElectronConnectionProfile(input);
        setStorageError(undefined);
        setPreferences(await listElectronConnectionProfiles());
        // The profile has been durably saved at this point. Connection errors
        // belong to its card, not to the editor as though persistence failed.
        await connect(profile).catch(() => undefined);
      }}
      onDelete={async (profileId) => {
        await removeProfileCredentials(profileId);
        setPreferences(await deleteElectronConnectionProfile(profileId));
        setProfileErrors((current) => ({ ...current, [profileId]: undefined }));
      }}
      onResetPreferences={
        storageError
          ? async () => {
              setPreferences(await resetElectronConnectionProfiles());
              setStorageError(undefined);
              setProfileErrors({});
            }
          : undefined
      }
    />
  );
}

function AuthenticatedApp(props: {
  endpoint: SedesServerEndpoint;
  credentialProfileId?: string;
  serverSettings?: ServerSettingsControls;
  electronConnectionSettings?: ElectronConnectionSettingsControls;
  panelTenants: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  const settings = props.serverSettings ? <ServerSettingsForm controls={props.serverSettings} /> : props.electronConnectionSettings ? <Button onClick={() => void props.electronConnectionSettings!.switchConnection()}>Switch connection</Button> : undefined;
  return <AuthenticationGate endpoint={props.endpoint} profileId={props.credentialProfileId} settings={settings}><ConnectedApp {...props} /></AuthenticationGate>;
}

function ConnectedApp({
  endpoint,
  serverSettings,
  electronConnectionSettings,
  panelTenants,
}: {
  endpoint: SedesServerEndpoint;
  serverSettings?: ServerSettingsControls;
  electronConnectionSettings?: ElectronConnectionSettingsControls;
  panelTenants: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  const dependencies = useMemo(() => {
    const api = new ApiClient(endpoint);
    const transport = new BrowserEventStreamTransport(endpoint);
    const threadRegistry = new ThreadStoreRegistry(api, transport);
    const applicationStore = new ApplicationClientStore(api, transport);
    const unsubscribeUsage = applicationStore.subscribe(() => {
      threadRegistry.setExperimentalUsageEnabled(applicationStore.getSnapshot().experimentalUsageEnabled);
    });
    return {
      unsubscribeUsage,
      transport,
      applicationStore,
      threadRegistry,
      mounted: false,
      started: false,
      disposed: false,
      panelLayoutStore: new PanelLayoutStore(panelTenants),
    };
  }, [endpoint.baseUrl, panelTenants]);
  const state = useApplicationStore(dependencies.applicationStore);

  useEffect(() => {
    dependencies.mounted = true;
    queueMicrotask(() => {
      if (
        !dependencies.mounted ||
        dependencies.started ||
        dependencies.disposed
      ) {
        return;
      }
      dependencies.started = true;
      void dependencies.applicationStore.initialize().catch(() => undefined);
    });
    let resumeScheduled = false;
    let sessionRefreshRequested = false;
    const resume = (refreshSession = false) => {
      sessionRefreshRequested ||= refreshSession;
      if (resumeScheduled) return;
      resumeScheduled = true;
      queueMicrotask(() => {
        resumeScheduled = false;
        const allowed =
          dependencies.started &&
          !dependencies.disposed &&
          document.visibilityState === "visible" &&
          navigator.onLine;
        if (!allowed) return;
        const shouldRefreshSession = sessionRefreshRequested;
        sessionRefreshRequested = false;
        // EventSource owns ordinary browser retry and Last-Event-ID. Streams
        // explicitly marked as native-suspended are recreated immediately
        // from each normalized store's accepted replay cursor. Reconnecting
        // inventory never requires an unconditional full bootstrap refresh.
        if (shouldRefreshSession) {
          void dependencies.applicationStore.resume().catch(() => undefined);
        } else {
          dependencies.transport.reconnectAll();
        }
      });
    };
    const resumeOnline = () => resume(true);
    const resumeVisible = () => resume();
    window.addEventListener("online", resumeOnline);
    document.addEventListener("visibilitychange", resumeVisible);
    let removeNativeResume: (() => void) | undefined;
    let nativeListenerDisposed = false;
    if (isAndroidClient()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) {
          // Native WebViews can retain an OPEN EventSource object while the
          // underlying suspended socket has gone stale. Mark it explicitly;
          // the active transition below will re-establish only these streams.
          dependencies.transport.markAllNativeSuspended();
          return;
        }
        resume(true);
      })
        .then((handle) => {
          removeNativeResume = () => void handle.remove();
          if (nativeListenerDisposed) removeNativeResume();
        })
        .catch(() => undefined);
    }
    return () => {
      dependencies.mounted = false;
      nativeListenerDisposed = true;
      removeNativeResume?.();
      window.removeEventListener("online", resumeOnline);
      document.removeEventListener("visibilitychange", resumeVisible);
      queueMicrotask(() => {
        if (dependencies.mounted || dependencies.disposed) return;
        dependencies.disposed = true;
        dependencies.unsubscribeUsage();
        dependencies.threadRegistry.dispose();
        dependencies.applicationStore.dispose();
        dependencies.transport.closeAll();
      });
    };
  }, [dependencies]);

  return (
    <>
    <OperationOverlayHost threadRegistry={dependencies.threadRegistry} />
    <ApplicationShell
      state={state}
      applicationStore={dependencies.applicationStore}
      threadRegistry={dependencies.threadRegistry}
      serverSettings={serverSettings}
      electronConnectionSettings={electronConnectionSettings}
      panelLayoutStore={dependencies.panelLayoutStore}
      panelTenants={panelTenants}
      toolClientEndpoint={endpoint.baseUrl ?? window.location.origin}
    />
    </>
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not read the saved Sedes server setting.";
}
