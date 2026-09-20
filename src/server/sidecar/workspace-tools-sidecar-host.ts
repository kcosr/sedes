import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  SidecarOperationError,
  workspaceToolsMutationInspectOperation,
  type WorkspaceToolsV2Handlers,
} from "../../internal/sidecar-protocol/index.js";
import { CanonicalMutationSerializer } from "../workspace-files/canonical-mutation-serializer.js";
import { WorkspaceToolError } from "../workspace-tools/contracts.js";
import { WorkspaceToolEngine } from "../workspace-tools/workspace-tool-engine.js";
import { TrustedSearchExecutableResolver } from "../workspace-tools/trusted-search-executables.js";

import { SidecarOperationReceipts } from "./sidecar-operation-receipts.js";

interface AdmittedWorkspace {
  readonly admissionId: string;
  readonly declaredPath: string;
  readonly policyRootPath: string;
  readonly engine: WorkspaceToolEngine;
}

/** Attachment-local workspace authority with service-owned mutation receipts. */
export class WorkspaceToolsSidecarHost {
  readonly handlers: WorkspaceToolsV2Handlers;
  readonly #sessionNonce: string;
  readonly #mutations: CanonicalMutationSerializer;
  readonly #search: TrustedSearchExecutableResolver;
  readonly #workspaces = new Map<string, AdmittedWorkspace>();
  readonly #admissions = new Map<string, string>();
  readonly #receipts = new SidecarOperationReceipts();
  readonly #opening = new Map<
    string,
    {
      readonly key: string;
      readonly promise: Promise<{ readonly workspaceHandle: string }>;
    }
  >();
  readonly #captureAdmission: () => () => void;
  #attachmentEpoch = 0;
  #closed = false;

  #admission(): () => void {
    const epoch = this.#attachmentEpoch;
    const assertExternal = this.#captureAdmission();
    return () => {
      if (epoch !== this.#attachmentEpoch)
        throw new SidecarOperationError("sidecar_controller_stale");
      assertExternal();
    };
  }

