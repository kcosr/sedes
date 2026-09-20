import path from "node:path";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import { BackendError } from "../contracts.js";
import { GROK_ACP_REVIEWED_PROFILE } from "./grok-release-guard.js";
import {
  decodeGrokSubagentEvent,
  type GrokSubagentEvent,
} from "./grok-subagent-reducer.js";

export const GROK_ACP_DIALECT_PROFILE = GROK_ACP_REVIEWED_PROFILE;
export const GROK_CACHED_TOKEN_AUTH_METHOD_ID = "cached_token" as const;

export class GrokAuthenticationRequiredError extends BackendError {
  constructor() {
    super({
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
      backendCode: "grok_authentication_required",
      safeMessage:
        "Grok authentication is required. Log in with the native Grok installation and retry.",
    });
    this.name = "GrokAuthenticationRequiredError";
  }
}

const MAXIMUM_IDENTIFIER_BYTES = 1_024;
const MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1_024;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAXIMUM_TITLE_BYTES = 464;
const MAXIMUM_TITLE_SCALARS = 100;
const MAXIMUM_MODELS = 512;
const MAXIMUM_REASONING_EFFORTS = 32;

export interface GrokModelDescriptor {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string;
  /**
   * Source-backed model image-input evidence. Undefined means the reviewed
   * stable-1.x profile supplies the default; an explicit false must win.
   */
  readonly imageInput?: boolean;
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort?: string;
}

export interface GrokModelCatalog {
  readonly currentModelId: string;
  readonly availableModels: readonly GrokModelDescriptor[];
}

export interface GrokEffectiveSessionConfiguration {
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export interface GrokPromptCompleteNotification {
  readonly sessionId: string;
  readonly promptId?: string;
  readonly stopReason: string;
  readonly agentResult?: string | null;
  readonly turnId?: number;
  readonly cancelTrigger?: string;
  readonly cancellationCategory?: string;
}

/**
 * Logical turn-completed payload observed in the pinned Grok source. It is
 * admitted only through the exact direct live/replay routes below.
 */
export interface GrokSourceCandidateTurnCompletedNotification {
  readonly sessionId: string;
  readonly update: {
    readonly sessionUpdate: "turn_completed";
    readonly prompt_id: string;
    readonly stop_reason: string;
    readonly agent_result?: string | null;
  };
  readonly _meta: GrokEventMetadata;
}

export type GrokMultiplexedSessionNotification =
  | {
      readonly kind: "turn_completed";
      readonly sessionId: string;
      readonly notification: GrokSourceCandidateTurnCompletedNotification;
    }
  | {
      readonly kind: "subagent";
      readonly sessionId: string;
      readonly event: GrokSubagentEvent;
    }
  | {
      readonly kind: "passive_ignored";
      readonly sessionId: string;
    };

export interface GrokEventMetadata {
  readonly eventId: string;
  readonly promptId?: string;
  readonly isReplay?: true;
  readonly agentTimestampMs?: number;
  readonly chunkId?: number;
}

export interface GrokSessionRenameRequest {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly kind: "build";
  readonly resetToAuto: false;
}

export interface GrokSessionRenameResponse {
  readonly success: true;
}

export interface GrokSessionUpdatesRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly turnIndex?: number;
  readonly stream: true;
  readonly chunkSize: 1;
}

export interface GrokStoredSessionUpdate {
  readonly timestamp: number;
  readonly method: "session/update" | "_x.ai/session/update";
  readonly params: Readonly<Record<string, unknown>>;
}

export interface GrokSessionUpdatesChunk {
  readonly sessionId: string;
  readonly index: number;
  readonly updates: readonly [] | readonly [GrokStoredSessionUpdate];
  readonly done: boolean;
}

export interface GrokSessionUpdatesResponse {
  readonly totalCount: number;
  readonly chunkCount: number;
  readonly lastEventId?: string;
  readonly promptStarts: readonly number[];
}

