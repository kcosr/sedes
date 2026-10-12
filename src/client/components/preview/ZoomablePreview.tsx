import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  scrollPreviewAncestors,
  startPreviewScrollMomentum,
} from "./inline-touch-scroll.js";
import { MediaZoomControls } from "../../workbench/components/MediaZoomControls.js";
import "../../workbench/styles/media-frame.css";
import "./zoomable-preview.css";

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

export type ZoomablePreviewInteractionMode = "standard" | "popup" | "inline";

const DEFAULT_VIEW_STATE: ZoomableViewState = {
  zoom: BASE_ZOOM,
  horizontalCenter: 0.5,
  verticalCenter: 0.5,
};

function boundedZoom(zoom: number, minimumZoom: number): number {
  // Saved views are relative to fit; a large image can need more than 4x fit
  // to show natural pixels. Its actual-scale ceiling is applied after measuring.
  return Math.max(minimumZoom, Number.isFinite(zoom) ? zoom : BASE_ZOOM);
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
  onGestureStart,
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
  readonly onGestureStart?: () => void;
  readonly resetLabel: string;
  readonly toolbarActions?: ReactNode;
  readonly title: string;
  readonly viewportLabel: string;
}): React.JSX.Element {
  const popupInteractions = interactionMode !== "standard";
  const inline = interactionMode === "inline";
  const minimumZoom = popupInteractions
    ? POPUP_MINIMUM_ZOOM
    : STANDARD_MINIMUM_ZOOM;
  const instructionsId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({
    width: 0,
    height: 0,
    naturalWidth: 0,
    naturalHeight: 0,
  });
  const suppressClick = useRef(false);
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
  const scrollTouch = useRef<
    | {
        pointerId: number;
        y: number;
        time: number;
        velocity: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const scrollMomentum = useRef<(() => void) | undefined>(undefined);
  const stopMomentum = useCallback(() => {
    scrollMomentum.current?.();
    scrollMomentum.current = undefined;
  }, []);
  useEffect(() => stopMomentum, [stopMomentum]);
  const finishScroll = (viewport: HTMLDivElement) => {
    const touch = scrollTouch.current;
    scrollTouch.current = undefined;
    if (!touch?.moved || performance.now() - touch.time > 100) return;
    stopMomentum();
    scrollMomentum.current = startPreviewScrollMomentum(
      viewport,
      touch.velocity,
    );
  };
  const [dragging, setDragging] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [panned, setPanned] = useState(false);
  const [zoom, setZoom] = useState(() =>
    boundedZoom(initialViewState.zoom, minimumZoom),
  );
  const zoomRef = useRef(zoom);
  const fitScale =
    dimensions.naturalWidth > 0 && dimensions.naturalHeight > 0
      ? Math.min(
          1,
          dimensions.width / dimensions.naturalWidth,
          dimensions.height / dimensions.naturalHeight,
        ) || 1
      : 1;
  const maximumZoom = Math.max(MAXIMUM_ZOOM, MAXIMUM_ZOOM / fitScale);
  const actualScale = fitScale * zoom;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const image = content.querySelector("img");
      const svg = content.querySelector("svg");
      // Mermaid supplies a natural-size inline cap. The preview owns the SVG's
      // scaled geometry; retaining that cap stops magnification at actual size.
      svg?.style.removeProperty("max-width");
      svg?.style.removeProperty("max-height");
      const viewBox = svg
        ?.getAttribute("viewBox")
        ?.trim()
        .split(/[ ,]+/)
        .map(Number);
      const naturalWidth =
        image?.naturalWidth || (viewBox?.length === 4 ? viewBox[2] : 0) || 0;
      const naturalHeight =
        image?.naturalHeight || (viewBox?.length === 4 ? viewBox[3] : 0) || 0;
      const next = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        naturalWidth,
        naturalHeight,
      };
      setDimensions((previous) =>
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    measure();
    content.addEventListener("load", measure, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      content.removeEventListener("load", measure, true);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [children]);

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
      const nextZoom = Math.min(
        maximumZoom,
        Math.max(minimumZoom, requestedZoom),
      );
      if (Math.abs(nextZoom - zoomRef.current) < 0.0001) return;
      const viewport = viewportRef.current;
      if (viewport) anchorRef.current = zoomAnchor(viewport, clientPoint);
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    },
    [maximumZoom, minimumZoom],
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
      scrollTouch.current = undefined;
      pinchRef.current = {
        firstPointerId: first![0],
        secondPointerId: second![0],
        initialDistance: pointerDistance(first![1], second![1]),
        initialZoom: zoomRef.current,
      };
      dragRef.current = undefined;
      suppressClick.current = true;
      onGestureStart?.();
      setDragging(false);
      return;
    }
    pinchRef.current = undefined;
    const remaining = touches[0];
    if (
      remaining &&
      (!inline || zoomRef.current > BASE_ZOOM + 0.001) &&
      viewportCanPan(viewport)
    ) {
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
  }, [actualScale, rememberViewState, zoom]);

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
    <div
      className="zoomable-preview-shell"
      data-mode={interactionMode}
      aria-label={title}
      style={
        inline
          ? {
              height:
                dimensions.naturalHeight > 0
                  ? dimensions.naturalHeight *
                    Math.min(
                      1,
                      (dimensions.width || dimensions.naturalWidth) /
                        dimensions.naturalWidth,
                    )
                  : 240,
            }
          : undefined
      }
    >
      {toolbarActions ? (
        <div className="zoomable-preview-actions">{toolbarActions}</div>
      ) : null}
      {!inline ? (
        <MediaZoomControls
          label={controlsLabel}
          zoomPercent={Math.round(actualScale * 100)}
          canZoomOut={canZoomOut}
          canZoomIn={zoom < maximumZoom}
          onZoomOut={() => updateZoom(zoom - ZOOM_STEP / fitScale)}
          onZoomIn={() => updateZoom(zoom + ZOOM_STEP / fitScale)}
          onFit={reset}
          onActualSize={() => updateZoom(1 / fitScale)}
          onZoomToPercent={(percent) => updateZoom(percent / 100 / fitScale)}
        />
      ) : null}
      <p className="sr-only" id={instructionsId}>
        {inline
          ? "Pinch or Control- or Command-scroll to zoom. Drag to pan zoomed content. Expand for zoom controls. Press 0 to reset the view."
          : popupInteractions
            ? "Use the zoom controls, pinch, or Control- or Command-scroll to zoom. Drag, scroll, or use the arrow keys to pan overflowing content. Press 0 to reset the view."
            : "Use the zoom controls to zoom. Drag, scroll, or use the arrow keys to pan overflowing content. Press 0 to reset the view."}
        <span>{resetLabel} returns to fit size.</span>
      </p>
      <div
        aria-describedby={instructionsId}
        aria-keyshortcuts="+ - 0"
        aria-label={viewportLabel}
        className="zoomable-preview-viewport"
        data-dragging={dragging ? "true" : undefined}
        data-gesture-zoom={popupInteractions ? "true" : undefined}
        data-pannable={overflowing ? "true" : undefined}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if ((event.key === "+" || event.key === "=") && zoom < maximumZoom) {
            event.preventDefault();
            updateZoom(zoom + ZOOM_STEP / fitScale);
            return;
          }
          if (event.key === "-" && canZoomOut) {
            event.preventDefault();
            updateZoom(zoom - ZOOM_STEP / fitScale);
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
            if (scrollTouch.current?.pointerId === event.pointerId)
              scrollTouch.current = undefined;
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
            if (scrollTouch.current?.pointerId === event.pointerId)
              scrollTouch.current = undefined;
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
            stopMomentum();
            if (touchPointersRef.current.size === 0)
              suppressClick.current = false;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            if (
              inline &&
              zoomRef.current <= BASE_ZOOM + 0.001 &&
              touchPointersRef.current.size === 0
            ) {
              scrollTouch.current = {
                pointerId: event.pointerId,
                y: event.clientY,
                time: performance.now(),
                velocity: 0,
                moved: false,
              };
            }
            touchPointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            rebuildTouchGesture(event.currentTarget);
            return;
          }
          if (
            (inline && zoomRef.current <= BASE_ZOOM + 0.001) ||
            !viewportCanPan(event.currentTarget) ||
            event.button !== 0
          ) {
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
          const scrolling = scrollTouch.current;
          if (
            event.pointerType === "touch" &&
            scrolling?.pointerId === event.pointerId
          ) {
            const now = performance.now();
            const delta = scrolling.y - event.clientY;
            if (Math.abs(delta) >= 2 || scrolling.moved) {
              event.preventDefault();
              const moved = scrollPreviewAncestors(event.currentTarget, delta);
              scrolling.velocity = moved / Math.max(8, now - scrolling.time);
              scrolling.y = event.clientY;
              scrolling.time = now;
              scrolling.moved = true;
              suppressClick.current = true;
              onGestureStart?.();
            }
            return;
          }
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          suppressClick.current = true;
          onGestureStart?.();
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
            if (scrollTouch.current?.pointerId === event.pointerId)
              finishScroll(event.currentTarget);
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
              height:
                dimensions.naturalHeight > 0
                  ? `${Math.max(dimensions.height, dimensions.naturalHeight * actualScale)}px`
                  : `${zoomPercent}%`,
              width:
                dimensions.naturalWidth > 0
                  ? `${Math.max(dimensions.width, dimensions.naturalWidth * actualScale)}px`
                  : `${zoomPercent}%`,
            } as React.CSSProperties
          }
        >
          <div
            className="zoomable-preview-content"
            ref={contentRef}
            style={
              dimensions.naturalWidth > 0
                ? {
                    width: dimensions.naturalWidth * actualScale,
                    height: dimensions.naturalHeight * actualScale,
                  }
                : undefined
            }
          >
            {children}
          </div>
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
