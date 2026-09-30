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
  projects: "projects",
  server: "server",
} as const satisfies Readonly<Record<SettingsPage, string>>;

/**
 * Inventory pages whose entities have their own URLs. Selection and editing
 * are route state, so browser and Android Back walk the same path.
 */
export type SettingsResourcePage = "environments" | "backends";
/** `view` shows an entity, `edit` its editor, `new` a creation flow and
 * `pending` a host registration awaiting approval (environments only). */
export type SettingsResourceMode = "view" | "edit" | "new" | "pending";

export interface SettingsResourceRoute {
  readonly resourceId?: string;
  readonly mode?: SettingsResourceMode;
}

export const settingsResourcePages: readonly SettingsResourcePage[] = ["environments", "backends"];

/** Creation starts for environments: `/new` is the chooser, `/new/:kind` the form or pairing setup. */
export const environmentCreationKinds = ["local", "ssh", "pair"] as const;
export type EnvironmentCreationKind = typeof environmentCreationKinds[number];

export function isSettingsResourcePage(page: SettingsPage | undefined): page is SettingsResourcePage {
  return page === "environments" || page === "backends";
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
 * `new` and `pending` are reserved words, never entity ids.
 */
export function parseSettingsResource(page: SettingsResourcePage, segments: readonly string[]): SettingsResourceRoute | undefined {
  const [first, second, ...rest] = segments;
  if (first === undefined || rest.length > 0) return undefined;
  if (first === "new") {
    if (second === undefined) return { mode: "new" };
    return page === "environments" && (environmentCreationKinds as readonly string[]).includes(second)
      ? { mode: "new", resourceId: second } : undefined;
  }
  if (first === "pending") {
    if (page !== "environments" || second === undefined) return undefined;
    const registrationId = decodeSegment(second);
    return registrationId ? { mode: "pending", resourceId: registrationId } : undefined;
  }
  const resourceId = decodeSegment(first);
  if (!resourceId || resourceId === "new" || resourceId === "pending") return undefined;
  if (second === undefined) return { mode: "view", resourceId };
  return second === "edit" ? { mode: "edit", resourceId } : undefined;
}

/** The path suffix (after `/settings/<slug>`) for an entity route. */
export function settingsResourceSuffix(resource: SettingsResourceRoute): string {
  const { mode, resourceId } = resource;
  if (!mode) return "";
  if (mode === "new") return resourceId ? `/new/${encodeURIComponent(resourceId)}` : "/new";
  if (!resourceId) return "";
  const id = encodeURIComponent(resourceId);
  if (mode === "pending") return `/pending/${id}`;
  return mode === "edit" ? `/${id}/edit` : `/${id}`;
}
