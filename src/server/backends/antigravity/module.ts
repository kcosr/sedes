import { ConnectionDriverCache } from "../connection-driver-cache.js";
import { createHash, createHmac } from "node:crypto";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import { NO_BACKEND_ACCOUNT_USAGE } from "../backend-account-usage.js";
import { PROVIDER_ASSIGNED_CREATION_IDENTITY, type AgentConnectionProfile } from "../contracts.js";
import {
  NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES, type BackendModule, type BackendModuleConfigurationInput,
  type BackendModuleRuntime, type BackendModuleRuntimeContext, type BackendRuntimeRecoveryContext,
  type PreparedBackendModule,
} from "../module.js";
import { AntigravityArchiveReceipts } from "./archive-receipts.js";
import { AntigravityActionPersistence } from "./action-persistence.js";
import { AntigravityAutomationPolicy } from "./automation-policy.js";
import { parseAntigravityBackendConfiguration } from "./backend-configuration.js";
import { AntigravityDriver } from "./driver.js";
import { AntigravityHost } from "./host/native-host.js";
import { createAntigravityNativeHistoryReader, removeAntigravityProbeSession } from "./native-history.js";
import { AntigravityError, type AntigravityPort, type AntigravityRuntimeConfiguration } from "./port.js";
import { ANTIGRAVITY_PROTOCOL_RELEASE } from "./release-profile.js";
import { antigravityAdministration, recoverAntigravityAdministration } from "./runtime-administration.js";
import { AntigravitySavedAgentAdapter } from "./saved-agent-adapter.js";
import { AntigravityRemotePort, inspectRetainedAntigravityOwner } from "./sidecar/remote-port.js";
import { antigravityRuntimeCapability } from "./sidecar/wire.js";
import { AntigravityThreadPersistence } from "./thread-persistence.js";
import { AntigravityThreadPresentation } from "./thread-presentation.js";
import { AntigravityThreadRepository } from "./thread-repository.js";
import { AntigravityAgentToolService } from "./agent-tools.js";
import { AntigravityModeCatalog } from "./mode-catalog.js";
import { ConversationOperationRepository } from "../../db/repositories/conversation-operation-repository.js";

interface CreatePortInput {
  readonly context: BackendModuleRuntimeContext;
  readonly configuration: AntigravityRuntimeConfiguration;
  readonly environment: BackendModuleConfigurationInput["environment"];
}

function createPort({ context, configuration, environment }: CreatePortInput): AntigravityPort {
  if (context.environmentOperations.environmentKind !== "local") {
    if (!context.sidecarRuntime) throw new Error("antigravity_sidecar_required");
    return new AntigravityRemotePort({ configuration, sidecarRuntime: context.sidecarRuntime, assertNativeOwner: context.assertNativeOwner, confirmNativeOwner: context.confirmNativeOwner });
  }
  return new AntigravityHost({
    configuration,
    reserveNativeOwner: () => {
      context.assertNativeOwner?.(configuration.backendInstanceId);
      context.confirmNativeOwner?.(configuration.backendInstanceId);
    },
    releaseNativeOwner: () => context.confirmNativeOwner?.(null, configuration.backendInstanceId),
    channels: context.environmentChannel,
    environment,
    history: createAntigravityNativeHistoryReader(configuration),
    removeProbe: identity => removeAntigravityProbeSession(configuration, identity),
  });
}

const managedProviderTerminals = Object.freeze({
  async authorizeAdmission(): Promise<never> { throw unsupportedTerminal(); },
  async attachViewer(): Promise<never> { throw unsupportedTerminal(); },
});
function unsupportedTerminal(): ManagedTerminalCarrierError {
  return new ManagedTerminalCarrierError("terminal_unavailable", "Managed provider terminals are unavailable for Antigravity.", false);
}

export class AntigravityBackendModule implements BackendModule {
  readonly backendKind = "antigravity" as const;
  readonly connectionKinds = ["antigravity_acp"] as const;
  readonly protocolRelease = ANTIGRAVITY_PROTOCOL_RELEASE;
  readonly startupPolicy = "composition_only" as const;
  readonly inspectRetainedOwner = inspectRetainedAntigravityOwner;
  readonly remoteRuntimeCapabilities = [antigravityRuntimeCapability];

  constructor(readonly createHostPort: (input: CreatePortInput) => AntigravityPort = createPort) {}

