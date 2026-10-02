/**
 * Presentation of projects and their locations (one directory on one
 * environment). Identity is always the opaque project or workspace ID; these
 * labels only say as much as a reader needs to tell locations apart.
 */
import {
  environmentDisplayLabel,
  uniqueCollisionToken,
} from "./sidebar-scope-presentation.js";

export interface ProjectPresentation {
  readonly id: string;
  readonly name: string;
}

export interface LocationPresentation {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly label: { readonly text: string };
  readonly displayPath: { readonly text: string };
  readonly available: boolean;
}

export interface LocationEnvironmentPresentation {
  readonly id: string;
  readonly kind: string;
  readonly label: { readonly text: string };
  readonly available: boolean;
}

/** Active projects and their active locations, as the snapshot carries them. */
export interface ProjectLocationCatalog {
  readonly projects: readonly ProjectPresentation[];
  readonly workspaces: readonly LocationPresentation[];
  readonly environments: readonly LocationEnvironmentPresentation[];
}

export interface ProjectLocations {
  readonly project: (projectId: string) => ProjectPresentation | undefined;
  /** A location's project, by workspace ID. */
  readonly projectForLocation: (
    workspaceId: string,
  ) => ProjectPresentation | undefined;
  /** Every active location of a project, in catalog order. */
  readonly locationsOf: (projectId: string) => readonly LocationPresentation[];
  /**
   * The project's name; a name another active project shares gains a hint
   * from its locations: its environments when those differ, else its path.
   */
  readonly projectLabel: (projectId: string) => string | undefined;
  /**
   * The folder, when the project has another location on the same
   * environment and the folder name differs from the project name. Two
   * same-named folders add their path.
   */
  readonly folderLabel: (workspaceId: string) => string | undefined;
  /**
   * A project group header: the project label and, when `includeEnvironment`
   * is set and every active location is on one non-Local environment, that
   * environment ("sedes · Build host"). A project on several environments
   * shows only its label; its rows say where they run.
   */
  readonly projectHeaderLabel: (
    projectId: string,
    options?: { readonly includeEnvironment?: boolean },
  ) => string | undefined;
  /**
   * "sedes › sedes-context": the project label and, when needed, the folder.
   * `includeEnvironment` appends a non-Local environment: "sedes · Build host",
   * unless the label's hint already names that one environment alone.
   */
  readonly projectFolderLabel: (
    workspaceId: string,
    options?: { readonly includeEnvironment?: boolean },
  ) => string | undefined;
  /**
   * A Projects-view row tag in a project with more than one location: only
   * what distinguishes its location. The environment shows when the project
   * spans environments (never Local, nor when the caller's scope already
   * implies it); the folder follows `folderLabel`.
   */
  readonly locationTag: (
    workspaceId: string,
    options?: { readonly includeEnvironment?: boolean },
  ) => string | undefined;
  /** "Build host · /srv/sedes": the environment (when several exist) and path. */
  readonly locationLabel: (workspaceId: string) => string | undefined;
  /** "sedes · Build host · /srv/sedes", for pickers that choose a location. */
  readonly projectLocationLabel: (workspaceId: string) => string | undefined;
  /** "sedes · /srv/sedes", for pickers whose locations share one environment. */
  readonly projectPathLabel: (workspaceId: string) => string | undefined;
}

const HINT_ENVIRONMENT_LIMIT = 2;

