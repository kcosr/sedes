import type Database from "better-sqlite3";
import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import type {
  PiBindingDetailsRecord,
  PiThreadSettingsRecord,
} from "./pi-conversation-repository.js";
import { PiConversationRepository } from "./pi-conversation-repository.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  RegisteredBackendActionInput,
} from "../contracts.js";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import type { ConnectionSettingPreferenceRepository } from "../../db/repositories/connection-setting-preference-repository.js";
import {
  extractPiNativeSessionPath,
  parsePiBindingDetail,
} from "./pi-session-store.js";
import {
  decodePiModelSetting,
  requirePiThinkingLevel,
} from "./pi-thread-presentation-provider.js";
import { isPiToolAccessMode } from "./pi-tool-access.js";
import { PiSessionClaims } from "./pi-session-claims.js";

/**
 * Pi's transactional participant in the backend-neutral conversation
 * lifecycle. Opaque detail is persisted verbatim; parsing is confined to this
 * Pi boundary and only extracts identity/path fields used by constraints.
 */
export class PiBackendThreadPersistenceAdapter implements BackendThreadPersistenceAdapter {
  readonly #pi: PiConversationRepository;
  readonly #preferences: ConnectionSettingPreferenceRepository;

  constructor(
    repository: PiConversationRepository,
    preferences: ConnectionSettingPreferenceRepository,
    readonly profile: {
      readonly connectionKind: "pi_sdk" | "pi_rpc";
      readonly parseBinding: (value: string) => { readonly backendConversationId: string; readonly sessionFile: string };
      readonly resolveDefaults?: (connection: AgentConnectionProfile) => { readonly modelProvider?: string; readonly modelId?: string; readonly thinkingLevel?: string };
    } = { connectionKind: "pi_sdk", parseBinding: value => {
      const parsed = parsePiBindingDetail(value);
      return { backendConversationId: parsed.backendConversationId,
        sessionFile: extractPiNativeSessionPath(value, parsed.backendConversationId) };
    } },
  ) {
    if (repository.database !== preferences.database) {
      throw new Error("pi_preference_database_mismatch");
    }
    this.#pi = repository;
    this.#preferences = preferences;
  }

  get database(): Database.Database {
    return this.#pi.database;
  }

