import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../execution/environment-channel.js";
import type { SidecarUpgradeBlocker } from "../../../internal/sidecar-protocol/service-management-v1.js";
import { PersistentSidecarServiceRegistry, SidecarResourceHandoffPendingError } from "../../sidecar/persistent-sidecar-service-registry.js";
import { OpenCodeRuntime, type OpenCodeRuntimeInput } from "./opencode-runtime.js";
import type { OpenCodeNativeHost } from "./opencode-native-host.js";
import { admitOpenCodeRuntimeConfiguration, resolveOpenCodeRuntimeInput, type OpenCodeRuntimeConfiguration } from "./opencode-runtime-configuration.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export type { OpenCodeRuntimeConfiguration } from "./opencode-runtime-configuration.js";
type Resident = {
  readonly runtime: OpenCodeRuntime;
  readonly configuration: OpenCodeRuntimeConfiguration;
  readonly fingerprint: string;
  readonly startupEnvironmentFingerprint: string;
  host?: OpenCodeNativeHost;
  unregister(): void;
  frozen: boolean;
  retiring: boolean;
  stopping?: Promise<void>;
};

/** The execution service owns these runtimes. Releasing a carrier or main-side
 * presentation never closes native stdin, the store lease or retained proof. */
export class OpenCodeRuntimeHostRegistry {
  readonly #runtimes = new Map<string, Resident>();
  readonly #byId = new Map<string, Resident>();
  readonly #starting = new Map<string, Promise<Resident>>();
  constructor(readonly input: {
    readonly scope: RequestScope;
    readonly executionEnvironmentId: string;
    readonly environmentChannel: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly services: PersistentSidecarServiceRegistry;
    readonly agentTools?: OpenCodeRuntimeInput["agentTools"];
    readonly createRuntime?: (input: OpenCodeRuntimeInput) => OpenCodeRuntime;
  }) {
    input.services.assertScope({ ...input.services.scope, ...input.scope, executionEnvironmentId: input.executionEnvironmentId });
  }

