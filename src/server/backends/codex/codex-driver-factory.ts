import type { UsageSink } from "../../usage/contracts.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBackendDriver,
  CreateConversationResult,
  AttachConversationInput,
} from "../contracts.js";
import { PROVIDER_ASSIGNED_CREATION_IDENTITY } from "../contracts.js";
import type { BackendDriverFactory } from "../registry.js";
import type { PreparedCodexConnectionConfiguration } from "./codex-backend-configuration.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import type { CodexServerRequestRouter } from "./codex-server-request-router.js";
import { copyCodexSubmissionCorrelationKey } from "./codex-submission-correlation.js";
import {
  CodexConversationBackendDriver,
  CodexConversationOwnershipRegistry,
} from "./codex-conversation-driver.js";
import type { CodexExecutionSettingsProvider } from "./codex-conversation-handle.js";
import type { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import type { CodexManagedTuiController } from "./codex-managed-tui-controller.js";
import { CodexFastModeSessionRegistry } from "./codex-fast-mode-session.js";
import type { CodexAgentToolCliEnvironmentProvider } from "./codex-agent-tool-cli-environment.js";
import {
  defaultCodexComposerSkillPreferenceReader,
  type CodexComposerSkillPreferenceReader,
} from "./codex-skills.js";

/**
 * Profile-specific drivers over one principal/backend-scoped daemon client.
 */
export class CodexBackendDriverFactory implements BackendDriverFactory {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connectionKinds = ["codex_app_server"] as const;
  readonly supportsConversationCreation = true;
  readonly creationIdentity = PROVIDER_ASSIGNED_CREATION_IDENTITY;
  readonly ownership = new CodexConversationOwnershipRegistry();
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #usageSink: UsageSink;
  readonly #nativeNamespace: string;
  readonly #client: CodexSharedClientFacade;
  readonly #serverRequests: CodexServerRequestRouter;
  readonly #toolProvenanceKey: Uint8Array;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #executionSettings: CodexExecutionSettingsProvider;
  readonly #viewedImageCapture: import("../../output-artifacts/viewed-image-capture.js").ViewedImageCapture;
  readonly #outputArtifacts: import("../../output-artifacts/contracts.js").OutputArtifactPublisher;
  readonly #agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider;
  readonly #composerSkillPreferences: CodexComposerSkillPreferenceReader;
  readonly #goalSessions: CodexGoalSessionRegistry | undefined;
  readonly #fastModeSessions: CodexFastModeSessionRegistry;
  readonly #managedTui: CodexManagedTuiController | undefined;
  readonly #configuredByTemplateId: ReadonlyMap<
    string,
    PreparedCodexConnectionConfiguration
  >;
  readonly #materializedById: ReadonlyMap<string, AgentConnectionProfile>;
  readonly #drivers = new Map<string, CodexConversationBackendDriver>();
  readonly #guardedDrivers = new Map<string, ConversationBackendDriver>();
  readonly #created = new Map<string, { generation: number; release(): Promise<void> }>();
  readonly #now: () => string;
  readonly #onError: (error: unknown) => void;

  constructor(input: {
    readonly usageSink: UsageSink;
    readonly nativeNamespace: string;
    readonly scope: RequestScope;
    readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
    readonly instance: AgentBackendInstance;
    readonly client: CodexSharedClientFacade;
    readonly serverRequests: CodexServerRequestRouter;
    readonly toolProvenanceKey: Uint8Array;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly executionSettings: CodexExecutionSettingsProvider;
    readonly viewedImageCapture: import("../../output-artifacts/viewed-image-capture.js").ViewedImageCapture;
    readonly outputArtifacts: import("../../output-artifacts/contracts.js").OutputArtifactPublisher;
    readonly agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider;
    readonly composerSkillPreferences?: CodexComposerSkillPreferenceReader;
    readonly goalSessions?: CodexGoalSessionRegistry;
    readonly fastModeSessions?: CodexFastModeSessionRegistry;
    readonly managedTui?: CodexManagedTuiController;
    readonly connections: readonly PreparedCodexConnectionConfiguration[];
    readonly materializedConnections: readonly AgentConnectionProfile[];
    readonly now?: () => string;
    readonly onError?: (error: unknown) => void;
  }) {
    this.scope = Object.freeze({ ...input.scope });
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = input.instance;
    this.#usageSink = input.usageSink;
    this.#nativeNamespace = input.nativeNamespace;
    this.#client = input.client;
    this.#serverRequests = input.serverRequests;
    this.#toolProvenanceKey = copyCodexSubmissionCorrelationKey(
      input.toolProvenanceKey,
    );
    this.#modelPolicy = input.modelPolicy;
    this.#executionSettings = input.executionSettings;
    this.#outputArtifacts = input.outputArtifacts;
    this.#viewedImageCapture = input.viewedImageCapture;
    this.#agentToolCliEnvironment = input.agentToolCliEnvironment;
    this.#composerSkillPreferences =
      input.composerSkillPreferences ??
      defaultCodexComposerSkillPreferenceReader;
    this.#goalSessions = input.goalSessions;
    this.#fastModeSessions =
      input.fastModeSessions ?? new CodexFastModeSessionRegistry();
    this.#managedTui = input.managedTui;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#onError = input.onError ?? (() => undefined);
    input.client.subscribeLifecycle(lifecycle => {
      for (const [id, lease] of this.#created) {
        if (lease.generation === lifecycle.generation && lifecycle.state !== "closed") continue;
        this.#created.delete(id);
        void lease.release().catch(this.#onError);
      }
    });
    this.#configuredByTemplateId = new Map(
      input.connections.map((connection) => [connection.id, connection]),
    );
    this.#materializedById = new Map(
      input.materializedConnections.map((connection) => [
        connection.id,
        connection,
      ]),
    );
    if (
      this.instance.kind !== "codex_app_server" ||
      this.instance.tenantId !== this.scope.tenantId ||
      this.#configuredByTemplateId.size !== input.connections.length ||
      this.#materializedById.size !== input.materializedConnections.length
    ) {
      throw new Error("codex_driver_factory_configuration_invalid");
    }
    // Background child accounting must recover when the runtime connects,
    // even if none of its root conversations has an open presentation actor.
    // Driver construction only restores scoped accounting subscriptions.
    for (const connection of input.materializedConnections) {
      if (connection.enabled && this.#configuredByTemplateId.get(connection.templateId)?.enabled) this.create(connection);
    }
  }

  create(connection: AgentConnectionProfile): ConversationBackendDriver {
    const configured = this.#configuredByTemplateId.get(connection.templateId);
    const materialized = this.#materializedById.get(connection.id);
    if (
      !configured ||
      !materialized ||
      !sameConnection(materialized, connection) ||
      !configured.enabled ||
      connection.kind !== "codex_app_server" ||
      connection.tenantId !== this.scope.tenantId ||
      connection.ownerPrincipalId !== this.scope.principalId ||
      connection.backendInstanceId !== this.instance.id ||
      connection.enabled !== configured.enabled
    ) {
      throw new Error("codex_driver_factory_connection_mismatch");
    }
    let driver = this.#drivers.get(connection.id);
    if (!driver) {
      driver = new CodexConversationBackendDriver({
        usageSink: this.#usageSink,
        nativeNamespace: this.#nativeNamespace,
        resolveThreadEnvironment: this.#resolveThreadEnvironment,
        instance: this.instance,
        connection,
        client: this.#client,
        serverRequests: this.#serverRequests,
        ownership: this.ownership,
        toolProvenanceKey: copyCodexSubmissionCorrelationKey(
          this.#toolProvenanceKey,
        ),
        modelPolicy: this.#modelPolicy,
        executionSettings: this.#executionSettings,
        outputArtifacts: this.#outputArtifacts,
        viewedImageCapture: this.#viewedImageCapture,
        agentToolCliEnvironment: this.#agentToolCliEnvironment,
        composerSkillPreferences: this.#composerSkillPreferences,
        fastModeSessions: this.#fastModeSessions,
        ...(this.#goalSessions ? { goalSessions: this.#goalSessions } : {}),
        ...(this.#managedTui ? { managedTui: this.#managedTui } : {}),
        now: this.#now,
        onError: this.#onError,
      });
      this.#drivers.set(connection.id, driver);
    } else if (!sameConnection(driver.connection, connection)) {
      throw new Error("codex_driver_factory_configuration_changed");
    }
    const selected = driver;
    const residency = this.#client.residency;
    if (!residency) return selected;
    const guarded = this.#guardedDrivers.get(connection.id);
    if (guarded) return guarded;
    const created = this.#created;
    const client = this.#client;
    const onError = this.#onError;
    const wrapped = new Proxy(selected, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "health") return value.bind(target);
        return (...args: unknown[]) => residency.run(async () => {
          const result: unknown = await Reflect.apply(value, target, args);
          if (property === "create") {
            // A freshly created empty native thread can exist only in memory.
            // Keep its generation through the durable binding/attach handoff.
            const id = (result as CreateConversationResult).backendConversationId;
            if (!created.has(id)) created.set(id, { generation: client.lifecycleSnapshot().generation, ...residency.retain() });
          } else if (property === "branchConversation") {
            // A fork copies durable native history and can remain unopened in
            // the application. Unlike an empty new thread, it needs no
            // creation-to-attach lease. Main explicitly releases the remote
            // subscription; a later attachment reacquires normal residency.
            const id = (result as CreateConversationResult).backendConversationId;
            try { await client.persistentSessions?.detachThread(id, client.lifecycleSnapshot().generation, true); }
            catch (error) {
              // A cleanup failure cannot undo the successful native fork.
              try { onError(error); } catch { /* Diagnostics only. */ }
            }
          } else if (property === "attach") {
            const id = (args[0] as AttachConversationInput).binding.backendConversationId;
            const pending = created.get(id);
            created.delete(id);
            await pending?.release();
          }
          return result;
        });
      },
    });
    this.#guardedDrivers.set(connection.id, wrapped);
    return wrapped;
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
