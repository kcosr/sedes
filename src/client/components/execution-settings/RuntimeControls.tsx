import { useEffect, useId, useRef, useState } from "react";
import type { ConfigurationLifecycleImpact, ConfigurationLifecycleResult, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError } from "../../api/ApiClient.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { DropdownMenuItem } from "../ui/dropdown-menu.js";
import { KeyValueList, type KeyValueItem } from "../ui/key-value-list.js";
import { StatusPill } from "../ui/status-pill.js";
import type { Tone } from "../ui/tone.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { errorMessage } from "./fields.js";
import { actionLabels, applyLabels, atLeast, preferenceLabels, presentRuntime, upgradeLabels, type RuntimeAction, type RuntimeActionPresentation, type RuntimePresentation, type StatusPresentation } from "./runtime-presentation.js";
import type { ConfigurationControls } from "./useConfiguration.js";

const confirmationNotes: Partial<Record<RuntimeAction, string>> = {
  upgrade: "The sidecar is upgraded to this server's current version and restarted.",
  restart: "The service restarts with the saved configuration.",
  stop: "The service stops, and Sedes will not restart it automatically.",
};

export interface RuntimeControllerOptions {
  readonly controls: ConfigurationControls;
  readonly revision: number;
  readonly resourceKind: "environment" | "backend";
  readonly resourceId: string;
  readonly label: string;
  readonly runtime?: ConfigurationRuntimeState;
  readonly disabled: boolean;
  /** Shown beside disabled controls so the operator knows why they are paused. */
  readonly disabledReason?: string;
  /** Whether the definition itself is enabled; a disabled backend may still own a runtime. */
  readonly enabled?: boolean;
  readonly onRuntime: (runtime: ConfigurationRuntimeState) => void;
  readonly onRefresh: () => Promise<boolean>;
  readonly showSidecar?: boolean;
  readonly stopEffect?: "service" | "attachment" | "unknown";
}

export interface RuntimeController {
  readonly label: string;
  readonly runtime?: ConfigurationRuntimeState;
  readonly presentation: RuntimePresentation;
  readonly showSidecar: boolean;
  readonly stopEffect: "service" | "attachment" | "unknown";
  readonly busy: boolean;
  /** Commands are paused: the page is busy or the caller disabled them. */
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  /** The id of the element explaining why controls are paused, when they are. */
  readonly reasonId: string;
  readonly describedBy?: string;
  readonly error?: { readonly message: string; readonly tone: Tone };
  readonly notice?: string;
  /** A command whose outcome is still being checked; other commands wait for it. */
  readonly unsettled: boolean;
  readonly awaitingOutcome: boolean;
  readonly canStopUnknown: boolean;
  readonly impact?: ConfigurationLifecycleImpact;
  requestAction(action: RuntimeAction): void;
  refreshStatus(): void;
  confirmImpact(): Promise<void>;
  cancelImpact(): void;
}

/**
 * The lifecycle state of one runtime: its command in flight, the receipt of
 * an unsettled command, and an interruption preview awaiting confirmation.
 * Keep exactly one mounted per resource, even while its detail is hidden,
 * so receipts keep settling and a command is never repeated.
 */
