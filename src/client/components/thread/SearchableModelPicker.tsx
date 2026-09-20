import { usePickerFocus } from "../../lib/use-picker-focus.js";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SettingDescriptor } from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { Check, ChevronDown, Search } from "lucide-react";

type ModelOption = SettingDescriptor["options"][number];

export function SearchableModelPicker({
  setting,
  value,
  disabled,
  variant,
  onValueChange,
}: {
  setting: SettingDescriptor;
  value: string;
  disabled: boolean;
  variant: "row" | "pill";
  onValueChange: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string>();
  const searchInput = useRef<HTMLInputElement>(null);
  const pickerFocus = usePickerFocus(searchInput);
  const openingDirection = useRef<"first" | "last">("first");
  const contentId = useId();
  const listboxId = useId();
  const selectedOption = setting.options.find(
    (option) => option.value === value,
  );
  const selectedLabel = selectedOption?.label.text;
  const placeholder = setting.requiredForFirstSubmission
    ? `Choose ${setting.label.text.toLocaleLowerCase()}…`
    : "Default";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingOptions = useMemo(
    () =>
      setting.options
        .map((option, originalIndex) => ({ option, originalIndex }))
        .filter(({ option }) =>
          normalizedQuery.length === 0
            ? true
            : option.label.text
                .toLocaleLowerCase()
                .includes(normalizedQuery),
        ),
    [normalizedQuery, setting.options],
  );
  const availableOptions = useMemo(
    () => matchingOptions.filter(({ option }) => option.available),
    [matchingOptions],
  );

  useEffect(() => {
    if (!open) return;
    setActiveValue((current) => {
      if (
        current &&
        availableOptions.some(({ option }) => option.value === current)
      ) {
        return current;
      }
      if (
        selectedOption?.available &&
        availableOptions.some(
          ({ option }) => option.value === selectedOption.value,
        )
      ) {
        return selectedOption.value;
      }
      return openingDirection.current === "last"
        ? availableOptions.at(-1)?.option.value
        : availableOptions[0]?.option.value;
    });
  }, [availableOptions, open, selectedOption]);

  const updateOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setActiveValue(undefined);
      openingDirection.current = "first";
    }
  };

  const choose = (option: ModelOption): void => {
    if (!option.available) return;
    onValueChange(option.value);
    updateOpen(false);
  };

  const moveActive = (direction: 1 | -1): void => {
    if (availableOptions.length === 0) return;
    const currentIndex = availableOptions.findIndex(
      ({ option }) => option.value === activeValue,
    );
    const nextIndex =
      currentIndex < 0
        ? direction === 1
          ? 0
          : availableOptions.length - 1
        : (currentIndex + direction + availableOptions.length) %
          availableOptions.length;
    setActiveValue(availableOptions[nextIndex]?.option.value);
  };

  const activeOption = matchingOptions.find(
    ({ option }) => option.value === activeValue,
  );
  const activeOptionId = activeOption
    ? `${listboxId}-option-${activeOption.originalIndex}`
    : undefined;

  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({
      block: "nearest",
    });
  }, [activeOptionId]);

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          role="combobox"
          variant="outline"
          aria-label={setting.label.text}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-haspopup="listbox"
          disabled={disabled}
          title={selectedLabel}
          data-slot="model-picker-trigger"
          data-picker-variant={variant}
          className={
            variant === "pill"
              ? "h-6 max-w-56 justify-between gap-1 rounded-full border-transparent bg-transparent px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent [&_svg:not([class*='size-'])]:size-3"
              : "h-8 w-fit min-w-0 justify-between gap-2 px-3 text-sm font-normal"
          }
          onPointerDown={pickerFocus.onPointerDown}
          onKeyDown={(event) => {
            pickerFocus.onKeyDown(event);
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            openingDirection.current =
              event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }}
        >
          <span data-slot="model-picker-value">
            {selectedLabel ?? placeholder}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        align="start"
        sideOffset={6}
        aria-label={`Choose ${setting.label.text.toLocaleLowerCase()}`}
        data-model-picker-content=""
        className="model-picker-popover"
        onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          updateOpen(false);
        }}
      >
        <div className="model-picker-search">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <Input
            ref={searchInput}
            type="search"
            value={query}
            aria-label="Search models"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            placeholder="Search models"
            onChange={(event) => {
              openingDirection.current = "first";
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveValue(availableOptions[0]?.option.value);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveValue(availableOptions.at(-1)?.option.value);
              } else if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                const option = availableOptions.find(
                  (candidate) => candidate.option.value === activeValue,
                )?.option;
                if (option) choose(option);
              }
            }}
          />
        </div>
        <div
          id={listboxId}
          className="model-picker-options"
          role="listbox"
          aria-label={`${setting.label.text} options`}
        >
          {matchingOptions.map(({ option, originalIndex }) => {
            const active = option.value === activeValue;
            return (
              <button
                type="button"
                id={`${listboxId}-option-${originalIndex}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={!option.available}
                data-active={active || undefined}
                tabIndex={-1}
                onPointerMove={(event) => {
                  if (event.pointerType === "mouse" && option.available) {
                    setActiveValue(option.value);
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <span>{option.label.text}</span>
                {option.value === value && (
                  <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                )}
              </button>
            );
          })}
          {matchingOptions.length === 0 && (
            <p className="model-picker-empty" role="status">
              No matching models
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
