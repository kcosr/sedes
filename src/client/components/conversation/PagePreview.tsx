import {
  Check,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Maximize2,
  Pointer,
  RotateCcw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import { MediaFrame } from "../../workbench/components/MediaFrame.js";
import { MediaZoomControls } from "../../workbench/components/MediaZoomControls.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import type { ItemRenderContext } from "./types.js";
import { pageFrameLayout, pageFrameMessage } from "./page-frame-layout.js";
import {
  PageFrameLoadGuard,
  usePageFrameAdmission,
} from "./page-frame-lifecycle.js";
import { supportsSafePageFrames } from "../../app/page-safety.js";
import { isAndroidClient } from "../../app/client-platform.js";
import {
  PageFrameRecoveryAttempt,
  pageFrameNeedsActivation,
  pageFrameRecoveryKey,
} from "./page-frame-recovery.js";
import "../../workbench/styles/media-frame.css";
import "./page-preview.css";

export type PagePreviewServices = Pick<
  ItemRenderContext,
  "createPageRenderAdmission" | "listPageRevisions" | "getPageRevision"
>;

// Interaction follows the input device, not the width of a desktop window.
function readTouchInput(): boolean {
  return (
    isAndroidClient() ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches)
  );
}
function subscribeTouchInput(notify: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(pointer: coarse)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

/** Each occurrence keeps its pinned revision and its own interaction state. */
export function PagePreview({
  page,
  services,
}: {
  readonly page: PageRevision;
  readonly services: PagePreviewServices;
}): React.JSX.Element {
  const [selected, setSelected] = useState(page);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [latestRevision, setLatestRevision] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const menuButton = useRef<HTMLButtonElement>(null);
  const touchInput = useSyncExternalStore(
    subscribeTouchInput,
    readTouchInput,
    () => false,
  );
  const deactivate = useCallback(() => setInteracting(false), []);

  useEffect(() => {
    setSelected(page);
    setLatestRevision(undefined);
    setError("");
    return () => abort.current?.abort();
  }, [page.pageId, page.revision]);
  useEffect(deactivate, [
    deactivate,
    selected.pageId,
    selected.revision,
    touchInput,
  ]);

  const navigateRevision = async (direction: -1 | 1) => {
    if (loading || !services.listPageRevisions || !services.getPageRevision)
      return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError("");
    try {
      const newest = (
        await services.listPageRevisions(page.pageId, {
          limit: 1,
          signal: controller.signal,
        })
      ).items[0];
      if (controller.signal.aborted) return;
      setLatestRevision(newest?.revision);
      const wanted = selected.revision + direction;
      if (newest && wanted >= 1 && wanted <= newest.revision) {
        const next =
          wanted === newest.revision
            ? newest
            : await services.getPageRevision(
                page.pageId,
                wanted,
                controller.signal,
              );
        if (!controller.signal.aborted) setSelected(next);
      }
    } catch {
      if (!controller.signal.aborted)
        setError("Could not load page revisions.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return (
    <>
      <MediaFrame
        className="page-preview"
        data-page-id={page.pageId}
        data-page-revision={page.revision}
        data-interacting={touchInput && interacting ? "true" : undefined}
        aria-busy={loading}
        role="group"
        aria-label={selected.title}
      >
        <div className="page-preview-controls">
          {touchInput ? (
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={
                interacting
                  ? "Done interacting with preview"
                  : "Interact with preview"
              }
              title={
                interacting
                  ? "Done interacting with preview"
                  : "Interact with preview"
              }
              aria-pressed={interacting}
              className="page-preview-interact"
              onClick={() => setInteracting((value) => !value)}
            >
              {interacting ? <Check /> : <Pointer />}
            </Button>
          ) : null}
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={menuButton}
                size="icon-xs"
                variant="outline"
                aria-label={`Page details: ${selected.title}`}
                title="Page details"
              >
                <Ellipsis />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="page-preview-menu"
              onCloseAutoFocus={(event) => {
                if (expanded) event.preventDefault();
              }}
            >
              <span className="page-preview-name" title={selected.title}>
                {selected.title}
              </span>
              <div
                className="page-preview-revisions"
                role="group"
                aria-label="Page revision controls"
              >
                <Button
                  aria-label="Previous page revision"
                  title="Previous revision"
                  disabled={
                    loading ||
                    selected.revision <= 1 ||
                    !services.listPageRevisions ||
                    !services.getPageRevision
                  }
                  onClick={() => void navigateRevision(-1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <ChevronLeft />
                </Button>
                {selected.revision === page.revision ? (
                  <span
                    aria-live="polite"
                    aria-label={`Revision ${selected.revision}`}
                    className="page-revision-label"
                  >
                    v{selected.revision}
                  </span>
                ) : (
                  <Button
                    className="page-revision-label"
                    variant="ghost"
                    size="xs"
                    aria-label={`Return to published revision ${page.revision}`}
                    title={`Published here as revision ${page.revision}; return to it`}
                    onClick={() => setSelected(page)}
                  >
                    v{selected.revision}
                  </Button>
                )}
                <Button
                  aria-label={
                    latestRevision !== undefined &&
                    selected.revision >= latestRevision
                      ? "Check for a newer page revision"
                      : "Next page revision"
                  }
                  title="Next revision"
                  disabled={
                    loading ||
                    !services.listPageRevisions ||
                    !services.getPageRevision
                  }
                  onClick={() => void navigateRevision(1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <ChevronRight />
                </Button>
              </div>
              <span
                className="page-preview-menu-separator"
                aria-hidden="true"
              />
              <Button
                aria-label={`Expand page: ${selected.title}`}
                title="Expand preview"
                onClick={() => {
                  setMenuOpen(false);
                  setExpanded(true);
                  deactivate();
                }}
                size="icon-xs"
                variant="ghost"
              >
                <Maximize2 />
              </Button>
              <Button
                aria-label="Refresh page preview"
                title="Refresh preview"
                onClick={() => {
                  setRefreshVersion((value) => value + 1);
                  setMenuOpen(false);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <RotateCcw />
              </Button>
            </PopoverContent>
          </Popover>
        </div>
        {error ? (
          <p className="page-preview-error" role="alert">
            {error}
          </p>
        ) : null}
        <PageFrame
          key={`${selected.pageId}:${selected.revision}`}
          page={selected}
          createAdmission={services.createPageRenderAdmission}
          enabled={!expanded}
          interactive={!touchInput || interacting}
          onDeactivate={deactivate}
          refreshVersion={refreshVersion}
        />
      </MediaFrame>
      <Dialog
        open={expanded}
        onOpenChange={(value) => {
          setExpanded(value);
          deactivate();
        }}
      >
        <DialogContent
          size="viewer"
          layer="over-dialog"
          returnFocusRef={menuButton}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">
            {selected.title} · Revision {selected.revision}
          </DialogTitle>
          <PageFrame
            key={`${selected.pageId}:${selected.revision}`}
            page={selected}
            createAdmission={services.createPageRenderAdmission}
            enabled={expanded}
            interactive
            onDeactivate={deactivate}
            refreshVersion={refreshVersion}
            expanded
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PageFrame({
  page,
  createAdmission,
  enabled,
  interactive,
  onDeactivate,
  refreshVersion,
  expanded = false,
}: {
  readonly page: PageRevision;
  readonly createAdmission: PagePreviewServices["createPageRenderAdmission"];
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly onDeactivate: () => void;
  readonly refreshVersion: number;
  readonly expanded?: boolean;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(page.viewport.width ?? 640);
  const [height, setHeight] = useState(page.viewport.height ?? 240);
  const [availableHeight, setAvailableHeight] = useState(0);
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
        recovery: PageFrameRecoveryAttempt;
      }
  >({ status: "waiting" });
  const { admitted, request, visible } = usePageFrameAdmission(
    host,
    enabled,
    expanded,
    !needsActivation,
  );
  const fitted = pageFrameLayout(page.viewport, width, height);
  const fitScale =
    expanded && availableHeight > 0
      ? Math.min(
          fitted.scale,
          Math.max(1, availableHeight - 64) / fitted.height,
        )
      : fitted.scale;
  const scale = zoom ?? fitScale;
  const layout = pageFrameLayout(
    page.viewport,
    width,
    height,
    scale / fitted.scale,
  );
  useEffect(() => {
    if (!visible) manualActivation.current = false;
  }, [visible]);
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
    enabled && admitted && state.status === "ready" ? state : undefined;
  const loadGuard = useRef(new PageFrameLoadGuard());
  const handshakeAcknowledged = useRef(false);
  const wrapperAcknowledged = useRef(false);
  const handshakeTimeout = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
      setAvailableHeight(element.clientHeight);
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
      const recoveryKey = pageFrameRecoveryKey(admission.url, page);
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
      setState({ status: "ready", url, channel, recovery });
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
  ]);

  useLayoutEffect(() => {
    if (!ready) return;
    handshakeAcknowledged.current = false;
    wrapperAcknowledged.current = false;
    const fail = () => {
      ready.recovery.fail();
      setNeedsActivation(true);
      setState({ status: "error" });
    };
    // Transport can take longer than bootstrap execution for a large document.
    handshakeTimeout.current = window.setTimeout(fail, 60_000);
    const receive = (event: MessageEvent) => {
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
      window.clearTimeout(handshakeTimeout.current);
      handshakeTimeout.current = undefined;
      window.removeEventListener("message", receive);
    };
  }, [page.viewport.height, ready]);

  return (
    <div
      className={`page-frame-shell${expanded ? " page-frame-expanded" : ""}`}
    >
      {expanded ? (
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
        tabIndex={expanded ? 0 : undefined}
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