/** Labels are resolved once per catalog; callers memoize on the catalog. */
export function describeProjectLocations(
  catalog: ProjectLocationCatalog,
): ProjectLocations {
  const { projects, workspaces, environments } = catalog;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const workspaceById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const environmentById = new Map(
    environments.map((environment) => [environment.id, environment]),
  );
  const locationsByProject = new Map<string, LocationPresentation[]>();
  for (const workspace of workspaces) {
    const locations = locationsByProject.get(workspace.projectId) ?? [];
    locations.push(workspace);
    locationsByProject.set(workspace.projectId, locations);
  }
  const locationsOf = (projectId: string) =>
    locationsByProject.get(projectId) ?? [];
  const environmentLabel = (environmentId: string) => {
    const environment = environmentById.get(environmentId);
    return environment
      ? environmentDisplayLabel(environment, environments)
      : undefined;
  };

  const projectLabels = new Map<string, string>();
  // The one environment a project's label names, when its hint names exactly
  // one: a location there needs no environment appended.
  const labelEnvironment = new Map<string, string>();
  const projectsByName = new Map<string, ProjectPresentation[]>();
  for (const project of projects) {
    const named = projectsByName.get(project.name) ?? [];
    named.push(project);
    projectsByName.set(project.name, named);
  }
  for (const [name, named] of projectsByName) {
    if (named.length === 1) {
      projectLabels.set(named[0]!.id, name);
      continue;
    }
    const environmentHints = named.map((project) =>
      environmentHint(locationsOf(project.id), environmentById, environments),
    );
    const byEnvironment = new Set(environmentHints).size === named.length;
    const hints = byEnvironment
      ? environmentHints
      : named.map((project) =>
          pathHint(locationsOf(project.id), environmentLabel, environmentById),
        );
    for (const project of named) {
      const hinted = byEnvironment
        ? remoteEnvironmentIds(locationsOf(project.id), environmentById)
        : remoteEnvironmentIds(
            locationsOf(project.id).slice(0, 1),
            environmentById,
          );
      if (hinted.length === 1) labelEnvironment.set(project.id, hinted[0]!);
    }
    named.forEach((project, index) => {
      const hint = hints[index]!;
      const collidingIds = named
        .filter((_candidate, candidateIndex) => hints[candidateIndex] === hint)
        .map(({ id }) => id);
      const qualified = hint ? `${name} · ${hint}` : name;
      projectLabels.set(
        project.id,
        collidingIds.length > 1
          ? `${qualified} · ${uniqueCollisionToken(project.id, collidingIds)}`
          : qualified,
      );
    });
  }

  const folderLabels = new Map<string, string>();
  for (const workspace of workspaces) {
    const siblings = locationsOf(workspace.projectId).filter(
      (candidate) => candidate.environmentId === workspace.environmentId,
    );
    if (siblings.length <= 1) continue;
    const folder = workspace.label.text;
    if (
      siblings.some(
        (candidate) =>
          candidate.id !== workspace.id && candidate.label.text === folder,
      )
    ) {
      folderLabels.set(workspace.id, `${folder} · ${workspace.displayPath.text}`);
    } else if (folder !== projectById.get(workspace.projectId)?.name) {
      folderLabels.set(workspace.id, folder);
    }
  }

  const locationLabel = (workspaceId: string) => {
    const workspace = workspaceById.get(workspaceId);
    if (!workspace) return undefined;
    const environment =
      environments.length > 1
        ? environmentLabel(workspace.environmentId)
        : undefined;
    return environment
      ? `${environment} · ${workspace.displayPath.text}`
      : workspace.displayPath.text;
  };

  return {
    project: (projectId) => projectById.get(projectId),
    projectForLocation: (workspaceId) => {
      const workspace = workspaceById.get(workspaceId);
      return workspace ? projectById.get(workspace.projectId) : undefined;
    },
    locationsOf,
    projectLabel: (projectId) => projectLabels.get(projectId),
    folderLabel: (workspaceId) => folderLabels.get(workspaceId),
    projectHeaderLabel: (projectId, options) => {
      const label = projectLabels.get(projectId);
      if (label === undefined || !options?.includeEnvironment) return label;
      const environmentIds = new Set(
        locationsOf(projectId).map(({ environmentId }) => environmentId),
      );
      const [environmentId] = environmentIds;
      const environment =
        environmentIds.size === 1 && environmentId !== undefined
          ? environmentById.get(environmentId)
          : undefined;
      return environment &&
        environment.kind !== "local" &&
        labelEnvironment.get(projectId) !== environment.id
        ? `${label} · ${environmentDisplayLabel(environment, environments)}`
        : label;
    },
    projectFolderLabel: (workspaceId, options) => {
      const workspace = workspaceById.get(workspaceId);
      const project = workspace
        ? projectById.get(workspace.projectId)
        : undefined;
      if (!workspace || !project) return undefined;
      const name = projectLabels.get(project.id) ?? project.name;
      const folder = folderLabels.get(workspaceId);
      const label = folder ? `${name} › ${folder}` : name;
      const environment = environmentById.get(workspace.environmentId);
      return options?.includeEnvironment &&
        labelEnvironment.get(project.id) !== workspace.environmentId &&
        environment &&
        environment.kind !== "local"
        ? `${label} · ${environmentDisplayLabel(environment, environments)}`
        : label;
    },
    locationTag: (workspaceId, options) => {
      const workspace = workspaceById.get(workspaceId);
      if (!workspace) return undefined;
      const locations = locationsOf(workspace.projectId);
      if (locations.length <= 1) return undefined;
      const spansEnvironments =
        new Set(locations.map(({ environmentId }) => environmentId)).size > 1;
      const environment = environmentById.get(workspace.environmentId);
      const parts = [
        (options?.includeEnvironment ?? true) &&
        spansEnvironments &&
        environment &&
        environment.kind !== "local"
          ? environmentDisplayLabel(environment, environments)
          : undefined,
        folderLabels.get(workspaceId),
      ].filter((part): part is string => part !== undefined);
      return parts.length > 0 ? parts.join(" · ") : undefined;
    },
    locationLabel,
    projectLocationLabel: (workspaceId) => {
      const workspace = workspaceById.get(workspaceId);
      const project = workspace
        ? projectLabels.get(workspace.projectId)
        : undefined;
      const location = locationLabel(workspaceId);
      return project && location ? `${project} · ${location}` : undefined;
    },
    projectPathLabel: (workspaceId) => {
      const workspace = workspaceById.get(workspaceId);
      const project = workspace
        ? projectLabels.get(workspace.projectId)
        : undefined;
      return workspace && project
        ? `${project} · ${workspace.displayPath.text}`
        : undefined;
    },
  };
}

