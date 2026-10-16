import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, Plus, Repeat, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { EmptyState } from "@client/components/ui/empty-state";
import { Input } from "@client/components/ui/input";
import { Skeleton } from "@client/components/ui/skeleton";
import { useMinuteClock } from "../../app/use-minute-clock.js";
import { useSidebarInventoryScope } from "../../app/use-sidebar-inventory-scope.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import {
  listThreadAutomations,
  projectAutomations,
  selectAutomationsBase,
  type AutomationListRow,
  type AutomationsBase,
  type AutomationsGroupBy,
} from "../../automation/automation-list.js";
import {
  automationGroupCollapsed,
  setAutomationGroupCollapsed,
  setAutomationsGroupBy,
  useAutomationsViewPreferences,
} from "../../automation/automations-view-preferences.js";
import { automationCreatePath, threadPath, navigate, navigateUp } from "../../app/router.js";
import type { ThreadAutomationDefinition } from "../../types.js";
import { Callout } from "@client/components/ui/callout";
import { mutationId } from "../../lib/ids.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import {
  AutomationRow,
  type AutomationRowActionKind,
  type AutomationRowStatus,
} from "./AutomationRow.js";
import { useAutomationUp } from "./automation-navigation.js";
import {
  useAutomationAnchor,
  type AutomationThreadSource,
} from "./use-automation-thread.js";
import "./automations-view.css";
import "./automations-list.css";

const GROUP_OPTIONS: ReadonlyArray<{
  readonly value: AutomationsGroupBy;
  readonly label: string;
}> = [
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
];

const SUCCESS_ANNOUNCEMENTS: Readonly<Record<AutomationRowActionKind, string>> =
  {
    run: "Started a run of",
    pause: "Paused",
    enable: "Enabled",
  };

const countFormat = new Intl.NumberFormat();

/** The collection's load: nothing to count or call empty before the first. */
interface AutomationsLoad {
  readonly loaded: boolean;
  readonly error: string | undefined;
  readonly retry: () => void;
}

/** What every row on either list needs from the page. */
interface AutomationRowsState {
  readonly now: number;
  readonly statuses: ReadonlyMap<string, AutomationRowStatus>;
  readonly onAction: (
    row: AutomationListRow,
    action: AutomationRowActionKind,
  ) => void;
}