  async ensure(configuration: OpenCodeRuntimeConfiguration, controllerEpoch: number): Promise<OpenCodeRuntime> {
    this.input.services.assertController(controllerEpoch);
    const admitted = this.#configuration(configuration);
    if (!admitted.instance.enabled || !admitted.connections.some(connection => connection.enabled)) throw error("configuration_disabled");
    const existing = await this.#existing(admitted.instance.id);
    this.input.services.assertController(controllerEpoch);
    if (existing) { this.#sameConfiguration(existing, admitted); return existing.runtime; }
    this.input.services.assertAdmission(controllerEpoch);
    // Install the promise synchronously before the first resolver await.
    let starting = this.#starting.get(admitted.instance.id);
    if (!starting) {
      starting = this.#start(admitted, controllerEpoch);
      this.#starting.set(admitted.instance.id, starting);
    }
    try {
      const resident = await starting;
      this.input.services.assertController(controllerEpoch);
      this.#sameConfiguration(resident, admitted);
      return resident.runtime;
    } finally { if (this.#starting.get(admitted.instance.id) === starting) this.#starting.delete(admitted.instance.id); }
  }

  /** Existing-only discovery waits for already-admitted startup. It never
   * resolves a new secret, takes a store lease or starts a native process. */
  async lookup(configuration: OpenCodeRuntimeConfiguration, controllerEpoch: number): Promise<OpenCodeRuntime | undefined> {
    this.input.services.assertController(controllerEpoch);
    const admitted = this.#configuration(configuration), existing = await this.#existing(admitted.instance.id);
    this.input.services.assertController(controllerEpoch);
    if (!existing) return undefined;
    this.#sameConfiguration(existing, admitted); return existing.runtime;
  }

  /** Authenticated administration can reach the original owner after desired
   * paths/configuration change. This grants no workspace or session admission. */
  async lookupRetained(backendInstanceId: string, controllerEpoch: number): Promise<OpenCodeRuntime | undefined> {
    this.input.services.assertController(controllerEpoch);
    if (typeof backendInstanceId !== "string" || !backendInstanceId || backendInstanceId.length > 256) throw error("configuration_scope_denied");
    const resident = await this.#existing(backendInstanceId);
    this.input.services.assertController(controllerEpoch);
    return resident?.runtime;
  }

  getRuntime(runtimeId: string): OpenCodeRuntime { return this.#resident(runtimeId).runtime; }
  get(runtimeId: string): OpenCodeNativeHost {
    const resident = this.#resident(runtimeId), host = resident.runtime.nativeHost;
    if (!host || resident.retiring || resident.runtime.snapshot().state !== "ready") throw error("unavailable");
    resident.host = host; return host;
  }
  async inspect(runtimeId: string) {
    const resident = this.#resident(runtimeId);
    await this.#refresh(resident);
    return this.#snapshot(resident);
  }
  async stop(runtimeId: string, expectedRevision: string, force: boolean): Promise<void> {
    const resident = this.#resident(runtimeId);
    const alreadyFrozen = resident.frozen;
    this.#freeze(resident);
    try {
      const snapshot = this.#snapshot(resident);
      if (snapshot.revision !== expectedRevision) throw error("confirmation_stale");
      if (!force && snapshot.blockers.length) throw error("restart_blocked");
      await this.#retire(resident, "operator_backend_stop", force);
    } catch (cause) {
      if (!resident.retiring && !alreadyFrozen) { resident.frozen = false; resident.host?.restoreAdmission(); }
      throw cause;
    }
  }

  #configuration(configuration: OpenCodeRuntimeConfiguration): OpenCodeRuntimeConfiguration {
    return admitOpenCodeRuntimeConfiguration(configuration, this.input.scope, this.input.executionEnvironmentId);
  }
  #fingerprint(configuration: OpenCodeRuntimeConfiguration): string {
    return configurationFingerprint({ nativeStorePath: configuration.nativeStorePath,
      configDirectory: configuration.configDirectory ?? null, connection: configuration.connection });
  }
  #sameConfiguration(resident: Resident, configuration: OpenCodeRuntimeConfiguration): void {
    if (resident.fingerprint !== this.#fingerprint(configuration)) throw error("configuration_restart_required");
  }
  async #existing(backendInstanceId: string): Promise<Resident | undefined> {
    const starting = this.#starting.get(backendInstanceId);
    if (starting) await starting.catch(() => undefined);
    return this.#runtimes.get(backendInstanceId);
  }
  #resident(runtimeId: string): Resident {
    const resident = this.#byId.get(runtimeId);
    if (!resident) throw error("unknown");
    return resident;
  }
  #freeze(resident: Resident): void {
    resident.frozen = true;
    resident.host ??= resident.runtime.nativeHost;
    resident.host?.freezeAdmission();
  }
  async #refresh(resident: Resident): Promise<void> {
    resident.host ??= resident.runtime.nativeHost;
    if (resident.runtime.snapshot().state === "ready") await resident.host?.prepareRetirement().catch(() => undefined);
  }
  #serviceSnapshot(resident: Resident) {
    const native = resident.runtime.snapshot();
    // Stock background inventory is incomplete even when foreground reads are
    // empty. Keep that conservative service posture stable while main detaches
    // and native events/ACKs continue: those do not replace the confirmed owner.
    // Detailed work and evidence still appear in backend inspection/archival.
    const blockers: SidecarUpgradeBlocker[] = ["unknown_state"];
    if (native.state === "cleanup_unproved") blockers.push("cleanup_unproven");
    return { state: "unknown" as const, blockers,
      revision: configurationFingerprint({ runtimeId: resident.runtime.runtimeId,
        state: native.state, generation: native.generation ?? null, ownership: native.ownership }) };
  }
  #snapshot(resident: Resident) {
    resident.host ??= resident.runtime.nativeHost;
    const native = resident.runtime.snapshot(), retained = resident.host?.retentionSnapshot();
    // Stock v2 cannot enumerate every background process. Empty foreground
    // inventory is never a complete idle/cleanup proof for a resident owner.
    const state = (retained?.activeWorkCount ?? 0) > 0 ? "active" as const : "unknown" as const;
    const blockers: SidecarUpgradeBlocker[] = ["unknown_state"];
    if (state === "active") blockers.push("active_work");
    if ((retained?.pendingInteractionCount ?? 0) > 0) blockers.push("pending_interaction");
    if ((retained?.retainedMutationCount ?? 0) > 0 || (retained?.observation.pendingEvidenceCount ?? 0) > 0) blockers.push("unsettled_outcome");
    if (native.state === "cleanup_unproved") blockers.push("cleanup_unproven");
    // Confirmation authorizes retiring this exact native owner. Streaming deltas,
    // evidence ACKs and newly observed work must not make a confirmed force Stop
    // impossible; current blockers still govern every non-forced retirement.
    const { revision } = this.#serviceSnapshot(resident);
    return { state, incarnation: resident.runtime.runtimeId, revision, blockers,
      startupEnvironmentFingerprint: resident.startupEnvironmentFingerprint,
      retainedThreadIds: retained?.threadIds ?? [] };
  }
  #evidence(resident: Resident, phase: "before_shutdown" | "after_shutdown") {
    const { state, blockers } = this.#snapshot(resident);
    return { phase, ownership: resident.configuration.connection.ownership, state, blockers,
      retention: resident.host?.retentionSnapshot() ?? null, operations: resident.host?.snapshot().operations ?? [] };
  }
  #retire(resident: Resident, reason: string, force: boolean): Promise<void> {
    if (resident.stopping) return resident.stopping;
    this.#freeze(resident);
    const retiring = (async () => {
      if (!force && this.#snapshot(resident).blockers.length) throw new SidecarResourceHandoffPendingError();
      resident.retiring = true;
      if (force) await this.input.services.recordAbandonment({ resourceId: resident.runtime.runtimeId,
        kind: "opencode", reason, evidence: this.#evidence(resident, "before_shutdown") });
      try { await resident.runtime.close(); }
      catch { throw new OpenCodeRuntimeError("opencode_runtime_cleanup_unproven"); }
      finally {
        if (force) await this.input.services.recordAbandonment({ resourceId: resident.runtime.runtimeId,
          kind: "opencode", reason, evidence: this.#evidence(resident, "after_shutdown") });
      }
      resident.unregister(); this.#byId.delete(resident.runtime.runtimeId);
      if (this.#runtimes.get(resident.configuration.instance.id) === resident) this.#runtimes.delete(resident.configuration.instance.id);
    })();
    resident.stopping = retiring;
    void retiring.finally(() => { if (resident.stopping === retiring) resident.stopping = undefined; }).catch(() => undefined);
    return retiring;
  }
  async #start(configuration: OpenCodeRuntimeConfiguration, controllerEpoch: number): Promise<Resident> {
    const resolved = await resolveOpenCodeRuntimeInput({ configuration, scope: this.input.scope,
      executionEnvironmentId: this.input.executionEnvironmentId, hostIncarnation: this.input.services.serviceIncarnation,
      environmentChannel: this.input.environmentChannel, environment: this.input.environment,
      ...(this.input.agentTools ? { agentTools: this.input.agentTools } : {}) });
    this.input.services.assertAdmission(controllerEpoch);
    let resident: Resident;
    const runtime = (this.input.createRuntime ?? (input => new OpenCodeRuntime(input)))({ ...resolved,
      assertLaunchAdmission: () => {
        this.input.services.assertAdmission(controllerEpoch);
        if (resident.frozen || resident.retiring) throw error("stopping");
      } });
    resident = { runtime, configuration, fingerprint: this.#fingerprint(configuration),
      startupEnvironmentFingerprint: configurationFingerprint(configuration.startupEnvironmentVariables ?? {}),
      unregister: () => {}, frozen: false, retiring: false };
    resident.unregister = this.input.services.register({ resourceId: runtime.runtimeId, kind: "provider",
      snapshot: () => this.#serviceSnapshot(resident),
      prepareRestart: () => this.#refresh(resident),
      stop: (reason, { force }) => this.#retire(resident, reason, force) });
    this.#runtimes.set(configuration.instance.id, resident); this.#byId.set(runtime.runtimeId, resident);
    try {
      await runtime.start(); resident.host = runtime.nativeHost;
      if (resident.frozen) resident.host?.freezeAdmission();
      return resident;
    } catch (cause) {
      // Failed cleanup retains the participant and exact owner for Stop/Upgrade.
      // A controller loss after launch is not a reason to stop a ready runtime.
      if (runtime.snapshot().state === "stopped") {
        resident.unregister(); this.#runtimes.delete(configuration.instance.id); this.#byId.delete(runtime.runtimeId);
      }
      throw cause;
    }
  }
}
function error(suffix: string): OpenCodeRuntimeError { return new OpenCodeRuntimeError(`opencode_runtime_${suffix}`); }