  constructor(input: {
    readonly sessionNonce: string;
    readonly mutations: CanonicalMutationSerializer;
    readonly search?: TrustedSearchExecutableResolver;
    readonly captureAdmission?: () => () => void;
  }) {
    this.#sessionNonce = input.sessionNonce;
    this.#captureAdmission = input.captureAdmission ?? (() => () => undefined);
    this.#mutations = input.mutations;
    this.#search = input.search ?? new TrustedSearchExecutableResolver();
    this.handlers = {
      mutationList: () => ({ operationIds: [...this.#receipts.ids()] }),
      mutationInspect: ({ operationId }) =>
        workspaceToolsMutationInspectOperation.responseSchema.parse(
          this.#receipts.inspect(operationId),
        ),
      mutationAcknowledge: ({ operationId }) => ({
        acknowledged: this.#receipts.acknowledge(operationId),
      }),
      openWorkspace: (request) => this.#guard(() => this.#open(request)),
      closeWorkspace: ({ workspaceHandle }) =>
        this.#guard(() => this.#closeWorkspace(workspaceHandle)),
      readFile: ({ workspaceHandle, ...request }, context) =>
        this.#guard(() =>
          this.#workspace(workspaceHandle).engine.read({
            ...request,
            signal: context.signal,
          }),
        ),
      writeFile: ({ workspaceHandle, operationId, ...request }, context) =>
        this.#guard(() =>
          this.#mutation(workspaceHandle, operationId, request, () =>
            this.#workspace(workspaceHandle).engine.write({
              ...request,
              signal: context.signal,
            }),
          ),
        ),
      editFile: ({ workspaceHandle, operationId, ...request }, context) =>
        this.#guard(() =>
          this.#mutation(workspaceHandle, operationId, request, () =>
            this.#workspace(workspaceHandle).engine.edit({
              ...request,
              signal: context.signal,
            }),
          ),
        ),
      listDirectory: ({ workspaceHandle, ...request }, context) =>
        this.#guard(() =>
          this.#workspace(workspaceHandle).engine.list({
            ...request,
            signal: context.signal,
          }),
        ),
      findFiles: ({ workspaceHandle, ...request }, context) =>
        this.#guard(() =>
          this.#workspace(workspaceHandle).engine.find({
            ...request,
            signal: context.signal,
          }),
        ),
      grepFiles: ({ workspaceHandle, ...request }, context) =>
        this.#guard(() =>
          this.#workspace(workspaceHandle).engine.grep({
            ...request,
            signal: context.signal,
          }),
        ),
    };
  }

  close(): void {
    this.#closed = true;
    this.#workspaces.clear();
    this.#admissions.clear();
    this.#opening.clear();
  }

  detach(): void {
    this.#attachmentEpoch += 1;
    this.#workspaces.clear();
    this.#admissions.clear();
    this.#opening.clear();
  }

  /** Resolve shell cwd authority while revalidating the canonical root. */
  async resolveWorkspace(workspaceHandle: string): Promise<string> {
    const workspace = this.#workspace(workspaceHandle);
    await workspace.engine.validateRoot();
    return workspace.declaredPath;
  }

  /** One service-owned admission ledger shared by write, edit, and shell. */
  admitOperation<T>(
    workspaceHandle: string,
    operationId: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#mutation(workspaceHandle, operationId, payload, operation);
  }

  async #open(request: {
    readonly admissionId: string;
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }) {
    const key = JSON.stringify(request);
    const pending = this.#opening.get(request.admissionId);
    if (pending) {
      if (pending.key !== key)
        throw new SidecarOperationError("workspace_tools_operation_id_reused");
      return await pending.promise;
    }
    if (this.#opening.size >= 1024)
      throw new SidecarOperationError(
        "sidecar_workspace_admission_capacity",
        true,
      );
    const promise = this.#openAdmitted(request);
    this.#opening.set(request.admissionId, { key, promise });
    try {
      return await promise;
    } finally {
      if (this.#opening.get(request.admissionId)?.promise === promise)
        this.#opening.delete(request.admissionId);
    }
  }

  async #openAdmitted(request: {
    readonly admissionId: string;
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }) {
    this.#assertOpen();
    const assertAdmission = this.#admission();
    assertAdmission();
    const existingHandle = this.#admissions.get(request.admissionId);
    if (existingHandle) {
      const existing = this.#workspaces.get(existingHandle);
      if (
        !existing ||
        existing.declaredPath !== request.declaredPath ||
        existing.policyRootPath !== request.policyRootPath
      )
        throw new SidecarOperationError("workspace_tools_operation_id_reused");
      return { workspaceHandle: existingHandle };
    }
    const [policy, workspace] = await Promise.all([
      canonicalDirectory(request.policyRootPath),
      canonicalDirectory(request.declaredPath),
    ]);
    if (
      policy !== request.policyRootPath ||
      workspace !== request.declaredPath ||
      !isWithin(policy, workspace)
    )
      throw new SidecarOperationError(
        "workspace_tools_workspace_outside_policy",
      );
    const workspaceHandle = randomUUID();
    const engine = new WorkspaceToolEngine({
      pathGrammar: "workspace_relative",
      root: {
        canonicalPath: workspace,
        homePath: homedir(),
        operationKey: `${this.#sessionNonce}\0${workspaceHandle}`,
      },
      mutations: this.#mutations,
      search: this.#search,
    });
    await engine.validateRoot();
    assertAdmission();
    if (this.#workspaces.size >= 1024)
      throw new SidecarOperationError("workspace_tools_unavailable", true);
    this.#workspaces.set(workspaceHandle, { ...request, engine });
    this.#admissions.set(request.admissionId, workspaceHandle);
    return { workspaceHandle };
  }

  #closeWorkspace(handle: string) {
    const workspace = this.#workspace(handle);
    this.#workspaces.delete(handle);
    this.#admissions.delete(workspace.admissionId);
    return { closed: true as const };
  }

  async #mutation<T>(
    workspaceHandle: string,
    operationId: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const maximumResultBytes =
        typeof payload === "object" && payload !== null && "edits" in payload
          ? 16 * 1024 * 1024
          : 8192;
      return await this.#receipts.run(
        operationId,
        { workspaceHandle, payload },
        () => this.#guard(operation),
        maximumResultBytes,
      );
    } catch (error) {
      if (
        error instanceof SidecarOperationError &&
        error.code === "sidecar_receipt_capacity"
      )
        throw new SidecarOperationError("workspace_tools_unavailable", true);
      if (
        error instanceof SidecarOperationError &&
        error.code === "sidecar_operation_id_reused"
      )
        throw new SidecarOperationError("workspace_tools_operation_id_reused");
      throw error;
    }
  }

  snapshot() {
    return this.#receipts.snapshot();
  }

  abandonmentEvidence() { return this.#receipts.abandonmentEvidence(); }
  async stop(force = false): Promise<void> {
    await this.#receipts.stop(force);
    this.close();
  }

  acknowledgeOperation(operationId: string): boolean {
    return this.#receipts.acknowledge(operationId);
  }

  #workspace(handle: string): AdmittedWorkspace {
    this.#assertOpen();
    const workspace = this.#workspaces.get(handle);
    if (!workspace)
      throw new SidecarOperationError(
        "workspace_tools_workspace_handle_invalid",
      );
    return workspace;
  }

  async #guard<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      this.#admission()();
      return await operation();
    } catch (error) {
      if (error instanceof SidecarOperationError) throw error;
      if (error instanceof WorkspaceToolError)
        throw new SidecarOperationError(error.code);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new SidecarOperationError("workspace_tools_unavailable");
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  const canonical = await realpath(value).catch(() => {
    throw new SidecarOperationError("workspace_tools_workspace_invalid");
  });
  const metadata = await stat(canonical).catch(() => {
    throw new SidecarOperationError("workspace_tools_workspace_invalid");
  });
  if (!metadata.isDirectory())
    throw new SidecarOperationError("workspace_tools_workspace_invalid");
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
