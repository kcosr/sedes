import { createHash } from "node:crypto";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  CodexTuiExitStatusV1,
  CodexTuiStateV1,
} from "./codex-tui-feature.js";
import { codexTuiDiagnostic } from "./codex-tui-feature.js";

const MAXIMUM_INPUT_BYTES = 64 * 1_024;
const MAXIMUM_OUTPUT_CHUNK_BYTES = 256 * 1_024;
const MINIMUM_TERMINAL_COLUMNS = 2;
const MAXIMUM_TERMINAL_COLUMNS = 512;
const MINIMUM_TERMINAL_ROWS = 1;
const MAXIMUM_TERMINAL_ROWS = 256;

export interface CodexManagedTuiBindingAuthority {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly workspaceId: string;
  readonly canonicalWorkspacePath: string;
  readonly opaqueBindingDetail: string;
  /** Ephemeral identity of the authoritative conversation runtime lease. */
  readonly runtimeLeaseId: string;
  readonly appServerGeneration: number;
}

export interface CodexManagedTuiProcess {
  readonly output: AsyncIterable<Uint8Array>;
  readonly closed: Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>;
  write(bytes: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface CodexManagedTuiLauncher {
  launch(input: {
    readonly authority: CodexManagedTuiBindingAuthority;
    readonly resourceGeneration: number;
    readonly signal: AbortSignal;
  }): Promise<CodexManagedTuiProcess>;
}

export interface CodexManagedTuiViewer {
  readonly viewerId: string;
  output(bytes: Uint8Array): void;
  stateChanged(state: CodexTuiStateV1): void;
  /** Recheck an enduring host's controller fence at the actual native write. */
  assertControl?(): void;
  transportLost?(): void;
}

export interface CodexManagedTuiViewerHandle {
  readonly resourceGeneration: number;
  input(bytes: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  requestSync(): Promise<{ readonly columns: number; readonly rows: number }>;
  requestRefit(
    columns: number,
    rows: number,
  ): Promise<{ readonly columns: number; readonly rows: number }>;
  detach(): void;
}

export type CodexManagedTuiRegistryAuthority = Pick<CodexManagedTuiRegistry, keyof CodexManagedTuiRegistry>;
export type CodexManagedTuiResourceSnapshot = Readonly<{
  authority: CodexManagedTuiBindingAuthority;
  revision: number;
  state: CodexTuiStateV1;
}>;

type Resource = {
  readonly key: string;
  readonly authority: CodexManagedTuiBindingAuthority;
  readonly bindingFingerprint: string;
  readonly resourceGeneration: number;
  readonly controller: AbortController;
  readonly viewers: Map<string, CodexManagedTuiViewer>;
  state: CodexTuiStateV1;
  process?: CodexManagedTuiProcess;
  stopRequested: boolean;
  revision: number;
  ioTail: Promise<void>;
  geometry: { columns: number; rows: number };
};

export class CodexManagedTuiRegistry {
  readonly #resources = new Map<string, Resource>();
  readonly #stateListeners = new Set<
    (authority: CodexManagedTuiBindingAuthority, state: CodexTuiStateV1) => void
  >();
  #nextResourceGeneration = 1;
  #nextRevision = 2;
  #closed = false;
  readonly #startupTimeoutMilliseconds: number;
  readonly #maximumResources: number;

  constructor(input?: { readonly startupTimeoutMilliseconds?: number; readonly maximumResources?: number }) {
    const timeout = input?.startupTimeoutMilliseconds ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000) {
      throw new Error("codex_tui_startup_timeout_invalid");
    }
    this.#startupTimeoutMilliseconds = timeout;
    this.#maximumResources = input?.maximumResources ?? 128;
    if (!Number.isSafeInteger(this.#maximumResources) || this.#maximumResources < 1 || this.#maximumResources > 128) {
      throw new Error("codex_tui_resource_limit_invalid");
    }
  }

  snapshot(): readonly CodexManagedTuiResourceSnapshot[] {
    return [...this.#resources.values()].map(resource => ({ authority: resource.authority, state: resource.state, revision: resource.revision }));
  }

  state(authority: CodexManagedTuiBindingAuthority): CodexTuiStateV1 {
    const resource = this.#resource(authority, false);
    return resource?.state ?? stoppedState;
  }

  projection(
    scope: RequestScope,
    applicationThreadId: string,
  ): { readonly revision: number; readonly state: CodexTuiStateV1 } {
    const resource = this.#resources.get(
      resourceKey(scope, applicationThreadId),
    );
    return resource
      ? { revision: resource.revision, state: resource.state }
      : { revision: 1, state: stoppedState };
  }

  runningGeneration(
    scope: RequestScope,
    applicationThreadId: string,
  ): number | undefined {
    const resource = this.#resources.get(
      resourceKey(scope, applicationThreadId),
    );
    return resource?.state.lifecycle === "running"
      ? resource.resourceGeneration
      : undefined;
  }

  runningAuthority(
    scope: RequestScope,
    applicationThreadId: string,
  ): CodexManagedTuiBindingAuthority | undefined {
    const resource = this.#resources.get(
      resourceKey(scope, applicationThreadId),
    );
    return resource?.state.lifecycle === "running"
      ? resource.authority
      : undefined;
  }

  attachScopedViewer(
    scope: RequestScope,
    applicationThreadId: string,
    expectedResourceGeneration: number,
    viewer: CodexManagedTuiViewer,
  ): CodexManagedTuiViewerHandle {
    const resource = this.#resources.get(
      resourceKey(scope, applicationThreadId),
    );
    if (!resource) throw new Error("codex_tui_stream_unavailable");
    return this.attachViewer(
      resource.authority,
      expectedResourceGeneration,
      viewer,
    );
  }

