import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AutomationSchedule } from "../../shared/protocol/automation";
import type {
  AutomationMisfirePolicy,
  AutomationRunMode,
} from "../../shared/protocol/domain";
import { localDateTimeValue } from "../lib/time";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore";
import { messageFrom } from "../stores/ApplicationClientStore";
import { ApiError } from "../api/ApiClient";
import type { ThreadAutomationSummary } from "../../shared/protocol/automation-presentation";
import type {
  AutomationPrecheckTestResult,
  ThreadAutomationDefinition,
  ThreadAutomationRun,
} from "../types";
import { mutationId } from "../lib/ids";
import { useMediaQuery } from "../app/use-media-query";
import { Ellipsis, Pause, Play, Power } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
  DIALOG_FOOTER_STACK_QUERY,
} from "@client/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { StatusPill } from "@client/components/ui/status-pill";
import { Tag } from "@client/components/ui/tag";
import { Textarea } from "@client/components/ui/textarea";
import {
  AutomationMisfireSection,
  AutomationScheduleSection,
  type IntervalUnit,
  type ScheduleKind,
} from "./automation/ScheduleSection";
import { AutomationRunModeSection } from "./automation/RunModeSection";
import { AutomationPrecheckSection } from "./automation/PrecheckSection";
import { AutomationRunHistory } from "./automation/RunHistory";
import { AutomationFieldError } from "./automation/AutomationFieldError";

const maximumPromptBytes = 65_536;
const maximumPrecheckCommandBytes = 4_096;
type AutomationDialogSummary = Pick<
  ThreadAutomationSummary,
  "revision" | "lastRun"
>;

