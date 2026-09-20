import { z } from "zod";
import {
  projectCodexThread,
  refineCodexThreadItem,
  refineCodexThreadStatus,
  refineCodexThreadTokenUsage,
  refineCodexTurn,
} from "./codex-c1-protocol.js";
import {
  refineCodexThreadGoalClearedNotification,
  refineCodexThreadGoalUpdatedNotification,
} from "./codex-goal-protocol.js";
import type { CodexRpcMethod } from "./rpc/codex-rpc-client.js";
import {
  decodeCodexServerNotificationParams,
  decodeCodexServerRequestParams,
  defineCodexAppServerMethod,
  assertCodexAttestedServerNotificationParams,
  assertCodexAttestedServerRequestParams,
  type CodexAdoptedServerNotificationMethod,
  type CodexClientRequestMethod,
  type OfficialCodexClientRequestParams,
  type OfficialCodexClientRequestResult,
  type OfficialCodexServerNotificationParams,
  type OfficialCodexServerRequestParams,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type {
  CodexServerNotificationMethod,
  CodexServerRequestMethod,
} from "./rpc/protocol.js";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  maximumBase64Characters,
} from "../../../shared/output-artifact-limits.js";

export const CODEX_C2_MAX_TEXT_BYTES = 7 * 1024 * 1024;
export const CODEX_C2_MAX_COLLECTION_ITEMS = 10_000;
export const CODEX_C2_MAX_CATALOG_ITEMS = 1_000;
const CODEX_C2_MAX_AUTH_RECOVERY_MESSAGE_CHARACTERS = 4_096;
const CODEX_C2_MAX_IMAGE_GENERATION_RESULT_CHARACTERS =
  maximumBase64Characters(MAXIMUM_OUTPUT_IMAGE_BYTES);

export type CodexJsonValue =
  | number
  | string
  | boolean
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue | undefined }
  | null;

const nativeTextSchema = z.string().refine(
  (value) => value.length <= CODEX_C2_MAX_TEXT_BYTES,
  "text_bound",
);

// JSON/config maps are intentionally open provider payloads. This is the only
// local structural schema: all Codex RPC wire structures come from generated
// app-server types and validators.
export const codexJsonValueSchema: z.ZodType<CodexJsonValue> = z.lazy(() =>
  z.union([
    z.number().finite(),
    nativeTextSchema,
    z.boolean(),
    z.null(),
    z.array(codexJsonValueSchema).max(CODEX_C2_MAX_COLLECTION_ITEMS),
    z.record(z.string(), codexJsonValueSchema),
  ]),
);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("object_expected");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("unexpected_field");
  }
  return record;
}

function variantKeys(
  value: unknown,
  discriminator: string,
  variants: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown> {
  const record = asRecord(value);
  const variant = record[discriminator];
  if (typeof variant !== "string" || variants[variant] === undefined) {
    throw new Error("unsupported_variant");
  }
  return exactKeys(record, variants[variant]);
}

function assertNativeId(value: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new Error("native_id_bound");
  }
}

function assertSafeCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("safe_integer_bound");
  }
}

function assertSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error("safe_integer_bound");
}

function assertRecordIds(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined) assertNativeId(value as string);
  }
}

function isImageGenerationResultPath(
  path: readonly (string | number)[],
): boolean {
  return (
    (path.length === 2 && path[0] === "item" && path[1] === "result") ||
    (path.length === 4 &&
      path[0] === "turn" &&
      path[1] === "items" &&
      typeof path[2] === "number" &&
      path[3] === "result") ||
    (path.length === 6 &&
      path[0] === "thread" &&
      path[1] === "turns" &&
      typeof path[2] === "number" &&
      path[3] === "items" &&
      typeof path[4] === "number" &&
      path[5] === "result")
  );
}

function assertBounds(
  value: unknown,
  allowImageGenerationResult = false,
  path: readonly (string | number)[] = [],
): void {
  if (typeof value === "string") {
    if (value.length > CODEX_C2_MAX_TEXT_BYTES) {
      throw new Error("text_bound");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("finite_number_bound");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > CODEX_C2_MAX_COLLECTION_ITEMS) {
      throw new Error("collection_bound");
    }
    value.forEach((entry, index) =>
      assertBounds(entry, allowImageGenerationResult, [...path, index]),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      allowImageGenerationResult &&
      key === "result" &&
      "type" in value &&
      value.type === "imageGeneration" &&
      isImageGenerationResultPath([...path, key])
    ) {
      if (
        typeof entry !== "string" ||
        entry.length > CODEX_C2_MAX_IMAGE_GENERATION_RESULT_CHARACTERS
      ) {
        throw new Error("text_bound");
      }
      continue;
    }
    assertBounds(entry, allowImageGenerationResult, [...path, key]);
  }
}

function refineApprovalPolicy(value: unknown): void {
  if (value === null || value === undefined || typeof value === "string") return;
  const granular = exactKeys(value, ["granular"]).granular;
  exactKeys(granular, [
    "sandbox_approval",
    "rules",
    "skill_approval",
    "request_permissions",
    "mcp_elicitations",
  ]);
}

function refineSandboxPolicy(value: unknown, allowExternal = true): void {
  if (value === null || value === undefined) return;
  const policy = asRecord(value);
  if (policy.type === "dangerFullAccess") exactKeys(policy, ["type"]);
  else if (policy.type === "readOnly") exactKeys(policy, ["type", "networkAccess"]);
  else if (policy.type === "workspaceWrite") {
    exactKeys(policy, [
      "type",
      "writableRoots",
      "networkAccess",
      "excludeTmpdirEnvVar",
      "excludeSlashTmp",
    ]);
  } else if (allowExternal && policy.type === "externalSandbox") {
    exactKeys(policy, ["type", "networkAccess"]);
  } else throw new Error("sandbox_policy_unsupported");
}