  subscribeState(
    listener: (
      authority: CodexManagedTuiBindingAuthority,
      state: CodexTuiStateV1,
    ) => void,
  ): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async start(
    authority: CodexManagedTuiBindingAuthority,
    launcher: CodexManagedTuiLauncher,
  ): Promise<CodexTuiStateV1> {
    this.#assertOpen();
    validateAuthority(authority);
    const key = resourceKey(authority.scope, authority.applicationThreadId);
    const existingAtKey = this.#resources.get(key);
    if (!existingAtKey && this.#resources.size >= this.#maximumResources) {
      const settled = [...this.#resources.values()].find(resource =>
        ["stopped", "exited"].includes(resource.state.lifecycle));
      if (settled) this.#resources.delete(settled.key);
      else throw new Error("codex_tui_resource_capacity_exceeded");
    }
    if (
      existingAtKey &&
      existingAtKey.bindingFingerprint !==
        codexManagedTuiBindingFingerprint(authority)
    ) {
      await this.#terminate(
        existingAtKey,
        "codex_tui_binding_replaced",
        "stopped",
      );
    }
    const existing = this.#resource(authority, false);
    if (
      existing &&
      (existing.state.lifecycle === "starting" ||
        existing.state.lifecycle === "running")
    ) {
      return existing.state;
    }
    if (existing)
      await this.#terminate(existing, "codex_tui_replaced", "stopped");

    const resourceGeneration = this.#nextResourceGeneration++;
    const resource: Resource = {
      key: resourceKey(authority.scope, authority.applicationThreadId),
      authority: freezeAuthority(authority),
      bindingFingerprint: codexManagedTuiBindingFingerprint(authority),
      resourceGeneration,
      controller: new AbortController(),
      viewers: new Map(),
      state: {
        lifecycle: "starting",
        resourceGeneration,
        streamAvailable: false,
      },
      stopRequested: false,
      revision: this.#nextRevision++,
      ioTail: Promise.resolve(),
      geometry: { columns: 120, rows: 40 },
    };
    this.#resources.set(resource.key, resource);
    this.#publish(resource);
    try {
      const launchPromise = launcher.launch({
        authority: resource.authority,
        resourceGeneration,
        signal: resource.controller.signal,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("codex_tui_startup_deadline_exceeded");
          resource.controller.abort(error);
          reject(error);
        }, this.#startupTimeoutMilliseconds);
        timer.unref?.();
      });
      let process: CodexManagedTuiProcess;
      try {
        process = await Promise.race([launchPromise, deadline]);
      } catch (error) {
        if (resource.controller.signal.aborted) {
          void launchPromise.then(
            async (lateProcess) => {
              await lateProcess.close("codex_tui_launch_deadline_exceeded");
            },
            () => undefined,
          );
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (
        this.#resources.get(resource.key) !== resource ||
        resource.stopRequested
      ) {
        await process.close("codex_tui_launch_stale");
        return resource.state;
      }
      resource.process = process;
      resource.state = {
        lifecycle: "running",
        resourceGeneration,
        streamAvailable: true,
      };
      this.#publish(resource);
      void this.#readOutput(resource, process);
      void process.closed.then(
        (status) => this.#processClosed(resource, status),
        () => this.#processClosed(resource, undefined),
      );
      return resource.state;
    } catch {
      if (this.#resources.get(resource.key) !== resource) return resource.state;
      resource.state = {
        lifecycle: "failed",
        resourceGeneration,
        streamAvailable: false,
        diagnostic: codexTuiDiagnostic(
          "The managed Codex TUI could not be started.",
        ),
      };
      this.#publish(resource);
      return resource.state;
    }
  }

  async stop(
    authority: CodexManagedTuiBindingAuthority,
  ): Promise<CodexTuiStateV1> {
    const resource = this.#resource(authority, true);
    if (!resource) return stoppedState;
    await this.#terminate(resource, "codex_tui_stopped", "stopped");
    return stoppedState;
  }

  async fail(
    authority: CodexManagedTuiBindingAuthority,
    diagnostic: string,
  ): Promise<CodexTuiStateV1> {
    const resource = this.#resource(authority, true);
    if (!resource) return stoppedState;
    await this.#terminate(resource, "codex_tui_failed", "failed", diagnostic);
    return resource.state;
  }

  /**
   * Releases the TUI owned by one authoritative conversation runtime. A stale
   * handle carries an older binding/app-server fingerprint and therefore
   * cannot stop a replacement resource.
   */
  async releaseRuntime(
    authority: CodexManagedTuiBindingAuthority,
  ): Promise<void> {
    const resource = this.#resource(authority, false);
    if (!resource) return;
    await this.#terminate(
      resource,
      "codex_tui_thread_runtime_released",
      "stopped",
    );
  }