export function ThreadAutomationDialog({
  store,
  threadId,
  threadTitle,
  automationSummary,
  snoozed,
  canCloneOnRun,
  onClose,
}: {
  store: ApplicationClientStore;
  threadId: string;
  threadTitle: string;
  automationSummary: AutomationDialogSummary | null;
  snoozed: boolean;
  canCloneOnRun: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const automationSummaryRevision = automationSummary?.revision;
  const [definition, setDefinition] = useState<ThreadAutomationDefinition>();
  // Where the footer would stack (phones), Run now and Enable/Pause move to
  // a header menu, so the footer is Cancel and Save.
  const stackedFooter = useMediaQuery(DIALOG_FOOTER_STACK_QUERY);
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const [history, setHistory] = useState<ThreadAutomationRun[]>([]);
  const [loading, setLoading] = useState(automationSummary !== null);
  // The action in flight: every action locks the others, and only the
  // pending one shows its progress label.
  const [busy, setBusy] = useState<
    "save" | "state" | "run" | "resolve" | "delete"
  >();
  const saving = busy !== undefined;
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const promptHelpId = useId();
  const promptErrorId = useId();
  const [prompt, setPrompt] = useState("");
  const [runMode, setRunMode] = useState<AutomationRunMode>("same_thread");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("date_time");
  const [dateTime, setDateTime] = useState(() =>
    localDateTimeValue(new Date(Date.now() + 60 * 60_000)),
  );
  const [intervalAmount, setIntervalAmount] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hours");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [misfirePolicy, setMisfirePolicy] =
    useState<AutomationMisfirePolicy>("coalesce");
  const [precheckEnabled, setPrecheckEnabled] = useState(false);
  const [precheckCommand, setPrecheckCommand] = useState("");
  const [precheckTimeout, setPrecheckTimeout] = useState(30);
  const [precheckIncludeStdout, setPrecheckIncludeStdout] =
    useState(false);
  const [precheckTesting, setPrecheckTesting] = useState(false);
  const [precheckResult, setPrecheckResult] =
    useState<AutomationPrecheckTestResult>();
  const [preview, setPreview] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState("");
  const [previewedScheduleKey, setPreviewedScheduleKey] = useState("");
  const precheckTestController = useRef<AbortController | undefined>(
    undefined,
  );
  const loadedExistingAutomation = useRef(false);
  const handledLoadAttempt = useRef(0);
  const observedAttachedAutomation = useRef(automationSummary !== null);
  const precheckInputFingerprint = JSON.stringify({
    prompt,
    enabled: precheckEnabled,
    command: precheckCommand,
    timeoutSeconds: precheckTimeout,
    includeStdout: precheckIncludeStdout,
  });
  const precheckInputFingerprintRef = useRef(precheckInputFingerprint);
  precheckInputFingerprintRef.current = precheckInputFingerprint;

  useEffect(() => {
    const controller = precheckTestController.current;
    if (controller) {
      controller.abort();
      precheckTestController.current = undefined;
      setPrecheckTesting(false);
    }
    setPrecheckResult(undefined);
  }, [precheckInputFingerprint]);

  useEffect(
    () => () => {
      precheckTestController.current?.abort();
      precheckTestController.current = undefined;
    },
    [],
  );

  const adoptDefinition = useCallback(
    (loaded: ThreadAutomationDefinition) => {
      setDefinition(loaded);
      setPrompt(loaded.prompt);
      setRunMode(loaded.runMode);
      setMisfirePolicy(loaded.misfirePolicy);
      setPrecheckEnabled(Boolean(loaded.precheck));
      setPrecheckCommand(loaded.precheck?.command ?? "");
      setPrecheckTimeout(loaded.precheck?.timeoutSeconds ?? 30);
      setPrecheckIncludeStdout(loaded.precheck?.includeStdout ?? false);
      setPrecheckResult(undefined);
      setScheduleKind(loaded.schedule.kind);
      if (loaded.schedule.kind === "date_time") {
        setDateTime(localDateTimeValue(new Date(loaded.schedule.runAt)));
      } else if (loaded.schedule.kind === "interval") {
        const seconds = loaded.schedule.everySeconds;
        if (seconds % 86_400 === 0) {
          setIntervalUnit("days");
          setIntervalAmount(seconds / 86_400);
        } else if (seconds % 3_600 === 0) {
          setIntervalUnit("hours");
          setIntervalAmount(seconds / 3_600);
        } else {
          setIntervalUnit("minutes");
          setIntervalAmount(seconds / 60);
        }
      } else {
        setCronExpression(loaded.schedule.expression);
      }
    },
    [],
  );

  useEffect(() => {
    if (automationSummaryRevision !== undefined) {
      observedAttachedAutomation.current = true;
    } else if (observedAttachedAutomation.current) {
      onClose();
    }
  }, [automationSummaryRevision, onClose]);

  useEffect(() => {
    const currentDefinition = definitionRef.current;
    const explicitReload = loadAttempt > handledLoadAttempt.current;
    handledLoadAttempt.current = loadAttempt;
    const shouldLoad =
      explicitReload ||
      (!loadedExistingAutomation.current &&
        automationSummaryRevision !== undefined &&
        currentDefinition === undefined);
    if (!shouldLoad) {
      if (currentDefinition !== undefined) {
        setLoading(false);
        return;
      }
      if (automationSummaryRevision === undefined) {
        setLoading(false);
        setLoadError("");
      }
      return;
    }
    const controller = new AbortController();
    setLoading(currentDefinition === undefined);
    setLoadError("");
    void store.api
      .getThreadAutomation(threadId, controller.signal)
      .then(async (loaded) => {
        if (controller.signal.aborted) return;
        adoptDefinition(loaded);
        const runs = await store.api.listThreadAutomationRuns(threadId, {
          limit: 50,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setHistory((current) => mergeRuns(runs.items, current));
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(messageFrom(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          loadedExistingAutomation.current = true;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    adoptDefinition,
    automationSummaryRevision,
    loadAttempt,
    store,
    threadId,
  ]);

  const schedule = useMemo<AutomationSchedule | undefined>(() => {
    if (scheduleKind === "date_time") {
      const timestamp = new Date(dateTime);
      return Number.isFinite(timestamp.getTime())
        ? { kind: "date_time", runAt: timestamp.toISOString() }
        : undefined;
    }
    if (scheduleKind === "interval") {
      const multiplier =
        intervalUnit === "minutes" ? 60 : intervalUnit === "hours" ? 3_600 : 86_400;
      const everySeconds = intervalAmount * multiplier;
      return Number.isSafeInteger(everySeconds)
        ? {
            kind: "interval",
            anchorAt:
              definition?.schedule.kind === "interval"
                ? definition.schedule.anchorAt
                : new Date().toISOString(),
            everySeconds,
          }
        : undefined;
    }
    return cronExpression.trim()
      ? {
          kind: "cron",
          expression: cronExpression.trim(),
          timeZone:
            definition?.schedule.kind === "cron"
              ? definition.schedule.timeZone
              : timeZone,
        }
      : undefined;
  }, [
    cronExpression,
    dateTime,
    definition,
    intervalAmount,
    intervalUnit,
    scheduleKind,
    timeZone,
  ]);
  const scheduleKey = schedule ? JSON.stringify(schedule) : "";

  useEffect(() => {
    if (loading) return;
    if (!schedule) {
      setPreview([]);
      setPreviewError("");
      setPreviewedScheduleKey("");
      return;
    }
    setPreview([]);
    setPreviewError("");
    setPreviewedScheduleKey("");
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      void store.api
        .previewThreadAutomationSchedule(
          threadId,
          schedule,
          5,
          controller.signal,
        )
        .then((result) => {
          if (!controller.signal.aborted) {
            setPreview(result.occurrences);
            setPreviewError("");
            setPreviewedScheduleKey(scheduleKey);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setPreview([]);
            setPreviewError(messageFrom(reason));
          }
        });
    }, 200);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [loading, schedule, scheduleKey, store, threadId]);

  const promptBytes = new TextEncoder().encode(prompt.trim()).byteLength;
  const precheckCommandBytes = new TextEncoder().encode(
    precheckCommand.trim(),
  ).byteLength;
  const precheck =
    precheckEnabled &&
    precheckCommand.trim() &&
    Number.isInteger(precheckTimeout) &&
    precheckTimeout >= 1 &&
    precheckTimeout <= 60 &&
    precheckCommandBytes <= maximumPrecheckCommandBytes
      ? {
          command: precheckCommand.trim(),
          timeoutSeconds: precheckTimeout,
          includeStdout: precheckIncludeStdout,
        }
      : null;
  const valid =
    Boolean(prompt.trim() && schedule) &&
    promptBytes <= maximumPromptBytes &&
    (!precheckEnabled || Boolean(precheck)) &&
    (runMode !== "clone" || canCloneOnRun) &&
    previewedScheduleKey === scheduleKey &&
    !previewError;

  const save = async () => {
    if (!schedule || !valid) return;
    setBusy("save");
    setError("");
    try {
      const fields = {
        prompt: prompt.trim(),
        runMode,
        schedule,
        misfirePolicy,
        precheck,
      };
      const saved = definition
        ? await store.api.updateThreadAutomation(threadId, {
            ...fields,
            expectedRevision: definition.revision,
            mutationId: mutationId(),
          })
        : await store.api.createThreadAutomation(threadId, {
            ...fields,
            mutationId: mutationId(),
          });
      adoptDefinition(saved);
    } catch (reason) {
      if (
        !definition &&
        reason instanceof ApiError &&
        reason.code === "conflict"
      ) {
        try {
          adoptDefinition(await store.api.getThreadAutomation(threadId));
          const runs = await store.api.listThreadAutomationRuns(threadId, {
            limit: 50,
          });
          setHistory((current) => mergeRuns(runs.items, current));
        } catch (reloadReason) {
          setError(messageFrom(reloadReason));
        }
      } else {
        setError(messageFrom(reason));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const testPrecheck = async () => {
    if (!precheck || !prompt.trim()) return;
    precheckTestController.current?.abort();
    const controller = new AbortController();
    const testedFingerprint = precheckInputFingerprint;
    precheckTestController.current = controller;
    setPrecheckTesting(true);
    setPrecheckResult(undefined);
    setError("");
    try {
      const result = await store.api.testThreadAutomationPrecheck(
        threadId,
        prompt.trim(),
        precheck,
        controller.signal,
      );
      if (
        !controller.signal.aborted &&
        precheckTestController.current === controller &&
        precheckInputFingerprintRef.current === testedFingerprint
      ) {
        setPrecheckResult(result);
      }
    } catch (reason) {
      if (
        !controller.signal.aborted &&
        precheckTestController.current === controller
      ) {
        setError(messageFrom(reason));
      }
    } finally {
      if (precheckTestController.current === controller) {
        precheckTestController.current = undefined;
        setPrecheckTesting(false);
      }
    }
  };

  const setState = async (action: "enable" | "pause") => {
    if (!definition) return;
    setBusy("state");
    setError("");
    try {
      const updated = await store.api.setThreadAutomationState(
        threadId,
        action,
        definition.revision,
        mutationId(),
      );
      setDefinition(updated);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const runNow = async () => {
    if (!definition) return;
    setBusy("run");
    setError("");
    try {
      const run = await store.api.runThreadAutomationNow(
        threadId,
        mutationId(),
      );
      setHistory((current) => mergeRuns(current, [run]));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const resolveRun = async (runId: string) => {
    if (!definition) return;
    setBusy("resolve");
    setError("");
    try {
      const { run } = await store.api.resolveThreadAutomationRun(
        threadId,
        runId,
      );
      setHistory((current) =>
        current.map((candidate) =>
          candidate.id === run.id ? run : candidate,
        ),
      );
      const refreshed = await store.api.getThreadAutomation(threadId);
      setDefinition(refreshed);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    if (!definition) return;
    setBusy("delete");
    setError("");
    try {
      await store.api.deleteThreadAutomation(
        threadId,
        definition.revision,
        mutationId(),
      );
    } catch (reason) {
      setBusy(undefined);
      throw new Error(messageFrom(reason));
    }
    onClose();
  };

  const frame = (
    header: React.ReactNode,
    body: React.ReactNode,
    footer: React.ReactNode,
  ): React.JSX.Element => (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        layout="side"
        size="lg"
        layer="over-dialog"
      >
        <DialogHeader>
          <div className="automation-dialog-title">
            <DialogTitle>
              Automation{" "}
              <span className="sr-only">settings for {threadTitle}</span>
            </DialogTitle>
            {header}
          </div>
          <DialogDescription>{threadTitle}</DialogDescription>
        </DialogHeader>
        {body}
        {footer}
      </DialogContent>
    </Dialog>
  );

  if (loading) {
    return frame(
      null,
      <DialogBody>
        <p className="automation-loading" role="status">
          Loading automation…
        </p>
      </DialogBody>,
      null,
    );
  }

  if (loadError && !definition) {
    return frame(
      null,
      <DialogBody>
        <DialogAlert tone="danger" title="We couldn’t load this automation">
          {loadError}
        </DialogAlert>
      </DialogBody>,
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Back to thread
        </Button>
        <Button onClick={() => setLoadAttempt((current) => current + 1)}>
          Try again
        </Button>
      </DialogFooter>,
    );
  }

  const liveSummary = automationSummary;
  const newerSummary =
    liveSummary &&
    definition &&
    liveSummary.revision > definition.revision
      ? liveSummary
      : undefined;
  const outcomeUncertain =
    definition?.lastRun?.state === "uncertain" ||
    liveSummary?.lastRun?.state === "uncertain";

  const runDisabled =
    saving || snoozed || outcomeUncertain || Boolean(newerSummary);
  const stateDisabled = saving || Boolean(newerSummary) || outcomeUncertain;
  const paused = definition?.status === "paused";
  const runLabel = busy === "run" ? "Running…" : "Run now";
  const stateLabel =
    busy === "state"
      ? paused
        ? "Enabling…"
        : "Pausing…"
      : paused
        ? "Enable"
        : "Pause";
  const toggleState = () => void setState(paused ? "enable" : "pause");

  return frame(
    definition ? (
      <>
        <StatusPill
          tone={definition.status === "enabled" ? "success" : "neutral"}
          className="capitalize"
        >
          {definition.status}
        </StatusPill>
        {stackedFooter && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* Sized like the X beside it and centred on the title line. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto size-(--dialog-close-size) my-[calc((var(--dialog-title-line)-var(--dialog-close-size))/2)] text-muted-foreground"
                aria-label="More automation actions"
                title="More automation actions"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={runDisabled}
                onSelect={() => void runNow()}
              >
                <Play aria-hidden="true" />
                {runLabel}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={stateDisabled} onSelect={toggleState}>
                {paused ? (
                  <Power aria-hidden="true" />
                ) : (
                  <Pause aria-hidden="true" />
                )}
                {stateLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>
    ) : (
      <Tag>New</Tag>
    ),
    <DialogBody>
      {error && <DialogAlert tone="danger">{error}</DialogAlert>}
      {loadError && definition && (
        <DialogAlert tone="danger">
          The latest automation state could not be loaded: {loadError}
        </DialogAlert>
      )}
      {newerSummary && (
        <DialogAlert
          tone="warning"
          role="status"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt((current) => current + 1)}
            >
              Reload automation
            </Button>
          }
        >
          This automation changed elsewhere. Reload before making another
          change.
        </DialogAlert>
      )}
      {outcomeUncertain && (
        <DialogAlert tone="warning" role="status">
          Resolve the uncertain run in history before editing, running, enabling,
          or deleting this automation.
        </DialogAlert>
      )}
      {snoozed && (
        <DialogAlert tone="warning" role="status">
          This thread is snoozed. Wake it before running the automation
          manually; scheduled occurrences are skipped while it sleeps.
        </DialogAlert>
      )}

      <div className="automation-editor-grid">
        <div className="automation-form">
          <DialogSection title="Prompt">
            <div className="automation-section-card padded">
              <Textarea
                className="automation-prompt"
                aria-label="Canned prompt"
                aria-describedby={`${promptHelpId}${promptBytes > maximumPromptBytes ? ` ${promptErrorId}` : ""}`}
                aria-invalid={promptBytes > maximumPromptBytes || undefined}
                value={prompt}
                maxLength={65_536}
                placeholder="Review the current project status and continue with the highest-priority task."
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setPrecheckResult(undefined);
                }}
              />
              <p id={promptHelpId} className="automation-help">
                This is separate from the thread composer and its stashes.
              </p>
              {promptBytes > maximumPromptBytes && (
                <AutomationFieldError id={promptErrorId}>
                  Prompt must be at most 65,536 UTF-8 bytes.
                </AutomationFieldError>
              )}
            </div>
          </DialogSection>

          <AutomationPrecheckSection
            enabled={precheckEnabled}
            onEnabledChange={(enabled) => {
              setPrecheckEnabled(enabled);
              setPrecheckResult(undefined);
            }}
            command={precheckCommand}
            onCommandChange={(command) => {
              setPrecheckCommand(command);
              setPrecheckResult(undefined);
            }}
            commandBytes={precheckCommandBytes}
            timeoutSeconds={precheckTimeout}
            onTimeoutSecondsChange={(seconds) => {
              setPrecheckTimeout(seconds);
              setPrecheckResult(undefined);
            }}
            includeStdout={precheckIncludeStdout}
            onIncludeStdoutChange={(include) => {
              setPrecheckIncludeStdout(include);
              setPrecheckResult(undefined);
            }}
            canTest={Boolean(precheck && prompt.trim())}
            testing={precheckTesting}
            result={precheckResult}
            onTest={() => void testPrecheck()}
          />

          <AutomationRunModeSection
            threadTitle={threadTitle}
            runMode={runMode}
            onRunModeChange={setRunMode}
            canCloneOnRun={canCloneOnRun}
          />

          <AutomationScheduleSection
            scheduleKind={scheduleKind}
            onScheduleKindChange={setScheduleKind}
            dateTime={dateTime}
            onDateTimeChange={setDateTime}
            intervalAmount={intervalAmount}
            onIntervalAmountChange={setIntervalAmount}
            intervalUnit={intervalUnit}
            onIntervalUnitChange={setIntervalUnit}
            cronExpression={cronExpression}
            onCronExpressionChange={setCronExpression}
            schedule={schedule}
            timeZone={timeZone}
            preview={preview}
            previewError={previewError}
          />

          <AutomationMisfireSection
            misfirePolicy={misfirePolicy}
            onMisfirePolicyChange={setMisfirePolicy}
          />

          {definition && (
            <Button
              variant="destructive"
              className="justify-self-start"
              disabled={saving || outcomeUncertain || Boolean(newerSummary)}
              onClick={() => setDeleteOpen(true)}
            >
              Delete automation…
            </Button>
          )}
        </div>

        <AutomationRunHistory
          history={history}
          saving={saving}
          onResolveRun={(runId) => void resolveRun(runId)}
        />
      </div>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        layer="over-dialog"
        title="Delete this automation?"
        description={`Scheduled and manual runs for “${threadTitle}” stop, and its settings are removed. This can’t be undone.`}
        confirmLabel="Delete automation"
        pendingLabel="Deleting…"
        tone="danger"
        onConfirm={remove}
      />
    </DialogBody>,
    <DialogFooter
      start={
        definition && !stackedFooter ? (
          <>
            <Button
              variant="outline"
              disabled={runDisabled}
              onClick={() => void runNow()}
            >
              {runLabel}
            </Button>
            <Button
              variant="outline"
              disabled={stateDisabled}
              onClick={toggleState}
            >
              {stateLabel}
            </Button>
          </>
        ) : undefined
      }
    >
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      <Button
        disabled={!valid || saving || outcomeUncertain || Boolean(newerSummary)}
        onClick={() => void save()}
      >
        {busy === "save" ? "Saving…" : "Save"}
      </Button>
    </DialogFooter>,
  );
}

function mergeRuns(
  current: readonly ThreadAutomationRun[],
  incoming: readonly ThreadAutomationRun[],
): ThreadAutomationRun[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()]
    .sort(
      (left, right) =>
        right.scheduledFor.localeCompare(left.scheduledFor) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, 50);
}