export const GROK_XAI_NOTIFICATIONS = Object.freeze({
  promptComplete:
    defineAcpExtensionNotification<GrokPromptCompleteNotification>({
      method: "_x.ai/session/prompt_complete",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: GROK_ACP_DIALECT_PROFILE,
      decodeParams: decodePromptComplete,
      validateParams: () => true,
      notificationOrderingKey: (params) => params.sessionId,
    }),
  liveSessionNotification:
    defineAcpExtensionNotification<GrokMultiplexedSessionNotification>({
      method: "_x.ai/session_notification",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: GROK_ACP_DIALECT_PROFILE,
      decodeParams: (value) =>
        decodeMultiplexedSessionNotification(value, false),
      validateParams: () => true,
      notificationOrderingKey: (params) => params.sessionId,
    }),
  replaySessionUpdate:
    defineAcpExtensionNotification<GrokMultiplexedSessionNotification>({
      method: "_x.ai/session/update",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: GROK_ACP_DIALECT_PROFILE,
      decodeParams: (value) =>
        decodeMultiplexedSessionNotification(value, true),
      validateParams: () => true,
      notificationOrderingKey: (params) => params.sessionId,
    }),
  sessionUpdatesChunk: defineAcpExtensionNotification<GrokSessionUpdatesChunk>({
    method: "_x.ai/session/updates/chunk",
    direction: "agent_to_client",
    operation: "read",
    requiredProfile: GROK_ACP_DIALECT_PROFILE,
    decodeParams: decodeSessionUpdatesChunk,
    validateParams: () => true,
    notificationOrderingKey: (params) => params.sessionId,
  }),
});

export const GROK_XAI_REQUESTS = Object.freeze({
  renameSession: defineAcpExtensionRequest<
    GrokSessionRenameRequest,
    GrokSessionRenameResponse
  >({
    method: "_x.ai/session/rename",
    direction: "client_to_agent",
    operation: "mutation",
    requiredProfile: GROK_ACP_DIALECT_PROFILE,
    decodeRequest: decodeRenameRequest,
    validateRequest: () => true,
    decodeResponse: decodeRenameResponse,
    validateResponse: () => true,
  }),
  sessionUpdates: defineAcpExtensionRequest<
    GrokSessionUpdatesRequest,
    GrokSessionUpdatesResponse
  >({
    method: "_x.ai/session/updates",
    direction: "client_to_agent",
    operation: "read",
    requiredProfile: GROK_ACP_DIALECT_PROFILE,
    decodeRequest: decodeSessionUpdatesRequest,
    validateRequest: () => true,
    decodeResponse: decodeSessionUpdatesResponse,
    validateResponse: () => true,
  }),
});

/**
 * Pins the structurally reviewed Grok 1.0.4 / ACP 0.10.4 initialize profile.
 * This is parser admission only; production runtime admission remains closed.
 */
export function admitGrokAcpInitializeProfile(
  response: InitializeResponse,
): InitializeResponse {
  const capabilities = response.agentCapabilities;
  const session = capabilities?.sessionCapabilities;
  const prompt = capabilities?.promptCapabilities;
  const authMethods = response.authMethods ?? [];
  const matchingAuthMethods = authMethods.filter(
    (method) => method.id === GROK_CACHED_TOKEN_AUTH_METHOD_ID,
  );
  if (
    response.protocolVersion !== 1 ||
    capabilities?.loadSession !== true ||
    session?.list == null ||
    session.resume == null ||
    session.close == null ||
    prompt?.embeddedContext !== true
  ) {
    throw new Error("grok_acp_initialize_profile_incompatible");
  }
  if (
    matchingAuthMethods.length !== 1 ||
    ("type" in matchingAuthMethods[0]! &&
      matchingAuthMethods[0]!.type !== undefined)
  ) {
    throw new Error("grok_acp_initialize_profile_incompatible");
  }
  return response;
}

