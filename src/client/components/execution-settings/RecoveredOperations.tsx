import { useEffect, useRef, useState } from "react";
import type {
  ConfigurationOperationRecoveryReference,
  ConfigurationOperationRecoverySummary,
  ConfigurationOperationRecoveryDetails,
} from "../../../shared/protocol/configuration-operation-recovery.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { errorMessage, Toggle } from "./fields.js";
import type { ApiClient } from "../../api/ApiClient.js";

export type OperationRecoveryControls = Pick<ApiClient, "listConfigurationOperations" | "inspectConfigurationOperation" | "acknowledgeConfigurationOperation">;
const stateLabels = { pending: "Pending", unknown: "Outcome unknown", failed: "Failed", succeeded: "Succeeded" } as const;
const kindLabels = { file: "File operation", workspace: "Workspace operation", shell: "Shell command" } as const;
const pageSize = 40;

export function RecoveredOperations({ controls, environmentId, label, disabled, emphasized = false }: {
  readonly controls: OperationRecoveryControls;
  readonly environmentId: string;
  readonly label: string;
  readonly disabled: boolean;
  /** Retained results likely block lifecycle actions; make the entry point prominent. */
  readonly emphasized?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
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
  const currentPage = Math.min(page, Math.max(0, Math.ceil(receipts.length / pageSize) - 1));
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" variant={emphasized ? "outline" : "ghost"} size="sm" disabled={disabled}>Recovered operations</Button></DialogTrigger>
    <DialogContent className="execution-recovery-dialog">
      <DialogHeader><DialogTitle>Recovered operations · {label}</DialogTitle>
        <DialogDescription>Inspect results retained after a connection loss. Reading a result does not acknowledge or repeat the operation.</DialogDescription></DialogHeader>
      <div className="execution-settings-actions"><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>Refresh operations</Button></div>
      {loading ? <p role="status">Loading retained operation state…</p> : null}
      {error ? <p role="alert" className="execution-settings-error">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="execution-recovery-layout">
        <section aria-label="Retained operations" className="execution-settings-list">
          {loaded && receipts.length === 0 ? <p>No retained operations.</p> : null}
          {receipts.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((receipt) => <article key={`${receipt.kind}:${receipt.receiptId}`} className="execution-settings-card">
            <h4>{kindLabels[receipt.kind]} · {stateLabels[receipt.state]}</h4><p>{receipt.summary}</p>
            <p className="execution-settings-muted">Receipt {receipt.receiptId}</p>
            <Button type="button" variant="outline" size="sm" disabled={loading || uncertainAcknowledgment}
              aria-label={`Inspect ${receipt.summary || kindLabels[receipt.kind]}`} onClick={() => void inspect({ kind: receipt.kind, receiptId: receipt.receiptId })}>Inspect</Button>
          </article>)}
          {receipts.length > pageSize ? <div className="execution-settings-actions"><Button type="button" variant="outline" size="sm" disabled={loading || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
            <span>Page {currentPage + 1} of {Math.ceil(receipts.length / pageSize)}</span>
            <Button type="button" variant="outline" size="sm" disabled={loading || (currentPage + 1) * pageSize >= receipts.length} onClick={() => setPage(currentPage + 1)}>Next</Button></div> : null}
        </section>
        <section aria-label="Inspected operation" className="execution-settings-section">
          {inspected ? <>
            <h4>{kindLabels[inspected.kind]} · {stateLabels[inspected.state]}</h4><p>{inspected.summary}</p>
            {inspected.details ? <div><h5>Details</h5><pre>{inspected.details}</pre></div> : null}
            {inspected.stdout ? <div><h5>Standard output</h5><pre>{inspected.stdout}</pre></div> : null}
            {inspected.stderr ? <div><h5>Standard error</h5><pre>{inspected.stderr}</pre></div> : null}
            {inspected.omittedBytes > 0 ? <p>{inspected.omittedBytes.toLocaleString()} output bytes were omitted from this bounded result.</p> : null}
            {inspected.acknowledgeable ? <>
              <p className="execution-settings-muted">Acknowledging releases this retained result. It does not retry the operation or change its effect.</p>
              {inspected.state === "unknown" ? <>
                <p>The operation's effect is unknown. Inspect the affected workspace before releasing this record. Release does not confirm success or undo the operation.</p>
                <Toggle label="I inspected the affected workspace and accept this unknown outcome" checked={unknownReviewed} disabled={loading || uncertainAcknowledgment} onChange={setUnknownReviewed} />
              </> : null}
              {confirmationToken === null ? <p>An acknowledgment confirmation is unavailable. Refresh and inspect the result again.</p> : null}
              <Button type="button" size="sm" variant={inspected.state === "unknown" ? "destructive" : "outline"}
                disabled={loading || uncertainAcknowledgment || confirmationToken === null || (inspected.state === "unknown" && !unknownReviewed)} onClick={() => void acknowledge()}>
                {inspected.state === "unknown" ? "Release inspected unknown outcome" : "Acknowledge and release result"}
              </Button>
            </> : <p>This operation does not have an acknowledgeable final result. It remains retained.</p>}
          </> : <p className="execution-settings-muted">Inspect an operation to review its result before acknowledging it.</p>}
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}