function refineTurnError(value: unknown): void {
  const error = exactKeys(value, ["message", "codexErrorInfo", "additionalDetails", "misalignment"]);
  if (error.misalignment != null) {
    const misalignment = exactKeys(error.misalignment, ["errorType", "detailedExplanation", "steer"]);
    if (misalignment.steer != null) exactKeys(misalignment.steer, ["message"]);
  }
  if (error.codexErrorInfo != null && typeof error.codexErrorInfo === "object") {
    const info = asRecord(error.codexErrorInfo);
    if (Object.keys(info).length !== 1) throw new Error("codex_error_info_invalid");
    const detail = Object.values(info)[0];
    if (detail !== null && typeof detail === "object") {
      if ("httpStatusCode" in detail) exactKeys(detail, ["httpStatusCode"]);
      else exactKeys(detail, ["turnKind"]);
    }
  }
}

function refineUserInput(value: unknown): void {
  const input = variantKeys(value, "type", {
    text: ["type", "text", "text_elements"],
    image: ["type", "detail", "url"],
    localImage: ["type", "detail", "path"],
    audio: ["type", "url"],
    localAudio: ["type", "path"],
    skill: ["type", "name", "path"],
    mention: ["type", "name", "path"],
  });
  if (input.type === "text") {
    for (const element of input.text_elements as readonly unknown[]) {
      const textElement = exactKeys(element, ["byteRange", "placeholder"]);
      const range = exactKeys(textElement.byteRange, ["start", "end"]);
      assertSafeCount(range.start as number);
      assertSafeCount(range.end as number);
    }
  }
}

type ThreadStartParams = Pick<
  OfficialCodexClientRequestParams<"thread/start">,
  | "model"
  | "serviceTier"
  | "cwd"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "sandbox"
  | "config"
  | "ephemeral"
  | "historyMode"
  | "threadSource"
>;
type ThreadSettingsUpdateParams = Pick<
  OfficialCodexClientRequestParams<"thread/settings/update">,
  | "threadId"
  | "cwd"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "sandboxPolicy"
  | "model"
  | "serviceTier"
  | "effort"
>;

function refineThreadStartParams(
  value: ThreadStartParams,
): OfficialCodexClientRequestParams<"thread/start"> {
  exactKeys(value, [
    "model", "serviceTier", "cwd", "approvalPolicy", "approvalsReviewer",
    "sandbox", "config", "ephemeral", "historyMode", "threadSource",
  ]);
  if (value.approvalPolicy != null && typeof value.approvalPolicy !== "string") {
    throw new Error("approval_policy_unsupported");
  }
  if (value.threadSource != null) assertNativeId(value.threadSource);
  if (
    value.historyMode != null &&
    value.historyMode !== "legacy" &&
    value.historyMode !== "paginated"
  ) {
    throw new Error("history_mode_unsupported");
  }
  if (value.config != null) codexJsonValueSchema.parse(value.config);
  assertBounds(value);
  return value;
}

function refineTurnStartParams(
  value: OfficialCodexClientRequestParams<"turn/start">,
): OfficialCodexClientRequestParams<"turn/start"> {
  exactKeys(value, [
    "threadId", "clientUserMessageId", "input", "cwd", "approvalPolicy",
    "approvalsReviewer", "sandboxPolicy", "model", "serviceTier", "effort",
    "summary", "personality", "outputSchema",
  ]);
  value.input.forEach(refineUserInput);
  refineApprovalPolicy(value.approvalPolicy);
  refineSandboxPolicy(value.sandboxPolicy);
  if (value.outputSchema != null) codexJsonValueSchema.parse(value.outputSchema);
  assertRecordIds(value, ["threadId", "clientUserMessageId"]);
  assertBounds(value);
  return value;
}

function refineSettingsUpdateParams(
  value: ThreadSettingsUpdateParams,
): OfficialCodexClientRequestParams<"thread/settings/update"> {
  exactKeys(value, [
    "threadId", "cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy",
    "model", "serviceTier", "effort",
  ]);
  if (value.approvalPolicy != null && typeof value.approvalPolicy !== "string") {
    throw new Error("approval_policy_unsupported");
  }
  if (value.approvalsReviewer === "guardian_subagent") {
    throw new Error("reviewer_unsupported");
  }
  refineSandboxPolicy(value.sandboxPolicy, false);
  assertNativeId(value.threadId);
  assertBounds(value);
  return value;
}

function refineTurnSteerParams(
  value: OfficialCodexClientRequestParams<"turn/steer">,
): OfficialCodexClientRequestParams<"turn/steer"> {
  exactKeys(value, ["threadId", "clientUserMessageId", "input", "expectedTurnId"]);
  value.input.forEach(refineUserInput);
  assertRecordIds(value, ["threadId", "clientUserMessageId", "expectedTurnId"]);
  assertBounds(value);
  return value;
}

function refineSimpleParams<Value>(
  value: Value,
  keys: readonly string[],
): Value {
  exactKeys(value, keys);
  assertBounds(value);
  return value;
}

function refinePaginatedParams<Value extends Readonly<Record<string, unknown>>>(
  value: Value,
  keys: readonly string[],
): Value {
  refineSimpleParams(value, keys);
  if (value.limit !== null && value.limit !== undefined) {
    assertSafeCount(value.limit as number);
  }
  return value;
}

function refineResult<Method extends CodexClientRequestMethod>(
  value: OfficialCodexClientRequestResult<Method>,
): OfficialCodexClientRequestResult<Method> {
  assertBounds(value);
  return value;
}

function refineEmptyResult<Method extends CodexClientRequestMethod>(
  value: OfficialCodexClientRequestResult<Method>,
): OfficialCodexClientRequestResult<Method> {
  exactKeys(value, []);
  return value;
}

