/**
 * Presentation-only labels for sidebar execution scope. Opaque IDs remain the
 * identity; short ID suffixes are used only when human labels still collide.
 */

export interface SidebarEnvironmentPresentation {
  readonly id: string;
  readonly label: { readonly text: string };
  readonly available: boolean;
}

export interface SidebarWorkspacePresentation {
  readonly id: string;
  readonly environmentId: string;
  readonly label: { readonly text: string };
  readonly displayPath: { readonly text: string };
  readonly available: boolean;
}

export interface SidebarTargetPresentation {
  readonly id: string;
  readonly environmentId: string;
  readonly label: { readonly text: string };
  readonly backend: {
    readonly label: { readonly text: string };
    readonly brand?: string;
  };
  readonly available: boolean;
}

const COLLISION_TOKEN_MIN_LENGTH = 6;

function uniqueCollisionToken(
  id: string,
  collidingIds: readonly string[],
): string {
  const maxLength = Math.max(
    id.length,
    ...collidingIds.map((candidate) => candidate.length),
  );
  for (
    let length = Math.min(COLLISION_TOKEN_MIN_LENGTH, id.length);
    length <= maxLength;
    length += 1
  ) {
    const token = id.slice(-length);
    if (
      collidingIds.every(
        (candidate) => candidate === id || candidate.slice(-length) !== token,
      )
    ) {
      return token;
    }
  }
  // IDs are unique by protocol, so a full raw ID is the deterministic final
  // discriminator even when shorter suffixes collide.
  return id;
}

export function environmentDisplayLabel(
  environment: SidebarEnvironmentPresentation,
  environments: readonly SidebarEnvironmentPresentation[],
): string {
  const label = environment.label.text;
  const collidingIds = environments
    .filter((candidate) => candidate.label.text === label)
    .map(({ id }) => id);
  return collidingIds.length > 1
    ? `${label} · ${uniqueCollisionToken(environment.id, collidingIds)}`
    : label;
}

export function workspaceDisplayLabel(options: {
  readonly workspace: SidebarWorkspacePresentation;
  readonly workspaces: readonly SidebarWorkspacePresentation[];
  readonly environments: readonly SidebarEnvironmentPresentation[];
  readonly includeEnvironment: boolean;
}): string {
  const { workspace, workspaces, environments, includeEnvironment } = options;
  const environment = environments.find(
    ({ id }) => id === workspace.environmentId,
  );
  let label = workspace.label.text;
  if (includeEnvironment && environment) {
    label += ` · ${environmentDisplayLabel(environment, environments)}`;
  }
  const sameEnvironmentCollision = workspaces.some(
    (candidate) =>
      candidate.id !== workspace.id &&
      candidate.environmentId === workspace.environmentId &&
      candidate.label.text === workspace.label.text,
  );
  if (sameEnvironmentCollision) label += ` · ${workspace.displayPath.text}`;
  return label;
}

function targetBaseLabel(target: SidebarTargetPresentation): string {
  const targetLabel = target.label.text;
  const backendLabel = target.backend.label.text;
  return targetLabel === backendLabel
    ? targetLabel
    : `${targetLabel} · ${backendLabel}`;
}

export function targetDisplayLabel(options: {
  readonly target: SidebarTargetPresentation;
  readonly targets: readonly SidebarTargetPresentation[];
  readonly environments: readonly SidebarEnvironmentPresentation[];
  readonly includeEnvironment: boolean;
}): string {
  const { target, targets, environments, includeEnvironment } = options;
  const environment = environments.find(
    ({ id }) => id === target.environmentId,
  );
  let label = targetBaseLabel(target);
  if (includeEnvironment && environment) {
    label += ` · ${environmentDisplayLabel(environment, environments)}`;
  }
  const presentationFor = (candidate: SidebarTargetPresentation) => {
    const candidateEnvironment = environments.find(
      ({ id }) => id === candidate.environmentId,
    );
    const base = targetBaseLabel(candidate);
    return includeEnvironment && candidateEnvironment
      ? `${base} · ${environmentDisplayLabel(candidateEnvironment, environments)}`
      : base;
  };
  const collidingIds = targets
    .filter(
      (candidate) => presentationFor(candidate) === presentationFor(target),
    )
    .map(({ id }) => id);
  if (collidingIds.length > 1) {
    label += ` · ${uniqueCollisionToken(target.id, collidingIds)}`;
  }
  return label;
}

export function scopeSummaryLabel(options: {
  readonly environment?: SidebarEnvironmentPresentation;
  readonly target?: SidebarTargetPresentation;
  readonly projectName?: string | null;
  readonly environments: readonly SidebarEnvironmentPresentation[];
  readonly targets: readonly SidebarTargetPresentation[];
  readonly workspaces: readonly SidebarWorkspacePresentation[];
}): string {
  return scopeSummaryPresentation(options).fullLabel;
}

export function scopeSummaryPresentation(options: {
  readonly environment?: SidebarEnvironmentPresentation;
  readonly target?: SidebarTargetPresentation;
  readonly projectName?: string | null;
  readonly environments: readonly SidebarEnvironmentPresentation[];
  readonly targets: readonly SidebarTargetPresentation[];
  readonly workspaces: readonly SidebarWorkspacePresentation[];
  readonly maxVisibleParts?: number;
}): { readonly fullLabel: string; readonly visibleLabel: string } {
  const { environment, target, projectName, environments, targets, workspaces } =
    options;
  const parts: string[] = [];
  if (environment) {
    parts.push(
      `${environmentDisplayLabel(environment, environments)}${environment.available ? "" : " — Unavailable"}`,
    );
  }
  if (target) {
    let label = targetDisplayLabel({
      target,
      targets,
      environments,
      includeEnvironment: environment === undefined && environments.length > 1,
    });
    if (!target.available) label += " — Unavailable";
    else if (
      environment === undefined &&
      environments.find(({ id }) => id === target.environmentId)?.available ===
        false
    ) {
      label += " — Environment unavailable";
    }
    parts.push(label);
  }
  if (projectName) {
    const environmentId = environment?.id ?? target?.environmentId;
    const matching = workspaces.filter((workspace) =>
      workspace.label.text === projectName &&
      (environmentId === undefined || workspace.environmentId === environmentId),
    );
    const available = matching.some((workspace) => workspace.available &&
      environments.find(({ id }) => id === workspace.environmentId)?.available !== false);
    parts.push(`${projectName}${available ? "" : " — Unavailable"}`);
  }
  const fullLabel = parts.join(" · ");
  const maxVisibleParts = Math.max(1, options.maxVisibleParts ?? 2);
  const visibleParts = parts.slice(0, maxVisibleParts);
  const omittedCount = parts.length - visibleParts.length;
  return {
    fullLabel,
    visibleLabel: `${visibleParts.join(" · ")}${omittedCount > 0 ? ` +${omittedCount}` : ""}`,
  };
}
