import "./automations-view.css";
import "./automation-page.css";
import {
  Ellipsis,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Repeat,
  Trash2,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  automationEditPath,
  automationsPath,
  navigate,
  navigateBack,
  navigateUp,
  threadPath,
} from "../../app/router.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { useMinuteClock } from "../../app/use-minute-clock.js";
import {
  automationHealth,
  type AutomationHealth,
  type SummaryAutomation,
} from "../../automation/automation-health.js";
import {
  automationErrorText,
  dayTimeLabel,
  dayTimePhrase,
  describeSchedule,
  lastRunAge,
  runTurnRunning,
  threadLiveState,
} from "../../automation/automation-text.js";
import {
  automationActionAvailability,
  uncertainRunResolution,
  type UncertainRunResolution,
} from "../../automation/automation-actions.js";
import { mutationId } from "../../lib/ids.js";
import { futureTimeLabel, shortRelativeTime } from "../../lib/time.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type { ThreadAutomationDefinition } from "../../types.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { isPlainClick } from "../settings/SettingsNav.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuValue,
} from "@client/components/ui/dropdown-menu";
import { EmptyState } from "@client/components/ui/empty-state";
import { KeyValueList, type KeyValueItem } from "@client/components/ui/key-value-list";
import { Skeleton } from "@client/components/ui/skeleton";
import { StatusPill } from "@client/components/ui/status-pill";
import { AutomationRunsSection, type AutomationRunsView } from "./AutomationRuns.js";
import { MarkRunFailedDialog } from "./MarkRunFailedDialog.js";
import {
  useAutomationCapability,
  useAutomationDefinition,
} from "./use-automation-details.js";
import { useAutomationRuns } from "./use-automation-runs.js";
import { useNextOccurrences } from "./use-next-occurrences.js";
import {
  automationLiveKey,
  useAutomationAnchor,
  useThreadRunState,
  type AutomationThread,
  type AutomationThreadSource,
} from "./use-automation-thread.js";
import {
  AutomationAnchorLoading,
  AutomationAnchorUnavailable,
} from "./AutomationAnchorStates.js";

const PHONE_QUERY = "(max-width: 819px)";

type PageStore = Pick<
  ApplicationClientStore,
  "api" | "subscribe" | "getSnapshot" | "mutateInventory"
>;

type PageAction = "run" | "state" | "restore" | "wake";

/** One automation, read-only, with its runs (`/automations/:threadId`). */
export function AutomationPage({
  store,
  threadRegistry,
  threadId,
}: {
  store: PageStore;
  /** Loads a thread the application store does not hold, as its route would. */
  threadRegistry: AutomationThreadSource;
  threadId: string;
}): React.JSX.Element {
  const anchor = useAutomationAnchor(store, threadRegistry, threadId);
  const thread = anchor.status === "ready" ? anchor.thread : undefined;
  const minute = useMinuteClock();
  const now = useMemo(() => new Date(minute), [minute]);
  const back = (
    <SettingsBackLink
      href={automationsPath()}
      label="Automations"
      onNavigate={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigateBack(automationsPath());
      }}
    />
  );

  let content: React.ReactNode;
  if (anchor.status === "loading") {
    content = <AutomationAnchorLoading back={back} />;
  } else if (anchor.status === "unavailable") {
    content = (
      <AutomationAnchorUnavailable back={back} message={anchor.message} onRetry={anchor.retry} />
    );
  } else {
    // Keyed by thread: another thread's page starts from its own
    // definition, runs, capability and view state, never from this one's.
    content = (
      <LoadedAutomation
        key={anchor.thread.id}
        store={store}
        thread={anchor.thread}
        back={back}
        now={now}
      />
    );
  }
  return (
    <section
      className="automations-view"
      aria-label={thread ? `${thread.title} automation` : "Automation"}
    >
      <div className="automations-page automation-page">{content}</div>
    </section>
  );
}