function method<Method extends CodexClientRequestMethod, Params, Result = OfficialCodexClientRequestResult<Method>>(
  name: Method,
  refineParams: (value: Params) => OfficialCodexClientRequestParams<Method>,
  refineResponse: (value: OfficialCodexClientRequestResult<Method>) => Result =
    refineResult as (value: OfficialCodexClientRequestResult<Method>) => Result,
): CodexRpcMethod<Params, Result> {
  return defineCodexAppServerMethod<Method, Params, Result>({
    method: name,
    refineParams: (value) => refineParams(value as Params),
    refineResult: refineResponse,
  });
}

function projectThreadStartResponse(
  value: OfficialCodexClientRequestResult<"thread/start">,
) {
  // Thread start historically projected the reviewed result fields and
  // ignored additive provider metadata at this top-level boundary.
  asRecord(value);
  assertBounds(value, true);
  if (value.runtimeWorkspaceRoots.length > CODEX_C2_MAX_CATALOG_ITEMS || value.instructionSources.length > CODEX_C2_MAX_CATALOG_ITEMS) throw new Error("thread_start_collection_bound");
  refineApprovalPolicy(value.approvalPolicy);
  refineSandboxPolicy(value.sandbox);
  if (value.activePermissionProfile != null) {
    exactKeys(value.activePermissionProfile, ["id", "extends"]);
    assertNativeId(value.activePermissionProfile.id);
  }
  if (typeof value.multiAgentMode === "object") exactKeys(value.multiAgentMode, ["custom"]);
  return {
    thread: projectCodexThread(value.thread),
    model: value.model,
    modelProvider: value.modelProvider,
    serviceTier: value.serviceTier,
    cwd: value.cwd,
    runtimeWorkspaceRoots: value.runtimeWorkspaceRoots,
    instructionSources: value.instructionSources,
    approvalPolicy: value.approvalPolicy,
    approvalsReviewer: value.approvalsReviewer,
    sandbox: value.sandbox,
    activePermissionProfile: value.activePermissionProfile,
    reasoningEffort: value.reasoningEffort,
    multiAgentMode: value.multiAgentMode,
  };
}

export const codexThreadStartMethod = method(
  "thread/start",
  refineThreadStartParams,
  projectThreadStartResponse,
);
export const codexTurnStartMethod = method("turn/start", refineTurnStartParams, (value) => {
  exactKeys(value, ["turn"]);
  assertBounds(value, true);
  return { turn: refineCodexTurn(value.turn) };
});
export const codexThreadSettingsUpdateMethod = method(
  "thread/settings/update",
  refineSettingsUpdateParams,
  refineEmptyResult,
);
export const codexTurnSteerMethod = method("turn/steer", refineTurnSteerParams, (value) => {
  exactKeys(value, ["turnId"]);
  assertNativeId(value.turnId);
  assertBounds(value);
  return value;
});
export const codexTurnInterruptMethod = method(
  "turn/interrupt",
  (value: OfficialCodexClientRequestParams<"turn/interrupt">) => {
    refineSimpleParams(value, ["threadId", "turnId"]);
    assertRecordIds(value, ["threadId", "turnId"]);
    return value;
  },
  refineEmptyResult,
);
export const codexThreadSetNameMethod = method(
  "thread/name/set",
  (value: OfficialCodexClientRequestParams<"thread/name/set">) => {
    refineSimpleParams(value, ["threadId", "name"]);
    assertNativeId(value.threadId);
    return value;
  },
  refineEmptyResult,
);
export const codexThreadCompactStartMethod = method(
  "thread/compact/start",
  (value: OfficialCodexClientRequestParams<"thread/compact/start">) => {
    refineSimpleParams(value, ["threadId"]);
    assertNativeId(value.threadId);
    return value;
  },
  refineEmptyResult,
);

function projectModelList(value: OfficialCodexClientRequestResult<"model/list">) {
  // Root/model objects were historical strip boundaries. Nested consumed
  // records remain closed.
  asRecord(value);
  assertBounds(value);
  if (value.data.length > CODEX_C2_MAX_CATALOG_ITEMS) throw new Error("catalog_bound");
  return {
    data: value.data.map((model) => {
      assertNativeId(model.id);
      if (model.upgradeInfo != null) {
        exactKeys(model.upgradeInfo, ["model", "upgradeCopy", "modelLink", "migrationMarkdown", "retirementAt"]);
        if (model.upgradeInfo.retirementAt !== null && (!Number.isSafeInteger(model.upgradeInfo.retirementAt) || model.upgradeInfo.retirementAt < 0)) throw new Error("model_retirement_time_invalid");
      }
      if (model.availabilityNux != null) exactKeys(model.availabilityNux, ["message"]);
      model.supportedReasoningEfforts.forEach((entry) => exactKeys(entry, ["reasoningEffort", "description"]));
      model.serviceTiers.forEach((entry) => {
        exactKeys(entry, ["id", "name", "description"]);
        assertNativeId(entry.id);
      });
      if (model.inputModalities.length > 3) throw new Error("modality_bound");
      if (model.multiAgentVersion != null && model.multiAgentVersion !== "disabled" && model.multiAgentVersion !== "v1" && model.multiAgentVersion !== "v2") throw new Error("multi_agent_version_invalid");
      const upgradeInfo = model.upgradeInfo == null
        ? null
        : {
            model: model.upgradeInfo.model,
            upgradeCopy: model.upgradeInfo.upgradeCopy,
            modelLink: model.upgradeInfo.modelLink,
            migrationMarkdown: model.upgradeInfo.migrationMarkdown,
          };
      return {
        id: model.id,
        model: model.model,
        upgrade: model.upgrade,
        upgradeInfo,
        availabilityNux: model.availabilityNux,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        inputModalities: model.inputModalities,
        supportsPersonality: model.supportsPersonality,
        additionalSpeedTiers: model.additionalSpeedTiers,
        serviceTiers: model.serviceTiers,
        defaultServiceTier: model.defaultServiceTier,
        isDefault: model.isDefault,
      };
    }),
    nextCursor: value.nextCursor,
  };
}

