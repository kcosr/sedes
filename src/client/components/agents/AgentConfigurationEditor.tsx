import type {
  NormalizedAgentConfigurationDescriptor,
  NormalizedAgentConfigurationOverrides,
} from "../../../shared/index.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { SwitchField } from "../settings/SettingsField.js";
import { SettingsSection } from "../settings/SettingsSection.js";

export function AgentConfigurationEditor({
  descriptor,
  overrides = descriptor.canonicalOverrides,
  disabled = false,
  onChange,
}: {
  readonly descriptor: NormalizedAgentConfigurationDescriptor;
  readonly overrides?: NormalizedAgentConfigurationOverrides;
  readonly disabled?: boolean;
  readonly onChange: (overrides: NormalizedAgentConfigurationOverrides) => void;
}): React.JSX.Element {
  const overrideById = new Map(
    overrides.map((override) => [override.id, override]),
  );

  const replace = (fieldId: string, value?: string): void => {
    const next = descriptor.fields.flatMap((field) => {
      if (field.id === fieldId) {
        return value === undefined ? [] : [{ id: field.id, value }];
      }
      const current = overrideById.get(field.id);
      return current ? [current] : [];
    });
    onChange(next);
  };

  return (
    <SettingsSection
      title="Agent configuration"
      description="Override only the settings this Agent should carry between targets."
      card
    >
      {descriptor.fields.map((field) => {
        const override = overrideById.get(field.id);
        const currentOption = field.options.find(
          ({ value }) => value === override?.value,
        );
        const currentValue = override?.value ?? "";
        const defaultLabel = labelForValue(
          field.currentDefaultValue,
          field.options,
        );
        const resolvedLabel = labelForValue(field.resolvedValue, field.options);
        return (
          <SwitchField
            key={field.id}
            label={field.label.text}
            description={
              <>
                {field.description ? (
                  <span className="agent-configuration-description">
                    {field.description.text}
                  </span>
                ) : null}
                <span className="agent-configuration-description">
                  {defaultLabel
                    ? `Current target default: ${defaultLabel}`
                    : "This target has no complete default."}
                </span>
              </>
            }
            checked={Boolean(override)}
            disabled={disabled}
            switchProps={{ "aria-label": `Override ${field.label.text}` }}
            onCheckedChange={(checked) => {
              if (!checked) {
                replace(field.id);
                return;
              }
              const initial =
                field.resolvedValue ??
                field.currentDefaultValue ??
                field.options.find(({ available }) => available)?.value;
              if (initial) replace(field.id, initial);
            }}
          >
            {override ? (
              <Select
                value={currentValue}
                disabled={disabled}
                onValueChange={(value) => replace(field.id, value)}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={field.label.text}
                  aria-describedby={`${field.id}-resolved-value`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={!option.available}
                    >
                      {option.label.text}
                    </SelectItem>
                  ))}
                  {currentValue && !currentOption && (
                    <SelectItem value={currentValue} disabled>
                      {currentValue} (unavailable)
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            ) : null}
            <p
              id={`${field.id}-resolved-value`}
              className="agent-configuration-resolved"
            >
              Resolved value: {resolvedLabel ?? "Unavailable"}
            </p>
          </SwitchField>
        );
      })}
    </SettingsSection>
  );
}

function labelForValue(
  value: string | null,
  options: NormalizedAgentConfigurationDescriptor["fields"][number]["options"],
): string | undefined {
  if (value === null) return undefined;
  return options.find((option) => option.value === value)?.label.text ?? value;
}
