import { Search } from "lucide-react";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuValue,
} from "../components/ui/dropdown-menu.js";
import {
  isTerminalProcessLive,
  terminalConnectionLabel,
  terminalTabId,
  terminalTabPanelId,
  terminalTerminationLabel,
  TerminalPanel,
  TerminalTabs,
  ThreadTerminalMenu,
  type ThreadTerminalControls,
  type ThreadTerminalMenuHandle,
} from "../terminals/index.js";
import { PanelChrome, type PanelChromeControls } from "./PanelChrome.js";
import type { ThreadTerminalPanel } from "./region-store.js";
import type { ThreadTerminals } from "./use-thread-terminals.js";

/**
 * The Terminals panel: a header with the thread's terminal tabs, and the
 * active tab's terminal. The body is retained in the panel's portal target
 * (see PanelLayout), so it stays mounted while the panel is hidden; the
 * terminal renderer itself disconnects while it is not visible.
 */

function terminalReadOnly(
  terminals: ThreadTerminals,
  terminal: ReturnType<ThreadTerminals["resource"]>,
): boolean {
  const session = terminals.sessionState;
  return (
    session?.connection === "ready" &&
    session.caughtUp &&
    session.role === "observer" &&
    !session.controlRequestPending &&
    terminal?.lifecycle === "running"
  );
}