  prepare(input: BackendModuleConfigurationInput): PreparedBackendModule {
    if (input.backend.kind !== this.backendKind ||
        (input.backend.enabled && input.backend.protocolRelease !== this.protocolRelease)) {
      throw new Error("antigravity_configuration_invalid");
    }
    const prepared = parseAntigravityBackendConfiguration(input);
    const namespace = `antigravity:${createHash("sha256").update(JSON.stringify([
      prepared.executionEnvironmentId, prepared.moduleConfiguration.geminiDirectory ?? null,
    ])).digest("hex")}`;
    // Preparation cannot resolve execution-host homes or symlinks. Reserve the
    // whole environment so default, explicit and symlinked profile paths cannot
    // produce competing owners. Binding identity remains profile-sensitive.
    const reservation = `antigravity-environment:${createHash("sha256").update(JSON.stringify([prepared.executionEnvironmentId])).digest("hex")}`;
    const nativeNamespaces = input.backend.enabled ? [{ namespaceKey: reservation, sortKey: reservation }] : [];
    const configured = new Map(input.connections.map(connection => [connection.id, connection]));
    const configurationFor = ({ scope, instance, connections }: Pick<BackendRuntimeRecoveryContext, "scope" | "instance" | "connections">): AntigravityRuntimeConfiguration => {
      if (instance.kind !== this.backendKind || instance.protocolRelease !== this.protocolRelease ||
          instance.id !== input.backend.id || instance.tenantId !== scope.tenantId || !prepared.executionEnvironmentId ||
          connections.length !== configured.size || new Set(connections.map(connection => connection.id)).size !== configured.size ||
          new Set(connections.map(connection => connection.templateId)).size !== configured.size ||
          connections.some(connection => {
            const original = configured.get(connection.templateId);
            return !original || connection.kind !== "antigravity_acp" || connection.backendInstanceId !== instance.id ||
              connection.tenantId !== scope.tenantId || connection.ownerPrincipalId !== scope.principalId ||
              connection.executionEnvironmentId !== prepared.executionEnvironmentId || connection.enabled !== original.enabled;
          })) {
        throw new Error("antigravity_runtime_context_invalid");
      }
      return {
        ...prepared.moduleConfiguration, ...scope, backendInstanceId: instance.id,
        executionEnvironmentId: prepared.executionEnvironmentId, startupEnvironmentVariables: prepared.startupEnvironmentVariables,
      };
    };
    let constructed = false;
    return {
      module: this,
      backendInstanceId: input.backend.id,
      nativeNamespaces,
      nativeStores: [],
      createRuntime: context => {
        const { scope, instance, environmentOperations, environmentChannel } = context;
        if (constructed || !input.backend.enabled || !instance.enabled ||
            environmentOperations.environmentId !== prepared.executionEnvironmentId ||
            environmentOperations.environmentKind !== prepared.environmentKind ||
            environmentChannel.executionEnvironmentId !== prepared.executionEnvironmentId ||
            environmentChannel.scope.tenantId !== scope.tenantId || environmentChannel.scope.principalId !== scope.principalId ||
            (prepared.environmentKind === "local") === Boolean(context.sidecarRuntime)) {
          throw new Error("antigravity_runtime_context_invalid");
        }
        const configuration = configurationFor(context);
        const port = this.createHostPort({ context, configuration, environment: input.environment });
        const runtime = createRuntime(context, port, prepared, namespace, configuration.executionEnvironmentId);
        constructed = true;
        return runtime;
      },
      ...(prepared.environmentKind === "ssh" || prepared.environmentKind === "outbound" ? {
        recoverAdministration: (context: BackendRuntimeRecoveryContext) =>
          recoverAntigravityAdministration(context, configurationFor(context)),
      } : {}),
    };
  }

  runtimeDiagnostic(error: unknown) {
    if (error instanceof AntigravityError) {
      return { connectionState: "unknown" as const,
        message: "Antigravity is unavailable. Verify the CLI, native profile, and connection on its execution host." };
    }
    return undefined;
  }
}

