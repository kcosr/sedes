import { useEffect, useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  FolderGit2,
  RotateCw,
  Trash2,
} from "lucide-react";
import type { ThreadExecutionWorkspaceResource } from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { menuDescriptionClass } from "@client/components/ui/floating";
import { cn } from "@client/lib/utils";
import type { IsolatedWorkspace } from "./ExecutionWorkspaceActions.js";
import type { MenuParts } from "./menu-parts.js";

/** A non-focusable status line inside a menu: results, warnings, errors. */
function MenuNote({
  tone = "neutral",
  children,
}: {
  readonly tone?: "neutral" | "danger";
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        menuDescriptionClass,
        "m-0 px-2 py-1.5",
        tone === "danger" && "text-destructive",
      )}
    >
      {children}
    </p>
  );
}

/**
 * The isolated-workspace actions as real menu rows: an "Isolated workspace"
 * submenu (a drill-in on touch) with copy, import and retain, then the
 * irreversible delete after a separator. Results and failures stay visible
 * in the submenu; deletion is confirmed by the owning surface.
 */
export function ExecutionWorkspaceMenu({
  parts,
  threadId,
  store,
  active,
  disabled = false,
  knownDirect = false,
  onRequestDelete,
}: {
  readonly parts: MenuParts;
  readonly threadId: string;
  readonly store: ApplicationClientStore;
  /** The owning menu is open; the workspace is (re)loaded on each opening. */
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly knownDirect?: boolean;
  readonly onRequestDelete: (workspace: IsolatedWorkspace) => void;
}): React.JSX.Element | null {
  const { Item, Separator, Shortcut, Sub, SubContent, SubTrigger, ItemDescription } =
    parts;
  const [workspace, setWorkspace] =
    useState<ThreadExecutionWorkspaceResource>();
  const [pending, setPending] = useState<"copy" | "import" | "handoff">();
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
    if (!active) return;
    setMessage("");
    if (!knownDirect) void load();
    // Reload only when the owning menu opens or the thread changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, knownDirect, threadId]);

  if (!active || knownDirect || workspace?.kind === "direct") return null;
  if (!workspace) {
    if (!error) return null;
    return (
      <Item
        onSelect={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <RotateCw aria-hidden="true" />
        <span className="min-w-0 flex-1">
          Retry workspace details
          <ItemDescription>
            <span role="alert">Workspace details unavailable. {error}</span>
          </ItemDescription>
        </span>
      </Item>
    );
  }

  const isolated = workspace;
  const mutable = isolated.state === "ready" || isolated.state === "retained";
  const deleteEligible =
    mutable ||
    isolated.state === "deletion_failed" ||
    isolated.state === "provisioning_failed";
  const busy = disabled || Boolean(pending);
  const run = (
    action: "copy" | "import" | "handoff",
    operation: () => Promise<string>,
  ) => {
    setPending(action);
    setError("");
    setMessage("");
    void operation()
      .then(setMessage)
      .catch((cause: unknown) => setError(messageFrom(cause)))
      .finally(() => setPending(undefined));
  };
  // Keep the submenu open so the result of the action stays readable.
  const keepOpen = (action: () => void) => (event: Event) => {
    event.preventDefault();
    action();
  };
  // The short reason is visual; the row's title carries the full one.
  const unavailableShortcut = !mutable ? (
    <Shortcut aria-hidden="true">Unavailable</Shortcut>
  ) : null;
  const unavailableTitle = !mutable
    ? "Unavailable while the isolated workspace is not ready"
    : undefined;

  return (
    <Sub>
      <SubTrigger>
        <FolderGit2 aria-hidden="true" />
        Isolated workspace
      </SubTrigger>
      <SubContent>
        <Item
          disabled={busy}
          onSelect={keepOpen(() =>
            run("copy", async () => {
              const clipboard = navigator.clipboard;
              if (typeof clipboard?.writeText !== "function") {
                throw new Error("Clipboard access is unavailable.");
              }
              await clipboard.writeText(isolated.hostPaths.workspace);
              return "Workspace path copied.";
            }),
          )}
        >
          <Copy aria-hidden="true" />
          Copy workspace path
        </Item>
        {isolated.workspaceAccess === "writable_clone" && (
          <>
            <Item
              disabled={busy || !mutable}
              title={unavailableTitle}
              onSelect={keepOpen(() =>
                run("import", async () => {
                  const result = await store.importThreadExecutionWorkspace(
                    threadId,
                    isolated.allocationRevision,
                  );
                  return `Imported ${result.branch} at ${result.headOid.slice(0, 8)} into ${result.sourceRepositoryPath}.`;
                }),
              )}
            >
              <Download aria-hidden="true" />
              Import branch
              {unavailableShortcut}
            </Item>
            <Item
              disabled={busy || !mutable}
              title={unavailableTitle}
              onSelect={keepOpen(() =>
                run("handoff", async () => {
                  const result = await store.handoffThreadExecutionWorkspace(
                    threadId,
                    isolated.allocationRevision,
                  );
                  await load();
                  return `Retained ${result.branch} at ${result.workspacePath}.`;
                }),
              )}
            >
              <ExternalLink aria-hidden="true" />
              Retain for outside use
              {unavailableShortcut}
            </Item>
          </>
        )}
        <Separator />
        <Item
          variant="destructive"
          disabled={busy || !deleteEligible}
          onSelect={() => onRequestDelete(isolated)}
        >
          <Trash2 aria-hidden="true" />
          {isolated.state === "deletion_failed"
            ? "Retry deleting isolated workspace…"
            : "Delete isolated workspace…"}
          {!deleteEligible && <Shortcut aria-hidden="true">Unavailable</Shortcut>}
        </Item>
        {isolated.state === "deletion_failed" && (
          <MenuNote tone="danger">
            The previous deletion failed. Review the deletion details and retry.
          </MenuNote>
        )}
        {isolated.state === "provisioning_failed" && (
          <MenuNote tone="danger">
            Provisioning failed. You can delete the incomplete workspace.
          </MenuNote>
        )}
        {message && <MenuNote>{message}</MenuNote>}
        {error && <MenuNote tone="danger">{error}</MenuNote>}
      </SubContent>
    </Sub>
  );
}
