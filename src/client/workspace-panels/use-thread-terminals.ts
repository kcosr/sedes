import { useEffect, useRef, useState } from "react";
import type { TerminalResource } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import {
  getConfirmTerminalTermination,
  subscribeConfirmTerminalTermination,
} from "../app/settings.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import {
  isTerminalProcessLive,
  type TerminalPanelHandle,
  type TerminalSessionSnapshot,
} from "../terminals/index.js";
import { withoutMapKey } from "./panel-dom.js";
import type { PanelRegionStore, ThreadTerminalPanel } from "./region-store.js";
import type { RegionId } from "./regions.js";

/**
 * The Terminals panel's client state for one thread: the terminal resources
 * its tabs show, lookups and their failures, the active tab's session, and
 * ending, removing and renaming terminals. Tabs live in the panel region
 * store; this keeps what the server says about them.
 */

export interface TerminalLookupFailure {
  readonly kind: "gone" | "transient";
  readonly message: string;
}

export interface TerminalLifecycleConfirmation {
  readonly terminalId: string;
  readonly label: string;
  readonly terminal?: TerminalResource;
}

export type TerminalRemovalDisposition = "ended" | "removed" | "disconnected";

export interface ThreadTerminals {
  readonly panelRef: React.RefObject<TerminalPanelHandle | null>;
  readonly resources: ReadonlyMap<string, TerminalResource>;
  readonly lookupFailures: ReadonlyMap<string, TerminalLookupFailure>;
  readonly sessionState: TerminalSessionSnapshot | undefined;
  readonly lifecyclePendingId: string | undefined;
  readonly lifecycleError:
    | { readonly terminalId: string; readonly message: string }
    | undefined;
  readonly lifecycleConfirmation: TerminalLifecycleConfirmation | undefined;
  readonly confirmTermination: boolean;
  setSessionState(state: TerminalSessionSnapshot | undefined): void;
  /** This thread's resource for a terminal, if known. */
  resource(terminalId: string): TerminalResource | undefined;
  /** Records a newer resource and forgets a failed lookup for it. */
  noteResource(terminal: TerminalResource): void;
  setResource(terminal: TerminalResource): void;
  retryLookup(terminalId: string): void;
  /** Shows a terminal's tab, in `region` when one was chosen. */
  open(terminal: TerminalResource, region?: RegionId): boolean;
  activate(terminalId: string): void;
  removeFromClient(
    terminalId: string,
    displayName?: string,
    disposition?: TerminalRemovalDisposition,
  ): void;
  /** The disposition a removal had, from what was known of the terminal. */
  dispositionOf(terminal: TerminalResource | undefined): TerminalRemovalDisposition;
  requestClose(terminalId: string): void;
  endOrRemove(terminalId: string, known?: TerminalResource): Promise<void>;
  closeView(terminalId: string, label: string): void;
  dismissLifecycleConfirmation(): void;
  rename(terminalId: string, displayName: string): Promise<void>;
}

