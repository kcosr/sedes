import type { ZodError } from "zod";
import type { Configuration } from "./types.js";

type ZodIssue = ZodError["issues"][number];
type PathKey = PropertyKey;

/** A validation failure with a message written for people, not a schema path. */
export interface ValidationIssue {
  readonly path: readonly PathKey[];
  readonly message: string;
}

export interface GeneralError {
  /** Where the problem is, in words ("Workspace roots › entry 2"); absent for the whole form. */
  readonly location?: string;
  readonly message: string;
}

/** Errors for the fields of one editor, keyed by their path relative to the edited item. */
export class FieldErrors {
  static readonly none = new FieldErrors(new Map());
  constructor(private readonly entries: ReadonlyMap<string, string>) {}
  get size(): number { return this.entries.size; }
  /** The error for exactly this field. */
  get(path: string): string | undefined { return this.entries.get(path); }
  /** The first error at or below `path`, for a control that edits a whole subtree. */
  under(path: string): string | undefined {
    for (const [key, message] of this.entries) if (key === path || key.startsWith(`${path}.`)) return message;
    return undefined;
  }
  /** The errors below `path`, re-keyed relative to it, for a nested editor. */
  scope(path: string): FieldErrors {
    const scoped = new Map<string, string>();
    for (const [key, message] of this.entries) if (key.startsWith(`${path}.`)) scoped.set(key.slice(path.length + 1), message);
    return scoped.size ? new FieldErrors(scoped) : FieldErrors.none;
  }
}

export interface MappedErrors {
  readonly fields: FieldErrors;
  readonly general: readonly GeneralError[];
}

export const noErrors: MappedErrors = { fields: FieldErrors.none, general: [] };

const keyLabels: Record<string, string> = {
  label: "Name", hostAlias: "SSH host alias", workspaceRoots: "Workspace roots", operations: "Sidecar operations",
  enabledCapabilities: "Operations", environmentVariables: "Environment variables", execution: "Tools and commands",
  startup: "Backend startup", workspaceIsolation: "Isolated workspaces", networkProfiles: "Network access",
  enabled: "Enabled", connection: "Connection", workingDirectory: "Working directory", socketPath: "Unix socket path",
  url: "WebSocket endpoint", authentication: "Capability token", secret: "Token source", path: "Token file reference",
  variable: "Token environment variable", executablePath: "Executable path", codexHome: "Codex home directory",
  tuiExecutablePath: "Codex TUI executable path", policy: "Execution policy",
  allowedSandboxModes: "Allowed filesystem access", allowedNetworkAccess: "Allowed network access",
  allowedApprovalPolicies: "Allowed approval policies", allowedApprovalReviewers: "Allowed approval reviewers",
  modelPolicy: "Models", allowed: "Rules", denied: "Rules", modelIds: "Model identifiers", providerIds: "Provider identifiers",
  reasoningEfforts: "Reasoning efforts", defaults: "Defaults", model: "Default model", modelId: "Default model identifier",
  reasoningEffort: "Default reasoning effort", effortId: "Reasoning effort identifier", sandboxMode: "Default filesystem access",
  networkAccess: "Default network access", approvalPolicy: "Default approval policy", approvalReviewer: "Default approval reviewer",
  permissionPolicy: "Permission policy", allowedModes: "Allowed permission modes", permissionMode: "Default permission mode",
  initializationTimeoutMs: "Initialization timeout", configDirectory: "Claude configuration directory",
  webSearch: "Research provider", grokHome: "Grok home directory", defaultTargetId: "Default connection",
};
/** Structural keys that name no user-facing part of the form. */
const silentKeys = new Set(["moduleConfiguration", "channel"]);

