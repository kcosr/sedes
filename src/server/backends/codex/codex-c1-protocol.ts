import type { CodexRpcMethod } from "./rpc/codex-rpc-client.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";
import {
  defineCodexAppServerMethod,
  type CodexClientRequestMethod,
  type OfficialCodexClientRequestParams,
  type OfficialCodexClientRequestResult,
  type OfficialCodexServerNotificationParams,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  nonblockingQuestionsPayloadSchema,
  type NonblockingQuestionsPayload,
} from "../../../shared/protocol/questions.js";

export const CODEX_C1_MAX_NATIVE_STRING_CODE_UNITS = 14 * 1024 * 1024;
export const CODEX_C1_MAX_COLLECTION_ITEMS = 10_000;
// Long-running Codex turns can legitimately accumulate thousands of native
// tool and collaboration items. Keep this count ceiling aligned with the
// normalized per-turn contract; serialized page bounds remain authoritative.
export const CODEX_C1_MAX_ITEMS_PER_TURN = 20_000;
export const CODEX_C1_MAX_LIST_THREADS = 500;
export const CODEX_C1_MAX_TURNS_PAGE_ITEMS = 100;
export const CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS = 100;

type OfficialThreadListParams = OfficialCodexClientRequestParams<"thread/list">;
type OfficialThreadListResponse = OfficialCodexClientRequestResult<"thread/list">;
type OfficialThreadReadParams = OfficialCodexClientRequestParams<"thread/read">;
type OfficialThreadReadResponse = OfficialCodexClientRequestResult<"thread/read">;
type OfficialThreadResumeParams = OfficialCodexClientRequestParams<"thread/resume">;
type OfficialThreadResumeResponse = OfficialCodexClientRequestResult<"thread/resume">;
type OfficialThreadTurnsListParams = OfficialCodexClientRequestParams<"thread/turns/list">;
type OfficialThreadTurnsListResponse = OfficialCodexClientRequestResult<"thread/turns/list">;
type OfficialThreadItemsListParams = OfficialCodexClientRequestParams<"thread/items/list">;
type OfficialThreadItemsListResponse = OfficialCodexClientRequestResult<"thread/items/list">;
type OfficialThreadUnsubscribeParams = OfficialCodexClientRequestParams<"thread/unsubscribe">;
type OfficialThreadUnsubscribeResponse = OfficialCodexClientRequestResult<"thread/unsubscribe">;
type OfficialThread = OfficialThreadReadResponse["thread"];
type OfficialTurn = OfficialThread["turns"][number];
type OfficialThreadItem = OfficialTurn["items"][number];
type OfficialThreadStatus = OfficialThread["status"];
type OfficialThreadSection = NonNullable<OfficialThread["section"]>;
// Exhaustive key maps make drift in the pinned generated metadata a type error.
const threadSectionKeys = Object.keys({
  id: true, name: true, appearance: true,
} satisfies Record<keyof OfficialThreadSection, true>);
const threadSectionAppearanceKeys = Object.keys({
  icon: true, color: true,
} satisfies Record<keyof NonNullable<OfficialThreadSection["appearance"]>, true>);
type OfficialTokenUsageNotification =
  OfficialCodexServerNotificationParams<"thread/tokenUsage/updated">;
type OfficialThreadTokenUsage = OfficialTokenUsageNotification["tokenUsage"];

