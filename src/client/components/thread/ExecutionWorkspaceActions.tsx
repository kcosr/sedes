import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, Trash2, X } from "lucide-react";
import type { ThreadExecutionWorkspaceResource } from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Button } from "@client/components/ui/button";

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
      <p role="status">
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
    return <p role="status">Git reports no local or unpushed work.</p>;
  }
  return (
    <ul className="execution-workspace-git-warnings" aria-label="Git warnings">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay over-drawer" />
        {workspace && (
          <Dialog.Content
            className="dialog-card over-drawer"
            onCloseAutoFocus={(event) => {
              const target = returnFocusRef?.current;
              if (!target?.isConnected) return;
              event.preventDefault();
              target.focus();
            }}
          >
            <Dialog.Title>Delete isolated workspace?</Dialog.Title>
            <Dialog.Description>
              {workspace.workspaceAccess === "read_only"
                ? `This permanently deletes the private writable home at ${workspace.hostPaths.home}. The read-only project at ${workspace.hostPaths.workspace} is not deleted.`
                : `This permanently deletes the workspace at ${workspace.hostPaths.workspace}.`}
            </Dialog.Description>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="dialog-close"
                aria-label="Close"
              >
                <X size={18} strokeWidth={1.8} />
              </Button>
            </Dialog.Close>
            <ExecutionWorkspaceGitWarnings workspace={workspace} />
            {error && (
              <p className="menu-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={onDelete}
              >
                {pending ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ExecutionWorkspaceActions({
  threadId,
  store,
  active,
  disabled = false,
  knownDirect = false,
  onRequestDelete,
}: {
  readonly threadId: string;
  readonly store: ApplicationClientStore;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly knownDirect?: boolean;
  /** Lets an owning surface host deletion confirmation outside transient UI. */
  readonly onRequestDelete?: (workspace: IsolatedWorkspace) => void;
}): React.JSX.Element | null {
  const [workspace, setWorkspace] =
    useState<ThreadExecutionWorkspaceResource>();
  const [pending, setPending] = useState<
    "copy" | "import" | "handoff" | "delete"
  >();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      setWorkspace(await store.getThreadExecutionWorkspace(threadId));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };

  useEffect(() => {
    if (active && !knownDirect) void load();
    // Reload only when the owning menu opens or the thread changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, knownDirect, threadId]);

  if (!active || knownDirect || workspace?.kind === "direct") return null;
  if (!workspace) {
    return error ? (
      <p className="menu-error" role="alert">
        Workspace details unavailable. {error}{" "}
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </p>
    ) : null;
  }

  const mutable = workspace.state === "ready" || workspace.state === "retained";
  const deleteEligible =
    mutable ||
    workspace.state === "deletion_failed" ||
    workspace.state === "provisioning_failed";
  const perform = async (
    action: "import" | "handoff" | "delete",
  ): Promise<void> => {
    setPending(action);
    setError("");
    setMessage("");
    try {
      if (action === "import") {
        const result = await store.importThreadExecutionWorkspace(
          threadId,
          workspace.allocationRevision,
        );
        setMessage(
          `Imported ${result.branch} at ${result.headOid.slice(0, 8)} into ${result.sourceRepositoryPath}.`,
        );
      } else if (action === "handoff") {
        const result = await store.handoffThreadExecutionWorkspace(
          threadId,
          workspace.allocationRevision,
        );
        setMessage(`Retained ${result.branch} at ${result.workspacePath}.`);
        await load();
      } else {
        await store.deleteThreadExecutionWorkspace(
          threadId,
          workspace.allocationRevision,
        );
        setDeleteOpen(false);
        setMessage("Isolated workspace deleted.");
        await load();
      }
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <section
      className="execution-workspace-actions"
      aria-label="Isolated workspace"
    >
      <p className="menu-label">Isolated workspace</p>
      <Button
        variant="ghost"
        disabled={disabled || Boolean(pending)}
        onClick={() => {
          setPending("copy");
          setError("");
          setMessage("");
          void (async () => {
            try {
              const clipboard = navigator.clipboard;
              if (typeof clipboard?.writeText !== "function") {
                throw new Error("Clipboard access is unavailable.");
              }
              await clipboard.writeText(workspace.hostPaths.workspace);
              setMessage("Workspace path copied.");
            } catch (cause) {
              setError(messageFrom(cause));
            } finally {
              setPending(undefined);
            }
          })();
        }}
      >
        <Copy size={18} strokeWidth={1.8} /> Copy workspace path
      </Button>
      {workspace.workspaceAccess === "writable_clone" && (
        <>
          <Button
            variant="ghost"
            disabled={disabled || !mutable || Boolean(pending)}
            onClick={() => void perform("import")}
          >
            <Download size={18} strokeWidth={1.8} /> Import branch
          </Button>
          <Button
            variant="ghost"
            disabled={disabled || !mutable || Boolean(pending)}
            onClick={() => void perform("handoff")}
          >
            <ExternalLink size={18} strokeWidth={1.8} /> Retain for outside use
          </Button>
        </>
      )}
      <Button
        variant="destructive"
        className="danger"
        disabled={disabled || !deleteEligible || Boolean(pending)}
        onClick={() =>
          onRequestDelete ? onRequestDelete(workspace) : setDeleteOpen(true)
        }
      >
        <Trash2 size={18} strokeWidth={1.8} />{" "}
        {workspace.state === "deletion_failed"
          ? "Retry deleting isolated workspace…"
          : "Delete isolated workspace…"}
      </Button>
      {workspace.state === "deletion_failed" && (
        <p className="menu-error" role="alert">
          The previous deletion failed. Review the deletion details and retry.
        </p>
      )}
      {workspace.state === "provisioning_failed" && (
        <p className="menu-error" role="alert">
          Provisioning failed. You can delete the incomplete workspace.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="menu-error" role="alert">
          {error}
        </p>
      )}
      {!onRequestDelete && (
        <ExecutionWorkspaceDeleteDialog
          workspace={workspace}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          pending={pending === "delete"}
          error={error}
          onDelete={() => void perform("delete")}
        />
      )}
    </section>
  );
}