function sentenceCase(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lastNamedKey(path: readonly PathKey[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index--) if (typeof path[index] === "string") return path[index] as string;
  return undefined;
}

const atLeastOne: Record<string, string> = {
  workspaceRoots: "Add at least one workspace root.",
  enabledCapabilities: "Choose at least one operation, or turn sidecar operations off.",
  allowed: "Add at least one rule.", denied: "Add at least one rule.",
  modelIds: "Add at least one identifier.", providerIds: "Add at least one identifier.", reasoningEfforts: "Add at least one identifier.",
};
const unnamedRefinement: Record<string, string> = {
  workspaceRoots: "Each workspace root can be listed only once.",
  modelIds: "Each identifier can be listed only once.", providerIds: "Each identifier can be listed only once.",
  reasoningEfforts: "Each identifier can be listed only once.",
  label: "Remove control characters from the name.",
};
const formats: Record<string, string> = {
  hostAlias: "Use an SSH alias: letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit.",
};

/** Credential reference formats are distinct even though both schemas call the field `variable`. */
const credentialFormats: Readonly<Record<string, string>> = {
  [String(/^SEDES_CODEX_[A-Z0-9_]*TOKEN[A-Z0-9_]*$/)]: "Use an approved name that starts with SEDES_CODEX_ and contains TOKEN, such as SEDES_CODEX_REMOTE_TOKEN.",
  [String(/^SEDES_OPENCODE_[A-Z0-9_]*PASSWORD[A-Z0-9_]*$/u)]: "Use an approved name that starts with SEDES_OPENCODE_ and contains PASSWORD, such as SEDES_OPENCODE_REMOTE_PASSWORD.",
};

/** A readable message for one schema issue; Zod's generic wording never reaches the page. */
export function describeIssue(issue: ZodIssue): string {
  const key = lastNamedKey(issue.path);
  if (issue.code === "invalid_key") {
    // Record keys (variable names) carry their reason in the nested issues.
    const nested = issue.issues.find(entry => entry.code === "custom") ?? issue.issues[0];
    return nested ? describeIssue({ ...nested, path: issue.path } as ZodIssue) : "This name is not allowed.";
  }
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "array" || issue.origin === "set") return (key && atLeastOne[key]) ?? (issue.minimum === 1 ? "Add at least one entry." : `Add at least ${issue.minimum} entries.`);
      if (issue.origin === "string") return key === "label" ? "Enter a name." : "Enter a value.";
      if (issue.origin === "number") return key === "initializationTimeoutMs" ? `Use at least ${issue.minimum} ms.` : `Use at least ${issue.minimum}.`;
      return "Enter a value.";
    case "too_big":
      if (issue.origin === "array" || issue.origin === "set") return `Use at most ${issue.maximum} entries.`;
      if (issue.origin === "string") return `Use at most ${issue.maximum} characters.`;
      if (issue.origin === "number") return key === "initializationTimeoutMs" ? `Use at most ${issue.maximum} ms.` : `Use at most ${issue.maximum}.`;
      return "This value is too large.";
    case "invalid_format":
      if (key === "variable" && issue.pattern && credentialFormats[issue.pattern]) return credentialFormats[issue.pattern]!;
      if (key && formats[key]) return formats[key];
      return issue.format === "regex" ? "Use letters, digits and underscores, starting with a letter or underscore." : "Enter a value in the expected format.";
    case "custom":
      return issue.message && issue.message !== "Invalid input" ? issue.message : (key && unnamedRefinement[key]) ?? "This value isn't valid.";
    default:
      return "Choose a valid value.";
  }
}

export function validationIssues(error: Pick<ZodError, "issues">): ValidationIssue[] {
  return error.issues.map(issue => ({ path: issue.path, message: describeIssue(issue) }));
}

/** Describes a path relative to an item in words: "Workspace roots › entry 2". */
export function describePath(path: readonly PathKey[]): string | undefined {
  const parts: string[] = [];
  let previous: string | undefined;
  for (const segment of path) {
    if (typeof segment === "number") parts.push(previous === "allowed" || previous === "denied" ? `rule ${segment + 1}` : `entry ${segment + 1}`);
    else if (typeof segment === "string" && !silentKeys.has(segment)) {
      // Keys of a record (variable names) are shown as they are.
      parts.push(previous === "execution" || previous === "startup" ? segment : keyLabels[segment] ?? sentenceCase(segment));
    }
    if (typeof segment === "string") previous = segment;
  }
  return parts.length ? parts.join(" › ") : undefined;
}

