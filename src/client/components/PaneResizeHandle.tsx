import { useEffect, useRef } from "react";

export type PaneResizeOrientation = "row" | "column";

export interface PaneResizeHandleProps {
  readonly orientation: PaneResizeOrientation;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly resetValue: number;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly testId?: string;
  readonly keyboardStep?: number;
  /** Inverts pointer and arrow-key movement for a pane before the divider. */
  readonly reverse?: boolean;
  readonly normalizeValue?: (value: number) => number;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
  readonly onInteractionChange?: (active: boolean) => void;
}

interface ResizeDrag {
  readonly pointerId: number;
  readonly startCoordinate: number;
  readonly startValue: number;
}

interface BodyInteractionStyle {
  readonly cursor: string;
  readonly userSelect: string;
}

/**
 * Pointer- and keyboard-accessible divider shared by shell and workspace
 * panes. Pointer movement previews through rAF and commits once on pointerup;
 * cancellation restores the gesture's starting value.
 */
export function PaneResizeHandle({
  orientation,
  value,
  min,
  max,
  resetValue,
  ariaLabel,
  className,
  testId,
  keyboardStep = 16,
  reverse = false,
  normalizeValue,
  onPreview,
  onCommit,
  onInteractionChange,
}: PaneResizeHandleProps): React.JSX.Element {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const frameRef = useRef(0);
  const valueRef = useRef(value);
  const bodyStyleRef = useRef<BodyInteractionStyle | null>(null);
  const previewRef = useRef(onPreview);
  const commitRef = useRef(onCommit);
  const interactionRef = useRef(onInteractionChange);

  previewRef.current = onPreview;
  commitRef.current = onCommit;
  interactionRef.current = onInteractionChange;

  const normalize = (candidate: number): number => {
    const boundedCandidate = Number.isFinite(candidate)
      ? candidate
      : valueRef.current;
    const normalized = normalizeValue
      ? normalizeValue(boundedCandidate)
      : boundedCandidate;
    if (!Number.isFinite(normalized)) return valueRef.current;
    return Math.min(max, Math.max(min, normalized));
  };

  const syncValueNow = (nextValue: number) => {
    handleRef.current?.setAttribute("aria-valuenow", String(nextValue));
  };

  const cancelFrame = () => {
    if (!frameRef.current) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  };

  const restoreBodyInteraction = () => {
    const prior = bodyStyleRef.current;
    if (!prior) return;
    document.body.style.cursor = prior.cursor;
    document.body.style.userSelect = prior.userSelect;
    bodyStyleRef.current = null;
  };

  const finishInteraction = () => {
    handleRef.current?.removeAttribute("data-dragging");
    restoreBodyInteraction();
    interactionRef.current?.(false);
  };

  const applyPreview = (nextValue: number) => {
    valueRef.current = nextValue;
    previewRef.current(nextValue);
    syncValueNow(nextValue);
  };

  const schedulePreview = (nextValue: number) => {
    valueRef.current = nextValue;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      previewRef.current(valueRef.current);
      syncValueNow(valueRef.current);
    });
  };

  const releaseCapture = (pointerId: number) => {
    const handle = handleRef.current;
    if (!handle?.hasPointerCapture?.(pointerId)) return;
    handle.releasePointerCapture(pointerId);
  };

  const cancelDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    cancelFrame();
    applyPreview(drag.startValue);
    finishInteraction();
    releaseCapture(drag.pointerId);
  };

  const commitValue = (candidate: number) => {
    const nextValue = normalize(candidate);
    valueRef.current = nextValue;
    syncValueNow(nextValue);
    commitRef.current(nextValue);
  };

  useEffect(() => {
    if (dragRef.current) return;
    valueRef.current = normalize(value);
    syncValueNow(valueRef.current);
  }, [value, min, max, normalizeValue]);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      dragRef.current = null;
      cancelFrame();
      if (drag) previewRef.current(drag.startValue);
      if (drag) interactionRef.current?.(false);
      restoreBodyInteraction();
    },
    [],
  );

  const ariaOrientation = orientation === "row" ? "vertical" : "horizontal";
  const movementDirection = reverse ? -1 : 1;

  return (
    <div
      ref={handleRef}
      className={className}
      data-testid={testId}
      role="separator"
      aria-orientation={ariaOrientation}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={normalize(value)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          dragRef.current
        ) {
          return;
        }
        event.preventDefault();
        const startValue = normalize(valueRef.current);
        dragRef.current = {
          pointerId: event.pointerId,
          startCoordinate:
            orientation === "row" ? event.clientX : event.clientY,
          startValue,
        };
        bodyStyleRef.current = {
          cursor: document.body.style.cursor,
          userSelect: document.body.style.userSelect,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute("data-dragging", "true");
        interactionRef.current?.(true);
        document.body.style.cursor =
          orientation === "row" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const coordinate =
          orientation === "row" ? event.clientX : event.clientY;
        schedulePreview(
          normalize(
            drag.startValue +
              (coordinate - drag.startCoordinate) * movementDirection,
          ),
        );
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        dragRef.current = null;
        cancelFrame();
        finishInteraction();
        commitValue(valueRef.current);
        releaseCapture(drag.pointerId);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) cancelDrag();
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) cancelDrag();
      }}
      onDoubleClick={() => commitValue(resetValue)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && dragRef.current) {
          event.preventDefault();
          cancelDrag();
          return;
        }
        const decrementKey = orientation === "row" ? "ArrowLeft" : "ArrowUp";
        const incrementKey = orientation === "row" ? "ArrowRight" : "ArrowDown";
        if (event.key !== decrementKey && event.key !== incrementKey) return;
        event.preventDefault();
        commitValue(
          valueRef.current +
            (event.key === decrementKey ? -keyboardStep : keyboardStep) *
              movementDirection,
        );
      }}
    />
  );
}
