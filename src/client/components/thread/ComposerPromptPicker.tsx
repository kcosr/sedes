import { usePickerFocus } from "../../lib/use-picker-focus.js";
import * as Popover from "@radix-ui/react-popover";
import { Library, ListPlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../../app/use-media-query.js";

export const COMPOSER_PROMPT_PICKER_MOBILE_QUERY =
  "(pointer: coarse), (max-width: 819px)";

const SWIPE_THRESHOLD_PX = 28;
const SWIPE_CLICK_SUPPRESSION_MS = 500;

export type ComposerPromptPickerItem = {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
};

export type ComposerPromptPickerProps = {
  readonly active?: boolean;
  readonly triggerVariant: "tab" | "toolbar";
  /** Ordered, principal-owned prompt library. */
  readonly catalog: readonly ComposerPromptPickerItem[];
  readonly loading: boolean;
  readonly error?: string;
  readonly disabled?: boolean;
  /** Disables delivery without taking away the independently safe Append action. */
  readonly sendDisabled?: boolean;
  readonly currentDraftState: "empty" | "dirty";
  readonly onRetry: () => void | Promise<void>;
  /** Promotes a staged server revision into this open picker. */
  readonly updateAvailable: boolean;
  /** Applies any staged revision, then silently checks for a newer one. */
  readonly onOpen: () => void | Promise<void>;
  readonly onApplyUpdate: () => void;
  /** Inserts the prompt into the composer's current candidate. */
  readonly onAppend: (prompt: ComposerPromptPickerItem) => void | Promise<void>;
  /** Appends the prompt to the current candidate and delivers it. */
  readonly onSend: (prompt: ComposerPromptPickerItem) => void | Promise<void>;
  readonly onManage: () => void;
};

type SwipeState = {
  readonly pointerId: number;
  readonly startY: number;
  currentY: number;
};

export function ComposerPromptPicker({
  active = true,
  triggerVariant,
  catalog,
  loading,
  error,
  disabled = false,
  sendDisabled = false,
  currentDraftState,
  onRetry,
  updateAvailable,
  onOpen,
  onApplyUpdate,
  onAppend,
  onSend,
  onManage,
}: ComposerPromptPickerProps): React.JSX.Element {
  const mobile = useMediaQuery(COMPOSER_PROMPT_PICKER_MOBILE_QUERY);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pickerFocus = usePickerFocus(searchRef);
  const sendRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const appendRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const swipeRef = useRef<SwipeState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | undefined>(undefined);
  const actionGuardRef = useRef(false);
  const preventCloseAutoFocusRef = useRef(false);

  const visibleCatalog = useMemo(() => {
    if (mobile) return catalog;
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog;
    return catalog.filter(
      ({ title, prompt }) =>
        title.toLocaleLowerCase().includes(needle) ||
        prompt.toLocaleLowerCase().includes(needle),
    );
  }, [catalog, mobile, query]);

  useEffect(() => {
    sendRefs.current.length = visibleCatalog.length;
    appendRefs.current.length = visibleCatalog.length;
  }, [visibleCatalog.length]);

  const clearClickSuppression = useCallback(() => {
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== undefined) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = undefined;
    }
  }, []);

  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && !open) {
        void Promise.resolve(onOpen()).catch(() => undefined);
      }
      setOpen(nextOpen);
      if (!nextOpen) {
        setQuery("");
        clearClickSuppression();
      }
    },
    [clearClickSuppression, onOpen, open],
  );

  useEffect(() => clearClickSuppression, [clearClickSuppression]);

  useEffect(() => {
    if (!active || !mobile || !open) return;
    const ownerDocument =
      contentRef.current?.ownerDocument ?? triggerRef.current?.ownerDocument;
    if (!ownerDocument) return;

    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        contentRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      preventCloseAutoFocusRef.current = true;
      changeOpen(false);
    };

    ownerDocument.addEventListener(
      "pointerdown",
      dismissOnOutsidePointerDown,
      true,
    );
    return () =>
      ownerDocument.removeEventListener(
        "pointerdown",
        dismissOnOutsidePointerDown,
        true,
      );
  }, [active, changeOpen, mobile, open]);

  const runPromptAction = useCallback(
    async (
      action: (prompt: ComposerPromptPickerItem) => void | Promise<void>,
      prompt: ComposerPromptPickerItem,
    ) => {
      if (disabled || actionGuardRef.current) return;
      actionGuardRef.current = true;
      preventCloseAutoFocusRef.current = true;
      setActionPending(true);
      changeOpen(false);
      try {
        await action(prompt);
      } finally {
        // Retain the guard beyond a synchronous callback so a double click or
        // synthetic click following pointer-up cannot apply the prompt twice.
        window.setTimeout(() => {
          actionGuardRef.current = false;
          setActionPending(false);
        }, 250);
      }
    },
    [changeOpen, disabled],
  );

  const finishSwipe = useCallback(
    (pointerId: number, target: HTMLElement) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== pointerId) return;
      swipeRef.current = undefined;
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      const distance = swipe.currentY - swipe.startY;
      if (Math.abs(distance) < SWIPE_THRESHOLD_PX) return;
      changeOpen(distance < 0);
      clearClickSuppression();
      suppressClickRef.current = true;
      suppressClickTimerRef.current = window.setTimeout(
        clearClickSuppression,
        SWIPE_CLICK_SUPPRESSION_MS,
      );
    },
    [changeOpen, clearClickSuppression],
  );

  const startSwipe = (event: React.PointerEvent<HTMLElement>) => {
    if (!mobile || disabled || event.button !== 0) return;
    clearClickSuppression();
    event.currentTarget.setPointerCapture(event.pointerId);
    swipeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      currentY: event.clientY,
    };
  };

  const moveSwipe = (event: React.PointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    swipe.currentY = event.clientY;
  };

  const endSwipe = (event: React.PointerEvent<HTMLElement>) => {
    finishSwipe(event.pointerId, event.currentTarget);
  };

  const cancelSwipe = (event: React.PointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    swipeRef.current = undefined;
  };

  const focusPromptAction = (row: number, action: "append" | "send") => {
    const preferred = (action === "send" ? sendRefs : appendRefs).current[row];
    const fallback = (action === "send" ? appendRefs : sendRefs).current[row];
    if (preferred && !preferred.disabled) preferred.focus();
    else if (fallback && !fallback.disabled) fallback.focus();
  };

  const focusRelativeItem = (
    current: number,
    direction: 1 | -1,
    action: "append" | "send",
  ) => {
    if (visibleCatalog.length === 0) return;
    const next =
      (current + direction + visibleCatalog.length) % visibleCatalog.length;
    focusPromptAction(next, action);
  };

  const handleActionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    row: number,
    action: "append" | "send",
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRelativeItem(row, 1, action);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!mobile && row === 0) searchRef.current?.focus();
      else focusRelativeItem(row, -1, action);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusPromptAction(row, action === "append" ? "send" : "append");
    } else if (event.key === "Home") {
      event.preventDefault();
      focusPromptAction(0, action);
    } else if (event.key === "End") {
      event.preventDefault();
      focusPromptAction(visibleCatalog.length - 1, action);
    }
  };

  return (
    <Popover.Root open={active && open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={`composer-prompt-trigger composer-prompt-${triggerVariant}`}
          aria-label="Open saved prompts"
          title={triggerVariant === "toolbar" ? "Saved prompts" : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          data-state={open ? "open" : "closed"}
          onPointerDown={(event) => {
            pickerFocus.onPointerDown(event);
            if (triggerVariant === "tab") startSwipe(event);
          }}
          onKeyDown={pickerFocus.onKeyDown}
          onPointerMove={triggerVariant === "tab" ? moveSwipe : undefined}
          onPointerUp={triggerVariant === "tab" ? endSwipe : undefined}
          onPointerCancel={triggerVariant === "tab" ? cancelSwipe : undefined}
          onClick={(event) => {
            if (!suppressClickRef.current) return;
            event.preventDefault();
            clearClickSuppression();
          }}
        >
          {triggerVariant === "toolbar" ? (
            <Library size={15} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <span>Prompts</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          className="composer-prompt-popover"
          role="dialog"
          aria-label="Saved prompts"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          data-layout={mobile ? "mobile" : "desktop"}
          onEscapeKeyDown={() => changeOpen(false)}
          onOpenAutoFocus={(event) => {
            if (mobile) {
              event.preventDefault();
              requestAnimationFrame(() => focusPromptAction(0, "send"));
            } else {
              pickerFocus.onOpenAutoFocus(event);
            }
          }}
          onCloseAutoFocus={(event) => {
            if (!preventCloseAutoFocusRef.current) return;
            preventCloseAutoFocusRef.current = false;
            event.preventDefault();
          }}
        >
          {mobile && (
            <div
              className="composer-prompt-swipe-handle"
              aria-hidden="true"
              onPointerDown={startSwipe}
              onPointerMove={moveSwipe}
              onPointerUp={endSwipe}
              onPointerCancel={cancelSwipe}
            />
          )}
          <div className="composer-prompt-header">
            <div className="composer-prompt-heading">
              <strong>Saved prompts</strong>
              <small>
                {currentDraftState === "empty"
                  ? "Tap a prompt to send, or add it to the composer"
                  : "Tap to send with the current draft, or add it to the composer"}
              </small>
            </div>
            <div className="composer-prompt-header-action">
              {updateAvailable ? (
                <button
                  type="button"
                  className="composer-prompt-refresh"
                  aria-label="Refresh saved prompts"
                  title="Refresh saved prompts"
                  onClick={onApplyUpdate}
                >
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-prompt-manage"
                  onClick={() => {
                    changeOpen(false);
                    onManage();
                  }}
                >
                  Manage
                </button>
              )}
            </div>
          </div>

          {!mobile && (
            <label className="composer-prompt-search">
              <span className="sr-only">Search saved prompts</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search prompts"
                autoComplete="off"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && visibleCatalog.length > 0) {
                    event.preventDefault();
                    focusPromptAction(0, "send");
                  }
                }}
              />
            </label>
          )}

          <div
            className="composer-prompt-list"
            role="list"
            aria-label="Saved prompts"
            aria-busy={loading || actionPending}
          >
            {visibleCatalog.map((prompt, index) => (
              <div
                key={prompt.id}
                className="composer-prompt-row"
                role="listitem"
              >
                <button
                  ref={(element) => {
                    sendRefs.current[index] = element;
                  }}
                  type="button"
                  className="composer-prompt-preview composer-prompt-send-target"
                  aria-label={`Send prompt: ${prompt.title}`}
                  title="Send now"
                  disabled={disabled || sendDisabled || actionPending}
                  onClick={() => void runPromptAction(onSend, prompt)}
                  onKeyDown={(event) =>
                    handleActionKeyDown(event, index, "send")
                  }
                >
                  <span>{prompt.title}</span>
                  <small>{prompt.prompt}</small>
                </button>
                <div
                  className="composer-prompt-actions"
                  role="group"
                  aria-label={`Actions for ${prompt.title}`}
                >
                  <button
                    ref={(element) => {
                      appendRefs.current[index] = element;
                    }}
                    type="button"
                    className="composer-prompt-action"
                    aria-label={`Add prompt to composer: ${prompt.title}`}
                    title="Add to composer"
                    disabled={disabled || actionPending}
                    onClick={() => void runPromptAction(onAppend, prompt)}
                    onKeyDown={(event) =>
                      handleActionKeyDown(event, index, "append")
                    }
                  >
                    <ListPlus size={16} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}

            {loading && catalog.length === 0 && (
              <p className="composer-prompt-status" role="status">
                Loading prompts…
              </p>
            )}
            {!loading && error && catalog.length === 0 && (
              <div className="composer-prompt-status" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => void onRetry()}>
                  Try again
                </button>
              </div>
            )}
            {!loading && !error && catalog.length === 0 && (
              <p className="composer-prompt-status">
                No saved prompts yet. Use Manage to create one.
              </p>
            )}
            {!loading && catalog.length > 0 && visibleCatalog.length === 0 && (
              <p className="composer-prompt-status">No matching prompts.</p>
            )}
          </div>

          {error && catalog.length > 0 && (
            <div className="composer-prompt-inline-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void onRetry()}>
                Retry
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
