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
  describeLocationChanges,
  describeProjectChanges,
  groupBlockersByLocation,
  isLastActiveLocation,
  placeLocation,
  reselectRemovedLocations,
  type PlacedLocation,
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
  /**
   * Reloads the list after every attempt, successful or not, and resolves to
   * it, or to undefined when it cannot be loaded.
   */
  readonly refresh: () => Promise<readonly ProjectSummary[] | undefined>;
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

/** Counts remain live without replacing the structural revisions being confirmed. */
function projectWithCurrentCounts(context: ProjectDialogContext, project: ProjectSummary): ProjectSummary {
  const current = context.projects.find(({ id }) => id === project.id);
  return current ? { ...project, taskCount: current.taskCount, workpadCount: current.workpadCount } : project;
}

/** How the records a dialog shows read in the reloaded list. */
type Reconciled<T> =
  | { readonly kind: "unchanged" }
  /** The dialog shows these instead and says what changed; the user confirms again. */
  | { readonly kind: "changed"; readonly records: T; readonly message: string; readonly changes: readonly string[] }
  /** Gone, or the dialog's action no longer applies to them. */
  | { readonly kind: "unavailable"; readonly reason: string };

const changedMessage = (subject: string) =>
  `${subject} changed while this was open. Check the details and try again.`;

/** Re-reads a project; `required` is the state the dialog's action needs it in. */
function reconcileProject(
  projects: readonly ProjectSummary[],
  shown: ProjectSummary,
  required?: "active" | "removed",
): Reconciled<ProjectSummary> {
  const current = projects.find(({ id }) => id === shown.id);
  if (!current) {
    return { kind: "unavailable", reason: `“${shown.name}” no longer exists. It may have been merged into another project.` };
  }
  if (required === "active" && current.removed) {
    return { kind: "unavailable", reason: `“${current.name}” was removed while this was open.` };
  }
  if (required === "removed" && !current.removed) {
    return { kind: "unavailable", reason: `“${current.name}” was restored while this was open.` };
  }
  return JSON.stringify(current) === JSON.stringify(shown) ? { kind: "unchanged" } : {
    kind: "changed", records: current, message: changedMessage(`“${shown.name}”`), changes: describeProjectChanges(shown, current),
  };
}

/** Re-reads a location wherever it is now; removing one needs it still active. */
function reconcileLocation(
  context: ProjectDialogContext,
  projects: readonly ProjectSummary[],
  shown: PlacedLocation,
  requireActive: boolean,
): Reconciled<PlacedLocation> {
  const name = locationName(context, shown.location);
  const current = placeLocation(projects, shown.location.id);
  if (!current) return { kind: "unavailable", reason: `${name} no longer exists.` };
  if (requireActive && current.location.removed) {
    return { kind: "unavailable", reason: `${name} was removed while this was open.` };
  }
  const sameLocation = JSON.stringify(current.location) === JSON.stringify(shown.location);
  if (sameLocation && JSON.stringify(current.project) === JSON.stringify(shown.project)) return { kind: "unchanged" };
  return {
    kind: "changed", records: current, message: changedMessage(sameLocation ? `“${shown.project.name}”` : name),
    changes: describeLocationChanges(shown, current),
  };
}

/**
 * The records a dialog describes, kept as the user saw them so that
 * confirming sends their revisions. A failed attempt reloads the list and
 * re-reads them. Changed records replace the shown ones and the failure
 * says what changed, so the user confirms again with current revisions;
 * records that are gone, or that the action no longer applies to, disable
 * the action and the failure says why.
 */
