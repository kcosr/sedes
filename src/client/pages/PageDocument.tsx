import { ArrowLeft, ChevronLeft, ChevronRight, Download, LoaderCircle, Lock, LockOpen, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PageRevision } from "../../shared/protocol/pages.js";
import { useConnectionScope } from "../app/connection-scope.js";
import { Button } from "../components/ui/button.js";
import { PageFrame } from "../components/conversation/PageFrame.js";
import type { PageDocumentServices } from "../lib/page-services.js";
import { pageFrameRecoveryKey } from "../components/conversation/page-frame-recovery.js";
import { usePageDownload } from "../components/conversation/page-download.js";
import { usePageResponseSubmission } from "../components/conversation/page-response-submission.js";
import "../components/conversation/page-preview.css";

interface PageDocumentProps {
  readonly page: PageRevision;
  readonly services: PageDocumentServices;
  readonly visible: boolean;
  readonly onBack: () => void;
  readonly revisionRefreshKey?: string;
}

/** The anchor is the exact revision opened from chat or the browser. */
export function PageDocument(props: PageDocumentProps): React.JSX.Element {
  const connection = useConnectionScope();
  return <PageDocumentView key={pageFrameRecoveryKey(connection, props.page)} {...props} />;
}

const ignoreInteractionChange = () => undefined;

function PageDocumentView({ page, services, visible, onBack, revisionRefreshKey }: PageDocumentProps): React.JSX.Element {
  const [selected, setSelected] = useState(page);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadedLatestRevision, setLatestRevision] = useState<number>();
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const [revisionCheckVersion, setRevisionCheckVersion] = useState(0);
  const openingRefreshKey = useRef(revisionRefreshKey);
  const lastCheckedRevision = useRef<number | undefined>(undefined);
  const latestPage = useRef(page);
  const catchUp = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const connection = useConnectionScope();
  const download = usePageDownload(
    pageFrameRecoveryKey(connection, selected), selected, true, services.preparePageDownload, connection.profileId,
  );
  const response = usePageResponseSubmission(
    pageFrameRecoveryKey(connection, selected), selected, services.pageResponse,
  );

  useEffect(() => {
    if (!visible || !services.listPageRevisions) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setLoading(true);
    setError("");
    void services
      .listPageRevisions(page.pageId, {
        limit: 1,
        signal: controller.signal,
      })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          const newest = result.items[0];
          if (!newest) return;
          if (newest.revision > latestPage.current.revision) latestPage.current = newest;
          const previousRevision = lastCheckedRevision.current;
          // Opening an old chat occurrence keeps its exact revision. Later
          // publications advance even a manually browsed document unless locked.
          const updated = newest.revision > (previousRevision ?? page.revision) &&
            (previousRevision !== undefined || revisionRefreshKey !== openingRefreshKey.current);
          lastCheckedRevision.current = Math.max(previousRevision ?? page.revision, newest.revision);
          setLatestRevision(latestPage.current.revision);
          if (!lockedRef.current && (updated || catchUp.current)) {
            catchUp.current = false;
            setSelected(latestPage.current);
          }
        },
        () => {
          if (!controller.signal.aborted)
            setError("Could not load page revisions.");
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => abort.current?.abort();
  }, [
    visible,
    page.pageId,
    page.revision,
    services.listPageRevisions,
    refreshVersion,
    revisionRefreshKey,
    revisionCheckVersion,
  ]);

  useEffect(() => {
    if (!visible) return;
    const check = () => setRevisionCheckVersion((value) => value + 1);
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [visible]);

  const navigateRevision = async (direction: -1 | 1) => {
    if (!visible || loading || !services.listPageRevisions || !services.getPageRevision)
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
      if (newest && newest.revision > latestPage.current.revision) latestPage.current = newest;
      setLatestRevision(latestPage.current.revision);
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

  const returnToPublishedRevision = () => {
    abort.current?.abort();
    catchUp.current = false;
    setLoading(false);
    setError("");
    setSelected(page);
  };

  const latestRevision = Math.max(page.revision, selected.revision, loadedLatestRevision ?? 0);
  const hasRevisions = latestRevision > 1;

  const headerActions = (
    <div
      className="page-preview-header-actions"
      role="toolbar"
      aria-label="Page actions"
    >
      {hasRevisions ? (
        <>
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
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            {selected.revision === page.revision ? (
              <span
                aria-live="polite"
                aria-label={`Revision ${selected.revision} of ${latestRevision}`}
                className="page-revision-label"
              >
                {selected.revision}/{latestRevision}
              </span>
            ) : (
              <Button
                className="page-revision-label"
                variant="ghost"
                size="sm"
                aria-label={`Return to published revision ${page.revision}`}
                title={`Published here as revision ${page.revision}; return to it`}
                onClick={returnToPublishedRevision}
              >
                {selected.revision}/{latestRevision}
              </Button>
            )}
            <Button
              aria-label={
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
              size="icon-sm"
              variant="ghost"
            >
              <ChevronRight />
            </Button>
          </div>
          <span className="page-preview-header-separator" aria-hidden="true" />
        </>
      ) : null}
      <Button
        aria-label={locked ? "Unlock page revision" : "Lock page revision"}
        title={locked ? "Unlock and load the latest revision" : "Lock this revision to pause automatic updates"}
        aria-pressed={locked}
        disabled={!visible || !services.listPageRevisions}
        onClick={() => {
          lockedRef.current = !lockedRef.current;
          setLocked(lockedRef.current);
          if (!lockedRef.current) {
            catchUp.current = true;
            setRevisionCheckVersion((value) => value + 1);
          }
        }}
        size="icon-sm"
        variant={locked ? "secondary" : "ghost"}
      >
        {locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
      </Button>
      <Button
        aria-label="Refresh page preview"
        title="Refresh preview"
        onClick={() => {
          response.reset();
          setRefreshVersion((value) => value + 1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <RotateCcw />
      </Button>
      <Button
        aria-label={download.phase === "preparing" ? "Preparing HTML download" : download.phase === "started" ? "HTML download started" : "Download HTML"}
        title="Download HTML"
        aria-busy={download.phase !== "idle" || undefined}
        disabled={!visible || !services.preparePageDownload || download.phase !== "idle"}
        onClick={() => void download.download()}
        size="icon-sm"
        variant="ghost"
      >
        {download.phase === "preparing" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}
      </Button>
    </div>
  );

  return <div className="page-document" data-page-id={selected.pageId} data-page-revision={selected.revision}
    data-page-anchor-revision={page.revision} role="group" aria-label={selected.title} aria-busy={loading}>
    <header className="page-document-header">
      <div className="page-document-heading">
        <Button variant="ghost" size="sm" aria-label="Back to Pages" data-panel-autofocus onClick={onBack}><ArrowLeft aria-hidden="true" />Pages</Button>
        <h3 className="page-preview-name" title={selected.title}>{selected.title}</h3>
      </div>
      {headerActions}
    </header>
    {error ? <p className="page-preview-error" role="alert">{error}</p> : null}
    {download.error || download.status ? <p className={download.error ? "page-preview-error" : "page-preview-download-status"}
      role={download.error ? "alert" : "status"}>{download.error || download.status}</p> : null}
    <PageFrame key={`${selected.pageId}:${selected.revision}`} page={selected} createAdmission={services.createPageRenderAdmission}
      responseServices={services.pageResponse} response={response} enabled={visible} interactive
      onActivate={ignoreInteractionChange} onDeactivate={ignoreInteractionChange} refreshVersion={refreshVersion} documentView />
  </div>;
}