export function useRuntimeController({ controls, revision, resourceKind, resourceId, label, runtime, disabled, disabledReason, enabled = true, onRuntime, onRefresh, stopEffect = "service", showSidecar = resourceKind === "environment" }: RuntimeControllerOptions): RuntimeController {
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ConfigurationLifecycleImpact>();
  const [error, setErrorState] = useState<{ message: string; tone: Tone }>();
  const [notice, setNotice] = useState("");
  const [unsettledMutationId, setUnsettledMutationId] = useState<string | undefined>(runtime?.lifecycleOperation?.mutationId);
  const [awaitingOutcome, setAwaitingOutcome] = useState(Boolean(runtime?.lifecycleOperation));
  const [outcomeUnknown, setOutcomeUnknown] = useState(runtime?.lifecycleOperation?.state === "unknown");
  const reasonId = useId();
  const setError = (message: string, tone: Tone = "danger") => setErrorState(message ? { message, tone } : undefined);
  const durableOperation = runtime?.lifecycleOperation;
  const durableOperationRef = useRef(durableOperation);
  durableOperationRef.current = durableOperation;
  const releaseSettledReceipt = (mutationId: string) => {
    const outstanding = durableOperationRef.current;
    // A superseding Stop can settle as rejected while the earlier command is
    // still unknown. Settling this receipt must not hide that original one.
    if (outstanding && outstanding.mutationId !== mutationId) {
      setUnsettledMutationId(outstanding.mutationId);
      setAwaitingOutcome(true);
      setOutcomeUnknown(outstanding.state === "unknown");
      return true;
    } else {
      setUnsettledMutationId(undefined);
      return false;
    }
  };
  useEffect(() => {
    if (!durableOperation) return;
    setUnsettledMutationId(durableOperation.mutationId);
    setAwaitingOutcome(true);
    setOutcomeUnknown(durableOperation.state === "unknown");
    if (durableOperation.state === "unknown") {
      setError("The previous operation outcome is unknown. Checking its original receipt does not repeat the command.", "warning");
    } else {
      setNotice(`${actionLabels[durableOperation.action]} is pending. Checking the original operation's outcome.`);
    }
  }, [durableOperation?.mutationId, durableOperation?.state, durableOperation?.action]);
  const expireImpact = () => {
    setImpact(undefined);
    setNotice("The interruption preview expired. Select the action again to review its current impact.");
  };
  useEffect(() => {
    if (!impact) return;
    const remaining = Date.parse(impact.expiresAt) - Date.now();
    if (remaining <= 0) { expireImpact(); return; }
    const timer = window.setTimeout(expireImpact, remaining);
    return () => window.clearTimeout(timer);
  }, [impact]);
  const showResult = (result: ConfigurationLifecycleResult) => {
    onRuntime(result.runtime);
    setError("");
    setNotice("");
    // A slow operation keeps running server-side; keep asking for its receipt.
    setAwaitingOutcome(result.state === "pending" || result.state === "unknown");
    setOutcomeUnknown(result.state === "unknown");
    if (result.state === "unknown") {
      setError("The operation outcome is unknown. Check its original status, or Stop to end this runtime once the earlier command can be safely withdrawn.", "warning");
    } else if (result.state === "rejected" || result.state === "unavailable") {
      setError(result.runtime.lastError ?? "The requested operation is unavailable.", result.state === "rejected" ? "danger" : "warning");
    } else {
      setNotice(result.state === "pending" ? "Operation pending. Refresh status to check the original operation's outcome." : "Operation applied. The reported status is shown above.");
    }
    return result.state !== "pending" && result.state !== "unknown";
  };
  const execute = async (action: RuntimeAction, confirmed?: ConfigurationLifecycleImpact) => {
    // Background tabs may pause timers, so also check at command admission.
    if (confirmed && Date.parse(confirmed.expiresAt) <= Date.now()) {
      expireImpact();
      return;
    }
    const mutationId = crypto.randomUUID();
    const previousMutationId = unsettledMutationId;
    setUnsettledMutationId(mutationId);
    setOutcomeUnknown(false);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await controls.configurationLifecycle({
        mutationId, expectedRevision: confirmed?.configurationRevision ?? revision,
        resourceKind, resourceId, action,
        expectedIncarnation: confirmed ? confirmed.incarnation : runtime?.incarnation ?? null,
        impactToken: confirmed?.token ?? null,
      });
      const settled = showResult(result);
      // Lifecycle preferences advance the saved document revision. Load that
      // document before allowing another command to use its revision.
      const refreshed = await onRefresh();
      if (settled && refreshed) releaseSettledReceipt(result.mutationId);
      else if (settled) setAwaitingOutcome(true); // A busy configuration read/save must not strand this receipt.
    } catch (cause) {
      setAwaitingOutcome(false);
      if (previousMutationId && action === "stop" && cause instanceof ApiError && cause.status === 409) {
        setUnsettledMutationId(previousMutationId);
        setOutcomeUnknown(true);
      }
      setError(`${errorMessage(cause, "The operation result could not be confirmed.")} Refresh before issuing another command.`);
    } finally { setBusy(false); }
  };
  const refreshStatus = async () => {
    if (!unsettledMutationId) return;
    setBusy(true);
    try {
      const result = await controls.getLifecycleReceipt(unsettledMutationId);
      const settled = showResult(result);
      const refreshed = await onRefresh();
      if (settled && refreshed) releaseSettledReceipt(result.mutationId);
      else if (settled) setAwaitingOutcome(true); // A busy configuration read/save must not strand this receipt.
    } catch (cause) {
      setAwaitingOutcome(false);
      if (cause instanceof ApiError && cause.status === 404) {
        // Admission records a receipt before any effect; absence is definitive.
        const originalRemains = releaseSettledReceipt(unsettledMutationId);
        setError("");
        setNotice(originalRemains
          ? "No new operation was admitted. The earlier operation still has an unconfirmed outcome."
          : "No operation was admitted. You can select the action again.");
      } else {
        setError(`${errorMessage(cause, "The original operation result could not be confirmed.")} Refresh status before issuing another command.`);
      }
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!unsettledMutationId || !awaitingOutcome || busy) return;
    const timer = window.setTimeout(() => void refreshStatus(), 4_000);
    return () => window.clearTimeout(timer);
  });
  const requestAction = async (action: RuntimeAction) => {
    if (action !== "stop" && action !== "restart" && action !== "upgrade") {
      await execute(action);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await controls.configurationLifecycleImpact({ resourceKind, resourceId, action, expectedRevision: revision });
      if (next.activeResources > 0 || next.interruptions.length > 0) setImpact(next);
      else await execute(action, next);
    } catch (cause) { setError(errorMessage(cause, "Could not determine the effect of this operation.")); }
    finally { setBusy(false); }
  };
  const presentation = presentRuntime(runtime, { resourceKind, sidecar: showSidecar, enabled, stopEffect });
  const unsettled = Boolean(unsettledMutationId);
  return {
    label, runtime, presentation, showSidecar, stopEffect, busy, paused: disabled || busy, disabled, disabledReason, reasonId,
    describedBy: disabled && disabledReason ? reasonId : undefined,
    ...(error ? { error } : {}), ...(notice ? { notice } : {}),
    unsettled, awaitingOutcome,
    canStopUnknown: unsettled && outcomeUnknown && Boolean(runtime?.supportedActions.includes("stop")),
    ...(impact ? { impact } : {}),
    requestAction: (action) => void requestAction(action),
    refreshStatus: () => void refreshStatus(),
    confirmImpact: async () => {
      if (!impact) return;
      await execute(impact.action, impact);
      setImpact(undefined);
    },
    cancelImpact: () => setImpact(undefined),
  };
}

