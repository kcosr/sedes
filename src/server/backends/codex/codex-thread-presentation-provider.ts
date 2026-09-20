import { createHash } from "node:crypto";
import type {
  ComposerCommandDescriptor,
  ComposerSkillDescriptor,
  SettingDescriptor,
  ThreadSettingsSnapshot,
} from "../../../shared/protocol/conversation.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BACKEND_BRANDS, type BackendModelDescriptor } from "../contracts.js";
import type { ThreadApplicationPresentation } from "../../conversations/thread-application-service.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import {
  CODEX_EXECUTION_FEATURE_REF,
  type CodexExecutionStateV1,
} from "./codex-execution-feature.js";
import {
  CODEX_FAST_MODE_FEATURE_REF,
  type CodexFastModeStateV1,
} from "./codex-fast-mode-feature.js";
import {
  availableCodexGoalActionIds,
  CODEX_GOAL_FEATURE_REF,
  type CodexGoalStateV1,
} from "./codex-goal-feature.js";
import type { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import type {
  CodexExecutionPolicyAllowlist,
  CodexExecutionPolicySelection,
} from "./codex-execution-policy.js";
import { encodeCodexModelSetting } from "./codex-setting-values.js";
import type {
  CodexThreadExecutionSettingsRecord,
  CodexThreadExecutionSettingsRepository,
} from "./codex-thread-execution-settings-repository.js";
import type { CodexManagedTuiController } from "./codex-managed-tui-controller.js";
import {
  availableCodexTuiActionIds,
  CODEX_TUI_FEATURE_REF,
} from "./codex-tui-feature.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

type ThreadState = {
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly enabledAutomation: number;
};

export class CodexThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(
    readonly input: {
      readonly settings: CodexThreadExecutionSettingsRepository;
      readonly executionPolicy: CodexExecutionPolicyAllowlist;
      readonly modelPolicy: CompiledBackendModelPolicy;
      readonly goalSessions?: CodexGoalSessionRegistry;
      readonly managedTui?: CodexManagedTuiController;
      readonly fastModeRuntime?: {
        projection(
          scope: Parameters<
            ThreadBackendPresentationProvider["read"]
          >[0]["scope"],
          applicationThreadId: string,
        ):
          | {
              readonly revision: number;
              readonly enabled: boolean;
              readonly availability: "available" | "unavailable";
              readonly unavailableReason?: string;
            }
          | undefined;
      };
    },
  ) {}

  async read(
    input: Parameters<ThreadBackendPresentationProvider["read"]>[0],
  ): Promise<ThreadApplicationPresentation> {
    if (
      input.connection.kind !== "codex_app_server" ||
      input.backend.kind !== "codex_app_server" ||
      (input.catalog !== undefined && input.workspace === undefined)
    ) {
      throw new Error("codex_thread_presentation_target_invalid");
    }
    const thread = this.#threadState(input.scope, input.applicationThreadId);
    const catalog = input.catalog ?? {
      models: [],
      commands: [],
      skills: [],
      notices: [],
    };
    const catalogKnown = input.catalog !== undefined;
    const settings = this.input.settings.find(
      input.scope,
      input.applicationThreadId,
    );
    if (!settings) throw new Error("codex_thread_settings_missing");

    const models = catalog.models.flatMap((model) => {
      if (!model.supportedReasoningEfforts?.length) {
        return [];
      }
      try {
        const allowedReasoningEfforts = model.supportedReasoningEfforts.filter(
          (reasoningEffort) =>
            this.input.modelPolicy.isSelectionAllowed({
              modelId: model.id,
              reasoningEffort,
            }),
        );
        if (allowedReasoningEfforts.length === 0) return [];
        const preferredEffort =
          model.id === settings.desired?.model &&
          allowedReasoningEfforts.includes(settings.desired.reasoningEffort)
            ? settings.desired.reasoningEffort
            : model.defaultReasoningEffort &&
                allowedReasoningEfforts.includes(model.defaultReasoningEffort)
              ? model.defaultReasoningEffort
              : undefined;
        const selectableEfforts = preferredEffort
          ? [preferredEffort]
          : allowedReasoningEfforts;
        return selectableEfforts.map((selectedReasoningEffort) => ({
          ...model,
          supportedReasoningEfforts: allowedReasoningEfforts,
          optionLabel:
            selectableEfforts.length === 1
              ? model.label
              : `${model.label} (${reasoningLabel(selectedReasoningEffort)})`,
          value: encodeCodexModelSetting(
            model.id,
            selectedReasoningEffort,
            model.fastMode?.supported === true,
            model.fastMode?.defaultSelection ?? "standard",
          ),
        }));
      } catch {
        return [];
      }
    });
    const desiredModel = models.find(
      ({ id }) => id === settings.desired?.model,
    );
    const effectiveModel = models.find(
      ({ id }) => id === settings.effective?.model,
    );
    const desiredModelValue = modelSettingValue(
      settings.desired?.model,
      settings.desired?.reasoningEffort,
      desiredModel,
      settings.desired?.serviceTier,
    );
    const effectiveModelValue =
      settings.effective?.model === settings.desired?.model
        ? desiredModelValue
        : modelSettingValue(
            settings.effective?.model,
            settings.effective?.reasoningEffort,
            effectiveModel,
            settings.effective?.serviceTier ?? undefined,
          );
    const reasoningOptions = desiredModel?.supportedReasoningEfforts ?? [];
    const modelOptions = [
      ...models.map((model) => ({
        value: model.value,
        label: boundDisplayText(model.optionLabel),
        available: true,
      })),
    ];
    if (
      desiredModelValue &&
      !modelOptions.some(({ value }) => value === desiredModelValue)
    ) {
      modelOptions.push({
        value: desiredModelValue,
        label: boundDisplayText(
          catalogKnown
            ? `${settings.desired!.model} (unavailable)`
            : settings.desired!.model,
        ),
        available: !catalogKnown,
        ...(!catalogKnown ||
        this.input.modelPolicy.isSelectionAllowed({
          modelId: settings.desired!.model,
          reasoningEffort: settings.desired!.reasoningEffort,
        })
          ? {}
          : {
              unavailableReason: boundDisplayText(
                "This model or reasoning effort is not allowed by the backend policy.",
              ),
            }),
      });
    }
    const presentedReasoningOptions =
      !catalogKnown && settings.desired?.reasoningEffort
        ? [settings.desired.reasoningEffort]
        : reasoningOptions;
    const settingDescriptors: SettingDescriptor[] = [
      {
        id: "model",
        label: boundDisplayText("Model"),
        requiredForFirstSubmission: true,
        available: models.length > 0 && thread.enabledAutomation === 0,
        ...(models.length === 0
          ? {
              unavailableReason: boundDisplayText(
                catalogKnown
                  ? "No models allowed by this backend policy are currently available."
                  : "Refreshing the Codex model catalog.",
              ),
            }
          : thread.enabledAutomation > 0
            ? {
                unavailableReason: boundDisplayText(
                  "Disable the automation before changing Codex execution settings.",
                ),
              }
            : {}),
        options: modelOptions,
      },
      {
        id: "thinking_level",
        label: boundDisplayText("Reasoning"),
        requiredForFirstSubmission: true,
        available:
          reasoningOptions.length > 0 && thread.enabledAutomation === 0,
        ...(reasoningOptions.length === 0
          ? {
              unavailableReason: boundDisplayText(
                catalogKnown
                  ? "Choose an available Codex model first."
                  : "Refreshing the Codex model catalog.",
              ),
            }
          : thread.enabledAutomation > 0
            ? {
                unavailableReason: boundDisplayText(
                  "Disable the automation before changing Codex execution settings.",
                ),
              }
            : {}),
        options: presentedReasoningOptions.map((effort) => ({
          value: effort,
          label: boundDisplayText(reasoningLabel(effort)),
          available: true,
        })),
      },
    ];
    const catalogSupportsDesired =
      !catalogKnown ||
      (desiredModel !== undefined &&
        reasoningOptions.includes(settings.desired?.reasoningEffort ?? "") &&
        (settings.desired?.serviceTier !== "fast" ||
          desiredModel.fastMode?.supported === true));
    const catalogSupportsEffective =
      !catalogKnown ||
      settings.effective === null ||
      (effectiveModel !== undefined &&
        effectiveModel.supportedReasoningEfforts?.includes(
          settings.effective.reasoningEffort,
        ) === true &&
        (settings.effective.serviceTier !== "fast" ||
          effectiveModel.fastMode?.supported === true));
    const state = applicationState(
      settings,
      thread.backingState,
      catalogSupportsDesired && catalogSupportsEffective,
    );
    const normalizedSettings: ThreadSettingsSnapshot = {
      revision: settings.revision,
      values: [
        {
          id: "model",
          desiredValue: desiredModelValue,
          effectiveValue: effectiveModelValue,
          applicationState: settingApplicationState(
            state,
            settings.desired?.model,
            settings.effective?.model,
            (!catalogKnown || desiredModel !== undefined) &&
              (settings.effective === null ||
                !catalogKnown ||
                effectiveModel !== undefined),
          ),
        },
        {
          id: "thinking_level",
          desiredValue: settings.desired?.reasoningEffort ?? null,
          effectiveValue: settings.effective?.reasoningEffort ?? null,
          applicationState: settingApplicationState(
            state,
            settings.desired?.reasoningEffort,
            settings.effective?.reasoningEffort,
            catalogSupportsDesired && catalogSupportsEffective,
          ),
        },
      ],
    };
    const allowedActions = allowedExecutionActionIds(
      this.input.executionPolicy,
    );
    const featureAvailability =
      settings.desired && thread.enabledAutomation === 0
        ? ("available" as const)
        : ("read_only" as const);
    const featureCapability = compiledProviderFeatureRegistry.capability(
      CODEX_EXECUTION_FEATURE_REF,
      "codex_app_server",
      {
        revision: settings.revision,
        availability: featureAvailability,
        ...(featureAvailability === "available"
          ? {}
          : {
              unavailableReason: boundDisplayText(
                thread.enabledAutomation > 0
                  ? "Disable the automation before changing Codex permissions."
                  : "Observe or choose complete Codex settings before changing permissions.",
              ),
            }),
        allowedOperationIds: allowedActions,
      },
    );
    const featureState: CodexExecutionStateV1 = {
      desired: settings.desired ? executionSelection(settings.desired) : null,
      effective: settings.effective
        ? {
            sandboxMode: settings.effective.sandboxMode,
            networkAccess: settings.effective.networkAccess,
            approvalPolicy: settings.effective.approvalPolicy,
            approvalReviewer: settings.effective.approvalReviewer,
          }
        : null,
    };
    const goalPresentation = goalFeaturePresentation(
      this.input.goalSessions,
      input.scope,
      input.applicationThreadId,
      thread.backingState,
    );
    const fastModePresentation = fastModeFeaturePresentation({
      runtime: this.input.fastModeRuntime,
      scope: input.scope,
      applicationThreadId: input.applicationThreadId,
      backingState: thread.backingState,
      enabledAutomation: thread.enabledAutomation,
      settings,
      desiredModel,
    });
    const tuiPresentation = this.input.managedTui?.presentation(
      input.scope,
      input.applicationThreadId,
    );
    const commandInvocations = new Set<string>();
    const composerCommands: ComposerCommandDescriptor[] = catalog.commands
      .flatMap((command) => {
        if (
          !command.invocation.startsWith("/") ||
          command.invocation.length < 2 ||
          command.invocation.length > 240 ||
          commandInvocations.has(command.invocation)
        )
          return [];
        commandInvocations.add(command.invocation);
        return [
          {
            invocation: command.invocation,
            source: command.source,
            ...(command.description
              ? { description: boundDisplayText(command.description) }
              : {}),
            ...(command.argumentHint
              ? { argumentHint: boundDisplayText(command.argumentHint) }
              : {}),
          },
        ];
      })
      .slice(0, 512);
    const skillIds = new Set<string>();
    const skills: ComposerSkillDescriptor[] = catalog.skills
      .flatMap((skill) => {
        if (
          skill.id.length < 1 ||
          skill.id.length > 160 ||
          skill.name.length < 1 ||
          skill.reference.length < 1 ||
          skill.reference.length > 240 ||
          skillIds.has(skill.id)
        ) {
          return [];
        }
        skillIds.add(skill.id);
        return [
          {
            id: skill.id,
            name: boundDisplayText(skill.name),
            ...(skill.displayName
              ? { displayName: boundDisplayText(skill.displayName) }
              : {}),
            reference: skill.reference,
            ...(skill.description
              ? { description: boundDisplayText(skill.description) }
              : {}),
          },
        ];
      })
      .slice(0, 512);
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          backendRevision: input.backend.configurationRevision,
          connectionRevision: input.connection.configurationRevision,
          settings,
          models,
          commands: catalog.commands,
          skills: catalog.skills,
          allowedActions,
          enabledAutomation: thread.enabledAutomation,
          goal: goalPresentation
            ? {
                revision: goalPresentation.revision,
                availability: goalPresentation.availability,
                state: goalPresentation.state,
              }
            : null,
          fastMode: fastModePresentation
            ? {
                revision: fastModePresentation.revision,
                availability: fastModePresentation.availability,
                state: fastModePresentation.state,
              }
            : null,
          tui: tuiPresentation
            ? {
                revision: tuiPresentation.revision,
                availability: tuiPresentation.availability,
                state: tuiPresentation.state,
              }
            : null,
        }),
      )
      .digest("base64url")
      .slice(0, 40);
    const providerFeatureCapabilities = [featureCapability];
    const providerFeatureStates = [
      compiledProviderFeatureRegistry.stateEnvelope({
        ref: CODEX_EXECUTION_FEATURE_REF,
        backendKind: "codex_app_server",
        revision: settings.revision,
        providerState: featureState,
      }),
    ];
    if (goalPresentation) {
      providerFeatureCapabilities.push(goalPresentation.capability);
      providerFeatureStates.push(goalPresentation.stateEnvelope);
    }
    if (fastModePresentation) {
      providerFeatureCapabilities.push(fastModePresentation.capability);
      providerFeatureStates.push(fastModePresentation.stateEnvelope);
    }
    if (tuiPresentation) {
      const availability =
        thread.backingState === "bound"
          ? tuiPresentation.availability
          : ("unavailable" as const);
      providerFeatureCapabilities.push(
        compiledProviderFeatureRegistry.capability(
          CODEX_TUI_FEATURE_REF,
          "codex_app_server",
          {
            revision: tuiPresentation.revision,
            availability,
            ...(availability === "available"
              ? {}
              : {
                  unavailableReason: boundDisplayText(
                    thread.backingState === "bound"
                      ? (tuiPresentation.unavailableReason ??
                          "The managed Codex TUI is unavailable.")
                      : "Bind the Codex thread before starting its TUI.",
                  ),
                }),
            allowedOperationIds:
              availability === "available"
                ? availableCodexTuiActionIds(tuiPresentation.state)
                : [],
          },
        ),
      );
      providerFeatureStates.push(
        compiledProviderFeatureRegistry.stateEnvelope({
          ref: CODEX_TUI_FEATURE_REF,
          backendKind: "codex_app_server",
          revision: tuiPresentation.revision,
          providerState: tuiPresentation.state,
        }),
      );
    }
    return {
      revision: `codex_${revision}`,
      backend: {
        label: boundDisplayText(input.backend.label),
        brand: BACKEND_BRANDS[input.backend.kind],
        ...(effectiveModel || desiredModel
          ? {
              modelLabel: boundDisplayText(
                (effectiveModel ?? desiredModel)!.label,
              ),
            }
          : {}),
      },
      interactionMode: "interactive",
      settings: normalizedSettings,
      settingDescriptors,
      nextTurnSettingIds: ["model", "thinking_level"],
      automationAllowed:
        settings.desired !== null &&
        this.input.modelPolicy.isSelectionAllowed({
          modelId: settings.desired.model,
          reasoningEffort: settings.desired.reasoningEffort,
        }) &&
        catalogSupportsDesired,
      providerFeatureCapabilities,
      providerFeatureStates,
      composerCommands,
      skills,
    };
  }

  #threadState(
    scope: Parameters<ThreadBackendPresentationProvider["read"]>[0]["scope"],
    applicationThreadId: string,
  ): ThreadState {
    const row = this.input.settings.database
      .prepare(
        `
      SELECT thread.backing_state AS backingState,
        EXISTS(
          SELECT 1 FROM automation_definitions AS automation
          WHERE automation.tenant_id = thread.tenant_id
            AND automation.owner_principal_id = thread.owner_principal_id
            AND automation.anchor_thread_id = thread.id
            AND automation.enabled = 1 AND automation.deleted_at IS NULL
        ) AS enabledAutomation
      FROM application_threads AS thread
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
        AND thread.id = ?
    `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadState | undefined;
    if (!row) throw new Error("codex_thread_presentation_missing");
    return row;
  }
}

