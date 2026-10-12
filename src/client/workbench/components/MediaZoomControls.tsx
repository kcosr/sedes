import { useEffect, useId, useRef, useState } from "react";
import { cx } from "../lib/cx";

export interface MediaZoomControlsProps {
  /** Accessible name of the controls, usually identifying the viewed content. */
  label: string;
  zoomPercent: number;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onActualSize: () => void;
  /** Enables the percentage button's preset popover. The caller applies limits. */
  onZoomToPercent?: ((percent: number) => void) | undefined;
  className?: string | undefined;
}

const presets = [25, 50, 75, 100, 125, 150, 200] as const;

/** A floating control strip; the viewer owns zoom state, sizing and fitting. */
export function MediaZoomControls({
  label,
  zoomPercent,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onFit,
  onActualSize,
  onZoomToPercent,
  className,
}: MediaZoomControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const percentageRef = useRef<HTMLButtonElement>(null);
  const presetsId = useId();
  const [open, setOpen] = useState(false);
  const presetsOpen = open && onZoomToPercent !== undefined;
  const percentage = `${Math.round(zoomPercent)}%`;

  useEffect(() => {
    if (!presetsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeOutside, true);
  }, [presetsOpen]);

  return (
    <div
      ref={rootRef}
      className={cx("wb-media-zoom", className)}
      role="group"
      aria-label={label}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && presetsOpen) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          percentageRef.current?.focus();
        }
      }}
    >
      <button
        className="wb-media-zoom-button"
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <span aria-hidden="true">−</span>
      </button>
      {onZoomToPercent ? (
        <button
          ref={percentageRef}
          className="wb-media-zoom-button wb-media-zoom-percentage"
          type="button"
          aria-label={`Zoom percentage: ${percentage}`}
          aria-expanded={presetsOpen}
          aria-controls={presetsOpen ? presetsId : undefined}
          title="Choose zoom percentage"
          onClick={() => setOpen(!presetsOpen)}
        >
          {percentage}
        </button>
      ) : (
        <output
          className="wb-media-zoom-percentage"
          aria-label="Zoom percentage"
        >
          {percentage}
        </output>
      )}
      <button
        className="wb-media-zoom-button"
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <span aria-hidden="true">+</span>
      </button>
      <span className="wb-media-zoom-divider" aria-hidden="true" />
      <button
        className="wb-media-zoom-button"
        type="button"
        aria-label="Fit to view"
        title="Fit to view"
        onClick={onFit}
      >
        <svg
          className="wb-media-zoom-fit-icon"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
          <rect x="7" y="7" width="6" height="6" rx="0.5" />
        </svg>
      </button>
      <button
        className="wb-media-zoom-button wb-media-zoom-actual"
        type="button"
        aria-label="Actual size (100%)"
        title="Actual size (100%)"
        onClick={onActualSize}
      >
        1:1
      </button>
      {presetsOpen ? (
        <div
          id={presetsId}
          className="wb-media-zoom-presets"
          role="group"
          aria-label="Zoom presets"
        >
          {presets.map((percent) => (
            <button
              key={percent}
              className="wb-media-zoom-button"
              type="button"
              aria-pressed={Math.round(zoomPercent) === percent}
              onClick={() => {
                setOpen(false);
                percentageRef.current?.focus();
                onZoomToPercent?.(percent);
              }}
            >
              {percent}%
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
