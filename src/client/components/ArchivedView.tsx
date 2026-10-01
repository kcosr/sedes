import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Archive, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuValue,
} from "@client/components/ui/dropdown-menu";
import { EmptyState } from "@client/components/ui/empty-state";
import { Input } from "@client/components/ui/input";
import {
  ARCHIVE_PAGE_SIZE,
  archiveAgeLabel,
  archiveRowTimestamp,
  archiveTimesTitle,
  effectiveArchiveGroupBy,
  pageArchivedThreads,
  projectArchivedThreads,
  selectArchiveBase,
  type ArchiveBase,
  type ArchiveGroupBy,
  type ArchiveProjection,
  type ArchiveSort,
  type ArchivedThreadRow as ArchivedThreadRowModel,
} from "../archive/archived-threads.js";
import {
  setArchiveGroupBy,
  setArchiveSort,
  useArchiveViewPreferences,
} from "../archive/archive-view-preferences.js";
import { useSidebarInventoryScope } from "../app/use-sidebar-inventory-scope.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import {
  messageFrom,
  type ApplicationClientState,
  type ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../stores/use-application-store-selector.js";
import {
  ArchivedThreadRow,
  type ArchiveRestoreStatus,
} from "./ArchivedThreadRow.js";
import "./archived-view.css";

const SORT_OPTIONS: ReadonlyArray<{
  readonly value: ArchiveSort;
  readonly label: string;
}> = [
  { value: "archived", label: "Recently archived" },
  { value: "activity", label: "Last active" },
  { value: "title", label: "Title" },
];

