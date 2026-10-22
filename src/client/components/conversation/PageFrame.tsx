import { Send } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import { PageResponseBridge } from "../../lib/page-response-bridge.js";
import type { PageResponseServices } from "./page-response-services.js";
import type { PageResponseSubmission } from "./page-response-submission.js";
import type { PageFrameServices } from "../../lib/page-services.js";
import { MediaZoomControls } from "../../workbench/components/MediaZoomControls.js";
import { Button } from "../ui/button.js";
import { pageFrameLayout, pageFrameMessage } from "./page-frame-layout.js";
import { PageFrameLoadGuard, usePageFrameAdmission } from "./page-frame-lifecycle.js";
import { supportsSafePageFrames } from "../../app/page-safety.js";
import { useConnectionScope } from "../../app/connection-scope.js";
import { stoppedPreviewScrollMomentum } from "../preview/inline-touch-scroll.js";
import { PageFrameRecoveryAttempt, pageFrameNeedsActivation, pageFrameRecoveryKey } from "./page-frame-recovery.js";
import "../../workbench/styles/media-frame.css";
import "./page-preview.css";

export function PageFrame({
  page,
  createAdmission,
  responseServices,
  response,
  enabled,
  interactive,
  onDeactivate,
  onActivate,
  refreshVersion,
  documentView = false,
}: {
  readonly page: PageRevision;
  readonly createAdmission: PageFrameServices["createPageRenderAdmission"];
  readonly responseServices?: PageResponseServices;
  readonly response: PageResponseSubmission;
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly onDeactivate: () => void;
  readonly onActivate: () => void;
  readonly refreshVersion: number;
  readonly documentView?: boolean;
}): React.JSX.Element {
  const connection = useConnectionScope();
  const recoveryKey = pageFrameRecoveryKey(connection, page);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const responseBridge = useRef<PageResponseBridge | undefined>(undefined);
  const [responseReady, setResponseReady] = useState(false);
  const tap = useRef<{ id: number; x: number; y: number; time: number } | undefined>(undefined);
  const clickReady = useRef(false);
  const [width, setWidth] = useState(page.viewport.width ?? 640);
  const [height, setHeight] = useState(page.viewport.height ?? 240);
  const [zoom, setZoom] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const [needsActivation, setNeedsActivation] = useState(false);
  const manualActivation = useRef(false);
  const activeRecoveryKey = useRef<string | undefined>(undefined);
  const [state, setState] = useState<
    | { status: "waiting" | "loading" | "error" }
    | {
        status: "ready";
        url: string;
        channel: string;
        recoveryKey: string;
        recovery: PageFrameRecoveryAttempt;
      }
  >({ status: "waiting" });
  const { admitted, request, visible } = usePageFrameAdmission(
    host,
    enabled,
    documentView,
    !needsActivation,
  );
  const fitted = pageFrameLayout(page.viewport, width, height);
  const fitScale = fitted.scale;
  const scale = zoom ?? fitScale;
  const layout = pageFrameLayout(
    page.viewport,
    width,
    height,
    scale / fitted.scale,
  );
  useEffect(() => {
    if (!visible || !enabled) manualActivation.current = false;
  }, [visible, enabled]);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    manualActivation.current = true;
    setNeedsActivation(false);
    request();
    setAttempt((value) => value + 1);
  }, [refreshVersion, request]);
  useEffect(() => {
    if (!admitted || !visible) onDeactivate();
  }, [admitted, onDeactivate, visible]);
  const ready =
    enabled && admitted && state.status === "ready" && state.recoveryKey === recoveryKey ? state : undefined;
  const loadGuard = useRef(new PageFrameLoadGuard());
  const handshakeAcknowledged = useRef(false);
  const wrapperAcknowledged = useRef(false);
  const handshakeTimeout = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!admitted || !enabled) {
      if (
        activeRecoveryKey.current &&
        pageFrameNeedsActivation(activeRecoveryKey.current)
      )
        setNeedsActivation(true);
      setState((current) =>
        current.status === "error" ? current : { status: "waiting" },
      );
      return;
    }
    if (!createAdmission) {
      setState({ status: "error" });
      return;
    }
    const controller = new AbortController();
    let recovery: PageFrameRecoveryAttempt | undefined;
    setState({ status: "loading" });
    void (async () => {
      if (!(await supportsSafePageFrames()))
        throw new Error("page_frame_isolation_unavailable");
      const admission = await createAdmission(
        page.pageId,
        page.revision,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      activeRecoveryKey.current = recoveryKey;
      if (!manualActivation.current && pageFrameNeedsActivation(recoveryKey)) {
        setNeedsActivation(true);
        setState({ status: "waiting" });
        return;
      }
      recovery = new PageFrameRecoveryAttempt(recoveryKey);
      if (!recovery.recorded && !manualActivation.current) {
        setNeedsActivation(true);
        setState({ status: "waiting" });
        return;
      }
      const channel = crypto.randomUUID();
      const url = `${admission.url}#${new URLSearchParams({ channel })}`;
      loadGuard.current.reset();
      setState({ status: "ready", url, channel, recovery, recoveryKey });
    })().catch(() => {
      if (!controller.signal.aborted) {
        setNeedsActivation(true);
        setState({ status: "error" });
      }
    });
    return () => {
      controller.abort();
      recovery?.cancel();
    };
  }, [
    admitted,
    attempt,
    createAdmission,
    enabled,
    page.pageId,
    page.revision,
    page.threadId,
    recoveryKey,
  ]);

  useLayoutEffect(() => {
    if (!ready) return;
    const bridge = new PageResponseBridge({
      getSource: () => frame.current?.contentWindow ?? null,
      channel: ready.channel,
      onReady: setResponseReady,
    });
    responseBridge.current = bridge;
    handshakeAcknowledged.current = false;
    wrapperAcknowledged.current = false;
    const fail = () => {
      bridge.dispose();
      ready.recovery.fail();
      setNeedsActivation(true);
      setState({ status: "error" });
    };
    // Transport can take longer than bootstrap execution for a large document.
    handshakeTimeout.current = window.setTimeout(fail, 60_000);
    const receive = (event: MessageEvent) => {
      bridge.handleMessage(event);
      const message = pageFrameMessage(
        event,
        frame.current?.contentWindow ?? null,
        ready.channel,
      );
      if (message === undefined) return;
      if (message.kind === "wrapper-ready") {
        if (!handshakeAcknowledged.current && !wrapperAcknowledged.current) {
          wrapperAcknowledged.current = true;
          window.clearTimeout(handshakeTimeout.current);
          handshakeTimeout.current = window.setTimeout(fail, 10_000);
        }
        return;
      }
      window.clearTimeout(handshakeTimeout.current);
      handshakeTimeout.current = undefined;
      if (message.kind === "error") {
        fail();
        return;
      }
      handshakeAcknowledged.current = true;
      ready.recovery.complete();
      setNeedsActivation(false);
      if (page.viewport.height === undefined) setHeight(message.height);
    };
    window.addEventListener("message", receive);
    return () => {
      bridge.dispose();
      responseBridge.current = undefined;
      setResponseReady(false);
      window.clearTimeout(handshakeTimeout.current);
      handshakeTimeout.current = undefined;
      window.removeEventListener("message", receive);
    };
  }, [page.viewport.height, ready]);

  return (
    <div
      className={`page-frame-shell${documentView ? " page-frame-document-view" : ""}`}
    >
      {enabled && responseServices?.threadId === page.threadId &&
        (responseReady || response.phase !== "idle" || response.status || response.error) ? (
        <div className="page-response-controls">
          <span className="page-response-status" role={response.error ? "alert" : "status"}>
            {response.error || response.status || responseServices.unavailableReason}
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label={response.phase === "retry" ? "Retry page response" : "Send page response"}
            disabled={response.phase === "sending" || (response.phase !== "retry" && (!responseReady || Boolean(responseServices.unavailableReason)))}
            title={responseServices.unavailableReason ?? "Send this page response to the conversation"}
            onClick={(event) => {
              if (!documentView) {
                onDeactivate();
                // Touch browsers need an explicit focus transfer out of the
                // frame so the chat regains its normal scrolling behavior.
                event.currentTarget.focus({ preventScroll: true });
              }
              void response.send(responseBridge.current);
            }}
          >
            <Send aria-hidden="true" />
            {response.phase === "retry" ? "Retry" : response.phase === "sending" ? "Sending…" : "Send"}
          </Button>
        </div>
      ) : null}
      {documentView ? (
        <MediaZoomControls
          label="Page zoom controls"
          zoomPercent={Math.round(scale * 100)}
          canZoomOut={scale > 0.1}
          canZoomIn={scale < 4}
          onZoomOut={() => setZoom(Math.max(0.1, scale - 0.25))}
          onZoomIn={() => setZoom(Math.min(4, scale + 0.25))}
          onFit={() => setZoom(undefined)}
          onActualSize={() => setZoom(1)}
          onZoomToPercent={(percent) =>
            setZoom(Math.max(0.1, Math.min(4, percent / 100)))
          }
        />
      ) : null}
      <div
        className="page-frame-viewport"
        data-interactive={interactive ? "true" : "false"}
        ref={host}
        role="region"
        aria-label={`Page preview: ${page.title}`}
        tabIndex={!interactive || documentView ? 0 : undefined}
        onKeyDown={(event) => {
          clickReady.current = false;
          tap.current = undefined;
          if (!interactive && ready && event.target === event.currentTarget &&
              (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onActivate();
          }
        }}
        onPointerDown={(event) => {
          tap.current = undefined;
          clickReady.current = false;
          if (interactive || !ready || !event.isPrimary || event.button !== 0 ||
              (event.target as Element).closest("button") ||
              stoppedPreviewScrollMomentum(event.nativeEvent)) return;
          tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
        }}
        onPointerMove={(event) => {
          const start = tap.current;
          if (start && (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10))
            tap.current = undefined;
        }}
        onPointerCancel={() => {
          tap.current = undefined;
          clickReady.current = false;
        }}
        onWheelCapture={() => {
          tap.current = undefined;
          clickReady.current = false;
        }}
        onPointerUp={(event) => {
          const start = tap.current;
          tap.current = undefined;
          clickReady.current = Boolean(start && event.pointerId === start.id &&
            event.timeStamp - start.time < 500 &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10);
        }}
        onClick={(event) => {
          const canActivate = clickReady.current;
          clickReady.current = false;
          // Native scrolling suppresses the click for a fling-stopping tap.
          // Scripted clicks have no matching pointer click count.
          if (!canActivate || event.detail === 0 || interactive || !ready) return;
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }}
      >
        <div
          className="page-frame-canvas"
          style={{ width: layout.displayWidth, height: layout.displayHeight }}
        >
          {ready ? (
            <iframe
              className="page-frame-document"
              ref={frame}
              title={`${page.title} · Revision ${page.revision}`}
              src={ready.url}
              sandbox="allow-scripts"
              inert={!interactive}
              tabIndex={interactive ? 0 : -1}
              allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
              referrerPolicy="no-referrer"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${layout.scale})`,
              }}
              onLoad={(event) => {
                const context = event.currentTarget.contentWindow;
                // A retained workspace panel moves between hosts when the
                // responsive layout changes. The browser recreates its frame
                // context in that case; navigation inside one context keeps
                // its WindowProxy and remains disallowed.
                const admission = loadGuard.current.accept(context);
                if (admission === "rejected") {
                  responseBridge.current?.dispose();
                  ready.recovery.fail();
                  setNeedsActivation(true);
                  setState({ status: "error" });
                } else if (admission === "replacement") {
                  // Reparenting can reload a token long after it expired.
                  // Renew exact document authority for the new context.
                  setAttempt((value) => value + 1);
                }
              }}
            />
          ) : (
            <div
              className="page-frame-placeholder"
              style={{ minHeight: Math.min(layout.displayHeight, 360) }}
            >
              {state.status === "loading" ? (
                <span role="status">Loading preview…</span>
              ) : state.status === "error" ? (
                <>
                  <span role="alert">Page preview unavailable.</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      manualActivation.current = true;
                      request();
                      setAttempt((value) => value + 1);
                    }}
                  >
                    Retry preview
                  </Button>
                </>
              ) : needsActivation ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!enabled}
                  onClick={() => {
                    manualActivation.current = true;
                    request();
                    setAttempt((value) => value + 1);
                  }}
                >
                  Retry preview
                </Button>
              ) : (
                <span role="status">Loading preview…</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
