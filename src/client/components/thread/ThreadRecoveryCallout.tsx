import type {
  NormalizedThreadRecovery,
  ThreadOperationDescriptor,
} from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";

export function ThreadRecoveryCallout({
  recovery,
  operation,
  pending,
  onRecover,
}: {
  readonly recovery: NormalizedThreadRecovery;
  readonly operation?: ThreadOperationDescriptor;
  readonly pending: boolean;
  readonly onRecover: () => void;
}): React.JSX.Element {
  const creation = recovery.kind === "conversation_creation";
  const forkCreation = creation && recovery.creationType === "fork";
  return (
    <div className="materialization-recovery" role="alert">
      <strong>
        {forkCreation
          ? "Fork creation needs attention."
          : creation
          ? "Submission status needs attention."
          : "Operation status needs attention."}
      </strong>
      <p>{recovery.diagnostic.text}</p>
      {forkCreation && recovery.forkUncertainty === "fork_unknown" && (
        <small>
          The provider may already have created a child. Reconcile this fork
          before trying to create another one.
        </small>
      )}
      {forkCreation && recovery.possibleProviderOrphan && (
        <small>
          A provider child may exist without a completed Sedes binding.
        </small>
      )}
      {!forkCreation && recovery.submissionMayHaveBeenAccepted && (
        <small>The backend may already have accepted this prompt.</small>
      )}
      {operation?.available && (
        <Button variant="secondary" size="sm" disabled={pending} onClick={onRecover}>
          {operation.label.text}
        </Button>
      )}
    </div>
  );
}
