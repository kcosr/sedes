import { realpath, stat } from "node:fs/promises";
import { DomainError } from "../domain/errors.js";
import type { ThreadWorkspaceIsolationResolver } from "../execution/thread-workspace-isolation.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { LocalPiSandboxRuntime } from "./local-pi-sandbox-runtime.js";
import type {
  PiSandboxAllocationRecord,
  PiSandboxAllocationRepository,
} from "./pi-sandbox-allocation-repository.js";
import { piSandboxEffectiveWorkspacePath } from "./pi-sandbox-allocation-repository.js";
import type { PiSandboxMaterializer } from "./pi-sandbox-materializer.js";

function assertAllocationAuthority(
  scope: RequestScope,
  sourceWorkspace: Parameters<
    ThreadWorkspaceIsolationResolver["resolve"]
  >[0]["sourceWorkspace"],
  allocation: PiSandboxAllocationRecord,
): void {
  if (
    allocation.tenantId !== scope.tenantId ||
    allocation.ownerPrincipalId !== scope.principalId ||
    allocation.sourceWorkspaceId !== sourceWorkspace.summary.id ||
    allocation.executionEnvironmentId !==
      sourceWorkspace.summary.environmentId ||
    allocation.sourceCanonicalPath !== sourceWorkspace.canonicalPath
  ) {
    throw new DomainError(
      "conflict",
      "The isolated workspace does not match the thread source workspace.",
    );
  }
}

async function validatedPassivePath(
  allocation: PiSandboxAllocationRecord,
): Promise<string> {
  if (
    allocation.state !== "ready" ||
    allocation.retention === "delete_requested"
  ) {
    throw new DomainError(
      "runtime_unavailable",
      "The isolated workspace is not ready for passive access.",
      true,
    );
  }
  try {
    const effectivePath = piSandboxEffectiveWorkspacePath(allocation);
    const canonicalPath = await realpath(effectivePath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory() || canonicalPath !== effectivePath) {
      throw new Error("pi_sandbox_workspace_path_invalid");
    }
    return canonicalPath;
  } catch (cause) {
    throw new DomainError(
      "runtime_unavailable",
      "The isolated workspace path is unavailable.",
      true,
      { cause },
    );
  }
}

/** Local composition of durable allocation, lazy clone materialization, and worker ownership. */
export class LocalThreadWorkspaceIsolationResolver implements ThreadWorkspaceIsolationResolver {
  readonly #materializations = new Map<
    string,
    Promise<PiSandboxAllocationRecord>
  >();

  constructor(
    readonly input: {
      readonly allocations: Pick<PiSandboxAllocationRepository, "getForThread">;
      readonly materializer: Pick<PiSandboxMaterializer, "materialize">;
      readonly runtime: Pick<LocalPiSandboxRuntime, "acquire">;
      readonly backendInstanceId: string;
      readonly admittedNetworkProfiles: ReadonlySet<
        "isolated" | "execution_host"
      >;
    },
  ) {}

  isSelected(
    input: Parameters<ThreadWorkspaceIsolationResolver["isSelected"]>[0],
  ): boolean {
    const allocation = this.input.allocations.getForThread(
      input.scope,
      input.applicationThreadId,
    );
    if (!allocation) return false;
    this.#assertAuthority(input.scope, input.sourceWorkspace, allocation);
    return true;
  }

  async resolve(
    input: Parameters<ThreadWorkspaceIsolationResolver["resolve"]>[0],
  ): Promise<Awaited<ReturnType<ThreadWorkspaceIsolationResolver["resolve"]>>> {
    const allocation = this.input.allocations.getForThread(
      input.scope,
      input.applicationThreadId,
    );
    if (!allocation) return undefined;
    this.#assertAuthority(input.scope, input.sourceWorkspace, allocation);
    if (input.access === "passive") {
      const canonicalPath = await validatedPassivePath(allocation);
      return {
        access: "passive",
        workspaceAccess:
          allocation.workspaceAccess === "read_only"
            ? "read_only"
            : "read_write",
        effectiveWorkspace: {
          ...input.sourceWorkspace,
          canonicalPath,
        },
        async release() {},
      };
    }
    const ready = await this.#ready(input.scope, allocation);
    if (input.access === "prepare") {
      const canonicalPath = await validatedPassivePath(ready);
      return {
        access: "prepare",
        workspaceAccess:
          ready.workspaceAccess === "read_only" ? "read_only" : "read_write",
        effectiveWorkspace: {
          ...input.sourceWorkspace,
          canonicalPath,
        },
        async release() {},
      };
    }
    const lease = await this.input.runtime.acquire({
      allocationId: ready.allocationId,
      scope: {
        ...input.scope,
        backendInstanceId: this.input.backendInstanceId,
        executionEnvironmentId: ready.executionEnvironmentId,
      },
      applicationThreadId: ready.applicationThreadId,
      sourceWorkspaceId: ready.sourceWorkspaceId,
      hostHomePath: ready.homePath,
      hostWorkspacePath: piSandboxEffectiveWorkspacePath(ready),
      serviceCwd: piSandboxEffectiveWorkspacePath(ready),
      networkMode: ready.networkProfile,
      workspaceAccess: ready.workspaceAccess,
    });
    return {
      access: "active",
      workspaceAccess:
        ready.workspaceAccess === "read_only" ? "read_only" : "read_write",
      effectiveWorkspace: {
        ...input.sourceWorkspace,
        canonicalPath: piSandboxEffectiveWorkspacePath(ready),
      },
      semanticCwd: lease.semanticCwd,
      serviceCwd: lease.serviceCwd,
      executor: lease.executor,
      contextReader: lease.contextReader,
      environmentLabel: lease.environmentLabel,
      release: () => lease.release(),
    };
  }

