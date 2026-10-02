import { useMemo, useState } from "react";
import { FolderPlus } from "lucide-react";
import {
  MAXIMUM_PROJECT_NAME_LENGTH,
  projectNameInputSchema,
  type LocationConflict,
  type NormalizedEnvironmentSummary,
  type NormalizedProjectSummary,
  type NormalizedWorkspaceSummary,
  type OpenWorkspaceResult,
  type ProjectAssignment,
} from "../../shared/index.js";
import { LocationConflictApiError } from "../api/ApiClient.js";
import { describeProjectLocations } from "../app/project-locations.js";
import { messageFrom, type ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog.js";
import { Button } from "./ui/button.js";
import { DialogAlert } from "./ui/dialog.js";
import { Field } from "./ui/field.js";
import { Input } from "./ui/input.js";
import { SearchableSelect } from "./ui/searchable-select.js";

/** The project choice that creates a new project; project IDs are UUIDs. */
export const NEW_PROJECT = "new";

/** The last path segment, which names a new project by default. */
function directoryName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || path;
}

/**
 * Preselects an existing project only when it is surely the same one: the
 * one active project named like the folder, with no location on this
 * environment yet (the same repository on another host). A wrong join is
 * lossy, so anything else starts a new project.
 */
export function preselectedProjectId(
  catalog: {
    readonly projects: readonly Pick<NormalizedProjectSummary, "id" | "name">[];
    readonly workspaces: readonly Pick<NormalizedWorkspaceSummary, "projectId" | "environmentId">[];
  },
  folder: string,
  environmentId: string,
): string {
  const named = catalog.projects.filter(({ name }) => name === folder);
  const [candidate] = named;
  return named.length === 1 && candidate && !catalog.workspaces.some(
    (workspace) => workspace.projectId === candidate.id && workspace.environmentId === environmentId,
  ) ? candidate.id : NEW_PROJECT;
}

/**
 * A conflict and the directory it was reported for. Its actions act on that
 * directory's location, so they are offered only while it is on display.
 */
interface ReportedConflict {
  readonly conflict: LocationConflict;
  readonly environmentId: string;
  readonly path: string;
}

/**
 * Adds a directory as a location of a new or an existing project. Projects
 * are principal-owned; adding a location never changes root grants. A
 * directory that is already a location keeps its project unless the user
 * moves it here, and one in a removed project offers to restore it.
 */
