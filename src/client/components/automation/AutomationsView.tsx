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
import { ChevronRight, Repeat, Search, SlidersHorizontal } from "lucide-react";
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
import { useMinuteClock } from "../../app/use-minute-clock.js";
import { useSidebarInventoryScope } from "../../app/use-sidebar-inventory-scope.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import {
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
import { mutationId } from "../../lib/ids.js";
import {
  messageFrom,
  type ApplicationClientState,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";
import {
  AutomationRow,
  type AutomationRowActionKind,
  type AutomationRowStatus,
} from "./AutomationRow.js";
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

/** Only snapshot changes can change the list. */
function selectBase(
  state: ApplicationClientState,
  previous: AutomationsBase | undefined,
): AutomationsBase {
  return selectAutomationsBase(state.snapshot, previous);
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

/**
 * Every automation across threads (`/automations`). The list honors the
 * sidebar's Scope (shared with the sidebar) and its own search over titles and
 * prompt previews; collapsible groups are its filter. It subscribes only to
 * the automation-relevant part of the application store, so unrelated events
 * do not re-render it, and `thread_upsert` events update it live.
 */
export const AutomationsView = memo(function AutomationsView({
  store,
}: {
  store: ApplicationClientStore;
}): React.JSX.Element {
  const base = useApplicationStoreSelector(store, selectBase);
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
  const now = useMinuteClock();
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

  const [statuses, setStatuses] = useState<
    ReadonlyMap<string, AutomationRowStatus>
  >(() => new Map());
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  // Keyed so a repeated message still replaces the live region's content
  // and is announced again.
  const [announcement, setAnnouncement] = useState<{
    readonly key: number;
    readonly text: string;
  }>({ key: 0, text: "" });
  const searchRef = useRef<HTMLInputElement>(null);

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
      const request =
        action === "run"
          ? store.api.runThreadAutomationNow(row.id, mutationId())
          : store.api.setThreadAutomationState(
              row.id,
              action,
              row.automation.revision,
              mutationId(),
            );
      request.then(
        () => {
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

  const searching = deferredSearch.trim().length > 0;
  const filtered = searching || scopeActive;
  // Rows name their project unless the grouping or the Scope already does.
  const showProject = groupBy !== "project" && scope.projectId === null;
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
        description="Open a thread’s ⋯ menu and choose Automate… to send it a prompt on a schedule."
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
    <section className="automations-view" aria-labelledby="automations-title">
      <div className="automations-page">
        <header className="automations-header">
          <div className="automations-heading">
            <h1 id="automations-title">Automations</h1>
            <span className="automations-count" data-testid="automations-count">
              {countFormat.format(projection.total)}
              <span className="sr-only"> automations</span>
            </span>
          </div>
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
          {empty}
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
                        showProject={showProject}
                        status={statuses.get(entry.row.id)}
                        onAction={runAction}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        <span key={announcement.key}>{announcement.text}</span>
      </div>
    </section>
  );
});
