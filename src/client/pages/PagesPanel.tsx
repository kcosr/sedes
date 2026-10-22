import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PanelsTopLeft, RotateCcw } from "lucide-react";
import type { PageRevision, PageRevisionPage } from "../../shared/protocol/pages.js";
import { CLOSE_PAGE_EVENT, OPEN_OVERLAY_SELECTOR } from "../app/android-back.js";
import { Button } from "../components/ui/button.js";
import { EmptyState } from "../components/ui/empty-state.js";
import type { PageDocumentServices } from "../lib/page-services.js";
import { usePageResponseServices } from "../components/conversation/page-response-services.js";
import { useThreadStore } from "../stores/ThreadClientStore.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { PageDocument } from "./PageDocument.js";
import { parsePagesPanelIntent } from "./pages-panel-intent.js";
import "./pages-panel.css";

/** Device-wide placement, with list and document state owned by the current thread. */
export function PagesPanel({ context }: { readonly context: WorkspacePanelContext }): React.JSX.Element {
  const consumedSequence = useRef(0);
  if (!context.threadId) return <EmptyState className="pages-empty" title="Open a thread to browse its pages." />;
  return <ThreadPagesPanel key={context.threadId} context={context} threadId={context.threadId} consumedSequence={consumedSequence} />;
}

function uniquePages(items: readonly PageRevision[], threadId: string): PageRevision[] {
  const pages = new Map<string, PageRevision>();
  for (const page of items) {
    if (page.threadId !== threadId) continue;
    const existing = pages.get(page.pageId);
    if (!existing || page.revision > existing.revision) pages.set(page.pageId, page);
  }
  return [...pages.values()];
}

