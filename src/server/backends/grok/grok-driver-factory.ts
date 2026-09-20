import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../execution/environment-channel.js";
import {
  PROVIDER_ASSIGNED_CREATION_IDENTITY,
  type AgentBackendInstance,
  type AgentConnectionProfile,
} from "../contracts.js";
import type { BackendDriverFactory } from "../registry.js";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import type { GrokBackendConfigurationInput } from "./grok-backend-configuration.js";
import { GrokConversationBackendDriver } from "./grok-conversation-driver.js";
import type { GrokThreadRepository } from "./grok-thread-repository.js";
import type { OutputArtifactPublisher } from "../../output-artifacts/contracts.js";
import type { GrokRuntimeAssessmentObservation } from "./grok-runtime-advisories.js";

export class GrokBackendDriverFactory implements BackendDriverFactory {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connectionKinds = ["grok_acp"] as const;
  readonly supportsConversationCreation = true;
  readonly creationIdentity = PROVIDER_ASSIGNED_CREATION_IDENTITY;
  readonly #startupEnvironmentVariables: EnvironmentVariableOverrides;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #configuration: GrokBackendConfigurationInput;
  readonly #connections: ReadonlyMap<string, AgentConnectionProfile>;
  readonly #environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #submissionCorrelationKey: Uint8Array;
  readonly #agentToolCli: AgentToolCliAvailability;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentTools: BackendAgentToolFacade;
  readonly #settings: GrokThreadRepository;
  readonly #outputArtifacts: OutputArtifactPublisher;
  readonly #beginRuntimeAssessmentObservation: () => GrokRuntimeAssessmentObservation;
  readonly #drivers = new Map<string, GrokConversationBackendDriver>();
  #closed = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
    readonly instance: AgentBackendInstance;
    readonly connections: readonly AgentConnectionProfile[];
    readonly configuration: GrokBackendConfigurationInput;
    readonly environmentChannel: ExecutionEnvironmentChannelProvider;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly submissionCorrelationKey: Uint8Array;
    readonly agentToolCli: AgentToolCliAvailability;
    readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly agentTools: BackendAgentToolFacade;
    readonly settings: GrokThreadRepository;
    readonly outputArtifacts: OutputArtifactPublisher;
    readonly beginRuntimeAssessmentObservation: () => GrokRuntimeAssessmentObservation;
  }) {
    this.scope = Object.freeze({ ...input.scope });
    this.#startupEnvironmentVariables = input.startupEnvironmentVariables ?? {};
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = Object.freeze({ ...input.instance });
    this.#configuration = input.configuration;
    this.#environmentChannel = input.environmentChannel;
    this.#environment = Object.freeze({ ...input.environment });
    this.#submissionCorrelationKey = new Uint8Array(
      input.submissionCorrelationKey,
    );
    this.#agentToolCli = input.agentToolCli;
    this.#agentToolSourceCapabilities = input.agentToolSourceCapabilities;
    this.#agentTools = input.agentTools;
    this.#settings = input.settings;
    this.#outputArtifacts = input.outputArtifacts;
    this.#beginRuntimeAssessmentObservation =
      input.beginRuntimeAssessmentObservation;
    this.#connections = new Map(
      input.connections.map((connection) => [
        connection.id,
        Object.freeze({ ...connection }),
      ]),
    );
    if (
      this.instance.kind !== "grok_build" ||
      this.instance.tenantId !== this.scope.tenantId ||
      this.#submissionCorrelationKey.byteLength !== 32 ||
      this.#connections.size !== input.connections.length
    ) {
      throw new Error("grok_driver_factory_configuration_invalid");
    }
  }

  create(connection: AgentConnectionProfile): GrokConversationBackendDriver {
    if (this.#closed) throw new Error("grok_driver_factory_closed");
    const admitted = this.#connections.get(connection.id);
    if (!admitted || !sameConnection(admitted, connection)) {
      throw new Error("grok_driver_factory_connection_invalid");
    }
    const existing = this.#drivers.get(connection.id);
    if (existing) return existing;
    const driver = new GrokConversationBackendDriver({
        resolveThreadEnvironment: this.#resolveThreadEnvironment,
        startupEnvironmentVariables: this.#startupEnvironmentVariables,
      configuration: this.#configuration,
      instance: this.instance,
      connection,
      environmentChannel: this.#environmentChannel,
      environment: this.#environment,
      submissionCorrelationKey: this.#submissionCorrelationKey,
      agentToolCli: this.#agentToolCli,
      agentToolSourceCapabilities: this.#agentToolSourceCapabilities,
      agentTools: this.#agentTools,
      settings: this.#settings,
      outputArtifacts: this.#outputArtifacts,
      beginRuntimeAssessmentObservation:
        this.#beginRuntimeAssessmentObservation,
    });
    this.#drivers.set(connection.id, driver);
    return driver;
  }

  async startupEnvironmentState(): Promise<"not_started" | "started"> {
    return [...this.#drivers.values()].some(driver => driver.startupEnvironmentState() === "started") ? "started" : "not_started";
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closures = await Promise.allSettled(
      [...this.#drivers.values()].map(async (driver) => await driver.close()),
    );
    this.#drivers.clear();
    const failures = closures.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "grok_driver_factory_close_failed");
    }
  }
}

function sameConnection(
  left: AgentConnectionProfile,
  right: AgentConnectionProfile,
): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.templateId === right.templateId &&
    left.kind === right.kind &&
    left.backendInstanceId === right.backendInstanceId &&
    left.executionEnvironmentId === right.executionEnvironmentId &&
    left.label === right.label &&
    left.enabled === right.enabled &&
    left.configurationRevision === right.configurationRevision
  );
}
