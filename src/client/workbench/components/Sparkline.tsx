import { cx } from "../lib/cx";

export interface SparklineProps {
  values: readonly number[];
  /** Accessible description ("Requests per day, last 14 days: 1,284 today"). */
  label: string;
  /** "bars" (columns: de-emphasised, the last one in the accent) or "line". */
  variant?: "bars" | "line" | undefined;
  width?: number | undefined;
  height?: number | undefined;
  className?: string | undefined;
}

/**
 * Tiny trend for table cells and tiles (fixed size, no axes, no tooltip).
 * Colours come from CSS (--wb-deemph, --wb-accent), so it follows the theme.
 */
export function Sparkline({
  values,
  label,
  variant = "bars",
  width = 80,
  height = 20,
  className,
}: SparklineProps) {
  const n = values.length;
  const finite = values.map((v) => (Number.isFinite(v) ? v : 0));
  const max = Math.max(0, ...finite);
  const min = Math.min(0, ...finite);
  const span = max - min || 1;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  let body = null;
  if (n > 0 && variant === "bars") {
    const slot = width / n;
    const gap = Math.min(2, Math.max(1, slot * 0.25));
    const bw = Math.max(1, slot - gap);
    body = finite.map((v, i) => {
      const h = v > 0 && max > 0 ? Math.max(1.5, (v / max) * (height - 1)) : 1;
      return (
        <rect
          key={i}
          className={cx(
            "wb-spark-bar",
            i === n - 1 && "is-last",
            !(v > 0) && "is-zero",
          )}
          x={i * slot + gap / 2}
          y={height - h}
          width={bw}
          height={h}
          rx={Math.min(1.5, bw / 2)}
        />
      );
    });
  } else if (n > 0) {
    const step = n > 1 ? (width - 2) / (n - 1) : 0;
    const pts = finite.map((v, i) => [1 + i * step, y(v)] as const);
    const d = pts
      .map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`)
      .join("");
    const last = pts[pts.length - 1];
    body = (
      <>
        <path
          className="wb-spark-area"
          d={`${d}L${(1 + (n - 1) * step).toFixed(1)} ${height}L1 ${height}Z`}
        />
        <path className="wb-spark-line" d={d} />
        {last ? (
          <circle className="wb-spark-dot" cx={last[0]} cy={last[1]} r={1.75} />
        ) : null}
      </>
    );
  }
  return (
    <svg
      className={cx("wb-spark", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {body}
    </svg>
  );
}
