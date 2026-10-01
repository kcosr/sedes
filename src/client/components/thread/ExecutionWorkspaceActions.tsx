import type { ThreadExecutionWorkspaceResource } from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import "./archive-choices.css";

export type IsolatedWorkspace = Extract<
  ThreadExecutionWorkspaceResource,
  { kind: "isolated" }
>;

export function ExecutionWorkspaceGitWarnings({
  workspace,
}: {
  readonly workspace: IsolatedWorkspace;
}): React.JSX.Element {
  if (workspace.workspaceAccess === "read_only") {
    return (
      <p className="archive-choice-note" role="status">
        The original project is mounted read-only and will not be deleted. The
        private writable home and its data will be permanently deleted.
      </p>
    );
  }
  const status = workspace.gitStatus;
  const warnings = status.available
    ? [
        status.trackedChangeCount > 0
          ? `${status.trackedChangeCount} tracked ${status.trackedChangeCount === 1 ? "change is" : "changes are"} not committed.`
          : undefined,
        status.untrackedFileCount > 0
          ? `${status.untrackedFileCount} untracked ${status.untrackedFileCount === 1 ? "file will" : "files will"} be deleted.`
          : undefined,
        status.upstream === null
          ? "No upstream is configured; unpushed work cannot be verified."
          : status.aheadCount === null
            ? "Unpushed commits could not be verified."
            : status.aheadCount > 0
              ? `${status.aheadCount} unpushed ${status.aheadCount === 1 ? "commit will" : "commits will"} be deleted.`
              : undefined,
      ].filter((warning): warning is string => warning !== undefined)
    : [`Git safety checks are unavailable: ${status.reason}`];
  if (warnings.length === 0) {
    return (
      <p className="archive-choice-note" role="status">
        Git reports no local or unpushed work.
      </p>
    );
  }
  return (
    <Callout tone="warning">
      <ul
        className="execution-workspace-git-warnings"
        aria-label="Git warnings"
      >
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </Callout>
  );
}

export function ExecutionWorkspaceDeleteDialog({
  workspace,
  open,
  onOpenChange,
  pending,
  error,
  onDelete,
  returnFocusRef,
}: {
  readonly workspace: IsolatedWorkspace | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly error?: string;
  readonly onDelete: () => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  // The confirm anatomy (ConfirmDialog's), with the mutation state owned by
  // the caller: the thread header and context menu keep the dialog open
  // across a failed delete and show the error here.
  return (
    <Dialog
      open={open && workspace !== undefined}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      {workspace && (
        <DialogContent
          layer="over-dialog"
          showClose={false}
          dismissible={!pending}
          aria-busy={pending || undefined}
          returnFocusRef={returnFocusRef}
        >
          <DialogHeader>
            <DialogTitle>Delete isolated workspace?</DialogTitle>
            <DialogDescription>
              {workspace.workspaceAccess === "read_only"
                ? `This permanently deletes the private writable home at ${workspace.hostPaths.home}. The read-only project at ${workspace.hostPaths.workspace} is not deleted.`
                : `This permanently deletes the workspace at ${workspace.hostPaths.workspace}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ExecutionWorkspaceGitWarnings workspace={workspace} />
            {error && <DialogAlert tone="danger">{error}</DialogAlert>}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={onDelete}
            >
              {pending ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
