import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PageRevision,
  PageRevisionPage,
} from "../../../shared/protocol/pages.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { PagePreview } from "../conversation/PagePreview.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import "./thread-pages-dialog.css";

/** Durable discovery also finds pages whose original turn was compacted away. */
export function ThreadPagesDialog({
  open,
  onOpenChange,
  store,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly store: ThreadClientStore;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [result, setResult] = useState<PageRevisionPage>({ items: [] });
  const [selected, setSelected] = useState<PageRevision>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const services = useMemo(
    () => ({
      createPageRenderAdmission: (
        pageId: string,
        revision: number,
        signal?: AbortSignal,
      ) => store.createPageRenderAdmission(pageId, revision, signal),
      listPageRevisions: (
        pageId: string,
        options?: import("../../api/ApiClient.js").PageListOptions,
      ) => store.listPageRevisions(pageId, options),
      getPageRevision: (
        pageId: string,
        revision: number,
        signal?: AbortSignal,
      ) => store.getPageRevision(pageId, revision, signal),
    }),
    [store],
  );
  const load = useCallback(
    (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      void store
        .listPages({ cursor, limit: 50, signal: controller.signal })
        .then(
          (page) => {
            if (controller.signal.aborted) return;
            setResult((previous) => ({
              ...page,
              items: cursor ? [...previous.items, ...page.items] : page.items,
            }));
            if (!cursor) setSelected(page.items[0]);
          },
          () => {
            if (!controller.signal.aborted)
              setError("Could not load published pages.");
          },
        )
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [store],
  );

  useEffect(() => {
    if (open) load();
    return () => request.current?.abort();
  }, [load, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>Published pages</DialogTitle>
          <DialogDescription>
            Saved HTML previews from this conversation, including earlier
            history.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="thread-pages-layout">
            <nav aria-label="Published pages" className="thread-pages-list">
              <Button
                size="xs"
                variant="outline"
                onClick={() => load()}
                disabled={loading}
              >
                Refresh pages
              </Button>
              {result.items.map((page) => (
                <Button
                  key={page.pageId}
                  variant={
                    page.pageId === selected?.pageId ? "secondary" : "ghost"
                  }
                  onClick={() => setSelected(page)}
                  aria-current={
                    page.pageId === selected?.pageId ? "true" : undefined
                  }
                >
                  <span>{page.title}</span>
                  <span className="thread-pages-list-revision">
                    Revision {page.revision}
                  </span>
                </Button>
              ))}
              {result.nextCursor ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={loading}
                  onClick={() => load(result.nextCursor)}
                >
                  Load more pages
                </Button>
              ) : null}
              {loading ? <p role="status">Loading pages…</p> : null}
              {!loading && !error && !result.items.length ? (
                <p>No pages have been published.</p>
              ) : null}
              {error ? <p role="alert">{error}</p> : null}
            </nav>
            <div className="thread-pages-selected">
              {open && selected ? (
                <PagePreview
                  key={`${selected.pageId}:${selected.revision}`}
                  page={selected}
                  services={services}
                />
              ) : null}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
