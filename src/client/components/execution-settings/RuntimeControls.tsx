import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ConfigurationLifecycleImpact, ConfigurationLifecycleResult, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError } from "../../api/ApiClient.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { errorMessage } from "./fields.js";
import { actionLabels, applyLabels, preferenceLabels, presentRuntime, upgradeLabels, type RuntimeAction } from "./runtime-presentation.js";
import type { ConfigurationControls } from "./useConfiguration.js";

const confirmationNotes: Partial<Record<RuntimeAction, string>> = {
  upgrade: "The sidecar is upgraded to this server's current version and restarted.",
  restart: "The service restarts with the saved configuration.",
  stop: "The service stops, and Sedes will not restart it automatically.",
};

export function RuntimeControls({ controls, revision, resourceKind, resourceId, label, runtime, disabled, disabledReason, enabled = true, onRuntime, onRefresh, showSidecar = resourceKind === "environment" }: {
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
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ConfigurationLifecycleImpact>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unsettledMutationId, setUnsettledMutationId] = useState<string | undefined>(runtime?.lifecycleOperation?.mutationId);
  const [awaitingOutcome, setAwaitingOutcome] = useState(Boolean(runtime?.lifecycleOperation));
  const [outcomeUnknown, setOutcomeUnknown] = useState(runtime?.lifecycleOperation?.state === "unknown");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const initiatedFrom = useRef<"primary" | "actions" | "stop">("actions");
  const stopRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!impact && restoreFocus.current) {
      restoreFocus.current = false;
      (initiatedFrom.current === "stop" ? stopRef.current : initiatedFrom.current === "primary" ? primaryRef.current ?? actionsRef.current : actionsRef.current)?.focus();
    }
  }, [impact]);
  const reasonId = useId();
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
      setError("The previous operation outcome is unknown. Checking its original receipt does not repeat the command.");
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
  useEffect(() => {
    if (impact) confirmationRef.current?.focus();
  }, [impact]);
  const showResult = (result: ConfigurationLifecycleResult) => {
    onRuntime(result.runtime);
    setError("");
    setNotice("");
    // A slow operation keeps running server-side; keep asking for its receipt.
    setAwaitingOutcome(result.state === "pending" || result.state === "unknown");
    setOutcomeUnknown(result.state === "unknown");
    if (result.state === "unknown") {
      setError("The operation outcome is unknown. Check its original status, or Stop to end this runtime once the earlier command can be safely withdrawn.");
    } else if (result.state === "rejected" || result.state === "unavailable") {
      setError(result.runtime.lastError ?? "The requested operation is unavailable.");
    } else {
      setNotice(result.state === "pending" ? "Operation pending. Refresh status to check the original operation's outcome." : "Operation applied. The reported status is shown below.");
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
    setImpact(undefined);
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
  const cancelImpact = () => {
    setImpact(undefined);
    restoreFocus.current = true;
  };
  const presentation = presentRuntime(runtime, { resourceKind, sidecar: showSidecar, enabled });
  const menuOrder: readonly RuntimeAction[] = ["connect", "start", "restart", "upgrade", "disconnect", "stop"];
  const menuActions = [ ...(presentation.primary ? [presentation.primary] : []), ...presentation.secondary ]
    .sort((a, b) => menuOrder.indexOf(a.action) - menuOrder.indexOf(b.action));
  const paused = disabled || busy;
  const describedBy = disabled && disabledReason ? reasonId : undefined;
  const unconfirmed = runtime?.connectionState === "unknown" || runtime?.connectionState === "unreachable" || runtime?.connectionState === "recovery_required";
  const canStopUnknown = Boolean(unsettledMutationId) && outcomeUnknown && runtime?.supportedActions.includes("stop");
  return <section aria-label={`${label} runtime`} aria-busy={busy || undefined} className="execution-settings-section">
    <div className="execution-settings-status" data-tone={presentation.tone}>
      <div className="execution-settings-status-headline">
        <strong>{presentation.headline}</strong>
        {presentation.qualifier ? <Badge variant={presentation.tone === "attention" ? "destructive" : "outline"}>{presentation.qualifier}</Badge> : null}
      </div>
      <p className="execution-settings-status-detail">{presentation.detail}</p>
      {error || runtime?.lastError ? <div role="alert">
        {error ? <p className="execution-settings-error">{error}</p> : null}
        {runtime?.lastError && runtime.lastError !== error ? <p className="execution-settings-error">{runtime.lastError}</p> : null}
      </div> : null}
      {runtime ? <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="execution-settings-status-details">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="link" size="xs" aria-label={`${label} runtime details`}>Diagnostics <ChevronDown aria-hidden="true" data-icon="inline-end" /></Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl>
            <dt>Connection preference</dt><dd>{preferenceLabels[runtime.preference]}</dd>
            <dt>Configuration</dt><dd>{runtime.applyState === "pending" && runtime.startupEnvironmentPending ? "Pending restart" : applyLabels[runtime.applyState]}</dd>
            <dt>Saved revision</dt><dd>{runtime.desiredRevision}</dd>
            <dt>Applied revision</dt><dd>{runtime.effectiveRevision ?? "Not confirmed"}</dd>
            <dt>Active or unconfirmed resources</dt><dd>{unconfirmed ? "Not confirmed" : runtime.activeResources}</dd>
            {showSidecar ? <><dt>Sidecar version</dt><dd>{runtime.softwareVersion ?? "Not reported"}</dd>
              <dt>Upgrade</dt><dd>{upgradeLabels[runtime.upgradeState]}</dd></> : null}
            {runtime.incarnation ? <><dt>Service incarnation</dt><dd className="execution-settings-truncate" title={runtime.incarnation}>{runtime.incarnation}</dd></> : null}
          </dl>
        </CollapsibleContent>
      </Collapsible> : null}
    </div>
    {impact ? <div ref={confirmationRef} tabIndex={-1} className="execution-settings-confirmation" data-tone="attention" role="group" aria-label="Confirm runtime interruption">
      <strong>{actionLabels[impact.action]} {label}?</strong>
      <p>{impact.activeResources} affected resource{impact.activeResources === 1 ? "" : "s"}. Running work will be interrupted; interrupted work is not restarted automatically.</p>
      <p>Some retained work may have an unknown outcome. Unrecovered output or results may be lost when its runtime stops; completed external changes are not undone.</p>
      {impact.interruptions.length ? <ul>{impact.interruptions.map((interruption, index) => <li key={index}>{interruption}</li>)}</ul> : null}
      {confirmationNotes[impact.action] ? <p>{confirmationNotes[impact.action]}</p> : null}
      <p className="execution-settings-muted">This preview expires in about two minutes.</p>
      <div className="execution-settings-actions"><Button type="button" variant="destructive" size="sm" disabled={busy || disabled}
        onClick={() => void execute(impact.action, impact)}>Confirm {actionLabels[impact.action].toLowerCase()}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancelImpact}>Cancel</Button></div>
    </div> : <div className="execution-settings-actions">
      {unsettledMutationId
        ? <Button type="button" size="sm" disabled={busy} onClick={() => void refreshStatus()}>Refresh status</Button>
        : presentation.primary
          ? <Button ref={primaryRef} type="button" size="sm" variant={presentation.primary.emphasis} disabled={paused} aria-describedby={describedBy}
            onClick={() => { initiatedFrom.current = "primary"; void requestAction(presentation.primary!.action); }}>{presentation.primary.label}</Button>
          : null}
      {canStopUnknown ? <Button ref={stopRef} type="button" variant="destructive" size="sm" disabled={paused}
        onClick={() => { initiatedFrom.current = "stop"; void requestAction("stop"); }}>Stop</Button> : null}
      {<DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={actionsRef} type="button" size="sm" variant="outline" disabled={paused || Boolean(unsettledMutationId) || !menuActions.length} aria-describedby={describedBy} aria-label={`Runtime actions for ${label}`}>
            Actions <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        {/* Settings renders inside a modal dialog whose overlay sits above the menu's default layer. */}
        <DropdownMenuContent align="start" className="execution-settings-menu z-[100]">
          {menuActions.map((entry) => <DropdownMenuItem key={entry.action} variant={entry.emphasis} onSelect={() => { initiatedFrom.current = "actions"; void requestAction(entry.action); }}>{entry.label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>}
      {unsettledMutationId ? <span className="execution-settings-muted">{awaitingOutcome ? "Checking the outcome automatically. " : ""}{canStopUnknown ? "Stop checks the earlier command before ending this runtime." : "Other actions wait until this operation settles."}</span> : null}
    </div>}
    {disabled && disabledReason ? <p role="status" id={reasonId} className="execution-settings-muted">{disabledReason}</p> : null}
    {notice ? <p role="status" className="execution-settings-notice">{notice}</p> : null}
  </section>;
}
