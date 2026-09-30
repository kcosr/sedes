import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  ConfigurationOperationRecoveryReference,
  ConfigurationOperationRecoverySummary,
  ConfigurationOperationRecoveryDetails,
} from "../../../shared/protocol/configuration-operation-recovery.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { Checkbox } from "../ui/checkbox.js";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { EmptyState } from "../ui/empty-state.js";
import { Field } from "../ui/field.js";
import { KeyValueList } from "../ui/key-value-list.js";
import { StatusPill } from "../ui/status-pill.js";
import type { Tone } from "../ui/tone.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { CopyableValue } from "./detail-parts.js";
import { errorMessage } from "./fields.js";
import type { ApiClient } from "../../api/ApiClient.js";

export type OperationRecoveryControls = Pick<ApiClient, "listConfigurationOperations" | "inspectConfigurationOperation" | "acknowledgeConfigurationOperation">;
const stateLabels = { pending: "Pending", unknown: "Outcome unknown", failed: "Failed", succeeded: "Succeeded" } as const;
const stateTones: Record<keyof typeof stateLabels, Tone> = { pending: "info", unknown: "warning", failed: "danger", succeeded: "success" };
const kindLabels = { file: "File operation", workspace: "Workspace operation", shell: "Shell command" } as const;
const pageSize = 40;

/**
 * Results retained on a host after a connection loss. Opening the dialog is
 * an explicit inspection request: reading a result never acknowledges or
 * repeats it, and releasing one requires its fresh inspection.
 */
