import { useState } from "react";
import type { NormalizedEnvironmentSummary } from "../../shared/index.js";
import { messageFrom, type ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog.js";

/** The last path segment, which names a new project; a known directory keeps its project. */
function directoryName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || path;
}

/** Projects are principal-owned remembered directories; adding one never changes root grants. */
export function AddProjectDialog({ store, environments, initialEnvironmentId, environmentLocked = false, onAdded, onClose }: {
  readonly store: Pick<ApplicationClientStore, "api" | "openWorkspace">;
  readonly environments: readonly NormalizedEnvironmentSummary[];
  readonly initialEnvironmentId?: string;
  readonly environmentLocked?: boolean;
  readonly onAdded: (workspaceId: string, environmentId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [environmentId, setEnvironmentId] = useState(
    initialEnvironmentId && (environmentLocked || environments.some(({ id }) => id === initialEnvironmentId))
      ? initialEnvironmentId : environments.length === 1 ? environments[0]!.id : "",
  );
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    if (pending || !environmentId || !path.trim()) return;
    setPending(true);
    setError("");
    try {
      const directory = path.trim();
      const id = await store.openWorkspace(directory, environmentId, { kind: "new", name: directoryName(directory) });
      onAdded(id, environmentId);
      onClose();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };
  return <DirectoryPickerDialog open onOpenChange={(open) => { if (!open) onClose(); }}
    title="Add project" description="Choose an existing directory to remember as a project, or enter its absolute path."
    environments={environments} environmentId={environmentId} environmentLocked={environmentLocked}
    onEnvironmentChange={(id) => { setEnvironmentId(id); setError(""); }}
    path={path} onPathChange={setPath} api={store.api}
    submitLabel="Add project" submitting={pending} submitError={error} onSubmit={add} />;
}
