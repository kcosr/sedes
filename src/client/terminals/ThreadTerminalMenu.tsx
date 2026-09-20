import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Plus,
  Pencil,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { TerminalResource } from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import { getPanelPresentation } from "../app/settings.js";
import { Input } from "../components/ui/input.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { isTerminalProcessLive, terminalStatusLabel, terminalTerminationLabel, terminalTerminationDescription, terminalTerminationPendingLabel } from "./domain.js";
import {
  resolvePanelPresentation,
  type PanelPresentation,
} from "../workspace-panels/panel-presentation.js";

interface LifecycleConfirmation {
  readonly terminal: TerminalResource;
  readonly action: "end" | "remove";
}

export interface ThreadTerminalMenuHandle {
  open(presentation: PanelPresentation, invoker: HTMLElement | null): void;
  create(invoker: HTMLElement | null): void;
}

export interface ThreadTerminalMenuProps {
  readonly active?: boolean;
  readonly ref?: React.Ref<ThreadTerminalMenuHandle>;
  readonly threadId: string;
  readonly triggerVariant?: "tab" | "panel";
  readonly displayedTerminalIds?: ReadonlySet<string>;
  readonly api: Pick<
    ApiClient,
    "listTerminals" | "createTerminal" | "endTerminal" | "deleteTerminal"
  >;
  readonly onOpen: (
    terminal: TerminalResource,
    presentation?: PanelPresentation,
  ) => void;
  readonly onRename: (terminalId: string, displayName: string) => Promise<void>;
  readonly onReveal?: (presentation: PanelPresentation) => boolean;
  readonly onResourceChange?: (terminal: TerminalResource) => void;
  readonly onDelete?: (terminalId: string) => void;
}

export type ThreadTerminalControls = Omit<
  ThreadTerminalMenuProps,
  "threadId" | "triggerVariant" | "displayedTerminalIds" | "ref"
>;

