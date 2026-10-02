import type {
  InventoryProjectAssignment,
  InventoryRepository,
} from "../db/repositories/inventory-repository.js";
import type { ValidatedWorkspace } from "../execution/contracts.js";
import { DomainError } from "../domain/errors.js";
import type { ExecutionEnvironmentProvider } from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { callRuntime } from "../runtime/runtime-errors.js";
import { environmentAdmitsForegroundOperation } from "../domain/environment-operational-state.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../agent-tools/environment/environment-authority.js";

export type WorkspaceEnvironmentSummary = {
  readonly id: string;
  readonly label: string;
  readonly availability: "available" | "unavailable";
};

export type OpenedWorkspaceSummary = {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly label: string;
  readonly availability: "available" | "unavailable";
};

export interface WorkspaceApplicationPublication {
  handoffAuthoritativeReplacement(scope: RequestScope): void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("operation_aborted");
}

/**
 * Principal-scoped workspace discovery and admission shared by HTTP and
 * canonical agent tools. Execution-environment configuration remains operator
 * authority; this service only records an already-configured absolute path as
 * principal application state.
 */
export class WorkspaceApplicationService {
  constructor(
    readonly input: {
      readonly inventory: Pick<
        InventoryRepository,
        | "getEnvironment"
        | "listEnvironments"
        | "upsertWorkspace"
        | "getWorkspace"
        | "isWorkspaceRemoved"
        | "getProject"
      >;
      readonly execution: Pick<
        ExecutionEnvironmentProvider,
        "validateWorkspace"
      >;
      readonly publications: WorkspaceApplicationPublication;
      readonly discoverWorkspace?: (
        scope: RequestScope,
        workspaceId: string,
      ) => Promise<void>;
      readonly now?: () => number;
    },
  ) {}

  listEnvironments(
    scope: RequestScope,
  ): readonly WorkspaceEnvironmentSummary[] {
    return this.input.inventory
      .listEnvironments(scope)
      .map((environment) => ({
        id: environment.id,
        label: environment.label,
        availability: environmentAdmitsForegroundOperation(environment)
          ? ("available" as const)
          : ("unavailable" as const),
      }))
      .sort(
        (left, right) =>
          compareText(left.label, right.label) ||
          compareText(left.id, right.id),
      );
  }

  /**
   * Adds a directory as a location of the assigned project, or restores or
   * revalidates it when it is already a location. A known location keeps its
   * project; naming a different existing project is a conflict.
   */
  async openWorkspace(
    scope: RequestScope,
    request: {
      readonly environmentId: string;
      readonly path: string;
      readonly project: InventoryProjectAssignment;
    },
    signal = new AbortController().signal,
  ): Promise<OpenedWorkspaceSummary> {
    const validated = await this.#validate(scope, request, undefined, signal);
    return this.#admit(scope, validated, {
      project: request.project,
      restoreRemoved: true,
    });
  }

  /**
   * Agents cannot choose an existing project: a new directory becomes its own
   * project, and a known one keeps its project.
   */
  async openWorkspaceForAgent(
    scope: RequestScope,
    request: { readonly environmentId: string; readonly path: string },
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
    signal = new AbortController().signal,
  ): Promise<OpenedWorkspaceSummary> {
    requireAdmittedResource(environmentAuthority, {
      kind: "environment",
      id: request.environmentId,
      environmentId: request.environmentId,
    });
    const validated = await this.#validate(
      scope,
      request,
      environmentAuthority,
      signal,
    );
    return this.#admit(scope, validated, {
      project: { kind: "new", name: validated.summary.displayName },
      restoreRemoved: true,
    });
  }

  /**
   * Restores or revalidates one known location under its original identity.
   * The location never changes project here: the commit rechecks the
   * project it was validated for, and a directory that now resolves
   * elsewhere fails instead of becoming a new location.
   */
  async restoreLocation(
    scope: RequestScope,
    workspaceId: string,
    options: {
      /** Fails the restore if the location has moved to another project. */
      readonly expectedProjectId?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<OpenedWorkspaceSummary> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const current = this.input.inventory.getWorkspace(scope, workspaceId);
    if (options.expectedProjectId !== undefined && current.projectId !== options.expectedProjectId) {
      throw new DomainError(
        "conflict",
        "The location moved to another project. Refresh and try again.",
      );
    }
    if (
      this.input.inventory.isWorkspaceRemoved(scope, workspaceId) &&
      this.input.inventory.getProject(scope, current.projectId).removedAt !== null
    ) {
      throw new DomainError(
        "invalid_transition",
        "The project was removed. Restore it before restoring its locations.",
      );
    }
    const validated = await this.#validate(
      scope,
      { environmentId: current.environmentId, path: current.canonicalPath },
      undefined,
      signal,
    );
    if (validated.canonicalPath !== current.canonicalPath) {
      throw new DomainError(
        "conflict",
        "The location's directory now resolves to a different path. Add that directory as a location instead.",
      );
    }
    return this.#admit(scope, validated, {
      id: current.id,
      restoreRemoved: true,
      expectedProjectId: current.projectId,
    });
  }

  async #validate(
    scope: RequestScope,
    request: { readonly environmentId: string; readonly path: string },
    environmentAuthority: TrustedEnvironmentAuthorityGrant | undefined,
    signal: AbortSignal,
  ): Promise<ValidatedWorkspace> {
    throwIfAborted(signal);
    this.input.inventory.getEnvironment(scope, request.environmentId);
    const validated = await callRuntime(() =>
      this.input.execution.validateWorkspace(
        scope,
        request.environmentId,
        request.path,
      ),
    );
    throwIfAborted(signal);
    if (validated.summary.environmentId !== request.environmentId) {
      throw new DomainError(
        "conflict",
        "The validated workspace belongs to a different execution environment.",
      );
    }
    if (environmentAuthority) {
      requireAdmittedResource(environmentAuthority, {
        kind: "environment",
        id: validated.summary.environmentId,
        environmentId: validated.summary.environmentId,
      });
    }
    return validated;
  }

  #admit(
    scope: RequestScope,
    validated: ValidatedWorkspace,
    identity:
      | {
          readonly project: InventoryProjectAssignment;
          readonly restoreRemoved: true;
        }
      | {
          readonly id: string;
          readonly restoreRemoved: true;
          readonly expectedProjectId: string;
        },
  ): OpenedWorkspaceSummary {
    const workspace = this.input.inventory.upsertWorkspace(scope, {
      ...identity,
      environmentId: validated.summary.environmentId,
      canonicalPath: validated.canonicalPath,
      displayName: validated.summary.displayName,
      available: validated.summary.availability === "available",
      trustState: validated.summary.trustState,
      environmentConfigurationRevision: validated.authorityRevision,
      now: this.input.now?.() ?? Date.now(),
    });
    this.input.publications.handoffAuthoritativeReplacement(scope);
    void this.input
      .discoverWorkspace?.(scope, workspace.id)
      .catch(() => undefined);
    return {
      workspaceId: workspace.id,
      environmentId: workspace.environmentId,
      projectId: workspace.projectId,
      label: workspace.displayName,
      availability:
        workspace.availability === "available" ? "available" : "unavailable",
    };
  }
}
