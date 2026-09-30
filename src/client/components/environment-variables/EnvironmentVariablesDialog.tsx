import { useState, type ReactNode } from "react";
import type { EnvironmentVariableOverrides, EnvironmentVariablesSnapshot } from "../../../shared/protocol/environment-variables.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogAlert, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogSection, DialogTitle } from "../ui/dialog.js";
import { EnvironmentVariableEditor } from "./EnvironmentVariableEditor.js";

export function EnvironmentVariablesDialog({ open, onOpenChange, snapshot, description, context, readOnly = false, onApply, onFork, forkUnavailableReason, pending = false, error, startupReason, restoreFocus }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly snapshot: EnvironmentVariablesSnapshot;
  readonly description: string;
  readonly context?: ReactNode;
  readonly readOnly?: boolean;
  readonly onApply?: (value: EnvironmentVariableOverrides) => void;
  readonly onFork?: () => void;
  readonly forkUnavailableReason?: string;
  readonly pending?: boolean;
  readonly error?: string;
  readonly startupReason?: string;
  readonly restoreFocus?: () => void;
}) {
  // The parent mounts a fresh dialog for every edit transaction. Cancel never
  // changes the caller's draft, including a previously accepted override map.
  const [draft, setDraft] = useState(snapshot.layers.thread);
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    <DialogContent size="lg" layer="over-dialog" dismissible={!pending} onCloseAutoFocus={event => { if (restoreFocus) { event.preventDefault(); restoreFocus(); } }}>
      <DialogHeader>
        <DialogTitle>Environment variables</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {context}
        {readOnly && <DialogAlert>Saved at creation. Changes to defaults do not change this thread. Secret references are resolved on the execution host.</DialogAlert>}
        <EnvironmentVariableEditor scope="thread" inherited={[
          { scope: "environment", values: snapshot.layers.environment },
          { scope: "backend", values: snapshot.layers.backend },
          { scope: "agent", values: snapshot.layers.agent },
        ]} value={readOnly ? snapshot.layers.thread : draft} onChange={setDraft} readOnly={readOnly} disabled={pending} />
        <DialogSection title="Backend startup settings">
          <p className="environment-variable-help">{startupReason ?? "Managed in environment and backend Settings. Startup values cannot be changed for an individual thread."}</p>
        </DialogSection>
        {forkUnavailableReason && <p className="environment-variable-help">{forkUnavailableReason}</p>}
        {error && <DialogAlert tone="danger">{error}</DialogAlert>}
      </DialogBody>
      {readOnly ? <DialogFooter start={onFork ? <Button type="button" variant="outline" disabled={pending || Boolean(forkUnavailableReason)} onClick={onFork}>Fork with changes…</Button> : undefined}>
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
        : <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => onApply?.(draft)}>{pending ? "Creating fork…" : onFork ? "Create fork" : "Use these values"}</Button>
        </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
