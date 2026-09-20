import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SidecarOperationDefinition, SidecarOperationRegistry } from "../../../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarResourceSnapshot } from "../../../../internal/sidecar-protocol/service-management-v1.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { RequestScope } from "../../../identity/identity-provider.js";
import type { SidecarRuntimeChannel } from "../../../sidecar/runtime-channel.js";
import { sidecarRuntimeBodySchema } from "../../../sidecar/runtime-body-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import type { CodexSharedClientFacade } from "../codex-client-facade.js";
import { CODEX_SANDBOX_MODES, CODEX_NETWORK_ACCESS_VALUES, CODEX_APPROVAL_POLICIES, CODEX_APPROVAL_REVIEWERS } from "../codex-execution-policy.js";
import { assertCodexLiveModelSelection } from "../codex-live-model-selection.js";
import { EnvironmentCodexManagedTuiLauncher, codexTuiLaunchPolicyRepresentable, type CodexManagedTuiLaunchSettings } from "../codex-managed-tui-launcher.js";
import {
  CodexManagedTuiRegistry, codexManagedTuiBindingFingerprint,
  type CodexManagedTuiBindingAuthority, type CodexManagedTuiLauncher, type CodexManagedTuiProcess,
  type CodexManagedTuiRegistryAuthority, type CodexManagedTuiResourceSnapshot,
  type CodexManagedTuiViewer, type CodexManagedTuiViewerHandle,
} from "../codex-managed-tui-registry.js";
import type { ResolvedCodexRuntimeConfiguration } from "../codex-runtime-config.js";
import { verifyCodexRuntimeVersion, type VerifiedCodexRuntimeVersion } from "../codex-release-guard.js";
import { codexServiceTierSelectionSchema } from "../codex-service-tier.js";
import { codexTuiStateV1Schema, type CodexTuiStateV1 } from "../codex-tui-feature.js";

