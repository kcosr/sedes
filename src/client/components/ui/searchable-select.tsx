import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog.js";
import { useKeyboardInset } from "../../app/use-keyboard-inset.js";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { cn } from "@client/lib/utils";

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly searchTerms?: readonly string[];
  readonly disabled?: boolean;
  /** Reset choices remain reachable even when no catalog entries match. */
  readonly pinned?: boolean;
}

interface SearchableSelectProps {
  readonly label: string;
  readonly searchLabel: string;
  readonly emptyLabel: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly selectedLabel?: string;
  readonly options: readonly SearchableSelectOption[];
  readonly disabled?: boolean;
  readonly fieldLabel?: string;
  readonly triggerProps?: ComponentProps<typeof Button> & {
    readonly [attribute: `data-${string}`]: string | undefined;
  };
  readonly contentClassName?: string;
  readonly presentation?: "popover" | "dialog";
  readonly onValueChange: (value: string) => void;
}

function focusAdjacentTo(
  trigger: HTMLButtonElement | null,
  direction: 1 | -1,
): void {
  if (!trigger) return;
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    ),
  ].filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(":disabled") ||
      element.closest('[hidden], [inert], [aria-hidden="true"], .searchable-select-popover')
    ) return false;
    for (
      let ancestor: HTMLElement | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }).sort((left, right) => (left.tabIndex || Infinity) - (right.tabIndex || Infinity));
  const index = candidates.indexOf(trigger);
  (index >= 0 ? candidates[index + direction] ?? trigger : trigger).focus();
}