function applicationState(
  settings: CodexThreadExecutionSettingsRecord,
  backingState: ThreadState["backingState"],
  catalogSupported: boolean,
): SettingApplicationState {
  if (backingState === "unbound") return "draft";
  if (settings.effectiveConfirmationState !== "confirmed") {
    return "confirmation_unknown";
  }
  if (
    settings.effective?.sandboxClassification === "external_custom" ||
    settings.effective?.networkClassification === "external_custom" ||
    settings.effective?.approvalPolicyClassification === "external_custom" ||
    settings.effective?.approvalReviewerClassification === "external_custom" ||
    settings.effective?.serviceTierClassification === "external_custom" ||
    !catalogSupported
  ) {
    return "external_custom";
  }
  return settings.desired &&
    settings.effective &&
    settings.desired.model === settings.effective.model &&
    settings.desired.reasoningEffort === settings.effective.reasoningEffort &&
    settings.desired.serviceTier === settings.effective.serviceTier &&
    settings.desired.sandboxMode === settings.effective.sandboxMode &&
    settings.desired.networkAccess === settings.effective.networkAccess &&
    settings.desired.approvalPolicy === settings.effective.approvalPolicy &&
    settings.desired.approvalReviewer === settings.effective.approvalReviewer
    ? "effective"
    : "pending_next_turn";
}