const capability = { capabilityId: "codex_managed_tui", majorVersion: 1 } as const;
const id = z.string().min(1).max(256);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ tenantId: id, principalId: id });
const bindingSchema = z.strictObject({
  scope: scopeSchema, applicationThreadId: id, backendInstanceId: id, connectionProfileId: id,
  executionEnvironmentId: id, backendConversationId: id, workspaceId: id,
  canonicalWorkspacePath: z.string().min(1).max(4096), opaqueBindingDetail: z.string().min(1).max(4096),
  runtimeLeaseId: z.string().min(1).max(512), appServerGeneration: generation,
});
const settingsSchema = z.strictObject({
  model: id, reasoningEffort: id, serviceTier: codexServiceTierSelectionSchema,
  sandboxMode: z.enum(CODEX_SANDBOX_MODES), networkAccess: z.enum(CODEX_NETWORK_ACCESS_VALUES),
  approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES), approvalReviewer: z.enum(CODEX_APPROVAL_REVIEWERS),
});
const geometrySchema = z.strictObject({ columns: z.number().int().min(2).max(512), rows: z.number().int().min(1).max(256) });
const base = { runtimeId: id, controllerEpoch: generation };
const viewerBase = { ...base, viewerId: id };
const commandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.literal("attach") }),
  z.strictObject({ ...base, action: z.literal("detach") }),
  z.strictObject({ ...base, action: z.literal("start"), authority: bindingSchema, settings: settingsSchema, configuredExecutablePath: z.string().min(1).max(4096).optional() }),
  z.strictObject({ ...base, action: z.literal("stop"), authority: bindingSchema }),
  z.strictObject({ ...base, action: z.literal("fail"), authority: bindingSchema, diagnostic: z.string().min(1).max(400) }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.attach"), authority: bindingSchema, resourceGeneration: generation }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.detach") }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.input"), bytes: z.string().max(87_384) }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.resize"), geometry: geometrySchema }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.sync") }),
  z.strictObject({ ...viewerBase, action: z.literal("viewer.refit"), geometry: geometrySchema }),
]);
type Command = z.infer<typeof commandSchema>;
type CommandInput = Command extends infer C ? C extends Command ? Omit<C, "runtimeId" | "controllerEpoch"> : never : never;
const resourceSchema = z.strictObject({ authority: bindingSchema, state: codexTuiStateV1Schema, revision: generation });
const snapshotSchema = z.strictObject({ resources: z.array(resourceSchema).max(128), version: z.string().min(1).max(128).optional() });
const okSchema = z.strictObject({ ok: z.literal(true) });
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("state"), resource: resourceSchema }),
  z.strictObject({ type: z.literal("output"), viewerId: id, bytes: z.string().max(349_528) }),
  z.strictObject({ type: z.literal("assessment"), version: z.string().min(1).max(128) }),
]);
type TuiEvent = z.infer<typeof eventSchema>;
const eventDefinition = { ...capability, event: "tui.event", schema: z.strictObject({ runtimeId: id, body: sidecarRuntimeBodySchema }) };
export const codexManagedTuiOperation = {
  ...capability, operation: "tui.execute", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const codexManagedTuiControlOperation = { ...codexManagedTuiOperation,
  operation: "tui.control", lane: "control", maximumDeadlineMilliseconds: 30_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const codexManagedTuiOperations = [codexManagedTuiOperation, codexManagedTuiControlOperation] as const;
export const codexManagedTuiCapability = { ...capability, operations: [codexManagedTuiControlOperation.operation, codexManagedTuiOperation.operation] } as const;

export type CodexManagedTuiHostRuntime = Readonly<{
  configuration: ResolvedCodexRuntimeConfiguration;
  environmentChannel: ExecutionEnvironmentChannelProvider;
  environment: Readonly<Record<string, string | undefined>>;
  supervisor: Readonly<{ client: CodexSharedClientFacade }>;
}>;
type Host = {
  registry: CodexManagedTuiRegistry;
  runtime: CodexManagedTuiHostRuntime;
  processes: Set<CodexManagedTuiProcess>;
  processAuthorities: Map<CodexManagedTuiProcess, string>;
  launches: Set<Promise<CodexManagedTuiProcess>>;
  revision: number;
  stopping: boolean;
  cleanupUnproven: boolean;
  stopPromise?: Promise<void>;
  assessment?: VerifiedCodexRuntimeVersion;
  assessmentListeners: Set<(assessment: VerifiedCodexRuntimeVersion) => void>;
  removeLifecycle(): void;
  unregister(): void;
};

/** Sidecar-owned native TUI processes. The ordinary launcher retains executable
 * admission, account-owned authentication resolution, exact endpoint assurance,
 * managed keymap and execution settings. Main never receives endpoint secrets. */
export class CodexRuntimeManagedTuiHosts {
  readonly #hosts = new Map<string, Host>();
  readonly #admissionFrozen = new Map<string, symbol>();
  constructor(readonly input: {
    getRuntime(runtimeId: string): CodexManagedTuiHostRuntime;
    services: PersistentSidecarServiceRegistry;
    /** Deterministic process boundary for tests; production uses the native launcher. */
    createLauncher?(input: ConstructorParameters<typeof EnvironmentCodexManagedTuiLauncher>[0]): CodexManagedTuiLauncher;
  }) {}

  /** Read inventory without instantiating a host or registering a participant. */
  activity(runtimeId: string): Pick<SidecarResourceSnapshot, "state" | "revision" | "blockers"> {
    const host = this.#hosts.get(runtimeId);
    if (!host) return { state: "idle", revision: "0", blockers: [] };
    const live = host.processes.size > 0 || host.launches.size > 0 || host.registry.snapshot().some(resource => resource.state.lifecycle === "starting");
    const unknown = live && host.cleanupUnproven;
    return { revision: String(host.revision), state: unknown ? "unknown" : live ? "active" : "idle",
      blockers: unknown ? ["live_terminal", "cleanup_unproven"] : live ? ["live_terminal"] : [] };
  }

  /** Reversible admission fencing does not itself change the resource revision. */
  freezeAdmission(runtimeId: string): () => void {
    this.input.getRuntime(runtimeId);
    if (!this.#admissionFrozen.has(runtimeId) && this.#admissionFrozen.size >= 256) throw new Error("codex_tui_admission_fence_capacity_exceeded");
    const token = Symbol(runtimeId);
    this.#admissionFrozen.set(runtimeId, token);
    return () => { if (this.#admissionFrozen.get(runtimeId) === token) this.#admissionFrozen.delete(runtimeId); };
  }
  admissionFrozen(runtimeId: string): boolean { return this.#admissionFrozen.has(runtimeId); }
  /** Also release the fence after the owning runtime has positively retired. */
  restoreAdmission(runtimeId: string): void { this.#admissionFrozen.delete(runtimeId); }
  assertControl(runtimeId: string, controllerEpoch: number): void { this.#assertAdmission(runtimeId, controllerEpoch); }

  registry(runtimeId: string): CodexManagedTuiRegistry { return this.#host(runtimeId).registry; }
  snapshot(runtimeId: string): z.infer<typeof snapshotSchema> {
    const host = this.#host(runtimeId);
    return { resources: [...host.registry.snapshot()], ...(host.assessment ? { version: host.assessment.version } : {}) };
  }
  subscribeAssessment(runtimeId: string, listener: (assessment: VerifiedCodexRuntimeVersion) => void): () => void {
    const host = this.#host(runtimeId);
    host.assessmentListeners.add(listener);
    return () => { host.assessmentListeners.delete(listener); };
  }

  async start(runtimeId: string, authority: CodexManagedTuiBindingAuthority,
    settings: CodexManagedTuiLaunchSettings, configuredExecutablePath: string | undefined,
    controllerEpoch: number): Promise<CodexTuiStateV1> {
    this.#assertAdmission(runtimeId, controllerEpoch);
    const host = this.#host(runtimeId);
    this.#assertBinding(host, runtimeId, authority);
    settingsSchema.parse(settings);
    if (!codexTuiLaunchPolicyRepresentable(settings)) throw new Error("codex_tui_execution_policy_unrepresentable");
    const launcherInput: ConstructorParameters<typeof EnvironmentCodexManagedTuiLauncher>[0] = {
      channels: host.runtime.environmentChannel, configuration: host.runtime.configuration,
      environment: host.runtime.environment, ...(configuredExecutablePath ? { configuredExecutablePath } : {}),
      settings: () => settings,
      assertLaunchAdmission: () => this.#assertAdmission(runtimeId, controllerEpoch),
      validateModelSelection: async ({ authority: current, settings: selection, signal }) => {
        await assertCodexLiveModelSelection({ client: host.runtime.supervisor.client,
          expectedGeneration: current.appServerGeneration, model: selection.model,
          reasoningEffort: selection.reasoningEffort, signal });
        this.#assertAdmission(runtimeId, controllerEpoch);
      },
      onRuntimeVersionAssessment: assessment => {
        host.assessment = assessment;
        for (const listener of host.assessmentListeners) listener(assessment);
      },
    };
    const launcher = this.input.createLauncher?.(launcherInput) ?? new EnvironmentCodexManagedTuiLauncher(launcherInput);
    return await host.registry.start(authority, {
      launch: async launch => {
        this.#assertAdmission(runtimeId, controllerEpoch);
        const pending = launcher.launch(launch);
        host.launches.add(pending);
        host.revision++;
        try {
          const process = await pending;
          host.processes.add(process);
          host.processAuthorities.set(process, codexManagedTuiBindingFingerprint(authority));
          host.revision++;
          void process.closed.then(() => { host.processes.delete(process); host.processAuthorities.delete(process); host.revision++; }, () => { host.cleanupUnproven = true; host.revision++; });
          try { this.#assertAdmission(runtimeId, controllerEpoch); }
          catch (error) {
            try { await process.close("codex_tui_launch_admission_fenced"); await boundedCleanup(process.closed); }
            catch (cleanupError) { host.cleanupUnproven = true; host.revision++; throw cleanupError; }
            throw error;
          }
          return process;
        } finally { host.launches.delete(pending); host.revision++; }
      },
    });
  }

  assertBinding(runtimeId: string, authority: CodexManagedTuiBindingAuthority): void {
    this.#assertBinding(this.#host(runtimeId), runtimeId, authority);
  }

  async stopBinding(runtimeId: string, authority: CodexManagedTuiBindingAuthority, diagnostic?: string): Promise<CodexTuiStateV1> {
    const host = this.#host(runtimeId);
    this.#assertBinding(host, runtimeId, authority);
    const fingerprint = codexManagedTuiBindingFingerprint(authority);
    const state = diagnostic === undefined ? await host.registry.stop(authority) : await host.registry.fail(authority, diagnostic);
    try {
      await boundedCleanup(Promise.allSettled([...host.launches]));
      await boundedCleanup(Promise.all([...host.processes].filter(process => host.processAuthorities.get(process) === fingerprint).map(process => process.closed)));
    } catch (error) { host.cleanupUnproven = true; host.revision++; throw error; }
    return state;
  }

  /** Runtime retirement must call this before retiring the app-server. */
  async stopRuntime(runtimeId: string): Promise<void> {
    const host = this.#hosts.get(runtimeId);
    if (!host) return;
    host.stopPromise ??= this.#stopRuntime(runtimeId, host).catch(error => { host.cleanupUnproven = true; host.revision++; throw error; }).finally(() => { host.stopPromise = undefined; });
    return await host.stopPromise;
  }
  async #stopRuntime(runtimeId: string, host: Host): Promise<void> {
    host.stopping = true;
    await host.registry.close();
    await boundedCleanup(Promise.allSettled([...host.launches]));
    // Registry presentation may settle before process cleanup. Positive PTY
    // closure, rather than a swallowed close error, owns upgrade admission.
    await Promise.all([...host.processes].map(async process => {
      await process.close("codex_tui_runtime_stopped");
      await boundedCleanup(process.closed);
    }));
    host.removeLifecycle();
    host.unregister();
    this.#hosts.delete(runtimeId);
  }

  #host(runtimeId: string): Host {
    const known = this.#hosts.get(runtimeId);
    if (known) {
      if (known.stopping) throw new Error("codex_tui_runtime_stopping");
      return known;
    }
    if (this.#admissionFrozen.has(runtimeId)) throw new Error("codex_tui_admission_frozen");
    const runtime = this.input.getRuntime(runtimeId);
    if (runtime.configuration.connection.ownership !== "external") throw new Error("codex_tui_external_connection_required");
    if (this.#hosts.size >= 64) throw new Error("codex_tui_runtime_capacity_exceeded");
    const host: Host = { runtime, registry: new CodexManagedTuiRegistry(), processes: new Set(), processAuthorities: new Map(), launches: new Set(), revision: 1,
      stopping: false, cleanupUnproven: false, assessmentListeners: new Set(), removeLifecycle: () => {}, unregister: () => {} };
    host.registry.subscribeState(() => { host.revision++; });
    host.unregister = this.input.services.register({ resourceId: `codex-tui:${runtimeId}`, kind: "provider",
      snapshot: () => this.#hosts.has(runtimeId) ? this.activity(runtimeId) : { revision: String(host.revision), state: "idle", blockers: [] },
      stop: () => this.stopRuntime(runtimeId),
    });
    host.removeLifecycle = runtime.supervisor.client.subscribeLifecycle(lifecycle => {
      void host.registry.fenceAppServerGeneration(lifecycle.state === "ready" ? lifecycle.generation : 0);
    });
    this.#hosts.set(runtimeId, host);
    return host;
  }

  #assertBinding(host: Host, runtimeId: string, authority: CodexManagedTuiBindingAuthority): void {
    bindingSchema.parse(authority);
    const configuration = host.runtime.configuration;
    const current = host.runtime.supervisor.client.lifecycleSnapshot();
    if (authority.scope.tenantId !== configuration.scope.tenantId || authority.scope.principalId !== configuration.scope.principalId ||
      authority.backendInstanceId !== configuration.instance.id || authority.executionEnvironmentId !== configuration.executionEnvironmentId ||
      authority.runtimeLeaseId !== runtimeId || current.state !== "ready" || authority.appServerGeneration !== current.generation) {
      throw new Error("codex_tui_runtime_binding_denied");
    }
  }
  #assertAdmission(runtimeId: string, controllerEpoch: number): void {
    this.input.services.assertAdmission(controllerEpoch);
    if (this.#admissionFrozen.has(runtimeId) || this.#hosts.get(runtimeId)?.stopping) throw new Error("codex_tui_admission_frozen");
  }
}

/** One authenticated peer/controller attachment. Output is transient and bounded;
 * absent/slow consumers lose their viewer, never ownership of the native PTY. */
export function registerCodexManagedTuiHost(input: {
  hosts: CodexRuntimeManagedTuiHosts; registry: SidecarOperationRegistry; channel: SidecarRuntimeChannel;
  services: PersistentSidecarServiceRegistry; controllerEpoch: number;
}): () => void {
  const attached = new Map<string, () => void>();
  const viewers = new Map<string, { runtimeId: string; handle: CodexManagedTuiViewerHandle }>();
  let detached = false;
  let queuedBytes = 0;
  let queuedEvents = 0;
  let events = Promise.resolve();
  const detach = () => {
    if (detached) return;
    detached = true;
    for (const remove of attached.values()) remove();
    for (const viewer of viewers.values()) viewer.handle.detach();
    attached.clear(); viewers.clear();
  };
  const emit = (runtimeId: string, event: TuiEvent) => {
    if (detached) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (queuedBytes + bytes > 512 * 1024 || queuedEvents >= 128) { detach(); return; }
    queuedBytes += bytes; queuedEvents++;
    events = events.then(async () => {
      if (detached) return;
      const body = await input.channel.encodeBody(event);
      await input.channel.peer.sendEvent({ ...eventDefinition, payload: { runtimeId, body } });
    }).catch(detach).finally(() => { queuedBytes -= bytes; queuedEvents--; });
  };
  const execute = async (body: z.infer<typeof sidecarRuntimeBodySchema>, control: boolean) => {
    if (detached) throw new Error("codex_tui_attachment_detached");
    const command = commandSchema.parse(await input.channel.decodeBody(body));
    if (control === (command.action === "start")) throw new Error("codex_tui_control_lane_mismatch");
    if (command.controllerEpoch !== input.controllerEpoch) throw new Error("codex_tui_controller_stale");
    input.services.assertController(input.controllerEpoch);
    const registry = input.hosts.registry(command.runtimeId);
    let result: unknown = { ok: true };
    if ("authority" in command) input.hosts.assertBinding(command.runtimeId, command.authority);
    switch (command.action) {
      case "attach": {
        attached.get(command.runtimeId)?.();
        const removeState = registry.subscribeState(authority => {
          const projection = registry.projection(authority.scope, authority.applicationThreadId);
          emit(command.runtimeId, { type: "state", resource: { authority, ...projection } });
        });
        const removeAssessment = input.hosts.subscribeAssessment(command.runtimeId, assessment => emit(command.runtimeId, { type: "assessment", version: assessment.version }));
        attached.set(command.runtimeId, () => { removeState(); removeAssessment(); });
        result = input.hosts.snapshot(command.runtimeId); break;
      }
      case "detach": {
        attached.get(command.runtimeId)?.(); attached.delete(command.runtimeId);
        for (const [id, viewer] of viewers) if (viewer.runtimeId === command.runtimeId) { viewer.handle.detach(); viewers.delete(id); }
        break;
      }
      case "start":
        input.services.assertAdmission(input.controllerEpoch);
        result = await input.hosts.start(command.runtimeId, command.authority, command.settings, command.configuredExecutablePath, input.controllerEpoch); break;
      case "stop": result = await input.hosts.stopBinding(command.runtimeId, command.authority); break;
      case "fail": result = await input.hosts.stopBinding(command.runtimeId, command.authority, command.diagnostic); break;
      case "viewer.attach": {
        if (!attached.has(command.runtimeId)) throw new Error("codex_tui_not_attached");
        if (viewers.size >= 128 || viewers.has(command.viewerId)) throw new Error("codex_tui_viewer_capacity_exceeded");
        const handle = registry.attachViewer(command.authority, command.resourceGeneration, {
          viewerId: command.viewerId,
          assertControl: () => input.hosts.assertControl(command.runtimeId, input.controllerEpoch),
          output: bytes => emit(command.runtimeId, { type: "output", viewerId: command.viewerId, bytes: Buffer.from(bytes).toString("base64") }),
          stateChanged: () => {},
        });
        viewers.set(command.viewerId, { runtimeId: command.runtimeId, handle }); break;
      }
      case "viewer.detach": {
        const viewer = viewers.get(command.viewerId);
        if (viewer?.runtimeId === command.runtimeId) { viewer.handle.detach(); viewers.delete(command.viewerId); }
        break;
      }
      default: {
        input.hosts.assertControl(command.runtimeId, input.controllerEpoch);
        const viewer = viewers.get(command.viewerId);
        if (!viewer || viewer.runtimeId !== command.runtimeId) throw new Error("codex_tui_viewer_detached");
        switch (command.action) {
          case "viewer.input": await viewer.handle.input(decodeBytes(command.bytes, 64 * 1024)); break;
          case "viewer.resize": await viewer.handle.resize(command.geometry.columns, command.geometry.rows); break;
          case "viewer.sync": result = await viewer.handle.requestSync(); break;
          case "viewer.refit": result = await viewer.handle.requestRefit(command.geometry.columns, command.geometry.rows); break;
        }
      }
    }
    return await input.channel.encodeBody(result);
  };
  input.registry.register(codexManagedTuiOperation, body => execute(body, false));
  input.registry.register(codexManagedTuiControlOperation, body => execute(body, true));
  return detach;
}

export type CodexManagedTuiRuntimeAttachment = Readonly<{
  channel: SidecarRuntimeChannel; runtimeId: string; controllerEpoch: number;
  closed: Promise<unknown>; providerGeneration: number; generationOffset: number;
}>;

/** Main-side launch intent. All executable, PTY, credentials and endpoint work
 * occurs inside the sidecar's ordinary local launcher. */
export class CodexRuntimeManagedTuiLauncher implements CodexManagedTuiLauncher {
  constructor(readonly input: {
    settings(authority: CodexManagedTuiBindingAuthority): CodexManagedTuiLaunchSettings;
    configuredExecutablePath?: string;
    validateModelSelection(input: { authority: CodexManagedTuiBindingAuthority; settings: CodexManagedTuiLaunchSettings; signal: AbortSignal }): Promise<void>;
  }) {}
  async prepare(authority: CodexManagedTuiBindingAuthority): Promise<CodexManagedTuiLaunchSettings> {
    const settings = settingsSchema.parse(this.input.settings(authority));
    if (!codexTuiLaunchPolicyRepresentable(settings)) throw new Error("codex_tui_execution_policy_unrepresentable");
    await this.input.validateModelSelection({ authority, settings, signal: AbortSignal.timeout(10_000) });
    return settings;
  }
  async launch(): Promise<CodexManagedTuiProcess> { throw new Error("codex_tui_remote_registry_required"); }
}

/** Cached synchronous presentation with a typed remote resource controller.
 * A reconnect rebinds only presentation/epoch; the host keeps native processes,
 * geometry and resource generations. No PTY output history is mirrored here:
 * the existing managed-TUI repaint handshake reconstructs the viewer surface. */
export class CodexRuntimeManagedTuiRegistry implements CodexManagedTuiRegistryAuthority {
  readonly #resources = new Map<string, CodexManagedTuiResourceSnapshot>();
  readonly #listeners = new Set<(authority: CodexManagedTuiBindingAuthority, state: CodexTuiStateV1) => void>();
  readonly #viewers = new Map<string, { authority: CodexManagedTuiBindingAuthority; viewer: CodexManagedTuiViewer }>();
  #attachment: CodexManagedTuiRuntimeAttachment | undefined;
  #connecting: Promise<void> | undefined;
  #removeEvents: (() => void) | undefined;
  #closed = false;
  constructor(readonly input: { connect(): Promise<CodexManagedTuiRuntimeAttachment>; onError?(error: unknown): void;
    onRuntimeVersionAssessment?(assessment: VerifiedCodexRuntimeVersion): void }) {}

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("codex_tui_registry_closed");
    this.#connecting ??= this.#connect().finally(() => { this.#connecting = undefined; });
    return await this.#connecting;
  }
  async #connect(): Promise<void> {
    const attachment = await this.input.connect();
    if (!codexManagedTuiOperations.every(operation => attachment.channel.supportsOperation(operation))) throw new Error("codex_tui_runtime_unavailable");
    if (this.#closed) throw new Error("codex_tui_registry_closed");
    const current = this.#attachment;
    if (current?.runtimeId === attachment.runtimeId && current.channel === attachment.channel &&
      current.controllerEpoch === attachment.controllerEpoch && current.generationOffset === attachment.generationOffset) return;
    if (current) {
      this.#lost(current);
      // A reused carrier still owns the previous viewers and subscriptions.
      // Retirement can already have removed that runtime, making detach moot.
      if (current.channel === attachment.channel && current.controllerEpoch === attachment.controllerEpoch) {
        await this.#executeAttached(current, { action: "detach" }).catch(() => undefined);
      }
    }
    if (this.#closed) throw new Error("codex_tui_registry_closed");
    this.#attachment = attachment;
    let eventTail = Promise.resolve();
    let pendingEvents = 0;
    const buffered: TuiEvent[] = [];
    let installing = true;
    this.#removeEvents = attachment.channel.onEvent({ ...eventDefinition, listener: envelope => {
      if (envelope.runtimeId !== attachment.runtimeId || this.#attachment !== attachment) return;
      if (++pendingEvents > 128) { this.#lost(attachment); this.input.onError?.(new Error("codex_tui_event_capacity_exceeded")); return; }
      eventTail = eventTail.then(async () => {
        const event = eventSchema.parse(await attachment.channel.decodeBody(envelope.body));
        if (installing) {
          if (buffered.length >= 128) throw new Error("codex_tui_event_capacity_exceeded");
          buffered.push(event);
        } else this.#event(attachment, event);
      }).catch(error => { this.#lost(attachment); this.input.onError?.(error); }).finally(() => { pendingEvents--; });
    } });
    void attachment.closed.then(() => this.#lost(attachment), () => this.#lost(attachment));
    try {
      const snapshot = snapshotSchema.parse(await this.#executeAttached(attachment, { action: "attach" }));
      if (this.#attachment !== attachment) throw new Error("codex_tui_attachment_detached");
      this.#resources.clear();
      for (const resource of snapshot.resources) this.#state(attachment, resource);
      if (snapshot.version) this.input.onRuntimeVersionAssessment?.(verifyCodexRuntimeVersion(snapshot.version));
      await eventTail;
      installing = false;
      for (const event of buffered) this.#event(attachment, event);
    } catch (error) { this.#lost(attachment); throw error; }
  }

  snapshot(): readonly CodexManagedTuiResourceSnapshot[] { return [...this.#resources.values()]; }
  projection(scope: RequestScope, applicationThreadId: string): { readonly revision: number; readonly state: CodexTuiStateV1 } {
    const resource = this.#resources.get(resourceKey(scope, applicationThreadId));
    return resource ? { revision: resource.revision, state: resource.state } : { revision: 1, state: stoppedState };
  }
  state(authority: CodexManagedTuiBindingAuthority): CodexTuiStateV1 { return this.#resource(authority)?.state ?? stoppedState; }
  runningGeneration(scope: RequestScope, applicationThreadId: string): number | undefined {
    const state = this.projection(scope, applicationThreadId).state;
    return state.lifecycle === "running" && this.#attachment ? state.resourceGeneration ?? undefined : undefined;
  }
  runningAuthority(scope: RequestScope, applicationThreadId: string): CodexManagedTuiBindingAuthority | undefined {
    const value = this.#resources.get(resourceKey(scope, applicationThreadId));
    return value?.state.lifecycle === "running" && this.#attachment ? value.authority : undefined;
  }
  subscribeState(listener: (authority: CodexManagedTuiBindingAuthority, state: CodexTuiStateV1) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  async start(authority: CodexManagedTuiBindingAuthority, launcher: CodexManagedTuiLauncher): Promise<CodexTuiStateV1> {
    if (!(launcher instanceof CodexRuntimeManagedTuiLauncher)) throw new Error("codex_tui_remote_launcher_required");
    const settings = await launcher.prepare(authority);
    await this.connect();
    const remoteAuthority = this.#remote(authority);
    const state = codexTuiStateV1Schema.parse(await this.#execute({ action: "start", authority: remoteAuthority, settings,
      ...(launcher.input.configuredExecutablePath ? { configuredExecutablePath: launcher.input.configuredExecutablePath } : {}) }));
    // The state event owns its authoritative revision. Awaiting subsequent state
    // is unnecessary for the launch result; a direct refresh closes the race.
    await this.#refresh();
    return state;
  }
  async stop(authority: CodexManagedTuiBindingAuthority): Promise<CodexTuiStateV1> {
    await this.connect();
    const state = codexTuiStateV1Schema.parse(await this.#execute({ action: "stop", authority: this.#remote(authority) }));
    await this.#refresh(); return state;
  }
  async fail(authority: CodexManagedTuiBindingAuthority, diagnostic: string): Promise<CodexTuiStateV1> {
    await this.connect();
    const state = codexTuiStateV1Schema.parse(await this.#execute({ action: "fail", authority: this.#remote(authority), diagnostic }));
    await this.#refresh(); return state;
  }
  async releaseRuntime(_authority: CodexManagedTuiBindingAuthority): Promise<void> {
    // Main actor residency is not enduring provider-process ownership.
  }
  async fenceAppServerGeneration(appServerGeneration: number): Promise<void> {
    if (appServerGeneration > 0 && !this.#closed) await this.connect();
    // The host fences actual app-server generation changes. Main offsets and
    // disconnected lifecycle projections must never terminate a surviving PTY.
  }
  attachScopedViewer(scope: RequestScope, applicationThreadId: string, resourceGeneration: number, viewer: CodexManagedTuiViewer): CodexManagedTuiViewerHandle {
    const authority = this.runningAuthority(scope, applicationThreadId);
    if (!authority) throw new Error("codex_tui_stream_unavailable");
    return this.attachViewer(authority, resourceGeneration, viewer);
  }
  attachViewer(authority: CodexManagedTuiBindingAuthority, resourceGeneration: number, viewer: CodexManagedTuiViewer): CodexManagedTuiViewerHandle {
    if (this.#resource(authority)?.state.resourceGeneration !== resourceGeneration || !this.#attachment) throw new Error("codex_tui_stream_unavailable");
    if (this.#viewers.size >= 128) throw new Error("codex_tui_viewer_capacity_exceeded");
    const viewerId = randomUUID();
    const attachment = this.#attachment;
    this.#viewers.set(viewerId, { authority, viewer });
    let active = true;
    const ready = this.#executeAttached(attachment, { action: "viewer.attach", viewerId, authority: this.#remote(authority), resourceGeneration }).then(value => { okSchema.parse(value); });
    void ready.catch(error => { this.#viewers.delete(viewerId); this.input.onError?.(error); });
    const execute = async (command: CommandInput) => {
      await ready;
      if (!active || this.#attachment !== attachment) throw new Error("codex_tui_viewer_detached");
      return await this.#executeAttached(attachment, command);
    };
    return {
      resourceGeneration,
      input: async bytes => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024) throw new Error("codex_tui_input_invalid");
        okSchema.parse(await execute({ action: "viewer.input", viewerId, bytes: Buffer.from(bytes).toString("base64") }));
      },
      resize: async (columns, rows) => { okSchema.parse(await execute({ action: "viewer.resize", viewerId, geometry: geometrySchema.parse({ columns, rows }) })); },
      requestSync: async () => geometrySchema.parse(await execute({ action: "viewer.sync", viewerId })),
      requestRefit: async (columns, rows) => geometrySchema.parse(await execute({ action: "viewer.refit", viewerId, geometry: geometrySchema.parse({ columns, rows }) })),
      detach: () => {
        if (!active) return;
        active = false; this.#viewers.delete(viewerId);
        void ready.then(async () => {
          if (this.#attachment === attachment) await this.#executeAttached(attachment, { action: "viewer.detach", viewerId });
        }).catch(error => this.input.onError?.(error));
      },
    };
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const attachment = this.#attachment;
    if (attachment) {
      void this.#executeAttached(attachment, { action: "detach" }).catch(error => this.input.onError?.(error));
      this.#lost(attachment);
    }
    this.#resources.clear(); this.#listeners.clear();
  }
  async #refresh(): Promise<void> {
    const attachment = this.#attachment;
    if (!attachment) throw new Error("codex_tui_attachment_detached");
    const snapshot = snapshotSchema.parse(await this.#executeAttached(attachment, { action: "attach" }));
    for (const resource of snapshot.resources) this.#state(attachment, resource);
    if (snapshot.version) this.input.onRuntimeVersionAssessment?.(verifyCodexRuntimeVersion(snapshot.version));
  }
  async #execute(command: CommandInput): Promise<unknown> {
    await this.connect();
    return await this.#executeAttached(this.#attachment!, command);
  }
  async #executeAttached(attachment: CodexManagedTuiRuntimeAttachment, command: CommandInput): Promise<unknown> {
    const value = commandSchema.parse({ ...command, runtimeId: attachment.runtimeId, controllerEpoch: attachment.controllerEpoch });
    const request = await attachment.channel.encodeBody(value);
    const response = await attachment.channel.call(command.action === "start" ? codexManagedTuiOperation : codexManagedTuiControlOperation, request);
    return await attachment.channel.decodeBody(response);
  }
  #remote(authority: CodexManagedTuiBindingAuthority): CodexManagedTuiBindingAuthority {
    if (!this.#attachment) throw new Error("codex_tui_attachment_detached");
    return bindingSchema.parse({ ...authority, runtimeLeaseId: this.#attachment.runtimeId,
      appServerGeneration: authority.appServerGeneration - this.#attachment.generationOffset });
  }
  #resource(authority: CodexManagedTuiBindingAuthority): CodexManagedTuiResourceSnapshot | undefined {
    const value = this.#resources.get(resourceKey(authority.scope, authority.applicationThreadId));
    if (value && this.#attachment && codexManagedTuiBindingFingerprint({ ...authority, runtimeLeaseId: this.#attachment.runtimeId }) !== codexManagedTuiBindingFingerprint(value.authority)) {
      throw new Error("codex_tui_binding_conflict");
    }
    return value;
  }
  #state(attachment: CodexManagedTuiRuntimeAttachment, resource: CodexManagedTuiResourceSnapshot): void {
    if (this.#attachment !== attachment) return;
    const authority = { ...resource.authority, appServerGeneration: resource.authority.appServerGeneration + attachment.generationOffset };
    const key = resourceKey(authority.scope, authority.applicationThreadId);
    const previous = this.#resources.get(key);
    if (previous && previous.revision > resource.revision) return;
    if (!previous && this.#resources.size >= 128) {
      const settled = [...this.#resources].find(([, resource]) => ["stopped", "exited"].includes(resource.state.lifecycle));
      if (!settled) throw new Error("codex_tui_resource_capacity_exceeded");
      this.#resources.delete(settled[0]);
    }
    this.#resources.set(key, { ...resource, authority });
    for (const listener of this.#listeners) listener(authority, resource.state);
    for (const { authority: viewed, viewer } of this.#viewers.values()) {
      if (resourceKey(viewed.scope, viewed.applicationThreadId) === key) viewer.stateChanged(resource.state);
    }
  }
  #event(attachment: CodexManagedTuiRuntimeAttachment, event: TuiEvent): void {
    if (this.#attachment !== attachment) return;
    if (event.type === "state") this.#state(attachment, event.resource);
    else if (event.type === "assessment") this.input.onRuntimeVersionAssessment?.(verifyCodexRuntimeVersion(event.version));
    else this.#viewers.get(event.viewerId)?.viewer.output(decodeBytes(event.bytes, 256 * 1024));
  }
  #lost(attachment: CodexManagedTuiRuntimeAttachment): void {
    if (this.#attachment !== attachment) return;
    this.#attachment = undefined; this.#removeEvents?.(); this.#removeEvents = undefined;
    const viewers = [...this.#viewers.values()];
    this.#viewers.clear();
    for (const { viewer } of viewers) {
      try { viewer.transportLost?.(); } catch (error) { this.input.onError?.(error); }
    }
  }
}

const stoppedState = { lifecycle: "stopped", resourceGeneration: null, streamAvailable: false } as const;
function resourceKey(scope: RequestScope, applicationThreadId: string): string {
  return JSON.stringify([scope.tenantId, scope.principalId, applicationThreadId]);
}
function decodeBytes(encoded: string, maximumBytes: number): Uint8Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64") !== encoded) throw new Error("codex_tui_bytes_invalid");
  return bytes;
}
async function boundedCleanup(value: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([value, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("codex_tui_cleanup_unproven")), 10_000);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