/** The contextual command: the state's primary action, or Refresh status while a command is unsettled. */
export function RuntimePrimaryAction({ controller }: { readonly controller: RuntimeController }): React.JSX.Element | null {
  const { presentation, unsettled, busy, paused, describedBy } = controller;
  if (unsettled) return <Button type="button" disabled={busy} onClick={controller.refreshStatus}>Refresh status</Button>;
  const primary = presentation.primary;
  if (!primary) return null;
  return <Button type="button" variant={primary.emphasis} disabled={paused} aria-describedby={describedBy}
    onClick={() => controller.requestAction(primary.action)}>{primary.label}</Button>;
}

const menuOrder: readonly RuntimeAction[] = ["connect", "start", "restart", "upgrade", "disconnect", "stop"];

/**
 * The rarer lifecycle commands, as items of the detail's actions menu: the
 * regular ones, or the destructive ones that the menu puts last, after a
 * separator.
 */
export function RuntimeMenuItems({ controller, emphasis }: { readonly controller: RuntimeController; readonly emphasis: RuntimeActionPresentation["emphasis"] }): React.JSX.Element {
  const actions = controller.presentation.secondary.filter(entry => entry.emphasis === emphasis)
    .sort((a, b) => menuOrder.indexOf(a.action) - menuOrder.indexOf(b.action));
  return <>{actions.map((entry) => <DropdownMenuItem key={entry.action} variant={entry.emphasis}
    disabled={controller.paused || (controller.unsettled && !stopsUnknown(controller, entry.action))}
    onSelect={() => controller.requestAction(entry.action)}>{entry.label}</DropdownMenuItem>)}</>;
}

