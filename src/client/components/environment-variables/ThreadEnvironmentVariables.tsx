import { useEffect, useState } from "react";
import type { EnvironmentVariableOverrides, EnvironmentVariablesSnapshot } from "../../../shared/protocol/environment-variables.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog.js";
import { EnvironmentVariablesDialog } from "./EnvironmentVariablesDialog.js";

export function ThreadEnvironmentVariables({ api, threadId, title, onClose, onFork, forkUnavailableReason, restoreFocus }: {
  readonly api: ApiClient;
  readonly threadId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly onFork: (overrides: EnvironmentVariableOverrides) => void;
  readonly forkUnavailableReason?: string;
  readonly restoreFocus: () => void;
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
  if (!snapshot) return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}><DialogTitle>Environment variables</DialogTitle><DialogDescription>Saved for “{title}”</DialogDescription>
      {error ? <><p role="alert">{error}</p><Button onClick={() => setGeneration(current => current + 1)}>Retry</Button></> : <p role="status">Loading saved variables…</p>}
    </DialogContent>
  </Dialog>;
  return <EnvironmentVariablesDialog key={editingFork ? "fork" : "inspect"} open onOpenChange={next => { if (!next) onClose(); }} snapshot={snapshot}
    description={editingFork ? "Change variables for a new fork. The source thread stays unchanged." : `Saved for “${title}”`}
    readOnly={!editingFork} onFork={() => setEditingFork(true)} forkUnavailableReason={forkUnavailableReason}
    onApply={value => onFork(value)} restoreFocus={restoreFocus} />;
}
