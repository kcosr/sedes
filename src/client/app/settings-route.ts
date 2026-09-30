/** Settings categories are route state; their controls retain their existing ownership scopes. */
export type SettingsPage =
  | "paired_clients"
  | "notifications"
  | "general"
  | "diagnostics"
  | "appearance"
  | "prompts"
  | "mobile"
  | "terminal"
  | "tool_clients"
  | "connection"
  | "environments"
  | "backends"
  | "agents"
  | "projects"
  | "server";

export const settingsPageSlugs = {
  paired_clients: "paired-clients",
  notifications: "notifications",
  general: "general",
  diagnostics: "diagnostics",
  appearance: "appearance",
  prompts: "prompts",
  mobile: "mobile",
  terminal: "terminal",
  tool_clients: "tool-clients",
  connection: "connection",
  environments: "environments",
  backends: "backends",
  agents: "agents",
  projects: "projects",
  server: "server",
} as const satisfies Readonly<Record<SettingsPage, string>>;

/**
 * Inventory pages whose entities have their own URLs. Selection and editing
 * are route state, so browser and Android Back walk the same path.
 */
export type SettingsResourcePage = "environments" | "backends" | "agents";
/** `view` shows an entity, `edit` its editor, `new` a creation flow and
 * `pending` a host registration awaiting approval (environments only). An
 * Agent is a small preset whose view is its editor, so Agents have no `edit`. */
export type SettingsResourceMode = "view" | "edit" | "new" | "pending";

/**
 * Action segments start with `~`, which no entity id can: backend ids start
 * with a letter or digit (`configurationIdSchema`), and environment, Agent
 * and registration ids are UUIDs. So every id the configuration contract
 * accepts, "new", "pending" and "edit" included, has a URL of its own.
 */
const actionSegments = { new: "~new", pending: "~pending" } as const;

export interface SettingsResourceRoute {
  readonly resourceId?: string;
  readonly mode?: SettingsResourceMode;
}

export const settingsResourcePages: readonly SettingsResourcePage[] = ["environments", "backends", "agents"];

/** Creation starts for environments: `/~new` is the chooser, `/~new/:kind` the form or pairing setup. */
export const environmentCreationKinds = ["local", "ssh", "pair"] as const;
export type EnvironmentCreationKind = typeof environmentCreationKinds[number];

export function isSettingsResourcePage(page: SettingsPage | undefined): page is SettingsResourcePage {
  return (settingsResourcePages as readonly (SettingsPage | undefined)[]).includes(page);
}

function decodeSegment(segment: string): string | undefined {
  try {
    const value = decodeURIComponent(segment);
    return value.length > 0 && value.length <= 160 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses the segments after `/settings/<page>/`. Returns undefined for a
 * shape the page does not have; the caller then treats the URL as unknown.
 */
export function parseSettingsResource(page: SettingsResourcePage, segments: readonly string[]): SettingsResourceRoute | undefined {
  const [first, second, ...rest] = segments;
  if (first === undefined || rest.length > 0) return undefined;
  if (first === actionSegments.new) {
    if (second === undefined) return { mode: "new" };
    return page === "environments" && (environmentCreationKinds as readonly string[]).includes(second)
      ? { mode: "new", resourceId: second } : undefined;
  }
  if (first === actionSegments.pending) {
    if (page !== "environments" || second === undefined) return undefined;
    const registrationId = decodeSegment(second);
    return registrationId ? { mode: "pending", resourceId: registrationId } : undefined;
  }
  const resourceId = decodeSegment(first);
  if (!resourceId || resourceId.startsWith("~")) return undefined;
  if (second === undefined) return { mode: "view", resourceId };
  return second === "edit" && page !== "agents" ? { mode: "edit", resourceId } : undefined;
}

/**
 * One level up from an entity route, where its "‹" link and Escape go: an
 * editor's entity, a creation kind's chooser, otherwise the page's list.
 */
export function settingsResourceParent(resource: SettingsResourceRoute): SettingsResourceRoute {
  const { mode, resourceId } = resource;
  if (mode === "edit" && resourceId) return { mode: "view", resourceId };
  if (mode === "new" && resourceId) return { mode: "new" };
  return {};
}

/** The path suffix (after `/settings/<slug>`) for an entity route. */
export function settingsResourceSuffix(resource: SettingsResourceRoute): string {
  const { mode, resourceId } = resource;
  if (!mode) return "";
  if (mode === "new") return resourceId ? `/${actionSegments.new}/${encodeURIComponent(resourceId)}` : `/${actionSegments.new}`;
  if (!resourceId) return "";
  const id = encodeURIComponent(resourceId);
  if (mode === "pending") return `/${actionSegments.pending}/${id}`;
  return mode === "edit" ? `/${id}/edit` : `/${id}`;
}
