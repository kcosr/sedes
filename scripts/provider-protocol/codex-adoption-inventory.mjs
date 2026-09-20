/**
 * Current production Codex app-server wire inventory.
 *
 * This inventory is the input to the generated CodexAppServerBinding profile.
 * Every route consumed by production must be present here before its official
 * definition can become structural authority.
 */
export const clientRequests = [
  ["initialize", "InitializeParams", "InitializeResponse", "initialization"],
  ["thread/list", "ThreadListParams", "ThreadListResponse", "thread_history", "stable", "experimental"],
  ["thread/loaded/list", "ThreadLoadedListParams", "ThreadLoadedListResponse", "thread_history"],
  ["thread/read", "ThreadReadParams", "ThreadReadResponse", "thread_history", "stable", "experimental"],
  ["thread/resume", "ThreadResumeParams", "ThreadResumeResponse", "thread_history", "stable", "experimental"],
  ["thread/turns/list", "ThreadTurnsListParams", "ThreadTurnsListResponse", "thread_history"],
  ["thread/items/list", "ThreadItemsListParams", "ThreadItemsListResponse", "thread_history"],
  ["thread/unsubscribe", "ThreadUnsubscribeParams", "ThreadUnsubscribeResponse", "thread_history"],
  ["thread/start", "ThreadStartParams", "ThreadStartResponse", "thread_history", "stable", "experimental"],
  ["turn/start", "TurnStartParams", "TurnStartResponse", "live_turns"],
  ["turn/steer", "TurnSteerParams", "TurnSteerResponse", "live_turns"],
  ["turn/interrupt", "TurnInterruptParams", "TurnInterruptResponse", "live_turns"],
  ["thread/name/set", "ThreadSetNameParams", "ThreadSetNameResponse", "actions"],
  ["thread/compact/start", "ThreadCompactStartParams", "ThreadCompactStartResponse", "actions"],
  ["model/list", "ModelListParams", "ModelListResponse", "initialization"],
  ["experimentalFeature/list", "ExperimentalFeatureListParams", "ExperimentalFeatureListResponse", "actions"],
  ["skills/list", "SkillsListParams", "SkillsListResponse", "actions"],
  ["permissionProfile/list", "PermissionProfileListParams", "PermissionProfileListResponse", "actions"],
  ["thread/fork", "ThreadForkParams", "ThreadForkResponse", "actions", "stable", "experimental"],
  ["thread/inject_items", "ThreadInjectItemsParams", "ThreadInjectItemsResponse", "actions"],
  ["thread/goal/get", "ThreadGoalGetParams", "ThreadGoalGetResponse", "actions"],
  ["thread/goal/set", "ThreadGoalSetParams", "ThreadGoalSetResponse", "actions"],
  ["thread/goal/clear", "ThreadGoalClearParams", "ThreadGoalClearResponse", "actions"],
  ["thread/settings/update", "ThreadSettingsUpdateParams", "ThreadSettingsUpdateResponse", "actions", "experimental"],
];

export const clientNotifications = [
  ["initialized", null, "initialization"],
];

export const serverRequests = [
  ["account/chatgptAuthTokens/refresh", "ChatgptAuthTokensRefreshParams", "ChatgptAuthTokensRefreshResponse", "recognized_fail_closed"],
  ["applyPatchApproval", "ApplyPatchApprovalParams", "ApplyPatchApprovalResponse", "handled"],
  ["attestation/generate", "AttestationGenerateParams", "AttestationGenerateResponse", "recognized_fail_closed"],
  ["execCommandApproval", "ExecCommandApprovalParams", "ExecCommandApprovalResponse", "handled"],
  ["item/commandExecution/requestApproval", "CommandExecutionRequestApprovalParams", "CommandExecutionRequestApprovalResponse", "handled", "experimental"],
  ["item/fileChange/requestApproval", "FileChangeRequestApprovalParams", "FileChangeRequestApprovalResponse", "handled"],
  ["item/permissions/requestApproval", "PermissionsRequestApprovalParams", "PermissionsRequestApprovalResponse", "handled"],
  ["item/tool/call", "DynamicToolCallParams", "DynamicToolCallResponse", "recognized_fail_closed"],
  ["item/tool/requestUserInput", "ToolRequestUserInputParams", "ToolRequestUserInputResponse", "handled"],
  ["mcpServer/elicitation/request", "McpServerElicitationRequestParams", "McpServerElicitationRequestResponse", "handled"],
];

export const serverNotifications = [
  ["account/updated", "AccountUpdatedNotification", "initialization", "ignored_lifecycle", ["none_beyond_official_structure"]],
  ["warning", "WarningNotification"],
  ["error", "ErrorNotification"],
  ["thread/status/changed", "ThreadStatusChangedNotification"],
  ["thread/name/updated", "ThreadNameUpdatedNotification"],
  ["thread/goal/updated", "ThreadGoalUpdatedNotification"],
  ["thread/goal/cleared", "ThreadGoalClearedNotification"],
  ["thread/settings/updated", "ThreadSettingsUpdatedNotification", "live_turns", "decoded", undefined, "experimental"],
  ["thread/tokenUsage/updated", "ThreadTokenUsageUpdatedNotification"],
  ["thread/compacted", "ContextCompactedNotification"],
  ["turn/started", "TurnStartedNotification"],
  ["turn/completed", "TurnCompletedNotification"],
  ["turn/diff/updated", "TurnDiffUpdatedNotification"],
  ["turn/plan/updated", "TurnPlanUpdatedNotification"],
  ["item/started", "ItemStartedNotification"],
  ["item/completed", "ItemCompletedNotification"],
  ["item/agentMessage/delta", "AgentMessageDeltaNotification"],
  ["item/plan/delta", "PlanDeltaNotification"],
  ["item/commandExecution/outputDelta", "CommandExecutionOutputDeltaNotification"],
  ["item/fileChange/outputDelta", "FileChangeOutputDeltaNotification"],
  ["item/fileChange/patchUpdated", "FileChangePatchUpdatedNotification"],
  ["item/mcpToolCall/progress", "McpToolCallProgressNotification"],
  ["item/reasoning/summaryPartAdded", "ReasoningSummaryPartAddedNotification"],
  ["item/reasoning/summaryTextDelta", "ReasoningSummaryTextDeltaNotification"],
  ["item/reasoning/textDelta", "ReasoningTextDeltaNotification"],
  ["modelProvider/authRecoveryStarted", "AuthRecoveryNotification", "live_turns", "decoded", ["route_identity"]],
  ["modelProvider/authRecoveryCompleted", "AuthRecoveryNotification", "live_turns", "decoded", ["route_identity"]],
  ["mcpServer/startupStatus/updated", "McpServerStatusUpdatedNotification", "initialization", "ignored_informational", ["none_beyond_official_structure"]],
  ["serverRequest/resolved", "ServerRequestResolvedNotification"],
  ["skills/changed", "SkillsChangedNotification", "actions", "catalog_invalidation", ["catalog_generation_invalidation"]],
  ["thread/started", "ThreadStartedNotification", "thread_history", "creation_correlation", ["creation_correlation", "native_identity_bounds", "owned_scope"], "experimental"],
];

export const refinementDomains = {
  initialization: ["release_guard", "owned_scope", "native_text_bounds"],
  thread_history: ["native_identity_bounds", "history_bounds", "consumed_projection"],
  live_turns: ["route_identity", "collection_bounds", "completion_semantics"],
  interactions: ["route_identity", "supported_decisions", "answer_data_properties"],
  actions: ["outbound_subset", "safe_integer_bounds", "postcondition_semantics"],
};
