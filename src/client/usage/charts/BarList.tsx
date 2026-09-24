import type { ReactNode } from "react";

export interface BarListRow {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | null;
  readonly icon?: ReactNode;
  readonly value: number;
  readonly display: string;
  readonly secondary?: string | null;
  readonly color?: string;
  readonly muted?: boolean;
  readonly selected?: boolean;
  readonly badge?: string | null;
}

/**
 * Ranked horizontal bars for one nominal dimension. One hue for every row
 * unless a row carries its chart series color; length carries magnitude.
 */
export function BarList({ rows, total, onSelect, emptyText = "No recorded usage", label }: {
  readonly rows: readonly BarListRow[];
  readonly total: number;
  readonly onSelect?: (id: string) => void;
  readonly emptyText?: string;
  readonly label: string;
}) {
  if (!rows.length) return <p className="usage-empty-note">{emptyText}</p>;
  const largest = Math.max(...rows.map((row) => row.value), 0);
  return (
    <ol className="usage-bar-list" aria-label={label}>
      {rows.map((row) => {
        const share = total > 0 ? row.value / total : 0;
        const content = (
          <>
            <span className="usage-bar-name">
              {row.icon ? <span className="usage-bar-icon" aria-hidden="true">{row.icon}</span> : null}
              <span className="usage-bar-text">
                <span className="usage-bar-label" title={row.label}>{row.label}</span>
                {row.badge ? <span className="usage-bar-badge">{row.badge}</span> : null}
                {row.detail ? <small title={row.detail}>{row.detail}</small> : null}
              </span>
            </span>
            <span className="usage-bar-figures">
              <strong>{row.display}</strong>
              <small>{row.secondary ?? `${Math.round(share * 1000) / 10}%`}</small>
            </span>
            <span className="usage-bar-track" aria-hidden="true">
              <i style={{ width: `${largest > 0 ? Math.max(row.value > 0 ? 1.5 : 0, (row.value / largest) * 100) : 0}%`, background: row.color }}
                data-muted={row.muted ? "true" : undefined} />
            </span>
          </>
        );
        return (
          <li key={row.id}>
            {onSelect ? (
              <button type="button" className="usage-bar-row" aria-pressed={row.selected ?? false} onClick={() => onSelect(row.id)}
                title={row.selected ? `Remove ${row.label} filter` : `Filter to ${row.label}`}>{content}</button>
            ) : <div className="usage-bar-row">{content}</div>}
          </li>
        );
      })}
    </ol>
  );
}
