import { Check, ChevronRight, CircleDashed } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { AutomationRunFilter } from "../../../shared/protocol/domain.js";
import { threadPath } from "../../app/router.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import {
  automationErrorText,
  runMeta,
  runStateLabel,
} from "../../automation/automation-text.js";
import { futureTimeLabel } from "../../lib/time.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { followLink } from "../settings/SettingsNav.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { EmptyState } from "@client/components/ui/empty-state";
import { KeyValueList, type KeyValueItem } from "@client/components/ui/key-value-list";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { Skeleton } from "@client/components/ui/skeleton";
import { AutomationGlyph } from "./AutomationGlyph.js";
import {
  runAccessibleName,
  runDateTime,
  runDayTime,
  runDetailTitle,
  runHealth,
  runKind,
  runPrecheckSummary,
  runTimeline,
  type RunHealth,
} from "./automation-run-format.js";
import type { AutomationRuns } from "./use-automation-runs.js";
import { useThreadTitle } from "./use-automation-thread.js";

/** Runs the compact list shows before "Show all runs". */
const COMPACT_RUN_COUNT = 5;
const PHONE_QUERY = "(max-width: 819px)";

export interface AutomationRunsView {
  /** The full history in its bounded scroller, with the filter. */
  readonly expanded: boolean;
  readonly filter: AutomationRunFilter;
}

const FILTER_EMPTY: Readonly<Record<AutomationRunFilter, string>> = {
  all: "No runs yet.",
  problems: "No failed or unknown runs.",
  skipped: "No skipped runs.",
};

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * The automation page's run history: a compact list of the latest runs by
 * default, or the whole history in a bounded scroller with a filter and
 * cursor paging. A row opens its facts inline on desktop and in a bottom
 * sheet on phones. Runs that a live refresh brings in are announced.
 */