export type CodexThread = OfficialThread;
export type CodexThreadStatus = OfficialThreadStatus;
export type CodexTurn = OfficialTurn;
export type CodexThreadItem = OfficialThreadItem;
export type CodexThreadListParams = OfficialThreadListParams;
export type CodexThreadListResponse = Omit<OfficialThreadListResponse, "data"> & {
  readonly data: readonly CodexThread[];
};
export type CodexThreadReadParams = OfficialThreadReadParams;
export type CodexThreadReadResponse = Omit<OfficialThreadReadResponse, "thread"> & {
  readonly thread: CodexThread;
};
export type CodexThreadResumeParams = OfficialThreadResumeParams;
export interface CodexThreadResumeResponse {
  readonly thread: CodexThread;
  readonly model: OfficialThreadResumeResponse["model"];
  readonly modelProvider: OfficialThreadResumeResponse["modelProvider"];
  readonly serviceTier: OfficialThreadResumeResponse["serviceTier"];
  readonly cwd: OfficialThreadResumeResponse["cwd"];
  readonly runtimeWorkspaceRoots: OfficialThreadResumeResponse["runtimeWorkspaceRoots"];
  readonly instructionSources: OfficialThreadResumeResponse["instructionSources"];
  readonly approvalPolicy: OfficialThreadResumeResponse["approvalPolicy"];
  readonly approvalsReviewer: OfficialThreadResumeResponse["approvalsReviewer"];
  readonly sandbox: OfficialThreadResumeResponse["sandbox"];
  readonly activePermissionProfile: OfficialThreadResumeResponse["activePermissionProfile"];
  readonly reasoningEffort: OfficialThreadResumeResponse["reasoningEffort"];
  readonly multiAgentMode: OfficialThreadResumeResponse["multiAgentMode"];
  readonly initialTurnsPage: OfficialThreadResumeResponse["initialTurnsPage"];
  readonly turnsBackwardsCursor: OfficialThreadResumeResponse["turnsBackwardsCursor"];
  readonly itemsBackwardsCursor: OfficialThreadResumeResponse["itemsBackwardsCursor"];
}
export type CodexThreadTurnsListParams = OfficialThreadTurnsListParams;
export type CodexThreadTurnsListResponse = Omit<OfficialThreadTurnsListResponse, "data"> & {
  readonly data: readonly CodexTurn[];
};
export type CodexThreadItemsListParams = OfficialThreadItemsListParams;
export type CodexThreadItemEntry = OfficialThreadItemsListResponse["data"][number];
export type CodexThreadItemsListResponse = Omit<OfficialThreadItemsListResponse, "data"> & {
  readonly data: readonly CodexThreadItemEntry[];
};
export type CodexThreadUnsubscribeParams = OfficialThreadUnsubscribeParams;
export type CodexThreadUnsubscribeResponse = OfficialThreadUnsubscribeResponse;
export type CodexThreadTokenUsage = OfficialThreadTokenUsage;
export type CodexThreadTokenUsageUpdatedNotification = OfficialTokenUsageNotification;
type OfficialAgentMessage = Extract<OfficialThreadItem, { type: "agentMessage" }>;
type CodexNativeAsyncQuestions = {
  readonly questions: NonNullable<OfficialAgentMessage["questions"]>;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function assertExactKeys(value: unknown, keys: readonly string[], label: string): void {
  assertRecord(value, label);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label}_unexpected_field`);
  }
}

function assertNativeString(value: string, label: string): void {
  if (value.length > CODEX_C1_MAX_NATIVE_STRING_CODE_UNITS) {
    throw new Error(`${label}_too_large`);
  }
}

function assertNativeId(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) throw new Error(`${label}_invalid`);
}

function assertRequestCursor(value: string | null | undefined, label: string): void {
  if (value === undefined) return;
  if (value === null || value.length === 0) throw new Error(`${label}_invalid`);
  assertNativeString(value, label);
}

function assertResponseCursor(value: string | null, label: string): void {
  if (value === null) return;
  if (value.length === 0) throw new Error(`${label}_invalid`);
  assertNativeString(value, label);
}

function assertPageLimit(
  value: number | null | undefined,
  maximum: number,
  label: string,
): void {
  if (
    value === null ||
    (value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > maximum))
  ) {
    throw new Error(`${label}_invalid`);
  }
}

function assertSafeCount(value: number | null, label: string): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error(`${label}_invalid`);
  }
}

function assertNativeValueBounds(
  value: unknown,
  label: string,
  shouldInspect: (container: object, key: string | number) => boolean = () => true,
): void {
  if (typeof value === "string") {
    assertNativeString(value, label);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > CODEX_C1_MAX_COLLECTION_ITEMS) {
      throw new Error(`${label}_too_many_values`);
    }
    value.forEach((entry, index) => {
      if (shouldInspect(value, index)) {
        assertNativeValueBounds(entry, label, shouldInspect);
      }
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (!shouldInspect(value, key)) continue;
      assertNativeString(key, `${label}_object_key`);
      assertNativeValueBounds(entry, label, shouldInspect);
    }
  }
}

function assertUserInputClosed(input: Extract<OfficialThreadItem, { type: "userMessage" }>["content"][number]): void {
  switch (input.type) {
    case "text":
      assertExactKeys(input, ["type", "text", "text_elements"], "user_input_text");
      input.text_elements.forEach((element) => {
        assertExactKeys(element, ["byteRange", "placeholder"], "text_element");
        assertExactKeys(element.byteRange, ["start", "end"], "byte_range");
      });
      break;
    case "image":
    case "localImage":
      assertExactKeys(input, ["type", "detail", input.type === "image" ? "url" : "path"], "user_input_image");
      break;
    case "audio":
      assertExactKeys(input, ["type", "url"], "user_input_audio");
      break;
    case "localAudio":
      assertExactKeys(input, ["type", "path"], "user_input_local_audio");
      break;
    case "skill":
    case "mention":
      assertExactKeys(input, ["type", "name", "path"], "user_input_reference");
      break;
  }
}

function assertThreadItemClosed(item: OfficialThreadItem): void {
  const keysByType = {
    userMessage: ["type", "id", "clientId", "content"], hookPrompt: ["type", "id", "fragments"], agentMessage: ["type", "id", "text", "phase", "memoryCitation", "delivery", "questions"], functionCallOutput: ["type", "id", "name", "namespace", "output"], plan: ["type", "id", "text"], reasoning: ["type", "id", "summary", "content"],
    commandExecution: ["type", "id", "pluginId", "scriptPath", "command", "cwd", "processId", "source", "status", "commandActions", "aggregatedOutput", "exitCode", "durationMs"], fileChange: ["type", "id", "changes", "status"],
    mcpToolCall: ["type", "id", "server", "tool", "status", "arguments", "appContext", "mcpAppResourceUri", "pluginId", "readOnlyHint", "result", "error", "durationMs"], dynamicToolCall: ["type", "id", "namespace", "tool", "arguments", "status", "contentItems", "success", "durationMs"],
    collabAgentToolCall: ["type", "id", "tool", "status", "senderThreadId", "receiverThreadIds", "prompt", "model", "reasoningEffort", "agentsStates"], subAgentActivity: ["type", "id", "kind", "agentThreadId", "agentPath"], webSearch: ["type", "id", "query", "action", "results"], imageView: ["type", "id", "path"], sleep: ["type", "id", "durationMs"], imageGeneration: ["type", "id", "status", "revisedPrompt", "result", "transparentBackground", "failure", "savedPath"], enteredReviewMode: ["type", "id", "review"], exitedReviewMode: ["type", "id", "review"], contextCompaction: ["type", "id"],
  } as const satisfies Record<OfficialThreadItem["type"], readonly string[]>;
  assertExactKeys(item, keysByType[item.type], "thread_item");
  switch (item.type) {
    case "userMessage": item.content.forEach(assertUserInputClosed); break;
    case "hookPrompt": item.fragments.forEach((fragment) => assertExactKeys(fragment, ["text", "hookRunId"], "hook_prompt_fragment")); break;
    case "agentMessage":
      if (item.memoryCitation !== null) {
        assertExactKeys(item.memoryCitation, ["entries", "threadIds"], "memory_citation");
        item.memoryCitation.entries.forEach((entry) => assertExactKeys(entry, ["path", "lineStart", "lineEnd", "note"], "memory_citation_entry"));
      }
      refineCodexAsyncQuestions(item.questions, item.delivery);
      break;
    case "functionCallOutput":
      if (Array.isArray(item.output)) {
        item.output.forEach((content) =>
          assertExactKeys(
            content,
            content.type === "input_text"
              ? ["type", "text"]
              : content.type === "input_image"
                ? ["type", "image_url", "detail"]
                : content.type === "input_audio"
                  ? ["type", "audio_url"]
                  : ["type", "encrypted_content"],
            "function_call_output_content",
          ),
        );
      }
      break;
    case "commandExecution":
      item.commandActions.forEach((action) => assertExactKeys(action, action.type === "read" ? ["type", "command", "name", "path"] : action.type === "listFiles" ? ["type", "command", "path"] : action.type === "search" ? ["type", "command", "query", "path"] : ["type", "command"], "command_action"));
      break;
    case "fileChange":
      item.changes.forEach((change) => {
        assertExactKeys(change, ["path", "kind", "diff"], "file_update_change");
        assertExactKeys(change.kind, change.kind.type === "update" ? ["type", "move_path"] : ["type"], "patch_change_kind");
      });
      break;
    case "mcpToolCall":
      if (item.appContext !== null) assertExactKeys(item.appContext, ["connectorId", "linkId", "resourceUri", "appName", "actionName"], "mcp_app_context");
      if (item.result !== null) assertExactKeys(item.result, ["content", "structuredContent", "_meta"], "mcp_result");
      if (item.error !== null) assertExactKeys(item.error, ["message"], "mcp_error");
      break;
    case "dynamicToolCall": item.contentItems?.forEach((content) => assertExactKeys(content, content.type === "inputText" ? ["type", "text"] : content.type === "inputImage" ? ["type", "imageUrl"] : ["type", "audioUrl"], "dynamic_content")); break;
    case "collabAgentToolCall": Object.values(item.agentsStates).forEach((state) => { if (state !== undefined) assertExactKeys(state, ["status", "message"], "collab_agent_state"); }); break;
    case "webSearch":
      if (item.action !== null) assertExactKeys(item.action, item.action.type === "search" ? ["type", "query", "queries"] : item.action.type === "openPage" ? ["type", "url"] : item.action.type === "findInPage" ? ["type", "url", "pattern"] : ["type"], "web_action");
      break;
  }
}

/**
 * Validates the native producer semantics for one structured async-question
 * item without imposing the tighter browser feature envelope. `undefined`
 * means the required native field was `null`, so this is an ordinary
 * assistant message without structured questions.
 */
export function refineCodexAsyncQuestions(
  questions: unknown,
  delivery: OfficialAgentMessage["delivery"],
): CodexNativeAsyncQuestions | undefined {
  if (questions === null) return undefined;
  if (questions === undefined) throw new Error("async_questions_invalid");
  if (delivery !== "async") {
    throw new Error("async_questions_delivery_invalid");
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("async_questions_invalid");
  }
  for (const question of questions) {
    assertRecord(question, "async_question");
    assertExactKeys(question, ["title", "options"], "async_question");
    if (typeof question.title !== "string" || question.title.trim().length === 0) {
      throw new Error("async_questions_invalid");
    }
    if (question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length === 0) {
        throw new Error("async_questions_invalid");
      }
      for (const option of question.options) {
        if (typeof option !== "string" || option.trim().length === 0) {
          throw new Error("async_questions_invalid");
        }
      }
    }
  }
  return { questions: questions as NonNullable<OfficialAgentMessage["questions"]> };
}

export function codexAsyncQuestionsFromAgentMessage(
  item: Extract<OfficialThreadItem, { type: "agentMessage" }>,
): NonblockingQuestionsPayload | undefined {
  const native = refineCodexAsyncQuestions(item.questions, item.delivery);
  if (native === undefined) return undefined;
  const projected = nonblockingQuestionsPayloadSchema.safeParse(native);
  return projected.success ? projected.data : undefined;
}

function assertThreadItem(item: OfficialThreadItem): void {
  assertThreadItemClosed(item);
  assertNativeId(item.id, "thread_item_id");
  assertNativeValueBounds(item, "thread_item", (container, key) => {
    if (
      container === item &&
      ((item.type === "mcpToolCall" && key === "arguments") ||
        (item.type === "dynamicToolCall" && key === "arguments") ||
        (item.type === "webSearch" && key === "results") ||
        (item.type === "imageGeneration" && key === "result"))
    ) {
      return false;
    }
    if (
      item.type === "mcpToolCall" &&
      item.result !== null &&
      container === item.result &&
      (key === "content" || key === "structuredContent" || key === "_meta")
    ) {
      return false;
    }
    return true;
  });
  switch (item.type) {
    case "userMessage":
      if (item.content.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("user_content_count_exceeded");
      if (item.clientId !== null) assertNativeId(item.clientId, "client_message_id");
      for (const input of item.content) {
        if (input.type === "text") {
          if (input.text_elements.length > 1_000) throw new Error("text_element_count_exceeded");
          for (const element of input.text_elements) {
            assertSafeCount(element.byteRange.start, "text_element_start");
            assertSafeCount(element.byteRange.end, "text_element_end");
          }
        }
      }
      break;
    case "hookPrompt":
      if (item.fragments.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("hook_fragment_count_exceeded");
      item.fragments.forEach((fragment) => assertNativeId(fragment.hookRunId, "hook_run_id"));
      break;
    case "agentMessage":
      if (item.memoryCitation !== null && (item.memoryCitation.entries.length > 1_000 || item.memoryCitation.threadIds.length > 1_000)) throw new Error("memory_citation_count_exceeded");
      item.memoryCitation?.entries.forEach((entry) => {
        assertSafeCount(entry.lineStart, "citation_line_start");
        assertSafeCount(entry.lineEnd, "citation_line_end");
      });
      item.memoryCitation?.threadIds.forEach((id) => assertNativeId(id, "citation_thread_id"));
      break;
    case "functionCallOutput":
      if (Array.isArray(item.output) && item.output.length > CODEX_C1_MAX_COLLECTION_ITEMS) {
        throw new Error("function_call_output_count_exceeded");
      }
      break;
    case "reasoning":
      if (item.summary.length > 1_000 || item.content.length > 1_000) throw new Error("reasoning_part_count_exceeded");
      break;
    case "commandExecution":
      if (item.processId !== null) assertNativeString(item.processId, "process_id");
      if (item.exitCode !== null && !Number.isInteger(item.exitCode)) throw new Error("exit_code_invalid");
      assertSafeCount(item.durationMs, "command_duration");
      break;
    case "mcpToolCall":
      if (item.result !== null && item.result.content.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("mcp_content_count_exceeded");
      assertSafeCount(item.durationMs, "tool_duration");
      break;
    case "dynamicToolCall":
      if (item.contentItems !== null && item.contentItems.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("dynamic_content_count_exceeded");
      assertSafeCount(item.durationMs, "tool_duration");
      break;
    case "collabAgentToolCall":
      if (item.receiverThreadIds.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("receiver_thread_count_exceeded");
      assertNativeId(item.senderThreadId, "sender_thread_id");
      item.receiverThreadIds.forEach((id) => assertNativeId(id, "receiver_thread_id"));
      break;
    case "webSearch":
      if (item.action?.type === "search" && item.action.queries !== null && item.action.queries.length > 1_000) throw new Error("web_search_query_count_exceeded");
      if (item.results !== null && item.results.length > CODEX_C1_MAX_COLLECTION_ITEMS) throw new Error("web_search_result_count_exceeded");
      break;
    case "subAgentActivity":
      assertNativeId(item.agentThreadId, "agent_thread_id");
      break;
    case "sleep":
      assertSafeCount(item.durationMs, "sleep_duration");
      break;
    case "imageGeneration":
      if (
        item.status !== "in_progress" &&
        item.status !== "completed" &&
        item.status !== "failed"
      ) {
        throw new Error("image_generation_status_invalid");
      }
      if (
        item.transparentBackground !== undefined &&
        item.transparentBackground !== null &&
        typeof item.transparentBackground !== "boolean"
      ) {
        throw new Error("image_generation_transparency_invalid");
      }
      if (item.failure !== null) {
        assertExactKeys(
          item.failure,
          ["type", "limitId", "resetsAt"],
          "image_generation_failure",
        );
        assertNativeId(item.failure.limitId, "image_generation_limit_id");
        assertSafeCount(item.failure.resetsAt, "image_generation_reset_time");
      }
      if (item.result.length > MAXIMUM_PROVIDER_FRAME_BYTES) {
        throw new Error("image_generation_result_too_large");
      }
      break;
  }
  if (item.type === "fileChange" && item.changes.length > CODEX_C1_MAX_ITEMS_PER_TURN) {
    throw new Error("file_change_count_exceeded");
  }
}

function assertTurn(turn: OfficialTurn): void {
  assertExactKeys(turn, ["id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs"], "turn");
  assertNativeId(turn.id, "turn_id");
  if (turn.items.length > CODEX_C1_MAX_ITEMS_PER_TURN) {
    throw new Error("turn_item_count_exceeded");
  }
  assertSafeCount(turn.startedAt, "turn_started_at");
  assertSafeCount(turn.completedAt, "turn_completed_at");
  assertSafeCount(turn.durationMs, "turn_duration");
  assertNativeValueBounds(
    turn,
    "turn",
    (container, key) => !(container === turn && key === "items"),
  );
  if (turn.error !== null) {
    const error = turn.error;
    assertExactKeys(error, ["message", "codexErrorInfo", "additionalDetails", "misalignment"], "turn_error");
    if (error.misalignment != null) {
      assertExactKeys(error.misalignment, ["errorType", "detailedExplanation", "steer"], "turn_error_misalignment");
      if (error.misalignment.steer != null) {
        assertExactKeys(error.misalignment.steer, ["message"], "turn_error_misalignment_steer");
      }
    }
    const info = error.codexErrorInfo;
    if (info !== null && typeof info === "object") {
      const keys = Object.keys(info);
      const allowed = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts", "activeTurnNotSteerable"]);
      if (keys.length !== 1 || !allowed.has(keys[0]!)) throw new Error("codex_error_info_invalid");
      for (const detail of Object.values(info)) {
        if (typeof detail === "object" && detail !== null) {
          if ("httpStatusCode" in detail) {
            assertExactKeys(detail, ["httpStatusCode"], "http_status");
            if (detail.httpStatusCode !== null && !Number.isInteger(detail.httpStatusCode)) throw new Error("http_status_invalid");
          }
          if ("turnKind" in detail) assertExactKeys(detail, ["turnKind"], "active_turn_not_steerable");
        }
      }
    }
  }
  turn.items.forEach(assertThreadItem);
}

export function refineCodexThreadItem(value: CodexThreadItem): CodexThreadItem {
  assertThreadItem(value);
  return value;
}

export function refineCodexTurn(value: CodexTurn): CodexTurn {
  assertTurn(value);
  return value;
}

export function refineCodexThreadStatus(
  value: CodexThreadStatus,
): CodexThreadStatus {
  assertExactKeys(
    value,
    value.type === "active" ? ["type", "activeFlags"] : ["type"],
    "thread_status",
  );
  if (value.type === "active" && value.activeFlags.length > 2) {
    throw new Error("thread_active_flag_count_exceeded");
  }
  return value;
}

function assertSupportedThreadProfile(value: OfficialThread): void {
  if (value.model === undefined) {
    throw new Error("thread_model_missing");
  }
  if (value.reasoningEffort === undefined) {
    throw new Error("thread_reasoning_effort_missing");
  }
  if (value.extra !== null && Object.keys(value.extra).length !== 0) {
    throw new Error("thread_extra_invalid");
  }
}

export function projectCodexThread(value: OfficialThread): CodexThread {
  assertNativeId(value.id, "thread_id");
  assertNativeId(value.sessionId, "session_id");
  if (value.forkedFromId !== null) assertNativeId(value.forkedFromId, "forked_from_id");
  if (value.parentThreadId !== null) assertNativeId(value.parentThreadId, "parent_thread_id");
  if (value.projectId !== null) assertNativeId(value.projectId, "project_id");
  if (value.section !== null) assertNativeId(value.section.id, "section_id");
  assertSafeCount(value.createdAt, "thread_created_at");
  assertSafeCount(value.updatedAt, "thread_updated_at");
  assertSafeCount(value.recencyAt, "thread_recency_at");
  assertSafeCount(value.sectionEnteredAt, "section_entered_at");
  refineCodexThreadStatus(value.status);
  if (value.section !== null) {
    assertExactKeys(value.section, threadSectionKeys, "thread_section");
    if (value.section.appearance !== null) {
      assertExactKeys(value.section.appearance, threadSectionAppearanceKeys, "thread_section_appearance");
    }
  }
  if (value.gitInfo !== null) assertExactKeys(value.gitInfo, ["sha", "branch", "originUrl"], "git_info");
  value.turns.forEach(assertTurn);
  if (typeof value.source === "object" && "subAgent" in value.source) {
    assertExactKeys(value.source, ["subAgent"], "session_source");
    const source = value.source.subAgent;
    if (typeof source === "object" && "thread_spawn" in source) {
      assertExactKeys(source, ["thread_spawn"], "sub_agent_source");
      assertExactKeys(source.thread_spawn, ["parent_thread_id", "depth", "agent_path", "agent_nickname", "agent_role"], "thread_spawn_source");
      assertNativeId(source.thread_spawn.parent_thread_id, "source_parent_thread_id");
      assertSafeCount(source.thread_spawn.depth, "source_agent_depth");
    } else if (typeof source === "object") assertExactKeys(source, ["other"], "sub_agent_source_other");
  } else if (typeof value.source === "object") {
    assertExactKeys(value.source, ["custom"], "session_source_custom");
  }
  assertNativeValueBounds(
    value,
    "thread",
    (container, key) => !(container === value && key === "turns"),
  );
  assertSupportedThreadProfile(value);
  return {
    id: value.id,
    extra: value.extra,
    sessionId: value.sessionId,
    forkedFromId: value.forkedFromId,
    parentThreadId: value.parentThreadId,
    preview: value.preview,
    ephemeral: value.ephemeral,
    section: value.section,
    sectionEnteredAt: value.sectionEnteredAt,
    projectId: value.projectId,
    historyMode: value.historyMode,
    modelProvider: value.modelProvider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    recencyAt: value.recencyAt,
    status: value.status,
    path: value.path,
    cwd: value.cwd,
    cliVersion: value.cliVersion,
    source: value.source,
    canAcceptDirectInput: value.canAcceptDirectInput,
    threadSource: value.threadSource,
    agentNickname: value.agentNickname,
    agentRole: value.agentRole,
    gitInfo: value.gitInfo,
    name: value.name,
    turns: value.turns,
  };
}

function refineListParams(value: OfficialThreadListParams): OfficialThreadListParams {
  assertExactKeys(value, ["cursor", "limit", "sortKey", "sortDirection", "modelProviders", "sourceKinds", "archived", "sectionId", "cwd", "useStateDbOnly", "searchTerm"], "thread_list_params");
  if (value.limit != null && (!Number.isSafeInteger(value.limit) || value.limit <= 0 || value.limit > CODEX_C1_MAX_LIST_THREADS)) {
    throw new Error("thread_list_limit_invalid");
  }
  if (value.modelProviders && value.modelProviders.length > CODEX_C1_MAX_LIST_THREADS) throw new Error("model_provider_count_exceeded");
  if (value.sourceKinds && value.sourceKinds.length > 10) throw new Error("source_kind_count_exceeded");
  const cwds = Array.isArray(value.cwd) ? value.cwd : [];
  if (cwds.length > CODEX_C1_MAX_LIST_THREADS) throw new Error("cwd_count_exceeded");
  assertNativeValueBounds(value, "thread_list_params");
  return value;
}

function refineThreadReadParams(value: OfficialThreadReadParams): OfficialThreadReadParams {
  assertExactKeys(value, ["threadId", "includeTurns"], "thread_read_params");
  assertNativeId(value.threadId, "thread_id");
  return value;
}

function refineThreadResumeParams(value: OfficialThreadResumeParams): OfficialThreadResumeParams {
  assertExactKeys(value, ["threadId", "model", "modelProvider", "serviceTier", "cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "config", "baseInstructions", "developerInstructions", "personality", "excludeTurns", "initialTurnsPage"], "thread_resume_params");
  assertNativeId(value.threadId, "thread_id");
  if (value.excludeTurns !== undefined && value.excludeTurns !== true) {
    throw new Error("thread_resume_exclude_turns_invalid");
  }
  if (value.initialTurnsPage !== undefined) {
    if (value.initialTurnsPage === null || value.excludeTurns !== true) {
      throw new Error("thread_resume_initial_turns_page_invalid");
    }
    assertExactKeys(
      value.initialTurnsPage,
      ["limit", "sortDirection", "itemsView"],
      "thread_resume_initial_turns_page",
    );
    assertPageLimit(
      value.initialTurnsPage.limit,
      CODEX_C1_MAX_TURNS_PAGE_ITEMS,
      "thread_resume_initial_turns_page_limit",
    );
    if (
      value.initialTurnsPage.limit === undefined ||
      value.initialTurnsPage.sortDirection !== "desc" ||
      value.initialTurnsPage.itemsView !== "notLoaded"
    ) {
      throw new Error("thread_resume_initial_turns_page_invalid");
    }
  }
  if (value.approvalPolicy !== null && value.approvalPolicy !== undefined && typeof value.approvalPolicy === "object") {
    assertExactKeys(value.approvalPolicy, ["granular"], "approval_policy");
    assertExactKeys(value.approvalPolicy.granular, ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"], "granular_approval_policy");
  }
  assertNativeValueBounds(
    value,
    "thread_resume_params",
    (container, key) => !(container === value && key === "config"),
  );
  return value;
}

function refineThreadTurnsListParams(
  value: OfficialThreadTurnsListParams,
): OfficialThreadTurnsListParams {
  assertExactKeys(
    value,
    ["threadId", "cursor", "limit", "sortDirection", "itemsView"],
    "thread_turns_list_params",
  );
  assertNativeId(value.threadId, "thread_id");
  assertRequestCursor(value.cursor, "thread_turns_cursor");
  assertPageLimit(
    value.limit,
    CODEX_C1_MAX_TURNS_PAGE_ITEMS,
    "thread_turns_list_limit",
  );
  if (value.itemsView !== "notLoaded") {
    throw new Error("thread_turns_items_view_invalid");
  }
  if (value.sortDirection === null) {
    throw new Error("thread_turns_sort_direction_invalid");
  }
  return value;
}

function refineThreadItemsListParams(
  value: OfficialThreadItemsListParams,
): OfficialThreadItemsListParams {
  assertExactKeys(
    value,
    ["threadId", "turnId", "cursor", "limit", "sortDirection"],
    "thread_items_list_params",
  );
  assertNativeId(value.threadId, "thread_id");
  if (value.turnId === null) throw new Error("thread_items_turn_id_invalid");
  if (value.turnId !== undefined) assertNativeId(value.turnId, "turn_id");
  assertRequestCursor(value.cursor, "thread_items_cursor");
  assertPageLimit(
    value.limit,
    CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS,
    "thread_items_list_limit",
  );
  if (value.sortDirection === null) {
    throw new Error("thread_items_sort_direction_invalid");
  }
  return value;
}

function refineThreadUnsubscribeParams(value: OfficialThreadUnsubscribeParams): OfficialThreadUnsubscribeParams {
  assertExactKeys(value, ["threadId"], "thread_unsubscribe_params");
  assertNativeId(value.threadId, "thread_id");
  return value;
}

function projectThreadListResponse(value: OfficialThreadListResponse): CodexThreadListResponse {
  assertExactKeys(value, ["data", "nextCursor", "backwardsCursor"], "thread_list_response");
  if (value.data.length > CODEX_C1_MAX_LIST_THREADS) throw new Error("thread_list_count_exceeded");
  return { data: value.data.map(projectCodexThread), nextCursor: value.nextCursor, backwardsCursor: value.backwardsCursor };
}

function projectThreadReadResponse(value: OfficialThreadReadResponse): CodexThreadReadResponse {
  assertExactKeys(value, ["thread"], "thread_read_response");
  return { thread: projectCodexThread(value.thread) };
}

function projectThreadTurnsListResponse(
  value: OfficialThreadTurnsListResponse,
): CodexThreadTurnsListResponse {
  assertExactKeys(
    value,
    ["data", "nextCursor", "backwardsCursor"],
    "thread_turns_list_response",
  );
  if (value.data.length > CODEX_C1_MAX_TURNS_PAGE_ITEMS) {
    throw new Error("thread_turns_list_count_exceeded");
  }
  assertResponseCursor(value.nextCursor, "thread_turns_next_cursor");
  assertResponseCursor(value.backwardsCursor, "thread_turns_backwards_cursor");
  if (value.data.length === 0 && value.backwardsCursor !== null) {
    throw new Error("thread_turns_backwards_cursor_invalid");
  }
  const turnIds = new Set<string>();
  for (const turn of value.data) {
    refineCodexTurn(turn);
    if (turn.itemsView !== "notLoaded" || turn.items.length !== 0) {
      throw new Error("thread_turns_items_not_loaded_invalid");
    }
    if (turnIds.has(turn.id)) throw new Error("thread_turns_duplicate_turn");
    turnIds.add(turn.id);
  }
  return value;
}

function projectThreadItemsListResponse(
  value: OfficialThreadItemsListResponse,
): CodexThreadItemsListResponse {
  assertExactKeys(
    value,
    ["data", "nextCursor", "backwardsCursor"],
    "thread_items_list_response",
  );
  if (value.data.length > CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS) {
    throw new Error("thread_items_list_count_exceeded");
  }
  assertResponseCursor(value.nextCursor, "thread_items_next_cursor");
  assertResponseCursor(value.backwardsCursor, "thread_items_backwards_cursor");
  if (value.data.length === 0 && value.backwardsCursor !== null) {
    throw new Error("thread_items_backwards_cursor_invalid");
  }
  const itemIdsByTurn = new Map<string, Set<string>>();
  for (const entry of value.data) {
    assertExactKeys(entry, ["turnId", "item"], "thread_item_entry");
    assertNativeId(entry.turnId, "turn_id");
    refineCodexThreadItem(entry.item);
    const itemIds = itemIdsByTurn.get(entry.turnId) ?? new Set<string>();
    if (itemIds.has(entry.item.id)) {
      throw new Error("thread_items_duplicate_coordinate");
    }
    itemIds.add(entry.item.id);
    itemIdsByTurn.set(entry.turnId, itemIds);
  }
  return value;
}

function assertResumeHistoryFields(value: OfficialThreadResumeResponse): void {
  if (value.runtimeWorkspaceRoots.length > 1_000) {
    throw new Error("runtime_workspace_roots_invalid");
  }
  if (value.activePermissionProfile !== null) {
    assertExactKeys(value.activePermissionProfile, ["id", "extends"], "active_permission_profile");
    assertNativeId(value.activePermissionProfile.id, "permission_profile_id");
  }
  if (typeof value.multiAgentMode === "object") {
    assertExactKeys(value.multiAgentMode, ["custom"], "multi_agent_mode");
  }
  if (value.initialTurnsPage !== null) {
    projectThreadTurnsListResponse(value.initialTurnsPage);
  }
  assertResponseCursor(value.turnsBackwardsCursor, "resume_turns_backwards_cursor");
  assertResponseCursor(value.itemsBackwardsCursor, "resume_items_backwards_cursor");
}

export function projectCodexThreadResumeResponse(
  value: OfficialThreadResumeResponse,
): CodexThreadResumeResponse {
  assertNativeValueBounds(value, "thread_resume_response", (container, key) => {
    if (container === value && key === "thread") return false;
    return !(
      value.initialTurnsPage !== null &&
      container === value.initialTurnsPage &&
      key === "data"
    );
  });
  assertResumeHistoryFields(value);
  if (value.instructionSources.length > 1_000) throw new Error("instruction_source_count_exceeded");
  if (typeof value.approvalPolicy === "object") {
    assertExactKeys(value.approvalPolicy, ["granular"], "approval_policy");
    assertExactKeys(value.approvalPolicy.granular, ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"], "granular_approval_policy");
  }
  assertExactKeys(value.sandbox, value.sandbox.type === "dangerFullAccess" ? ["type"] : value.sandbox.type === "workspaceWrite" ? ["type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"] : ["type", "networkAccess"], "sandbox_policy");
  if (value.sandbox.type === "workspaceWrite" && value.sandbox.writableRoots.length > 1_000) throw new Error("sandbox_writable_root_count_exceeded");
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
    initialTurnsPage: value.initialTurnsPage,
    turnsBackwardsCursor: value.turnsBackwardsCursor,
    itemsBackwardsCursor: value.itemsBackwardsCursor,
  };
}

function refineTokenUsage(value: OfficialThreadTokenUsage): OfficialThreadTokenUsage {
  assertExactKeys(value, ["total", "last", "modelContextWindow"], "thread_token_usage");
  for (const usage of [value.total, value.last]) {
    assertExactKeys(usage, ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"], "token_usage_breakdown");
    for (const count of Object.values(usage)) assertSafeCount(count, "token_usage_count");
  }
  assertSafeCount(value.modelContextWindow, "model_context_window");
  return value;
}

export function refineCodexThreadTokenUsage(
  value: CodexThreadTokenUsage,
): CodexThreadTokenUsage {
  return refineTokenUsage(value);
}

function method<
  Method extends CodexClientRequestMethod,
  Result,
>(
  name: Method,
  refineParams: (
    value: OfficialCodexClientRequestParams<Method>,
  ) => OfficialCodexClientRequestParams<Method>,
  refineResult: (value: OfficialCodexClientRequestResult<Method>) => Result,
): CodexRpcMethod<OfficialCodexClientRequestParams<Method>, Result> {
  return defineCodexAppServerMethod({ method: name, refineParams, refineResult });
}

export const codexThreadListMethod = method("thread/list", refineListParams, projectThreadListResponse);
export const codexThreadReadMethod = method("thread/read", refineThreadReadParams, projectThreadReadResponse);
export const codexThreadResumeMethod = method("thread/resume", refineThreadResumeParams, projectCodexThreadResumeResponse);
export const codexThreadTurnsListMethod = method(
  "thread/turns/list",
  refineThreadTurnsListParams,
  projectThreadTurnsListResponse,
);
export const codexThreadItemsListMethod = method(
  "thread/items/list",
  refineThreadItemsListParams,
  projectThreadItemsListResponse,
);
export const codexThreadUnsubscribeMethod = method("thread/unsubscribe", refineThreadUnsubscribeParams, (value) => {
  assertExactKeys(value, ["status"], "thread_unsubscribe_response");
  return value;
});
