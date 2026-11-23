import { SidecarOperationError } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { observedLaunchDigest, type ProviderLaunchAdmission } from "../../provider-policy-admission.js";
import { configurationFingerprint } from "../../../config/configuration-fingerprint.js";
import type { EnvironmentVariableOverrides } from "../../../../shared/protocol/environment-variables.js";
import type { SidecarUpgradeBlocker } from "../../../../internal/sidecar-protocol/service-management-v1.js";
import path from "node:path";
import { homedir } from "node:os";
import { canonicalLocalEnvironmentDirectorySync } from "../../../execution/local-environment-channel.js";
import { createHash, randomUUID } from "node:crypto";
import type { ResolvedCodexRuntimeConfiguration } from "../codex-runtime-config.js";
import type { RequestScope } from "../../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import { SidecarResourceHandoffPendingError } from "../../../sidecar/persistent-sidecar-service-registry.js";
import type { AgentBackendInstance, AgentConnectionProfile } from "../../contracts.js";
import type { CodexBackendModuleConfiguration } from "../codex-backend-configuration.js";
import { CodexNativeStoreOwnershipGate } from "../codex-native-store-ownership.js";
import { createCodexNativeStoreLifecycle, type CodexSidecarStoreContext } from "../codex-native-store-lock.js";
import { resolveCodexRuntimeConfiguration } from "../codex-runtime-config.js";
import { CodexDaemonSupervisor } from "../codex-daemon-supervisor.js";
import { createCodexRuntimeTransport } from "./codex-runtime-transport.js";
import { CodexRuntimeHost } from "./codex-runtime-host.js";
import { CodexRuntimeManagedTuiHosts } from "./codex-runtime-managed-tui.js";

export type CodexRuntimeConfiguration = Readonly<{
  startupEnvironmentVariables?: EnvironmentVariableOverrides;
  instance: AgentBackendInstance;
  connections: readonly AgentConnectionProfile[];
  connection: CodexBackendModuleConfiguration["connection"];
}>;
export type CodexHostedRuntime = { configuration: ResolvedCodexRuntimeConfiguration; environmentChannel: ExecutionEnvironmentChannelProvider; environment: Readonly<Record<string, string | undefined>>; host: CodexRuntimeHost; fingerprint: string; storeFingerprint: string; startupEnvironmentFingerprint: string; supervisor: CodexDaemonSupervisor; stop(reason?: string, force?: boolean): Promise<void> };

/** One execution-host registry, retained across attachment replacement. Raw
 * definitions resolve here using this host's environment, credentials and
 * native-store lock. Main-server paths/environment never enter launch. */
export class CodexRuntimeHostRegistry {
  readonly #runtimes = new Map<string, CodexHostedRuntime>();
  readonly #starting = new Map<string, Promise<CodexHostedRuntime>>();
  readonly managedTui: CodexRuntimeManagedTuiHosts;
  observedLaunchDigest(id: string): string | null | undefined {
    const resident = this.#runtimes.get(id);
    if (resident) return this.canReplaceParkedLaunch(resident) ? null : observedLaunchDigest(resident.host);
    return this.#starting.has(id) ? undefined : null;
  }

  constructor(readonly input: {
    scope: RequestScope; executionEnvironmentId: string;
    environmentChannel: ExecutionEnvironmentChannelProvider;
    environment: Readonly<Record<string, string | undefined>>;
    services: PersistentSidecarServiceRegistry;
    sidecarStore?: CodexSidecarStoreContext;
  }) {
    this.managedTui = new CodexRuntimeManagedTuiHosts({ getRuntime: runtimeId => this.getRuntime(runtimeId), services: input.services });
  }