  async #ready(
    scope: RequestScope,
    allocation: PiSandboxAllocationRecord,
  ): Promise<PiSandboxAllocationRecord> {
    if (
      allocation.state === "ready" &&
      allocation.retention !== "delete_requested"
    ) {
      return allocation;
    }
    if (
      allocation.retention === "delete_requested" ||
      allocation.state === "deleting" ||
      allocation.state === "delete_failed" ||
      allocation.state === "deleted"
    ) {
      throw new DomainError(
        "runtime_unavailable",
        "The isolated workspace is unavailable.",
        true,
      );
    }
    const key = `${scope.tenantId}\0${scope.principalId}\0${allocation.applicationThreadId}`;
    let pending = this.#materializations.get(key);
    if (!pending) {
      if (allocation.state === "materializing") {
        throw new DomainError(
          "runtime_unavailable",
          "The isolated workspace has an unresolved materialization.",
          true,
        );
      }
      pending = this.input.materializer.materialize(
        scope,
        allocation.applicationThreadId,
        { expectedRevision: allocation.revision },
      );
      this.#materializations.set(key, pending);
      void pending.then(
        () => this.#materializations.delete(key),
        () => this.#materializations.delete(key),
      );
    }
    const result = await pending;
    if (result.state !== "ready") {
      throw new DomainError(
        "runtime_unavailable",
        "The isolated workspace could not be materialized.",
        true,
      );
    }
    return result;
  }

  #assertAuthority(
    scope: RequestScope,
    sourceWorkspace: Parameters<
      ThreadWorkspaceIsolationResolver["resolve"]
    >[0]["sourceWorkspace"],
    allocation: PiSandboxAllocationRecord,
  ): void {
    assertAllocationAuthority(scope, sourceWorkspace, allocation);
    if (!this.input.admittedNetworkProfiles.has(allocation.networkProfile)) {
      throw new DomainError(
        "runtime_unavailable",
        "The isolated workspace network profile is no longer admitted.",
        true,
      );
    }
  }
}

/** Preserves fail-closed selection semantics when local isolation preflight fails. */
export class UnavailableThreadWorkspaceIsolationResolver implements ThreadWorkspaceIsolationResolver {
  constructor(
    readonly allocations: Pick<PiSandboxAllocationRepository, "getForThread">,
  ) {}

  isSelected(
    input: Parameters<ThreadWorkspaceIsolationResolver["isSelected"]>[0],
  ): boolean {
    const allocation = this.allocations.getForThread(
      input.scope,
      input.applicationThreadId,
    );
    if (!allocation) return false;
    assertAllocationAuthority(input.scope, input.sourceWorkspace, allocation);
    return true;
  }

  async resolve(
    input: Parameters<ThreadWorkspaceIsolationResolver["resolve"]>[0],
  ): Promise<Awaited<ReturnType<ThreadWorkspaceIsolationResolver["resolve"]>>> {
    const allocation = this.allocations.getForThread(
      input.scope,
      input.applicationThreadId,
    );
    if (!allocation) return undefined;
    assertAllocationAuthority(input.scope, input.sourceWorkspace, allocation);
    if (input.access === "passive") {
      const canonicalPath = await validatedPassivePath(allocation);
      return {
        access: "passive",
        workspaceAccess:
          allocation.workspaceAccess === "read_only"
            ? "read_only"
            : "read_write",
        effectiveWorkspace: {
          ...input.sourceWorkspace,
          canonicalPath,
        },
        async release() {},
      };
    }
    throw new DomainError(
      "runtime_unavailable",
      "The isolated workspace runtime is unavailable.",
      true,
    );
  }
}