function ThreadPagesPanel({ context, threadId, consumedSequence }: {
  readonly context: WorkspacePanelContext;
  readonly threadId: string;
  readonly consumedSequence: RefObject<number>;
}): React.JSX.Element {
  const { threadRegistry, host, visible } = context;
  const store = useMemo(() => threadRegistry.get(threadId), [threadRegistry, threadId]);
  const state = useThreadStore(store);
  const pageResponse = usePageResponseServices(store, state);
  const storeServices = useMemo<Omit<PageDocumentServices, "pageResponse">>(() => ({
    preparePageDownload: (page, signal) => store.preparePageDownload(page, signal),
    createPageRenderAdmission: (pageId, revision, signal) => store.createPageRenderAdmission(pageId, revision, signal),
    listPageRevisions: (pageId, options) => store.listPageRevisions(pageId, options),
    getPageRevision: (pageId, revision, signal) => store.getPageRevision(pageId, revision, signal),
  }), [store]);
  const services = useMemo<PageDocumentServices>(() => ({ ...storeServices, pageResponse }), [storeServices, pageResponse]);
  const [result, setResult] = useState<PageRevisionPage>({ items: [] });
  const resultRef = useRef(result); resultRef.current = result;
  const [selected, setSelected] = useState<{ page: PageRevision; occurrence: number }>();
  const occurrence = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const returnPageId = useRef<string | undefined>(undefined);
  const focusList = useRef(false);
  const focusDocument = useRef(false);

  useEffect(() => {
    threadRegistry.retainCached(threadId);
    return () => threadRegistry.releaseCached(threadId);
  }, [threadRegistry, threadId]);

  const select = useCallback((page: PageRevision, fromBrowser = false) => {
    if (page.threadId !== threadId) return;
    if (list.current) listScroll.current = list.current.scrollTop;
    returnPageId.current = page.pageId;
    // The clicked row goes away. Chat intents use the layout's own focus request.
    focusDocument.current = fromBrowser;
    setSelected({ page, occurrence: ++occurrence.current });
  }, [threadId]);

  useEffect(() => {
    const intent = parsePagesPanelIntent(context.intent);
    if (!intent) return;
    if (intent.sequence > consumedSequence.current) {
      consumedSequence.current = intent.sequence;
      if (intent.threadId === threadId && intent.page.threadId === threadId) select(intent.page);
    }
    host.consumeIntent(intent.sequence);
  }, [context.intent, consumedSequence, host, select, threadId]);

  const load = useCallback(async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const previous = resultRef.current;
    setLoading(true);
    setError("");
    try {
      let page = await store.listPages({ cursor, limit: 50, signal: controller.signal });
      if (controller.signal.aborted) return;
      let items = uniquePages(page.items, threadId);
      // A refresh preserves the depth already browsed without selecting a new document.
      while (!cursor && page.nextCursor && items.length < previous.items.length) {
        page = await store.listPages({ cursor: page.nextCursor, limit: 50, signal: controller.signal });
        if (controller.signal.aborted) return;
        items = uniquePages([...items, ...page.items], threadId);
      }
      const next = {
        items: cursor ? uniquePages([...previous.items, ...items], threadId) : items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
      resultRef.current = next;
      setResult(next);
    } catch {
      if (!controller.signal.aborted) setError("Could not load published pages.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [store, threadId]);

  const publications = useMemo(() => visible ? JSON.stringify(Object.values(state.snapshot?.itemsById ?? {})
    .filter((item) => item.kind === "page")
    .map((item) => item.id).sort()) : "", [state.snapshot?.itemsById, visible]);

  useEffect(() => {
    if (!visible) { setLoading(false); return; }
    void load();
    return () => request.current?.abort();
  }, [load, publications, visible]);

  useEffect(() => {
    if (!visible) return;
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load, visible]);

  const back = useCallback(() => {
    focusDocument.current = false;
    setSelected(undefined);
    focusList.current = true;
  }, []);

  useEffect(() => {
    if (!visible || !selected) return;
    const onClose = (event: Event) => {
      if (event.defaultPrevented || document.querySelector(OPEN_OVERLAY_SELECTOR)) return;
      event.preventDefault();
      back();
    };
    window.addEventListener(CLOSE_PAGE_EVENT, onClose);
    return () => window.removeEventListener(CLOSE_PAGE_EVENT, onClose);
  }, [back, selected, visible]);

  useEffect(() => {
    if (!visible || !selected || !focusDocument.current) return;
    const target = panel.current?.querySelector<HTMLElement>("[data-panel-autofocus]");
    if (!target) return;
    focusDocument.current = false;
    target.focus({ preventScroll: true });
  }, [selected, visible]);

  useEffect(() => {
    if (!visible || selected || !list.current) return;
    list.current.scrollTop = listScroll.current;
    if (!focusList.current) return;
    focusList.current = false;
    const row = [...list.current.querySelectorAll<HTMLButtonElement>("[data-page-id]")]
      .find((button) => button.dataset.pageId === returnPageId.current);
    (row ?? list.current).focus({ preventScroll: true });
  }, [selected, visible]);

  return (
    <div className="pages-panel" ref={panel}>
      {selected ? (
        <PageDocument
          key={selected.occurrence}
          page={selected.page}
          services={services}
          visible={visible}
          onBack={back}
          latestRevision={result.items.find((page) => page.pageId === selected.page.pageId)?.revision}
        />
      ) : (
        <>
          <div className="pages-browser-toolbar">
            <span>Pages in this thread</span>
            <Button variant="ghost" size="icon-sm" aria-label="Refresh pages" title="Refresh pages" disabled={loading} onClick={() => void load()}>
              <RotateCcw aria-hidden="true" />
            </Button>
          </div>
          <nav className="pages-browser" aria-label="Published pages" ref={list} tabIndex={-1} data-panel-autofocus onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }}>
            {error ? <div className="pages-list-error" role="alert"><span>{error}</span><Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>Try again</Button></div> : null}
            {result.items.length ? <ul className="pages-list">
              {result.items.map((page) => <li key={page.pageId}>
                <button type="button" className="pages-row" data-page-id={page.pageId} onClick={() => select(page, true)}>
                  <PanelsTopLeft aria-hidden="true" />
                  <span>{page.title}</span>
                </button>
              </li>)}
            </ul> : !loading && !error ? <EmptyState className="pages-empty" title="No pages have been published." description="Pages published in this thread will appear here, including earlier history." /> : null}
            {loading ? <p className="pages-list-status" role="status">Loading pages…</p> : null}
            {result.nextCursor ? <Button className="pages-load-more" variant="ghost" size="sm" disabled={loading} onClick={() => void load(result.nextCursor)}>Load more pages</Button> : null}
          </nav>
        </>
      )}
    </div>
  );
}
