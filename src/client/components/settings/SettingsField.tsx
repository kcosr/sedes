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
  /** Props for the Switch itself, such as a test id. */
  readonly switchProps?: Omit<
    React.ComponentProps<typeof Switch>,
    "checked" | "defaultChecked" | "onCheckedChange" | "name" | "disabled"
  > & { readonly "data-testid"?: string };
  /** Content under the row (for example the options of an enabled setting). */
  readonly children?: React.ReactNode;
};

/** An on/off settings row: label and help on the left, a Switch on the right, at every width. */
export function SwitchField({
  checked,
  defaultChecked,
  onCheckedChange,
  name,
  disabled,
  switchProps,
  children,
  ...props
}: SwitchFieldProps): React.JSX.Element {
  const field = (
    <Field data-slot="switch-field" orientation="horizontal" disabled={disabled} {...props}>
      <Switch
        {...switchProps}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        name={name}
        disabled={disabled}
      />
    </Field>
  );
  if (children === undefined || children === null || children === false) return field;
  return (
    <div data-slot="switch-field-group">
      {field}
      <div data-slot="switch-field-options">{children}</div>
    </div>
  );
}

export type SettingsActionRowProps = Omit<React.ComponentProps<"div">, "title"> & {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Buttons for the item, primary last. */
  readonly actions?: React.ReactNode;
};

/**
 * A row that is not a form control: an item (a paired device, a saved
 * connection) or a tool, with its buttons on the right. It sits between
 * field rows with the same hairlines.
 */
export function SettingsActionRow({
  title,
  description,
  actions,
  children,
  ...props
}: SettingsActionRowProps): React.JSX.Element {
  return (
    <div data-slot="settings-action-row" {...props}>
      <div data-slot="settings-action-row-text">
        <p data-slot="settings-action-row-title">{title}</p>
        {description ? <p data-slot="settings-action-row-description">{description}</p> : null}
        {children}
      </div>
      {actions ? <div data-slot="settings-action-row-actions">{actions}</div> : null}
    </div>
  );
}
