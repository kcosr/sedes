import { useState } from "react";
import type {
  NormalizedThreadRecovery,
  ThreadOperationDescriptor,
} from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";

export function ThreadRecoveryCallout({
  recovery,
  operation,
  discardOperation,
  pending,
  onRecover,
  onDiscard,
}: {
  readonly recovery: NormalizedThreadRecovery;
  readonly operation?: ThreadOperationDescriptor;
  /** Removes an unfinished fork child without another provider call. */
  readonly discardOperation?: ThreadOperationDescriptor;
  readonly pending: boolean;
  readonly onRecover: () => void;
  readonly onDiscard?: () => void;
}): React.JSX.Element {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const creation = recovery.kind === "conversation_creation";
  const forkCreation = creation && recovery.creationType === "fork";
  // The server refuses to discard a fork whose child the provider returned.
  const canDiscard =
    forkCreation &&
    !recovery.conversationIdentified &&
    discardOperation?.available === true &&
    onDiscard !== undefined;
  // Discovery never imports an application-reserved child after a discard; a
  // provider-assigned (or unrecorded) child identity carries no such promise.
  const discardedCopyDisposition =
    forkCreation && recovery.forkChildIdentity === "application_reserved"
      ? "Anything the provider already copied is left untouched and never imported as a thread."
      : "Anything the provider already copied is left untouched and may later appear as a separate thread.";
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
      {confirmingDiscard ? (
        <div className="materialization-recovery-confirm">
          <small>
            Discard removes this fork thread. {discardedCopyDisposition}
          </small>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              setConfirmingDiscard(false);
              onDiscard?.();
            }}
          >
            Discard fork
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => setConfirmingDiscard(false)}
          >
            Keep it
          </Button>
        </div>
      ) : (
        (operation?.available || canDiscard) && (
          <div className="materialization-recovery-actions">
            {operation?.available && (
              <Button variant="secondary" size="sm" disabled={pending} onClick={onRecover}>
                {operation.label.text}
              </Button>
            )}
            {canDiscard && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setConfirmingDiscard(true)}
              >
                {discardOperation.label.text}
              </Button>
            )}
          </div>
        )
      )}
    </div>
  );
}
