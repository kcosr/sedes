import { useState } from "react";
import type { NormalizedEnvironmentSummary } from "../../shared/index.js";
import { messageFrom, type ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog.js";

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
      const id = await store.openWorkspace(path.trim(), environmentId);
      onAdded(id, environmentId);
      onClose();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };
  return <DirectoryPickerDialog open mobileSheet onOpenChange={(open) => { if (!open) onClose(); }}
    title="Add project" description="Choose an existing directory to remember as a project, or enter its absolute path."
    environments={environments} environmentId={environmentId} environmentLocked={environmentLocked}
    onEnvironmentChange={(id) => { setEnvironmentId(id); setError(""); }}
    path={path} onPathChange={setPath} api={store.api}
    submitLabel="Add project" submitting={pending} submitError={error} onSubmit={add} />;
}