function fastModeFeaturePresentation(input: {
  readonly runtime: CodexThreadPresentationProvider["input"]["fastModeRuntime"];
  readonly scope: Parameters<
    ThreadBackendPresentationProvider["read"]
  >[0]["scope"];
  readonly applicationThreadId: string;
  readonly backingState: ThreadState["backingState"];
  readonly enabledAutomation: number;
  readonly settings: CodexThreadExecutionSettingsRecord;
  readonly desiredModel: BackendModelDescriptor | undefined;
}):
  | {
      readonly revision: number;
      readonly availability: "available" | "read_only";
      readonly state: CodexFastModeStateV1;
      readonly capability: ReturnType<
        typeof compiledProviderFeatureRegistry.capability
      >;
      readonly stateEnvelope: ReturnType<
        typeof compiledProviderFeatureRegistry.stateEnvelope
      >;
    }
  | undefined {
  if (
    !input.settings.desired ||
    input.desiredModel?.fastMode?.supported !== true
  ) {
    return undefined;
  }
  const desired = input.settings.desired.serviceTier;
  const revision = input.settings.revision;
  if (input.backingState === "unbound") {
    const availability =
      input.enabledAutomation === 0
        ? ("available" as const)
        : ("read_only" as const);
    const state: CodexFastModeStateV1 = {
      desired,
      effective: null,
      applicationState: "pending",
    };
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_FAST_MODE_FEATURE_REF,
      "codex_app_server",
      {
        revision,
        availability,
        ...(availability === "available"
          ? {}
          : {
              unavailableReason: boundDisplayText(
                "Disable the automation before changing Fast mode.",
              ),
            }),
        allowedOperationIds:
          availability === "available"
            ? [desired === "fast" ? "disable" : "enable"]
            : [],
      },
    );
    return {
      revision,
      availability,
      state,
      capability,
      stateEnvelope: compiledProviderFeatureRegistry.stateEnvelope({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        revision,
        providerState: state,
      }),
    };
  }
  if (input.backingState !== "bound") return undefined;
  const projection = input.runtime?.projection(
    input.scope,
    input.applicationThreadId,
  );
  if (!projection?.enabled) return undefined;
  const availability =
    input.enabledAutomation === 0 && projection.availability === "available"
      ? ("available" as const)
      : ("read_only" as const);
  const effective = input.settings.effective?.serviceTier ?? null;
  const state: CodexFastModeStateV1 = {
    desired,
    effective,
    applicationState:
      projection.availability !== "available" ||
      input.settings.effectiveConfirmationState !== "confirmed" ||
      input.settings.effective?.serviceTierClassification !== "recognized"
        ? "unknown"
        : desired === effective
          ? "applied"
          : "pending",
  };
  const capability = compiledProviderFeatureRegistry.capability(
    CODEX_FAST_MODE_FEATURE_REF,
    "codex_app_server",
    {
      revision,
      availability,
      ...(availability === "available"
        ? {}
        : {
            unavailableReason: boundDisplayText(
              input.enabledAutomation > 0
                ? "Disable the automation before changing Fast mode."
                : "Fast mode is temporarily unavailable while Codex reconnects.",
            ),
          }),
      allowedOperationIds:
        availability === "available"
          ? [desired === "fast" ? "disable" : "enable"]
          : [],
    },
  );
  return {
    revision,
    availability,
    state,
    capability,
    stateEnvelope: compiledProviderFeatureRegistry.stateEnvelope({
      ref: CODEX_FAST_MODE_FEATURE_REF,
      backendKind: "codex_app_server",
      revision,
      providerState: state,
    }),
  };
}

