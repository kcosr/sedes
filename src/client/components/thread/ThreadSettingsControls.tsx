import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { SearchableModelPicker } from "./SearchableModelPicker.js";

export function ThreadSettingsControls({
  store,
  snapshot,
  disabled,
  mobile = false,
  variant = "row",
}: {
  store: ThreadClientStore;
  snapshot: NormalizedThreadSnapshot;
  disabled: boolean;
  mobile?: boolean;
  variant?: "row" | "pill";
}): React.JSX.Element {
  const className = mobile ? "mobile-config" : "desktop-config";
  return (
    <div
      className={className}
      data-testid="thread-configuration"
      data-variant={variant}
      aria-label="Thread configuration"
    >
      {snapshot.capabilities.settings.map((setting) => {
        const settingState = snapshot.settings.values.find(
          ({ id }) => id === setting.id,
        );
        const desiredValue = settingState?.desiredValue;
        const value = typeof desiredValue === "string" ? desiredValue : "";
        const selectedLabel = setting.options.find(
          (option) => option.value === value,
        )?.label.text;
        // Pills show the bare value ("Low", "Read only") — the aria-label
        // still carries the setting name for assistive tech.
        const pillLabel =
          variant === "pill" && value && selectedLabel
            ? selectedLabel
            : undefined;
        const performSettingUpdate = (next: string): void => {
          void store
            .perform({
              action: "set_setting",
              settingId: setting.id,
              value: next || null,
            })
            .catch(() => undefined);
        };
        const control = setting.id === "model" ? (
          <SearchableModelPicker
            setting={setting}
            value={value}
            disabled={disabled || !setting.available}
            variant={variant}
            onValueChange={performSettingUpdate}
          />
        ) : (
          <Select
            value={value}
            disabled={disabled || !setting.available}
            onValueChange={performSettingUpdate}
          >
            <SelectTrigger
              size="sm"
              aria-label={setting.label.text}
              className={
                variant === "pill"
                  ? "gap-1 rounded-full border-transparent bg-transparent px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent data-[size=sm]:h-6 [&_svg:not([class*='size-'])]:size-3"
                  : undefined
              }
            >
              <SelectValue
                placeholder={
                  setting.requiredForFirstSubmission
                    ? `Choose ${setting.label.text.toLocaleLowerCase()}…`
                    : "Default"
                }
              >
                {pillLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper">
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
        if (variant === "pill") {
          return (
            <span
              key={setting.id}
              className="thread-setting-pill"
              data-setting-id={setting.id}
            >
              {control}
            </span>
          );
        }
        return (
          <div
            className={mobile ? undefined : "control-select"}
            data-slot="thread-setting-row"
            key={setting.id}
          >
            <span>{setting.label.text}</span>
            {control}
          </div>
        );
      })}
    </div>
  );
}
