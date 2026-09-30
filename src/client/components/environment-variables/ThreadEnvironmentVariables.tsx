import { useEffect, useState, type RefObject } from "react";
import type { EnvironmentVariableOverrides, EnvironmentVariablesSnapshot } from "../../../shared/protocol/environment-variables.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogAlert, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { EnvironmentVariablesDialog } from "./EnvironmentVariablesDialog.js";

export function ThreadEnvironmentVariables({ api, threadId, title, onClose, onFork, forkUnavailableReason, returnFocusRef }: {
  readonly api: ApiClient;
  readonly threadId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly onFork: (overrides: EnvironmentVariableOverrides) => void;
  readonly forkUnavailableReason?: string;
  /** Where focus returns when the dialog closes. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [snapshot, setSnapshot] = useState<EnvironmentVariablesSnapshot>();
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [editingFork, setEditingFork] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void api.getThreadEnvironmentVariables(threadId, abort.signal)
      .then(result => { if (!abort.signal.aborted) setSnapshot(result.snapshot); })
      .catch(cause => { if (!abort.signal.aborted) setError(messageFrom(cause)); });
    return () => abort.abort();
  }, [api, threadId, generation]);
  // Loading and load failure use the editor's own frame, so the dialog does
  // not jump from a small card to the full editor.
  if (!snapshot) return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent size="lg" layer="over-dialog" returnFocusRef={returnFocusRef}>
      <DialogHeader>
        <DialogTitle>Environment variables</DialogTitle>
        <DialogDescription>Saved for “{title}”</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {error
          ? <DialogAlert tone="danger" action={<Button type="button" variant="outline" size="sm" onClick={() => setGeneration(current => current + 1)}>Retry</Button>}>{error}</DialogAlert>
          : <p role="status" className="environment-variable-help">Loading saved variables…</p>}
      </DialogBody>
    </DialogContent>
  </Dialog>;
  return <EnvironmentVariablesDialog key={editingFork ? "fork" : "inspect"} open onOpenChange={next => { if (!next) onClose(); }} snapshot={snapshot}
    description={editingFork ? "Change variables for a new fork. The source thread stays unchanged." : `Saved for “${title}”`}
    readOnly={!editingFork} onFork={() => setEditingFork(true)} forkUnavailableReason={forkUnavailableReason}
    onApply={value => onFork(value)} returnFocusRef={returnFocusRef} />;
}