function useShownRecords<T>(
  context: ProjectDialogContext,
  opened: T,
  reconcile: (projects: readonly ProjectSummary[], shown: T) => Reconciled<T>,
) {
  const [records, setRecords] = useState(opened);
  const [changes, setChanges] = useState<readonly string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  /** Runs a mutation, then reloads the list; a failure keeps the dialog open with a message. */
  const attempt = async (operation: (shown: T) => Promise<unknown>): Promise<void> => {
    setChanges([]);
    try {
      await operation(records);
    } catch (cause) {
      const reloaded = await context.refresh();
      const next: Reconciled<T> = reloaded === undefined ? { kind: "unchanged" } : reconcile(reloaded, records);
      if (next.kind === "unavailable") {
        setUnavailable(true);
        throw new Error(next.reason);
      }
      if (next.kind === "changed") {
        setRecords(next.records);
        setChanges(next.changes);
        throw new Error(next.message);
      }
      throw cause instanceof ProjectRemovalBlockedApiError ? cause : new Error(messageFrom(cause));
    }
    await context.refresh();
  };
  return {
    records,
    unavailable,
    attempt,
    /** What changed, for the failure alert. */
    changes: changes.length > 0
      ? <ul className="projects-changes">{changes.map((change) => <li key={change}>{change}</li>)}</ul>
      : undefined,
  };
}

