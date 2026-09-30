import "./settings.css";
import { SettingsSection, type SettingsSectionProps } from "./SettingsSection.js";

export type DangerZoneProps = Omit<SettingsSectionProps, "card" | "title" | "actions"> & {
  readonly title?: React.ReactNode;
};

/**
 * The last section of a page: irreversible actions in a card with a
 * destructive border. Each item's action opens a ConfirmDialog.
 */
export function DangerZone({ title = "Danger zone", ...props }: DangerZoneProps): React.JSX.Element {
  return <SettingsSection data-variant="danger" title={title} card {...props} />;
}

export type DangerZoneItemProps = Omit<React.ComponentProps<"div">, "title"> & {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** The destructive action, usually `<Button variant="destructive">Remove…</Button>`. */
  readonly action: React.ReactNode;
};

export function DangerZoneItem({ title, description, action, ...props }: DangerZoneItemProps): React.JSX.Element {
  return (
    <div data-slot="danger-zone-item" {...props}>
      <div data-slot="danger-zone-text">
        <p data-slot="danger-zone-title">{title}</p>
        {description ? <p data-slot="danger-zone-description">{description}</p> : null}
      </div>
      <div data-slot="danger-zone-action">{action}</div>
    </div>
  );
}
