import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { BackendBrandIcon } from "../components/brand-icons.js";
import type { UsageAnalyticsDimension } from "../../shared/protocol/usage-analytics.js";
import { Sparkline } from "./charts/Sparkline.js";
import type { DimensionLabel } from "./usage-format.js";
import { formatPercent } from "./usage-format.js";

export function UsageCard({ title, subtitle, actions, children, className, footer }: {
  readonly title: ReactNode; readonly subtitle?: ReactNode; readonly actions?: ReactNode;
  readonly children: ReactNode; readonly className?: string; readonly footer?: ReactNode;
}) {
  return (
    <section className={`usage-card${className ? ` ${className}` : ""}`}>
      <header className="usage-card-header">
        <div className="usage-card-heading">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="usage-card-actions">{actions}</div> : null}
      </header>
      <div className="usage-card-body">{children}</div>
      {footer ? <footer className="usage-card-footer">{footer}</footer> : null}
    </section>
  );
}

export function StatTile({ label, value, change, changeLabel, detail, trend, title }: {
  readonly label: string; readonly value: string; readonly change?: number | null; readonly changeLabel?: string;
  readonly detail?: ReactNode; readonly trend?: readonly number[]; readonly title?: string;
}) {
  const direction = change === undefined || change === null ? null : change > 0.0005 ? "up" : change < -0.0005 ? "down" : "flat";
  return (
    <div className="usage-stat" title={title}>
      <p className="usage-stat-label">{label}</p>
      <p className="usage-stat-value">{value}</p>
      <div className="usage-stat-meta">
        {direction ? (
          <span className="usage-stat-change" data-direction={direction}>
            {direction === "up" ? <ArrowUpRight aria-hidden="true" size={13} /> : direction === "down" ? <ArrowDownRight aria-hidden="true" size={13} /> : null}
            {direction === "flat" ? "No change" : <><span className="sr-only">{direction === "up" ? "Up " : "Down "}</span>{formatPercent(Math.abs(change!))}</>}
            {changeLabel ? <span className="usage-stat-change-label">{changeLabel}</span> : null}
          </span>
        ) : null}
        {detail ? <span className="usage-stat-detail">{detail}</span> : null}
      </div>
      {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
    </div>
  );
}

export interface MenuOption<T extends string> { readonly value: T; readonly label: string; readonly hint?: string }
/** Compact labeled dropdown built on the shared menu primitive. */
export function MenuSelect<T extends string>({ label, value, options, onChange, prefix, align = "start" }: {
  readonly label: string; readonly value: T; readonly options: readonly MenuOption<T>[]; readonly onChange: (value: T) => void;
  readonly prefix?: string; readonly align?: "start" | "end";
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="usage-select" aria-label={`${label}: ${current?.label ?? value}`}>
          {prefix ? <span className="usage-select-prefix">{prefix}</span> : null}
          <span>{current?.label ?? value}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="usage-menu">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span>{option.label}</span>
              {option.hint ? <span className="usage-menu-hint">{option.hint}</span> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two to four mutually exclusive icon or text choices. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  readonly label: string; readonly value: T;
  readonly options: readonly { value: T; label: string; icon?: ReactNode }[]; readonly onChange: (value: T) => void;
}) {
  return (
    <div className="usage-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
          aria-label={option.icon ? option.label : undefined} title={option.icon ? option.label : undefined}
          onClick={() => onChange(option.value)}>
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  );
}

export function DimensionIcon({ dimension, label }: { readonly dimension: UsageAnalyticsDimension; readonly label: DimensionLabel }) {
  if (label.brand && (dimension === "backend" || dimension === "backendKind" || dimension === "thread")) return <BackendBrandIcon brand={label.brand} size={14} />;
  return null;
}

export function Check16() { return <Check aria-hidden="true" size={16} strokeWidth={2.4} />; }