function AutomationsViewOptions({
  groupBy,
}: {
  readonly groupBy: AutomationsGroupBy;
}): React.JSX.Element {
  // A sheet on touch, like the sidebar's and the archive's View options.
  const sheet = useTouchDensity();
  return (
    <DropdownMenu presentation={sheet ? "sheet" : "menu"}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="automations-view-options"
          data-testid="automations-view-options"
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
        <DropdownMenuLabel>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Group by"
          value={groupBy}
          onValueChange={(value) =>
            setAutomationsGroupBy(value as AutomationsGroupBy)
          }
        >
          {GROUP_OPTIONS.map(({ value, label }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The page title, with the count once the collection has loaded. */
function AutomationsHeading({
  count,
}: {
  readonly count: number | undefined;
}): React.JSX.Element {
  return (
    <div className="automations-heading">
      <h1 id="automations-title">Automations</h1>
      {count !== undefined && (
        <span className="automations-count" data-testid="automations-count">
          {countFormat.format(count)}
          <span className="sr-only"> automations</span>
        </span>
      )}
    </div>
  );
}

/** A failed load, or skeleton rows until the first load arrives. */
function AutomationsLoadStatus({
  load,
}: {
  readonly load: AutomationsLoad;
}): React.JSX.Element | null {
  if (load.error) {
    return (
      <Callout
        tone="danger"
        action={
          <Button variant="outline" size="sm" onClick={load.retry}>
            Retry
          </Button>
        }
      >
        {load.error}
      </Callout>
    );
  }
  if (load.loaded) return null;
  return (
    <div className="automations-loading" role="status" aria-label="Loading automations">
      <Skeleton className="automations-skeleton-row" />
      <Skeleton className="automations-skeleton-row" />
      <Skeleton className="automations-skeleton-row" />
    </div>
  );
}

/**
 * Every automation across threads (`/automations`), or one thread's
 * (`/threads/:id/automations`). It subscribes only to the
 * automation-relevant part of the application store, so unrelated events do
 * not re-render it, and `thread_upsert` events update it live.
 */
export const AutomationsView = memo(function AutomationsView({
  store, threadRegistry, threadId,
}: {
  store: ApplicationClientStore;
  /** Where a thread's list reads a thread the application store lacks. */
  threadRegistry: AutomationThreadSource;
  threadId?: string;
}): React.JSX.Element {
  const snapshot = useApplicationStoreSelector(store, (state) => state.snapshot);
  // Undefined until the first load.
  const [definitions, setDefinitions] = useState<readonly ThreadAutomationDefinition[]>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => store.subscribeAutomationChanges((change) => {
    if (!change || !threadId || change.threadId === threadId) setAttempt((value) => value + 1);
  }), [store, threadId]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void (async () => {
      const items: ThreadAutomationDefinition[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.api.listAutomations({ threadId, cursor, limit: 100, signal: controller.signal });
        items.push(...page.items); cursor = page.nextCursor ?? undefined;
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setDefinitions(items);
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setLoadError(messageFrom(reason));
    });
    return () => controller.abort();
  }, [store, threadId, attempt]);
  useEffect(() => store.subscribeThreadSummaryChanges((sourceId) => {
    if (sourceId === undefined || (threadId ? sourceId === threadId : definitions?.some((definition) => definition.threadId === sourceId))) setAttempt((value) => value + 1);
  }), [store, threadId, definitions]);
  const base = useMemo(() => selectAutomationsBase(snapshot, definitions ?? []), [snapshot, definitions]);
  // A thread's list is under the thread: Escape (and Android Back without
  // history) goes up to it, as its "‹" link does.
  useAutomationUp(threadId ? () => navigateUp(threadPath(threadId)) : undefined);
  const now = useMinuteClock();
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const [statuses, setStatuses] = useState<
    ReadonlyMap<string, AutomationRowStatus>
  >(() => new Map());
  const runMutations = useRef(new Map<string, string>());
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  // Keyed so a repeated message still replaces the live region's content
  // and is announced again.
  const [announcement, setAnnouncement] = useState<{
    readonly key: number;
    readonly text: string;
  }>({ key: 0, text: "" });

  // Run now, Pause and Enable from a row's menu. A row takes one action at a
  // time; its answer settles only the status it started, so a row that left
  // the list meanwhile (its status dropped) stays clean.
  const runAction = useCallback(
    (row: AutomationListRow, action: AutomationRowActionKind) => {
      if (statusesRef.current.get(row.id)?.kind === "pending") return;
      const pending: AutomationRowStatus = { kind: "pending", action };
      const settle = (next: AutomationRowStatus | undefined) =>
        setStatuses((current) => {
          if (current.get(row.id) !== pending) return current;
          const updated = new Map(current);
          if (next) updated.set(row.id, next);
          else updated.delete(row.id);
          return updated;
        });
      setStatuses((current) => new Map(current).set(row.id, pending));
      if (action === "run" && !runMutations.current.has(row.id)) runMutations.current.set(row.id, mutationId());
      const request =
        action === "run"
          ? store.api.runAutomationNow(row.id, runMutations.current.get(row.id)!)
          : store.api.setAutomationState(
              row.id,
              action,
              row.automation.revision,
              mutationId(),
            );
      request.then(
        () => {
          if (action === "run") runMutations.current.delete(row.id);
          settle(undefined);
          setAnnouncement((current) => ({
            key: current.key + 1,
            text: `${SUCCESS_ANNOUNCEMENTS[action]} ${row.displayTitle}`,
          }));
        },
        (error: unknown) =>
          settle({ kind: "error", action, message: messageFrom(error) }),
      );
    },
    [store],
  );

  // Forget the statuses of automations that no longer exist.
  const listed = useMemo(
    () => new Set(base.rows.map(({ id }) => id)),
    [base.rows],
  );
  useEffect(() => {
    if ([...statuses.keys()].every((id) => listed.has(id))) return;
    setStatuses(
      (current) => new Map([...current].filter(([id]) => listed.has(id))),
    );
  }, [listed, statuses]);

  const load: AutomationsLoad = {
    loaded: definitions !== undefined,
    error: loadError,
    retry,
  };
  const rows: AutomationRowsState = { now, statuses, onAction: runAction };
  return (
    <section className="automations-view" aria-labelledby="automations-title">
      <div className="automations-page">
        {threadId ? (
          <ThreadAutomations
            store={store}
            threadRegistry={threadRegistry}
            threadId={threadId}
            base={base}
            load={load}
            rows={rows}
          />
        ) : (
          <AllAutomations base={base} load={load} rows={rows} />
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        <span key={announcement.key}>{announcement.text}</span>
      </div>
    </section>
  );
});

/**
 * Every automation (`/automations`). The list honors the sidebar's Scope
 * (shared with the sidebar) and its own search over titles and prompt
 * previews; collapsible groups are its filter.
 */
function AllAutomations({
  base,
  load,
  rows,
}: {
  readonly base: AutomationsBase;
  readonly load: AutomationsLoad;
  readonly rows: AutomationRowsState;
}): React.JSX.Element {
  // Page-local: the search also matches prompt previews, which the
  // sidebar's search does not, so the two are kept apart.
  const [search, setSearch] = useState("");
  // The input stays immediate; the list follows without blocking typing.
  const deferredSearch = useDeferredValue(search);
  const {
    scope,
    active: scopeActive,
    summary: scopeSummary,
    clearScope,
  } = useSidebarInventoryScope(base.catalog);
  const preferences = useAutomationsViewPreferences();
  const { groupBy } = preferences;
  const { now } = rows;
  const projection = useMemo(
    () =>
      projectAutomations(base, {
        scope,
        search: deferredSearch,
        groupBy,
        now,
      }),
    [base, deferredSearch, groupBy, now, scope],
  );
  const searchRef = useRef<HTMLInputElement>(null);

  const searching = deferredSearch.trim().length > 0;
  const filtered = searching || scopeActive;
  // Rows name their project unless the grouping or the Scope already does.
  const context =
    groupBy !== "project" && scope.projectId === null ? "all" : "project";
  const clearSearch = () => {
    setSearch("");
    searchRef.current?.focus();
  };
  // The control that cleared the scope disappears with it; keep focus nearby.
  const clearScopeAndFocus = () => {
    clearScope();
    searchRef.current?.focus();
  };
  const groupIds = useId();

  let empty: React.ReactNode = null;
  if (projection.total === 0) {
    empty = (
      <EmptyState
        icon={<Repeat />}
        title="No automations yet"
        description="Choose Automations… from a thread’s menu, then add a named schedule."
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
          icon={<Repeat />}
          title={`No automations in ${scopeSummary.fullLabel}`}
          action={scopeAction}
        />
      ) : (
        <EmptyState
          icon={<Search />}
          title="No matching automations"
          description={`Nothing matches “${deferredSearch.trim()}”${scopeActive ? ` in ${scopeSummary.fullLabel}` : ""}.`}
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
    <>
      <header className="automations-header">
        <AutomationsHeading count={load.loaded ? projection.total : undefined} />
        <div className="automations-tools">
          <label className="search-box automations-search">
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">Search automations</span>
            <Input
              ref={searchRef}
              type="search"
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder="Search automations"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <AutomationsViewOptions groupBy={groupBy} />
        </div>
        <p className="automations-status" data-testid="automations-status">
          {filtered && (
            <span>
              {countFormat.format(projection.matchCount)} of{" "}
              {countFormat.format(projection.total)}
            </span>
          )}
          {scopeActive ? (
            <span title={scopeSummary.fullLabel}>
              Scope: {scopeSummary.visibleLabel}
            </span>
          ) : (
            <span>All projects</span>
          )}
          {searching && <span>matching “{deferredSearch.trim()}”</span>}
          <span>
            {groupBy === "status" ? "Grouped by status" : "Grouped by project"}
          </span>
          {scopeActive && (
            <span>
              <button
                type="button"
                className="automations-status-action"
                onClick={clearScopeAndFocus}
              >
                Clear scope
              </button>
            </span>
          )}
        </p>
      </header>
      <div className="automations-groups">
        <AutomationsLoadStatus load={load} />
        {load.loaded && empty}
        {projection.groups.map((group, position) => {
          const headingId = `${groupIds}-group-${position}`;
          const collapsed = automationGroupCollapsed(preferences, group.key);
          return (
            <section
              key={group.key}
              className="automations-group"
              data-testid="automations-group"
              data-group={group.key}
              aria-labelledby={headingId}
            >
              <h2 className="automations-group-heading">
                <button
                  type="button"
                  id={headingId}
                  className="automations-group-toggle"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setAutomationGroupCollapsed(group.key, !collapsed)
                  }
                >
                  <ChevronRight
                    className="automations-group-chevron"
                    aria-hidden="true"
                  />
                  <span className="automations-group-label">
                    {group.label}
                  </span>{" "}
                  <span className="automations-group-count">
                    · {countFormat.format(group.entries.length)}
                  </span>
                </button>
              </h2>
              {!collapsed && (
                <ul className="automations-list" aria-labelledby={headingId}>
                  {group.entries.map((entry) => (
                    <AutomationRow
                      key={entry.row.id}
                      entry={entry}
                      now={now}
                      context={context}
                      status={rows.statuses.get(entry.row.id)}
                      onAction={rows.onAction}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

/**
 * One thread's automations (`/threads/:id/automations`), a page under its
 * thread: the "‹" link names the thread and goes up to it. The list is
 * flat, in status order, without the global page's Scope, search or groups,
 * and its rows leave out what the thread already says.
 */
function ThreadAutomations({
  store,
  threadRegistry,
  threadId,
  base,
  load,
  rows,
}: {
  readonly store: ApplicationClientStore;
  readonly threadRegistry: AutomationThreadSource;
  readonly threadId: string;
  readonly base: AutomationsBase;
  readonly load: AutomationsLoad;
  readonly rows: AutomationRowsState;
}): React.JSX.Element {
  const { now } = rows;
  const entries = useMemo(() => listThreadAutomations(base, now), [base, now]);
  // The live summary; the automations' copy while a thread the application
  // store lacks (an archived one) loads.
  const anchor = useAutomationAnchor(store, threadRegistry, threadId);
  const thread = anchor.status === "ready" ? anchor.thread : undefined;
  const title = thread?.title ?? base.rows[0]?.sourceTitle ?? "Thread";
  return (
    <>
      <header className="automations-header" data-scope="thread">
        <SettingsBackLink href={threadPath(threadId)} label={title} />
        <AutomationsHeading count={load.loaded ? entries.length : undefined} />
        {/* With none yet, the empty state carries the action. */}
        {entries.length > 0 && (
          <AddAutomation threadId={threadId} variant="outline" />
        )}
      </header>
      <div className="automations-groups">
        <AutomationsLoadStatus load={load} />
        {load.loaded && entries.length === 0 && (
          <EmptyState
            icon={<Repeat />}
            title="No automations on this thread"
            description="Send this thread a prompt on a schedule."
            action={
              <AddAutomation threadId={threadId} variant="default" />
            }
          />
        )}
        {entries.length > 0 && (
          <ul className="automations-list" aria-labelledby="automations-title">
            {entries.map((entry) => (
              <AutomationRow
                key={entry.row.id}
                entry={entry}
                now={now}
                context="thread"
                status={rows.statuses.get(entry.row.id)}
                onAction={rows.onAction}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Opens the editor for a new automation on the thread. */
function AddAutomation({
  threadId,
  variant,
}: {
  readonly threadId: string;
  readonly variant: "default" | "outline";
}): React.JSX.Element {
  return (
    <Button
      variant={variant}
      className="automations-add"
      onClick={() => navigate(automationCreatePath(threadId))}
    >
      <Plus data-icon="inline-start" aria-hidden="true" />
      Add automation
    </Button>
  );
}