export function decodeGrokInitializeModelCatalog(
  response: InitializeResponse,
): GrokModelCatalog {
  const metadata = response._meta;
  const modelState = isRecord(metadata) ? metadata.modelState : undefined;
  if (!isRecord(modelState) || !Array.isArray(modelState.availableModels)) {
    throw new Error("grok_model_catalog_invalid");
  }
  const currentModelId = boundedString(
    modelState.currentModelId,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  if (
    !currentModelId ||
    modelState.availableModels.length === 0 ||
    modelState.availableModels.length > MAXIMUM_MODELS
  ) {
    throw new Error("grok_model_catalog_invalid");
  }
  const modelIds = new Set<string>();
  const availableModels = modelState.availableModels.map((value) => {
    if (!isRecord(value)) throw new Error("grok_model_catalog_invalid");
    const modelId = boundedString(value.modelId, MAXIMUM_IDENTIFIER_BYTES);
    const name = boundedString(value.name, MAXIMUM_IDENTIFIER_BYTES);
    const description = optionalString(
      value.description,
      MAXIMUM_DIAGNOSTIC_BYTES,
    );
    if (!modelId || !name || description === INVALID || modelIds.has(modelId)) {
      throw new Error("grok_model_catalog_invalid");
    }
    modelIds.add(modelId);
    const modelMetadata = value._meta;
    const decodedEfforts = decodeModelReasoningEfforts(modelMetadata);
    const imageInput = decodeGrokModelImageInput(modelMetadata);
    return Object.freeze({
      modelId,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(imageInput !== undefined ? { imageInput } : {}),
      supportedReasoningEfforts: decodedEfforts.values,
      ...(decodedEfforts.defaultValue !== undefined
        ? { defaultReasoningEffort: decodedEfforts.defaultValue }
        : {}),
    });
  });
  if (!modelIds.has(currentModelId)) {
    throw new Error("grok_model_catalog_invalid");
  }
  return Object.freeze({
    currentModelId,
    availableModels: Object.freeze(availableModels),
  });
}

/**
 * Mirrors Grok Build's reviewed ModelState precedence: acceptsImages wins when
 * it is a boolean; otherwise an inputModalities array is authoritative. The
 * absent case remains undefined so only the reviewed Grok profile may supply
 * the source-backed default.
 */
export function decodeGrokModelImageInput(
  metadata: unknown,
): boolean | undefined {
  if (!isRecord(metadata)) return undefined;
  if (typeof metadata.acceptsImages === "boolean") {
    return metadata.acceptsImages;
  }
  if (!Array.isArray(metadata.inputModalities)) return undefined;
  return metadata.inputModalities.some(
    (value) => typeof value === "string" && value.toLowerCase() === "image",
  );
}

export function decodeGrokEffectiveSessionConfiguration(response: {
  readonly _meta?: unknown;
}): GrokEffectiveSessionConfiguration {
  const metadata = response._meta;
  const sessionConfig = isRecord(metadata)
    ? metadata["x.ai/sessionConfig"]
    : undefined;
  const options = isRecord(sessionConfig) ? sessionConfig.options : undefined;
  if (!Array.isArray(options) || options.length === 0 || options.length > 544) {
    throw new Error("grok_session_configuration_invalid");
  }
  const seen = new Set<string>();
  let selectedModel: string | undefined;
  let selectedEffort: string | undefined;
  for (const value of options) {
    if (!isRecord(value)) throw new Error("grok_session_configuration_invalid");
    const id = boundedString(value.id, MAXIMUM_IDENTIFIER_BYTES);
    if (
      !id ||
      (value.category !== "model" && value.category !== "mode") ||
      typeof value.selected !== "boolean"
    ) {
      throw new Error("grok_session_configuration_invalid");
    }
    const key = `${value.category}\0${id}`;
    if (seen.has(key)) throw new Error("grok_session_configuration_invalid");
    seen.add(key);
    if (!value.selected) continue;
    if (value.category === "model") {
      if (selectedModel) throw new Error("grok_session_configuration_invalid");
      selectedModel = id;
    } else {
      if (selectedEffort) throw new Error("grok_session_configuration_invalid");
      selectedEffort = id;
    }
  }
  if (!selectedModel) throw new Error("grok_session_configuration_invalid");
  return Object.freeze({
    modelId: selectedModel,
    ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
  });
}

function decodeModelReasoningEfforts(value: unknown): {
  readonly values: readonly string[];
  readonly defaultValue?: string;
} {
  if (!isRecord(value)) return { values: Object.freeze([]) };
  const supports = value.supportsReasoningEffort;
  const efforts = value.reasoningEfforts;
  if (supports === undefined && efforts === undefined) {
    return { values: Object.freeze([]) };
  }
  if (supports !== true || !Array.isArray(efforts)) {
    throw new Error("grok_model_catalog_invalid");
  }
  if (efforts.length === 0 || efforts.length > MAXIMUM_REASONING_EFFORTS) {
    throw new Error("grok_model_catalog_invalid");
  }
  const configuredDefault = boundedString(
    value.reasoningEffort,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  if (value.reasoningEffort !== undefined && !configuredDefault) {
    throw new Error("grok_model_catalog_invalid");
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const effort of efforts) {
    if (!isRecord(effort)) throw new Error("grok_model_catalog_invalid");
    const value = boundedString(effort.value, MAXIMUM_IDENTIFIER_BYTES);
    if (!value || seen.has(value) || typeof effort.default !== "boolean") {
      throw new Error("grok_model_catalog_invalid");
    }
    seen.add(value);
    values.push(value);
  }
  if (configuredDefault && !seen.has(configuredDefault)) {
    throw new Error("grok_model_catalog_invalid");
  }
  return {
    values: Object.freeze(values),
    ...(configuredDefault ? { defaultValue: configuredDefault } : {}),
  };
}

function decodePromptComplete(
  value: unknown,
): GrokPromptCompleteNotification | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const promptId = optionalString(value.promptId, MAXIMUM_IDENTIFIER_BYTES);
  const stopReason = boundedString(value.stopReason, MAXIMUM_IDENTIFIER_BYTES);
  if (!sessionId || promptId === INVALID || !stopReason) return undefined;
  const agentResult = optionalNullableString(
    value.agentResult,
    MAXIMUM_DIAGNOSTIC_BYTES,
  );
  const cancelTrigger = optionalString(
    value.cancelTrigger,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  const cancellationCategory = optionalString(
    value.cancellationCategory,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  if (
    agentResult === INVALID ||
    cancelTrigger === INVALID ||
    cancellationCategory === INVALID ||
    (value.turnId !== undefined &&
      (!Number.isSafeInteger(value.turnId) || (value.turnId as number) < 0))
  ) {
    return undefined;
  }
  return {
    sessionId,
    ...(promptId !== undefined ? { promptId } : {}),
    stopReason,
    ...(agentResult !== undefined ? { agentResult } : {}),
    ...(value.turnId !== undefined ? { turnId: value.turnId as number } : {}),
    ...(cancelTrigger !== undefined ? { cancelTrigger } : {}),
    ...(cancellationCategory !== undefined ? { cancellationCategory } : {}),
  };
}

function decodeMultiplexedSessionNotification(
  value: unknown,
  replay: boolean,
): GrokMultiplexedSessionNotification | undefined {
  if (!isRecord(value) || !isRecord(value.update)) return undefined;
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const updateKind = boundedString(
    value.update.sessionUpdate,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  if (!sessionId || !updateKind) return undefined;
  if (
    updateKind === "subagent_spawned" ||
    updateKind === "subagent_progress" ||
    updateKind === "subagent_finished"
  ) {
    const event = decodeGrokSubagentEvent(value, { replay });
    return event ? { kind: "subagent", sessionId, event } : undefined;
  }
  if (updateKind !== "turn_completed") {
    return { kind: "passive_ignored", sessionId };
  }
  const notification = decodeGrokSourceCandidateTurnCompleted(value);
  if (!notification || (notification._meta.isReplay === true) !== replay) {
    return undefined;
  }
  return { kind: "turn_completed", sessionId, notification };
}

export function decodeGrokSourceCandidateTurnCompleted(
  value: unknown,
): GrokSourceCandidateTurnCompletedNotification | undefined {
  if (!isRecord(value) || !isRecord(value.update)) return undefined;
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const promptId = boundedString(
    value.update.prompt_id,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  const stopReason = boundedString(
    value.update.stop_reason,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  const agentResult = optionalNullableString(
    value.update.agent_result,
    MAXIMUM_DIAGNOSTIC_BYTES,
  );
  const metadata = decodeEventMetadata(value._meta);
  if (
    !sessionId ||
    value.update.sessionUpdate !== "turn_completed" ||
    !promptId ||
    !stopReason ||
    agentResult === INVALID ||
    !metadata
  ) {
    return undefined;
  }
  return {
    sessionId,
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: stopReason,
      ...(agentResult !== undefined ? { agent_result: agentResult } : {}),
    },
    _meta: metadata,
  };
}

function decodeEventMetadata(value: unknown): GrokEventMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const eventId = boundedString(value.eventId, MAXIMUM_IDENTIFIER_BYTES);
  const promptId = optionalString(value.promptId, MAXIMUM_IDENTIFIER_BYTES);
  if (
    !eventId ||
    promptId === INVALID ||
    (value.isReplay !== undefined && value.isReplay !== true) ||
    (value.agentTimestampMs !== undefined &&
      (!Number.isSafeInteger(value.agentTimestampMs) ||
        (value.agentTimestampMs as number) < 0 ||
        (value.agentTimestampMs as number) > MAXIMUM_DATE_MILLISECONDS)) ||
    (value.chunkId !== undefined &&
      (!Number.isSafeInteger(value.chunkId) || (value.chunkId as number) < 0))
  ) {
    return undefined;
  }
  return {
    eventId,
    ...(promptId !== undefined ? { promptId } : {}),
    ...(value.isReplay === true ? { isReplay: true as const } : {}),
    ...(value.agentTimestampMs !== undefined
      ? { agentTimestampMs: value.agentTimestampMs as number }
      : {}),
    ...(value.chunkId !== undefined
      ? { chunkId: value.chunkId as number }
      : {}),
  };
}

function decodeRenameRequest(
  value: unknown,
): GrokSessionRenameRequest | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const title = decodeRenameTitle(value.title);
  const cwd = boundedString(value.cwd, 32 * 1_024);
  if (
    !sessionId ||
    !title ||
    !cwd ||
    !path.isAbsolute(cwd) ||
    value.kind !== "build" ||
    value.resetToAuto !== false
  ) {
    return undefined;
  }
  return { sessionId, title, cwd, kind: "build", resetToAuto: false };
}

function decodeRenameTitle(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    hasUnpairedSurrogate(value) ||
    Buffer.byteLength(value) > MAXIMUM_TITLE_BYTES
  ) {
    return undefined;
  }
  const sanitized = [...value]
    .filter((character) => !isForbiddenTitleCharacter(character))
    .join("")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  return sanitized.length > 0 && [...sanitized].length <= MAXIMUM_TITLE_SCALARS
    ? sanitized
    : undefined;
}

/** Deterministic projection from one normalized Sedes title to Grok's wire bound. */
export function projectGrokNativeSessionTitle(title: string): string {
  const sanitized = [...title]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return isForbiddenTitleCharacter(character) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? " "
        : character;
    })
    .join("")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  const nonempty = sanitized.length > 0 ? sanitized : "New thread";
  return [...nonempty].slice(0, MAXIMUM_TITLE_SCALARS).join("");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isForbiddenTitleCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0x00 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function decodeRenameResponse(
  value: unknown,
): GrokSessionRenameResponse | undefined {
  return isRecord(value) && value.success === true
    ? { success: true }
    : undefined;
}

function decodeSessionUpdatesRequest(
  value: unknown,
): GrokSessionUpdatesRequest | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "sessionId",
      "cwd",
      "offset",
      "limit",
      "turnIndex",
      "stream",
      "chunkSize",
    ])
  ) {
    return undefined;
  }
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const cwd = boundedString(value.cwd, 32 * 1_024);
  const offset = optionalSafeInteger(value.offset);
  const limit = optionalNonnegativeSafeInteger(value.limit);
  const turnIndex = optionalNonnegativeSafeInteger(value.turnIndex);
  if (
    !sessionId ||
    !cwd ||
    offset === INVALID ||
    limit === INVALID ||
    turnIndex === INVALID ||
    value.stream !== true ||
    value.chunkSize !== 1
  ) {
    return undefined;
  }
  return {
    sessionId,
    cwd,
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    stream: true,
    chunkSize: 1,
  };
}

