import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  BackendError,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type ConversationBackendDriver,
} from "../contracts.js";
import type { BackendDriverFactory } from "../registry.js";
import type { AgentToolCliAvailability } from "../module.js";
import { ClaudeConversationBackendDriver } from "./claude-conversation-driver.js";
import { captureClaudeChildEnvironment } from "./claude-child-environment.js";
import type { ClaudeRuntimeClient } from "./claude-runtime-client.js";
import type { ClaudeThreadRepository } from "./claude-thread-repository.js";
import { copyClaudeForkBoundaryKey } from "./claude-fork-context-boundary.js";
import type { ClaudePermissionPolicy } from "./claude-permission-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import type {
  ClaudeRuntimeVersionObservation,
  ClaudeRuntimeVersionObservationSource,
} from "./claude-runtime-installation-advisories.js";

import type { UsageSink } from "../../usage/contracts.js";

export class ClaudeBackendDriverFactory implements BackendDriverFactory {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connectionKinds = ["claude_agent_sdk"] as const;
  readonly supportsConversationCreation = true;
  readonly creationIdentity = APPLICATION_ASSIGNED_CREATION_IDENTITY;
  readonly #usage: UsageSink;
  readonly #nativeNamespace: string;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #runtimeClient: ClaudeRuntimeClient;
  readonly #executablePath: string;
  readonly #initializationTimeoutMs: number;
  readonly #probeDirectory: string;
  readonly #settings: ClaudeThreadRepository;
  readonly #permissionPolicy: ClaudePermissionPolicy;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #attachmentProvenanceKey: Uint8Array;
  readonly #connections: ReadonlyMap<string, AgentConnectionProfile>;
  readonly #agentToolCli: AgentToolCliAvailability;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentTools: BackendAgentToolFacade;
  readonly #childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #toolProvenanceKey: Uint8Array;
  readonly #beginVersionObservation:
    | ((
        source: ClaudeRuntimeVersionObservationSource,
      ) => ClaudeRuntimeVersionObservation)
    | undefined;
  readonly #drivers = new Map<string, ClaudeConversationBackendDriver>();
  readonly #activeSessions = new Set<string>();
  #closed = false;

  constructor(input: {
    readonly usage: UsageSink;
    readonly nativeNamespace: string;
    readonly scope: RequestScope;
    readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
    readonly instance: AgentBackendInstance;
    readonly runtimeClient: ClaudeRuntimeClient;
    readonly executablePath: string;
    readonly initializationTimeoutMs: number;
    readonly probeDirectory: string;
    readonly settings: ClaudeThreadRepository;
    readonly permissionPolicy: ClaudePermissionPolicy;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly attachmentProvenanceKey: Uint8Array;
    readonly connections: readonly AgentConnectionProfile[];
    readonly agentToolCli: AgentToolCliAvailability;
    readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly agentTools: BackendAgentToolFacade;
    readonly toolProvenanceKey: Uint8Array;
    readonly childEnvironment: Readonly<Record<string, string | undefined>>;
    readonly beginVersionObservation?: (
      source: ClaudeRuntimeVersionObservationSource,
    ) => ClaudeRuntimeVersionObservation;
  }) {
    this.#usage = input.usage;
    this.#nativeNamespace = input.nativeNamespace;
    this.scope = Object.freeze({ ...input.scope });
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = input.instance;
    this.#runtimeClient = input.runtimeClient;
    this.#executablePath = input.executablePath;
    this.#initializationTimeoutMs = input.initializationTimeoutMs;
    this.#probeDirectory = input.probeDirectory;
    this.#settings = input.settings;
    this.#permissionPolicy = input.permissionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#attachmentProvenanceKey = new Uint8Array(
      input.attachmentProvenanceKey,
    );
    this.#agentToolCli = input.agentToolCli;
    this.#agentToolSourceCapabilities = input.agentToolSourceCapabilities;
    this.#agentTools = input.agentTools;
    this.#toolProvenanceKey = copyClaudeForkBoundaryKey(
      input.toolProvenanceKey,
    );
    this.#childEnvironment = captureClaudeChildEnvironment(
      input.childEnvironment,
    );
    this.#beginVersionObservation = input.beginVersionObservation;
    this.#connections = new Map(
      input.connections.map((connection) => [connection.id, connection]),
    );
    if (
      input.instance.kind !== "claude_agent_sdk" ||
      input.instance.tenantId !== input.scope.tenantId ||
      this.#connections.size !== input.connections.length
    ) {
      throw new Error("claude_driver_factory_configuration_invalid");
    }
  }

  create(connection: AgentConnectionProfile): ConversationBackendDriver {
    const configured = this.#connections.get(connection.id);
    if (
      this.#closed ||
      !configured ||
      !sameConnection(configured, connection) ||
      !connection.enabled ||
      connection.kind !== "claude_agent_sdk" ||
      connection.tenantId !== this.scope.tenantId ||
      connection.ownerPrincipalId !== this.scope.principalId ||
      connection.backendInstanceId !== this.instance.id
    ) {
      throw new Error("claude_driver_factory_connection_mismatch");
    }
    let driver = this.#drivers.get(connection.id);
    if (!driver) {
      driver = new ClaudeConversationBackendDriver({
        usage: this.#usage,
        nativeNamespace: this.#nativeNamespace,
        resolveThreadEnvironment: this.#resolveThreadEnvironment,
        instance: this.instance,
        connection,
        runtimeClient: this.#runtimeClient,
        executablePath: this.#executablePath,
        initializationTimeoutMs: this.#initializationTimeoutMs,
        probeDirectory: this.#probeDirectory,
        settings: this.#settings,
        permissionPolicy: this.#permissionPolicy,
        modelPolicy: this.#modelPolicy,
        attachmentProvenanceKey: this.#attachmentProvenanceKey,
        agentToolCli: this.#agentToolCli,
        agentToolSourceCapabilities: this.#agentToolSourceCapabilities,
        agentTools: this.#agentTools,
        toolProvenanceKey: copyClaudeForkBoundaryKey(this.#toolProvenanceKey),
        childEnvironment: this.#childEnvironment,
        ...(this.#beginVersionObservation
          ? { beginVersionObservation: this.#beginVersionObservation }
          : {}),
        acquireSession: (sessionId) => this.#acquireSession(sessionId),
      });
      this.#drivers.set(connection.id, driver);
    }
    return driver;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#drivers.values()].map((driver) => driver.close()),
    );
    this.#drivers.clear();
    this.#activeSessions.clear();
  }

  #acquireSession(sessionId: string): () => void {
    if (this.#closed) {
      throw unavailable("The Claude backend is shutting down.");
    }
    if (this.#activeSessions.has(sessionId)) {
      throw unavailable("The Claude session is already attached.");
    }
    this.#activeSessions.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeSessions.delete(sessionId);
    };
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

function unavailable(message: string): BackendError {
  return new BackendError({
    category: "unavailable",
    retryable: true,
    crossedSubmissionBoundary: false,
    safeMessage: message,
  });
}
