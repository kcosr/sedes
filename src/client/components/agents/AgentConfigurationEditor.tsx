import type {
  NormalizedAgentConfigurationDescriptor,
  NormalizedAgentConfigurationOverrides,
} from "../../../shared/index.js";
import { Checkbox } from "@client/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";

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
    <section
      className="agent-editor-section"
      aria-labelledby="agent-configuration-title"
    >
      <header>
        <h2 id="agent-configuration-title">Agent configuration</h2>
        <p>
          Override only the settings this Agent should carry between targets.
        </p>
      </header>
      <div className="agent-configuration-fields">
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
            <fieldset className="agent-configuration-field" key={field.id}>
              <legend>{field.label.text}</legend>
              {field.description && <p>{field.description.text}</p>}
              <label className="agent-editor-toggle">
                <span>
                  <strong>Override target default</strong>
                  <small id={`${field.id}-target-default`}>
                    {defaultLabel
                      ? `Current target default: ${defaultLabel}`
                      : "This target has no complete default."}
                  </small>
                </span>
                <Checkbox
                  aria-label={`Override ${field.label.text}`}
                  aria-describedby={`${field.id}-target-default`}
                  checked={Boolean(override)}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    if (checked !== true) {
                      replace(field.id);
                      return;
                    }
                    const initial =
                      field.resolvedValue ??
                      field.currentDefaultValue ??
                      field.options.find(({ available }) => available)?.value;
                    if (initial) replace(field.id, initial);
                  }}
                />
              </label>
              {override && (
                <Select
                  value={currentValue}
                  disabled={disabled}
                  onValueChange={(value) => replace(field.id, value)}
                >
                  <SelectTrigger
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
              )}
              <small
                id={`${field.id}-resolved-value`}
                className="agent-configuration-resolved"
              >
                Resolved value: {resolvedLabel ?? "Unavailable"}
              </small>
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}

function labelForValue(
  value: string | null,
  options: NormalizedAgentConfigurationDescriptor["fields"][number]["options"],
): string | undefined {
  if (value === null) return undefined;
  return options.find((option) => option.value === value)?.label.text ?? value;
}
