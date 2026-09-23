/** Trend line for a stat tile: de-emphasized history with an accented latest point. */
export function Sparkline({ values }: { readonly values: readonly number[] }) {
  if (values.length < 2) return null;
  const maximum = Math.max(...values), minimum = Math.min(0, ...values);
  const range = maximum - minimum || 1;
  const x = (index: number) => (index / (values.length - 1)) * 100;
  const y = (value: number) => 26 - ((value - minimum) / range) * 22;
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join("");
  const last = values.length - 1;
  return (
    <svg className="usage-sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={`${path}L100,28L0,28Z`} className="usage-sparkline-area" />
      <path d={path} className="usage-sparkline-line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last)} cy={y(values[last]!)} r={2.4} className="usage-sparkline-dot" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