  async ensure(configuration: CodexRuntimeConfiguration, controllerEpoch: number, admission?: ProviderLaunchAdmission): Promise<CodexRuntimeHost> {
    this.input.services.assertController(controllerEpoch);
    this.#assertConfigurationScope(configuration);
    if (!configuration.instance.enabled) throw new Error("codex_runtime_configuration_disabled");
    const fingerprint = configurationFingerprint([configuration.connection, configuration.startupEnvironmentVariables ?? {}]);
    const key = configuration.instance.id;
    const pending = this.#starting.get(key);
    const existing = pending ? await pending : this.#runtimes.get(key);
    this.input.services.assertController(controllerEpoch);
    if (existing?.fingerprint === fingerprint) return existing.host;
    if (existing && (existing.storeFingerprint !== codexStoreFingerprint(configuration.connection) ||
        !admission?.matchesGeneration(existing.host) || !this.canReplaceParkedLaunch(existing))) {
      throw new SidecarOperationError("codex_runtime_configuration_restart_required");
    }
    this.input.services.assertAdmission(controllerEpoch);
    admission?.assertCurrent();
    const starting = (async () => {
      if (existing) {
        const unfreezeTui = this.managedTui.freezeAdmission(existing.host.runtimeId);
        existing.host.freezeAdmission();
        try { await existing.stop(); }
        catch (error) { existing.host.restoreAdmission(); unfreezeTui(); throw error; }
        this.input.services.assertAdmission(controllerEpoch);
        admission!.assertCurrent();
      }
      return await this.#start(configuration, fingerprint, controllerEpoch, admission);
    })();
    this.#starting.set(key, starting);
    try { return (await starting).host; }
    finally { if (this.#starting.get(key) === starting) this.#starting.delete(key); }
  }

  canReplaceParkedLaunch(runtime: CodexHostedRuntime): boolean {
    const snapshot = runtime.supervisor.snapshot();
    if (runtime.configuration.connection.ownership !== "owned" || snapshot.state !== "idle" || snapshot.cleanupUncertainty ||
        !runtime.host.canReleaseParkedProcess() || this.managedTui.admissionFrozen(runtime.host.runtimeId)) return false;
    const tui = this.managedTui.activity(runtime.host.runtimeId);
    return tui.state === "idle" && !tui.blockers.length;
  }

  /** A missing result is authoritative only after any already-admitted
   * bootstrap settles. This method never creates or reconfigures a runtime. */
  async lookup(configuration: CodexRuntimeConfiguration, controllerEpoch: number): Promise<CodexRuntimeHost | undefined> {
    this.input.services.assertController(controllerEpoch);
    this.#assertConfigurationScope(configuration);
    const pending = this.#starting.get(configuration.instance.id);
    if (pending) await pending;
    const existing = this.#runtimes.get(configuration.instance.id);
    this.input.services.assertController(controllerEpoch);
    if (!existing) return undefined;
    if (existing.storeFingerprint !== codexStoreFingerprint(configuration.connection)) throw new Error("codex_runtime_configuration_restart_required");
    return existing.host;
  }

  #assertConfigurationScope(configuration: CodexRuntimeConfiguration): void {
    if (configuration.instance.tenantId !== this.input.scope.tenantId || configuration.instance.kind !== "codex_app_server" || configuration.connections.length === 0 || configuration.connections.some(connection => connection.kind !== "codex_app_server" || connection.tenantId !== this.input.scope.tenantId || connection.ownerPrincipalId !== this.input.scope.principalId || connection.executionEnvironmentId !== this.input.executionEnvironmentId || connection.backendInstanceId !== configuration.instance.id)) throw new Error("codex_runtime_configuration_scope_denied");
  }

  getRuntime(runtimeId: string): CodexHostedRuntime {
    const runtime = [...this.#runtimes.values()].find(runtime => runtime.host.runtimeId === runtimeId);
    if (!runtime) throw new Error("codex_runtime_unknown");
    return runtime;
  }

  get(runtimeId: string): CodexRuntimeHost { return this.getRuntime(runtimeId).host; }

  async inspect(runtimeId: string) {
    const runtime = this.getRuntime(runtimeId);
    await runtime.host.prepareRestart();
    return this.#snapshot(runtime);
  }
  async stop(runtimeId: string, expectedRevision: string, force: boolean): Promise<void> {
    const runtime = this.getRuntime(runtimeId);
    let interruptionStarted = false;
    runtime.host.freezeAdmission();
    try {
      this.managedTui.freezeAdmission(runtimeId);
      if (!force) await runtime.host.prepareRestart();
      const snapshot = this.#snapshot(runtime);
      if (snapshot.revision !== expectedRevision) throw new Error("codex_runtime_confirmation_stale");
      if (!force && (snapshot.blockers.includes("cleanup_unproven") || snapshot.state === "unknown")) throw new Error("codex_runtime_cleanup_unproven");
      if (!force && runtime.host.pendingOutcomeCount() > 0) throw new Error("codex_runtime_outcomes_unacknowledged");
      if (!force && snapshot.blockers.length > 0) throw new Error("codex_runtime_restart_blocked");
      interruptionStarted = force;
      try { await runtime.stop("operator_backend_stop", force); }
      catch (error) {
        // A returned cleanup failure ends this control attempt. Retain the
        // same owner for an explicit retry without claiming process cleanup.
        if (force && this.#snapshot(runtime).blockers.includes("cleanup_unproven")) {
          throw new Error("codex_runtime_cleanup_unproven", { cause: error });
        }
        throw error;
      }
    } catch (error) {
      runtime.host.restoreAdmission();
      if (!interruptionStarted) this.managedTui.restoreAdmission(runtimeId);
      throw error;
    }
  }
  #snapshot(runtime: CodexHostedRuntime) {
    const nativeState = runtime.supervisor.snapshot().state === "idle" ? "idle" : runtime.supervisor.snapshot().state === "ready" ? runtime.host.activity() : "unknown";
    const tui = this.managedTui.activity(runtime.host.runtimeId);
    const state: "unknown" | "active" | "idle" = nativeState === "unknown" || tui.state === "unknown" ? "unknown" : nativeState === "active" || tui.state === "active" ? "active" : "idle";
    const blockers: SidecarUpgradeBlocker[] = [];
    if (runtime.supervisor.snapshot().cleanupUncertainty) blockers.push("cleanup_unproven");
    if (state === "unknown") blockers.push("unknown_state");
    if (state === "active") blockers.push("active_work");
    if (runtime.host.pendingInteractionCount()) blockers.push("pending_interaction");
    if (runtime.host.pendingOutcomeCount()) blockers.push("unsettled_outcome");
    for (const blocker of tui.blockers) if (!blockers.includes(blocker)) blockers.push(blocker);
    const revision = createHash("sha256").update(JSON.stringify([runtime.host.revision(), tui.revision])).digest("hex");
    return { state, incarnation: runtime.host.runtimeId, revision, blockers, startupEnvironmentFingerprint: runtime.startupEnvironmentFingerprint };
  }

  async #start(configuration: CodexRuntimeConfiguration, fingerprint: string, controllerEpoch: number, admission?: ProviderLaunchAdmission): Promise<CodexHostedRuntime> {
    const ownership = configuration.connection.ownership === "owned" ? new CodexNativeStoreOwnershipGate() : undefined;
    const configuredHome = configuration.connection.ownership === "owned" ? configuration.connection.channel.codexHome : undefined;
    const nativeHome = ownership
      ? configuredHome
        ? canonicalLocalEnvironmentDirectorySync(configuredHome)
        : path.join(canonicalLocalEnvironmentDirectorySync(this.input.environment.HOME ?? homedir()), ".codex")
      : undefined;
    const lease = ownership && nativeHome
      ? await createCodexNativeStoreLifecycle({ canonicalCodexHome: nativeHome, createIfMissing: configuredHome === undefined, ownership, label: configuration.instance.id,
          ...(this.input.sidecarStore && { sidecar: { ...this.input.sidecarStore, backendInstanceId: configuration.instance.id } }) }).acquire()
      : undefined;
    let resolved: ResolvedCodexRuntimeConfiguration;
    try {
      resolved = await resolveCodexRuntimeConfiguration({ ...configuration, scope: this.input.scope, environmentChannel: this.input.environmentChannel, environment: this.input.environment });
      this.input.services.assertAdmission(controllerEpoch);
      admission?.assertCurrent();
    } catch (error) {
      await lease?.release();
      throw error;
    }
    const scope = { ...this.input.scope, backendInstanceId: configuration.instance.id, executionEnvironmentId: this.input.executionEnvironmentId };
    const host = new CodexRuntimeHost({ scope, runtimeId: randomUUID() });
    let registered = () => {};
    const supervisor = new CodexDaemonSupervisor({
      scope, transportFactory: createCodexRuntimeTransport({ scope, configuration: resolved, environmentChannel: this.input.environmentChannel, assertLaunchAdmission: admission && (() => admission.assertInstalled(this.input.services)) }),
      serverRequestRouter: host.serverRequests,
      onRuntimeVersionAssessment: assessment => host.observeRuntimeVersion(assessment),
      ...(ownership ? {
        isLaunchCurrent: admission && (() => admission.isInstalled(this.input.services)),
        nativeStoreOwnership: ownership, expectedCodexHome: resolved.codexHome,
        expectedRuntimeVersion: () => resolved.connection.ownership === "owned" ? resolved.connection.channel.executable.version : undefined,
      } : { maximumRestartAttempts: "unbounded" }),
    });
    host.bind(supervisor.client);
    let closed = false;
    // The resource snapshot's state and blockers, including managed terminals,
    // let the archive recognize an idle runtime whose stop abandons nothing.
    const evidence = (phase: "before_shutdown" | "after_shutdown") => {
      const { state, blockers } = this.#snapshot(runtime);
      return { phase, ownership: resolved.connection.ownership, state, blockers, ...host.abandonmentEvidence() };
    };
    const runtime: CodexHostedRuntime = { configuration: resolved, environmentChannel: this.input.environmentChannel, environment: this.input.environment, host, fingerprint, storeFingerprint: codexStoreFingerprint(configuration.connection), startupEnvironmentFingerprint: configurationFingerprint(configuration.startupEnvironmentVariables ?? {}), supervisor, stop: async (reason = "runtime_cleanup", force = false) => {
      if (closed) return;
      if (force) {
        host.freezeAdmission();
        this.managedTui.freezeAdmission(host.runtimeId);
        await this.input.services.recordAbandonment({ resourceId: host.runtimeId, kind: "codex_app_server", reason, evidence: evidence("before_shutdown") });
      }
      // External providers own their running turns and pending approvals. Fence
      // native writes by closing our connection before settling local callers;
      // rejecting an approval while RPC is live would send a control response.
      if (resolved.connection.ownership === "external") await supervisor.close();
      else await host.interruptOwnedActiveTurns();
      if (force) host.abandonPendingWork();
      await this.managedTui.stopRuntime(host.runtimeId);
      if (resolved.connection.ownership === "owned") await supervisor.close();
      if (force) await this.input.services.recordAbandonment({ resourceId: host.runtimeId, kind: "codex_app_server", reason, evidence: evidence("after_shutdown") });
      await lease?.release();
      host.dispose();
      registered();
      if (this.#runtimes.get(configuration.instance.id) === runtime) this.#runtimes.delete(configuration.instance.id);
      this.managedTui.restoreAdmission(host.runtimeId);
      closed = true;
    } };
    try {
      this.input.services.assertAdmission(controllerEpoch);
      admission?.assertCurrent();
      admission?.bind(host);
      registered = this.input.services.register({
        resourceId: host.runtimeId, kind: "provider",
        snapshot: () => {
          const { state, revision, blockers } = this.#snapshot(runtime);
          return { state, revision, blockers };
        },
        prepareRestart: () => host.prepareRestart(),
        stop: async (reason, { force }) => {
          if (!force && host.pendingOutcomeCount()) throw new SidecarResourceHandoffPendingError();
          await runtime.stop(reason, force);
        },
      });
      this.#runtimes.set(configuration.instance.id, runtime);
      await supervisor.start();
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }
}

function codexStoreFingerprint(connection: CodexRuntimeConfiguration["connection"]): string {
  const channel = connection.channel;
  return configurationFingerprint([channel.type, channel.type === "process_stdio" ? channel.codexHome ?? null :
    channel.type === "unix_websocket" ? channel.socketPath : channel.url]);
}