function createRuntime(
  context: BackendModuleRuntimeContext,
  port: AntigravityPort,
  prepared: ReturnType<typeof parseAntigravityBackendConfiguration>,
  nativeNamespaceKey: string,
  executionEnvironmentId: string,
): BackendModuleRuntime {
  const { scope, instance } = context;
  const profileFor = (id: string) => context.connections.find(connection => connection.id === id);
  const drivers = new ConnectionDriverCache<AntigravityDriver>();
  const settings = new AntigravityThreadRepository(context.database);
  const operations = new ConversationOperationRepository(context.database);
  const modeCatalog = new AntigravityModeCatalog();
  const actionPersistence = new AntigravityActionPersistence(settings, scope, instance.id, prepared.modelPolicy, modeCatalog);
  const archiveReceipts = new AntigravityArchiveReceipts(context.database, actionPersistence);
  const agentTools = new AntigravityAgentToolService({ facade: context.agentTools, cli: context.agentToolCli,
    sourceCapabilities: context.agentToolSourceCapabilities, remote: context.environmentOperations.environmentKind !== "local" });
  const threadPersistence = new AntigravityThreadPersistence({
    scope, backendInstanceId: instance.id, settings, modelPolicy: prepared.modelPolicy,
    defaultsForConnection: id => {
      const templateId = profileFor(id)?.templateId;
      if (templateId === undefined) return;
      const current = context.targetDefinition?.(templateId);
      return current?.kind === "antigravity_acp" ? current.moduleConfiguration.defaults : prepared.defaultsByConnectionId.get(templateId);
    },
    nativeNamespaceKey,
  });
  const correlationKey = createHmac("sha256", context.toolProvenanceKey)
    .update("sedes.antigravity.correlation.v1\0")
    .update(JSON.stringify([scope.tenantId, scope.principalId, instance.id, prepared.executionEnvironmentId])).digest();
  let closed = false;
  let closing: Promise<void> | undefined;
  function assertConnection(connection: AgentConnectionProfile): void {
    const configured = profileFor(connection.id);
    if (closed || !configured || configured.configurationRevision !== connection.configurationRevision ||
        configured.templateId !== connection.templateId || configured.enabled !== connection.enabled ||
        configured.executionEnvironmentId !== connection.executionEnvironmentId) {
      throw new Error("antigravity_connection_mismatch");
    }
    threadPersistence.assertConnection(scope, connection);
  }
  return {
    scope, instance, accountUsage: NO_BACKEND_ACCOUNT_USAGE,
    driverFactory: { scope, instance, connectionKinds: ["antigravity_acp"],
      supportsConversationCreation: true, creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
      create(connection) {
        assertConnection(connection);
        let driver = drivers.get(connection.id);
        if (driver?.connection.configurationRevision !== connection.configurationRevision) {
          driver = new AntigravityDriver({ instance, connection, scope, port, settings,
            modelPolicy: prepared.modelPolicy, nativeNamespaceKey, correlationKey, usage: context.usage, agentTools, modeCatalog, archiveReceipts,
            isOperationAbandoned: (threadId, operationId) => operations.isOperationAbandoned(scope, threadId, operationId),
            executionEnvironmentVariables: context.executionEnvironmentVariables });
          drivers.set(connection.id, driver);
        }
        return driver;
      },
    },
    threadPersistence, bindingDetails: threadPersistence, discoveryPersistence: threadPersistence,
    discovery: { nativeNamespaceKey(connection) { assertConnection(connection); return nativeNamespaceKey; } },
    presentation: new AntigravityThreadPresentation(settings, prepared.modelPolicy, modeCatalog),
    actionPersistence,
    savedAgents: new AntigravitySavedAgentAdapter(threadPersistence, modeCatalog),
    automationExecutionPolicy: new AntigravityAutomationPolicy(settings, prepared.modelPolicy, scope, instance.id),
    managedProviderTerminals, installationAdvisories: NO_ACTIVE_BACKEND_INSTALLATION_ADVISORIES,
    unresolvedSubmissionRecovery: "attach",
    agentToolRuntimeAvailability: input => agentTools.availability(input),
    administration: antigravityAdministration(context, executionEnvironmentId, threadPersistence, port),
    async start(signal) {
      signal?.throwIfAborted();
      if (closed) throw new Error("antigravity_runtime_closed");
    },
    async close() {
      closed = true;
      const close = closing ??= (async () => {
        const current = [...drivers.values()];
        const results = await Promise.allSettled(current.map(driver => driver.close()));
        const errors: unknown[] = [];
        let released = false;
        try { await port.close(); released = true; } catch (error) { errors.push(error); }
        // A failed handle release cannot skip closing the owner/proxy. Once it
        // closes, retry those releases against its retained cleanup evidence.
        if (released) {
          const retried = await Promise.allSettled(current.filter((_, index) => results[index]?.status === "rejected").map(driver => driver.close()));
          errors.push(...retried.flatMap(result => result.status === "rejected" ? [result.reason] : []));
          try { await agentTools.close(); } catch (error) { errors.push(error); }
        } else errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
        if (errors.length > 0) throw new AggregateError(errors, "Antigravity runtime cleanup was incomplete.");
        drivers.clear();
      })();
      try { await close; } catch (error) {
        if (closing === close) closing = undefined;
        throw error;
      }
    },
  };
}