export function RenameProjectDialog({ open, onOpenChange, context, project: opened }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  const shown = useShownRecords(context, opened, (projects, current) => reconcileProject(projects, current, "active"));
  const project = shown.records;
  const [name, setName] = useState(opened.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const focusReturn = useFocusReturn();
  const valid = projectNameInputSchema.safeParse(name).success;
  const unchanged = name.trim() === project.name;
  const rename = async () => {
    if (pending || !valid || unchanged || shown.unavailable) return;
    setPending(true);
    setError(undefined);
    try {
      await shown.attempt((current) => context.api.renameProject(current.id, { name, expectedRevision: current.revision }));
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
          {error !== undefined && <DialogAlert tone="danger">{error}{shown.changes}</DialogAlert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || !valid || unchanged || shown.unavailable}>{pending ? "Renaming…" : "Rename"}</Button>
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
function useProjectRemoval(context: ProjectDialogContext) {
  const [blockers, setBlockers] = useState<readonly ProjectRemovalBlocker[]>([]);
  return {
    errorDetail: (project: ProjectSummary) =>
      blockers.length > 0 ? <BlockerList context={context} project={project} blockers={blockers} /> : undefined,
    reset: () => setBlockers([]),
    /** Runs an attempt to remove the project, keeping the blockers it reports. */
    run: async (attempt: () => Promise<void>) => {
      setBlockers([]);
      try {
        await attempt();
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

const removeProject = (context: ProjectDialogContext, project: ProjectSummary) =>
  context.api.removeProject(project.id, {
    expectedRevision: project.revision, expectedMembershipRevision: project.membershipRevision,
  });

export function RemoveProjectDialog({ open, onOpenChange, context, project: opened }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  const shown = useShownRecords(context, opened, (projects, current) => reconcileProject(projects, current, "active"));
  const project = projectWithCurrentCounts(context, shown.records);
  const removal = useProjectRemoval(context);
  const focusReturn = useFocusReturn();
  const active = project.locations.filter(({ removed }) => !removed);
  const threads = active.reduce((total, location) => total + location.threadCount, 0);
  return <ConfirmDialog open={open} onOpenChange={(next) => { if (!next) removal.reset(); onOpenChange(next); }}
    title={`Remove project “${project.name}”?`} confirmLabel="Remove project" pendingLabel="Removing…"
    description={`Hide this project with its ${countLabel(project.taskCount, "task")} and ${countLabel(project.workpadCount, "workpad")}${active.length > 0 ? `, its ${countLabel(active.length, "active location")}, and their ${countLabel(threads, "thread")}` : ""} from the working inventory. Files, conversation history, and saved application data are retained, and you can restore the project here.`}
    confirmDisabled={shown.unavailable} errorDetail={removal.errorDetail(project) ?? shown.changes}
    onConfirm={() => removal.run(() => shown.attempt((current) => removeProject(context, current)))} {...focusReturn} />;
}

export function RemoveLocationDialog({ open, onOpenChange, context, project: openedProject, location: openedLocation }: DialogProps & {
  readonly project: ProjectSummary;
  readonly location: ProjectLocation;
}): React.JSX.Element {
  const [alsoProject, setAlsoProject] = useState(false);
  const shown = useShownRecords(context, { project: openedProject, location: openedLocation }, (projects, current) => {
    const next = reconcileLocation(context, projects, current, true);
    if (next.kind !== "changed" || isLastActiveLocation(next.records) === isLastActiveLocation(current)) return next;
    // Removing the project is offered afresh, unticked, or no longer at all.
    setAlsoProject(false);
    const name = next.records.project.name;
    return { ...next, changes: [...next.changes, isLastActiveLocation(next.records)
      ? `It is now the last active location of “${name}”.`
      : `Another location of “${name}” is active now, so removing this one keeps the project.`] };
  });
  const { location } = shown.records;
  const project = projectWithCurrentCounts(context, shown.records.project);
  const removal = useProjectRemoval(context);
  const focusReturn = useFocusReturn();
  const lastActive = isLastActiveLocation(shown.records);
  const removesProject = lastActive && alsoProject;
  return <ConfirmDialog open={open} onOpenChange={(next) => { if (!next) removal.reset(); onOpenChange(next); }}
    title={`Remove “${location.label}” from “${project.name}”?`}
    confirmLabel={removesProject ? "Remove project" : "Remove location"} pendingLabel="Removing…"
    description={`${removesProject
      ? `Hide this location (${locationName(context, location)}), its ${countLabel(location.threadCount, "thread")}, and “${project.name}” with its ${countLabel(project.taskCount, "task")} and ${countLabel(project.workpadCount, "workpad")} from the working inventory.`
      : `Hide this location (${locationName(context, location)}) and its ${countLabel(location.threadCount, "thread")} from the working inventory; the tasks and workpads of “${project.name}” stay.`} Files, conversation history, and saved application data are retained, and you can restore the location here. Stop running work, pause schedules, and end terminals before removal.`}
    confirmDisabled={shown.unavailable}
    errorDetail={(removesProject ? removal.errorDetail(project) : undefined) ?? shown.changes}
    onConfirm={() => removesProject
      ? removal.run(() => shown.attempt((current) => removeProject(context, current.project)))
      : shown.attempt((current) => context.api.removeLocation(current.location.id, { expectedRevision: current.location.revision }))}
    {...focusReturn}>
    {lastActive ? <label className="execution-checkbox-option">
      <Checkbox checked={alsoProject} onCheckedChange={(checked) => { setAlsoProject(checked === true); removal.reset(); }} />
      <span>Also remove project “{project.name}” ({countLabel(project.taskCount, "task")} and {countLabel(project.workpadCount, "workpad")})</span>
    </label> : undefined}
  </ConfirmDialog>;
}

export function RestoreProjectDialog({ open, onOpenChange, context, project: opened }: DialogProps & {
  readonly project: ProjectSummary;
}): React.JSX.Element {
  // Locations its removal took on available environments restore with it by default.
  const preselect = (location: ProjectLocation) =>
    location.removedWithProject && context.environmentAvailable(location.environmentId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(opened.locations
    .filter((location) => location.removed && preselect(location))
    .map(({ id }) => id)));
  const shown = useShownRecords(context, opened, (projects, current) => {
    const next = reconcileProject(projects, current, "removed");
    if (next.kind === "changed") {
      setSelected((choices) => reselectRemovedLocations(choices, current, next.records, preselect));
    }
    return next;
  });
  const project = shown.records;
  const removed = project.locations.filter((location) => location.removed);
  const [results, setResults] = useState<readonly RestoredLocationResult[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const focusReturn = useFocusReturn();
  const restore = async () => {
    if (pending || shown.unavailable) return;
    setPending(true);
    setError(undefined);
    try {
      let restored: readonly RestoredLocationResult[] = [];
      await shown.attempt(async (current) => {
        const locationIds = current.locations
          .filter((location) => location.removed && selected.has(location.id)).map(({ id }) => id);
        restored = (await context.api.restoreProject(current.id, { expectedRevision: current.revision, locationIds })).locations;
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
        {error !== undefined && <DialogAlert tone="danger">{error}{shown.changes}</DialogAlert>}
      </DialogBody>}
      <DialogFooter>
        {results ? <Button type="button" onClick={() => onOpenChange(false)}>Done</Button> : <>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending || shown.unavailable} onClick={() => void restore()}>{pending ? "Restoring…" : "Restore project"}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function MoveLocationDialog({ open, onOpenChange, context, project: openedProject, location: openedLocation }: DialogProps & {
  readonly project: ProjectSummary;
  readonly location: ProjectLocation;
}): React.JSX.Element {
  const shown = useShownRecords(context, { project: openedProject, location: openedLocation },
    (projects, current) => reconcileLocation(context, projects, current, false));
  const { project, location } = shown.records;
  const [target, setTarget] = useState<string>();
  const [name, setName] = useState(openedLocation.label);
  const focusReturn = useFocusReturn();
  const nameValid = projectNameInputSchema.safeParse(name).success;
  const destinations = context.projects.filter((candidate) => !candidate.removed && candidate.id !== project.id);
  // A destination that was removed, merged away, or now holds the location is no longer a choice.
  const chosen = target === NEW_PROJECT || destinations.some(({ id }) => id === target) ? target : undefined;
  const assignment: ProjectAssignment | undefined = chosen === undefined ? undefined
    : chosen === NEW_PROJECT ? nameValid ? { kind: "new", name } : undefined
      : { kind: "existing", projectId: chosen };
  return <ConfirmDialog open={open} onOpenChange={onOpenChange}
    title={`Move “${location.label}” to another project`} confirmLabel="Move location" pendingLabel="Moving…"
    description={`${locationName(context, location)} and its ${countLabel(location.threadCount, "thread")} leave “${project.name}” with their tasks and workpads. The project’s own tasks and workpads stay in “${project.name}”.`}
    confirmDisabled={assignment === undefined || shown.unavailable} errorDetail={shown.changes}
    onConfirm={() => assignment && shown.attempt((current) => context.api.moveLocation(current.location.id, {
      target: assignment, expectedRevision: current.location.revision,
    }))} {...focusReturn}>
    <Field label="Move to">
      <SearchableSelect label="Move to" searchLabel="Search projects" emptyLabel="No matching projects"
        placeholder="Choose a project" value={chosen ?? ""}
        options={[
          { value: NEW_PROJECT, label: "New project", icon: <FolderPlus size={14} />, pinned: true },
          ...destinations.map((candidate) => ({ value: candidate.id, ...context.projectChoice(candidate) })),
        ]}
        onValueChange={setTarget} />
    </Field>
    {chosen === NEW_PROJECT ? <Field label="New project name" error={nameValid ? undefined : nameError}>
      <Input aria-label="New project name" value={name} onChange={(event) => setName(event.target.value)} />
    </Field> : null}
  </ConfirmDialog>;
}

export function MergeProjectDialog({ open, onOpenChange, context, sources: opened, initialSourceId, initialTargetId }: DialogProps & {
  /** The project to merge, or the same-named projects to choose it from. */
  readonly sources: readonly ProjectSummary[];
  readonly initialSourceId: string;
  readonly initialTargetId?: string;
}): React.JSX.Element {
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [targetId, setTargetId] = useState(initialTargetId);
  // The chosen source is the record the merge confirms; the others reload with it.
  const shown = useShownRecords(context, opened, (projects, current): Reconciled<readonly ProjectSummary[]> => {
    const chosen = current.find(({ id }) => id === sourceId) ?? current[0]!;
    const next = reconcileProject(projects, chosen);
    if (next.kind !== "changed") return next;
    return {
      ...next,
      records: current.flatMap(({ id }) => id === chosen.id ? [next.records] : projects.filter((project) => project.id === id)),
    };
  });
  const sources = shown.records;
  const focusReturn = useFocusReturn();
  const source = sources.find(({ id }) => id === sourceId) ?? sources[0]!;
  const targets = context.projects.filter((candidate) => !candidate.removed && candidate.id !== source.id);
  const target = targets.find(({ id }) => id === targetId);
  return <ConfirmDialog open={open} onOpenChange={onOpenChange} tone="danger"
    title={sources.length > 1 ? `Merge projects named “${source.name}”` : `Merge “${source.name}” into another project`}
    confirmLabel="Merge projects" pendingLabel="Merging…" confirmDisabled={target === undefined || shown.unavailable}
    description={`Every location of “${source.name}” (${countLabel(source.locations.length, "location")}, removed ones included) moves into the chosen project with its threads, tasks, and workpads, and “${source.name}” is deleted. This can’t be undone.`}
    errorDetail={shown.changes}
    onConfirm={() => target ? shown.attempt(() => context.api.mergeProject(source.id, {
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
