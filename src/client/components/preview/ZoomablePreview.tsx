import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../ui/button.js";

const BASE_ZOOM = 1;
const STANDARD_MINIMUM_ZOOM = BASE_ZOOM;
const POPUP_MINIMUM_ZOOM = 0.25;
const MAXIMUM_ZOOM = 4;
const ZOOM_STEP = 0.25;
const KEYBOARD_PAN_STEP = 40;

export interface ZoomableViewState {
  readonly zoom: number;
  readonly horizontalCenter: number;
  readonly verticalCenter: number;
}

interface DragState {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

interface PinchState {
  readonly firstPointerId: number;
  readonly secondPointerId: number;
  readonly initialDistance: number;
  readonly initialZoom: number;
}

interface ZoomAnchor {
  readonly contentHorizontal: number;
  readonly contentVertical: number;
  readonly viewportHorizontal: number;
  readonly viewportVertical: number;
}

export type ZoomablePreviewInteractionMode = "standard" | "popup";

const DEFAULT_VIEW_STATE: ZoomableViewState = {
  zoom: BASE_ZOOM,
  horizontalCenter: 0.5,
  verticalCenter: 0.5,
};

function boundedZoom(zoom: number, minimumZoom: number): number {
  return Math.min(MAXIMUM_ZOOM, Math.max(minimumZoom, zoom));
}

function viewportCanPan(viewport: HTMLDivElement): boolean {
  return (
    viewport.scrollWidth > viewport.clientWidth + 0.5 ||
    viewport.scrollHeight > viewport.clientHeight + 0.5
  );
}

function zoomAnchor(
  viewport: HTMLDivElement,
  clientPoint?: { readonly x: number; readonly y: number },
): ZoomAnchor {
  const bounds = viewport.getBoundingClientRect();
  const localX = clientPoint
    ? Math.min(viewport.clientWidth, Math.max(0, clientPoint.x - bounds.left))
    : viewport.clientWidth / 2;
  const localY = clientPoint
    ? Math.min(viewport.clientHeight, Math.max(0, clientPoint.y - bounds.top))
    : viewport.clientHeight / 2;
  return {
    contentHorizontal:
      viewport.scrollWidth > 0
        ? (viewport.scrollLeft + localX) / viewport.scrollWidth
        : 0.5,
    contentVertical:
      viewport.scrollHeight > 0
        ? (viewport.scrollTop + localY) / viewport.scrollHeight
        : 0.5,
    viewportHorizontal:
      viewport.clientWidth > 0 ? localX / viewport.clientWidth : 0.5,
    viewportVertical:
      viewport.clientHeight > 0 ? localY / viewport.clientHeight : 0.5,
  };
}

function currentViewState(
  viewport: HTMLDivElement,
  zoom: number,
): ZoomableViewState {
  return {
    zoom,
    horizontalCenter:
      viewport.scrollWidth > 0
        ? (viewport.scrollLeft + viewport.clientWidth / 2) /
          viewport.scrollWidth
        : 0.5,
    verticalCenter:
      viewport.scrollHeight > 0
        ? (viewport.scrollTop + viewport.clientHeight / 2) /
          viewport.scrollHeight
        : 0.5,
  };
}

export function ZoomablePreview({
  children,
  controlsLabel,
  initialViewState = DEFAULT_VIEW_STATE,
  interactionMode = "standard",
  onViewStateChange,
  resetLabel,
  toolbarActions,
  title,
  viewportLabel,
}: {
  readonly children: ReactNode;
  readonly controlsLabel: string;
  readonly initialViewState?: ZoomableViewState;
  readonly interactionMode?: ZoomablePreviewInteractionMode;
  readonly onViewStateChange?: (state: ZoomableViewState) => void;
  readonly resetLabel: string;
  readonly toolbarActions?: ReactNode;
  readonly title: string;
  readonly viewportLabel: string;
}): React.JSX.Element {
  const popupInteractions = interactionMode === "popup";
  const minimumZoom = popupInteractions
    ? POPUP_MINIMUM_ZOOM
    : STANDARD_MINIMUM_ZOOM;
  const instructionsId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ZoomAnchor>({
    contentHorizontal: initialViewState.horizontalCenter,
    contentVertical: initialViewState.verticalCenter,
    viewportHorizontal: 0.5,
    viewportVertical: 0.5,
  });
  const dragRef = useRef<DragState | undefined>(undefined);
  const touchPointersRef = useRef(
    new Map<number, { readonly x: number; readonly y: number }>(),
  );
  const pinchRef = useRef<PinchState | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [panned, setPanned] = useState(false);
  const [zoom, setZoom] = useState(() =>
    boundedZoom(initialViewState.zoom, minimumZoom),
  );
  const zoomRef = useRef(zoom);

  const rememberViewState = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const state = currentViewState(viewport, zoomRef.current);
    anchorRef.current = {
      contentHorizontal: state.horizontalCenter,
      contentVertical: state.verticalCenter,
      viewportHorizontal: 0.5,
      viewportVertical: 0.5,
    };
    setOverflowing(viewportCanPan(viewport));
    setPanned(
      Math.abs(viewport.scrollLeft) > 0.5 || Math.abs(viewport.scrollTop) > 0.5,
    );
    onViewStateChange?.(state);
  }, [onViewStateChange]);

  const updateZoom = useCallback(
    (
      requestedZoom: number,
      clientPoint?: { readonly x: number; readonly y: number },
    ): void => {
      const nextZoom = boundedZoom(requestedZoom, minimumZoom);
      if (Math.abs(nextZoom - zoomRef.current) < 0.0001) return;
      const viewport = viewportRef.current;
      if (viewport) anchorRef.current = zoomAnchor(viewport, clientPoint);
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    },
    [minimumZoom],
  );

  const reset = (): void => {
    anchorRef.current = {
      contentHorizontal: 0.5,
      contentVertical: 0.5,
      viewportHorizontal: 0.5,
      viewportVertical: 0.5,
    };
    setPanned(false);
    zoomRef.current = BASE_ZOOM;
    setZoom(BASE_ZOOM);
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    onViewStateChange?.(DEFAULT_VIEW_STATE);
  };

  const rebuildTouchGesture = (viewport: HTMLDivElement): void => {
    const touches = [...touchPointersRef.current.entries()];
    if (touches.length >= 2) {
      const [first, second] = touches;
      pinchRef.current = {
        firstPointerId: first![0],
        secondPointerId: second![0],
        initialDistance: pointerDistance(first![1], second![1]),
        initialZoom: zoomRef.current,
      };
      dragRef.current = undefined;
      setDragging(false);
      return;
    }
    pinchRef.current = undefined;
    const remaining = touches[0];
    if (remaining && viewportCanPan(viewport)) {
      dragRef.current = {
        pointerId: remaining[0],
        x: remaining[1].x,
        y: remaining[1].y,
      };
      setDragging(true);
      return;
    }
    dragRef.current = undefined;
    setDragging(false);
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft =
      anchorRef.current.contentHorizontal * viewport.scrollWidth -
      anchorRef.current.viewportHorizontal * viewport.clientWidth;
    viewport.scrollTop =
      anchorRef.current.contentVertical * viewport.scrollHeight -
      anchorRef.current.viewportVertical * viewport.clientHeight;
    rememberViewState();
  }, [rememberViewState, zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !popupInteractions) return;
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const deltaPixels =
        event.deltaY *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, viewport.clientHeight)
            : 1);
      const exponent = Math.min(0.5, Math.max(-0.5, -deltaPixels * 0.0025));
      updateZoom(zoomRef.current * Math.exp(exponent), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [popupInteractions, updateZoom]);

  const canZoomOut = zoom > minimumZoom;
  const resettable = Math.abs(zoom - BASE_ZOOM) > 0.001 || panned;
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="zoomable-preview-shell">
      <header className="zoomable-preview-toolbar">
        <span title={title}>{title}</span>
        <div aria-label={controlsLabel} role="group">
          {toolbarActions}
          <Button
            aria-label="Zoom out"
            disabled={!canZoomOut}
            onClick={() => updateZoom(zoom - ZOOM_STEP)}
            size="icon-xs"
            title="Zoom out"
            variant="ghost"
          >
            <ZoomOut />
          </Button>
          <output
            aria-label="Zoom level"
            className="zoomable-preview-zoom-value"
          >
            {zoomPercent}%
          </output>
          <Button
            aria-label={resetLabel}
            disabled={!resettable}
            onClick={reset}
            size="icon-xs"
            title={resetLabel}
            variant="ghost"
          >
            <RotateCcw />
          </Button>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= MAXIMUM_ZOOM}
            onClick={() => updateZoom(zoom + ZOOM_STEP)}
            size="icon-xs"
            title="Zoom in"
            variant="ghost"
          >
            <ZoomIn />
          </Button>
        </div>
      </header>
      <p className="sr-only" id={instructionsId}>
        {popupInteractions
          ? "Use the zoom controls, pinch, or Control- or Command-scroll to zoom. Drag, scroll, or use the arrow keys to pan overflowing content. Press 0 to reset the view."
          : "Use the zoom controls to zoom. Drag, scroll, or use the arrow keys to pan overflowing content. Press 0 to reset the view."}
      </p>
      <div
        aria-describedby={instructionsId}
        aria-keyshortcuts="+ - 0"
        aria-label={viewportLabel}
        className="zoomable-preview-viewport"
        data-dragging={dragging ? "true" : undefined}
        data-gesture-zoom={popupInteractions ? "true" : undefined}
        data-pannable={overflowing ? "true" : undefined}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if ((event.key === "+" || event.key === "=") && zoom < MAXIMUM_ZOOM) {
            event.preventDefault();
            updateZoom(zoom + ZOOM_STEP);
            return;
          }
          if (event.key === "-" && canZoomOut) {
            event.preventDefault();
            updateZoom(zoom - ZOOM_STEP);
            return;
          }
          if (event.key === "0" && resettable) {
            event.preventDefault();
            reset();
            return;
          }
          if (!viewportCanPan(event.currentTarget)) return;
          const movement =
            event.key === "ArrowLeft"
              ? { x: -KEYBOARD_PAN_STEP, y: 0 }
              : event.key === "ArrowRight"
                ? { x: KEYBOARD_PAN_STEP, y: 0 }
                : event.key === "ArrowUp"
                  ? { x: 0, y: -KEYBOARD_PAN_STEP }
                  : event.key === "ArrowDown"
                    ? { x: 0, y: KEYBOARD_PAN_STEP }
                    : undefined;
          if (!movement) return;
          event.preventDefault();
          event.currentTarget.scrollLeft += movement.x;
          event.currentTarget.scrollTop += movement.y;
          rememberViewState();
        }}
        onLostPointerCapture={(event) => {
          if (event.pointerType === "touch") {
            touchPointersRef.current.delete(event.pointerId);
            rebuildTouchGesture(event.currentTarget);
            rememberViewState();
            return;
          }
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = undefined;
          setDragging(false);
          rememberViewState();
        }}
        onPointerCancel={(event) => {
          if (event.pointerType === "touch") {
            touchPointersRef.current.delete(event.pointerId);
            rebuildTouchGesture(event.currentTarget);
            rememberViewState();
            return;
          }
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = undefined;
          setDragging(false);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            if (!popupInteractions) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            touchPointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            rebuildTouchGesture(event.currentTarget);
            return;
          }
          if (!viewportCanPan(event.currentTarget) || event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") {
            if (!touchPointersRef.current.has(event.pointerId)) return;
            touchPointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            const pinch = pinchRef.current;
            if (pinch) {
              const first = touchPointersRef.current.get(pinch.firstPointerId);
              const second = touchPointersRef.current.get(
                pinch.secondPointerId,
              );
              if (first && second && pinch.initialDistance > 0) {
                event.preventDefault();
                updateZoom(
                  pinch.initialZoom *
                    (pointerDistance(first, second) / pinch.initialDistance),
                  {
                    x: (first.x + second.x) / 2,
                    y: (first.y + second.y) / 2,
                  },
                );
              }
              return;
            }
          }
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.currentTarget.scrollLeft -= event.clientX - drag.x;
          event.currentTarget.scrollTop -= event.clientY - drag.y;
          dragRef.current = {
            pointerId: drag.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
          rememberViewState();
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") {
            touchPointersRef.current.delete(event.pointerId);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            rebuildTouchGesture(event.currentTarget);
            rememberViewState();
            return;
          }
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = undefined;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          rememberViewState();
        }}
        onScroll={rememberViewState}
        ref={viewportRef}
        role="region"
        tabIndex={0}
      >
        <div
          className="zoomable-preview-canvas"
          data-reduced={zoom < BASE_ZOOM ? "true" : undefined}
          style={
            {
              "--zoomable-preview-content-padding": `${16 * zoom}px`,
              height: `${zoomPercent}%`,
              width: `${zoomPercent}%`,
            } as React.CSSProperties
          }
        >
          <div className="zoomable-preview-content">{children}</div>
        </div>
      </div>
    </div>
  );
}

function pointerDistance(
  first: { readonly x: number; readonly y: number },
  second: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}