export function AutomationRunsSection({
  store,
  runs,
  view,
  onViewChange,
  nextRunAt,
  canRunNow,
  revision,
  now,
}: {
  readonly store: Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;
  readonly runs: AutomationRuns;
  readonly view: AutomationRunsView;
  readonly onViewChange: (view: AutomationRunsView) => void;
  /** The next run, for the empty history; only while the schedule will make it. */
  readonly nextRunAt?: string;
  /** Run now is available, so the empty history can suggest it. */
  readonly canRunNow: boolean;
  /** The definition's current revision, to say a run's has been edited since. */
  readonly revision?: number;
  readonly now: Date;
}): React.JSX.Element {
  const phone = useMediaQuery(PHONE_QUERY);
  const touch = useTouchDensity();
  const [openRunId, setOpenRunId] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const counts = runs.counts;

  useEffect(() => {
    const newest = runs.arrived[0];
    if (!newest) return;
    setAnnouncement(
      runs.arrived.length === 1
        ? `New run: ${runAccessibleName(newest, new Date())}`
        : `${runs.arrived.length} new runs. Latest: ${runAccessibleName(newest, new Date())}`,
    );
  }, [runs.arrived]);

  const items = view.expanded ? runs.items : runs.items.slice(0, COMPACT_RUN_COUNT);
  const openRun = runs.items.find(({ id }) => id === openRunId);
  const toggle = (run: ThreadAutomationRun) =>
    setOpenRunId((current) => (current === run.id && !phone ? undefined : run.id));

  const countsLine = counts ? (
    <>
      {plural(counts.all, "run", "runs")}
      {counts.problems > 0 ? (
        <>
          {" · "}
          <button
            type="button"
            className="automation-link"
            onClick={() => onViewChange({ expanded: true, filter: "problems" })}
          >
            {plural(counts.problems, "problem", "problems")}
          </button>
        </>
      ) : null}
    </>
  ) : undefined;

  const list = (
    <ul className="automation-run-list" aria-label="Runs, newest first">
      {items.map((run) => (
        <AutomationRunRow
          key={run.id}
          store={store}
          run={run}
          now={now}
          phone={phone}
          expanded={!phone && openRunId === run.id}
          revision={revision}
          onToggle={() => toggle(run)}
        />
      ))}
    </ul>
  );

  let body: React.ReactNode;
  if (runs.status === "loading" || runs.status === "idle") {
    body = (
      <div className="automation-runs-loading" role="status" aria-label="Loading runs">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="automation-runs-skeleton" />
        ))}
      </div>
    );
  } else if (runs.status === "error") {
    body = (
      <Callout
        tone="danger"
        title="The runs could not be loaded"
        action={
          <Button type="button" variant="outline" size="sm" onClick={runs.retry}>
            Retry
          </Button>
        }
      >
        {runs.error}
      </Callout>
    );
  } else if (runs.items.length === 0) {
    const filter = view.expanded ? view.filter : "all";
    body = (
      <EmptyState
        variant="inline"
        title={FILTER_EMPTY[filter]}
        description={
          filter !== "all"
            ? undefined
            : nextRunAt
              ? `The first run is ${futureTimeLabel(nextRunAt, now)}.`
              : canRunNow
                ? "Run now to try it."
                : undefined
        }
      />
    );
  } else if (view.expanded) {
    body = (
      <div
        className="automation-runs-scroll"
        role="region"
        aria-label="Run history"
        tabIndex={0}
      >
        {list}
        {runs.loadMoreError ? (
          <Callout tone="danger" role="alert">
            {runs.loadMoreError}
          </Callout>
        ) : null}
        {runs.hasMore ? (
          <div className="automation-runs-footer">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={runs.loadingMore}
              onClick={runs.loadMore}
            >
              {runs.loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  } else {
    body = list;
  }

  const showAll =
    !view.expanded &&
    runs.status === "ready" &&
    (runs.items.length > COMPACT_RUN_COUNT || runs.hasMore);

  return (
    <SettingsSection
      className="automation-runs"
      title="Runs"
      description={countsLine}
      actions={
        view.expanded ? (
          <SegmentedControl
            size={touch ? "default" : "sm"}
            aria-label="Show runs"
            value={view.filter}
            onValueChange={(filter) =>
              onViewChange({ expanded: true, filter: filter as AutomationRunFilter })
            }
          >
            <SegmentedControlItem value="all">All</SegmentedControlItem>
            <SegmentedControlItem value="problems">Problems</SegmentedControlItem>
            <SegmentedControlItem value="skipped">Skipped</SegmentedControlItem>
          </SegmentedControl>
        ) : undefined
      }
    >
      {body}
      {showAll || view.expanded ? (
        <div className="automation-runs-footer">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onViewChange(
                view.expanded
                  ? { expanded: false, filter: "all" }
                  : { expanded: true, filter: "all" },
              )
            }
          >
            {view.expanded ? "Show fewer" : "Show all runs"}
          </Button>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <Dialog
        open={phone && openRun !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenRunId(undefined);
        }}
      >
        {openRun ? (
          <DialogContent layout="sheet" size="md">
            <DialogHeader>
              <DialogTitle>{runDetailTitle(openRun)}</DialogTitle>
              <DialogDescription>
                {runDateTime(openRun.scheduledFor)} · {runKind(openRun)}
                {openRun.coalescedCount > 0
                  ? ` · missed ×${openRun.coalescedCount} merged`
                  : null}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <AutomationRunFacts store={store} run={openRun} revision={revision} />
            </DialogBody>
          </DialogContent>
        ) : null}
      </Dialog>
    </SettingsSection>
  );
}

function RunGlyph({ health }: { readonly health: RunHealth }): React.JSX.Element {
  switch (health) {
    case "sending":
      return <AutomationGlyph glyph="spinner" tone="info" />;
    case "failed":
      return <AutomationGlyph glyph="triangle" tone="danger" />;
    case "uncertain":
      return <AutomationGlyph glyph="triangle" tone="warning" />;
    case "skipped":
      return <CircleDashed className="automation-glyph" aria-hidden="true" />;
    case "delivered":
      return <Check className="automation-glyph" aria-hidden="true" />;
  }
}

function AutomationRunRow({
  store,
  run,
  now,
  phone,
  expanded,
  revision,
  onToggle,
}: {
  readonly store: Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;
  readonly run: ThreadAutomationRun;
  readonly now: Date;
  readonly phone: boolean;
  readonly expanded: boolean;
  readonly revision?: number;
  readonly onToggle: () => void;
}): React.JSX.Element {
  const detailId = useId();
  const health = runHealth(run);
  return (
    <li className="automation-run" data-expanded={expanded || undefined}>
      <button
        type="button"
        className="automation-run-main"
        aria-label={runAccessibleName(run, now)}
        {...(phone
          ? { "aria-haspopup": "dialog" as const }
          : { "aria-expanded": expanded, "aria-controls": detailId })}
        onClick={onToggle}
      >
        <span className="automation-run-glyph">
          <RunGlyph health={health} />
        </span>
        <span className="automation-run-time">{runDayTime(run.scheduledFor, now)}</span>
        <span className="automation-run-state" data-health={health}>
          {runStateLabel(run)}
        </span>
        <span className="automation-run-meta">{runMeta(run)}</span>
        <span className="automation-run-chevron">
          <ChevronRight aria-hidden="true" />
        </span>
      </button>
      {!phone ? (
        <div id={detailId} className="automation-run-detail" hidden={!expanded}>
          {expanded ? (
            <AutomationRunFacts store={store} run={run} revision={revision} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One run's facts: its timeline, precheck, problem, revision and result thread. */
function AutomationRunFacts({
  store,
  run,
  revision,
}: {
  readonly store: Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;
  readonly run: ThreadAutomationRun;
  readonly revision?: number;
}): React.JSX.Element {
  const clone = run.runMode === "clone" && run.resultThreadId !== undefined;
  const resultTitle = useThreadTitle(store, clone ? run.resultThreadId : undefined);
  const health = runHealth(run);
  const problem =
    run.diagnostic ?? (run.errorCode ? automationErrorText(run.errorCode) : undefined);
  const items: KeyValueItem[] = [
    {
      label: "Timeline",
      value: (
        <ol className="automation-timeline">
          {runTimeline(run).map((step) => (
            <li key={step.label}>
              {step.label} <span className="automation-timeline-time">{step.time}</span>
              {step.delta ? <small>{step.delta}</small> : null}
            </li>
          ))}
        </ol>
      ),
    },
  ];
  if (run.precheck) {
    items.push({
      label: "Precheck",
      value: (
        <>
          {runPrecheckSummary(run.precheck)}
          <code className="automation-code automation-fact-sub">{run.precheck.command}</code>
          <span className="automation-fact-sub">
            {run.precheck.timeoutSeconds} s timeout
          </span>
        </>
      ),
    });
  }
  if (problem) {
    items.push({
      label: health === "skipped" ? "Reason" : health === "delivered" ? "Note" : "Problem",
      value: problem,
    });
  }
  if (run.errorCode) items.push({ label: "Error code", value: run.errorCode, mono: true });
  items.push({
    label: "Definition",
    value:
      revision !== undefined && revision > run.definitionRevision
        ? `Revision ${run.definitionRevision} · edited since (now revision ${revision})`
        : `Revision ${run.definitionRevision}`,
  });
  if (clone && run.resultThreadId) {
    const path = threadPath(run.resultThreadId);
    items.push({
      label: "Result thread",
      value: (
        <a
          className="automation-link"
          href={path}
          onClick={(event) => followLink(event, path)}
        >
          {resultTitle ?? "Open result thread"}
        </a>
      ),
    });
  }
  return <KeyValueList className="automation-run-facts" items={items} />;
}