function LoadedAutomation({
  store,
  thread,
  back,
  now,
}: {
  readonly store: PageStore;
  readonly thread: AutomationThread;
  readonly back: React.ReactNode;
  readonly now: Date;
}): React.JSX.Element {
  const capabilityState = useAutomationCapability(store, thread.id, thread);
  const capability = capabilityState.capability;
  const automation = thread.automation;
  const definitionState = useAutomationDefinition(
    store,
    thread.id,
    automationLiveKey(automation),
  );

  if (!automation || definitionState.status === "missing") {
    const canAttach = capability?.available === true && capability.canAttach;
    return (
      <>
        <SettingsDetailHeader back={back} headingLevel={1} title={thread.title} />
        <EmptyState
          icon={<Repeat />}
          title="No automation"
          description={
            canAttach || capability === undefined
              ? "An automation sends this thread a prompt on a schedule."
              : (capability.unavailableReason?.text ??
                "This thread can't take an automation right now.")
          }
          action={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(threadPath(thread.id))}
              >
                Open thread
              </Button>
              {canAttach ? (
                <Button type="button" onClick={() => navigate(automationEditPath(thread.id))}>
                  Automate…
                </Button>
              ) : null}
            </>
          }
        />
      </>
    );
  }
  return (
    <AutomationDetails
      store={store}
      thread={thread}
      automation={automation}
      definition={definitionState.definition}
      definitionStatus={definitionState.status}
      definitionError={definitionState.error}
      onRetryDefinition={definitionState.retry}
      onDefinition={definitionState.replace}
      available={capability?.available}
      unavailableReason={capability?.unavailableReason?.text}
      back={back}
      now={now}
    />
  );
}

/**
 * The meta line's lead: "next Tmrw 2:00 AM", or what keeps the schedule
 * from running (the chip beside the title already names the state).
 */
function headerState(
  automation: SummaryAutomation,
  health: AutomationHealth,
  thread: AutomationThread,
  now: Date,
): string {
  switch (health.kind) {
    case "unknown":
    case "paused":
    case "not_started":
      return "scheduling paused";
    case "archived":
      return "runs suspended";
    case "snoozed":
      return thread.snoozedUntil
        ? `snoozed until ${futureTimeLabel(thread.snoozedUntil, now)}`
        : "snoozed";
    case "active":
    case "failed":
    case "sending":
      if (automation.status === "paused") return "scheduling paused";
      return automation.nextRunAt
        ? `next ${futureTimeLabel(automation.nextRunAt, now)}`
        : "no next run";
  }
}

