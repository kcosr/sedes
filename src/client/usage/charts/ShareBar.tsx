export interface ShareSegment {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly display: string;
  readonly note?: string;
}

/** Part-to-whole bar with a legend that carries every value. */
export function ShareBar({ segments, label }: { readonly segments: readonly ShareSegment[]; readonly label: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);
  return (
    <div className="usage-share">
      <div className="usage-share-bar" role="img" aria-label={`${label}: ${segments.map((segment) => `${segment.label} ${segment.display}`).join(", ")}`}>
        {segments.filter((segment) => segment.value > 0).map((segment) => (
          <i key={segment.id} style={{ flexGrow: segment.value, background: segment.color }} title={`${segment.label}: ${segment.display}`} />
        ))}
        {total === 0 ? <i className="usage-share-empty" /> : null}
      </div>
      <ul className="usage-share-legend">
        {segments.map((segment) => (
          <li key={segment.id}>
            <i style={{ background: segment.color }} aria-hidden="true" />
            <span>{segment.label}</span>
            <strong>{segment.display}</strong>
            <small>{total > 0 ? `${(share(segment.value) * 100).toFixed(share(segment.value) < 0.1 ? 1 : 0)}%` : "—"}</small>
            {segment.note ? <em>{segment.note}</em> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