  isDiscoveredConversationClaimed(scope: RequestScope, connection: AgentConnectionProfile,
    input: { readonly backendConversationId: string; readonly opaqueBindingDetail: string }): boolean {
    const parsed = this.profile.parseBinding(input.opaqueBindingDetail);
    if (parsed.backendConversationId !== input.backendConversationId) throw new DomainError("conflict", "The Pi discovery identity changed.");
    return new PiSessionClaims(this.database).isClaimed(scope, {
      backendInstanceId: connection.backendInstanceId, executionEnvironmentId: connection.executionEnvironmentId,
      sessionId: parsed.backendConversationId, sessionFile: parsed.sessionFile,
    });
  }

  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    this.#assertThreadTarget(scope, applicationThreadId, connection);
    this.#pi.initializeSettings(scope, applicationThreadId, {
      toolMode: "full",
    });
  }

  initializeForkThread(
    scope: RequestScope,
    sourceApplicationThreadId: string,
    childApplicationThreadId: string,
    connection: AgentConnectionProfile,
    effectiveSettings: BackendEffectiveSettings,
  ): PiThreadSettingsRecord {
    this.#assertThreadTarget(scope, sourceApplicationThreadId, connection);
    this.#assertThreadTarget(scope, childApplicationThreadId, connection);
    if (!effectiveSettings.toolAccess) {
      throw new DomainError(
        "conflict",
        "Pi fork settings are missing effective tool access.",
      );
    }
    return this.#pi.initializeForkSettings(scope, childApplicationThreadId, {
      ...(effectiveSettings.model
        ? {
            modelProvider: effectiveSettings.model.provider,
            modelId: effectiveSettings.model.id,
          }
        : {}),
      ...(effectiveSettings.thinkingLevel
        ? { thinkingLevel: effectiveSettings.thinkingLevel }
        : {}),
      toolMode: effectiveSettings.toolAccess,
    });
  }

  readForkSettings(
    scope: RequestScope,
    childApplicationThreadId: string,
  ): BackendEffectiveSettings {
    const settings = this.#pi.getSettings(scope, childApplicationThreadId);
    return {
      ...(settings.modelProvider && settings.modelId
        ? {
            model: {
              provider: settings.modelProvider,
              id: settings.modelId,
            },
          }
        : {}),
      ...(settings.thinkingLevel
        ? { thinkingLevel: settings.thinkingLevel }
        : {}),
      toolAccess: settings.toolMode,
    };
  }

  initializeNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    catalog: BackendCatalog,
  ): void {
    this.#assertThreadTarget(scope, applicationThreadId, connection);
    const defaults = this.profile.resolveDefaults?.(connection);
    const modelPreference = this.#preferences.find(
      scope,
      connection.id,
      "model",
    );
    const nativeDefaults = catalog.models.filter(model => model.isDefault);
    const nativeDefault = nativeDefaults.length === 1 ? nativeDefaults[0] : undefined;
    let preferredModel:
      { readonly provider: string; readonly modelId: string } | undefined;
    if (modelPreference) {
      try {
        const decoded = decodePiModelSetting(modelPreference.value);
        if (
          catalog.models.filter(
            ({ provider, id }) =>
              provider === decoded.provider && id === decoded.modelId,
          ).length === 1
        ) {
          preferredModel = decoded;
        }
      } catch {
        preferredModel = undefined;
      }
    }
    const thinkingPreference = this.#preferences.find(
      scope,
      connection.id,
      "thinking_level",
    );
    let preferredThinkingLevel: string | undefined;
    if (thinkingPreference) {
      try {
        preferredThinkingLevel = requirePiThinkingLevel(
          thinkingPreference.value,
        );
      } catch {
        preferredThinkingLevel = undefined;
      }
    }
    if (!modelPreference) {
      if (defaults?.modelProvider && defaults.modelId) {
        if (catalog.models.filter(model => model.provider === defaults.modelProvider && model.id === defaults.modelId).length === 1)
          preferredModel = { provider: defaults.modelProvider, modelId: defaults.modelId };
      } else if (nativeDefault) {
        preferredModel = { provider: nativeDefault.provider, modelId: nativeDefault.id };
      }
    }
    if (!thinkingPreference) {
      const model = catalog.models.find(model => model.provider === preferredModel?.provider && model.id === preferredModel.modelId);
      const defaultEffort = defaults?.thinkingLevel ?? (model === nativeDefault ? nativeDefault?.defaultReasoningEffort : undefined);
      if (model && defaultEffort && (!model.supportedReasoningEfforts || model.supportedReasoningEfforts.includes(defaultEffort))) {
        try { preferredThinkingLevel = requirePiThinkingLevel(defaultEffort); }
        catch { preferredThinkingLevel = undefined; }
      }
    }
    this.#pi.initializeSettings(scope, applicationThreadId, {
      ...(preferredModel
        ? {
            modelProvider: preferredModel.provider,
            modelId: preferredModel.modelId,
          }
        : {}),
      ...(preferredThinkingLevel
        ? { thinkingLevel: preferredThinkingLevel }
        : {}),
      toolMode: "full",
    });
  }

  /**
   * Initializes one new draft from an already-resolved SavedAgent/Custom
   * configuration. Unlike ordinary target-default initialization, this path
   * must not read or update connection preferences: the caller has already
   * completed and validated the exact tuple outside the transaction.
   */
  initializeResolvedNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    resolved: {
      readonly modelProvider: string;
      readonly modelId: string;
      readonly thinkingLevel?: string;
      readonly toolAccess: "read_only" | "ask" | "full";
    },
  ): PiThreadSettingsRecord {
    this.#assertThreadTarget(scope, applicationThreadId, connection);
    if (resolved.thinkingLevel !== undefined) {
      requirePiThinkingLevel(resolved.thinkingLevel);
    }
    if (!isPiToolAccessMode(resolved.toolAccess)) {
      throw new DomainError(
        "conflict",
        "The resolved Pi tool access is invalid.",
      );
    }
    return this.#pi.initializeForkSettings(scope, applicationThreadId, {
      modelProvider: resolved.modelProvider,
      modelId: resolved.modelId,
      ...(resolved.thinkingLevel !== undefined
        ? { thinkingLevel: resolved.thinkingLevel }
        : {}),
      toolMode: resolved.toolAccess,
    });
  }

  #assertThreadTarget(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    if (
      connection.kind !== this.profile.connectionKind ||
      connection.tenantId !== scope.tenantId ||
      connection.ownerPrincipalId !== scope.principalId
    ) {
      throw new DomainError(
        "conflict",
        "The Pi connection does not match the thread owner.",
      );
    }
    const target = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | {
          backendInstanceId: string;
          connectionProfileId: string;
          executionEnvironmentId: string;
        }
      | undefined;
    if (
      !target ||
      target.backendInstanceId !== connection.backendInstanceId ||
      target.connectionProfileId !== connection.id ||
      target.executionEnvironmentId !== connection.executionEnvironmentId
    ) {
      throw new DomainError(
        "conflict",
        "The Pi connection does not match the thread target.",
      );
    }
  }

  validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    catalog: BackendCatalog,
  ): void {
    const settings = this.#pi.getSettings(scope, applicationThreadId);
    const selectedModel = catalog.models.find(
      ({ provider, id }) =>
        provider === settings.modelProvider && id === settings.modelId,
    );
    if (!selectedModel) {
      throw new DomainError(
        "invalid_transition",
        "Choose an available model before starting this thread.",
      );
    }
    if (settings.thinkingLevel === null) {
      throw new DomainError(
        "invalid_transition",
        "Choose a thinking level before starting this thread.",
      );
    } else {
      try {
        requirePiThinkingLevel(settings.thinkingLevel);
      } catch {
        throw new DomainError(
          "invalid_transition",
          "Choose a valid thinking level before starting this thread.",
        );
      }
      if (
        selectedModel.supportedReasoningEfforts !== undefined &&
        !selectedModel.supportedReasoningEfforts.includes(
          settings.thinkingLevel,
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          "The selected thinking level is not available for this model.",
        );
      }
    }
    if (!isPiToolAccessMode(settings.toolMode)) {
      throw new DomainError(
        "invalid_transition",
        "Choose valid Pi tool access before starting this thread.",
      );
    }
  }

  initializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): readonly RegisteredBackendActionInput[] {
    const settings = this.#pi.getSettings(scope, applicationThreadId);
    const operationId = (settingId: string) =>
      `${attemptId}:initial-setting:${settings.revision}:${settingId}`;
    return [
      ...(settings.modelProvider === null || settings.modelId === null
        ? []
        : [
            {
              applicationOperationId: operationId("model"),
              action: "set_model" as const,
              provider: settings.modelProvider,
              modelId: settings.modelId,
            },
          ]),
      ...(settings.thinkingLevel === null
        ? []
        : [
            {
              applicationOperationId: operationId("thinking_level"),
              action: "set_thinking_level" as const,
              level: settings.thinkingLevel,
            },
          ]),
      {
        applicationOperationId: operationId("tool_access"),
        action: "set_tool_access",
        mode: settings.toolMode,
      },
    ];
  }

  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly applicationOperationId: string;
      readonly mutationId: string;
      readonly reconciliationToken: string;
    },
  ): void {
    if (
      input.mutationId.length === 0 ||
      input.reconciliationToken.length === 0
    ) {
      throw new DomainError(
        "conflict",
        "Pi submission identities must not be empty.",
      );
    }
    this.#pi.createSubmissionDetails(scope, applicationThreadId, {
      operationId: input.applicationOperationId,
      creationAttemptId: attemptId,
    });
  }

  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean {
    return (
      this.#pi.findSubmissionDetails(
        scope,
        applicationThreadId,
        applicationOperationId,
      )?.creationAttemptId === attemptId
    );
  }

  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): PiBindingDetailsRecord {
    const parsed = this.profile.parseBinding(opaqueBindingDetail);
    return this.#pi.saveBindingDetails(scope, applicationThreadId, {
      backendConversationId: parsed.backendConversationId,
      opaqueBindingDetail,
      nativeSessionPath: parsed.sessionFile,
    });
  }

  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    return this.#pi.getBindingDetail(scope, applicationThreadId);
  }

  getSettings(
    scope: RequestScope,
    applicationThreadId: string,
  ): PiThreadSettingsRecord {
    return this.#pi.getSettings(scope, applicationThreadId);
  }

  readDesiredSettings(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): PiThreadSettingsRecord {
    this.#assertThreadTarget(scope, applicationThreadId, connection);
    return this.#pi.getSettings(scope, applicationThreadId);
  }
}