export function RecoveredOperations({ controls, environmentId, label, open, onOpenChange }: {
  readonly controls: OperationRecoveryControls;
  readonly environmentId: string;
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [receipts, setReceipts] = useState<ConfigurationOperationRecoverySummary[]>([]);
  const [inspected, setInspected] = useState<ConfigurationOperationRecoveryDetails>();
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const [unknownReviewed, setUnknownReviewed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertainAcknowledgment, setUncertainAcknowledgment] = useState(false);
  const [page, setPage] = useState(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const focusReturn = useFocusReturn();
  const begin = () => {
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setLoading(true); setError(""); setNotice("");
    return controller;
  };
  const refresh = async () => {
    const controller = begin();
    setInspected(undefined);
    setConfirmationToken(null);
    setUnknownReviewed(false);
    try {
      const result = await controls.listConfigurationOperations(environmentId, controller.signal);
      if (controller.signal.aborted) return;
      setReceipts(result.receipts); setPage(0); setLoaded(true); setUncertainAcknowledgment(false);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause, "Could not load retained operations."));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    if (open) void refresh();
    return () => requestController.current?.abort();
    // A dialog opening is an explicit inspection request; no background read acknowledges results.
  }, [open, controls, environmentId]);
  const inspect = async (reference: ConfigurationOperationRecoveryReference) => {
    const controller = begin();
    setInspected(undefined);
    setConfirmationToken(null);
    setUnknownReviewed(false);
    try {
      const result = await controls.inspectConfigurationOperation(environmentId, reference, controller.signal);
      if (controller.signal.aborted) return;
      if (result.operation.kind !== reference.kind || result.operation.receiptId !== reference.receiptId) throw new Error("The server returned a different operation. Refresh the list before inspecting again.");
      setInspected(result.operation);
      setConfirmationToken(result.confirmationToken);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause, "Could not inspect this operation."));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const acknowledge = async () => {
    if (!inspected?.acknowledgeable || (inspected.state === "unknown" && !unknownReviewed) || uncertainAcknowledgment || confirmationToken === null) return;
    const receipt = inspected;
    const controller = begin();
    try {
      const result = await controls.acknowledgeConfigurationOperation(environmentId, { kind: receipt.kind, receiptId: receipt.receiptId }, { confirmationToken }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.acknowledged) {
        setUncertainAcknowledgment(true);
        setError("Acknowledgment was not confirmed. Refresh and inspect the retained operation before trying again.");
        return;
      }
      setReceipts((current) => current.filter((entry) => entry.kind !== receipt.kind || entry.receiptId !== receipt.receiptId));
      setInspected(undefined); setConfirmationToken(null);
      setNotice(receipt.state === "unknown" ? "Retained result released. The operation's outcome remains unknown." : "Result acknowledged and released.");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setUncertainAcknowledgment(true);
        setError(`${errorMessage(cause, "Acknowledgment outcome is unknown.")} Refresh the list before another acknowledgment.`);
      }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const pages = Math.max(1, Math.ceil(receipts.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="xl" className="execution-recovery-dialog" {...focusReturn}>
      <DialogHeader><DialogTitle>Recovered operations · {label}</DialogTitle>
        <DialogDescription>Inspect results retained after a connection loss. Reading a result does not acknowledge or repeat the operation.</DialogDescription></DialogHeader>
      <DialogBody>
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        {notice ? <Callout tone="success" role="status">{notice}</Callout> : null}
        {loading ? <p role="status" className="execution-muted">Loading retained operation state…</p> : null}
        <div className="execution-recovery-layout">
          <section aria-label="Retained operations" className="execution-recovery-list">
            <Button type="button" variant="outline" size="sm" className="execution-recovery-refresh" disabled={loading} onClick={() => void refresh()}><RefreshCw />Refresh operations</Button>
            {loaded && receipts.length === 0 ? <EmptyState variant="inline" title="No retained operations." /> : null}
            {receipts.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((receipt) => {
              const selected = inspected?.kind === receipt.kind && inspected.receiptId === receipt.receiptId;
              return <button key={`${receipt.kind}:${receipt.receiptId}`} type="button" className="execution-recovery-item" aria-current={selected ? "true" : undefined}
                disabled={loading || uncertainAcknowledgment} aria-label={`Inspect ${receipt.summary || kindLabels[receipt.kind]}`}
                onClick={() => void inspect({ kind: receipt.kind, receiptId: receipt.receiptId })}>
                <span className="execution-recovery-item-title">{kindLabels[receipt.kind]}<StatusPill tone={stateTones[receipt.state]}>{stateLabels[receipt.state]}</StatusPill></span>
                <span className="execution-recovery-item-summary">{receipt.summary}</span>
              </button>;
            })}
            {receipts.length > pageSize ? <div className="execution-actions"><Button type="button" variant="outline" size="sm" disabled={loading || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
              <span className="execution-muted">Page {currentPage + 1} of {pages}</span>
              <Button type="button" variant="outline" size="sm" disabled={loading || currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</Button></div> : null}
          </section>
          <section aria-label="Inspected operation" className="execution-recovery-inspected">
            {inspected ? <>
              <h3 className="execution-recovery-heading">{kindLabels[inspected.kind]} <StatusPill tone={stateTones[inspected.state]}>{stateLabels[inspected.state]}</StatusPill></h3>
              <p>{inspected.summary}</p>
              <KeyValueList items={[{ label: "Receipt", value: <CopyableValue value={inspected.receiptId} label="receipt ID" /> }]} />
              {inspected.details ? <div><h4>Details</h4><pre>{inspected.details}</pre></div> : null}
              {inspected.stdout ? <div><h4>Standard output</h4><pre>{inspected.stdout}</pre></div> : null}
              {inspected.stderr ? <div><h4>Standard error</h4><pre>{inspected.stderr}</pre></div> : null}
              {inspected.omittedBytes > 0 ? <p className="execution-muted">{inspected.omittedBytes.toLocaleString()} output bytes were omitted from this bounded result.</p> : null}
              {inspected.acknowledgeable ? <div className="execution-recovery-release">
                <p className="execution-muted">Acknowledging releases this retained result. It does not retry the operation or change its effect.</p>
                {inspected.state === "unknown" ? <>
                  <Callout tone="warning">The operation's effect is unknown. Inspect the affected workspace before releasing this record. Release does not confirm success or undo the operation.</Callout>
                  <Field label="I inspected the affected workspace and accept this unknown outcome" orientation="horizontal" className="execution-recovery-review">
                    <Checkbox checked={unknownReviewed} disabled={loading || uncertainAcknowledgment} onCheckedChange={(checked) => setUnknownReviewed(checked === true)} />
                  </Field>
                </> : null}
                {confirmationToken === null ? <Callout tone="warning">An acknowledgment confirmation is unavailable. Refresh and inspect the result again.</Callout> : null}
                <div><Button type="button" size="sm" variant={inspected.state === "unknown" ? "destructive" : "default"}
                  disabled={loading || uncertainAcknowledgment || confirmationToken === null || (inspected.state === "unknown" && !unknownReviewed)} onClick={() => void acknowledge()}>
                  {inspected.state === "unknown" ? "Release inspected unknown outcome" : "Acknowledge and release result"}
                </Button></div>
              </div> : <p className="execution-muted">This operation does not have an acknowledgeable final result. It remains retained.</p>}
            </> : <EmptyState variant="inline" title="Inspect an operation to review its result before acknowledging it." />}
          </section>
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
