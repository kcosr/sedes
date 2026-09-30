import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Slot } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "./button.js";
import { useFieldControl } from "./control.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";
import {
  menuDescriptionClass,
  menuEmptyClass,
  menuLabelClass,
  menuRowClass,
  menuSeparatorClass,
  menuShortcutClass,
} from "./floating.js";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { cn } from "@client/lib/utils";

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly searchTerms?: readonly string[];
  /** Not selectable: dimmed and skipped by the keyboard. */
  readonly disabled?: boolean;
  /**
   * Selectable but not currently usable: dimmed, with a trailing note
   * ("Unavailable" when true, or the given text).
   */
  readonly unavailable?: boolean | string;
  /** Consecutive options with the same group render under one label. */
  readonly group?: string;
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
  /** Props for the default outline trigger. */
  readonly triggerProps?: ComponentProps<typeof Button> & {
    readonly [attribute: `data-${string}`]: string | undefined;
  };
  /**
   * A custom trigger element (e.g. a composer pill); it receives the
   * combobox role, state and handlers.
   */
  readonly trigger?: ReactElement;
  /** Above the search row, e.g. a title with an action. */
  readonly header?: ReactNode;
  /** Below the options, e.g. "Load more". */
  readonly footer?: ReactNode;
  readonly contentClassName?: string;
  /** "dialog" presents the choices as the shared bottom sheet. */
  readonly presentation?: "popover" | "dialog";
  readonly onValueChange: (value: string) => void;
}

function focusAdjacentTo(
  trigger: HTMLElement | null,
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

/**
 * The one searchable picker: a trigger, then a plain search row over a
 * divider and the options in the menu row anatomy (trailing check for the
 * selection, dimmed unavailable rows, optional groups). At least as wide as
 * its trigger. Search is local, transient presentation state; only
 * selection changes the value.
 */
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
  trigger: customTrigger,
  header,
  footer,
  contentClassName,
  presentation = "popover",
  onValueChange,
}: SearchableSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const openingDirection = useRef<"first" | "last">("first");
  const triggerRef = useRef<HTMLElement>(null);
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

  // Inside a Field, the trigger is the Field's control: its id, error and
  // description wiring, and invalid state.
  const fieldProps = useFieldControl({
    id: triggerProps?.id,
    "aria-describedby": triggerProps?.["aria-describedby"],
    "aria-invalid": triggerProps?.["aria-invalid"],
  });
  const comboboxProps = {
    ...fieldProps,
    type: "button" as const,
    role: "combobox",
    "aria-label": label,
    "aria-expanded": open && !disabled,
    "aria-controls": open ? (presentation === "dialog" ? dialogId : listboxId) : undefined,
    "aria-haspopup": presentation === "dialog" ? ("dialog" as const) : ("listbox" as const),
    disabled,
    title: displayLabel,
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      triggerProps?.onPointerDown?.(event);
      pickerFocus.onPointerDown(event);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      triggerProps?.onKeyDown?.(event);
      pickerFocus.onKeyDown(event);
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      openingDirection.current =
        event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    },
  };
  const trigger = customTrigger ? (
    <Slot.Root {...comboboxProps} ref={triggerRef as Ref<HTMLElement>}>
      {customTrigger}
    </Slot.Root>
  ) : (
    <Button
      {...triggerProps}
      {...comboboxProps}
      ref={triggerRef as Ref<HTMLButtonElement>}
      variant="outline"
      // The form-control box (Input's border, fill and shadow), so a picker
      // matches the fields beside it.
      className={cn(
        "searchable-select-trigger border-input bg-transparent shadow-xs dark:bg-input/30",
        triggerProps?.className,
      )}
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
          layout="sheet"
          size="md"
          className={cn("searchable-select-sheet", contentClassName)}
          aria-describedby={undefined}
          onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            updateOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Choose {label.toLocaleLowerCase()}</DialogTitle>
          </DialogHeader>
          {header}
          {choices}
          {footer}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open && !disabled} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
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
        {header}
        {choices}
        {footer}
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