/** Search is local, transient presentation state; only selection changes value. */
export function SearchableSelect({
  label,
  searchLabel,
  emptyLabel,
  value,
  placeholder,
  selectedLabel,
  options,
  disabled = false,
  fieldLabel,
  triggerProps,
  contentClassName,
  presentation = "popover",
  onValueChange,
}: SearchableSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const keyboardInset = useKeyboardInset(presentation === "dialog" && open);
  const openingDirection = useRef<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerFocus = usePickerFocus(searchRef);
  const tabDirection = useRef<1 | -1 | undefined>(undefined);
  const listboxId = useId();
  const dialogId = useId();
  const selected = options.find((option) => option.value === value);
  const displayLabel = selectedLabel ?? selected?.label ?? placeholder;
  const updateOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      openingDirection.current = "first";
    }
  };

  useEffect(() => {
    if (disabled) updateOpen(false);
  }, [disabled]);

  const trigger = (
    <Button
      {...triggerProps}
      ref={triggerRef}
      type="button"
      variant="outline"
      role="combobox"
      aria-label={label}
      aria-expanded={open && !disabled}
      aria-controls={open ? (presentation === "dialog" ? dialogId : listboxId) : undefined}
      aria-haspopup={presentation === "dialog" ? "dialog" : "listbox"}
      disabled={disabled}
      title={displayLabel}
      className={cn("searchable-select-trigger", triggerProps?.className)}
      onPointerDown={(event) => {
        triggerProps?.onPointerDown?.(event);
        pickerFocus.onPointerDown(event);
      }}
      onKeyDown={(event) => {
        triggerProps?.onKeyDown?.(event);
        pickerFocus.onKeyDown(event);
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        openingDirection.current =
          event.key === "ArrowUp" ? "last" : "first";
        setOpen(true);
      }}
    >
      <span className="searchable-select-copy">
        {fieldLabel && (
          <span className="searchable-select-field-label">{fieldLabel}</span>
        )}
        <span className="searchable-select-value">
          {selected?.icon && (
            <span className="searchable-select-icon" aria-hidden="true">
              {selected.icon}
            </span>
          )}
          <span>{displayLabel}</span>
        </span>
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </Button>
  );
  const choices = (
    <SearchableSelectList
      label={label}
      searchLabel={searchLabel}
      emptyLabel={emptyLabel}
      value={value}
      options={options}
      disabled={disabled}
      searchInputRef={searchRef}
      listboxId={listboxId}
      initialDirection={openingDirection.current}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        updateOpen(false);
      }}
      {...(presentation === "popover" ? { onTab: (direction: 1 | -1) => {
        tabDirection.current = direction;
        updateOpen(false);
      }} : {})}
    />
  );

  if (presentation === "dialog") {
    return (
      <Dialog open={open && !disabled} onOpenChange={updateOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          id={dialogId}
          placement="side"
          className={cn("searchable-select-dialog", contentClassName)}
          overlayClassName="searchable-select-dialog-overlay"
          aria-describedby={undefined}
          style={{ "--select-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
          onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            updateOpen(false);
          }}
        >
          <DialogTitle className="searchable-select-dialog-title">Choose {label.toLocaleLowerCase()}</DialogTitle>
          {choices}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open && !disabled} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        sideOffset={6}
        aria-label={`Choose ${label.toLocaleLowerCase()}`}
        className={cn("searchable-select-popover", contentClassName)}
        onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
        onCloseAutoFocus={(event) => {
          if (tabDirection.current) {
            event.preventDefault();
            focusAdjacentTo(triggerRef.current, tabDirection.current);
            tabDirection.current = undefined;
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          updateOpen(false);
        }}
      >
        {choices}
      </PopoverContent>
    </Popover>
  );
}

interface SearchableSelectListProps {
  readonly label: string;
  readonly searchLabel: string;
  readonly emptyLabel: string;
  readonly value: string;
  readonly options: readonly SearchableSelectOption[];
  readonly disabled?: boolean;
  readonly searchInputRef?: Ref<HTMLInputElement>;
  readonly listboxId?: string;
  readonly initialDirection?: "first" | "last" | "none";
  readonly onValueChange: (value: string) => void;
  readonly onTab?: (direction: 1 | -1) => void;
}

/** Inline searchable choices for popovers and dialogs. */
export function SearchableSelectList({
  label,
  searchLabel,
  emptyLabel,
  value,
  options,
  disabled = false,
  searchInputRef,
  listboxId: suppliedListboxId,
  initialDirection = "none",
  onValueChange,
  onTab,
}: SearchableSelectListProps): React.JSX.Element {
  const generatedListboxId = useId();
  const listboxId = suppliedListboxId ?? generatedListboxId;
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string>();
  const [openingDirection, setOpeningDirection] = useState(initialDirection);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (option: SearchableSelectOption): boolean => {
    const text = [
      option.label,
      option.description ?? "",
      ...(option.searchTerms ?? []),
    ].join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  };
  const visible = options
    .map((option, index) => ({ option, index, matches: matches(option) }))
    .filter(({ option, matches }) => option.pinned || matches);
  const enabled = visible.filter(({ option }) => !option.disabled);
  const matchingEnabled = enabled.filter(({ matches }) => matches);
  // Derive a valid active option on every render, including catalog updates.
  const active =
    enabled.find(({ option }) => option.value === activeValue) ??
    matchingEnabled.find(({ option }) => option.value === value) ??
    (openingDirection === "none"
      ? undefined
      : openingDirection === "last"
        ? matchingEnabled.at(-1)
        : matchingEnabled[0]);
  const activeId = active ? `${listboxId}-${active.index}` : undefined;

  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  const choose = (option: SearchableSelectOption) => {
    if (disabled || option.disabled) return;
    onValueChange(option.value);
  };

  const move = (direction: 1 | -1) => {
    if (enabled.length === 0) return;
    const index = enabled.findIndex((entry) => entry === active);
    const next = index < 0
      ? direction === 1 ? 0 : enabled.length - 1
      : (index + direction + enabled.length) % enabled.length;
    setActiveValue(enabled[next]!.option.value);
  };

  return (
    <>
      <div className="searchable-select-search">
        <Search size={15} aria-hidden="true" />
        <Input
          ref={searchInputRef}
          disabled={disabled}
          role="combobox"
          aria-label={searchLabel}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          value={query}
          placeholder={searchLabel}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveValue(undefined);
            setOpeningDirection("first");
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (active) choose(active.option);
            } else if (event.key === "Tab" && onTab) {
              // Continue tab navigation from the closed field, without applying search.
              event.preventDefault();
              onTab(event.shiftKey ? -1 : 1);
            }
          }}
        />
      </div>
      <div
        className="searchable-select-options"
        id={listboxId}
        role="listbox"
        aria-label={`${label} options`}
      >
        {visible.map(({ option, index }) => (
          <button
            key={option.value}
            type="button"
            role="option"
            id={`${listboxId}-${index}`}
            aria-selected={option.value === value}
            aria-disabled={disabled || option.disabled || undefined}
            data-active={active?.option.value === option.value || undefined}
            tabIndex={-1}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse") return;
              if (!disabled && !option.disabled) setActiveValue(option.value);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
          >
            {option.icon && (
              <span className="searchable-select-icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span className="searchable-select-option-copy">
              <span>{option.label}</span>
              {option.description && <> <small>{option.description}</small></>}
            </span>
            {option.value === value && (
              <Check size={15} aria-hidden="true" />
            )}
          </button>
        ))}
        {!visible.some(({ matches }) => matches) && (
          <p role="status" className="searchable-select-empty">{emptyLabel}</p>
        )}
      </div>
    </>
  );
}