function settingApplicationState(
  aggregate: SettingApplicationState,
  desired: string | undefined,
  effective: string | undefined,
  supported: boolean,
): SettingApplicationState {
  if (aggregate === "draft" || aggregate === "confirmation_unknown") {
    return aggregate;
  }
  if (!supported) return "external_custom";
  if (desired === undefined || effective === undefined) {
    return aggregate === "external_custom"
      ? "external_custom"
      : "pending_next_turn";
  }
  return desired === effective ? "effective" : "pending_next_turn";
}

function modelSettingValue(
  modelId: string | undefined,
  reasoningEffort: string | undefined,
  descriptor: BackendModelDescriptor | undefined,
  selectedServiceTier: "standard" | "fast" | undefined,
): string | null {
  if (!modelId || !reasoningEffort) return null;
  try {
    return encodeCodexModelSetting(
      modelId,
      reasoningEffort,
      descriptor?.fastMode?.supported === true ||
        selectedServiceTier === "fast",
      descriptor?.fastMode?.defaultSelection ?? "standard",
    );
  } catch {
    return null;
  }
}

type SettingApplicationState =
  | "draft"
  | "effective"
  | "pending_next_turn"
  | "confirmation_unknown"
  | "external_custom";

function executionSelection(
  settings: CodexExecutionPolicySelection,
): CodexExecutionPolicySelection {
  return {
    sandboxMode: settings.sandboxMode,
    networkAccess: settings.networkAccess,
    approvalPolicy: settings.approvalPolicy,
    approvalReviewer: settings.approvalReviewer,
  };
}