  attachViewer(
    authority: CodexManagedTuiBindingAuthority,
    expectedResourceGeneration: number,
    viewer: CodexManagedTuiViewer,
  ): CodexManagedTuiViewerHandle {
    validateViewer(viewer);
    const resource = this.#resource(authority, true);
    if (
      !resource ||
      resource.state.lifecycle !== "running" ||
      resource.resourceGeneration !== expectedResourceGeneration ||
      !resource.process
    ) {
      throw new Error("codex_tui_stream_unavailable");
    }
    if (resource.viewers.has(viewer.viewerId)) {
      throw new Error("codex_tui_viewer_duplicate");
    }
    resource.viewers.set(viewer.viewerId, viewer);
    let attached = true;
    const requireAttached = (): CodexManagedTuiProcess => {
      viewer.assertControl?.();
      if (
        !attached ||
        this.#resources.get(resource.key) !== resource ||
        resource.state.lifecycle !== "running" ||
        !resource.process
      ) {
        throw new Error("codex_tui_viewer_detached");
      }
      return resource.process;
    };
    return {
      resourceGeneration: expectedResourceGeneration,
      input: async (bytes) => {
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > MAXIMUM_INPUT_BYTES
        ) {
          throw new Error("codex_tui_input_invalid");
        }
        const process = requireAttached();
        await serializeResourceIo(resource, async () => {
          if (requireAttached() !== process) {
            throw new Error("codex_tui_viewer_detached");
          }
          await process.write(Uint8Array.from(bytes));
        });
      },
      resize: async (columns, rows) => {
        validateGeometry(columns, rows);
        const process = requireAttached();
        await serializeResourceIo(resource, async () => {
          if (requireAttached() !== process) {
            throw new Error("codex_tui_viewer_detached");
          }
          await process.resize(columns, rows);
          resource.geometry = { columns, rows };
        });
      },
      requestSync: async () => {
        const process = requireAttached();
        return await serializeResourceIo(resource, async () => {
          if (requireAttached() !== process) {
            throw new Error("codex_tui_viewer_detached");
          }
          const current = resource.geometry;
          const jiggleColumns =
            current.columns < MAXIMUM_TERMINAL_COLUMNS
              ? current.columns + 1
              : current.columns - 1;
          await process.resize(jiggleColumns, current.rows);
          requireAttached();
          await process.resize(current.columns, current.rows);
          return { ...current };
        });
      },
      requestRefit: async (columns, rows) => {
        validateGeometry(columns, rows);
        const process = requireAttached();
        return await serializeResourceIo(resource, async () => {
          if (requireAttached() !== process) {
            throw new Error("codex_tui_viewer_detached");
          }
          await process.resize(columns, rows);
          requireAttached();
          resource.geometry = { columns, rows };
          const jiggleColumns =
            columns < MAXIMUM_TERMINAL_COLUMNS ? columns + 1 : columns - 1;
          await process.resize(jiggleColumns, rows);
          requireAttached();
          await process.resize(columns, rows);
          return { columns, rows };
        });
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        if (resource.viewers.get(viewer.viewerId) === viewer) {
          resource.viewers.delete(viewer.viewerId);
        }
      },
    };
  }

  async fenceAppServerGeneration(appServerGeneration: number): Promise<void> {
    if (!Number.isSafeInteger(appServerGeneration) || appServerGeneration < 0) {
      throw new Error("codex_tui_app_server_generation_invalid");
    }
    await Promise.all(
      [...this.#resources.values()]
        .filter(
          (resource) =>
            resource.authority.appServerGeneration !== appServerGeneration,
        )
        .map((resource) =>
          this.#terminate(
            resource,
            "codex_tui_app_server_generation_changed",
            "exited",
            "The Codex connection changed. Start a new TUI to reconnect.",
          ),
        ),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(
      [...this.#resources.values()].map((resource) =>
        this.#terminate(resource, "codex_tui_registry_closed", "stopped"),
      ),
    );
    this.#resources.clear();
    this.#stateListeners.clear();
  }

  async #readOutput(
    resource: Resource,
    process: CodexManagedTuiProcess,
  ): Promise<void> {
    try {
      for await (const bytes of process.output) {
        if (
          this.#resources.get(resource.key) !== resource ||
          resource.process !== process
        ) {
          return;
        }
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > MAXIMUM_OUTPUT_CHUNK_BYTES
        ) {
          await this.#terminate(
            resource,
            "codex_tui_output_invalid",
            "failed",
            "The managed Codex TUI produced an invalid output frame.",
          );
          return;
        }
        const stable = Uint8Array.from(bytes);
        for (const viewer of [...resource.viewers.values()]) {
          try {
            viewer.output(stable);
          } catch {
            resource.viewers.delete(viewer.viewerId);
          }
        }
      }
    } catch {
      await this.#terminate(
        resource,
        "codex_tui_output_failed",
        "failed",
        "The managed Codex TUI output stream failed.",
      );
    }
  }

  async #processClosed(
    resource: Resource,
    status:
      | { readonly exitCode: number | null; readonly signal: string | null }
      | undefined,
  ): Promise<void> {
    if (
      this.#resources.get(resource.key) !== resource ||
      resource.state.lifecycle === "stopped" ||
      resource.state.lifecycle === "exited" ||
      resource.state.lifecycle === "failed" ||
      resource.stopRequested
    ) {
      return;
    }
    const exitStatus = parseExitStatus(status);
    resource.process = undefined;
    resource.controller.abort(new Error("codex_tui_process_exited"));
    resource.state = {
      lifecycle: "exited",
      resourceGeneration: resource.resourceGeneration,
      streamAvailable: false,
      ...(exitStatus ? { exitStatus } : {}),
    };
    this.#publish(resource);
  }

  async #terminate(
    resource: Resource,
    reason: string,
    finalLifecycle: "stopped" | "exited" | "failed",
    diagnostic?: string,
  ): Promise<void> {
    if (this.#resources.get(resource.key) !== resource) return;
    resource.stopRequested = true;
    if (
      resource.state.lifecycle === "starting" ||
      resource.state.lifecycle === "running"
    ) {
      resource.state = {
        lifecycle: "stopping",
        resourceGeneration: resource.resourceGeneration,
        streamAvailable: false,
      };
      this.#publish(resource);
    }
    resource.controller.abort(new Error(reason));
    const process = resource.process;
    resource.process = undefined;
    if (process) await process.close(reason).catch(() => undefined);
    resource.viewers.clear();
    resource.state =
      finalLifecycle === "stopped"
        ? stoppedState
        : {
            lifecycle: finalLifecycle,
            resourceGeneration: resource.resourceGeneration,
            streamAvailable: false,
            ...(diagnostic
              ? { diagnostic: codexTuiDiagnostic(diagnostic) }
              : {}),
          };
    this.#publish(resource);
  }

  #resource(
    authority: CodexManagedTuiBindingAuthority,
    failOnMismatch: boolean,
  ): Resource | undefined {
    validateAuthority(authority);
    const resource = this.#resources.get(
      resourceKey(authority.scope, authority.applicationThreadId),
    );
    if (
      resource &&
      resource.bindingFingerprint !==
        codexManagedTuiBindingFingerprint(authority)
    ) {
      if (failOnMismatch) throw new Error("codex_tui_binding_conflict");
      return undefined;
    }
    return resource;
  }

  #publish(resource: Resource): void {
    resource.revision = this.#nextRevision++;
    for (const viewer of [...resource.viewers.values()]) {
      try {
        viewer.stateChanged(resource.state);
      } catch {
        resource.viewers.delete(viewer.viewerId);
      }
    }
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(resource.authority, resource.state);
      } catch {
        // State observers are diagnostics/projection hooks and cannot own the
        // provider-private managed process lifecycle.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("codex_tui_registry_closed");
  }
}