function projectExperimentalFeatureList(
  value: OfficialCodexClientRequestResult<"experimentalFeature/list">,
) {
  asRecord(value);
  assertBounds(value);
  if (value.data.length > CODEX_C2_MAX_CATALOG_ITEMS) throw new Error("catalog_bound");
  return {
    data: value.data.map((feature) => {
      assertNativeId(feature.name);
      return {
        name: feature.name,
        stage: feature.stage,
        displayName: feature.displayName,
        description: feature.description,
        announcement: feature.announcement,
        enabled: feature.enabled,
        defaultEnabled: feature.defaultEnabled,
      };
    }),
    nextCursor: value.nextCursor,
  };
}

function projectSkillsList(value: OfficialCodexClientRequestResult<"skills/list">) {
  exactKeys(value, ["data"]);
  assertBounds(value);
  if (value.data.length > 16) throw new Error("cwd_bound");
  return {
    data: value.data.map((entry) => {
      exactKeys(entry, ["cwd", "skills", "errors"]);
      if (entry.cwd.length > 4096 || entry.cwd.length === 0) throw new Error("path_bound");
      if (entry.skills.length > CODEX_C2_MAX_CATALOG_ITEMS || entry.errors.length > CODEX_C2_MAX_CATALOG_ITEMS) throw new Error("catalog_bound");
      entry.errors.forEach((error) => {
        exactKeys(error, ["path", "message"]);
        if (error.path.length > 4096) throw new Error("path_bound");
      });
      return {
        cwd: entry.cwd,
        skills: entry.skills.map((skill) => {
          exactKeys(skill, ["name", "description", "shortDescription", "interface", "dependencies", "path", "scope", "enabled", "pluginId"]);
          if (skill.name.length === 0 || skill.name.length > 240 || skill.path.length === 0 || skill.path.length > 4096) throw new Error("skill_bound");
          if (skill.pluginId != null) assertNativeId(skill.pluginId);
          if (skill.interface !== undefined) {
            // Interface and skill metadata are intentional projection-strip boundaries.
            asRecord(skill.interface);
          }
          return {
            name: skill.name,
            description: skill.description,
            ...(skill.shortDescription === undefined ? {} : { shortDescription: skill.shortDescription }),
            ...(skill.interface === undefined ? {} : {
              interface: {
                ...(skill.interface.displayName === undefined ? {} : { displayName: skill.interface.displayName }),
              },
            }),
            path: skill.path,
            scope: skill.scope,
            enabled: skill.enabled,
          };
        }),
        errors: entry.errors,
      };
    }),
  };
}

export const codexModelListMethod = method(
  "model/list",
  (value: OfficialCodexClientRequestParams<"model/list">) =>
    refinePaginatedParams(value, ["cursor", "limit", "includeHidden"]),
  projectModelList,
);
export const codexExperimentalFeatureListMethod = method(
  "experimentalFeature/list",
  (value: OfficialCodexClientRequestParams<"experimentalFeature/list">) => {
    refinePaginatedParams(value, ["cursor", "limit", "threadId"]);
    if (value.threadId != null) assertNativeId(value.threadId);
    return value;
  },
  projectExperimentalFeatureList,
);
export const codexSkillsListMethod = method(
  "skills/list",
  (value: OfficialCodexClientRequestParams<"skills/list"> & { readonly cwds: string[] }) => {
    refineSimpleParams(value, ["cwds", "forceReload"]);
    if (value.cwds.length === 0 || value.cwds.length > 16 || value.cwds.some((cwd) => cwd.length === 0 || cwd.length > 4096)) throw new Error("cwd_bound");
    return value;
  },
  projectSkillsList,
);
export const codexPermissionProfileListMethod = method(
  "permissionProfile/list",
  (value: OfficialCodexClientRequestParams<"permissionProfile/list">) =>
    refinePaginatedParams(value, ["cursor", "limit", "cwd"]),
  (value) => {
    exactKeys(value, ["data", "nextCursor"]);
    assertBounds(value);
    if (value.data.length > CODEX_C2_MAX_CATALOG_ITEMS) throw new Error("catalog_bound");
    value.data.forEach((profile) => {
      exactKeys(profile, ["id", "description", "allowed"]);
      assertNativeId(profile.id);
    });
    return value;
  },
);