function allowedExecutionActionIds(
  policy: CodexExecutionPolicyAllowlist,
): string[] {
  const actions: string[] = [];
  if (policy.allowedSandboxModes.includes("read-only")) {
    actions.push("set_sandbox_read_only");
  }
  if (policy.allowedSandboxModes.includes("workspace-write")) {
    actions.push("set_sandbox_workspace");
  }
  if (
    policy.allowedSandboxModes.includes("danger-full-access") &&
    policy.allowedNetworkAccess.includes("enabled")
  ) {
    actions.push("set_sandbox_unrestricted");
  }
  if (policy.allowedNetworkAccess.includes("disabled")) {
    actions.push("set_network_disabled");
  }
  if (policy.allowedNetworkAccess.includes("enabled")) {
    actions.push("set_network_enabled");
  }
  if (policy.allowedApprovalPolicies.includes("untrusted")) {
    actions.push("set_approval_untrusted");
  }
  if (policy.allowedApprovalPolicies.includes("on-request")) {
    actions.push("set_approval_on_request");
  }
  if (policy.allowedApprovalPolicies.includes("never")) {
    actions.push("set_approval_never");
  }
  if (policy.allowedApprovalReviewers.includes("user")) {
    actions.push("set_reviewer_user");
  }
  if (policy.allowedApprovalReviewers.includes("auto_review")) {
    actions.push("set_reviewer_auto_review");
  }
  return actions;
}

function reasoningLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Maximum";
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function goalFeaturePresentation(
  goalSessions: CodexGoalSessionRegistry | undefined,
  scope: Parameters<ThreadBackendPresentationProvider["read"]>[0]["scope"],
  applicationThreadId: string,
  backingState: ThreadState["backingState"],
):
  | {
      readonly revision: number;
      readonly availability: "available" | "unavailable";
      readonly state: CodexGoalStateV1;
      readonly capability: ReturnType<
        typeof compiledProviderFeatureRegistry.capability
      >;
      readonly stateEnvelope: ReturnType<
        typeof compiledProviderFeatureRegistry.stateEnvelope
      >;
    }
  | undefined {
  // Goal is a bound-thread external feature. Drafts and creating threads do
  // not advertise it until the native binding exists.
  if (!goalSessions || backingState !== "bound") {
    return undefined;
  }
  const record = goalSessions.projection(scope, applicationThreadId);
  if (!record) {
    // Bound but not yet projected — advertise unavailable until authoritative
    // attach reread completes.
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_GOAL_FEATURE_REF,
      "codex_app_server",
      {
        revision: 0,
        availability: "unavailable",
        unavailableReason: boundDisplayText(
          "Codex Goal is reconciling with the provider.",
        ),
        allowedOperationIds: [],
      },
    );
    const state: CodexGoalStateV1 = { state: "unset" };
    return {
      revision: 0,
      availability: "unavailable",
      state,
      capability,
      stateEnvelope: compiledProviderFeatureRegistry.stateEnvelope({
        ref: CODEX_GOAL_FEATURE_REF,
        backendKind: "codex_app_server",
        revision: 0,
        providerState: state,
      }),
    };
  }
  if (record.availability !== "available") {
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_GOAL_FEATURE_REF,
      "codex_app_server",
      {
        revision: record.revision,
        availability: "unavailable",
        unavailableReason: boundDisplayText(
          record.unavailableReason ?? "Codex Goal is temporarily unavailable.",
        ),
        allowedOperationIds: [],
      },
    );
    return {
      revision: record.revision,
      availability: "unavailable",
      state: record.state,
      capability,
      stateEnvelope: compiledProviderFeatureRegistry.stateEnvelope({
        ref: CODEX_GOAL_FEATURE_REF,
        backendKind: "codex_app_server",
        revision: record.revision,
        providerState: record.state,
      }),
    };
  }
  const allowedOperationIds = availableCodexGoalActionIds(record.state);
  const capability = compiledProviderFeatureRegistry.capability(
    CODEX_GOAL_FEATURE_REF,
    "codex_app_server",
    {
      revision: record.revision,
      availability: "available",
      allowedOperationIds,
    },
  );
  return {
    revision: record.revision,
    availability: "available",
    state: record.state,
    capability,
    stateEnvelope: compiledProviderFeatureRegistry.stateEnvelope({
      ref: CODEX_GOAL_FEATURE_REF,
      backendKind: "codex_app_server",
      revision: record.revision,
      providerState: record.state,
    }),
  };
}
