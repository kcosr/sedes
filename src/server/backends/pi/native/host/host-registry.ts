import type { RequestScope } from "../../../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../../execution/environment-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../../sidecar/persistent-sidecar-service-registry.js";
import { configurationFingerprint } from "../../../../config/configuration-fingerprint.js";
import { PiNativeError, type PiNativeRuntimeConfiguration } from "../port.js";
import { piNativeConfigurationSchema } from "../sidecar/wire.js";
import { PiNativeHost, type PiNativeHostAuthority } from "./native-host.js";
import { loadPiNativeHostAuthenticationKey } from "./authentication-key.js";

type Entry = { host: PiNativeHost; fingerprint: string; unregister(): void };
/** The persistent service owns the registry; authenticated peers only borrow it. */
export class PiNativeHostRegistry {
  readonly #hosts = new Map<string, Entry>();
  readonly #starting = new Map<string, Promise<Entry>>();
  readonly #retiredHandles = new Map<string, ReadonlySet<string>>();
  constructor(readonly input: {
    readonly scope: RequestScope;
    readonly executionEnvironmentId: string;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly serviceDirectory: string;
    readonly services: PersistentSidecarServiceRegistry;
    readonly createHost?: (configuration: PiNativeRuntimeConfiguration, key: Uint8Array) => PiNativeHost;
  }) {}

  async ensure(raw: PiNativeRuntimeConfiguration, epoch: number): Promise<PiNativeHost> {
    const configuration = this.#configuration(raw);
    this.input.services.assertController(epoch);
    let entry = this.#hosts.get(configuration.backendInstanceId);
    if (!entry) {
      this.input.services.assertAdmission(epoch);
      let starting = this.#starting.get(configuration.backendInstanceId);
      if (!starting) {
        starting = this.#create(configuration, epoch);
        this.#starting.set(configuration.backendInstanceId, starting);
      }
      try { entry = await starting; }
      finally { if (this.#starting.get(configuration.backendInstanceId) === starting) this.#starting.delete(configuration.backendInstanceId); }
    }
    this.input.services.assertController(epoch);
    if (entry.fingerprint !== identity(configuration)) throw new PiNativeError("pi_native_configuration_restart_required");
    return entry.host;
  }
  async lookup(raw: PiNativeRuntimeConfiguration, epoch: number): Promise<PiNativeHost | undefined> {
    const configuration = this.#configuration(raw);
    this.input.services.assertController(epoch);
    await this.#starting.get(configuration.backendInstanceId)?.catch(() => undefined);
    this.input.services.assertController(epoch);
    const entry = this.#hosts.get(configuration.backendInstanceId);
    if (entry && entry.fingerprint !== identity(configuration)) throw new PiNativeError("pi_native_configuration_restart_required");
    return entry?.host;
  }
  async lookupRetained(backendInstanceId: string, epoch: number): Promise<PiNativeHost | undefined> {
    this.input.services.assertController(epoch);
    await this.#starting.get(backendInstanceId)?.catch(() => undefined);
    this.input.services.assertController(epoch);
    return this.#hosts.get(backendInstanceId)?.host;
  }
  get(runtimeId: string): PiNativeHost {
    const entry = [...this.#hosts.values()].find(entry => entry.host.runtimeId === runtimeId);
    if (!entry) throw new PiNativeError("pi_native_runtime_unknown", "sent_outcome_unknown");
    return entry.host;
  }
  async release(runtimeId: string, handleId: string, signal: AbortSignal, authority: PiNativeHostAuthority): Promise<void> {
    signal.throwIfAborted(); authority.assertCurrent();
    const retired = this.#retiredHandles.get(runtimeId);
    if (retired) {
      if (!retired.has(handleId)) throw new PiNativeError("pi_native_session_unknown", "sent_outcome_unknown");
      return;
    }
    await this.get(runtimeId).release({ handleId }, signal, authority);
  }
  async stop(runtimeId: string, expectedRevision: string, force: boolean, signal?: AbortSignal, authority?: PiNativeHostAuthority): Promise<void> {
    signal?.throwIfAborted(); authority?.assertCurrent();
    const pair = [...this.#hosts].find(([, entry]) => entry.host.runtimeId === runtimeId);
    if (!pair) throw new PiNativeError("pi_native_runtime_unknown", "sent_outcome_unknown");
    const [backendId, entry] = pair;
    await entry.host.stop({ expectedRevision, force }, signal, authority, evidence => this.input.services.recordAbandonment({
      resourceId: runtimeId, kind: "pi_native", reason: "operator_backend_stop", evidence }));
    this.#recordRetirement(entry.host);
    entry.unregister(); this.#hosts.delete(backendId);
  }
  #recordRetirement(host: PiNativeHost): void {
    // Keep only compact exact cleanup receipts, never stopped processes or
    // their retained histories. Retries remain valid after a lost reply.
    this.#retiredHandles.set(host.runtimeId, new Set(host.retiredHandleIds()));
    while (this.#retiredHandles.size > 128) this.#retiredHandles.delete(this.#retiredHandles.keys().next().value!);
  }
  #configuration(raw: PiNativeRuntimeConfiguration): PiNativeRuntimeConfiguration {
    const configuration = piNativeConfigurationSchema.parse(raw);
    if (configuration.tenantId !== this.input.scope.tenantId || configuration.principalId !== this.input.scope.principalId ||
      configuration.executionEnvironmentId !== this.input.executionEnvironmentId) throw new PiNativeError("pi_native_configuration_scope_denied");
    return configuration;
  }
  async #create(configuration: PiNativeRuntimeConfiguration, epoch: number): Promise<Entry> {
    const key = await loadPiNativeHostAuthenticationKey(this.input.serviceDirectory, configuration.backendInstanceId);
    this.input.services.assertAdmission(epoch);
    const host = this.input.createHost?.(configuration, key) ?? new PiNativeHost({ configuration, authenticationKey: key,
      channels: this.input.channels, environment: this.input.environment });
    let unregister = () => {};
    const entry: Entry = { host, fingerprint: identity(configuration), unregister: () => unregister() };
    unregister = this.input.services.register({ resourceId: host.runtimeId, kind: "provider",
      snapshot: () => host.snapshot(), onDetach: () => host.detach(),
      stop: async (reason, { force }) => {
        await host.stop({ expectedRevision: host.snapshot().revision, force }, undefined, undefined,
          evidence => this.input.services.recordAbandonment({ resourceId: host.runtimeId, kind: "pi_native", reason, evidence }));
        this.#recordRetirement(host);
        unregister(); this.#hosts.delete(configuration.backendInstanceId);
      } });
    this.#hosts.set(configuration.backendInstanceId, entry);
    return entry;
  }
}

function identity(configuration: PiNativeRuntimeConfiguration): string {
  // Startup-only edits apply on explicit restart, preserving the applied owner.
  const { startupEnvironmentVariables: _startup, ...rest } = configuration;
  return configurationFingerprint(rest);
}
