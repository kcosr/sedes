import {
  decodeCodexServerNotificationParams,
  defineCodexAppServerMethod,
  type OfficialCodexClientRequestParams,
  type OfficialCodexClientRequestResult,
  type OfficialCodexServerNotificationParams,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  CODEX_GOAL_OBJECTIVE_MAX_SCALARS,
  CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES,
  type CodexGoalStateV1,
  type CodexGoalStatusV1,
  validateNormalizedCodexGoalObjective,
} from "./codex-goal-feature.js";

type GoalGetParams = OfficialCodexClientRequestParams<"thread/goal/get">;
type GoalGetResponse = OfficialCodexClientRequestResult<"thread/goal/get">;
type OfficialGoalSetParams =
  OfficialCodexClientRequestParams<"thread/goal/set">;
type GoalSetResponse = OfficialCodexClientRequestResult<"thread/goal/set">;
type GoalClearParams = OfficialCodexClientRequestParams<"thread/goal/clear">;
type GoalClearResponse = OfficialCodexClientRequestResult<"thread/goal/clear">;

export type CodexNativeThreadGoal = GoalSetResponse["goal"];
export type CodexNativeGoalStatus = CodexNativeThreadGoal["status"];
export type CodexThreadGoalSetParams = {
  threadId: string;
  objective?: string | null;
  status?: CodexNativeGoalStatus | null;
};

function assertExactKeys(
  value: object,
  expected: readonly string[],
  code: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new Error(code);
  }
}

function assertNativeThreadId(value: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new Error("codex_goal_thread_id_invalid");
  }
}

function assertSafeCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`codex_goal_${field}_invalid`);
  }
}

function refineNativeGoal(goal: CodexNativeThreadGoal): CodexNativeThreadGoal {
  assertExactKeys(
    goal,
    [
      "threadId",
      "objective",
      "status",
      "tokenBudget",
      "tokensUsed",
      "timeUsedSeconds",
      "createdAt",
      "updatedAt",
    ],
    "codex_goal_fields_invalid",
  );
  assertNativeThreadId(goal.threadId);
  const validated = validateNormalizedCodexGoalObjective(goal.objective);
  if (!validated.ok || goal.objective !== goal.objective.trim()) {
    throw new Error("codex_goal_objective_invalid");
  }
  if (goal.tokenBudget !== null) {
    assertSafeCount(goal.tokenBudget, "token_budget");
  }
  assertSafeCount(goal.tokensUsed, "tokens_used");
  assertSafeCount(goal.timeUsedSeconds, "time_used_seconds");
  assertSafeCount(goal.createdAt, "created_at");
  assertSafeCount(goal.updatedAt, "updated_at");
  return goal;
}

function refineGoalGetParams(value: GoalGetParams): GoalGetParams {
  assertExactKeys(value, ["threadId"], "codex_goal_get_params_fields_invalid");
  assertNativeThreadId(value.threadId);
  return value;
}

function refineGoalSetParams(
  value: CodexThreadGoalSetParams,
): OfficialGoalSetParams {
  assertNativeThreadId(value.threadId);
  if (Object.hasOwn(value, "tokenBudget")) {
    throw new Error("codex_goal_token_budget_write_unsupported");
  }
  assertExactKeys(
    value,
    [
      "threadId",
      ...(value.objective === undefined ? [] : ["objective"]),
      ...(value.status === undefined ? [] : ["status"]),
    ],
    "codex_goal_set_params_fields_invalid",
  );
  if (value.objective === undefined && value.status === undefined) {
    throw new Error("codex_goal_set_requires_change");
  }
  if (typeof value.objective === "string") {
    const validated = validateNormalizedCodexGoalObjective(value.objective);
    if (!validated.ok) {
      throw new Error("codex_goal_objective_invalid");
    }
  }
  return value;
}

function refineGoalClearParams(value: GoalClearParams): GoalClearParams {
  assertExactKeys(
    value,
    ["threadId"],
    "codex_goal_clear_params_fields_invalid",
  );
  assertNativeThreadId(value.threadId);
  return value;
}

function refineGoalGetResponse(value: GoalGetResponse): GoalGetResponse {
  assertExactKeys(value, ["goal"], "codex_goal_get_response_fields_invalid");
  if (value.goal !== null) {
    refineNativeGoal(value.goal);
  }
  return value;
}

function refineGoalSetResponse(value: GoalSetResponse): GoalSetResponse {
  assertExactKeys(value, ["goal"], "codex_goal_set_response_fields_invalid");
  refineNativeGoal(value.goal);
  return value;
}

export const codexThreadGoalGetMethod = defineCodexAppServerMethod({
  method: "thread/goal/get",
  refineParams: refineGoalGetParams,
  refineResult: refineGoalGetResponse,
});
export const codexThreadGoalSetMethod = defineCodexAppServerMethod({
  method: "thread/goal/set",
  refineParams: refineGoalSetParams,
  refineResult: refineGoalSetResponse,
});
export const codexThreadGoalClearMethod = defineCodexAppServerMethod({
  method: "thread/goal/clear",
  refineParams: refineGoalClearParams,
  refineResult: (value): GoalClearResponse => {
    assertExactKeys(
      value,
      ["cleared"],
      "codex_goal_clear_response_fields_invalid",
    );
    return value;
  },
});

