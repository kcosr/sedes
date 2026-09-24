import { useState } from "react";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const STEPS = 6;
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
export const formatHour = (hour: number): string => hourLabel.format(new Date(2026, 0, 5, hour));

/** Weekday by local hour grid on a one-hue sequential ramp. */
export function Heatmap({ cells, format, label }: {
  readonly cells: readonly { weekday: number; hour: number; value: number }[];
  readonly format: (value: number) => string;
  readonly label: string;
}) {
  const [active, setActive] = useState<{ weekday: number; hour: number } | null>(null);
  const values = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell.value]));
  const maximum = Math.max(0, ...cells.map((cell) => cell.value));
  const step = (value: number) => value <= 0 || maximum <= 0 ? 0 : Math.max(1, Math.ceil((value / maximum) * STEPS));
  const activeValue = active ? values.get(`${active.weekday}:${active.hour}`) ?? 0 : 0;
  return (
    <div className="usage-heatmap" aria-label={label} role="img" onPointerLeave={() => setActive(null)}>
      <div className="usage-heatmap-grid">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="usage-heatmap-hour">{hour % 3 === 0 ? formatHour(hour) : ""}</span>
        ))}
        {WEEKDAYS.map((day, weekday) => (
          <div key={day} className="usage-heatmap-row">
            <span className="usage-heatmap-day">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = values.get(`${weekday}:${hour}`) ?? 0;
              return (
                <span key={hour} className="usage-heatmap-cell" data-step={step(value)}
                  data-active={active?.weekday === weekday && active.hour === hour ? "true" : undefined}
                  onPointerEnter={() => setActive({ weekday, hour })} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="usage-heatmap-footer">
        <p className="usage-heatmap-readout" aria-live="polite">
          {active ? <><strong>{format(activeValue)}</strong> {WEEKDAYS[active.weekday]} {formatHour(active.hour)}–{formatHour((active.hour + 1) % 24)}</> : "Hover a cell for its total"}
        </p>
        <span className="usage-heatmap-scale" aria-hidden="true">
          Less{Array.from({ length: STEPS + 1 }, (_, index) => <i key={index} data-step={index} />)}More
        </span>
      </div>
    </div>
  );
}
