import { projectCodexThread } from "./codex-c1-protocol.js";
import { codexJsonValueSchema } from "./codex-c2-protocol.js";
import {
  defineCodexAppServerMethod,
  type OfficialCodexClientRequestParams,
  type OfficialCodexClientRequestResult,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

// Preserve the established Zod `string().max(...)` semantics: JavaScript
// UTF-16 code units, not UTF-8 bytes or Unicode scalar values.
const MAX_NATIVE_ID_CODE_UNITS = 512;
const MAX_NATIVE_TEXT_CODE_UNITS = 7 * 1024 * 1024;

type OfficialThreadForkParams = OfficialCodexClientRequestParams<"thread/fork">;
type OfficialThreadForkResponse =
  OfficialCodexClientRequestResult<"thread/fork">;

const FORK_PARAM_KEYS = [
  "threadId",
  "lastTurnId",
  "model",
  "modelProvider",
  "serviceTier",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "config",
  "baseInstructions",
  "developerInstructions",
  "ephemeral",
  "threadSource",
  "excludeTurns",
] as const satisfies readonly (keyof OfficialThreadForkParams)[];
const FORK_PARAM_KEY_SET: ReadonlySet<string> = new Set(FORK_PARAM_KEYS);

/**
 * Sedes's outbound subset of the pinned `thread/fork` request. The official
 * release type owns every provider field; Sedes additionally excludes the
 * provider's nullable spelling for an inclusive turn boundary.
 */
export type CodexThreadForkParams = Omit<
  Pick<
    OfficialThreadForkParams,
    (typeof FORK_PARAM_KEYS)[number]
  >,
  "lastTurnId"
> & {
  readonly lastTurnId?: Exclude<
    OfficialThreadForkParams["lastTurnId"],
    null | undefined
  >;
};

/**
 * The pinned release type is the structural authority. The C1 projection
 * below remains a backend-owned bounded postcondition and projects only the
 * response fields consumed by Sedes.
 */
export type CodexThreadForkResponse = Pick<
  OfficialThreadForkResponse,
  | "thread"
  | "model"
  | "modelProvider"
  | "serviceTier"
  | "cwd"
  | "instructionSources"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "sandbox"
  | "reasoningEffort"
>;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function assertBoundedString(
  value: unknown,
  options: { readonly nullable: boolean; readonly nonempty: boolean },
): void {
  if (value === null && options.nullable) {
    return;
  }
  if (
    typeof value !== "string" ||
    (options.nonempty && value.length === 0) ||
    value.length > MAX_NATIVE_TEXT_CODE_UNITS
  ) {
    throw new Error("Codex C4 text is outside Sedes bounds.");
  }
}

function refineThreadForkParams(
  value: CodexThreadForkParams,
): OfficialThreadForkParams {
  if (!isRecord(value)) {
    throw new Error("Codex thread/fork parameters must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!FORK_PARAM_KEY_SET.has(key)) {
      throw new Error("Codex thread/fork parameters contain an unsupported field.");
    }
  }

  assertBoundedString(value.threadId, { nullable: false, nonempty: true });
  if (value.threadId.length > MAX_NATIVE_ID_CODE_UNITS) {
    throw new Error("Codex thread/fork threadId is outside Sedes bounds.");
  }
  if (value.lastTurnId !== undefined) {
    assertBoundedString(value.lastTurnId, { nullable: false, nonempty: true });
    if (value.lastTurnId.length > MAX_NATIVE_ID_CODE_UNITS) {
      throw new Error("Codex thread/fork lastTurnId is outside Sedes bounds.");
    }
  }
  if (value.excludeTurns !== undefined && value.excludeTurns !== true) {
    throw new Error("Codex thread/fork must exclude response turns.");
  }

  for (const key of [
    "model",
    "modelProvider",
    "serviceTier",
    "cwd",
    "baseInstructions",
    "developerInstructions",
  ] as const) {
    const candidate = value[key];
    if (candidate !== undefined) {
      assertBoundedString(candidate, { nullable: true, nonempty: false });
    }
  }
  if (value.threadSource !== undefined && value.threadSource !== null) {
    assertBoundedString(value.threadSource, { nullable: false, nonempty: true });
    if (value.threadSource.length > MAX_NATIVE_ID_CODE_UNITS) {
      throw new Error("Codex thread/fork threadSource is outside Sedes bounds.");
    }
  }
  refineApprovalPolicy(value.approvalPolicy);
  if (value.config !== undefined && value.config !== null) {
    codexJsonValueSchema.parse(value.config);
  }

  return value;
}

function refineApprovalPolicy(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  assertExactKeys(value, ["granular"], "approvalPolicy");
  assertExactKeys(
    value.granular,
    [
      "sandbox_approval",
      "rules",
      "skill_approval",
      "request_permissions",
      "mcp_elicitations",
    ],
    "approvalPolicy.granular",
  );
}

function refineForkSettings(value: OfficialThreadForkResponse): void {
  for (const candidate of [
    value.model,
    value.modelProvider,
    value.serviceTier,
    value.cwd,
    value.reasoningEffort,
  ]) {
    assertBoundedString(candidate, { nullable: true, nonempty: false });
  }
  if (value.instructionSources.length > 1_000) {
    throw new Error("Codex fork returned too many instruction sources.");
  }
  for (const source of value.instructionSources) {
    assertBoundedString(source, { nullable: false, nonempty: false });
  }
  refineApprovalPolicy(value.approvalPolicy);
  assertExactKeys(
    value.sandbox,
    value.sandbox.type === "dangerFullAccess"
      ? ["type"]
      : value.sandbox.type === "workspaceWrite"
        ? [
            "type",
            "writableRoots",
            "networkAccess",
            "excludeTmpdirEnvVar",
            "excludeSlashTmp",
          ]
        : ["type", "networkAccess"],
    "sandbox",
  );
  if (value.sandbox.type === "workspaceWrite") {
    if (value.sandbox.writableRoots.length > 1_000) {
      throw new Error("Codex fork returned too many writable roots.");
    }
    for (const root of value.sandbox.writableRoots) {
      assertBoundedString(root, { nullable: false, nonempty: false });
    }
  }
}

function refineThreadForkResponse(
  value: OfficialThreadForkResponse,
): CodexThreadForkResponse {
  refineForkSettings(value);
  return {
    thread: projectCodexThread(value.thread),
    model: value.model,
    modelProvider: value.modelProvider,
    serviceTier: value.serviceTier,
    cwd: value.cwd,
    instructionSources: value.instructionSources,
    approvalPolicy: value.approvalPolicy,
    approvalsReviewer: value.approvalsReviewer,
    sandbox: value.sandbox,
    reasoningEffort: value.reasoningEffort,
  };
}

export const codexThreadForkMethod = defineCodexAppServerMethod({
  method: "thread/fork",
  refineParams: refineThreadForkParams,
  refineResult: refineThreadForkResponse,
});