const serverRequestMethods = Object.freeze([
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "attestation/generate",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const satisfies readonly CodexServerRequestMethod[]);

const serverRequestKeys = Object.freeze({
  "account/chatgptAuthTokens/refresh": ["reason", "previousAccountId"],
  applyPatchApproval: ["conversationId", "callId", "fileChanges", "reason", "grantRoot"],
  "attestation/generate": [],
  execCommandApproval: ["conversationId", "callId", "approvalId", "command", "cwd", "reason", "parsedCmd"],
  "item/commandExecution/requestApproval": ["kind", "threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason", "networkApprovalContext", "command", "cwd", "commandActions", "additionalPermissions", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"],
  "item/fileChange/requestApproval": ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"],
  "item/permissions/requestApproval": ["threadId", "turnId", "itemId", "environmentId", "startedAtMs", "cwd", "reason", "permissions"],
  "item/tool/call": ["threadId", "turnId", "callId", "namespace", "tool", "arguments"],
  "item/tool/requestUserInput": ["threadId", "turnId", "itemId", "questions", "isBlocking", "autoResolutionMs"],
  "mcpServer/elicitation/request": ["threadId", "turnId", "serverName", "mode", "_meta", "message", "requestedSchema", "url", "elicitationId"],
} as const satisfies Record<CodexServerRequestMethod, readonly string[]>);

const serverRequestIdKeys = Object.freeze({
  "account/chatgptAuthTokens/refresh": ["previousAccountId"],
  applyPatchApproval: ["conversationId", "callId"],
  "attestation/generate": [],
  execCommandApproval: ["conversationId", "callId", "approvalId"],
  "item/commandExecution/requestApproval": ["threadId", "turnId", "itemId", "approvalId"],
  "item/fileChange/requestApproval": ["threadId", "turnId", "itemId"],
  "item/permissions/requestApproval": ["threadId", "turnId", "itemId"],
  "item/tool/call": ["threadId", "turnId", "callId"],
  "item/tool/requestUserInput": ["threadId", "turnId", "itemId"],
  "mcpServer/elicitation/request": ["threadId", "turnId", "elicitationId"],
} as const satisfies Record<CodexServerRequestMethod, readonly string[]>);

function refineCommandDecision(value: unknown): void {
  if (typeof value === "string") return;
  const decision = asRecord(value);
  if ("acceptWithExecpolicyAmendment" in decision) {
    exactKeys(decision, ["acceptWithExecpolicyAmendment"]);
    exactKeys(decision.acceptWithExecpolicyAmendment, ["execpolicy_amendment"]);
  } else {
    exactKeys(decision, ["applyNetworkPolicyAmendment"]);
    const policy = exactKeys(decision.applyNetworkPolicyAmendment, ["network_policy_amendment"]);
    exactKeys(policy.network_policy_amendment, ["host", "action"]);
  }
}

function refineElicitationProperty(value: unknown): void {
  const schema = asRecord(value);
  const common = ["type", "title", "description"];
  if (schema.type === "array") {
    exactKeys(schema, [...common, "minItems", "maxItems", "items", "default"]);
    if (schema.minItems !== undefined) assertSafeCount(schema.minItems as number);
    if (schema.maxItems !== undefined) assertSafeCount(schema.maxItems as number);
    const items = asRecord(schema.items);
    if ("anyOf" in items) {
      exactKeys(items, ["anyOf"]);
      (items.anyOf as readonly unknown[]).forEach((entry) => exactKeys(entry, ["const", "title"]));
    } else exactKeys(items, ["type", "enum"]);
  } else if (schema.type === "string" && "oneOf" in schema) {
    exactKeys(schema, [...common, "oneOf", "default"]);
    (schema.oneOf as readonly unknown[]).forEach((entry) => exactKeys(entry, ["const", "title"]));
  } else if (schema.type === "string" && "enum" in schema) {
    exactKeys(schema, [...common, "enum", "enumNames", "default"]);
  } else if (schema.type === "string") {
    exactKeys(schema, [...common, "minLength", "maxLength", "format", "default"]);
    if (schema.minLength !== undefined) assertSafeCount(schema.minLength as number);
    if (schema.maxLength !== undefined) assertSafeCount(schema.maxLength as number);
  } else if (schema.type === "boolean") {
    exactKeys(schema, [...common, "default"]);
  } else {
    exactKeys(schema, [...common, "minimum", "maximum", "default"]);
  }
}

function refinePermissionProfile(value: unknown): void {
  const permissions = exactKeys(value, ["network", "fileSystem"]);
  if (permissions.network != null) exactKeys(permissions.network, ["enabled"]);
  if (permissions.fileSystem == null) return;
  const fileSystem = exactKeys(permissions.fileSystem, [
    "read",
    "write",
    "globScanMaxDepth",
    "entries",
  ]);
  if (fileSystem.globScanMaxDepth !== undefined) {
    assertSafeCount(fileSystem.globScanMaxDepth as number);
  }
  for (const entry of (fileSystem.entries ?? []) as readonly unknown[]) {
    const item = exactKeys(entry, ["path", "access"]);
    const path = variantKeys(item.path, "type", {
      path: ["type", "path"],
      glob_pattern: ["type", "pattern"],
      special: ["type", "value"],
    });
    if (path.type === "special") {
      variantKeys(path.value, "kind", {
        root: ["kind"],
        minimal: ["kind"],
        project_roots: ["kind", "subpath"],
        tmpdir: ["kind"],
        slash_tmp: ["kind"],
        unknown: ["kind", "path", "subpath"],
      });
    }
  }
}

export function refineCodexC2ServerRequest<Method extends CodexServerRequestMethod>(
  method: Method,
  params: unknown,
): OfficialCodexServerRequestParams<Method> {
  const attested = assertCodexAttestedServerRequestParams(method, params);
  const record = method === "mcpServer/elicitation/request"
    ? (() => {
        const elicitation = asRecord(attested);
        if (elicitation.mode === "url") {
          return exactKeys(elicitation, [
            "threadId", "turnId", "serverName", "mode", "_meta", "message", "url", "elicitationId",
          ]);
        }
        return exactKeys(elicitation, [
          "threadId", "turnId", "serverName", "mode", "_meta", "message", "requestedSchema",
        ]);
      })()
    : exactKeys(attested, serverRequestKeys[method]);
  assertBounds(attested);
  assertRecordIds(record, serverRequestIdKeys[method]);
  if (record.startedAtMs !== undefined) assertSafeCount(record.startedAtMs as number);
  if (method === "account/chatgptAuthTokens/refresh") {
    if (record.reason !== "unauthorized") throw new Error("refresh_reason_invalid");
  } else if (method === "applyPatchApproval") {
    for (const change of Object.values(asRecord(record.fileChanges))) {
      variantKeys(change, "type", {
        add: ["type", "content"],
        delete: ["type", "content"],
        update: ["type", "unified_diff", "move_path"],
      });
    }
  } else if (method === "execCommandApproval") {
    for (const action of record.parsedCmd as readonly unknown[]) {
      variantKeys(action, "type", {
        read: ["type", "cmd", "name", "path"],
        list_files: ["type", "cmd", "path"],
        search: ["type", "cmd", "query", "path"],
        unknown: ["type", "cmd"],
      });
    }
  } else if (method === "item/commandExecution/requestApproval") {
    if (record.kind === "writeStdin") {
      if (!record.approvalId) throw new Error("write_stdin_approval_id_required");
      if (
        typeof record.environmentId !== "string" ||
        record.environmentId.length === 0 ||
        typeof record.reason !== "string" ||
        record.reason.length === 0 ||
        typeof record.command !== "string" ||
        record.command.length === 0 ||
        typeof record.cwd !== "string" ||
        record.cwd.length === 0 ||
        !Array.isArray(record.commandActions) ||
        record.commandActions.length === 0 ||
        record.networkApprovalContext != null ||
        record.proposedExecpolicyAmendment != null ||
        record.proposedNetworkPolicyAmendments != null ||
        !Array.isArray(record.availableDecisions) ||
        record.availableDecisions.length !== 2 ||
        record.availableDecisions[0] !== "accept" ||
        record.availableDecisions[1] !== "cancel"
      ) {
        throw new Error("write_stdin_approval_shape_invalid");
      }
    }
    if (record.networkApprovalContext != null) exactKeys(record.networkApprovalContext, ["host", "protocol"]);
    if (record.additionalPermissions != null) refinePermissionProfile(record.additionalPermissions);
    for (const action of (record.commandActions ?? []) as readonly unknown[]) {
      variantKeys(action, "type", {
        read: ["type", "command", "name", "path"],
        listFiles: ["type", "command", "path"],
        search: ["type", "command", "query", "path"],
        unknown: ["type", "command"],
      });
    }
    for (const amendment of (record.proposedNetworkPolicyAmendments ?? []) as readonly unknown[]) exactKeys(amendment, ["host", "action"]);
    if (Array.isArray(record.availableDecisions) && record.availableDecisions.length === 0) {
      throw new Error("approval_decisions_empty");
    }
    for (const decision of (record.availableDecisions ?? []) as readonly unknown[]) refineCommandDecision(decision);
  } else if (method === "item/permissions/requestApproval") {
    refinePermissionProfile(record.permissions);
  } else if (method === "item/tool/requestUserInput") {
    if (record.autoResolutionMs != null) assertSafeCount(record.autoResolutionMs as number);
    for (const question of record.questions as readonly unknown[]) {
      const item = exactKeys(question, ["id", "header", "question", "isOther", "isSecret", "options"]);
      assertNativeId(item.id as string);
      for (const option of (item.options ?? []) as readonly unknown[]) exactKeys(option, ["label", "description"]);
    }
  } else if (method === "mcpServer/elicitation/request") {
    if (record.mode === "openaiForm") {
      throw new Error("codex_mcp_openai_elicitation_unadvertised");
    }
    if (record.mode === "form") {
      const requested = exactKeys(record.requestedSchema, ["$schema", "type", "properties", "required"]);
      for (const property of Object.values(asRecord(requested.properties))) refineElicitationProperty(property);
    }
  }
  return attested;
}

export type CodexC2ServerRequest = {
  readonly [Method in CodexServerRequestMethod]: {
    readonly method: Method;
    readonly params: OfficialCodexServerRequestParams<Method>;
  };
}[CodexServerRequestMethod];

export function decodeCodexC2ServerRequest(
  method: CodexServerRequestMethod,
  params: unknown,
): CodexC2ServerRequest {
  if (!(serverRequestMethods as readonly string[]).includes(method)) {
    throw new Error("unadopted_server_request");
  }
  const decoded = decodeCodexServerRequestParams(method, params);
  return {
    method,
    params: refineCodexC2ServerRequest(method, decoded),
  } as CodexC2ServerRequest;
}

export const codexC2RoutedServerRequestMethods = Object.freeze([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const);
export type CodexC2RoutedServerRequestMethod =
  (typeof codexC2RoutedServerRequestMethods)[number];

function refineLegacyApprovalResponse(result: unknown): unknown {
  const response = exactKeys(result, ["decision"]);
  if (typeof response.decision !== "string") {
    const denied = exactKeys(response.decision, ["denied"]);
    exactKeys(denied.denied, ["rejection"]);
  }
  assertBounds(result);
  return result;
}

export function encodeCodexC2RoutedServerResponse(
  method: CodexC2RoutedServerRequestMethod,
  result: unknown,
): unknown {
  let refined = result;
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    refined = refineLegacyApprovalResponse(result);
  } else if (method === "item/commandExecution/requestApproval") {
    const response = exactKeys(result, ["decision"]);
    refineCommandDecision(response.decision);
    refined = result;
  } else if (method === "item/fileChange/requestApproval") {
    exactKeys(result, ["decision"]);
  } else if (method === "item/permissions/requestApproval") {
    const response = exactKeys(result, ["permissions", "scope", "strictAutoReview"]);
    if (response.scope !== "turn" && response.scope !== "session") {
      throw new Error("permissions_scope_invalid");
    }
    refinePermissionProfile(response.permissions);
  } else if (method === "item/tool/requestUserInput") {
    const response = exactKeys(result, ["answers"]);
    const answers = asRecord(response.answers);
    refined = {
      // Preserve provider question IDs such as "__proto__" as data properties.
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
        const parsed = exactKeys(answer, ["answers"]);
        assertBounds(parsed);
        return [id, { answers: parsed.answers }];
      })),
    };
  } else {
    const response = exactKeys(result, ["action", "content", "_meta"]);
    codexJsonValueSchema.parse(response.content);
    codexJsonValueSchema.parse(response._meta);
  }
  assertBounds(refined);
  return refined;
}

