import { observedLaunchDigest } from "../../provider-policy-admission.js";
import type { RequestScope } from "../../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import { configurationFingerprint } from "../../../config/configuration-fingerprint.js";
import { AntigravityError, type AntigravityRuntimeConfiguration } from "../port.js";
import { antigravityConfigurationSchema } from "../sidecar/wire.js";
import { AntigravityHost, type AntigravityHostAuthority } from "./native-host.js";
import { createAntigravityNativeHistoryReader, removeAntigravityProbeSession } from "../native-history.js";

type Entry = { readonly host: AntigravityHost; readonly fingerprint: string; readonly unregister: () => void };
export class AntigravityHostRegistry {
  readonly #hosts = new Map<string, Entry>();
  readonly #retired = new Map<string, ReadonlySet<string>>();
  observedLaunchDigest(id: string): string | undefined {
    return observedLaunchDigest(this.#hosts.get(id)?.host);
  }

  constructor(readonly input: {
    readonly scope: RequestScope;
    readonly executionEnvironmentId: string;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly services: PersistentSidecarServiceRegistry;
    readonly createHost?: (configuration: AntigravityRuntimeConfiguration) => AntigravityHost;
  }) {}
  async ensure(raw: AntigravityRuntimeConfiguration, epoch: number): Promise<AntigravityHost> {
    const configuration = this.#configuration(raw); this.input.services.assertController(epoch);
    const existing = this.#hosts.get(configuration.backendInstanceId);
    if (existing) { if (existing.fingerprint !== identity(configuration)) throw new AntigravityError("antigravity_configuration_restart_required"); return existing.host; }
    if (this.#hosts.size) throw new AntigravityError("antigravity_native_namespace_in_use");
    this.input.services.assertAdmission(epoch);
    const host = this.input.createHost?.(configuration) ?? new AntigravityHost({ configuration,
      channels: this.input.channels, environment: this.input.environment,
      history: createAntigravityNativeHistoryReader(configuration),
      removeProbe: session => removeAntigravityProbeSession(configuration, session),
    });
    let unregister = () => {};
    unregister = this.input.services.register({ resourceId: host.runtimeId, kind: "provider", snapshot: () => {
      const { state, revision, blockers } = host.snapshot();
      return { state, revision, blockers };
    },
      onDetach: () => host.detach(), stop: async (reason, context) => {
        const inspection = await host.inspect();
        const retained = new Set(inspection.retainedSessions.map(session => session.handleId));
        await host.stop({ expectedRevision: inspection.revision, force: context.force }, undefined, undefined,
          evidence => this.input.services.recordAbandonment({ resourceId: host.runtimeId, kind: "antigravity", reason, evidence }));
        this.#retired.set(host.runtimeId, retained); this.#trim(); unregister(); this.#hosts.delete(configuration.backendInstanceId);
      } });
    this.#hosts.set(configuration.backendInstanceId, { host, fingerprint: identity(configuration), unregister }); return host;
  }
  async lookup(raw: AntigravityRuntimeConfiguration, epoch: number): Promise<AntigravityHost | undefined> {
    const configuration = this.#configuration(raw); this.input.services.assertController(epoch);
    const entry = this.#hosts.get(configuration.backendInstanceId);
    if (entry && entry.host.input.configuration.geminiDirectory !== configuration.geminiDirectory) throw new AntigravityError("antigravity_configuration_scope_denied");
    return entry?.host;
  }
  async lookupRetained(backendInstanceId: string, epoch: number): Promise<AntigravityHost | undefined> {
    this.input.services.assertController(epoch); return this.#hosts.get(backendInstanceId)?.host;
  }
  get(runtimeId: string): AntigravityHost {
    const entry = [...this.#hosts.values()].find(entry => entry.host.runtimeId === runtimeId);
    if (!entry) throw new AntigravityError("antigravity_runtime_unknown", "sent_outcome_unknown"); return entry.host;
  }
  async release(runtimeId: string, handleId: string, signal: AbortSignal, authority: AntigravityHostAuthority) {
    authority.assertCurrent(); signal.throwIfAborted();
    const retired = this.#retired.get(runtimeId);
    if (retired) { if (!retired.has(handleId)) throw new AntigravityError("antigravity_session_unknown", "sent_outcome_unknown"); return; }
    await this.get(runtimeId).release({ handleId }, signal, authority);
  }
  async stop(runtimeId: string, expectedRevision: string, force: boolean, signal: AbortSignal, authority: AntigravityHostAuthority) {
    authority.assertCurrent(); const entry = [...this.#hosts].find(([, entry]) => entry.host.runtimeId === runtimeId);
    if (!entry) throw new AntigravityError("antigravity_runtime_unknown", "sent_outcome_unknown");
    const [backendId, value] = entry;
    const retained = new Set(value.host.snapshot().retainedSessions.map(session => session.handleId));
    await value.host.stop({ expectedRevision, force }, signal, authority,
      evidence => this.input.services.recordAbandonment({ resourceId: runtimeId, kind: "antigravity", reason: "operator_backend_stop", evidence }));
    this.#retired.set(runtimeId, retained); this.#trim(); value.unregister(); this.#hosts.delete(backendId);
  }
  #trim() { while (this.#retired.size > 128) this.#retired.delete(this.#retired.keys().next().value!); }
  #configuration(raw: AntigravityRuntimeConfiguration) {
    const configuration = antigravityConfigurationSchema.parse(raw);
    if (configuration.tenantId !== this.input.scope.tenantId || configuration.principalId !== this.input.scope.principalId ||
        configuration.executionEnvironmentId !== this.input.executionEnvironmentId) throw new AntigravityError("antigravity_configuration_scope_denied");
    return configuration;
  }
}
function identity(configuration: AntigravityRuntimeConfiguration) {
  const { startupEnvironmentVariables: _startup, ...rest } = configuration; return configurationFingerprint(rest);
}