export function AddProjectDialog({
  store,
  environments,
  projects,
  workspaces,
  initialEnvironmentId,
  environmentLocked = false,
  projectId: fixedProjectId,
  onAdded,
  onClose,
}: {
  readonly store: Pick<ApplicationClientStore, "api" | "openWorkspace" | "reopenWorkspace">;
  readonly environments: readonly NormalizedEnvironmentSummary[];
  /** Active projects and their active locations, as the snapshot carries them. */
  readonly projects: readonly NormalizedProjectSummary[];
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
  readonly initialEnvironmentId?: string;
  readonly environmentLocked?: boolean;
  /** Adds a location to this project; the project cannot be changed. */
  readonly projectId?: string;
  /** The location and the project it is in once the dialog's action commits. */
  readonly onAdded: (added: OpenWorkspaceResult, environmentId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [environmentId, setEnvironmentId] = useState(
    initialEnvironmentId && (environmentLocked || environments.some(({ id }) => id === initialEnvironmentId))
      ? initialEnvironmentId : environments.length === 1 ? environments[0]!.id : "",
  );
  const [path, setPath] = useState("");
  // Undefined until the user chooses, so the choice follows the directory.
  const [chosenProjectId, setChosenProjectId] = useState<string>();
  const [editedName, setEditedName] = useState<string>();
  const [reported, setReported] = useState<ReportedConflict>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const projectLocations = useMemo(
    () => describeProjectLocations({ projects, workspaces, environments }),
    [projects, workspaces, environments],
  );
  const directory = path.trim();
  const folder = directory ? directoryName(directory) : "";
  const fixedProject = fixedProjectId === undefined
    ? undefined : projects.find(({ id }) => id === fixedProjectId);
  const selectedProjectId = fixedProjectId
    ?? chosenProjectId
    ?? preselectedProjectId({ projects, workspaces }, folder, environmentId);
  const selectedProject = projects.find(({ id }) => id === selectedProjectId);
  const newName = editedName ?? folder;
  const nameValid = projectNameInputSchema.safeParse(newName).success;
  const assignment = (): ProjectAssignment | undefined =>
    selectedProjectId === NEW_PROJECT
      ? nameValid ? { kind: "new", name: newName.trim() } : undefined
      : { kind: "existing", projectId: selectedProjectId };
  const destination = selectedProjectId === NEW_PROJECT
    ? `a new project “${newName.trim() || folder}”`
    : `“${selectedProject ? projectLocations.projectLabel(selectedProject.id) ?? selectedProject.name : "this project"}”`;
  // A response to an earlier directory or environment never exposes its actions here.
  const conflict = reported?.environmentId === environmentId && reported.path === directory
    ? reported.conflict : undefined;
  const reset = () => { setReported(undefined); setError(""); };

  /** Runs an operation for the directory on display, which stays chosen until it settles. */
  const run = async (operation: () => Promise<OpenWorkspaceResult | undefined>) => {
    if (pending) return;
    const submitted = { environmentId, path: directory };
    setPending(true);
    setError("");
    try {
      const added = await operation();
      if (added !== undefined) {
        onAdded(added, submitted.environmentId);
        onClose();
      }
    } catch (cause) {
      if (cause instanceof LocationConflictApiError) setReported({ conflict: cause.conflict, ...submitted });
      else setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };
  const add = () => {
    if (!environmentId || !directory) return;
    const target = assignment();
    if (!target) {
      setError(`Enter a project name of 1 to ${MAXIMUM_PROJECT_NAME_LENGTH} characters.`);
      return;
    }
    setReported(undefined);
    void run(() => store.openWorkspace(directory, environmentId, target));
  };
  /** Moves the existing location into the chosen project, restoring it if removed. */
  const moveHere = (existing: LocationConflict) => {
    const target = assignment();
    if (!target) {
      setError(`Enter a project name of 1 to ${MAXIMUM_PROJECT_NAME_LENGTH} characters.`);
      return;
    }
    void run(async () => {
      const project = await store.api.moveLocation(existing.workspaceId, { target, expectedRevision: existing.locationRevision });
      setReported(undefined);
      return existing.locationRemoved
        ? store.reopenWorkspace(existing.workspaceId)
        : { id: existing.workspaceId, projectId: project.id };
    });
  };
  const restoreInOwnProject = (existing: LocationConflict) =>
    void run(() => store.reopenWorkspace(existing.workspaceId));
  const restoreProject = (existing: LocationConflict) => void run(async () => {
    const restored = await store.api.restoreProject(existing.projectId, {
      expectedRevision: existing.projectRevision,
      locationIds: [existing.workspaceId],
    });
    setReported(undefined);
    const location = restored.locations[0];
    if (location?.status === "failed") {
      setError(`Restored project “${existing.projectName}”, but not this location: ${location.error.message}`);
      return undefined;
    }
    return { id: existing.workspaceId, projectId: existing.projectId };
  });

  const conflictAlert = conflict ? <ConflictAlert conflict={conflict} destination={destination} pending={pending}
    onMoveHere={() => moveHere(conflict)} onRestoreLocation={() => restoreInOwnProject(conflict)}
    onRestoreProject={() => restoreProject(conflict)} /> : null;

  return <DirectoryPickerDialog open onOpenChange={(open) => { if (!open) onClose(); }}
    title={fixedProjectId === undefined ? "Add project" : "Add location"}
    description={fixedProjectId === undefined
      ? "Choose a directory or enter its absolute path, then choose the project it belongs to."
      : `Choose a directory or enter its absolute path to add to “${fixedProject?.name ?? "this project"}”.`}
    environments={environments} environmentId={environmentId} environmentLocked={environmentLocked}
    onEnvironmentChange={(id) => { setEnvironmentId(id); reset(); }}
    path={path} onPathChange={(next) => { setPath(next); reset(); }} api={store.api}
    submitLabel={fixedProjectId === undefined ? "Add project" : "Add location"}
    submitting={pending} submitError={error} onSubmit={add}>
    {fixedProjectId !== undefined ? <Field label="Project">
      <Input aria-label="Project" readOnly
        value={fixedProject ? projectLocations.projectLabel(fixedProject.id) ?? fixedProject.name : "Unavailable project"} />
    </Field> : <>
      <Field label="Project">
        <SearchableSelect label="Project" searchLabel="Search projects" emptyLabel="No matching projects"
          disabled={pending} value={selectedProjectId}
          options={[
            { value: NEW_PROJECT, label: "New project", icon: <FolderPlus size={14} />, pinned: true },
            ...[...projects]
              .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
              .map((project) => {
                const choice = projectLocations.projectChoice(project.id);
                return {
                  value: project.id,
                  label: choice?.label ?? project.name,
                  ...(choice ? { title: choice.title } : {}),
                  searchTerms: projectLocations.locationsOf(project.id).flatMap((location) => [
                    location.label.text, location.displayPath.text,
                  ]),
                };
              }),
          ]}
          onValueChange={(value) => { setChosenProjectId(value); reset(); }} />
      </Field>
      {selectedProjectId === NEW_PROJECT ? <Field label="New project name"
        error={newName && !nameValid ? `Use 1 to ${MAXIMUM_PROJECT_NAME_LENGTH} characters.` : undefined}>
        <Input aria-label="New project name" value={newName} disabled={pending} placeholder={folder || "Project name"}
          onChange={(event) => { setEditedName(event.target.value); reset(); }} />
      </Field> : null}
    </>}
    {conflictAlert}
  </DirectoryPickerDialog>;
}

/** The existing location the directory resolved to, with what can be done about it. */
function ConflictAlert({ conflict, destination, pending, onMoveHere, onRestoreLocation, onRestoreProject }: {
  readonly conflict: LocationConflict;
  /** Where "Move here" and "Add to another project" put the location. */
  readonly destination: string;
  readonly pending: boolean;
  readonly onMoveHere: () => void;
  readonly onRestoreLocation: () => void;
  readonly onRestoreProject: () => void;
}): React.JSX.Element {
  const name = `“${conflict.projectName}”`;
  if (conflict.reason === "project_removed") {
    return <DialogAlert tone="warning" role="alert" title={`Project ${name} was removed`}
      action={<span className="add-project-conflict-actions">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRestoreProject}>Restore project {name}</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onMoveHere}>Add to another project</Button>
      </span>}>
      This directory is a location of the removed project {name}. Restore that project with this location, or
      add the directory to {destination} instead.
    </DialogAlert>;
  }
  return <DialogAlert tone="warning" role="alert"
    title={conflict.locationRemoved ? `Removed from project ${name}` : `Already in project ${name}`}
    action={<span className="add-project-conflict-actions">
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onMoveHere}>Move here</Button>
      {conflict.locationRemoved ? <Button type="button" size="sm" variant="outline" disabled={pending}
        onClick={onRestoreLocation}>Restore in {name}</Button> : null}
    </span>}>
    {conflict.locationRemoved
      ? <>This directory is a removed location of {name}. Move it to {destination} and restore it there, or restore it in {name}.</>
      : <>This directory is a location of {name}. Move it to {destination}; its threads, tasks, and workpads move with it.</>}
  </DialogAlert>;
}