function decodeSessionUpdatesChunk(
  value: unknown,
): GrokSessionUpdatesChunk | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sessionId", "index", "updates", "done"])
  ) {
    return undefined;
  }
  const sessionId = boundedString(value.sessionId, MAXIMUM_IDENTIFIER_BYTES);
  const index = nonnegativeSafeInteger(value.index);
  if (
    !sessionId ||
    index === undefined ||
    !Array.isArray(value.updates) ||
    value.updates.length > 1 ||
    typeof value.done !== "boolean"
  ) {
    return undefined;
  }
  const update =
    value.updates.length === 1
      ? decodeStoredSessionUpdate(value.updates[0])
      : undefined;
  if (value.updates.length === 1 && !update) return undefined;
  return {
    sessionId,
    index,
    updates: update ? [update] : [],
    done: value.done,
  };
}

function decodeStoredSessionUpdate(
  value: unknown,
): GrokStoredSessionUpdate | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["timestamp", "method", "params"])
  ) {
    return undefined;
  }
  const timestamp =
    value.timestamp === undefined ? 0 : nonnegativeSafeInteger(value.timestamp);
  if (
    timestamp === undefined ||
    (value.method !== "session/update" &&
      value.method !== "_x.ai/session/update") ||
    !isRecord(value.params)
  ) {
    return undefined;
  }
  return {
    timestamp,
    method: value.method,
    params: value.params,
  };
}

