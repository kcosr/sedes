import { SidecarOperationError } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { observedLaunchDigest, type ProviderLaunchAdmission } from "../../provider-policy-admission.js";
import { configurationFingerprint } from "../../../config/configuration-fingerprint.js";
import type { RequestScope } from "../../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { ManagedWorkerArtifactRegistration } from "../../../managed-workers/artifact.js";
import { SidecarResourceHandoffPendingError, type PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import type { ClaudeOwnedRuntimeClient } from "../claude-runtime-client.js";
import type { ClaudeRuntimeAgentToolMcp } from "../worker/claude-runtime-v4.js";
import { ClaudeManagedRuntimeOwner } from "../claude-managed-runtime-owner.js";
import { ClaudePersistentRuntimeHost } from "./claude-persistent-runtime-host.js";
import { claudePersistentConfigurationSchema, type ClaudePersistentConfiguration } from "./claude-persistent-runtime-wire.js";

export class ClaudePersistentRuntimeRegistry {
  readonly #hosts = new Map<string, { host: ClaudePersistentRuntimeHost; fingerprint: string; retire(force?: boolean, reason?: string): Promise<void> }>();
  observedLaunchDigest(id: string): string | null | undefined {
    const resident = this.#hosts.get(id);
    if (resident) return resident.host.canReplaceWorker() ? null : observedLaunchDigest(resident.host.workerIdentity);
    return null;
  }

  constructor(readonly input: {
    scope: RequestScope; executionEnvironmentId: string;
    environmentChannel: ExecutionEnvironmentChannelProvider;
    environment: Readonly<Record<string, string | undefined>>;
    services: PersistentSidecarServiceRegistry;
    artifact: () => Promise<ManagedWorkerArtifactRegistration>;
    validateQueryEnvironment?: (environment: Readonly<Record<string, string | undefined>>, backendInstanceId: string) => void;
    validateAgentToolMcp?: (agentToolMcp: ClaudeRuntimeAgentToolMcp, backendInstanceId: string) => void;
    createRuntime?: (configuration: ClaudePersistentConfiguration) => ClaudeOwnedRuntimeClient & { close(): Promise<void> };
    /** Residency limit for detached, quiescent queries; tests shorten it. */
    detachedSessionTtlMs?: number;
    maximumCompactReceiptBytes?: number;
    /** Per-query journal bound; tests shorten it. */
    maximumJournaledOperations?: number;
  }) {}

  ensure(raw: ClaudePersistentConfiguration, epoch: number, admission?: ProviderLaunchAdmission): ClaudePersistentRuntimeHost {
    const configuration = claudePersistentConfigurationSchema.parse(raw);
    this.input.services.assertController(epoch);
    if (configuration.tenantId !== this.input.scope.tenantId || configuration.principalId !== this.input.scope.principalId ||
      configuration.executionEnvironmentId !== this.input.executionEnvironmentId) throw new Error("claude_persistent_configuration_scope_denied");
    const fingerprint = runtimeIdentityFingerprint(configuration);
    const existing = this.#hosts.get(configuration.backendInstanceId);
    if (existing) {
      // Existing-only lookup can reattach independently of this launch comparison.
      if (existing.fingerprint === fingerprint) return existing.host;
      if (existing.host.input.configuration.configDirectory !== configuration.configDirectory ||
          !admission?.matchesGeneration(existing.host.workerIdentity) || !existing.host.canReplaceWorker())
        throw new SidecarOperationError("claude_persistent_configuration_restart_required");
    }
    this.input.services.assertAdmission(epoch);
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (!this.input.createRuntime && (major < 24 || (major === 24 && minor < 18))) throw new Error("claude_persistent_node_version_unsupported");
    const client = this.input.createRuntime?.(configuration) ?? new ClaudeManagedRuntimeOwner({
      assertLaunchAdmission: admission && (() => {
        if (admission.isGenerationInstalled(this.input.services) && !admission.isInstalled(this.input.services))
          throw new SidecarOperationError("claude_persistent_configuration_restart_required");
        admission.assertInstalled(this.input.services);
      }), scope: configuration, environmentKind: "local", channels: this.input.environmentChannel,
      artifact: this.input.artifact(), workingDirectory: configuration.configDirectory ?? "/",
      executablePath: configuration.executablePath, configDirectory: configuration.configDirectory,
      initializationTimeoutMs: configuration.initializationTimeoutMs,
      startupEnvironmentVariables: configuration.startupEnvironmentVariables,
    });
    if (existing) {
      existing.host.replaceWorker(configuration, client);
      existing.fingerprint = fingerprint;
      return existing.host;
    }
    const host = new ClaudePersistentRuntimeHost({ configuration, client, close: () => client.close(), services: this.input.services, ...(this.input.validateQueryEnvironment ? { validateQueryEnvironment: this.input.validateQueryEnvironment } : {}), ...(this.input.validateAgentToolMcp ? { validateAgentToolMcp: this.input.validateAgentToolMcp } : {}),
      ...(this.input.maximumCompactReceiptBytes !== undefined ? { maximumCompactReceiptBytes: this.input.maximumCompactReceiptBytes } : {}),
      ...(this.input.detachedSessionTtlMs !== undefined ? { detachedSessionTtlMs: this.input.detachedSessionTtlMs } : {}),
      ...(this.input.maximumJournaledOperations !== undefined ? { maximumJournaledOperations: this.input.maximumJournaledOperations } : {}) });
    const unregister = this.input.services.register({
      resourceId: host.runtimeId, kind: "provider", snapshot: () => host.snapshot(),
      onDetach: () => host.detach(),
      stop: async (reason, { force }) => { await host.stop(force, reason); unregister(); this.#hosts.delete(configuration.backendInstanceId); },
    });
    const retire = async (force = false, reason = "operator_backend_stop") => {
      await host.stop(force, reason);
      unregister();
      if (this.#hosts.get(configuration.backendInstanceId)?.host === host) this.#hosts.delete(configuration.backendInstanceId);
    };
    this.#hosts.set(configuration.backendInstanceId, { host, fingerprint, retire });
    return host;
  }
  /** Existing-only lookup preserves configuration and principal authority. */
  lookup(raw: ClaudePersistentConfiguration, epoch: number): ClaudePersistentRuntimeHost | undefined {
    const configuration = claudePersistentConfigurationSchema.parse(raw);
    this.input.services.assertController(epoch);
    if (configuration.tenantId !== this.input.scope.tenantId || configuration.principalId !== this.input.scope.principalId ||
      configuration.executionEnvironmentId !== this.input.executionEnvironmentId) throw new Error("claude_persistent_configuration_scope_denied");
    const existing = this.#hosts.get(configuration.backendInstanceId);
    if (!existing) return undefined;
    if (existing.host.input.configuration.configDirectory !== configuration.configDirectory) throw new Error("claude_persistent_configuration_scope_denied");
    return existing.host;
  }

  inspect(runtimeId: string) {
    const host = this.get(runtimeId);
    return { ...host.snapshot(), ...host.retainedWork(), incarnation: host.runtimeId, startupEnvironmentFingerprint: configurationFingerprint(host.input.configuration.startupEnvironmentVariables ?? {}) };
  }

  async stop(runtimeId: string, expectedRevision: string, force: boolean): Promise<void> {
    const entry = [...this.#hosts.values()].find(value => value.host.runtimeId === runtimeId);
    if (!entry) throw new Error("claude_persistent_runtime_unknown");
    const host = entry.host;
    host.freezeAdmission();
    try {
      const snapshot = host.snapshot();
      if (snapshot.revision !== expectedRevision) throw new Error("claude_persistent_confirmation_stale");
      if (!force && snapshot.blockers.includes("cleanup_unproven")) throw new Error("claude_persistent_cleanup_unproven");
      if (!force && snapshot.blockers.includes("unsettled_outcome")) throw new Error("claude_persistent_outcomes_unacknowledged");
      if (!force && snapshot.blockers.length) throw new Error("claude_persistent_restart_blocked");
      try { await entry.retire(force); }
      catch (error) {
        // The owner answered, but its resources remain retained until a later
        // explicit retry proves cleanup. This is not transport uncertainty.
        if (force && host.snapshot().blockers.includes("cleanup_unproven")) {
          throw new Error("claude_persistent_cleanup_unproven", { cause: error });
        }
        throw error;
      }
    } catch (error) {
      if (!(error instanceof SidecarResourceHandoffPendingError)) host.restoreAdmission();
      throw error;
    }
  }

  get(runtimeId: string): ClaudePersistentRuntimeHost {
    const host = [...this.#hosts.values()].find(entry => entry.host.runtimeId === runtimeId)?.host;
    if (!host) throw new Error("claude_persistent_runtime_unknown");
    return host;
  }
}

function runtimeIdentityFingerprint(configuration: ClaudePersistentConfiguration): string {
  return configurationFingerprint({ ...configuration, startupEnvironmentVariables: configuration.startupEnvironmentVariables ?? {} });
}
