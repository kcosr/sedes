import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
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
        "getEnvironment" | "listEnvironments" | "upsertWorkspace"
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

  async openWorkspace(
    scope: RequestScope,
    request: { readonly environmentId: string; readonly path: string },
    signal = new AbortController().signal,
  ): Promise<OpenedWorkspaceSummary> {
    return this.#openWorkspace(scope, request, undefined, signal);
  }

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
    return this.#openWorkspace(scope, request, environmentAuthority, signal);
  }

  async #openWorkspace(
    scope: RequestScope,
    request: { readonly environmentId: string; readonly path: string },
    environmentAuthority: TrustedEnvironmentAuthorityGrant | undefined,
    signal: AbortSignal,
  ): Promise<OpenedWorkspaceSummary> {
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
    const workspace = this.input.inventory.upsertWorkspace(scope, {
      restoreRemoved: true,
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
      label: workspace.displayName,
      availability:
        workspace.availability === "available" ? "available" : "unavailable",
    };
  }
}
