import type { BackendItem } from "../../../shared/protocol/backend.js";
import type {
  AgentToolInvocationCorrelation,
  BoundedToolResult,
  OperationPhase,
} from "../../../shared/protocol/payload.js";
import {
  boundDisplayText,
  boundText,
  boundTextTail,
  boundToolResult,
  boundValue,
  countUnifiedDiff,
  DEFAULT_PAYLOAD_LIMITS,
  type PayloadLimits,
} from "../../conversations/payload-policy.js";
import type { PiToolIdentity } from "./pi-tool-identities.js";

const textEncoder = new TextEncoder();

export interface PiToolMapperBase {
  readonly backendItemId: string;
  readonly backendTurnId: string;
  readonly sourceOrder: number;
  readonly status: BackendItem["status"];
  readonly phase: OperationPhase;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface PiToolMapperInput extends PiToolMapperBase {
  readonly identity: PiToolIdentity;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly agentToolInvocation?: AgentToolInvocationCorrelation;
}

function base(
  input: PiToolMapperInput,
): Pick<
  BackendItem,
  | "backendItemId"
  | "backendTurnId"
  | "status"
  | "sourceOrder"
  | "startedAt"
  | "completedAt"
> {
  return {
    backendItemId: input.backendItemId,
    backendTurnId: input.backendTurnId,
    status: input.status,
    sourceOrder: input.sourceOrder,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
}

type BackendCommandItem = Extract<BackendItem, { semanticKind: "command" }>;
type BackendFileReadItem = Extract<BackendItem, { semanticKind: "file_read" }>;
type BackendFileChangeItem = Extract<
  BackendItem,
  { semanticKind: "file_change" }
>;
type BackendToolItem = Extract<BackendItem, { semanticKind: "tool" }>;
type BackendMcpItem = Extract<BackendItem, { semanticKind: "mcp" }>;
type BackendWebSearchItem = Extract<
  BackendItem,
  { semanticKind: "web_search" }
>;

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function resultText(
  result: unknown,
  maximumBytes: number,
  maximumParts: number,
  retainTail = false,
): ReturnType<typeof boundText> | undefined {
  const content = own(result, "content");
  if (!Array.isArray(content)) {
    if (typeof result !== "string") return undefined;
    return retainTail
      ? boundTextTail(result, maximumBytes)
      : boundText(result, maximumBytes);
  }
  const selected: string[] = [];
  let remainingBytes = maximumBytes;
  let byteTruncated = false;
  let examined = 0;
  const indexes = retainTail
    ? Array.from(
        { length: Math.min(content.length, maximumParts) },
        (_, offset) => content.length - 1 - offset,
      )
    : Array.from(
        { length: Math.min(content.length, maximumParts) },
        (_, index) => index,
      );
  for (const index of indexes) {
    examined += 1;
    const descriptor = Object.getOwnPropertyDescriptor(content, String(index));
    const part =
      descriptor && "value" in descriptor ? descriptor.value : undefined;
    const text = own(part, "text");
    if (own(part, "type") !== "text" || typeof text !== "string") continue;
    const bounded = retainTail
      ? boundTextTail(text, remainingBytes)
      : boundText(text, remainingBytes);
    if (retainTail) selected.unshift(bounded.text);
    else selected.push(bounded.text);
    remainingBytes = Math.max(
      0,
      remainingBytes - textEncoder.encode(bounded.text).byteLength,
    );
    byteTruncated ||= bounded.truncation !== undefined;
    if (remainingBytes === 0) break;
  }
  const omittedParts =
    content.length > indexes.length || examined < indexes.length;
  const truncated = byteTruncated || omittedParts;
  if (selected.length === 0) return undefined;
  // Every selected chunk was bounded against the remaining shared budget, so
  // this join cannot exceed maximumBytes.
  const text = selected.join("");
  return {
    text,
    ...(truncated
      ? {
          truncation: {
            truncated: true as const,
            retainedBytes: textEncoder.encode(text).byteLength,
            reason:
              byteTruncated || remainingBytes === 0
                ? ("byte_limit" as const)
                : ("entry_limit" as const),
          },
        }
      : {}),
  };
}

function mappedResult(
  input: PiToolMapperInput,
  limits: PayloadLimits,
): BoundedToolResult | undefined {
  return input.result === undefined
    ? undefined
    : boundToolResult(input.result, input.isError ?? false, limits);
}

function command(
  input: PiToolMapperInput,
  limits: PayloadLimits,
): BackendCommandItem {
  const timeoutSeconds = finiteNonnegative(own(input.arguments, "timeout"));
  const output = resultText(
    input.result,
    limits.maximumResultBytes,
    limits.maximumArrayEntries,
    true,
  );
  return {
    ...base(input),
    semanticKind: "command",
    phase: input.phase,
    command: boundDisplayText(own(input.arguments, "command"), limits),
    ...(timeoutSeconds === undefined
      ? {}
      : { timeoutMs: Math.floor(timeoutSeconds * 1_000) }),
    ...(output === undefined
      ? {}
      : {
          output,
        }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

function fileRead(
  input: PiToolMapperInput,
  limits: PayloadLimits,
): BackendFileReadItem {
  const offset = positiveInteger(own(input.arguments, "offset"));
  const limit = positiveInteger(own(input.arguments, "limit"));
  const preview = resultText(
    input.result,
    limits.maximumResultBytes,
    limits.maximumArrayEntries,
  );
  return {
    ...base(input),
    semanticKind: "file_read",
    phase: input.phase,
    path: boundDisplayText(own(input.arguments, "path"), limits),
    ...(offset || limit
      ? {
          range: {
            startLine: offset ?? 1,
            endLine: (offset ?? 1) + Math.max(1, limit ?? 1) - 1,
          },
        }
      : {}),
    ...(preview === undefined
      ? {}
      : {
          contentPreview: preview,
        }),
  };
}

function fileChange(
  input: PiToolMapperInput,
  operation: "write" | "edit",
  limits: PayloadLimits,
): BackendFileChangeItem {
  const details = own(input.result, "details");
  const diff =
    operation === "edit" && typeof own(details, "patch") === "string"
      ? (own(details, "patch") as string)
      : operation === "edit" && typeof own(details, "diff") === "string"
        ? (own(details, "diff") as string)
        : undefined;
  const boundedDiff = diff
    ? boundText(diff, limits.maximumResultBytes)
    : undefined;
  const content =
    operation === "write" && typeof own(input.arguments, "content") === "string"
      ? (own(input.arguments, "content") as string)
      : undefined;
  const counts =
    content !== undefined
      ? { additions: countWholeFileLines(content), deletions: 0 }
      : boundedDiff
        ? countUnifiedDiff(boundedDiff.text)
        : undefined;
  const terminal =
    input.phase === "completed" ||
    input.phase === "failed" ||
    input.phase === "interrupted";
  return {
    ...base(input),
    semanticKind: "file_change",
    phase: input.phase,
    operation,
    effect:
      input.phase === "completed"
        ? "applied"
        : terminal
          ? "unknown"
          : "proposed",
    path: boundDisplayText(own(input.arguments, "path"), limits),
    ...(boundedDiff ? { diff: { text: boundedDiff } } : {}),
    ...(content !== undefined
      ? {
          contentPreview: boundText(content, limits.maximumResultBytes),
        }
      : {}),
    ...(counts
      ? { additions: counts.additions, deletions: counts.deletions }
      : {}),
  };
}

function countWholeFileLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = content.endsWith("\n") ? 0 : 1;
  for (const character of content) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function generic(
  input: PiToolMapperInput,
  limits: PayloadLimits,
  category: BackendToolItem["category"] = "other",
): BackendToolItem {
  const result = mappedResult(input, limits);
  const authenticatedAgentToolInvocation =
    input.agentToolInvocation &&
    ((input.identity.origin === "sedes_agent_tool" &&
      input.agentToolInvocation.toolId === input.identity.agentToolId &&
      input.agentToolInvocation.schemaVersion ===
        input.identity.agentToolSchemaVersion) ||
      (input.identity.origin === "sedes_agent_tool_gateway" &&
        (input.identity.registrationId.endsWith(":sedes_read") ||
          input.identity.registrationId.endsWith(":sedes_act"))))
      ? input.agentToolInvocation
      : undefined;
  const displayName =
    input.identity.origin === "sedes_agent_tool_gateway" &&
    authenticatedAgentToolInvocation
      ? authenticatedAgentToolInvocation.toolId
      : input.identity.displayName;
  return {
    ...base(input),
    semanticKind: "tool",
    phase: input.phase,
    toolName: boundDisplayText(displayName, limits),
    title: boundDisplayText(displayName, limits),
    category,
    ...(authenticatedAgentToolInvocation
      ? { agentToolInvocation: authenticatedAgentToolInvocation }
      : {}),
    ...(input.arguments === undefined
      ? {}
      : {
          arguments: boundValue(input.arguments, {
            limits,
            maximumBytes: limits.maximumArgumentBytes,
          }),
        }),
    ...(result ? { result } : {}),
  };
}

function mcp(input: PiToolMapperInput, limits: PayloadLimits): BackendMcpItem {
  const result = mappedResult(input, limits);
  return {
    ...base(input),
    semanticKind: "mcp",
    phase: input.phase,
    server: boundDisplayText(input.identity.mcpServer ?? "MCP", limits),
    toolName: boundDisplayText(input.identity.displayName, limits),
    ...(input.arguments === undefined
      ? {}
      : {
          arguments: boundValue(input.arguments, {
            limits,
            maximumBytes: limits.maximumArgumentBytes,
          }),
        }),
    ...(result ? { result } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

function webSearch(
  input: PiToolMapperInput,
  limits: PayloadLimits,
): BackendWebSearchItem {
  const query = own(input.arguments, "query");
  const result = mappedResult(input, limits);
  return {
    ...base(input),
    semanticKind: "web_search",
    phase: input.phase,
    ...(typeof query === "string"
      ? { query: boundDisplayText(query, limits) }
      : {}),
    ...(result ? { result } : {}),
  };
}

export class PiToolSemanticMapperRegistry {
  constructor(readonly limits: PayloadLimits = DEFAULT_PAYLOAD_LIMITS) {}

  map(input: PiToolMapperInput): BackendItem {
    switch (input.identity.canonicalKind) {
      case "bash":
        return command(input, this.limits);
      case "read":
        return fileRead(input, this.limits);
      case "write":
        return fileChange(input, "write", this.limits);
      case "edit":
        return fileChange(input, "edit", this.limits);
      case "grep":
      case "find":
        return generic(input, this.limits, "search");
      case "ls":
        return generic(input, this.limits, "filesystem");
      case "mcp":
        return mcp(input, this.limits);
      case "web_search":
        return webSearch(input, this.limits);
      default:
        return generic(input, this.limits);
    }
  }
}
