import { isUncertainSidecarMutationError } from "../../internal/sidecar-protocol/operation-outcome.js";
import { randomUUID } from "node:crypto";
import { isWithinRemoteRoot } from "../execution/remote-path.js";
import {
  SidecarOperationError,
  workspaceToolsDirectoryListOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsMutationAcknowledgeOperation,
  workspaceToolsMutationInspectOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
  workspaceToolsWorkspaceOpenOperation,
} from "../../internal/sidecar-protocol/index.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../sidecar/sidecar-runtime.js";
import {
  WorkspaceToolError,
  WorkspaceToolOutcomeUnknownError,
  type WorkspaceToolExecutor,
} from "./contracts.js";
import {
  SidecarWorkspaceShellExecutor,
  type SidecarWorkspaceShellProcess,
} from "./sidecar-workspace-shell-executor.js";

import { recoverSidecarOperation } from "../sidecar/sidecar-operation-recovery.js";
import { prepareSidecarWorkspaceToolPath } from "./sidecar-workspace-path.js";

export class SidecarWorkspaceToolExecutor implements WorkspaceToolExecutor {
  readonly #runtime: SidecarRuntimeOwner<SidecarClientSession>;
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #declaredPath: string;
  readonly #policyRootPath: string;
  readonly #admissionId = randomUUID();
  readonly #handles = new Map<number, string>();
  readonly #shell: SidecarWorkspaceShellExecutor;

