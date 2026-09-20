import { randomUUID } from "node:crypto";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  workspaceContextReadOperation,
  workspaceToolsDirectoryListOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
  workspaceToolsWorkspaceOpenOperation,
} from "../../internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import type { WorkspaceContextReader } from "../workspace-context/contracts.js";
import {
  WorkspaceToolError,
  WorkspaceToolOutcomeUnknownError,
  type WorkspaceToolExecutor,
} from "../workspace-tools/contracts.js";
import { SidecarWorkspaceShellExecutor } from "../workspace-tools/sidecar-workspace-shell-executor.js";
import { prepareSidecarWorkspaceToolPath } from "../workspace-tools/sidecar-workspace-path.js";
import { PI_SANDBOX_HOME, PI_SANDBOX_WORKSPACE } from "./contracts.js";

export interface PiSandboxWorkerOperationLease {
  readonly session: SidecarClientSession;
  readonly carrierGeneration: number;
  release(): void;
}

export interface PiSandboxWorkerOperationRuntime {
  acquireOperation(signal: AbortSignal): Promise<PiSandboxWorkerOperationLease>;
}

/** Every operation crosses the worker protocol; this class performs no file I/O. */
export class PiSandboxWorkspaceToolExecutor implements WorkspaceToolExecutor {
  readonly #admissionId = randomUUID();
  readonly #handles = new Map<number, string>();
  readonly #shell: SidecarWorkspaceShellExecutor;

  constructor(private readonly runtime: PiSandboxWorkerOperationRuntime) {
    this.#shell = new SidecarWorkspaceShellExecutor({
      acquireWorkspaceLease: (signal) => this.#acquireWorkspace(signal),
      // A worker is ephemeral. Inspect only its original session; acquiring
      // another worker cannot recover its shell receipts.
      acquireRecoveryLease: async (signal, session) => ({
        session,
        assertActive: () => signal.throwIfAborted(),
        release: () => undefined,
      }),
    });
  }

  read(input: Parameters<WorkspaceToolExecutor["read"]>[0]) {
    return this.#call(workspaceToolsFileReadOperation, input as never);
  }
  write(input: Parameters<WorkspaceToolExecutor["write"]>[0]) {
    return this.#call(
      workspaceToolsFileWriteOperation,
      { ...input, operationId: randomUUID() } as never,
      true,
    );
  }
  edit(input: Parameters<WorkspaceToolExecutor["edit"]>[0]) {
    return this.#call(
      workspaceToolsFileEditOperation,
      { ...input, edits: [...input.edits], operationId: randomUUID() } as never,
      true,
    );
  }
  list(input: Parameters<WorkspaceToolExecutor["list"]>[0]) {
    return this.#call(
      workspaceToolsDirectoryListOperation,
      input as never,
      false,
      true,
    );
  }
  find(input: Parameters<WorkspaceToolExecutor["find"]>[0]) {
    return this.#call(
      workspaceToolsSearchFindOperation,
      input as never,
      false,
      true,
    );
  }
  grep(input: Parameters<WorkspaceToolExecutor["grep"]>[0]) {
    return this.#call(
      workspaceToolsSearchGrepOperation,
      input as never,
      false,
      true,
    );
  }
  startShell(input: Parameters<WorkspaceToolExecutor["startShell"]>[0]) {
    return this.#shell.start(input);
  }

  async #acquireWorkspace(signal: AbortSignal) {
    const operationLease = await this.runtime.acquireOperation(signal);
    try {
      let workspaceHandle = this.#handles.get(operationLease.carrierGeneration);
      if (!workspaceHandle) {
        this.#handles.clear();
        ({ workspaceHandle } = await operationLease.session.call(
          workspaceToolsWorkspaceOpenOperation,
          {
            admissionId: this.#admissionId,
            declaredPath: PI_SANDBOX_HOME,
            policyRootPath: PI_SANDBOX_HOME,
          },
          { signal },
        ));
        this.#handles.set(operationLease.carrierGeneration, workspaceHandle);
      }
      return {
        ...operationLease,
        workspaceHandle,
      };
    } catch (error) {
      operationLease.release();
      throw new WorkspaceToolError("workspace_tools_unavailable", {
        cause: error,
      });
    }
  }

  async #call<Request extends object, Response>(
    definition: {
      readonly requestSchema: import("zod").ZodType<
        Request & { workspaceHandle: string }
      >;
      readonly responseSchema: import("zod").ZodType<Response>;
      readonly capabilityId: string;
      readonly majorVersion: number;
      readonly operation: string;
      readonly lane: "control" | "operation";
      readonly maximumDeadlineMilliseconds: number;
    },
    input: Request & { readonly signal?: AbortSignal; readonly path?: string },
    mutation = false,
    allowRoot = false,
  ): Promise<Response> {
    const { signal, ...request } = input;
    const requestPath = prepareSidecarWorkspaceToolPath(input.path, {
      workspacePath: PI_SANDBOX_HOME,
      allowRoot,
    })(PI_SANDBOX_HOME);
    const lease = await this.#acquireWorkspace(
      signal ?? new AbortController().signal,
    );
    try {
      return (await lease.session.call(
        definition as never,
        {
          ...request,
          path: requestPath,
          workspaceHandle: lease.workspaceHandle,
        } as never,
        ...(signal ? ([{ signal }] as const) : []),
      )) as Response;
    } catch (error) {
      if (
        mutation &&
        error instanceof SidecarProtocolDeliveryError &&
        error.delivery === "sent_outcome_unknown"
      ) {
        throw new WorkspaceToolOutcomeUnknownError({ cause: error });
      }
      if (error instanceof SidecarOperationError) {
        throw new WorkspaceToolError(error.code as never, { cause: error });
      }
      throw error;
    } finally {
      lease.release();
    }
  }
}

export class PiSandboxWorkspaceContextReader implements WorkspaceContextReader {
  readonly #admissionId = randomUUID();
  constructor(private readonly runtime: PiSandboxWorkerOperationRuntime) {}

  async read(signal?: AbortSignal) {
    const lease = await this.runtime.acquireOperation(
      signal ?? new AbortController().signal,
    );
    try {
      return await lease.session.call(
        workspaceContextReadOperation,
        {
          admissionId: this.#admissionId,
          declaredPath: PI_SANDBOX_WORKSPACE,
          policyRootPath: PI_SANDBOX_WORKSPACE,
        },
        ...(signal ? ([{ signal }] as const) : []),
      );
    } finally {
      lease.release();
    }
  }
}