async function serializeResourceIo(
  resource: Resource,
  operation: () => Promise<void>,
): Promise<void>;
async function serializeResourceIo<T>(
  resource: Resource,
  operation: () => Promise<T>,
): Promise<T>;
async function serializeResourceIo<T>(
  resource: Resource,
  operation: () => Promise<T>,
): Promise<T> {
  const result = resource.ioTail.then(operation, operation);
  resource.ioTail = result.then(
    () => undefined,
    () => undefined,
  );
  return await result;
}

const stoppedState = Object.freeze({
  lifecycle: "stopped",
  resourceGeneration: null,
  streamAvailable: false,
} as const satisfies CodexTuiStateV1);

export function codexManagedTuiBindingFingerprint(
  authority: CodexManagedTuiBindingAuthority,
): string {
  validateAuthority(authority);
  return createHash("sha256")
    .update(
      JSON.stringify([
        authority.scope.tenantId,
        authority.scope.principalId,
        authority.applicationThreadId,
        authority.backendInstanceId,
        authority.connectionProfileId,
        authority.executionEnvironmentId,
        authority.backendConversationId,
        authority.workspaceId,
        authority.canonicalWorkspacePath,
        authority.opaqueBindingDetail,
        authority.runtimeLeaseId,
        authority.appServerGeneration,
      ]),
    )
    .digest("hex");
}