  constructor(input: {
    readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }) {
    if (!isWithin(input.policyRootPath, input.declaredPath))
      throw new Error("sidecar_workspace_tool_configuration_invalid");
    this.#runtime = input.runtime;
    this.#scope = input.scope;
    this.#environmentId = input.environmentId;
    this.#declaredPath = input.declaredPath;
    this.#policyRootPath = input.policyRootPath;
    this.#shell = new SidecarWorkspaceShellExecutor({
      acquireWorkspaceLease: async (signal) =>
        await this.acquireWorkspaceLease(signal),
      acquireRecoveryLease: async (signal) => ({
        ...await this.#acquireRecoveryLease(signal),
        assertActive: () => this.#runtime.assertAutomaticRecoveryActive(
          this.#scope,
          this.#environmentId,
        ),
      }),
    });
  }

  async read(input: Parameters<WorkspaceToolExecutor["read"]>[0]) {
    return this.#call(workspaceToolsFileReadOperation, input as never);
  }
  async write(input: Parameters<WorkspaceToolExecutor["write"]>[0]) {
    return this.#call(
      workspaceToolsFileWriteOperation,
      {
        ...input,
        operationId: randomUUID(),
      } as never,
      true,
    );
  }
  async edit(input: Parameters<WorkspaceToolExecutor["edit"]>[0]) {
    return this.#call(
      workspaceToolsFileEditOperation,
      {
        ...input,
        edits: [...input.edits],
        operationId: randomUUID(),
      } as never,
      true,
    );
  }
  async list(input: Parameters<WorkspaceToolExecutor["list"]>[0]) {
    return this.#call(
      workspaceToolsDirectoryListOperation,
      input as never,
      false,
      true,
    );
  }
  async find(input: Parameters<WorkspaceToolExecutor["find"]>[0]) {
    return this.#call(
      workspaceToolsSearchFindOperation,
      input as never,
      false,
      true,
    );
  }
  async grep(input: Parameters<WorkspaceToolExecutor["grep"]>[0]) {
    return this.#call(
      workspaceToolsSearchGrepOperation,
      input as never,
      false,
      true,
    );
  }


  startShell(
    input: Parameters<SidecarWorkspaceShellExecutor["start"]>[0],
  ): Promise<SidecarWorkspaceShellProcess> {
    return this.#shell.start(input);
  }

  #acquireRecoveryLease(signal: AbortSignal) {
    return this.#runtime.acquireAutomaticRecovery(
      this.#scope,
      this.#environmentId,
      signal,
    );
  }

  /** Internal capability seam for the retained shell adapter. */
  async acquireWorkspaceLease(
    signal: AbortSignal,
  ): Promise<SidecarWorkspaceToolLease> {
    let lease:
      | Awaited<
          ReturnType<
            SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
          >
        >
      | undefined;
    try {
      lease = await this.#runtime.acquireOperation(
        this.#scope,
        this.#environmentId,
        signal,
      );
      let workspaceHandle = this.#handles.get(lease.carrierGeneration);
      if (!workspaceHandle) {
        this.#handles.clear();
        ({ workspaceHandle } = await lease.session.call(
          workspaceToolsWorkspaceOpenOperation,
          {
            admissionId: this.#admissionId,
            declaredPath: this.#declaredPath,
            policyRootPath: this.#policyRootPath,
          },
          { signal },
        ));
        this.#handles.set(lease.carrierGeneration, workspaceHandle);
      }
      return {
        session: lease.session,
        workspaceHandle,
        carrierGeneration: lease.carrierGeneration,
        release: lease.release,
      };
    } catch (error) {
      lease?.release();
      throw new WorkspaceToolError("workspace_tools_unavailable", {
        cause: error,
      });
    }
  }

  async #call<Req extends object, Res>(
    definition: {
      readonly requestSchema: import("zod").ZodType<
        Req & { workspaceHandle: string }
      >;
      readonly responseSchema: import("zod").ZodType<Res>;
      readonly capabilityId: string;
      readonly majorVersion: number;
      readonly operation: string;
      readonly lane: "control" | "operation";
      readonly maximumDeadlineMilliseconds: number;
    },
    input: Req & { readonly signal?: AbortSignal },
    mutating = false,
    allowRoot = false,
  ): Promise<Res> {
    const { signal, ...request } = input;
    const resolvePath = prepareSidecarWorkspaceToolPath(
      "path" in request ? request.path : undefined,
      { workspacePath: this.#declaredPath, allowRoot },
    );
    // Runtime acquisition and workspace admission establish authority only;
    // they do not deliver the requested mutation. Keep them outside the
    // mutation delivery boundary so an uncertain workspace.open can never be
    // misreported as an uncertain write/edit.
    const lease = await this.acquireWorkspaceLease(
      signal ?? new AbortController().signal,
    );
    try {
      const relativePath = resolvePath(lease.session.accountHome);
      const result = (await lease.session
        .call(
          definition as never,
          {
            ...request,
            path: relativePath,
            workspaceHandle: lease.workspaceHandle,
          } as never,
          ...callOptions(signal),
        )
        .catch(async (error: unknown) => {
          if (
            !mutating ||
            !("operationId" in request) ||
            typeof request.operationId !== "string"
          )
            throw error;
          return await recoverSidecarOperation({
            error,
            operationId: request.operationId,
            resultSchema: definition.responseSchema,
            inspect: workspaceToolsMutationInspectOperation,
            acquire: () =>
              this.#acquireRecoveryLease(new AbortController().signal),
          });
        })) as Res;
      if (
        mutating &&
        "operationId" in request &&
        typeof request.operationId === "string"
      )
        await lease.session
          .call(workspaceToolsMutationAcknowledgeOperation, {
            operationId: request.operationId,
          })
          .catch(() => undefined);
      return result;
    } catch (error) {
      if (
        mutating &&
        error instanceof SidecarOperationError &&
        !isUncertainSidecarMutationError(error) &&
        "operationId" in request &&
        typeof request.operationId === "string"
      ) {
        await lease.session
          .call(workspaceToolsMutationAcknowledgeOperation, {
            operationId: request.operationId,
          })
          .catch(() => undefined);
      }
      if (mutating && isUncertainSidecarMutationError(error)) {
        throw new WorkspaceToolOutcomeUnknownError({ cause: error });
      }
      throw mapError(error);
    } finally {
      lease.release();
    }
  }
}

export interface SidecarWorkspaceToolLease {
  readonly session: SidecarClientSession;
  readonly workspaceHandle: string;
  readonly carrierGeneration: number;
  release(): void;
}

function callOptions(
  signal?: AbortSignal,
): [] | [{ readonly signal: AbortSignal }] {
  return signal ? [{ signal }] : [];
}
function mapError(error: unknown): Error {
  return error instanceof SidecarOperationError
    ? new WorkspaceToolError(error.code as never, { cause: error })
    : error instanceof Error
      ? error
      : new WorkspaceToolError("workspace_tools_unavailable");
}
function isWithin(root: string, candidate: string): boolean {
  return isWithinRemoteRoot(candidate, root);
}