/** A header action's tooltip: its name, or why it is off. */
function ActionTooltip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}): React.JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="lineage-tooltip"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
        >
          {label}
          <Tooltip.Arrow className="lineage-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function AutomationDetails({
  store,
  thread,
  automation,
  definition,
  definitionStatus,
  definitionError,
  onRetryDefinition,
  onDefinition,
  available,
  unavailableReason,
  back,
  now,
}: {
  readonly store: PageStore;
  readonly thread: AutomationThread;
  readonly automation: SummaryAutomation;
  readonly definition?: ThreadAutomationDefinition;
  readonly definitionStatus: "idle" | "loading" | "ready" | "error" | "missing";
  readonly definitionError?: string;
  readonly onRetryDefinition: () => void;
  readonly onDefinition: (definition: ThreadAutomationDefinition | null) => void;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly back: React.ReactNode;
  readonly now: Date;
}): React.JSX.Element {
  const phone = useMediaQuery(PHONE_QUERY);
  const health = automationHealth({ ...thread, automation }, now);
  const [runsView, setRunsView] = useState<AutomationRunsView>({
    expanded: false,
    filter: "all",
  });
  const runs = useAutomationRuns(
    store,
    thread,
    runsView.expanded ? runsView.filter : "all",
  );
  const [busy, setBusy] = useState<PageAction>();
  const [actionError, setActionError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [markFailedOpen, setMarkFailedOpen] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const revision = definition?.revision ?? automation.revision;
  const paused = automation.status === "paused";
  // The Automations list's row menu offers the same actions with the same reasons.
  const actions = automationActionAvailability(
    { inventoryState: thread.inventoryState, automation },
    health,
    available === undefined ? undefined : { available, unavailableReason },
  );
  const lastRun = automation.lastRun;
  // The latest run's result thread: this thread, or a fork run's own thread.
  const resultThreadId = lastRun?.resultThreadId ?? thread.id;
  const forkRunState = useThreadRunState(
    store,
    resultThreadId === thread.id ? undefined : resultThreadId,
  );
  const runningRunId =
    lastRun &&
    runTurnRunning(lastRun, resultThreadId === thread.id ? thread.runState : forkRunState)
      ? lastRun.id
      : undefined;
  const liveState = threadLiveState(thread.runState);
  const lastRunDetail = lastRun
    ? runs.items.find(({ id }) => id === lastRun.id)
    : undefined;
  const lastRunProblem =
    lastRunDetail?.diagnostic ??
    (lastRun?.errorCode ? automationErrorText(lastRun.errorCode) : undefined);

  const act = async (action: PageAction, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setActionError(undefined);
    try {
      await work();
    } catch (reason) {
      setActionError(messageFrom(reason));
    } finally {
      setBusy(undefined);
    }
  };
  const runNow = () =>
    void act("run", async () => {
      runs.upsert(await store.api.runThreadAutomationNow(thread.id, mutationId()));
    });
  const setState = (action: "enable" | "pause") =>
    void act("state", async () => {
      onDefinition(
        await store.api.setThreadAutomationState(thread.id, action, revision, mutationId()),
      );
    });
  const inventory = (action: "restore" | "wake") =>
    void act(action, async () => {
      await store.mutateInventory(thread, action);
    });
  const openThread = (id = thread.id) => navigate(threadPath(id));
  const toggleState = () => setState(paused ? "enable" : "pause");
  const edit = () => navigate(automationEditPath(thread.id));

  const runNowButton = (
    <ActionTooltip label={actions.runNow.reason ?? "Send the prompt now"}>
      <Button
        type="button"
        variant="outline"
        aria-disabled={!actions.runNow.available || busy ? true : undefined}
        onClick={() => {
          if (actions.runNow.available && !busy) runNow();
        }}
      >
        <Play data-icon="inline-start" aria-hidden="true" />
        {busy === "run" ? "Starting…" : "Run now"}
      </Button>
    </ActionTooltip>
  );
  const stateLabel = paused ? "Enable" : "Pause";
  const header = (
    <SettingsDetailHeader
      back={back}
      headingLevel={1}
      icon={<Repeat />}
      title={thread.title}
      status={<StatusPill tone={health.tone}>{health.label}</StatusPill>}
      description={
        <span className="automation-page-meta">
          {liveState ? <span data-tone={liveState.tone}>{liveState.label}</span> : null}
          <span>{headerState(automation, health, thread, now)}</span>
          {thread.projectLabel ? <span>{thread.projectLabel}</span> : null}
          <span>{thread.backendLabel}</span>
        </span>
      }
      actions={
        <Tooltip.Provider delayDuration={300}>
          {runNowButton}
          {phone ? null : (
            <>
              <ActionTooltip label={actions.toggle.reason ?? stateLabel}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${stateLabel} automation`}
                  aria-disabled={!actions.toggle.available || busy ? true : undefined}
                  onClick={() => {
                    if (actions.toggle.available && !busy) toggleState();
                  }}
                >
                  {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                </Button>
              </ActionTooltip>
              <ActionTooltip label={actions.edit.reason ?? "Edit"}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Edit automation"
                  aria-disabled={actions.edit.available ? undefined : true}
                  onClick={() => {
                    if (actions.edit.available) edit();
                  }}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              </ActionTooltip>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={moreTrigger}
                type="button"
                variant="ghost"
                size="icon"
                aria-label="More automation actions"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {phone ? (
                <>
                  <DropdownMenuItem
                    disabled={!actions.toggle.available || busy !== undefined}
                    title={actions.toggle.reason}
                    onSelect={toggleState}
                  >
                    {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                    {stateLabel}
                    {actions.toggle.hint ? (
                      <DropdownMenuValue aria-hidden="true">{actions.toggle.hint}</DropdownMenuValue>
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!actions.edit.available}
                    title={actions.edit.reason}
                    onSelect={edit}
                  >
                    <Pencil aria-hidden="true" />
                    Edit
                    {actions.edit.hint ? (
                      <DropdownMenuValue aria-hidden="true">{actions.edit.hint}</DropdownMenuValue>
                    ) : null}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => openThread()}>
                <MessageSquare aria-hidden="true" />
                Open thread
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!actions.remove.available}
                title={actions.remove.reason}
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 aria-hidden="true" />
                Delete automation…
                {actions.remove.hint ? (
                  <DropdownMenuValue aria-hidden="true">{actions.remove.hint}</DropdownMenuValue>
                ) : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Tooltip.Provider>
      }
    />
  );

  return (
    <>
      {header}
      {actionError ? (
        <Callout tone="danger" role="alert">
          {actionError}
        </Callout>
      ) : null}
      <HealthCallout
        health={health}
        thread={thread}
        automation={automation}
        problem={lastRunProblem}
        busy={busy}
        now={now}
        onOpenThread={() => openThread(lastRun?.resultThreadId ?? thread.id)}
        onMarkFailed={() => setMarkFailedOpen(true)}
        onEnable={() => setState("enable")}
        onRestore={() => inventory("restore")}
        onWake={() => inventory("wake")}
      />
      <SettingsSection title="Definition" card>
        {definition ? (
          <DefinitionFacts
            store={store}
            threadId={thread.id}
            definition={definition}
            nextRunAt={automation.nextRunAt}
            skippedUntil={
              thread.inventoryState === "snoozed" &&
              thread.snoozedUntil !== undefined &&
              Date.parse(thread.snoozedUntil) > now.getTime()
                ? thread.snoozedUntil
                : undefined
            }
            now={now}
          />
        ) : definitionStatus === "error" ? (
          <Callout
            tone="danger"
            title="The automation could not be loaded"
            action={
              <Button type="button" variant="outline" size="sm" onClick={onRetryDefinition}>
                Retry
              </Button>
            }
          >
            {definitionError}
          </Callout>
        ) : (
          <div className="automation-facts-loading" role="status" aria-label="Loading definition">
            <Skeleton className="automation-runs-skeleton" />
            <Skeleton className="automation-runs-skeleton" />
          </div>
        )}
      </SettingsSection>
      <AutomationRunsSection
        store={store}
        runs={runs}
        runningRunId={runningRunId}
        view={runsView}
        onViewChange={setRunsView}
        nextRunAt={health.kind === "active" ? automation.nextRunAt : undefined}
        canRunNow={actions.runNow.available}
        revision={revision}
        now={now}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        tone="danger"
        title="Delete this automation?"
        description="Scheduled and manual runs stop and the schedule is removed. The thread, its messages and any result threads stay. Run history is no longer shown."
        confirmLabel="Delete automation"
        pendingLabel="Deleting…"
        returnFocusRef={moreTrigger}
        onConfirm={async () => {
          try {
            await store.api.deleteThreadAutomation(thread.id, revision, mutationId());
          } catch (reason) {
            throw new Error(messageFrom(reason));
          }
          navigateUp(automationsPath());
        }}
      />
      {lastRun?.state === "uncertain" ? (
        <MarkRunFailedDialog
          open={markFailedOpen}
          onOpenChange={setMarkFailedOpen}
          runTime={dayTimePhrase(lastRun.scheduledFor, now)}
          resolution={uncertainRunResolution(automation, now) ?? "choose"}
          onResolve={async (resume) => {
            try {
              const resolution = await store.api.resolveThreadAutomationRun(
                thread.id,
                lastRun.id,
                { resume },
              );
              runs.upsert(resolution.run);
              onDefinition(resolution.automation);
            } catch (reason) {
              throw new Error(messageFrom(reason));
            }
          }}
        />
      ) : null}
    </>
  );
}

const RESOLUTION_HINTS: Readonly<Record<UncertainRunResolution, string>> = {
  ends: "Check the thread, then mark the run as failed to end this one-time automation.",
  choose: "Check the thread, then mark the run as failed to resume scheduling.",
  stays_paused: "Check the thread, then mark the run as failed.",
};

/** The one notice the automation's state calls for, with its way out. */
function HealthCallout({
  health,
  thread,
  automation,
  problem,
  busy,
  now,
  onOpenThread,
  onMarkFailed,
  onEnable,
  onRestore,
  onWake,
}: {
  readonly health: AutomationHealth;
  readonly thread: AutomationThread;
  readonly automation: SummaryAutomation;
  readonly problem?: string;
  readonly busy?: PageAction;
  readonly now: Date;
  readonly onOpenThread: () => void;
  readonly onMarkFailed: () => void;
  readonly onEnable: () => void;
  readonly onRestore: () => void;
  readonly onWake: () => void;
}): React.JSX.Element | null {
  const openThread = (
    <Button type="button" variant="outline" size="sm" onClick={onOpenThread}>
      Open thread
    </Button>
  );
  switch (health.kind) {
    case "failed":
      return (
        <Callout
          tone="danger"
          title={
            automation.lastRun
              ? `Last run failed ${lastRunAge(automation.lastRun, now.getTime())}`
              : "Last run failed"
          }
          action={openThread}
        >
          {problem}
        </Callout>
      );
    case "unknown":
      return (
        <Callout
          tone="warning"
          title="Sedes can't tell whether the last run reached the agent."
          action={
            <>
              {openThread}
              <Button type="button" variant="outline" size="sm" onClick={onMarkFailed}>
                Mark as failed…
              </Button>
            </>
          }
        >
          {problem ? `${problem} ` : null}
          {RESOLUTION_HINTS[uncertainRunResolution(automation, now) ?? "choose"]}
        </Callout>
      );
    case "not_started":
      return (
        <Callout
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== undefined}
              onClick={onEnable}
            >
              {busy === "state" ? "Enabling…" : "Enable"}
            </Button>
          }
        >
          Paused. This automation won't run until you enable it.
        </Callout>
      );
    case "archived":
      return (
        <Callout
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== undefined}
              onClick={onRestore}
            >
              {busy === "restore" ? "Restoring…" : "Restore thread"}
            </Button>
          }
        >
          Runs are suspended while the thread is archived.
        </Callout>
      );
    case "snoozed":
      return (
        <Callout
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== undefined}
              onClick={onWake}
            >
              {busy === "wake" ? "Unsnoozing…" : "Unsnooze"}
            </Button>
          }
        >
          {thread.snoozedUntil
            ? `Scheduled runs are skipped until ${futureTimeLabel(thread.snoozedUntil, now)}.`
            : "Scheduled runs are skipped while the thread is snoozed."}
        </Callout>
      );
    case "active":
    case "paused":
    case "sending":
      return null;
  }
}

function Sub({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <span className="automation-fact-sub">{children}</span>;
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DefinitionFacts({
  store,
  threadId,
  definition,
  nextRunAt,
  skippedUntil,
  now,
}: {
  readonly store: Pick<ApplicationClientStore, "api">;
  readonly threadId: string;
  readonly definition: ThreadAutomationDefinition;
  /** The live summary's next run, which moves on as scheduled runs fire. */
  readonly nextRunAt: string | undefined;
  /** A snooze's wake time: scheduled runs before it are skipped. */
  readonly skippedUntil: string | undefined;
  readonly now: Date;
}): React.JSX.Element {
  const recurring = definition.schedule.kind !== "date_time";
  const next = useNextOccurrences(
    store,
    threadId,
    definition.status === "enabled" && recurring ? definition.schedule : undefined,
    nextRunAt,
    now,
    skippedUntil,
  );
  const updated = shortRelativeTime(definition.updatedAt, now.getTime());
  const items: KeyValueItem[] = [
    { label: "Prompt", value: <PromptPreview prompt={definition.prompt} /> },
    {
      label: "Schedule",
      value: (
        <>
          {describeSchedule(definition.schedule, now)}
          {next.length > 0 ? (
            <Sub>
              {skippedUntil === undefined ? "Next: " : "Next after snooze: "}
              {next.map((occurrence) => dayTimeLabel(occurrence, now)).join(", ")}
            </Sub>
          ) : null}
          {recurring ? (
            <Sub>
              If Sedes was down:{" "}
              {definition.misfirePolicy === "coalesce" ? "run once" : "skip missed runs"}
            </Sub>
          ) : null}
        </>
      ),
    },
    {
      label: "Run in",
      value: definition.runMode === "clone" ? "A new fork each run" : "This thread",
    },
    {
      label: "Precheck",
      value: definition.precheck ? (
        <>
          <code className="automation-code">{definition.precheck.command}</code>
          <Sub>
            {definition.precheck.timeoutSeconds} s timeout ·{" "}
            {definition.precheck.includeStdout
              ? "output added to prompt"
              : "output not added to prompt"}
          </Sub>
        </>
      ) : (
        <span className="automation-fact-none">None</span>
      ),
    },
    {
      label: "Created",
      value:
        definition.updatedAt === definition.createdAt
          ? absoluteTime(definition.createdAt)
          : `${absoluteTime(definition.createdAt)} · updated ${updated === "now" ? "just now" : `${updated} ago`}`,
    },
  ];
  return <KeyValueList className="automation-facts" items={items} />;
}

/** The prompt clamped to four lines, with "Show all" when it runs longer. */
function PromptPreview({ prompt }: { readonly prompt: string }): React.JSX.Element {
  const text = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, prompt]);
  return (
    <>
      <span
        ref={text}
        className="automation-prompt-preview"
        data-expanded={expanded || undefined}
      >
        {prompt}
      </span>
      {overflows || expanded ? (
        <button
          type="button"
          className="automation-link automation-show-all"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </>
  );
}