export function TerminalsPanelHeader({
  active,
  threadId,
  panel,
  terminals,
  controls,
  tabMenuRef,
  terminalControls,
}: {
  readonly active: boolean;
  readonly threadId: string;
  readonly panel: ThreadTerminalPanel;
  readonly terminals: ThreadTerminals;
  readonly controls: PanelChromeControls;
  readonly tabMenuRef: React.Ref<ThreadTerminalMenuHandle>;
  readonly terminalControls: ThreadTerminalControls;
}): React.JSX.Element {
  const activeTab = panel.tabs.find(
    ({ terminalId }) => terminalId === panel.activeTerminalId,
  );
  const terminal = activeTab ? terminals.resource(activeTab.terminalId) : undefined;
  const readOnly = terminalReadOnly(terminals, terminal);
  const session = terminals.sessionState;
  const discardInputBlocker = !session
    ? undefined
    : session.connection !== "ready"
      ? terminalConnectionLabel(session)
      : !session.caughtUp
        ? "Catching up"
        : session.role !== "controller"
          ? "Read only"
          : undefined;
  const handle = terminals.panelRef;
  return (
    <PanelChrome
      panelTitle="Terminals"
      leading={
        <div className="terminal-panel-heading">
          <TerminalTabs
            tabs={panel.tabs.map(({ terminalId }) => {
              const resource = terminals.resource(terminalId);
              return {
                terminalId,
                label: resource?.displayName ?? "Terminal",
                closeDisabled: terminals.lifecyclePendingId !== undefined,
                closeLabel: resource && !isTerminalProcessLive(resource.lifecycle)
                  ? `Remove ${resource.displayName} terminal and history`
                  : terminals.confirmTermination
                    ? `Close ${resource?.displayName ?? "Terminal"} terminal`
                    : `${resource?.terminationEffect === "disconnect_transport" ? "Disconnect" : "End"} ${resource?.displayName ?? "Terminal"} terminal and remove history`,
                ...(resource ? { lifecycle: resource.lifecycle } : {}),
                ...(terminalId === panel.activeTerminalId && session
                  ? {
                      connection: session.connection,
                      ...(readOnly ? { readOnly: true } : {}),
                    }
                  : {}),
              };
            })}
            activeTerminalId={panel.activeTerminalId}
            onActivate={terminals.activate}
            onClose={terminals.requestClose}
            onRename={terminals.rename}
          />
          <ThreadTerminalMenu
            active={active}
            ref={tabMenuRef}
            threadId={threadId}
            triggerVariant="tab"
            displayedTerminalIds={
              new Set(
                panel.threadId === threadId
                  ? panel.tabs.map(({ terminalId }) => terminalId)
                  : [],
              )
            }
            {...terminalControls}
          />
        </div>
      }
      panelActions={
        <div className="terminal-panel-chrome-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Search terminal"
            title="Search terminal"
            disabled={!terminal}
            onClick={() => handle.current?.openSearch()}
          >
            <Search size={15} aria-hidden="true" />
          </Button>
        </div>
      }
      controls={{
        ...controls,
        renderMenuItems: (
          <>
            {readOnly ? (
              <>
                <DropdownMenuItem onSelect={() => handle.current?.claimControl()}>
                  Take control
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              disabled={!terminal}
              onSelect={() => handle.current?.openTranscript()}
            >
              Transcript
              {!terminal ? <DropdownMenuValue>No terminal</DropdownMenuValue> : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!terminal}
              onSelect={() => handle.current?.clearSelection()}
            >
              Clear selection
              {!terminal ? <DropdownMenuValue>No terminal</DropdownMenuValue> : null}
            </DropdownMenuItem>
            {session?.retryInputAvailable ? (
              <DropdownMenuItem onSelect={() => handle.current?.retryNotSentInput()}>
                Retry unsent input
              </DropdownMenuItem>
            ) : null}
            {session?.uncertainInputSeq !== undefined ? (
              <DropdownMenuItem
                disabled={discardInputBlocker !== undefined}
                onSelect={() => handle.current?.discardUnconfirmedInput()}
              >
                Discard unconfirmed input
                {discardInputBlocker !== undefined ? (
                  <DropdownMenuValue>{discardInputBlocker}</DropdownMenuValue>
                ) : null}
              </DropdownMenuItem>
            ) : null}
            {session?.connection === "reconnecting" ? (
              <DropdownMenuItem onSelect={() => handle.current?.retryConnection()}>
                Reconnect now
              </DropdownMenuItem>
            ) : null}
          </>
        ),
      }}
    />
  );
}

export function TerminalsPanelBody({
  active,
  visible,
  panel,
  terminals,
  applicationStore,
  onCreate,
}: {
  readonly active: boolean;
  readonly visible: boolean;
  readonly panel: ThreadTerminalPanel;
  readonly terminals: ThreadTerminals;
  readonly applicationStore: ApplicationClientStore;
  /** The empty panel's New terminal, from the header's tab menu. */
  readonly onCreate: (invoker: HTMLElement) => void;
}): React.JSX.Element {
  const activeTab = panel.tabs.find(
    ({ terminalId }) => terminalId === panel.activeTerminalId,
  );
  const terminal = activeTab ? terminals.resource(activeTab.terminalId) : undefined;
  const lookupFailure = activeTab
    ? terminals.lookupFailures.get(activeTab.terminalId)
    : undefined;
  const { lifecycleError } = terminals;
  return (
    <div
      className="workspace-panel-content terminal-panel-body"
      role={activeTab ? "tabpanel" : "region"}
      id={activeTab ? terminalTabPanelId(activeTab.terminalId) : undefined}
      aria-labelledby={activeTab ? terminalTabId(activeTab.terminalId) : undefined}
      aria-label={activeTab ? undefined : "Terminals"}
    >
      {lifecycleError && lifecycleError.terminalId !== activeTab?.terminalId && (
        <p role="alert">{lifecycleError.message}</p>
      )}
      {!activeTab ? (
        <div className="workspace-panel-availability">
          <p>No terminals open</p>
          <Button
            variant="outline"
            size="sm"
            data-workspace-primary-focus="preferred"
            onClick={(event) => onCreate(event.currentTarget)}
          >
            New terminal
          </Button>
        </div>
      ) : terminal ? (
        <TerminalPanel
          key={`${terminal.terminalId}:${terminal.incarnationId}`}
          ref={terminals.panelRef}
          terminal={terminal}
          producerId={activeTab.producerId}
          api={applicationStore.api}
          visible={visible}
          active={active}
          lifecycleError={
            lifecycleError?.terminalId === terminal.terminalId
              ? lifecycleError.message
              : undefined
          }
          onStateChange={terminals.setSessionState}
          onResourceChange={terminals.setResource}
          onRemoved={(terminalId) =>
            terminals.removeFromClient(
              terminalId,
              terminal.displayName,
              terminals.dispositionOf(terminal),
            )
          }
        />
      ) : (
        <div className="workspace-panel-availability" role="status">
          {lifecycleError?.terminalId === activeTab.terminalId && (
            <p role="alert">{lifecycleError.message}</p>
          )}
          {lookupFailure ? (
            <>
              <p>
                {lookupFailure.kind === "gone"
                  ? "This terminal is no longer available."
                  : `Couldn’t load this terminal. ${lookupFailure.message}`}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => terminals.retryLookup(activeTab.terminalId)}
              >
                {lookupFailure.kind === "gone" ? "Re-attempt lookup" : "Retry"}
              </Button>
            </>
          ) : (
            "Loading terminal…"
          )}
        </div>
      )}
    </div>
  );
}

/** Closing a live terminal's tab: keep it running, or end it. */
export function TerminalCloseDialog({
  active,
  terminals,
}: {
  readonly active: boolean;
  readonly terminals: ThreadTerminals;
}): React.JSX.Element {
  const confirmation = terminals.lifecycleConfirmation;
  const terminal = confirmation?.terminal;
  const canEnd = terminal !== undefined && terminal.lifecycle !== "stopping";
  return (
    <Dialog
      open={active && Boolean(confirmation)}
      onOpenChange={(open) => !open && terminals.dismissLifecycleConfirmation()}
    >
      <DialogContent showClose={false}>
        <DialogHeader>
          <DialogTitle>Close terminal?</DialogTitle>
          <DialogDescription>
            {canEnd
              ? terminal.terminationEffect === "disconnect_transport"
                ? `Close ${confirmation!.label} tab and leave the terminal connected, or disconnect the SSH session and remove its history. Remote processes may continue running.`
                : `Close ${confirmation!.label} tab and leave the terminal running, or end the terminal and delete its history.`
              : `Close ${confirmation?.label ?? "Terminal"} tab without ending the terminal.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter
          start={
            canEnd ? (
              <Button
                variant="destructive"
                onClick={() => {
                  const current = confirmation!;
                  terminals.dismissLifecycleConfirmation();
                  void terminals.endOrRemove(current.terminalId, current.terminal);
                }}
              >
                {terminalTerminationLabel(terminal)}
              </Button>
            ) : undefined
          }
        >
          <Button
            variant="outline"
            onClick={terminals.dismissLifecycleConfirmation}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              terminals.dismissLifecycleConfirmation();
              if (confirmation)
                terminals.closeView(confirmation.terminalId, confirmation.label);
            }}
          >
            Close tab
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