function decodeSessionUpdatesResponse(
  value: unknown,
): GrokSessionUpdatesResponse | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "totalCount",
      "chunkCount",
      "lastEventId",
      "promptStarts",
    ])
  ) {
    return undefined;
  }
  const totalCount = nonnegativeSafeInteger(value.totalCount);
  const chunkCount = nonnegativeSafeInteger(value.chunkCount);
  const lastEventId = optionalString(
    value.lastEventId,
    MAXIMUM_IDENTIFIER_BYTES,
  );
  if (
    totalCount === undefined ||
    chunkCount === undefined ||
    chunkCount > totalCount ||
    lastEventId === INVALID ||
    !Array.isArray(value.promptStarts)
  ) {
    return undefined;
  }
  const promptStarts: number[] = [];
  for (const candidate of value.promptStarts) {
    const start = nonnegativeSafeInteger(candidate);
    if (
      start === undefined ||
      start >= totalCount ||
      (promptStarts.length > 0 && start <= promptStarts.at(-1)!)
    ) {
      return undefined;
    }
    promptStarts.push(start);
  }
  return {
    totalCount,
    chunkCount,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    promptStarts,
  };
}

const INVALID = Symbol("invalid_optional_value");

function optionalSafeInteger(
  value: unknown,
): number | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) ? (value as number) : INVALID;
}

function optionalNonnegativeSafeInteger(
  value: unknown,
): number | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : INVALID;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function optionalString(
  value: unknown,
  maximumBytes: number,
): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return boundedString(value, maximumBytes) ?? INVALID;
}

function optionalNullableString(
  value: unknown,
  maximumBytes: number,
): string | null | undefined | typeof INVALID {
  if (value === undefined || value === null) return value;
  return boundedString(value, maximumBytes) ?? INVALID;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
