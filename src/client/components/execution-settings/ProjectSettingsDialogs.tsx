import { useState } from "react";
import { FolderPlus } from "lucide-react";
import {
  MAXIMUM_PROJECT_NAME_LENGTH,
  projectNameInputSchema,
  type ProjectAssignment,
  type ProjectLocation,
  type ProjectRemovalBlocker,
  type ProjectSummary,
  type RestoredLocationResult,
} from "../../../shared/index.js";
import { ProjectRemovalBlockedApiError } from "../../api/ApiClient.js";
import { messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { Button } from "../ui/button.js";
import { Checkbox } from "../ui/checkbox.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { SearchableSelect } from "../ui/searchable-select.js";
import { StatusPill } from "../ui/status-pill.js";
import { countLabel } from "./ExecutionInventory.js";
import {
  BLOCKER_ACTIONS,
  describeBlockedThreads,
  groupBlockersByLocation,
} from "./projects-settings-model.js";

/** What every project dialog needs from the page. */
export interface ProjectDialogContext {
  readonly api: Pick<ApplicationClientStore["api"],
    "renameProject" | "removeProject" | "restoreProject" | "mergeProject" | "removeLocation" | "moveLocation">;
  /** Every listed project, removed ones included. */
  readonly projects: readonly ProjectSummary[];
  /** A project described by its hosts, for pickers. */
  readonly projectChoice: (project: ProjectSummary) => { readonly label: string; readonly title?: string };
  readonly environmentLabel: (location: ProjectLocation) => string;
  readonly environmentAvailable: (environmentId: string) => boolean;
  readonly threadTitle: (threadId: string) => string | undefined;
  /** Reloads the list after every attempt, successful or not. */
  readonly refresh: () => Promise<void>;
}

interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly context: ProjectDialogContext;
}

/** The destination choice that creates a project; project IDs are UUIDs. */
const NEW_PROJECT = "new";
const nameError = `Use 1 to ${MAXIMUM_PROJECT_NAME_LENGTH} characters.`;

/** "Local · /src/sedes" */
export function locationName(context: ProjectDialogContext, location: ProjectLocation): string {
  return `${context.environmentLabel(location)} · ${location.path}`;
}

/** Runs a mutation, then reloads the list; a failure keeps the dialog open with the server's message. */
async function mutate(context: ProjectDialogContext, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    await context.refresh();
    throw cause instanceof ProjectRemovalBlockedApiError ? cause : new Error(messageFrom(cause));
  }
  await context.refresh();
}

