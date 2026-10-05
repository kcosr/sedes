import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { Library, ListPlus, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTouchDensity } from "@client/app/use-touch-density";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";
import {
  menuDescriptionClass,
  menuEmptyClass,
  menuListRowClass,
  menuRowActionClass,
  menuRowClass,
} from "@client/components/ui/floating";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { SearchableSelectSearch } from "@client/components/ui/searchable-select";
import { cn } from "@client/lib/utils";

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

/**
 * The composer's saved prompts: a searchable list popover above the
 * composer, or the shared bottom sheet under the density switch (opened by a
 * tap, or by swiping up on the Prompts tab). Each row sends its prompt; the
 * trailing action adds it to the composer instead.
 */
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
  const mobile = useTouchDensity();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
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
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog;
    return catalog.filter(
      ({ title, prompt }) =>
        title.toLocaleLowerCase().includes(needle) ||
        prompt.toLocaleLowerCase().includes(needle),
    );
  }, [catalog, query]);

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

  // A vertical swipe on the Prompts tab opens (up) or dismisses (down)
  // without the click that follows the gesture toggling it back.
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
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    swipeRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
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

  // Up and Down keep the column (send or add), Left and Right switch it,
  // Home and End jump to the ends, and Up from the first row returns to the
  // search field.
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
      if (row === 0) searchRef.current?.focus();
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

  const hint =
    currentDraftState === "empty"
      ? "Tap a prompt to send, or add it to the composer"
      : "Tap to send with the current draft, or add it to the composer";

  // The header's trailing action on desktop; the sheet's footer on touch.
  const headerAction = updateAvailable ? (
    <Button
      variant={mobile ? "outline" : "ghost"}
      size={mobile ? "default" : "icon-sm"}
      className={cn(mobile && "h-(--control-default)")}
      aria-label="Refresh saved prompts"
      title="Refresh saved prompts"
      onClick={onApplyUpdate}
    >
      <RefreshCw aria-hidden="true" />
      {mobile && "Refresh"}
    </Button>
  ) : (
    <Button
      variant={mobile ? "outline" : "ghost"}
      size={mobile ? "default" : "sm"}
      className={cn(mobile && "h-(--control-default)")}
      onClick={() => {
        changeOpen(false);
        onManage();
      }}
    >
      Manage
    </Button>
  );

  const list = (listClassName?: string) => (
    <>
      {visibleCatalog.length > 0 && (
        <ul
          className={cn("m-0 flex list-none flex-col p-0", listClassName)}
          aria-label="Saved prompts"
          aria-busy={loading || actionPending}
        >
          {visibleCatalog.map((prompt, index) => (
            <li key={prompt.id} className={menuListRowClass}>
              <button
                ref={(element) => {
                  sendRefs.current[index] = element;
                }}
                type="button"
                className={cn(menuRowClass, "w-auto min-w-0 flex-1")}
                aria-label={`Send prompt: ${prompt.title}`}
                title="Send now"
                disabled={disabled || sendDisabled || actionPending}
                onClick={() => void runPromptAction(onSend, prompt)}
                onKeyDown={(event) => handleActionKeyDown(event, index, "send")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{prompt.title}</span>
                  <span
                    data-slot="composer-prompt-item-description"
                    className={cn(menuDescriptionClass, "truncate")}
                  >
                    {prompt.prompt}
                  </span>
                </span>
              </button>
              <button
                ref={(element) => {
                  appendRefs.current[index] = element;
                }}
                type="button"
                className={menuRowActionClass}
                aria-label={`Add prompt to composer: ${prompt.title}`}
                title="Add to composer"
                disabled={disabled || actionPending}
                onClick={() => void runPromptAction(onAppend, prompt)}
                onKeyDown={(event) =>
                  handleActionKeyDown(event, index, "append")
                }
              >
                <ListPlus aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && catalog.length === 0 && (
        <p className={cn(menuEmptyClass, "m-0")} role="status">
          <LoaderCircle aria-hidden="true" />
          Loading prompts…
        </p>
      )}
      {!loading && !error && catalog.length === 0 && (
        <p className={cn(menuEmptyClass, "m-0")}>
          No saved prompts yet. Use Manage to create one.
        </p>
      )}
      {!loading && catalog.length > 0 && visibleCatalog.length === 0 && (
        <p className={cn(menuEmptyClass, "m-0")}>No matching prompts.</p>
      )}
      {error && (catalog.length > 0 || !loading) && (
        <Callout
          tone="danger"
          role="alert"
          className="shrink-0"
          action={
            <Button variant="outline" size="xs" onClick={() => void onRetry()}>
              {catalog.length === 0 ? "Try again" : "Retry"}
            </Button>
          }
        >
          {error}
        </Callout>
      )}
    </>
  );

  const trigger = (
    <button
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
  );

  const keepFocusAfterAction = (event: Event) => {
    if (!preventCloseAutoFocusRef.current) return;
    preventCloseAutoFocusRef.current = false;
    event.preventDefault();
  };
  const searchInput = <SearchableSelectSearch
    ref={searchRef}
    type="search"
    aria-label="Search saved prompts"
    placeholder="Search prompts"
    value={query}
    onChange={(event) => setQuery(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.key === "ArrowDown" && visibleCatalog.length > 0) {
        event.preventDefault();
        focusPromptAction(0, "send");
      }
    }}
  />;

  if (mobile) {
    return (
      <Dialog open={active && open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          layout="sheet"
          size="md"
          onOpenAutoFocus={(event) => {
            // Open for browsing: the first prompt, never the footer action.
            event.preventDefault();
            focusPromptAction(0, "send");
            const content = event.currentTarget as HTMLElement;
            if (!content.contains(document.activeElement)) content.focus();
          }}
          onCloseAutoFocus={keepFocusAfterAction}
        >
          <DialogHeader>
            <DialogTitle>Saved prompts</DialogTitle>
            <DialogDescription>{hint}</DialogDescription>
          </DialogHeader>
          {searchInput}
          {/* Rows reach into the inset so their text lines up with the title. */}
          <DialogBody>{list("-mx-2")}</DialogBody>
          <DialogFooter>{headerAction}</DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={active && open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="max-h-[min(520px,var(--radix-popover-content-available-height))] w-[min(500px,calc(100vw-16px))] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
        onCloseAutoFocus={keepFocusAfterAction}
      >
        <div className="flex min-w-0 shrink-0 items-start justify-between gap-3 px-3 pt-2.5 pb-2">
          <div className="grid min-w-0 gap-0.5">
            <PopoverTitle id={titleId} className="m-0 leading-5">
              Saved prompts
            </PopoverTitle>
            <PopoverDescription
              id={descriptionId}
              className="m-0 text-(length:--text-meta) leading-4 text-muted-foreground-2"
            >
              {hint}
            </PopoverDescription>
          </div>
          {/* A fixed slot, so swapping Manage for Refresh does not reflow the title. */}
          <div
            data-slot="composer-prompt-header-action"
            className="-mt-1 -mr-1 flex w-20 shrink-0 justify-end"
          >
            {headerAction}
          </div>
        </div>
        {searchInput}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-(--menu-panel-padding)">
          {list()}
        </div>
      </PopoverContent>
    </Popover>
  );
}