interface NotificationCodec<Method extends CodexAdoptedServerNotificationMethod> {
  parse(value: unknown): OfficialCodexServerNotificationParams<Method>;
}

function notificationCodec<Method extends CodexAdoptedServerNotificationMethod>(
  method: Method,
  refine: (
    value: OfficialCodexServerNotificationParams<Method>,
  ) => OfficialCodexServerNotificationParams<Method>,
): NotificationCodec<Method> {
  return Object.freeze({
    parse(value: unknown) {
      return refine(assertCodexAttestedServerNotificationParams(method, value));
    },
  });
}

const notificationKeys = Object.freeze({
  warning: ["threadId", "message"],
  error: ["error", "willRetry", "threadId", "turnId"],
  "modelProvider/authRecoveryStarted": ["threadId", "turnId", "provider", "message"],
  "modelProvider/authRecoveryCompleted": ["threadId", "turnId", "provider", "message"],
  "thread/status/changed": ["threadId", "status"],
  "thread/name/updated": ["threadId", "threadName"],
  "thread/settings/updated": ["threadId", "threadSettings"],
  "thread/tokenUsage/updated": ["threadId", "turnId", "tokenUsage"],
  "thread/compacted": ["threadId", "turnId"],
  "turn/started": ["threadId", "turn"],
  "turn/completed": ["threadId", "turn"],
  "turn/diff/updated": ["threadId", "turnId", "diff"],
  "turn/plan/updated": ["threadId", "turnId", "explanation", "plan"],
  "item/started": ["item", "threadId", "turnId", "startedAtMs"],
  "item/completed": ["item", "threadId", "turnId", "completedAtMs"],
  "item/agentMessage/delta": ["threadId", "turnId", "itemId", "delta"],
  "item/plan/delta": ["threadId", "turnId", "itemId", "delta"],
  "item/commandExecution/outputDelta": ["threadId", "turnId", "itemId", "delta"],
  "item/fileChange/outputDelta": ["threadId", "turnId", "itemId", "delta"],
  "item/fileChange/patchUpdated": ["threadId", "turnId", "itemId", "changes"],
  "item/mcpToolCall/progress": ["threadId", "turnId", "itemId", "message"],
  "item/reasoning/summaryPartAdded": ["threadId", "turnId", "itemId", "summaryIndex"],
  "item/reasoning/summaryTextDelta": ["threadId", "turnId", "itemId", "delta", "summaryIndex"],
  "item/reasoning/textDelta": ["threadId", "turnId", "itemId", "delta", "contentIndex"],
  "serverRequest/resolved": ["threadId", "requestId"],
} as const);