function resourceKey(scope: RequestScope, applicationThreadId: string): string {
  return JSON.stringify([
    scope.tenantId,
    scope.principalId,
    applicationThreadId,
  ]);
}

function validateAuthority(authority: CodexManagedTuiBindingAuthority): void {
  for (const value of [
    authority.scope.tenantId,
    authority.scope.principalId,
    authority.applicationThreadId,
    authority.backendInstanceId,
    authority.connectionProfileId,
    authority.executionEnvironmentId,
    authority.backendConversationId,
    authority.workspaceId,
    authority.canonicalWorkspacePath,
    authority.opaqueBindingDetail,
    authority.runtimeLeaseId,
  ]) {
    if (!value || value.length > 4_096)
      throw new Error("codex_tui_authority_invalid");
  }
  if (
    !Number.isSafeInteger(authority.appServerGeneration) ||
    authority.appServerGeneration <= 0
  ) {
    throw new Error("codex_tui_app_server_generation_invalid");
  }
}

function freezeAuthority(
  authority: CodexManagedTuiBindingAuthority,
): CodexManagedTuiBindingAuthority {
  return Object.freeze({
    ...authority,
    scope: Object.freeze({ ...authority.scope }),
  });
}

function validateViewer(viewer: CodexManagedTuiViewer): void {
  if (
    !viewer.viewerId ||
    viewer.viewerId.length > 128 ||
    typeof viewer.output !== "function" ||
    typeof viewer.stateChanged !== "function"
  ) {
    throw new Error("codex_tui_viewer_invalid");
  }
}

function validateGeometry(columns: number, rows: number): void {
  if (
    !Number.isSafeInteger(columns) ||
    columns < MINIMUM_TERMINAL_COLUMNS ||
    columns > MAXIMUM_TERMINAL_COLUMNS ||
    !Number.isSafeInteger(rows) ||
    rows < MINIMUM_TERMINAL_ROWS ||
    rows > MAXIMUM_TERMINAL_ROWS
  ) {
    throw new Error("codex_tui_geometry_invalid");
  }
}

function parseExitStatus(
  status:
    | { readonly exitCode: number | null; readonly signal: string | null }
    | undefined,
): CodexTuiExitStatusV1 | undefined {
  if (!status) return undefined;
  if (
    Number.isInteger(status.exitCode) &&
    status.exitCode! >= 0 &&
    status.exitCode! <= 255 &&
    status.signal === null
  ) {
    return { kind: "code", code: status.exitCode! };
  }
  if (
    status.exitCode === null &&
    typeof status.signal === "string" &&
    status.signal.length > 0 &&
    status.signal.length <= 32
  ) {
    return { kind: "signal", signal: status.signal };
  }
  return undefined;
}