/** The distinct non-Local environments of these locations, in order. */
function remoteEnvironmentIds(
  locations: readonly LocationPresentation[],
  environmentById: ReadonlyMap<string, LocationEnvironmentPresentation>,
): string[] {
  return [
    ...new Set(
      locations
        .filter(({ environmentId }) => {
          const environment = environmentById.get(environmentId);
          return environment !== undefined && environment.kind !== "local";
        })
        .map(({ environmentId }) => environmentId),
    ),
  ];
}

/** Non-Local environments hosting the project: "Build host, CI +1". */
function environmentHint(
  locations: readonly LocationPresentation[],
  environmentById: ReadonlyMap<string, LocationEnvironmentPresentation>,
  environments: readonly LocationEnvironmentPresentation[],
): string {
  const labels = [
    ...new Set(
      locations.flatMap(({ environmentId }) => {
        const environment = environmentById.get(environmentId);
        return environment && environment.kind !== "local"
          ? [environmentDisplayLabel(environment, environments)]
          : [];
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const shown = labels.slice(0, HINT_ENVIRONMENT_LIMIT).join(", ");
  return labels.length > HINT_ENVIRONMENT_LIMIT
    ? `${shown} +${labels.length - HINT_ENVIRONMENT_LIMIT}`
    : shown;
}

/** The first location's path (with a non-Local environment), then "+N". */
function pathHint(
  locations: readonly LocationPresentation[],
  environmentLabel: (environmentId: string) => string | undefined,
  environmentById: ReadonlyMap<string, LocationEnvironmentPresentation>,
): string {
  const [first] = locations;
  if (!first) return "No locations";
  const environment =
    environmentById.get(first.environmentId)?.kind === "local"
      ? undefined
      : environmentLabel(first.environmentId);
  const location = environment
    ? `${environment} · ${first.displayPath.text}`
    : first.displayPath.text;
  return locations.length > 1
    ? `${location} +${locations.length - 1}`
    : location;
}