function quoted(label: string | undefined, fallback: string): string {
  return label ? `“${label}”` : fallback;
}

/** Names a path of the whole configuration document, starting from the item it belongs to. */
export function describeDocumentPath(path: readonly PathKey[], document: Configuration): string | undefined {
  const [collection, index, ...rest] = path;
  const item = (label: string) => [label, describePath(rest)].filter(Boolean).join(" › ");
  if (collection === "executionEnvironments" && typeof index === "number") return item(`Environment ${quoted(document.executionEnvironments[index]?.label, "(new)")}`);
  if (collection === "backends" && typeof index === "number") return item(`Backend ${quoted(document.backends[index]?.label, "(new)")}`);
  if (collection === "targets" && typeof index === "number") return item(`Connection ${quoted(document.targets[index]?.label, "(new)")}`);
  return describePath(path);
}

/** The item a configuration editor saves: issues about it become field errors. */
export type EditedItem =
  | { readonly kind: "environment"; readonly id: string }
  | { readonly kind: "backend"; readonly id: string }
  | { readonly kind: "document" };

function joined(path: readonly PathKey[]): string {
  return path.map(segment => String(segment)).join(".");
}

/**
 * Splits the issues of a submitted configuration document into errors on
 * the edited item's fields and general errors. `fields` names the relative
 * paths the editor shows a control for; everything else, including issues
 * about other items, is described in words.
 *
 * Paths are resolved against the submitted `document`, so
 * `executionEnvironments.5.workspaceRoots.0` maps to the first workspace
 * root of the environment at index 5 only when that is the edited one.
 * Connection (target) paths are keyed by target id: `targets.<id>.label`.
 */
export function mapConfigurationIssues(issues: readonly ValidationIssue[], document: Configuration, edited: EditedItem, fields: RegExp): MappedErrors {
  const mapped = new Map<string, string>();
  const general: GeneralError[] = [];
  for (const issue of issues) {
    const relative = relativePath(issue.path, document, edited);
    const key = relative ? joined(relative) : undefined;
    if (key !== undefined && fields.test(key)) {
      if (!mapped.has(key)) mapped.set(key, issue.message);
      continue;
    }
    const location = relative ? describePath(relative) : describeDocumentPath(issue.path, document);
    general.push({ ...(location ? { location } : {}), message: issue.message });
  }
  return { fields: mapped.size ? new FieldErrors(mapped) : FieldErrors.none, general };
}

function relativePath(path: readonly PathKey[], document: Configuration, edited: EditedItem): PathKey[] | undefined {
  if (edited.kind === "document") return [...path];
  const [collection, index, ...rest] = path;
  if (typeof index !== "number") return undefined;
  if (edited.kind === "environment" && collection === "executionEnvironments") {
    return document.executionEnvironments[index]?.id === edited.id ? rest : undefined;
  }
  if (edited.kind === "backend" && collection === "backends") {
    return document.backends[index]?.id === edited.id ? rest : undefined;
  }
  if (edited.kind === "backend" && collection === "targets") {
    const target = document.targets[index];
    return target?.backendInstanceId === edited.id ? ["targets", target.id, ...rest] : undefined;
  }
  return undefined;
}

/** Errors about fields of a single request object, such as a host acceptance. */
export function mapRequestIssues(issues: readonly ValidationIssue[], fields: RegExp): MappedErrors {
  const mapped = new Map<string, string>();
  const general: GeneralError[] = [];
  for (const issue of issues) {
    const key = joined(issue.path);
    if (fields.test(key)) { if (!mapped.has(key)) mapped.set(key, issue.message); continue; }
    const location = describePath(issue.path);
    general.push({ ...(location ? { location } : {}), message: issue.message });
  }
  return { fields: mapped.size ? new FieldErrors(mapped) : FieldErrors.none, general };
}
