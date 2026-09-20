import type { BackendCatalog } from "../contracts.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";

const defaultFreshnessMilliseconds = 5_000;

interface CatalogEntry {
  readonly canonicalWorkspacePath: string;
  generation: number;
  expiresAt: number;
  value?: BackendCatalog;
  pending?: Promise<BackendCatalog>;
}

export interface PiCatalogServiceOptions {
  readonly owner: {
    readonly tenantId: string;
    readonly ownerPrincipalId: string;
    readonly backendInstanceId: string;
    readonly backendConfigurationRevision: number;
    readonly connectionProfileId: string;
    readonly connectionConfigurationRevision: number;
  };
  readonly freshnessMilliseconds?: number;
  readonly now?: () => number;
}

function cloneCatalog(catalog: BackendCatalog): BackendCatalog {
  return {
    models: catalog.models.map((model) => ({ ...model })),
    commands: catalog.commands.map((command) => ({ ...command })),
    skills: catalog.skills.map((skill) => ({ ...skill })),
    notices: catalog.notices.map((notice) => ({ ...notice })),
  };
}

function workspaceKey(
  owner: PiCatalogServiceOptions["owner"],
  workspace: ValidatedWorkspace,
): string {
  return JSON.stringify([
    owner.tenantId,
    owner.ownerPrincipalId,
    owner.backendInstanceId,
    owner.backendConfigurationRevision,
    owner.connectionProfileId,
    owner.connectionConfigurationRevision,
    workspace.summary.environmentId,
    workspace.summary.id,
    workspace.summary.revision,
    workspace.summary.trustState,
    workspace.canonicalPath,
  ]);
}

/**
 * Owns the bounded-lifetime Pi presentation catalog for one configured
 * connection-profile revision. Catalog construction loads Pi's complete
 * workspace resource stack, so callers share one in-flight/result value only
 * for an exact backend, profile, workspace, trust, and workspace-revision
 * identity.
 *
 * External resource edits are observed within the freshness bound. A resource
 * reload initiated by an attached Pi SDK session invalidates the workspace
 * immediately. Generation checks prevent a load that was invalidated while in
 * flight from being installed as the next cached value.
 */
export class PiCatalogService {
  readonly #owner: PiCatalogServiceOptions["owner"];
  readonly #freshnessMilliseconds: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CatalogEntry>();

  constructor(options: PiCatalogServiceOptions) {
    const freshnessMilliseconds =
      options.freshnessMilliseconds ?? defaultFreshnessMilliseconds;
    if (
      !Number.isSafeInteger(freshnessMilliseconds) ||
      freshnessMilliseconds < 0
    ) {
      throw new Error("pi_catalog_freshness_invalid");
    }
    this.#owner = { ...options.owner };
    this.#freshnessMilliseconds = freshnessMilliseconds;
    this.#now = options.now ?? Date.now;
  }

  read(
    workspace: ValidatedWorkspace,
    load: () => Promise<BackendCatalog>,
  ): Promise<BackendCatalog> {
    const key = workspaceKey(this.#owner, workspace);
    let entry = this.#entries.get(key);
    const now = this.#now();
    if (entry?.value && entry.expiresAt > now) {
      return Promise.resolve(entry.value);
    }
    if (entry?.value) {
      if (!entry.pending) {
        const refresh = this.#load(key, entry, workspace, load);
        void refresh.catch(() => undefined);
      }
      // Expiry triggers a background freshness check. Presentation remains
      // responsive with the last complete catalog until that check succeeds.
      return Promise.resolve(entry.value);
    }
    if (entry?.pending) return entry.pending;
    if (!entry) {
      this.#pruneWorkspace(workspace.canonicalPath, key);
      entry = {
        canonicalWorkspacePath: workspace.canonicalPath,
        generation: 0,
        expiresAt: 0,
      };
      this.#entries.set(key, entry);
    }
    return this.#load(key, entry, workspace, load);
  }

  #load(
    key: string,
    target: CatalogEntry,
    workspace: ValidatedWorkspace,
    load: () => Promise<BackendCatalog>,
  ): Promise<BackendCatalog> {
    const generation = target.generation;
    const pending = load()
      .then((catalog) => {
        const value = cloneCatalog(catalog);
        if (
          this.#entries.get(key) !== target ||
          target.generation !== generation
        ) {
          // An explicit reload invalidates both cache installation and
          // delivery. The caller receives a catalog from the new generation.
          return this.read(workspace, load);
        }
        target.value = value;
        target.expiresAt = this.#now() + this.#freshnessMilliseconds;
        return value;
      })
      .finally(() => {
        if (target.pending === pending) target.pending = undefined;
      });
    target.pending = pending;
    return pending;
  }

  invalidate(workspace: ValidatedWorkspace): void {
    const canonicalPath = workspace.canonicalPath;
    for (const [key, entry] of this.#entries) {
      if (entry.canonicalWorkspacePath !== canonicalPath) continue;
      entry.generation += 1;
      entry.value = undefined;
      entry.expiresAt = 0;
      entry.pending = undefined;
      this.#entries.delete(key);
    }
  }

  #pruneWorkspace(canonicalPath: string, retainedKey: string): void {
    for (const [key, entry] of this.#entries) {
      if (
        key === retainedKey ||
        entry.canonicalWorkspacePath !== canonicalPath
      ) {
        continue;
      }
      entry.generation += 1;
      entry.pending = undefined;
      this.#entries.delete(key);
    }
  }
}