function refineNotification<Method extends keyof typeof notificationKeys>(
  method: Method,
  value: OfficialCodexServerNotificationParams<Method>,
): OfficialCodexServerNotificationParams<Method> {
  const notification = exactKeys(value, notificationKeys[method]);
  assertBounds(
    value,
    method === "item/started" ||
      method === "item/completed" ||
      method === "turn/started" ||
      method === "turn/completed",
  );
  assertRecordIds(notification, ["threadId", "turnId", "itemId"]);
  if (notification.startedAtMs !== undefined) {
    assertSafeCount(notification.startedAtMs as number);
  }
  if (notification.completedAtMs !== undefined) {
    assertSafeCount(notification.completedAtMs as number);
  }
  if (notification.summaryIndex !== undefined) {
    assertSafeCount(notification.summaryIndex as number);
  }
  if (notification.contentIndex !== undefined) {
    assertSafeCount(notification.contentIndex as number);
  }
  if (method === "error") {
    refineTurnError(notification.error);
  } else if (
    method === "modelProvider/authRecoveryStarted" ||
    method === "modelProvider/authRecoveryCompleted"
  ) {
    assertNativeId(notification.provider as string);
    const message = notification.message as string;
    if (
      message.length === 0 ||
      message.length > CODEX_C2_MAX_AUTH_RECOVERY_MESSAGE_CHARACTERS
    ) {
      throw new Error("auth_recovery_message_bound");
    }
  } else if (method === "thread/status/changed") {
    refineCodexThreadStatus(notification.status as never);
  } else if (method === "thread/settings/updated") {
    const settings = exactKeys(notification.threadSettings, ["cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "activePermissionProfile", "model", "modelProvider", "serviceTier", "effort", "summary", "collaborationMode", "multiAgentMode", "personality"]);
    refineApprovalPolicy(settings.approvalPolicy);
    refineSandboxPolicy(settings.sandboxPolicy);
    if (settings.activePermissionProfile != null) {
      const profile = exactKeys(settings.activePermissionProfile, ["id", "extends"]);
      assertNativeId(profile.id as string);
    }
    const collaboration = exactKeys(settings.collaborationMode, ["mode", "settings"]);
    exactKeys(collaboration.settings, ["model", "reasoning_effort", "developer_instructions"]);
    if (typeof settings.multiAgentMode === "object") exactKeys(settings.multiAgentMode, ["custom"]);
  } else if (method === "thread/tokenUsage/updated") {
    refineCodexThreadTokenUsage(notification.tokenUsage as never);
  } else if (method === "turn/started" || method === "turn/completed") {
    refineCodexTurn(notification.turn as never);
  } else if (method === "turn/plan/updated") {
    for (const entry of notification.plan as readonly unknown[]) exactKeys(entry, ["step", "status"]);
  } else if (method === "item/started" || method === "item/completed") {
    refineCodexThreadItem(notification.item as never);
  } else if (method === "item/fileChange/patchUpdated") {
    for (const change of notification.changes as readonly unknown[]) {
      const parsed = exactKeys(change, ["path", "kind", "diff"]);
      variantKeys(parsed.kind, "type", {
        add: ["type"], delete: ["type"], update: ["type", "move_path"],
      });
    }
  } else if (method === "serverRequest/resolved") {
    if (typeof notification.requestId === "string") {
      assertNativeId(notification.requestId);
    } else {
      assertSafeInteger(notification.requestId as number);
    }
  }
  return value;
}

export const codexC2NotificationSchemas = Object.freeze({
  warning: notificationCodec("warning", (value) => refineNotification("warning", value)),
  error: notificationCodec("error", (value) => refineNotification("error", value)),
  "modelProvider/authRecoveryStarted": notificationCodec("modelProvider/authRecoveryStarted", (value) => refineNotification("modelProvider/authRecoveryStarted", value)),
  "modelProvider/authRecoveryCompleted": notificationCodec("modelProvider/authRecoveryCompleted", (value) => refineNotification("modelProvider/authRecoveryCompleted", value)),
  "thread/status/changed": notificationCodec("thread/status/changed", (value) => refineNotification("thread/status/changed", value)),
  "thread/name/updated": notificationCodec("thread/name/updated", (value) => refineNotification("thread/name/updated", value)),
  "thread/goal/updated": notificationCodec("thread/goal/updated", refineCodexThreadGoalUpdatedNotification),
  "thread/goal/cleared": notificationCodec("thread/goal/cleared", refineCodexThreadGoalClearedNotification),
  "thread/settings/updated": notificationCodec("thread/settings/updated", (value) => refineNotification("thread/settings/updated", value)),
  "thread/tokenUsage/updated": notificationCodec("thread/tokenUsage/updated", (value) => refineNotification("thread/tokenUsage/updated", value)),
  "thread/compacted": notificationCodec("thread/compacted", (value) => refineNotification("thread/compacted", value)),
  "turn/started": notificationCodec("turn/started", (value) => refineNotification("turn/started", value)),
  "turn/completed": notificationCodec("turn/completed", (value) => refineNotification("turn/completed", value)),
  "turn/diff/updated": notificationCodec("turn/diff/updated", (value) => refineNotification("turn/diff/updated", value)),
  "turn/plan/updated": notificationCodec("turn/plan/updated", (value) => refineNotification("turn/plan/updated", value)),
  "item/started": notificationCodec("item/started", (value) => refineNotification("item/started", value)),
  "item/completed": notificationCodec("item/completed", (value) => refineNotification("item/completed", value)),
  "item/agentMessage/delta": notificationCodec("item/agentMessage/delta", (value) => refineNotification("item/agentMessage/delta", value)),
  "item/plan/delta": notificationCodec("item/plan/delta", (value) => refineNotification("item/plan/delta", value)),
  "item/commandExecution/outputDelta": notificationCodec("item/commandExecution/outputDelta", (value) => refineNotification("item/commandExecution/outputDelta", value)),
  "item/fileChange/outputDelta": notificationCodec("item/fileChange/outputDelta", (value) => refineNotification("item/fileChange/outputDelta", value)),
  "item/fileChange/patchUpdated": notificationCodec("item/fileChange/patchUpdated", (value) => refineNotification("item/fileChange/patchUpdated", value)),
  "item/mcpToolCall/progress": notificationCodec("item/mcpToolCall/progress", (value) => refineNotification("item/mcpToolCall/progress", value)),
  "item/reasoning/summaryPartAdded": notificationCodec("item/reasoning/summaryPartAdded", (value) => refineNotification("item/reasoning/summaryPartAdded", value)),
  "item/reasoning/summaryTextDelta": notificationCodec("item/reasoning/summaryTextDelta", (value) => refineNotification("item/reasoning/summaryTextDelta", value)),
  "item/reasoning/textDelta": notificationCodec("item/reasoning/textDelta", (value) => refineNotification("item/reasoning/textDelta", value)),
  "serverRequest/resolved": notificationCodec("serverRequest/resolved", (value) => refineNotification("serverRequest/resolved", value)),
});

export type CodexC2NotificationMethod = keyof typeof codexC2NotificationSchemas;

export function isCodexC2NotificationMethod(
  method: CodexServerNotificationMethod,
): method is CodexC2NotificationMethod {
  return Object.hasOwn(codexC2NotificationSchemas, method);
}

export function decodeCodexC2Notification<Method extends CodexC2NotificationMethod>(
  method: Method,
  params: unknown,
): OfficialCodexServerNotificationParams<Method> {
  const decoded = decodeCodexServerNotificationParams(method, params);
  return codexC2NotificationSchemas[method].parse(decoded) as OfficialCodexServerNotificationParams<Method>;
}

export function refineCodexSkillsChangedNotification(
  params: unknown,
): OfficialCodexServerNotificationParams<"skills/changed"> {
  const attested = assertCodexAttestedServerNotificationParams("skills/changed", params);
  exactKeys(attested, []);
  return attested;
}

export function refineCodexThreadStartedNotification(
  params: unknown,
): OfficialCodexServerNotificationParams<"thread/started"> {
  const attested = assertCodexAttestedServerNotificationParams("thread/started", params);
  exactKeys(attested, ["thread"]);
  assertBounds(attested, true);
  return { thread: projectCodexThread(attested.thread) };
}

export type CodexTurnStartParams = OfficialCodexClientRequestParams<"turn/start">;
export type CodexTurnStartResponse = ReturnType<typeof codexTurnStartMethod.decodeResult>;
export type CodexTurnSteerParams = OfficialCodexClientRequestParams<"turn/steer">;
export type CodexTurnSteerResponse = OfficialCodexClientRequestResult<"turn/steer">;
export type CodexTurnInterruptParams = OfficialCodexClientRequestParams<"turn/interrupt">;
export type CodexThreadSetNameParams = OfficialCodexClientRequestParams<"thread/name/set">;
export type CodexThreadCompactStartParams = OfficialCodexClientRequestParams<"thread/compact/start">;
export type CodexModelListResponse = ReturnType<typeof codexModelListMethod.decodeResult>;
export type CodexExperimentalFeatureListResponse = ReturnType<typeof codexExperimentalFeatureListMethod.decodeResult>;
export type CodexPermissionProfileListResponse = OfficialCodexClientRequestResult<"permissionProfile/list">;