/** While a command's outcome is unknown, Stop alone stays available: it checks that command first. */
function stopsUnknown(controller: RuntimeController, action: RuntimeAction): boolean {
  return action === "stop" && controller.canStopUnknown;
}

/** Whether the menu has a command available now; otherwise its trigger is disabled. */
export function hasAvailableRuntimeMenuItems(controller: RuntimeController): boolean {
  if (controller.paused) return false;
  return !controller.unsettled || controller.presentation.secondary.some(entry => stopsUnknown(controller, entry.action));
}

/** Whether the detail's actions menu offers a destructive lifecycle command. */
export function hasDestructiveRuntimeMenuItems(controller: RuntimeController): boolean {
  return controller.presentation.secondary.some(entry => entry.emphasis === "destructive");
}

/** Whether the detail's actions menu has any lifecycle command to offer. */
export function hasRuntimeMenuItems(controller: RuntimeController): boolean {
  return controller.presentation.secondary.length > 0;
}

/**
 * Command feedback under the detail header, visible on every tab: why
 * commands are paused, one Callout for what went wrong (the last command's
 * error over the runtime's own last error), and a command's notice.
 */
export function RuntimeFeedback({ controller }: { readonly controller: RuntimeController }): React.JSX.Element | null {
  const { disabled, disabledReason, error, notice, reasonId, runtime, presentation } = controller;
  const reason = disabled && disabledReason;
  const lastError = runtime?.lastError ?? undefined;
  const commandError = error && error.message !== lastError ? error : undefined;
  const lastErrorTone: Tone = presentation.tone === "danger" ? "danger" : "warning";
  const problemTone: Tone = commandError && (!lastError || atLeast(commandError.tone, lastErrorTone)) ? commandError.tone : lastErrorTone;
  if (!reason && !commandError && !lastError && !notice) return null;
  return <div className="execution-runtime-feedback">
    {reason ? <p role="status" id={reasonId} className="execution-muted">{disabledReason}</p> : null}
    {commandError || lastError ? <Callout tone={problemTone} role="alert" title={commandError && lastError ? commandError.message : undefined}>
      {lastError ?? commandError?.message}</Callout> : null}
    {notice ? <Callout tone="info" role="status">{notice}</Callout> : null}
  </div>;
}

/**
 * The top of Overview: what the runtime is doing, in words. The detail
 * header carries the one status pill and the primary action, and the
 * feedback under it any error, so this names a runtime state only where it
 * differs from the header's (a paired host can be online while its runtime
 * is unknown).
 */
