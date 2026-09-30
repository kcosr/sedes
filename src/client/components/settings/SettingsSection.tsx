import "./settings.css";
import { useId } from "react";

export type SettingsSectionProps = Omit<React.ComponentProps<"section">, "title"> & {
  readonly title?: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly actions?: React.ReactNode;
  /** Frame the body as a card. Cards never nest: an inner card renders flat. */
  readonly card?: boolean;
};

/** A titled group of settings rows. Title 15px/600 over a 12px description. */
export function SettingsSection({
  title,
  description,
  actions,
  card = false,
  children,
  ...props
}: SettingsSectionProps): React.JSX.Element {
  const titleId = useId();
  const hasHeader = Boolean(title || description || actions);
  return (
    <section data-slot="settings-section" aria-labelledby={title ? titleId : undefined} {...props}>
      {hasHeader ? (
        <header data-slot="settings-section-header">
          <div data-slot="settings-section-titles">
            {title ? <h2 id={titleId} data-slot="settings-section-title">{title}</h2> : null}
            {description ? <p data-slot="settings-section-description">{description}</p> : null}
          </div>
          {actions ? <div data-slot="settings-section-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div data-slot="settings-section-body" data-card={card || undefined}>{children}</div>
    </section>
  );
}

export type SettingsSubgroupProps = Omit<React.ComponentProps<"div">, "title"> & {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
};

/** A subgroup inside a section (or its card): a 12px heading over a divider. */
export function SettingsSubgroup({
  title,
  description,
  children,
  ...props
}: SettingsSubgroupProps): React.JSX.Element {
  const titleId = useId();
  return (
    <div data-slot="settings-subgroup" role="group" aria-labelledby={titleId} {...props}>
      <h3 id={titleId} data-slot="settings-subgroup-title">{title}</h3>
      {description ? <p data-slot="settings-subgroup-description">{description}</p> : null}
      <div data-slot="settings-section-body">{children}</div>
    </div>
  );
}