export function useThreadTerminals({
  store,
  threadId,
  applicationStore,
  authoritative,
  connected,
  terminalSummary,
  panel,
  announce,
}: {
  readonly store: PanelRegionStore;
  readonly threadId: string;
  readonly applicationStore: ApplicationClientStore;
  readonly authoritative: boolean;
  readonly connected: boolean;
  /** The thread summary's terminal counts; a change refreshes the tabs. */
  readonly terminalSummary: unknown;
  readonly panel: ThreadTerminalPanel | undefined;
  readonly announce: (message: string) => void;
}): ThreadTerminals {
  const panelRef = useRef<TerminalPanelHandle>(null);
  const [confirmTermination, setConfirmTermination] = useState(
    getConfirmTerminalTermination,
  );
  const [resources, setResources] = useState<
    ReadonlyMap<string, TerminalResource>
  >(() => new Map());
  const [lookupFailures, setLookupFailures] = useState<
    ReadonlyMap<string, TerminalLookupFailure>
  >(() => new Map());
  const [lookupRevision, setLookupRevision] = useState(0);
  const [sessionState, setSessionState] = useState<TerminalSessionSnapshot>();
  const [lifecyclePendingId, setLifecyclePendingId] = useState<string>();
  const [lifecycleError, setLifecycleError] = useState<{
    readonly terminalId: string;
    readonly message: string;
  }>();
  const [lifecycleConfirmation, setLifecycleConfirmation] =
    useState<TerminalLifecycleConfirmation>();
  const closePendingRef = useRef<symbol | undefined>(undefined);
  const lifecycleMutationIdsRef = useRef(
    new Map<string, { readonly revision: number; readonly mutationId: string }>(),
  );
  const renameMutationIdsRef = useRef(
    new Map<string, { readonly fingerprint: string; readonly mutationId: string }>(),
  );
  const resourceThreadRef = useRef(threadId);
  const inventoryGenerationRef = useRef(0);
  const pendingLookupsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const tabIds = panel?.threadId === threadId ? panel.tabs.map(({ terminalId }) => terminalId) : [];
  const tabKey = tabIds.join(":");

  useEffect(() => subscribeConfirmTerminalTermination(setConfirmTermination), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (resourceThreadRef.current === threadId) return;
    resourceThreadRef.current = threadId;
    setResources(new Map());
    setLookupFailures(new Map());
    setSessionState(undefined);
    lifecycleMutationIdsRef.current.clear();
    renameMutationIdsRef.current.clear();
    closePendingRef.current = undefined;
    setLifecyclePendingId(undefined);
    setLifecycleError(undefined);
    setLifecycleConfirmation(undefined);
  }, [threadId]);

  const resource = (terminalId: string): TerminalResource | undefined => {
    const cached = resources.get(terminalId);
    return cached?.threadId === threadId ? cached : undefined;
  };

  const setResource = (terminal: TerminalResource) =>
    setResources((current) => new Map(current).set(terminal.terminalId, terminal));

  const dispositionOf = (
    terminal: TerminalResource | undefined,
  ): TerminalRemovalDisposition =>
    terminal && isTerminalProcessLive(terminal.lifecycle)
      ? terminal.terminationEffect === "disconnect_transport"
        ? "disconnected"
        : "ended"
      : "removed";

  const removeFromClient = (
    terminalId: string,
    displayName = "Terminal",
    disposition: TerminalRemovalDisposition = "ended",
  ) => {
    if (store.terminalPanel()?.activeTerminalId === terminalId)
      setSessionState(undefined);
    setResources((current) => withoutMapKey(current, terminalId));
    setLookupFailures((current) => withoutMapKey(current, terminalId));
    store.closeTerminalTab(terminalId);
    announce(
      `${displayName} ${disposition}. Its retained terminal history was removed.`,
    );
  };

  const closeView = (terminalId: string, label: string) => {
    if (store.terminalPanel()?.activeTerminalId === terminalId)
      setSessionState(undefined);
    if (!store.closeTerminalTab(terminalId)) return;
    announce(`${label} tab closed. Its process was not terminated.`);
  };

  const endOrRemove = async (
    terminalId: string,
    knownTerminal?: TerminalResource,
  ) => {
    if (closePendingRef.current) return;
    const pendingToken = Symbol();
    closePendingRef.current = pendingToken;
    const actionThreadId = threadId;
    setLifecyclePendingId(terminalId);
    setLifecycleError(undefined);
    let live = true;
    try {
      const terminal =
        knownTerminal ?? await applicationStore.api.readTerminal(terminalId);
      if (closePendingRef.current !== pendingToken) return;
      if (
        terminal.threadId !== actionThreadId ||
        terminal.terminalId !== terminalId
      )
        throw new Error("The terminal is no longer available.");
      live = isTerminalProcessLive(terminal.lifecycle);
      const action = live ? "end" : "remove";
      const key = `${action}:${terminal.terminalId}`;
      const existing = lifecycleMutationIdsRef.current.get(key);
      const mutationId =
        existing?.revision === terminal.lifecycleRevision
          ? existing.mutationId
          : crypto.randomUUID();
      lifecycleMutationIdsRef.current.set(key, {
        revision: terminal.lifecycleRevision,
        mutationId,
      });
      const request = {
        mutationId,
        expectedRevision: terminal.lifecycleRevision,
      };
      if (live)
        await applicationStore.api.endTerminal(terminal.terminalId, request);
      else
        await applicationStore.api.deleteTerminal(terminal.terminalId, request);
      if (closePendingRef.current !== pendingToken) return;
      lifecycleMutationIdsRef.current.delete(key);
      removeFromClient(
        terminal.terminalId,
        terminal.displayName,
        dispositionOf(terminal),
      );
    } catch (error: unknown) {
      if (closePendingRef.current !== pendingToken) return;
      const message =
        error instanceof Error
          ? error.message
          : `The terminal could not be ${live ? "ended" : "removed"}.`;
      setLifecycleError({ terminalId, message });
      announce(message);
    } finally {
      if (closePendingRef.current === pendingToken) {
        closePendingRef.current = undefined;
        setLifecyclePendingId((current) =>
          current === terminalId ? undefined : current,
        );
      }
    }
  };

  const requestClose = (terminalId: string) => {
    if (closePendingRef.current) return;
    const terminal = resource(terminalId);
    if (
      getConfirmTerminalTermination() &&
      (!terminal || isTerminalProcessLive(terminal.lifecycle))
    ) {
      setLifecycleConfirmation({
        terminalId,
        label: terminal?.displayName ?? "Terminal",
        terminal,
      });
      return;
    }
    void endOrRemove(terminalId, terminal);
  };

  const rename = async (terminalId: string, displayName: string) => {
    const terminal = resource(terminalId);
    if (!terminal) throw new Error("The terminal is no longer available.");
    const renameThreadId = terminal.threadId;
    const fingerprint = JSON.stringify({
      revision: terminal.lifecycleRevision,
      displayName,
    });
    const existing = renameMutationIdsRef.current.get(terminalId);
    const mutationId =
      existing?.fingerprint === fingerprint
        ? existing.mutationId
        : crypto.randomUUID();
    renameMutationIdsRef.current.set(terminalId, { fingerprint, mutationId });
    try {
      const result = await applicationStore.api.renameTerminal(terminalId, {
        mutationId,
        expectedRevision: terminal.lifecycleRevision,
        displayName,
      });
      if (
        !result.terminal ||
        result.terminal.terminalId !== terminalId ||
        result.terminal.threadId !== renameThreadId
      )
        throw new Error("The renamed terminal could not be verified.");
      renameMutationIdsRef.current.delete(terminalId);
      if (resourceThreadRef.current !== renameThreadId) return;
      setResource(result.terminal);
      announce(`${result.terminal.displayName} terminal renamed.`);
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      renameMutationIdsRef.current.delete(terminalId);
      try {
        const authoritativeTerminal =
          await applicationStore.api.readTerminal(terminalId);
        if (
          resourceThreadRef.current === renameThreadId &&
          authoritativeTerminal.terminalId === terminalId &&
          authoritativeTerminal.threadId === renameThreadId
        ) {
          setResource(authoritativeTerminal);
        } else {
          throw new Error("The terminal is no longer available.");
        }
      } catch {
        throw new Error(
          "The terminal changed elsewhere, but its latest name could not be loaded. Try again to refresh it.",
        );
      }
      throw new Error(
        "The terminal changed elsewhere. Review its latest name and try again.",
      );
    }
  };

  // A terminal summary change can mean another client ended a terminal: the
  // authoritative inventory drops tabs whose terminals are gone.
  useEffect(() => {
    if (
      !terminalSummary ||
      !authoritative ||
      !connected ||
      tabIds.length === 0
    )
      return;
    const generation = ++inventoryGenerationRef.current;
    let disposed = false;
    void applicationStore.api
      .listTerminals(threadId)
      .then((result) => {
        if (disposed || generation !== inventoryGenerationRef.current) return;
        const current = result.terminals.filter(
          (terminal) => terminal.threadId === threadId,
        );
        const currentIds = new Set(current.map((terminal) => terminal.terminalId));
        const latest = store.terminalPanel();
        const removedTabs = (
          latest?.threadId === threadId ? latest.tabs : []
        ).filter(({ terminalId }) => !currentIds.has(terminalId));
        if (
          removedTabs.some(({ terminalId }) => terminalId === latest?.activeTerminalId)
        )
          setSessionState(undefined);
        setResources(
          () => new Map(current.map((terminal) => [terminal.terminalId, terminal])),
        );
        setLookupFailures((failures) => {
          let next = failures;
          for (const { terminalId } of removedTabs)
            next = withoutMapKey(next, terminalId);
          return next;
        });
        for (const { terminalId } of removedTabs) store.closeTerminalTab(terminalId);
        if (removedTabs.length > 0) {
          const first = resources.get(removedTabs[0]!.terminalId);
          announce(
            removedTabs.length === 1
              ? `${first?.displayName ?? "Terminal"} ended. Its retained terminal history was removed.`
              : `${removedTabs.length} terminals ended. Their retained terminal history was removed.`,
          );
        }
      })
      .catch(() => {
        // Summary invalidation is advisory. A failed inventory refresh must
        // not speculate that any local terminal was removed; the next summary
        // change or explicit roster refresh retries from authoritative HTTP.
      });
    return () => {
      disposed = true;
    };
    // The tab IDs are compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationStore, authoritative, connected, terminalSummary, tabKey, threadId]);

  // Tabs restored from storage, or opened by ID, look their terminals up.
  useEffect(() => {
    const missing = tabIds.filter((terminalId) => {
      const cached = resources.get(terminalId);
      return (
        (!cached || cached.threadId !== threadId) &&
        !lookupFailures.has(terminalId) &&
        !pendingLookupsRef.current.has(`${threadId}:${terminalId}`)
      );
    });
    for (const terminalId of missing) {
      const lookupThreadId = threadId;
      const lookupKey = `${lookupThreadId}:${terminalId}`;
      pendingLookupsRef.current.add(lookupKey);
      void applicationStore.api
        .readTerminal(terminalId)
        .then((terminal) => {
          if (!mountedRef.current || resourceThreadRef.current !== lookupThreadId)
            return;
          if (terminal.threadId !== lookupThreadId) {
            setLookupFailures((current) =>
              new Map(current).set(terminalId, {
                kind: "gone",
                message: "That terminal belongs to a different thread.",
              }),
            );
            return;
          }
          setResources((current) => {
            const cached = current.get(terminal.terminalId);
            if (
              cached?.threadId === lookupThreadId &&
              cached.lifecycleRevision >= terminal.lifecycleRevision
            )
              return current;
            return new Map(current).set(terminal.terminalId, terminal);
          });
          setLookupFailures((current) => withoutMapKey(current, terminal.terminalId));
        })
        .catch((error: unknown) => {
          if (mountedRef.current && resourceThreadRef.current === lookupThreadId) {
            setLookupFailures((current) =>
              new Map(current).set(terminalId, terminalLookupFailure(error)),
            );
          }
        })
        .finally(() => {
          pendingLookupsRef.current.delete(lookupKey);
        });
    }
    // The tab IDs are compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationStore, tabKey, lookupRevision, resources]);

  return {
    panelRef,
    resources,
    lookupFailures,
    sessionState,
    lifecyclePendingId,
    lifecycleError,
    lifecycleConfirmation,
    confirmTermination,
    setSessionState,
    resource,
    noteResource: (terminal) => {
      setResource(terminal);
      setLookupFailures((current) => withoutMapKey(current, terminal.terminalId));
    },
    setResource,
    retryLookup: (terminalId) => {
      setLookupFailures((current) => withoutMapKey(current, terminalId));
      setLookupRevision((current) => current + 1);
    },
    open: (terminal, region) => {
      if (terminal.threadId !== threadId) {
        announce("That terminal belongs to a different thread.");
        return false;
      }
      setResource(terminal);
      setSessionState(undefined);
      if (
        store.openTerminalTab(terminal.terminalId, {
          focus: true,
          ...(region ? { region } : {}),
        })
      )
        return true;
      announce(
        "The terminal was created, but its panel could not be opened in this layout.",
      );
      return false;
    },
    activate: (terminalId) => {
      setSessionState(undefined);
      store.activateTerminalTab(terminalId);
    },
    removeFromClient,
    dispositionOf,
    requestClose,
    endOrRemove,
    closeView,
    dismissLifecycleConfirmation: () => setLifecycleConfirmation(undefined),
    rename,
  };
}

function terminalLookupFailure(error: unknown): TerminalLookupFailure {
  if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
    return { kind: "gone", message: error.message };
  }
  return {
    kind: "transient",
    message: error instanceof Error ? error.message : "The request failed.",
  };
}
