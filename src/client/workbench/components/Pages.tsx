import { useId } from "react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { FieldProvider } from "./Form";
import { Icon } from "./Icon";
import { useLinkComponent } from "./Link";

/** Settings-style page body: a max-width (~860px) column of cards. Put it in Main (tint). */
export function SettingsPage({
  children,
  center = false,
  className,
}: {
  children: ReactNode;
  /** Centre the column instead of aligning it left. */
  center?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cx("wb-settings", center && "wb-settings--center", className)}
    >
      {children}
    </div>
  );
}

/** One settings card with a heading. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  id,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the heading. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Anchor id (section rails link to it). */
  id?: string | undefined;
  className?: string | undefined;
}) {
  const auto = useId();
  const titleId = `${id ?? `wb-set-${auto}`}-title`;
  return (
    <section
      id={id}
      className={cx("wb-card", "wb-settings-sec", className)}
      aria-labelledby={titleId}
    >
      <div className="wb-settings-sec-head">
        <div className="wb-settings-sec-titles">
          <h2 className="wb-settings-sec-title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="wb-settings-sec-desc">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="wb-settings-sec-body">{children}</div>
    </section>
  );
}

/**
 * Label + help column, control column. The label targets the control inside
 * (Input, Select, Switch, Combobox pick up the id); for a group of controls
 * (Seg, chips) pass `group` so the label names the group instead.
 */
export function SettingsRow({
  label,
  help,
  children,
  id,
  group = false,
  stack = false,
  alignTop = false,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  id?: string | undefined;
  group?: boolean | undefined;
  /** Control column stacks vertically (textareas, chip inputs). */
  stack?: boolean | undefined;
  alignTop?: boolean | undefined;
  className?: string | undefined;
}) {
  const auto = useId();
  const controlId = id ?? `wb-row-${auto}`;
  const labelId = `${controlId}-label`;
  const helpId = help ? `${controlId}-help` : undefined;
  return (
    <div
      className={cx(
        "wb-settings-row",
        (alignTop || stack) && "wb-settings-row--top",
        className,
      )}
    >
      <div className="wb-settings-label">
        {group ? (
          <span id={labelId}>{label}</span>
        ) : (
          <label id={labelId} htmlFor={controlId}>
            {label}
          </label>
        )}
        {help ? (
          <small className="wb-settings-help" id={helpId}>
            {help}
          </small>
        ) : null}
      </div>
      <div
        className={cx(
          "wb-settings-control",
          stack && "wb-settings-control--stack",
        )}
        role={group ? "group" : undefined}
        aria-labelledby={group ? labelId : undefined}
        aria-describedby={group ? helpId : undefined}
      >
        {group ? (
          children
        ) : (
          <FieldProvider
            value={{ id: controlId, describedBy: helpId, invalid: false }}
          >
            {children}
          </FieldProvider>
        )}
      </div>
    </div>
  );
}

/** Surface card (charts, summaries). */
export function Card({
  title,
  subtitle,
  actions,
  children,
  wide = false,
  headAlign = "start",
  className,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Span both columns inside `.wb-cards`. */
  wide?: boolean | undefined;
  /**
   * "center": a one-row header, the actions (a filter, a button) centred
   * against the title and subtitle instead of aligned with the title.
   */
  headAlign?: "start" | "center" | undefined;
  className?: string | undefined;
  id?: string | undefined;
}) {
  const auto = useId();
  const titleId = title ? `${id ?? `wb-card-${auto}`}-title` : undefined;
  return (
    <section
      id={id}
      className={cx("wb-card", wide && "wb-card--wide", className)}
      aria-labelledby={titleId}
    >
      {title || actions ? (
        <div
          className={cx(
            "wb-card-head",
            headAlign === "center" && "wb-card-head--center",
          )}
        >
          <div className="wb-card-titles">
            {title ? (
              <h3 className="wb-card-title" id={titleId}>
                {title}
              </h3>
            ) : null}
            {subtitle ? <div className="wb-card-sub">{subtitle}</div> : null}
          </div>
          {actions ? <div className="wb-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface TileDelta {
  /** "18", "+4.2%". */
  value: ReactNode;
  direction?: "up" | "down" | "flat" | undefined;
  /** true = good (green), false = bad (red), null/undefined = neutral. */
  good?: boolean | null | undefined;
  /** "prior 30 days". */
  vs?: ReactNode;
}

const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;
const SPOKEN = { up: "up", down: "down", flat: "unchanged" } as const;

/** KPI tile: label, big value, delta, optional sparkline slot. Put tiles in `.wb-tiles`. */
export function Tile({
  label,
  value,
  unit,
  delta,
  spark,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: TileDelta | undefined;
  /** A small chart (≤110px wide), bottom-right. */
  spark?: ReactNode;
  className?: string | undefined;
}) {
  const direction = delta?.direction ?? "flat";
  return (
    <div className={cx("wb-tile", className)}>
      <span className="wb-tile-label">{label}</span>
      <div className="wb-tile-row">
        <div className="wb-tile-main">
          <div className="wb-tile-value">
            {value}
            {unit ? <small className="wb-tile-unit">{unit}</small> : null}
          </div>
          {delta ? (
            <span
              className={cx(
                "wb-tile-delta",
                delta.good === true && "is-good",
                delta.good === false && "is-bad",
              )}
            >
              <b>
                <span aria-hidden="true">{ARROWS[direction]} </span>
                <span className="wb-sr-only">{SPOKEN[direction]} </span>
                {delta.value}
              </b>
              {delta.vs ? (
                <>
                  {" "}
                  <span className="wb-tile-vs">vs {delta.vs}</span>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {spark ? <span className="wb-tile-spark">{spark}</span> : null}
      </div>
    </div>
  );
}

/** Header of a full entity page (user, group, service): back link, title, meta, actions, tabs. */
export function PageHeader({
  title,
  back,
  meta,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  back?: { href: string; label: string } | undefined;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Usually <Tabs> or <LinkTabs>; sits on the header's bottom edge. */
  children?: ReactNode;
  className?: string | undefined;
}) {
  const Link = useLinkComponent();
  return (
    <div className={cx("wb-page-head", className)}>
      {back ? (
        <Link href={back.href} className="wb-page-back">
          <Icon name="chevron-left" />
          {back.label}
        </Link>
      ) : null}
      <div className="wb-page-head-top">
        <h1 className="wb-page-title">{title}</h1>
        {actions ? <div className="wb-page-actions">{actions}</div> : null}
      </div>
      {meta ? <div className="wb-page-meta">{meta}</div> : null}
      {children}
    </div>
  );
}

/** Collapsed-by-default details (raw JSON, advanced options). */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <details
      className={cx("wb-disclosure", className)}
      open={defaultOpen || undefined}
    >
      <summary>
        <Icon name="chevron-right" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
