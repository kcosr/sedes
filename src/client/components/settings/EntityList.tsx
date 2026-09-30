import "./settings.css";
import { useId } from "react";

/** A list of entities (environments, backends, clients); each row opens its detail. */
export function EntityList({ children, ...props }: React.ComponentProps<"ul">): React.JSX.Element {
  return <ul data-slot="entity-list" role="list" {...props}>{children}</ul>;
}

export type EntityRowProps = Omit<React.ComponentProps<"li">, "title" | "onSelect"> & {
  readonly title: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  /** A leading icon, usually the entity's kind. */
  readonly icon?: React.ReactNode;
  /** Tag slot: fixed attributes such as the kind or "Default". */
  readonly tags?: React.ReactNode;
  /** StatusPill slot: the one live state of the entity. */
  readonly status?: React.ReactNode;
  /** Trailing slot, outside the row's main button: a kebab menu. */
  readonly actions?: React.ReactNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  /** Makes the row a link (routes); `onSelect` can still intercept the click. */
  readonly href?: string;
  readonly onSelect?: (event: React.MouseEvent<HTMLElement>) => void;
};

/**
 * One row of an EntityList, at least 56px tall. The row is one button (or
 * link) holding the icon, title, subtitle, tags and status, so the whole row
 * opens the entity; it is named by the title and described by the rest. The
 * actions slot sits beside it as its own tab stop.
 */
export function EntityRow({
  title,
  subtitle,
  icon,
  tags,
  status,
  actions,
  selected = false,
  disabled = false,
  href,
  onSelect,
  ...props
}: EntityRowProps): React.JSX.Element {
  const id = useId();
  const titleId = `${id}title`;
  const subtitleId = subtitle ? `${id}subtitle` : undefined;
  const metaId = tags || status ? `${id}meta` : undefined;
  const naming = {
    "aria-labelledby": titleId,
    "aria-describedby": [subtitleId, metaId].filter(Boolean).join(" ") || undefined,
  };
  const content = (
    <>
      {icon ? <span data-slot="entity-row-icon" aria-hidden="true">{icon}</span> : null}
      <span data-slot="entity-row-text">
        <span id={titleId} data-slot="entity-row-title">{title}</span>
        {subtitle ? (
          <span id={subtitleId} data-slot="entity-row-subtitle" title={typeof subtitle === "string" ? subtitle : undefined}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {metaId ? <span id={metaId} data-slot="entity-row-meta">{tags}{status}</span> : null}
    </>
  );
  return (
    <li data-slot="entity-row" data-selected={selected || undefined} data-disabled={disabled || undefined} {...props}>
      {href !== undefined && !disabled ? (
        <a data-slot="entity-row-main" href={href} aria-current={selected ? "page" : undefined} onClick={onSelect} {...naming}>
          {content}
        </a>
      ) : (
        <button
          type="button"
          data-slot="entity-row-main"
          aria-current={selected ? "true" : undefined}
          disabled={disabled}
          onClick={onSelect}
          {...naming}
        >
          {content}
        </button>
      )}
      {actions ? <div data-slot="entity-row-actions">{actions}</div> : null}
    </li>
  );
}
