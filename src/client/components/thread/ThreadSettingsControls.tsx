import {
  Brain,
  Box,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type {
  NormalizedThreadSnapshot,
  SettingDescriptor,
} from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@client/components/ui/dropdown-menu";
import {
  SearchableSelect,
  SearchableSelectList,
  type SearchableSelectOption,
} from "@client/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { useId, useRef } from "react";

const MODEL_SETTING_ID = "model";

/** The composer pills' shared chrome: a bare pill that washes on hover. */
const PILL_CLASS =
  "gap-1 rounded-full border-transparent bg-transparent px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent [&_svg:not([class*='size-'])]:size-3";

interface SettingState {
  readonly setting: SettingDescriptor;
  readonly value: string;
  readonly selectedLabel?: string;
  readonly placeholder: string;
}

function settingStates(snapshot: NormalizedThreadSnapshot): SettingState[] {
  return snapshot.capabilities.settings.map((setting) => {
    const desiredValue = snapshot.settings.values.find(
      ({ id }) => id === setting.id,
    )?.desiredValue;
    const value = typeof desiredValue === "string" ? desiredValue : "";
    return {
      setting,
      value,
      selectedLabel: setting.options.find((option) => option.value === value)
        ?.label.text,
      placeholder: setting.requiredForFirstSubmission
        ? `Choose ${setting.label.text.toLocaleLowerCase()}…`
        : "Default",
    };
  });
}

function performSetting(
  store: ThreadClientStore,
  settingId: SettingDescriptor["id"],
  next: string,
): void {
  void store
    .perform({ action: "set_setting", settingId, value: next || null })
    .catch(() => undefined);
}

function modelOptions(setting: SettingDescriptor): SearchableSelectOption[] {
  return setting.options.map((option) => ({
    value: option.value,
    label: option.label.text,
    disabled: !option.available,
  }));
}

/**
 * The composer's setting pills (desktop): the model opens the shared
 * searchable picker, every other setting a select. Pills show the bare
 * value ("Low", "Read only"); the accessible name carries the setting name.
 */
export function ThreadSettingsControls({
  store,
  snapshot,
  disabled,
}: {
  store: ThreadClientStore;
  snapshot: NormalizedThreadSnapshot;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div
      className="desktop-config"
      data-testid="thread-configuration"
      aria-label="Thread configuration"
    >
      {settingStates(snapshot).map(
        ({ setting, value, selectedLabel, placeholder }) => {
          const settingDisabled = disabled || !setting.available;
          const control =
            setting.id === MODEL_SETTING_ID ? (
              <SearchableSelect
                label={setting.label.text}
                searchLabel="Search models"
                emptyLabel="No matching models"
                value={value}
                selectedLabel={selectedLabel ?? placeholder}
                options={modelOptions(setting)}
                disabled={settingDisabled}
                onValueChange={(next) => performSetting(store, setting.id, next)}
                trigger={
                  <Button
                    variant="outline"
                    data-slot="model-picker-trigger"
                    className={`h-6 max-w-56 justify-between ${PILL_CLASS}`}
                  >
                    <span data-slot="model-picker-value">
                      {selectedLabel ?? placeholder}
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </Button>
                }
              />
            ) : (
              <Select
                value={value}
                disabled={settingDisabled}
                onValueChange={(next) => performSetting(store, setting.id, next)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={setting.label.text}
                  className={`data-[size=sm]:h-6 ${PILL_CLASS}`}
                >
                  <SelectValue placeholder={placeholder}>
                    {value && selectedLabel ? selectedLabel : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {setting.options.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={!option.available}
                    >
                      {option.label.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          return (
            <span
              key={setting.id}
              className="thread-setting-pill"
              data-setting-id={setting.id}
            >
              {control}
            </span>
          );
        },
      )}
    </div>
  );
}

function SettingIcon({
  id,
}: {
  readonly id: SettingDescriptor["id"];
}): React.JSX.Element {
  if (id === MODEL_SETTING_ID) return <Box aria-hidden="true" />;
  if (id === "thinking_level") return <Brain aria-hidden="true" />;
  if (id === "tool_access") return <ShieldCheck aria-hidden="true" />;
  return <SlidersHorizontal aria-hidden="true" />;
}

/**
 * The thread settings as rows of the Thread actions sheet (touch), where the
 * composer shows no setting pills: each setting drills into its choices as
 * radio rows, and the model hands off to the searchable model sheet.
 */
export function ThreadSettingsMenuItems({
  store,
  snapshot,
  disabled,
  onChooseModel,
}: {
  readonly store: ThreadClientStore;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly disabled: boolean;
  /** Hands off to the model sheet; `viaKeyboard` asks it to focus search. */
  readonly onChooseModel: (viaKeyboard: boolean) => void;
}): React.JSX.Element {
  const keyboardChoice = useRef(false);
  const idPrefix = useId();
  return (
    <>
      {settingStates(snapshot).map(
        ({ setting, value, selectedLabel, placeholder }) => {
          const settingDisabled = disabled || !setting.available;
          // The row is named by the setting; its current value describes it.
          const valueId = `${idPrefix}-${setting.id}`;
          const current = (
            <DropdownMenuShortcut id={valueId} aria-hidden="true">
              {selectedLabel ?? placeholder}
            </DropdownMenuShortcut>
          );
          if (setting.id === MODEL_SETTING_ID) {
            return (
              <DropdownMenuItem
                key={setting.id}
                disabled={settingDisabled}
                aria-haspopup="dialog"
                aria-describedby={valueId}
                title={setting.unavailableReason?.text}
                onPointerDown={() => {
                  keyboardChoice.current = false;
                }}
                onKeyDown={(event) => {
                  keyboardChoice.current =
                    event.key === "Enter" || event.key === " ";
                }}
                onSelect={() => onChooseModel(keyboardChoice.current)}
              >
                <SettingIcon id={setting.id} />
                <span className="min-w-0 flex-1">{setting.label.text}</span>
                {current}
                {/* Leads on to the model sheet, like the drill-in rows. */}
                <ChevronRight aria-hidden="true" />
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuSub key={setting.id}>
              <DropdownMenuSubTrigger
                disabled={settingDisabled}
                aria-describedby={valueId}
                title={setting.unavailableReason?.text}
              >
                <SettingIcon id={setting.id} />
                {/* The label takes the free space so the value sits by the chevron. */}
                <span className="min-w-0 flex-1">{setting.label.text}</span>
                {current}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={value}
                  onValueChange={(next) => {
                    if (next !== value) performSetting(store, setting.id, next);
                  }}
                >
                  {setting.options.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      disabled={!option.available}
                    >
                      {option.label.text}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        },
      )}
    </>
  );
}

/**
 * The searchable model picker as its own sheet, opened from the Thread
 * actions sheet once that sheet has closed. Focus returns to `returnFocusRef`.
 */
export function ThreadModelPickerSheet({
  store,
  snapshot,
  disabled,
  open,
  searchFirst = false,
  onOpenChange,
  returnFocusRef,
}: {
  readonly store: ThreadClientStore;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly disabled: boolean;
  readonly open: boolean;
  /** Opened from the keyboard: focus the search even on touch density. */
  readonly searchFirst?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef: React.RefObject<HTMLElement | null>;
}): React.JSX.Element | null {
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerFocus = usePickerFocus(searchRef);
  const model = settingStates(snapshot).find(
    ({ setting }) => setting.id === MODEL_SETTING_ID,
  );
  if (!model) return null;
  const { setting, value } = model;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="sheet"
        size="md"
        className="searchable-select-sheet"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          if (searchFirst) pickerFocus.requestSearchFocus();
          pickerFocus.onOpenAutoFocus(event);
        }}
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>Choose {setting.label.text.toLocaleLowerCase()}</DialogTitle>
        </DialogHeader>
        <SearchableSelectList
          label={setting.label.text}
          searchLabel="Search models"
          emptyLabel="No matching models"
          value={value}
          options={modelOptions(setting)}
          disabled={disabled || !setting.available}
          searchInputRef={searchRef}
          onValueChange={(next) => {
            performSetting(store, setting.id, next);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