export function RuntimeHealth({ controller, status, children }: {
  readonly controller: RuntimeController;
  /** The state the detail header's pill shows. */
  readonly status: StatusPresentation;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const { presentation, unsettled, awaitingOutcome, canStopUnknown, label } = controller;
  const pills = [
    { label: presentation.headline, tone: presentation.headlineTone },
    ...(presentation.qualifier ? [{ label: presentation.qualifier, tone: presentation.qualifierTone ?? "neutral" }] : []),
  ].filter(pill => pill.label !== status.label);
  return <section aria-label={`${label} status`} className="execution-health">
    {pills.length ? <div className="execution-health-status">
      <span className="execution-health-label">Runtime</span>
      {pills.map(pill => <StatusPill key={pill.label} tone={pill.tone}>{pill.label}</StatusPill>)}
    </div> : null}
    <p className="execution-health-detail">{presentation.detail}</p>
    {unsettled ? <p className="execution-muted">{awaitingOutcome ? "Checking the outcome automatically. " : ""}
      {canStopUnknown ? "Other actions wait until it settles; Stop is in the actions menu." : "Other actions wait until this operation settles."}</p> : null}
    {children}
  </section>;
}

/** Technical runtime details for Activity: preferences, revisions, versions and the incarnation. */
export function runtimeDiagnostics(controller: RuntimeController): KeyValueItem[] {
  const { runtime, showSidecar } = controller;
  if (!runtime) return [];
  const unconfirmed = runtime.connectionState === "unknown" || runtime.connectionState === "unreachable" || runtime.connectionState === "recovery_required";
  return [
    { label: "Connection preference", value: preferenceLabels[runtime.preference] },
    { label: "Configuration", value: runtime.applyState === "pending" && runtime.startupEnvironmentPending ? "Pending restart" : applyLabels[runtime.applyState] },
    { label: "Saved revision", value: runtime.desiredRevision, mono: true },
    { label: "Applied revision", value: runtime.effectiveRevision ?? "Not confirmed", mono: runtime.effectiveRevision !== null },
    { label: "Active or unconfirmed resources", value: unconfirmed ? "Not confirmed" : runtime.activeResources },
    ...(showSidecar ? [
      { label: "Sidecar version", value: runtime.softwareVersion ?? "Not reported", mono: Boolean(runtime.softwareVersion) },
      { label: "Upgrade", value: upgradeLabels[runtime.upgradeState] },
    ] : []),
  ];
}

/** Confirms a command that interrupts running work, listing exactly what it affects. */
export function RuntimeImpactDialog({ controller }: { readonly controller: RuntimeController }): React.JSX.Element {
  const { impact, label, runtime, stopEffect } = controller;
  const focusReturn = useFocusReturn();
  const [shown, setShown] = useState(impact);
  // Keep the last preview on screen while the dialog closes.
  useEffect(() => { if (impact) setShown(impact); }, [impact]);
  const current = impact ?? shown;
  const action = current ? actionLabels[current.action] : "";
  const retiresAttachment = current?.action === "stop" && stopEffect === "attachment";
  const unknownStopEffect = current?.action === "stop" && stopEffect === "unknown";
  const unreachableStop = current?.action === "stop" && runtime?.connectionState === "unreachable";
  const recoveryStop = current?.action === "stop" && runtime?.connectionState === "recovery_required";
  const consequence = unreachableStop
    ? "Stop records that Sedes should not start this runtime automatically. Shutdown or attachment retirement is unconfirmed while the host is unreachable."
    : recoveryStop ? "Stop checks ownership before ending Sedes-owned execution or retiring an external attachment. Shutdown is unconfirmed until ownership can be verified."
    : retiresAttachment
    ? "Sedes retires its connection and retained recovery state. The external server and its running work continue."
    : unknownStopEffect ? "Stop ends Sedes-owned execution or retires Sedes's attachment to an external server. External servers are left running."
    : "Running work will be interrupted; interrupted work is not restarted automatically.";
  return <ConfirmDialog open={Boolean(impact)} onOpenChange={(open) => { if (!open) controller.cancelImpact(); }}
    title={`${action} ${label}?`} tone="danger" confirmLabel={`Confirm ${action.toLowerCase()}`}
    description={current ? `${current.activeResources} affected resource${current.activeResources === 1 ? "" : "s"}. ${consequence}` : undefined}
    onConfirm={controller.confirmImpact} {...focusReturn}>
    {current ? <div className="execution-impact">
      <p>{unreachableStop
        ? "Work on the host may still be running. Reconnect and inspect its status before deciding whether to stop it again."
        : retiresAttachment
        ? "Pending Sedes results may remain unknown, and retained output may be lost. Connect again to establish a new Sedes attachment."
        : "Some retained work may have an unknown outcome. Unrecovered output or results may be lost when its runtime stops; completed external changes are not undone."}</p>
      {current.interruptions.length ? <ul>{current.interruptions.map((interruption, index) => <li key={index}>{interruption}</li>)}</ul> : null}
      {!unreachableStop && !recoveryStop && !retiresAttachment && !unknownStopEffect && confirmationNotes[current.action] ? <p>{confirmationNotes[current.action]}</p> : null}
      <p className="execution-muted">This preview expires in about two minutes.</p>
    </div> : null}
  </ConfirmDialog>;
}