export function decodeCodexThreadGoalUpdatedNotification(
  value: unknown,
): OfficialCodexServerNotificationParams<"thread/goal/updated"> {
  return refineCodexThreadGoalUpdatedNotification(
    decodeCodexServerNotificationParams("thread/goal/updated", value),
  );
}

export function refineCodexThreadGoalUpdatedNotification(
  notification: OfficialCodexServerNotificationParams<"thread/goal/updated">,
): OfficialCodexServerNotificationParams<"thread/goal/updated"> {
  assertExactKeys(
    notification,
    ["threadId", "turnId", "goal"],
    "codex_goal_updated_notification_fields_invalid",
  );
  assertNativeThreadId(notification.threadId);
  if (notification.turnId !== null) {
    assertNativeThreadId(notification.turnId);
  }
  refineNativeGoal(notification.goal);
  return notification;
}

export function decodeCodexThreadGoalClearedNotification(
  value: unknown,
): OfficialCodexServerNotificationParams<"thread/goal/cleared"> {
  return refineCodexThreadGoalClearedNotification(
    decodeCodexServerNotificationParams("thread/goal/cleared", value),
  );
}

export function refineCodexThreadGoalClearedNotification(
  notification: OfficialCodexServerNotificationParams<"thread/goal/cleared">,
): OfficialCodexServerNotificationParams<"thread/goal/cleared"> {
  assertExactKeys(
    notification,
    ["threadId"],
    "codex_goal_cleared_notification_fields_invalid",
  );
  assertNativeThreadId(notification.threadId);
  return notification;
}

const NATIVE_TO_BROWSER_STATUS: Readonly<
  Record<CodexNativeGoalStatus, CodexGoalStatusV1>
> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
};

const BROWSER_TO_NATIVE_STATUS: Readonly<
  Record<CodexGoalStatusV1, CodexNativeGoalStatus>
> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usage_limited: "usageLimited",
  budget_limited: "budgetLimited",
  complete: "complete",
};

export function projectNativeGoalStatus(
  status: CodexNativeGoalStatus,
): CodexGoalStatusV1 {
  return NATIVE_TO_BROWSER_STATUS[status];
}

export function nativeGoalStatusFromBrowser(
  status: CodexGoalStatusV1,
): CodexNativeGoalStatus {
  return BROWSER_TO_NATIVE_STATUS[status];
}

/**
 * Validate a complete native goal and project the closed browser state.
 * Binding mismatch, unknown status, unsafe numbers, or an oversized objective
 * fails closed after the exact release validator accepts the provider shape.
 */
export function projectCodexNativeGoal(input: {
  readonly nativeGoal: CodexNativeThreadGoal;
  readonly expectedThreadId: string;
}): CodexGoalStateV1 {
  return projectValidatedNativeGoal(input.nativeGoal, input.expectedThreadId);
}

function projectValidatedNativeGoal(
  goal: CodexNativeThreadGoal,
  expectedThreadId: string,
): CodexGoalStateV1 {
  if (goal.threadId !== expectedThreadId) {
    throw new Error("codex_goal_thread_binding_mismatch");
  }
  // Re-check bounds after parse for explicit projection failures.
  const validated = validateNormalizedCodexGoalObjective(goal.objective);
  if (!validated.ok) {
    throw new Error("codex_goal_objective_invalid");
  }
  if ([...goal.objective].length > CODEX_GOAL_OBJECTIVE_MAX_SCALARS) {
    throw new Error("codex_goal_objective_too_long");
  }
  if (
    new TextEncoder().encode(goal.objective).byteLength >
    CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES
  ) {
    throw new Error("codex_goal_objective_too_large");
  }
  return {
    state: "set",
    objective: goal.objective,
    status: projectNativeGoalStatus(goal.status),
  };
}

export function projectCodexGoalGetResponse(input: {
  readonly response: GoalGetResponse;
  readonly expectedThreadId: string;
}): CodexGoalStateV1 {
  if (input.response.goal === null) {
    return { state: "unset" };
  }
  return projectValidatedNativeGoal(
    input.response.goal,
    input.expectedThreadId,
  );
}

export function encodeCodexGoalSetParams(input: {
  readonly threadId: string;
  readonly objective?: string;
  readonly status?: Extract<CodexGoalStatusV1, "active" | "paused">;
}): CodexThreadGoalSetParams {
  const params: CodexThreadGoalSetParams = {
    threadId: input.threadId,
  };
  if (input.objective !== undefined) {
    const validated = validateNormalizedCodexGoalObjective(input.objective);
    if (!validated.ok) {
      throw new Error("codex_goal_objective_invalid");
    }
    params.objective = input.objective;
  }
  if (input.status !== undefined) {
    params.status = input.status === "active" ? "active" : "paused";
  }
  codexThreadGoalSetMethod.encodeParams(params);
  return params;
}
