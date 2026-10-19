import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTouchDensity } from "../../app/use-touch-density.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HOURS = 24;
const STEPS = 6;
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
export const formatHour = (hour: number): string => hourLabel.format(new Date(2026, 0, 5, hour));

type Cell = { readonly weekday: number; readonly hour: number };

/**
 * Weekday by local hour grid on a one-hue sequential ramp. Hovering, tapping,
 * or the arrow keys pick a cell; its total reads out below the grid. A tapped
 * cell stays picked until the next tap, Escape, or leaving the chart.
 */
export function Heatmap({ cells, format, label }: {
  readonly cells: readonly { weekday: number; hour: number; value: number }[];
  readonly format: (value: number) => string;
  readonly label: string;
}) {
  const touch = useTouchDensity();
  const [active, setActive] = useState<Cell | null>(null);
  const values = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell.value]));
  const maximum = Math.max(0, ...cells.map((cell) => cell.value));
  const step = (value: number) => value <= 0 || maximum <= 0 ? 0 : Math.max(1, Math.ceil((value / maximum) * STEPS));
  const activeValue = active ? values.get(`${active.weekday}:${active.hour}`) ?? 0 : 0;
  const peak = cells.reduce<Cell | null>((best, cell) =>
    cell.value > 0 && (!best || cell.value > (values.get(`${best.weekday}:${best.hour}`) ?? 0)) ? cell : best, null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { setActive(null); return; }
    const current = active ?? peak ?? { weekday: 0, hour: 0 };
    const next: Cell | null = event.key === "ArrowLeft" ? { ...current, hour: current.hour - 1 }
      : event.key === "ArrowRight" ? { ...current, hour: current.hour + 1 }
        : event.key === "ArrowUp" ? { ...current, weekday: current.weekday - 1 }
          : event.key === "ArrowDown" ? { ...current, weekday: current.weekday + 1 }
            : event.key === "Home" ? { ...current, hour: 0 }
              : event.key === "End" ? { ...current, hour: HOURS - 1 } : null;
    if (!next) return;
    event.preventDefault();
    setActive({
      weekday: Math.max(0, Math.min(WEEKDAYS.length - 1, next.weekday)),
      hour: Math.max(0, Math.min(HOURS - 1, next.hour)),
    });
  };
  // Touch browsers fire pointerleave as the finger lifts; only a mouse
  // leaving the grid clears the readout.
  const onPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") setActive(null);
  };
  return (
    <div className="usage-heatmap" role="group" aria-label={label} aria-roledescription="heatmap" tabIndex={0}
      onKeyDown={onKeyDown} onFocus={() => setActive((current) => current ?? peak ?? { weekday: 0, hour: 0 })}
      onBlur={() => setActive(null)}>
      <div className="usage-heatmap-grid" aria-hidden="true" onPointerLeave={onPointerLeave}>
        <span />
        {Array.from({ length: HOURS }, (_, hour) => (
          <span key={hour} className="usage-heatmap-hour">{hour % 3 === 0 ? formatHour(hour) : ""}</span>
        ))}
        {WEEKDAYS.map((day, weekday) => (
          <div key={day} className="usage-heatmap-row">
            <span className="usage-heatmap-day">{day}</span>
            {Array.from({ length: HOURS }, (_, hour) => {
              const value = values.get(`${weekday}:${hour}`) ?? 0;
              return (
                <span key={hour} className="usage-heatmap-cell" data-step={step(value)}
                  data-active={active?.weekday === weekday && active.hour === hour ? "true" : undefined}
                  onPointerEnter={() => setActive({ weekday, hour })}
                  onPointerDown={() => setActive({ weekday, hour })} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="usage-heatmap-footer">
        <p className="usage-heatmap-readout" aria-live="polite">
          {active ? <><strong>{format(activeValue)}</strong> {WEEKDAYS[active.weekday]} {formatHour(active.hour)}–{formatHour((active.hour + 1) % HOURS)}</>
            : touch ? "Tap a cell for its total" : "Hover a cell for its total"}
        </p>
        <span className="usage-heatmap-scale" aria-hidden="true">
          Less{Array.from({ length: STEPS + 1 }, (_, index) => <i key={index} data-step={index} />)}More
        </span>
      </div>
    </div>
  );
}