export function ThreadTerminalMenu({
  active = true,
  ref,
  threadId,
  triggerVariant = "tab",
  displayedTerminalIds,
  api,
  onOpen,
  onRename,
  onReveal,
  onResourceChange,
  onDelete,
}: ThreadTerminalMenuProps): React.JSX.Element {
  const tabMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const entryInvokerRef = useRef<HTMLElement | null>(null);
  const entryPanelOpenedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<TerminalResource>();
  const [renameDraft, setRenameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [entryFailureOpen, setEntryFailureOpen] = useState(false);
  const [terminals, setTerminals] = useState<readonly TerminalResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [entryPending, setEntryPending] = useState(false);
  const [entryRetryPresentation, setEntryRetryPresentation] =
    useState<PanelPresentation>();
  const [lifecycleConfirmation, setLifecycleConfirmation] =
    useState<LifecycleConfirmation>();
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const createMutationId = useRef<string | null>(null);
  const selectedPresentation = useRef<PanelPresentation | undefined>(undefined);
  const lifecycleMutationAttempts = useRef(
    new Map<string, { readonly mutationId: string; readonly revision: number }>(),
  );
  const suppressCloseAutoFocus = useRef(false);
  const skipNextOpenRefresh = useRef(false);
  const entryPendingRef = useRef(false);
  const creatingRef = useRef(false);
  const refreshRequestId = useRef(0);
  const currentThreadIdRef = useRef(threadId);
  const onResourceChangeRef = useRef(onResourceChange);
  currentThreadIdRef.current = threadId;
  onResourceChangeRef.current = onResourceChange;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await api.listTerminals(threadId, signal);
      if (
        currentThreadIdRef.current !== threadId ||
        refreshRequestId.current !== requestId
      ) return undefined;
      const owned = result.terminals.filter((terminal) => terminal.threadId === threadId);
      setTerminals(owned);
      for (const terminal of owned) onResourceChangeRef.current?.(terminal);
      return owned;
    } catch (error: unknown) {
      if (
        !signal?.aborted &&
        currentThreadIdRef.current === threadId &&
        refreshRequestId.current === requestId
      ) setMessage(errorMessage(error));
      return undefined;
    } finally {
      if (
        currentThreadIdRef.current === threadId &&
        refreshRequestId.current === requestId
      ) setLoading(false);
    }
  }, [api, threadId]);

  useEffect(() => {
    setOpen(false);
    setRenameTarget(undefined);
    setRenamePending(false);
    setRenameError(undefined);
    setEntryFailureOpen(false);
    setLifecycleConfirmation(undefined);
    setLifecyclePending(false);
    setLifecycleError(undefined);
    setTerminals([]);
    setLoading(false);
    setCreating(false);
    setEntryPending(false);
    setEntryRetryPresentation(undefined);
    setMessage(undefined);
    refreshRequestId.current += 1;
    createMutationId.current = null;
    creatingRef.current = false;
    entryPendingRef.current = false;
    selectedPresentation.current = undefined;
    lifecycleMutationAttempts.current.clear();
    suppressCloseAutoFocus.current = false;
    skipNextOpenRefresh.current = false;
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    if (skipNextOpenRefresh.current) {
      skipNextOpenRefresh.current = false;
      return;
    }
    setEntryRetryPresentation(undefined);
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  const presentationForEntry = (shiftKey = false): PanelPresentation | undefined =>
    triggerVariant === "tab"
      ? undefined
      : resolvePanelPresentation(getPanelPresentation(), shiftKey);

  const showMenuWithoutRefresh = () => {
    if (triggerVariant === "panel") {
      setEntryFailureOpen(true);
      return;
    }
    if (open) {
      skipNextOpenRefresh.current = false;
      return;
    }
    skipNextOpenRefresh.current = true;
    setOpen(true);
  };

  const create = async (presentation?: PanelPresentation): Promise<boolean> => {
    if (creatingRef.current) return false;
    const actionThreadId = threadId;
    const menuWasOpen = open;
    creatingRef.current = true;
    setCreating(true);
    setMessage(undefined);
    createMutationId.current ??= crypto.randomUUID();
    try {
      const result = await api.createTerminal(threadId, {
        mutationId: createMutationId.current,
        displayName: "Terminal",
        rows: 24,
        columns: 80,
      });
      if (!result.terminal) throw new Error("The terminal was not created.");
      if (result.terminal.threadId !== threadId)
        throw new Error("The created terminal belongs to a different thread.");
      if (currentThreadIdRef.current !== actionThreadId) return false;
      createMutationId.current = null;
      setTerminals((current) => [
        result.terminal!,
        ...current.filter(({ terminalId }) => terminalId !== result.terminal!.terminalId),
      ]);
      onResourceChange?.(result.terminal);
      suppressCloseAutoFocus.current = menuWasOpen;
      setOpen(false);
      entryPanelOpenedRef.current = true;
      if (presentation === undefined) onOpen(result.terminal);
      else onOpen(result.terminal, presentation);
      return true;
    } catch (error: unknown) {
      if (currentThreadIdRef.current === actionThreadId) {
        setMessage(errorMessage(error));
      }
      return false;
    } finally {
      if (currentThreadIdRef.current === actionThreadId) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  const openFromPrimaryTrigger = async (presentation: PanelPresentation) => {
    if (entryPendingRef.current || creatingRef.current) return;
    const actionThreadId = threadId;
    entryPendingRef.current = true;
    setEntryPending(true);
    setEntryRetryPresentation(undefined);
    try {
      const owned = await refresh();
      if (currentThreadIdRef.current !== actionThreadId) return;
      if (!owned) {
        setEntryRetryPresentation(presentation);
        showMenuWithoutRefresh();
        return;
      }
      const terminal = owned.find(({ incarnationId }) => incarnationId !== null);
      if (terminal) {
        entryPanelOpenedRef.current = true;
        onOpen(terminal, presentation);
        return;
      }
      if (!await create(presentation)) {
        if (currentThreadIdRef.current !== actionThreadId) return;
        setEntryRetryPresentation(presentation);
        showMenuWithoutRefresh();
      }
    } finally {
      if (currentThreadIdRef.current === actionThreadId) {
        entryPendingRef.current = false;
        setEntryPending(false);
      }
    }
  };

  const activatePrimaryTrigger = (presentation: PanelPresentation) => {
    if (onReveal?.(presentation)) return;
    void openFromPrimaryTrigger(presentation);
  };

  useImperativeHandle(ref, () => ({
    create: (invoker) => {
      if (creatingRef.current || entryPendingRef.current) return;
      entryInvokerRef.current = invoker;
      entryPanelOpenedRef.current = false;
      const actionThreadId = threadId;
      void create(presentationForEntry()).then((created) => {
        if (!created && currentThreadIdRef.current === actionThreadId)
          showMenuWithoutRefresh();
      });
    },
    open: (presentation, invoker) => {
      entryInvokerRef.current = invoker;
      entryPanelOpenedRef.current = false;
      activatePrimaryTrigger(presentation);
    },
  }));

  const restoreEntryFocus = (event: Event) => {
    if (triggerVariant !== "panel") return;
    event.preventDefault();
    if (!entryPanelOpenedRef.current) entryInvokerRef.current?.focus();
    entryPanelOpenedRef.current = false;
  };

  const tearDown = async (confirmation: LifecycleConfirmation) => {
    if (lifecyclePending) return;
    const actionThreadId = threadId;
    setLifecyclePending(true);
    setLifecycleError(undefined);
    setMessage(undefined);
    const terminal = confirmation.terminal;
    const key = `${confirmation.action}:${terminal.terminalId}`;
    const existing = lifecycleMutationAttempts.current.get(key);
    const mutationId = existing?.revision === terminal.lifecycleRevision
      ? existing.mutationId
      : crypto.randomUUID();
    lifecycleMutationAttempts.current.set(key, {
      mutationId,
      revision: terminal.lifecycleRevision,
    });
    try {
      const request = {
        mutationId,
        expectedRevision: terminal.lifecycleRevision,
      };
      if (confirmation.action === "end") {
        await api.endTerminal(terminal.terminalId, request);
      } else {
        await api.deleteTerminal(terminal.terminalId, request);
      }
      if (currentThreadIdRef.current !== actionThreadId) return;
      lifecycleMutationAttempts.current.delete(key);
      setTerminals((current) =>
        current.filter(({ terminalId }) => terminalId !== terminal.terminalId),
      );
      setLifecycleConfirmation(undefined);
      onDelete?.(terminal.terminalId);
    } catch (error: unknown) {
      if (currentThreadIdRef.current !== actionThreadId) return;
      const failure = errorMessage(error);
      const refreshed = await refresh();
      if (currentThreadIdRef.current !== actionThreadId) return;
      const current = refreshed?.find(
        ({ terminalId }) => terminalId === terminal.terminalId,
      );
      if (current) {
        setLifecycleConfirmation({
          terminal: current,
          action: isTerminalProcessLive(current.lifecycle) ? "end" : "remove",
        });
      }
      setLifecycleError(failure);
    } finally {
      if (currentThreadIdRef.current === actionThreadId) {
        setLifecyclePending(false);
      }
    }
  };

  return (
    <>
      {triggerVariant === "tab" ? <div className="thread-terminal-tab-menu">
        <DropdownMenu
          open={active && open}
          onOpenChange={(nextOpen) => {
            if (nextOpen && entryPendingRef.current) return;
            selectedPresentation.current = undefined;
            setOpen(nextOpen);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={tabMenuTriggerRef}
              variant="ghost"
              size="icon-sm"
              className="terminal-tab-add"
              aria-label="Open terminal tab"
              disabled={entryPending}
            >
              <Plus size={16} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="thread-terminal-menu"
            align="end"
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              if (!suppressCloseAutoFocus.current) return;
              event.preventDefault();
              suppressCloseAutoFocus.current = false;
            }}
          >
          <DropdownMenuLabel>Terminals</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={creating}
            onPointerDown={(event) => {
              selectedPresentation.current = presentationForEntry(event.shiftKey);
            }}
            onPointerCancel={() => {
              selectedPresentation.current = undefined;
            }}
            onSelect={(event) => {
              event.preventDefault();
              const presentation =
                selectedPresentation.current ?? presentationForEntry();
              selectedPresentation.current = undefined;
              void create(presentation);
            }}
          >
            <Plus size={15} aria-hidden="true" />
            {creating ? "Creating…" : "New terminal"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {loading && terminals.length === 0 ? (
            <DropdownMenuItem disabled>Loading terminals…</DropdownMenuItem>
          ) : terminals.length === 0 ? (
            <DropdownMenuItem disabled>No terminals for this thread</DropdownMenuItem>
          ) : (
            terminals.map((terminal) => {
              const alreadyDisplayed =
                displayedTerminalIds?.has(terminal.terminalId) === true;
              const live = isTerminalProcessLive(terminal.lifecycle);
              return (
                <div className="thread-terminal-menu-row" key={terminal.terminalId}>
                  <DropdownMenuItem
                    className="thread-terminal-menu-entry"
                    disabled={terminal.incarnationId === null || alreadyDisplayed}
                    title={
                      alreadyDisplayed
                        ? "Already open in this terminal panel"
                        : undefined
                    }
                    onSelect={() => {
                      const presentation =
                        selectedPresentation.current ?? presentationForEntry();
                      selectedPresentation.current = undefined;
                      suppressCloseAutoFocus.current = true;
                      if (presentation === undefined) onOpen(terminal);
                      else onOpen(terminal, presentation);
                    }}
                    onPointerDown={(event) => {
                      selectedPresentation.current = presentationForEntry(
                        event.shiftKey,
                      );
                    }}
                    onPointerCancel={() => {
                      selectedPresentation.current = undefined;
                    }}
                  >
                    <TerminalIcon size={15} aria-hidden="true" />
                    <span className="thread-terminal-menu-name">{terminal.displayName}</span>
                    <span className="thread-terminal-menu-status">
                      {terminalStatusLabel(terminal)}
                      {alreadyDisplayed ? " · Open" : ""}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="thread-terminal-menu-rename"
                    aria-label={`Rename ${terminal.displayName}`}
                    onSelect={() => {
                      suppressCloseAutoFocus.current = true;
                      setRenameTarget(terminal);
                      setRenameDraft(terminal.displayName);
                      setRenameError(undefined);
                    }}
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="thread-terminal-menu-teardown"
                    variant="destructive"
                    aria-label={terminal.terminationEffect === "disconnect_transport" && live ? `Disconnect and remove ${terminal.displayName}` : `Tear down and remove ${terminal.displayName}`}
                    title={terminal.terminationEffect === "disconnect_transport" && live ? `Disconnect and remove ${terminal.displayName}` : `Tear down and remove ${terminal.displayName}`}
                    onSelect={() => {
                      suppressCloseAutoFocus.current = true;
                      setLifecycleError(undefined);
                      setLifecycleConfirmation({
                        terminal,
                        action: live ? "end" : "remove",
                      });
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                  </DropdownMenuItem>
                </div>
              );
            })
          )}
          {message ? <DropdownMenuItem disabled>{message}</DropdownMenuItem> : null}
          {entryRetryPresentation ? (
            <DropdownMenuItem
              onSelect={() => {
                activatePrimaryTrigger(entryRetryPresentation);
              }}
            >
              Retry
            </DropdownMenuItem>
          ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div> : null}

      <Dialog open={active && entryFailureOpen} onOpenChange={setEntryFailureOpen}>
        <DialogContent onCloseAutoFocus={restoreEntryFocus}>
          <DialogHeader>
            <DialogTitle>Could not open Terminals</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryFailureOpen(false)}>Cancel</Button>
            <Button disabled={entryPending || creating} onClick={() => {
              setEntryFailureOpen(false);
              if (entryRetryPresentation) activatePrimaryTrigger(entryRetryPresentation);
            }}>Retry</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && Boolean(renameTarget)} onOpenChange={(nextOpen) => {
        if (!nextOpen && !renamePending) setRenameTarget(undefined);
      }}>
        <DialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          tabMenuTriggerRef.current?.focus();
        }}>
          <DialogHeader>
            <DialogTitle>Rename terminal</DialogTitle>
            <DialogDescription>Choose a name for this terminal.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!renameTarget || renamePending || !renameDraft.trim()) return;
            const actionThreadId = threadId;
            setRenamePending(true);
            setRenameError(undefined);
            void onRename(renameTarget.terminalId, renameDraft.trim()).then(() => {
              if (currentThreadIdRef.current === actionThreadId) setRenameTarget(undefined);
            }).catch((error: unknown) => {
              if (currentThreadIdRef.current === actionThreadId) setRenameError(errorMessage(error));
            }).finally(() => {
              if (currentThreadIdRef.current === actionThreadId) setRenamePending(false);
            });
          }}>
            <Input aria-label="Terminal name" value={renameDraft} maxLength={120}
              disabled={renamePending} onChange={(event) => setRenameDraft(event.target.value)} />
            {renameError ? <p className="terminal-operation-message" role="alert">{renameError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={renamePending} onClick={() => setRenameTarget(undefined)}>Cancel</Button>
              <Button type="submit" disabled={renamePending || !renameDraft.trim()}>{renamePending ? "Saving…" : "Save name"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={active && Boolean(lifecycleConfirmation)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !lifecyclePending) {
            setLifecycleConfirmation(undefined);
            setLifecycleError(undefined);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {lifecycleConfirmation?.action === "end"
                ? `${terminalTerminationLabel(lifecycleConfirmation.terminal)}?`
                : "Remove terminal?"}
            </DialogTitle>
            <DialogDescription>
              {lifecycleConfirmation?.action === "end"
                ? terminalTerminationDescription(lifecycleConfirmation.terminal)
                : `Remove ${lifecycleConfirmation?.terminal.displayName ?? "this terminal"} and permanently delete its retained history?`}
            </DialogDescription>
            {lifecycleError ? (
              <p className="terminal-operation-message" role="alert">
                {lifecycleError}
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={lifecyclePending}
              onClick={() => {
                setLifecycleConfirmation(undefined);
                setLifecycleError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={lifecyclePending}
              onClick={() => {
                const confirmation = lifecycleConfirmation;
                if (confirmation) void tearDown(confirmation);
              }}
            >
              {lifecyclePending
                ? lifecycleConfirmation?.action === "end"
                  ? terminalTerminationPendingLabel(lifecycleConfirmation.terminal)
                  : "Removing…"
                : lifecycleConfirmation?.action === "end"
                  ? terminalTerminationLabel(lifecycleConfirmation.terminal)
                  : "Remove terminal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The terminal operation failed.";
}
