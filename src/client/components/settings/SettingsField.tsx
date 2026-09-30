import "./settings.css";
import { Field, type FieldProps } from "@client/components/ui/field";
import { Switch } from "@client/components/ui/switch";

export type SettingsFieldProps = Omit<FieldProps, "orientation"> & {
  /** `stacked` keeps the control under the label (textareas, tables). */
  readonly layout?: "row" | "stacked";
};

/**
 * A settings row: label and help on the left, the control in a 220–360px
 * column on the right. It stacks under the density switch and in a page
 * narrower than 640px.
 */
export function SettingsField({ layout = "row", ...props }: SettingsFieldProps): React.JSX.Element {
  return (
    <Field
      data-slot="settings-field"
      orientation={layout === "row" ? "horizontal" : "vertical"}
      {...props}
    />
  );
}

export type SwitchFieldProps = Omit<FieldProps, "orientation" | "children" | "onChange"> & {
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly name?: string;
};

/** An on/off settings row: label and help on the left, a Switch on the right, at every width. */
export function SwitchField({
  checked,
  defaultChecked,
  onCheckedChange,
  name,
  disabled,
  ...props
}: SwitchFieldProps): React.JSX.Element {
  return (
    <Field data-slot="switch-field" orientation="horizontal" disabled={disabled} {...props}>
      <Switch
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        name={name}
        disabled={disabled}
      />
    </Field>
  );
}