const GROUP_OPTIONS: ReadonlyArray<{
  readonly value: ArchiveGroupBy;
  readonly label: string;
}> = [
  { value: "date", label: "Date" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];

const countFormat = new Intl.NumberFormat();

/** Only snapshot changes (and copy-pending flags) can change the archive. */
function selectBase(
  state: ApplicationClientState,
  previous: ArchiveBase | undefined,
): ArchiveBase {
  return selectArchiveBase(
    state.snapshot,
    state.pendingThreadConfigurationCopySourceIds,
    previous,
  );
}

function selectSearch(state: ApplicationClientState): string {
  return state.search;
}

/** Wall-clock minutes for ages and date buckets. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(1_000, 60_010 - (Date.now() % 60_000)),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

function ArchiveViewOptions({
  sort,
  groupBy,
}: {
  readonly sort: ArchiveSort;
  readonly groupBy: ArchiveGroupBy;
}): React.JSX.Element {
  // A sheet on touch, like the sidebar's View options.
  const sheet = useTouchDensity();
  const effective = effectiveArchiveGroupBy(sort, groupBy);
  return (
    <DropdownMenu presentation={sheet ? "sheet" : "menu"}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="archive-view-options"
          data-testid="archive-view-options"
          aria-label="View options"
          title="View options"
        >
          <SlidersHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="View options"
        sheetTitle="View options"
        align="end"
        className={sheet ? undefined : "w-56"}
      >
        <DropdownMenuLabel>Sort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Sort by"
          value={sort}
          onValueChange={(value) => setArchiveSort(value as ArchiveSort)}
        >
          {SORT_OPTIONS.map(({ value, label }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Group by"
          value={effective}
          onValueChange={(value) => setArchiveGroupBy(value as ArchiveGroupBy)}
        >
          {GROUP_OPTIONS.map(({ value, label }) => {
            const disabled = value === "date" && sort === "title";
            return (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                disabled={disabled}
              >
                {label}
                {disabled && (
                  <DropdownMenuValue>Not with Title sort</DropdownMenuValue>
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row at a list position, counting through the groups in order. */
function rowAt(
  projection: ArchiveProjection,
  index: number,
): ArchivedThreadRowModel | undefined {
  let offset = index;
  for (const group of projection.groups) {
    if (offset < group.rows.length) return group.rows[offset];
    offset -= group.rows.length;
  }
  return undefined;
}

interface FocusAfterRestore {
  readonly threadId: string;
  /** Following rows first, then preceding rows nearest first. */
  readonly candidates: readonly string[];
}

/**
 * Archived threads. The list honors the sidebar's Scope and search (both are
 * shared with the sidebar) and pages its rows; it subscribes only to the
 * archive-relevant part of the application store, so unrelated events do not
 * re-render it.
 */
export const ArchivedView = memo(function ArchivedView({
  store,
}: {
  store: ApplicationClientStore;
}): React.JSX.Element {
  const base = useApplicationStoreSelector(store, selectBase);
  const search = useApplicationStoreSelector(store, selectSearch);
  // The input stays immediate; the list follows without blocking typing.
  const deferredSearch = useDeferredValue(search);
  const {
    scope,
    active: scopeActive,
    summary: scopeSummary,
    clearScope,
  } = useSidebarInventoryScope(base.catalog);
  const { sort, groupBy } = useArchiveViewPreferences();
  const now = useMinuteClock();

  const projection = useMemo(
    () =>
      projectArchivedThreads(base, {
        scope,
        search: deferredSearch,
        sort,
        groupBy,
        now,
      }),
    [base, deferredSearch, groupBy, now, scope, sort],
  );

  // Changing what is listed returns to the first page.
  const pageKey = [
    deferredSearch.trim(),
    scope.environmentId,
    scope.targetId,
    scope.projectName,
    scope.groupId,
    scope.ungrouped,
    sort,
    groupBy,
  ].join("\0");
  const [paging, setPaging] = useState({
    key: pageKey,
    limit: ARCHIVE_PAGE_SIZE,
  });
  // Forget the expanded page as soon as the listing changes, so returning to
  // an earlier search starts from the first page again.
  if (paging.key !== pageKey) {
    setPaging({ key: pageKey, limit: ARCHIVE_PAGE_SIZE });
  }
  const limit = paging.key === pageKey ? paging.limit : ARCHIVE_PAGE_SIZE;
  const page = useMemo(
    () => pageArchivedThreads(projection, limit),
    [limit, projection],
  );
  // The first row a "Show more" adds, to take focus if the button unmounts.
  const [focusAfterShowMore, setFocusAfterShowMore] = useState<string>();
  const showMore = useCallback(() => {
    setFocusAfterShowMore(rowAt(projection, page.rows.length)?.id);
    setPaging((current) => ({
      key: pageKey,
      limit:
        (current.key === pageKey ? current.limit : ARCHIVE_PAGE_SIZE) +
        ARCHIVE_PAGE_SIZE,
    }));
  }, [page.rows.length, pageKey, projection]);

  const [restoreStatus, setRestoreStatus] = useState<
    ReadonlyMap<string, ArchiveRestoreStatus>
  >(() => new Map());
  const [focusAfterRestore, setFocusAfterRestore] =
    useState<FocusAfterRestore>();
  const [announcement, setAnnouncement] = useState("");
  const pageRowsRef = useRef(page.rows);
  pageRowsRef.current = page.rows;
  const restoreStatusRef = useRef(restoreStatus);
  restoreStatusRef.current = restoreStatus;
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setStatus = useCallback(
    (threadId: string, status: ArchiveRestoreStatus | undefined) =>
      setRestoreStatus((current) => {
        const next = new Map(current);
        if (status) next.set(threadId, status);
        else next.delete(threadId);
        return next;
      }),
    [],
  );

  /** Following rows first, then preceding rows nearest first. */
  const focusCandidates = useCallback((threadId: string): string[] => {
    const rows = pageRowsRef.current;
    const index = rows.findIndex(({ id }) => id === threadId);
    return index < 0
      ? []
      : [
          ...rows.slice(index + 1).map(({ id }) => id),
          ...rows
            .slice(0, index)
            .reverse()
            .map(({ id }) => id),
        ];
  }, []);

  const restore = useCallback(
    (row: ArchivedThreadRowModel) => {
      const status = restoreStatusRef.current.get(row.id);
      if (status?.kind === "pending" || status?.kind === "restored") return;
      const candidates = focusCandidates(row.id);
      const revision = row.thread.inventoryRevision;
      setStatus(row.id, { kind: "pending", revision });
      store.mutateInventory(row.thread, "restore").then(
        () => {
          // The stream may already have removed the row (and its pending
          // status); a late response must not mark a row that is no longer
          // this restore's.
          setRestoreStatus((current) => {
            const pending = current.get(row.id);
            if (pending?.kind !== "pending" || pending.revision !== revision)
              return current;
            const next = new Map(current);
            next.set(row.id, { kind: "restored", revision });
            return next;
          });
          setAnnouncement(`Restored ${row.title}`);
          setFocusAfterRestore({ threadId: row.id, candidates });
        },
        (error: unknown) =>
          setStatus(row.id, { kind: "error", message: messageFrom(error) }),
      );
    },
    [focusCandidates, setStatus, store],
  );

  // A Restore accepted from the thread actions menu gets the same busy row,
  // announcement, and focus recovery as the row's own Restore.
  const menuRestored = useCallback(
    (row: ArchivedThreadRowModel) => {
      const revision = row.thread.inventoryRevision;
      setRestoreStatus((current) => {
        if (!archivedRevisionsRef.current.has(row.id)) return current;
        const next = new Map(current);
        next.set(row.id, { kind: "restored", revision });
        return next;
      });
      setAnnouncement(`Restored ${row.title}`);
      setFocusAfterRestore({
        threadId: row.id,
        candidates: focusCandidates(row.id),
      });
    },
    [focusCandidates],
  );

  // Forget statuses of rows that left the archive or changed since their
  // restore started, and move focus on from a restored row once the stream
  // removes it.
  const archivedRevisions = useMemo(
    () =>
      new Map(base.rows.map(({ id, thread }) => [id, thread.inventoryRevision])),
    [base.rows],
  );
  const archivedRevisionsRef = useRef(archivedRevisions);
  archivedRevisionsRef.current = archivedRevisions;
  useEffect(() => {
    const stale = [...restoreStatus].flatMap(([id, status]) =>
      !archivedRevisions.has(id) ||
      (status.kind !== "error" &&
        status.revision !== archivedRevisions.get(id))
        ? [id]
        : [],
    );
    if (stale.length === 0) return;
    setRestoreStatus((current) => {
      const next = new Map(current);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [archivedRevisions, restoreStatus]);
  useLayoutEffect(() => {
    if (!focusAfterRestore) return;
    if (page.rows.some(({ id }) => id === focusAfterRestore.threadId)) return;
    setFocusAfterRestore(undefined);
    const list = listRef.current;
    const active = document.activeElement;
    // Only recover focus the removed row dropped; never take it from where
    // the user moved it meanwhile.
    if (active !== null && active !== document.body) return;
    for (const id of focusAfterRestore.candidates) {
      const target = list?.querySelector<HTMLElement>(
        `.archive-row[data-thread-id="${CSS.escape(id)}"] > .archive-row-open`,
      );
      if (target) {
        target.focus();
        return;
      }
    }
    searchRef.current?.focus();
  }, [focusAfterRestore, page.rows]);

  useLayoutEffect(() => {
    if (focusAfterShowMore === undefined) return;
    setFocusAfterShowMore(undefined);
    const active = document.activeElement;
    // The last page unmounts the button: continue from the first added row.
    if (active !== null && active !== document.body) return;
    listRef.current
      ?.querySelector<HTMLElement>(
        `.archive-row[data-thread-id="${CSS.escape(focusAfterShowMore)}"] > .archive-row-open`,
      )
      ?.focus();
  }, [focusAfterShowMore]);

  const searching = deferredSearch.trim().length > 0;
  const filtered = searching || scopeActive;
  const showProject =
    projection.groupBy !== "project" && scope.projectName === null;
  const showTarget = scope.targetId === null;
  const clearSearch = () => {
    store.setSearch("");
    searchRef.current?.focus();
  };
  // The control that cleared the scope disappears with it; keep focus nearby.
  const clearScopeAndFocus = () => {
    clearScope();
    searchRef.current?.focus();
  };

  let empty: React.ReactNode = null;
  if (projection.total === 0) {
    empty = (
      <EmptyState
        icon={<Archive />}
        title="No archived threads"
        description="Threads you archive will appear here. Archiving never deletes a thread."
      />
    );
  } else if (projection.matchCount === 0) {
    const scopeAction = scopeActive ? (
      <Button variant="outline" size="sm" onClick={clearScopeAndFocus}>
        Clear scope
      </Button>
    ) : null;
    empty =
      projection.scopedCount === 0 ? (
        <EmptyState
          icon={<Archive />}
          title="No archived threads in this scope"
          description={`Nothing archived matches ${scopeSummary.fullLabel}.`}
          action={scopeAction}
        />
      ) : (
        <EmptyState
          icon={<Search />}
          title="No matching archived threads"
          description={`Nothing archived matches “${deferredSearch.trim()}”${scopeActive ? ` in ${scopeSummary.fullLabel}` : ""}.`}
          action={
            <>
              <Button variant="outline" size="sm" onClick={clearSearch}>
                Clear search
              </Button>
              {scopeAction}
            </>
          }
        />
      );
  }

  return (
    <section className="archive-view" aria-labelledby="archive-view-title">
      <div className="archive-page">
        <header className="archive-header">
          <div className="archive-heading">
            <h1 id="archive-view-title">Archived</h1>
            <span className="archive-count" data-testid="archive-count">
              {countFormat.format(projection.total)}
              <span className="sr-only"> archived threads</span>
            </span>
          </div>
          <div className="archive-tools">
            <label className="search-box archive-search">
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">Search archived threads</span>
              <Input
                ref={searchRef}
                type="search"
                className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder="Search archive"
                value={search}
                onChange={(event) => store.setSearch(event.target.value)}
              />
            </label>
            <ArchiveViewOptions sort={sort} groupBy={groupBy} />
          </div>
          <p className="archive-status" data-testid="archive-status">
            {filtered ? (
              <span>
                {countFormat.format(projection.matchCount)} of{" "}
                {countFormat.format(projection.total)}
              </span>
            ) : (
              <>
                <span>All threads</span>
                <span>
                  {SORT_OPTIONS.find(({ value }) => value === sort)?.label}
                </span>
              </>
            )}
            {scopeActive && (
              <span title={scopeSummary.fullLabel}>
                Scope: {scopeSummary.visibleLabel}
              </span>
            )}
            {searching && <span>matching “{deferredSearch.trim()}”</span>}
            {scopeActive && (
              <span>
                <button
                  type="button"
                  className="archive-status-action"
                  onClick={clearScopeAndFocus}
                >
                  Clear scope
                </button>
              </span>
            )}
          </p>
        </header>
        <div className="archive-groups" ref={listRef}>
          {empty}
          {page.groups.map((group) => {
            const headingId = `archive-group-${group.key}`;
            const list = (
              <ul
                className="archive-list"
                aria-labelledby={group.label === null ? undefined : headingId}
                aria-label={
                  group.label === null ? "Archived threads" : undefined
                }
              >
                {group.rows.map((row) => {
                  const timestamp = archiveRowTimestamp(row, sort);
                  return (
                    <ArchivedThreadRow
                      key={row.id}
                      row={row}
                      store={store}
                      showProject={showProject}
                      showTarget={showTarget}
                      ageLabel={archiveAgeLabel(timestamp, now)}
                      ageTitle={archiveTimesTitle(row)}
                      ageDateTime={new Date(timestamp).toISOString()}
                      restoreStatus={restoreStatus.get(row.id)}
                      onRestore={restore}
                      onMenuRestored={menuRestored}
                    />
                  );
                })}
              </ul>
            );
            return group.label === null ? (
              <div key={group.key} className="archive-group">
                {list}
              </div>
            ) : (
              <section key={group.key} className="archive-group">
                <h2 id={headingId} className="archive-group-heading">
                  {group.label}
                  <span className="archive-group-count">
                    {" "}
                    · {countFormat.format(group.count)}
                  </span>
                </h2>
                {list}
              </section>
            );
          })}
          {page.remaining > 0 && (
            <div className="archive-more">
              <Button
                variant="outline"
                size="sm"
                data-testid="archive-show-more"
                onClick={showMore}
              >
                Show{" "}
                {countFormat.format(
                  Math.min(ARCHIVE_PAGE_SIZE, page.remaining),
                )}{" "}
                more · {countFormat.format(page.remaining)} remaining
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
});