export function RenameProjectDialog({ open, onOpenChange, context, project }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const focusReturn = useFocusReturn();
  const valid = projectNameInputSchema.safeParse(name).success;
  const unchanged = name.trim() === project.name;
  const rename = async () => {
    if (pending || !valid || unchanged) return;
    setPending(true);
    setError(undefined);
    try {
      await mutate(context, () => context.api.renameProject(project.id, { name, expectedRevision: project.revision }));
      onOpenChange(false);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent size="sm" showClose={false} dismissible={!pending} aria-busy={pending || undefined} {...focusReturn}>
      <DialogHeader>
        <DialogTitle>Rename project “{project.name}”</DialogTitle>
        <DialogDescription>The name is only a label; directories and locations keep their paths.</DialogDescription>
      </DialogHeader>
      <form className="contents" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
        <DialogBody>
          <Field label="Project name" error={valid ? undefined : nameError}>
            <Input value={name} disabled={pending} onChange={(event) => setName(event.target.value)} />
          </Field>
          {error !== undefined && <DialogAlert tone="danger">{error}</DialogAlert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || !valid || unchanged}>{pending ? "Renaming…" : "Rename"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** Every blocker the server reported, grouped by location, with thread titles where known. */
function BlockerList({ context, project, blockers }: {
  readonly context: ProjectDialogContext;
  readonly project: ProjectSummary;
  readonly blockers: readonly ProjectRemovalBlocker[];
}): React.JSX.Element {
  return <div className="projects-blockers" data-testid="project-removal-blockers">
    {groupBlockersByLocation(blockers).map((group) => {
      const location = project.locations.find(({ id }) => id === group.locationId);
      return <div key={group.locationId} className="projects-blockers-location">
        <p>{location ? locationName(context, location) : "Another location"}</p>
        <ul>
          {group.blockers.map((blocker) => <li key={blocker.kind}>
            {BLOCKER_ACTIONS[blocker.kind]}: {describeBlockedThreads(blocker.threadIds, context.threadTitle)}
          </li>)}
        </ul>
      </div>;
    })}
  </div>;
}

/** Removing a project reports every blocker at once; they render under the server's message. */
function useProjectRemoval(context: ProjectDialogContext, project: ProjectSummary) {
  const [blockers, setBlockers] = useState<readonly ProjectRemovalBlocker[]>([]);
  return {
    errorDetail: blockers.length > 0 ? <BlockerList context={context} project={project} blockers={blockers} /> : undefined,
    reset: () => setBlockers([]),
    remove: async () => {
      setBlockers([]);
      try {
        await mutate(context, () => context.api.removeProject(project.id, {
          expectedRevision: project.revision, expectedMembershipRevision: project.membershipRevision,
        }));
      } catch (cause) {
        if (cause instanceof ProjectRemovalBlockedApiError) {
          setBlockers(cause.blockers);
          throw new Error(cause.message);
        }
        throw cause;
      }
    },
  };
}

export function RemoveProjectDialog({ open, onOpenChange, context, project }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  const removal = useProjectRemoval(context, project);
  const focusReturn = useFocusReturn();
  const active = project.locations.filter(({ removed }) => !removed);
  const threads = active.reduce((total, location) => total + location.threadCount, 0);
  return <ConfirmDialog open={open} onOpenChange={(next) => { if (!next) removal.reset(); onOpenChange(next); }}
    title={`Remove project “${project.name}”?`} confirmLabel="Remove project" pendingLabel="Removing…"
    description={`Hide this project${active.length > 0 ? `, its ${countLabel(active.length, "active location")}, and their ${countLabel(threads, "thread")}` : ""} from the working inventory. Files, conversation history, and saved application data are retained, and you can restore the project here.`}
    errorDetail={removal.errorDetail} onConfirm={removal.remove} {...focusReturn} />;
}

export function RemoveLocationDialog({ open, onOpenChange, context, project, location }: DialogProps & {
  readonly project: ProjectSummary;
  readonly location: ProjectLocation;
}): React.JSX.Element {
  const [alsoProject, setAlsoProject] = useState(false);
  const removal = useProjectRemoval(context, project);
  const focusReturn = useFocusReturn();
  const lastActive = !project.removed
    && project.locations.every(({ id, removed }) => id === location.id || removed);
  const removeProject = lastActive && alsoProject;
  return <ConfirmDialog open={open} onOpenChange={(next) => { if (!next) removal.reset(); onOpenChange(next); }}
    title={`Remove “${location.label}” from “${project.name}”?`}
    confirmLabel={removeProject ? "Remove project" : "Remove location"} pendingLabel="Removing…"
    description={`Hide this location (${locationName(context, location)}) and its ${countLabel(location.threadCount, "thread")} from the working inventory. Files, conversation history, and saved application data are retained, and you can restore the location here. Stop running work, pause schedules, and end terminals before removal.`}
    errorDetail={removeProject ? removal.errorDetail : undefined}
    onConfirm={() => removeProject
      ? removal.remove()
      : mutate(context, () => context.api.removeLocation(location.id, { expectedRevision: location.revision }))}
    {...focusReturn}>
    {lastActive ? <label className="execution-checkbox-option">
      <Checkbox checked={alsoProject} onCheckedChange={(checked) => { setAlsoProject(checked === true); removal.reset(); }} />
      <span>Also remove project “{project.name}”</span>
    </label> : undefined}
  </ConfirmDialog>;
}

export function RestoreProjectDialog({ open, onOpenChange, context, project }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  const removed = project.locations.filter((location) => location.removed);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(removed
    .filter((location) => location.removedWithProject && context.environmentAvailable(location.environmentId))
    .map(({ id }) => id)));
  const [results, setResults] = useState<readonly RestoredLocationResult[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const focusReturn = useFocusReturn();
  const restore = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const locationIds = removed.filter(({ id }) => selected.has(id)).map(({ id }) => id);
      let restored: readonly RestoredLocationResult[] = [];
      await mutate(context, async () => {
        restored = (await context.api.restoreProject(project.id, { expectedRevision: project.revision, locationIds })).locations;
      });
      if (restored.length === 0) onOpenChange(false);
      else setResults(restored);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent size="sm" showClose={false} dismissible={!pending} aria-busy={pending || undefined} {...focusReturn}>
      <DialogHeader>
        <DialogTitle>{results ? `Restored project “${project.name}”` : `Restore project “${project.name}”?`}</DialogTitle>
        <DialogDescription>{results
          ? "Each location was checked again on its environment. Schedules stay paused."
          : removed.length > 0
            ? "Choose the locations to restore with it. Each is checked again on its environment, and schedules stay paused."
            : "The project has no locations to restore. Schedules stay paused."}</DialogDescription>
      </DialogHeader>
      {results ? <DialogBody>
        <ul className="projects-restore-results" aria-label="Restored locations">
          {results.map((result) => {
            const location = removed.find(({ id }) => id === result.id);
            return <li key={result.id}>
              <span className="projects-restore-location">{location ? locationName(context, location) : result.id}</span>
              {result.status === "restored"
                ? <StatusPill tone="success">Restored</StatusPill>
                : <><StatusPill tone="danger">Not restored</StatusPill><span className="projects-restore-error">{result.error.message}</span></>}
            </li>;
          })}
        </ul>
      </DialogBody> : (removed.length > 0 || error !== undefined) && <DialogBody>
        {removed.length > 0 ? <div role="group" aria-label="Locations to restore" className="execution-checkbox-group-options">
          {removed.map((location) => {
            const available = context.environmentAvailable(location.environmentId);
            return <label key={location.id} className="execution-checkbox-option" data-disabled={pending || undefined}>
              <Checkbox checked={selected.has(location.id)} disabled={pending} onCheckedChange={(checked) => setSelected((current) => {
                const next = new Set(current);
                if (checked === true) next.add(location.id); else next.delete(location.id);
                return next;
              })} />
              <span>{locationName(context, location)}{available ? "" : " (environment unavailable)"}</span>
            </label>;
          })}
        </div> : null}
        {error !== undefined && <DialogAlert tone="danger">{error}</DialogAlert>}
      </DialogBody>}
      <DialogFooter>
        {results ? <Button type="button" onClick={() => onOpenChange(false)}>Done</Button> : <>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => void restore()}>{pending ? "Restoring…" : "Restore project"}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function MoveLocationDialog({ open, onOpenChange, context, project, location }: DialogProps & {
  readonly project: ProjectSummary;
  readonly location: ProjectLocation;
}): React.JSX.Element {
  const [target, setTarget] = useState<string>();
  const [name, setName] = useState(location.label);
  const focusReturn = useFocusReturn();
  const nameValid = projectNameInputSchema.safeParse(name).success;
  const destinations = context.projects.filter((candidate) => !candidate.removed && candidate.id !== project.id);
  const assignment: ProjectAssignment | undefined = target === undefined ? undefined
    : target === NEW_PROJECT ? nameValid ? { kind: "new", name } : undefined
      : { kind: "existing", projectId: target };
  return <ConfirmDialog open={open} onOpenChange={onOpenChange}
    title={`Move “${location.label}” to another project`} confirmLabel="Move location" pendingLabel="Moving…"
    description={`${locationName(context, location)} leaves “${project.name}”. Its ${countLabel(location.threadCount, "thread")}, tasks, and workpads move with it.`}
    confirmDisabled={assignment === undefined}
    onConfirm={() => assignment && mutate(context, () => context.api.moveLocation(location.id, {
      target: assignment, expectedRevision: location.revision,
    }))} {...focusReturn}>
    <Field label="Move to">
      <SearchableSelect label="Move to" searchLabel="Search projects" emptyLabel="No matching projects"
        placeholder="Choose a project" value={target ?? ""}
        options={[
          { value: NEW_PROJECT, label: "New project", icon: <FolderPlus size={14} />, pinned: true },
          ...destinations.map((candidate) => ({ value: candidate.id, ...context.projectChoice(candidate) })),
        ]}
        onValueChange={setTarget} />
    </Field>
    {target === NEW_PROJECT ? <Field label="New project name" error={nameValid ? undefined : nameError}>
      <Input aria-label="New project name" value={name} onChange={(event) => setName(event.target.value)} />
    </Field> : null}
  </ConfirmDialog>;
}

export function MergeProjectDialog({ open, onOpenChange, context, sources, initialSourceId, initialTargetId }: DialogProps & {
  /** The project to merge, or the same-named projects to choose it from. */
  readonly sources: readonly ProjectSummary[];
  readonly initialSourceId: string;
  readonly initialTargetId?: string;
}): React.JSX.Element {
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [targetId, setTargetId] = useState(initialTargetId);
  const focusReturn = useFocusReturn();
  const source = sources.find(({ id }) => id === sourceId) ?? sources[0]!;
  const targets = context.projects.filter((candidate) => !candidate.removed && candidate.id !== source.id);
  const target = targets.find(({ id }) => id === targetId);
  return <ConfirmDialog open={open} onOpenChange={onOpenChange} tone="danger"
    title={sources.length > 1 ? `Merge projects named “${source.name}”` : `Merge “${source.name}” into another project`}
    confirmLabel="Merge projects" pendingLabel="Merging…" confirmDisabled={target === undefined}
    description={`Every location of “${source.name}” (${countLabel(source.locations.length, "location")}, removed ones included) moves into the chosen project with its threads, tasks, and workpads, and “${source.name}” is deleted. This can’t be undone.`}
    onConfirm={() => target ? mutate(context, () => context.api.mergeProject(source.id, {
      targetProjectId: target.id,
      expectedSourceMembershipRevision: source.membershipRevision,
      expectedTargetMembershipRevision: target.membershipRevision,
    })) : undefined} {...focusReturn}>
    {sources.length > 1 ? <Field label="Merge">
      <SearchableSelect label="Merge" searchLabel="Search projects" emptyLabel="No matching projects" value={source.id}
        options={sources.map((candidate) => ({ value: candidate.id, ...context.projectChoice(candidate) }))}
        onValueChange={(next) => { setSourceId(next); if (next === targetId) setTargetId(undefined); }} />
    </Field> : null}
    <Field label="Into">
      <SearchableSelect label="Into" searchLabel="Search projects" emptyLabel="No matching projects"
        placeholder="Choose a project" value={target?.id ?? ""}
        options={targets.map((candidate) => ({ value: candidate.id, ...context.projectChoice(candidate) }))}
        onValueChange={setTargetId} />
    </Field>
  </ConfirmDialog>;
}
