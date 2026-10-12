import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import { MediaFrame } from "../../workbench/components/MediaFrame.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
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

/** Local revision browsing never changes the immutable reference in chat. */
export function PagePreview({
  page,
  services,
}: {
  readonly page: PageRevision;
  readonly services: PagePreviewServices;
}): React.JSX.Element {
  const [selected, setSelected] = useState(page);
  const [expanded, setExpanded] = useState(false);
  const [latestRevision, setLatestRevision] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const expandButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSelected(page);
    setLatestRevision(undefined);
    setError("");
    return () => abort.current?.abort();
  }, [page.pageId, page.revision]);

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

  const controls = (
    <>
      <Button
        aria-label="Previous page revision"
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
      <span aria-live="polite" className="page-revision-label">
        Revision {selected.revision}
      </span>
      <Button
        aria-label={
          latestRevision !== undefined && selected.revision >= latestRevision
            ? "Check for a newer page revision"
            : "Next page revision"
        }
        title={
          latestRevision !== undefined && selected.revision >= latestRevision
            ? "Check for a newer page revision"
            : "Next page revision"
        }
        disabled={
          loading || !services.listPageRevisions || !services.getPageRevision
        }
        onClick={() => void navigateRevision(1)}
        size="icon-xs"
        variant="ghost"
      >
        <ChevronRight />
      </Button>
      {selected.revision !== page.revision ? (
        <Button onClick={() => setSelected(page)} size="xs" variant="ghost">
          Original
        </Button>
      ) : null}
      <Button
        ref={expandButton}
        aria-label={`Expand page: ${selected.title}`}
        onClick={() => setExpanded(true)}
        size="icon-xs"
        variant="ghost"
      >
        <Maximize2 />
      </Button>
    </>
  );

  return (
    <>
      <MediaFrame
        className="page-preview"
        data-page-id={page.pageId}
        data-page-revision={page.revision}
        aria-busy={loading}
        title={selected.title}
        metadata={
          selected.revision === page.revision
            ? "HTML preview"
            : `Published here as revision ${page.revision}`
        }
        actions={controls}
      >
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
        />
      </MediaFrame>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          size="viewer"
          layer="over-dialog"
          returnFocusRef={expandButton}
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
  expanded = false,
}: {
  readonly page: PageRevision;
  readonly createAdmission: PagePreviewServices["createPageRenderAdmission"];
  readonly enabled: boolean;
  readonly expanded?: boolean;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(page.viewport.width ?? 640);
  const [height, setHeight] = useState(page.viewport.height ?? 240);
  const [zoom, setZoom] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [needsActivation, setNeedsActivation] = useState(false);
  const manualActivation = useRef(false);
  const activeRecoveryKey = useRef<string | undefined>(undefined);
  const wasAdmitted = useRef(false);
  const [state, setState] = useState<
    | { status: "waiting" | "loading" | "error" }
    | {
        status: "ready";
        url: string;
        channel: string;
        recovery: PageFrameRecoveryAttempt;
      }
  >({ status: "waiting" });
  const { admitted, request } = usePageFrameAdmission(
    host,
    enabled,
    expanded,
    !isAndroidClient() && !needsActivation,
  );
  const layout = pageFrameLayout(page.viewport, width, height, zoom);
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
      if (wasAdmitted.current) manualActivation.current = false;
      wasAdmitted.current = false;
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
    wasAdmitted.current = true;
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
        <div
          className="page-frame-toolbar"
          role="group"
          aria-label="Page zoom controls"
        >
          <span>
            {page.title} · Revision {page.revision}
          </span>
          <Button
            aria-label="Zoom out"
            disabled={zoom <= 0.25}
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
            size="icon-xs"
            variant="ghost"
          >
            <ZoomOut />
          </Button>
          <output aria-label="Page zoom level">
            {Math.round(layout.scale * 100)}%
          </output>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= 4}
            onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
            size="icon-xs"
            variant="ghost"
          >
            <ZoomIn />
          </Button>
          <Button
            aria-label="Fit page to view"
            onClick={() => setZoom(1)}
            size="icon-xs"
            variant="ghost"
          >
            <RotateCcw />
          </Button>
          <Button
            onClick={() =>
              setZoom(1 / pageFrameLayout(page.viewport, width, height).scale)
            }
            size="xs"
            variant="ghost"
          >
            Actual size
          </Button>
        </div>
      ) : null}
      <div
        className="page-frame-viewport"
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
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!enabled}
                  onClick={() => {
                    manualActivation.current = true;
                    request();
                  }}
                >
                  Run interactive preview
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {page.viewport.width !== undefined ? (
        <div className="page-frame-size">
          {page.viewport.width} × {page.viewport.height ?? "content"} px
        </div>
      ) : null}
    </div>
  );
}
