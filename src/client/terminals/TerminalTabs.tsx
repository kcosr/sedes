import { useEffect, useRef, useState } from "react";
import { LockKeyhole, MoreHorizontal, X } from "lucide-react";
import type { TerminalResource } from "../../shared/index.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import type { TerminalConnectionState } from "./terminal-session.js";

export interface TerminalTabItem {
  readonly terminalId: string;
  readonly label: string;
  readonly closeLabel?: string;
  readonly closeDisabled?: boolean;
  readonly lifecycle?: TerminalResource["lifecycle"];
  /** Present only for the locally attached, active terminal tab. */
  readonly connection?: TerminalConnectionState;
  /** True only after the active attachment is confirmed to be read-only. */
  readonly readOnly?: boolean;
}

export interface TerminalTabsProps {
  readonly tabs: readonly TerminalTabItem[];
  readonly activeTerminalId: string | null;
  readonly onActivate: (terminalId: string) => void;
  readonly onClose: (terminalId: string) => void;
  readonly onRename: (terminalId: string, displayName: string) => Promise<void>;
}

export function TerminalTabs({
  tabs,
  activeTerminalId,
  onActivate,
  onClose,
  onRename,
}: TerminalTabsProps): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameGenerationRef = useRef(0);
  const restoreFocusIdRef = useRef<string | undefined>(undefined);
  const touchContextMenuRef = useRef(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string>();

  useEffect(() => {
    activeRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTerminalId]);

  useEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  useEffect(() => {
    if (renamingId || !restoreFocusIdRef.current) return;
    const terminalId = restoreFocusIdRef.current;
    restoreFocusIdRef.current = undefined;
    requestAnimationFrame(() =>
      document.getElementById(terminalTabId(terminalId))?.focus(),
    );
  }, [renamingId]);

  useEffect(() => {
    if (!renamingId || tabs.some(({ terminalId }) => terminalId === renamingId))
      return;
    renameGenerationRef.current += 1;
    setRenamingId(undefined);
    setRenamePending(false);
    setRenameError(undefined);
  }, [renamingId, tabs]);

  const beginRename = (tab: TerminalTabItem) => {
    renameGenerationRef.current += 1;
    setRenamingId(tab.terminalId);
    setRenameDraft(tab.label);
    setRenamePending(false);
    setRenameError(undefined);
  };

  const cancelRename = (terminalId: string, restoreFocus = true) => {
    renameGenerationRef.current += 1;
    setRenamingId(undefined);
    setRenamePending(false);
    setRenameError(undefined);
    if (restoreFocus) restoreFocusIdRef.current = terminalId;
  };

  const commitRename = async (
    tab: TerminalTabItem,
    restoreFocus: boolean,
  ) => {
    if (renamePending) return;
    const displayName = renameDraft.trim();
    if (!displayName || displayName === tab.label) {
      cancelRename(tab.terminalId, restoreFocus);
      return;
    }
    const generation = ++renameGenerationRef.current;
    setRenamePending(true);
    setRenameError(undefined);
    try {
      await onRename(tab.terminalId, displayName);
      if (renameGenerationRef.current !== generation) return;
      setRenamingId(undefined);
      setRenamePending(false);
      if (restoreFocus) restoreFocusIdRef.current = tab.terminalId;
    } catch (error: unknown) {
      if (renameGenerationRef.current !== generation) return;
      setRenamePending(false);
      setRenameError(
        error instanceof Error
          ? error.message
          : "The terminal could not be renamed.",
      );
      if (restoreFocus) {
        requestAnimationFrame(() => {
          renameInputRef.current?.focus();
          renameInputRef.current?.select();
        });
      }
    }
  };

  const move = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === "Delete") {
      event.preventDefault();
      if (!tabs[index]!.closeDisabled) onClose(tabs[index]!.terminalId);
      return;
    } else return;

    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    onActivate(next.terminalId);
    requestAnimationFrame(() =>
      document.getElementById(terminalTabId(next.terminalId))?.focus(),
    );
  };

  return (
    <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
      {tabs.map((tab, index) => {
        const active = tab.terminalId === activeTerminalId;
        const status = terminalTabStatus(tab);
        const renaming = tab.terminalId === renamingId;
        return (
          <div
            className="terminal-tab"
            data-active={active || undefined}
            key={tab.terminalId}
          >
            {renaming ? (
              <input
                ref={renameInputRef}
                className="terminal-tab-rename-input"
                aria-label={`Rename ${tab.label}`}
                aria-invalid={renameError ? "true" : undefined}
                aria-describedby={
                  renameError
                    ? terminalTabRenameErrorId(tab.terminalId)
                    : undefined
                }
                value={renameDraft}
                maxLength={120}
                disabled={renamePending}
                onChange={(event) => setRenameDraft(event.currentTarget.value)}
                onBlur={() => void commitRename(tab, false)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename(tab.terminalId);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    void commitRename(tab, true);
                  }
                }}
              />
            ) : (
              <ContextMenu>
                <div
                  className="terminal-tab-context-target"
                  onPointerDownCapture={(event) => {
                    touchContextMenuRef.current =
                      event.pointerType === "touch" ||
                      event.pointerType === "pen";
                    if (touchContextMenuRef.current) event.stopPropagation();
                  }}
                  onContextMenuCapture={(event) => {
                    if (!touchContextMenuRef.current) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <ContextMenuTrigger asChild>
                    <button
                      ref={active ? activeRef : undefined}
                      type="button"
                      role="tab"
                      id={terminalTabId(tab.terminalId)}
                      aria-controls={terminalTabPanelId(tab.terminalId)}
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      title={tab.label}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ContextMenu" ||
                          (event.key === "F10" && event.shiftKey)
                        ) {
                          event.preventDefault();
                          touchContextMenuRef.current = false;
                          const bounds =
                            event.currentTarget.getBoundingClientRect();
                          event.currentTarget.dispatchEvent(
                            new MouseEvent("contextmenu", {
                              bubbles: true,
                              clientX: bounds.left + Math.min(bounds.width, 16),
                              clientY: bounds.bottom,
                            }),
                          );
                          return;
                        }
                        move(event, index);
                      }}
                      onClick={() => onActivate(tab.terminalId)}
                    >
                      <span className="terminal-tab-label">{tab.label}</span>
                      {status ? (
                        <span
                          className="terminal-tab-status"
                          data-status={status.kind}
                          role="img"
                          aria-label={status.label}
                          title={status.label}
                        >
                          {status.kind === "read-only" ? (
                            <LockKeyhole
                              size={11}
                              strokeWidth={2.2}
                              aria-hidden="true"
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  </ContextMenuTrigger>
                </div>
                <ContextMenuContent data-testid="terminal-tab-context-menu">
                  <ContextMenuItem onSelect={() => beginRename(tab)}>
                    Rename
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
            {!renaming ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="terminal-tab-actions"
                    aria-label={`Terminal actions for ${tab.label}`} tabIndex={active ? 0 : -1}>
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => beginRename(tab)}>Rename</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {!renaming ? (
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={tab.closeLabel ?? `Close ${tab.label} terminal`}
                title={tab.closeLabel ?? `Close ${tab.label} terminal`}
                disabled={tab.closeDisabled}
                tabIndex={active ? 0 : -1}
                onClick={() => onClose(tab.terminalId)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
            {renaming && renameError ? (
              <span
                className="sr-only"
                id={terminalTabRenameErrorId(tab.terminalId)}
                role="alert"
              >
                {renameError}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function terminalTabRenameErrorId(terminalId: string): string {
  return `${terminalTabId(terminalId)}-rename-error`;
}

function terminalTabStatus(
  tab: TerminalTabItem,
): { readonly kind: string; readonly label: string } | undefined {
  if (
    tab.lifecycle === "failed" ||
    tab.lifecycle === "interrupted" ||
    tab.lifecycle === "exited"
  ) {
    return {
      kind: tab.lifecycle,
      label: `Terminal ${tab.lifecycle}`,
    };
  }
  if (tab.connection === "reconnecting")
    return { kind: "reconnecting", label: "Terminal reconnecting" };
  if (tab.connection === "failed")
    return { kind: "failed", label: "Terminal connection failed" };
  if (tab.readOnly)
    return {
      kind: "read-only",
      label: "Read only — controlled by another client",
    };
  return undefined;
}

export function terminalTabId(terminalId: string): string {
  return `terminal-tab-${domIdFragment(terminalId)}`;
}

export function terminalTabPanelId(terminalId: string): string {
  return `terminal-tabpanel-${domIdFragment(terminalId)}`;
}

function domIdFragment(value: string): string {
  return [...value]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join("-");
}