interface VisibleOption {
  readonly option: SearchableSelectOption;
  readonly index: number;
  readonly matches: boolean;
}

/** Consecutive visible options that share a group label. */
function groupRuns(visible: readonly VisibleOption[]): VisibleOption[][] {
  const runs: VisibleOption[][] = [];
  for (const entry of visible) {
    const run = runs.at(-1);
    if (run && run[0]!.option.group === entry.option.group) run.push(entry);
    else runs.push([entry]);
  }
  return runs;
}

/**
 * The one search rule for pickers: every whitespace-separated term of the
 * query occurs, case-insensitively, somewhere in the texts.
 */
export function matchesSearchQuery(
  query: string,
  texts: readonly string[],
): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = texts.join(" ").toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * The picker's search row: a leading icon and a plain input over a divider,
 * not a bordered form control. Every searchable picker uses it.
 */
export function SearchableSelectSearch(
  props: ComponentProps<"input">,
): React.JSX.Element {
  return (
    <div className="searchable-select-search">
      <Search aria-hidden="true" />
      <input
        type="text"
        autoComplete="off"
        data-slot="searchable-select-input"
        {...props}
      />
    </div>
  );
}

/** Inline searchable choices for popovers, sheets and dialogs. */
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
  const matches = (option: SearchableSelectOption): boolean =>
    matchesSearchQuery(query, [
      option.label,
      option.description ?? "",
      ...(option.searchTerms ?? []),
    ]);
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

  const row = ({ option, index }: VisibleOption) => {
    const unavailable =
      option.unavailable === true ? "Unavailable" : option.unavailable || undefined;
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        id={`${listboxId}-${index}`}
        // The label and description truncate to one line each; the full
        // text stays one hover away.
        title={option.description ? `${option.label}\n${option.description}` : option.label}
        aria-selected={selected}
        aria-disabled={disabled || option.disabled || undefined}
        data-active={active?.option.value === option.value || undefined}
        data-disabled={disabled || option.disabled || undefined}
        data-unavailable={unavailable === undefined ? undefined : ""}
        tabIndex={-1}
        className={cn(
          menuRowClass,
          "shrink-0 data-active:bg-(--hover) aria-selected:font-medium data-unavailable:*:opacity-(--disabled-opacity)",
        )}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse") return;
          if (!disabled && !option.disabled) setActiveValue(option.value);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
      >
        {option.icon && (
          <span
            className="flex shrink-0 items-center text-muted-foreground"
            aria-hidden="true"
          >
            {option.icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{option.label}</span>
          {option.description && (
            <>
              {" "}
              <span
                data-slot="searchable-select-item-description"
                className={cn(menuDescriptionClass, "truncate")}
              >
                {option.description}
              </span>
            </>
          )}
        </span>
        {unavailable && (
          <>
            {" "}
            <span className={cn(menuShortcutClass, "whitespace-nowrap")}>{unavailable}</span>
          </>
        )}
        {selected && (
          <Check className="size-4 text-foreground" aria-hidden="true" />
        )}
      </button>
    );
  };

  return (
    <>
      <SearchableSelectSearch
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
      <div
        className="searchable-select-options"
        id={listboxId}
        role="listbox"
        aria-label={`${label} options`}
      >
        {groupRuns(visible).map((run, runIndex) => {
          const group = run[0]!.option.group;
          if (group === undefined) return <Fragment key={`run-${runIndex}`}>{run.map(row)}</Fragment>;
          const labelId = `${listboxId}-group-${runIndex}`;
          return (
            <Fragment key={`run-${runIndex}`}>
              {runIndex > 0 && <div role="presentation" className={menuSeparatorClass} />}
              <div role="group" aria-labelledby={labelId} className="flex flex-col">
                <div id={labelId} role="presentation" className={menuLabelClass}>
                  {group}
                </div>
                {run.map(row)}
              </div>
            </Fragment>
          );
        })}
        {!visible.some(({ matches }) => matches) && (
          <p role="status" className={cn(menuEmptyClass, "m-0")}>
            {emptyLabel}
          </p>
        )}
      </div>
    </>
  );
}
