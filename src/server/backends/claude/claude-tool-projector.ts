import { isAbsolute } from "node:path";
import type { BackendItem } from "../../../shared/protocol/backend.js";
import { PAYLOAD_LIMITS } from "../../../shared/protocol/payload.js";
import {
  boundDisplayText,
  boundText,
  boundToolResult,
  boundValue,
  DEFAULT_PAYLOAD_LIMITS,
} from "../../conversations/payload-policy.js";

const MAXIMUM_FILE_CHANGE_TEXT_BYTES = PAYLOAD_LIMITS.textCharacters;
const MAXIMUM_EDIT_SOURCE_BYTES = MAXIMUM_FILE_CHANGE_TEXT_BYTES / 2;

type WithoutItemBase<Item> = Item extends BackendItem
  ? Omit<Item, "backendItemId" | "backendTurnId" | "status" | "sourceOrder">
  : never;
export type ClaudeProjectedTool = WithoutItemBase<BackendItem>;

/**
 * Project only semantics carried by the durable Claude session transcript.
 * Unknown or incomplete built-in shapes deliberately retain the generic tool
 * presentation so a provider change cannot manufacture stronger evidence.
 */
export function projectClaudeTool(
  name: string,
  input: unknown,
): ClaudeProjectedTool {
  if (!isPlainRecord(input)) return genericTool(name, input);

  switch (name) {
    case "Bash": {
      const command = ownString(input, "command");
      if (command === undefined || command.length === 0) {
        return genericTool(name, input, "computation");
      }
      const timeoutCandidate = ownPositiveSafeInteger(input, "timeout");
      const timeout =
        timeoutCandidate !== undefined && timeoutCandidate <= 600_000
          ? timeoutCandidate
          : undefined;
      return {
        semanticKind: "command",
        phase: "preflight_or_executing",
        command: boundDisplayText(command),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      };
    }
    case "Read": {
      const path = safeAbsolutePath(ownString(input, "file_path"));
      if (path === undefined) return genericTool(name, input, "filesystem");
      const offset = ownOptionalPositiveSafeInteger(input, "offset");
      const limit = ownOptionalPositiveSafeInteger(input, "limit");
      if (offset === null || limit === null) {
        return genericTool(name, input, "filesystem");
      }
      const startLine = offset ?? 1;
      const endLine =
        limit === undefined
          ? undefined
          : Math.min(Number.MAX_SAFE_INTEGER, startLine + limit - 1);
      return {
        semanticKind: "file_read",
        phase: "preflight_or_executing",
        path: boundDisplayText(path),
        ...(endLine === undefined ? {} : { range: { startLine, endLine } }),
      };
    }
    case "Write":
    case "Edit": {
      return (
        claudeFileChange(name, input) ?? genericTool(name, input, "filesystem")
      );
    }
    case "NotebookEdit": {
      const path = safeAbsolutePath(ownString(input, "notebook_path"));
      const source = ownString(input, "new_source");
      const mode = ownString(input, "edit_mode");
      if (
        path === undefined ||
        source === undefined ||
        (mode !== undefined &&
          mode !== "replace" &&
          mode !== "insert" &&
          mode !== "delete")
      ) {
        return genericTool(name, input, "filesystem");
      }
      return {
        semanticKind: "file_change",
        phase: "preflight_or_executing",
        operation: "edit",
        effect: "proposed",
        path: boundDisplayText(path),
        // This is cell source, not whole-notebook content; leave line counts
        // and replacement/diff absent rather than overstating its meaning.
        ...(mode === "delete"
          ? {}
          : {
              contentPreview: boundText(source, MAXIMUM_FILE_CHANGE_TEXT_BYTES),
            }),
      };
    }
    case "WebSearch": {
      const query = ownString(input, "query");
      if (query === undefined || query.length === 0) {
        return genericTool(name, input, "search");
      }
      return {
        semanticKind: "web_search",
        phase: "preflight_or_executing",
        query: boundDisplayText(query),
      };
    }
    case "WebFetch":
      return genericTool(name, input, "network");
    case "Agent":
    case "Task": {
      const description = ownString(input, "description");
      const prompt = ownString(input, "prompt");
      if (
        description === undefined ||
        description.length === 0 ||
        prompt === undefined ||
        prompt.length === 0
      ) {
        return genericTool(name, input, "computation");
      }
      const label =
        ownNonemptyString(input, "name") ??
        ownNonemptyString(input, "subagent_type");
      return {
        semanticKind: "collaboration",
        action: "spawn",
        ...(label === undefined ? {} : { agentLabel: boundDisplayText(label) }),
        summary: boundText(`Started subagent · ${description}`),
      };
    }
    default: {
      const mcp = parseMcpToolName(name);
      return mcp === undefined
        ? genericTool(name, input)
        : {
            semanticKind: "mcp",
            phase: "preflight_or_executing",
            server: boundDisplayText(mcp.server),
            toolName: boundDisplayText(mcp.toolName),
            arguments: boundValue(input),
          };
    }
  }
}

export function completeClaudeTool(
  existing: BackendItem,
  content: unknown,
  isError: boolean,
): BackendItem {
  const status = isError ? ("failed" as const) : ("completed" as const);
  const result = boundToolResult(
    Array.isArray(content) ? { content } : content,
    isError,
  );
  switch (existing.semanticKind) {
    case "tool":
      return { ...existing, status, phase: status, result };
    case "command": {
      const output = boundedResultText(result);
      return {
        ...existing,
        status,
        phase: status,
        ...(output === undefined ? {} : { output }),
      };
    }
    case "file_read": {
      const contentPreview = isError ? undefined : boundedResultText(result);
      return {
        ...existing,
        status,
        phase: status,
        ...(contentPreview === undefined ? {} : { contentPreview }),
      };
    }
    case "file_change":
      return {
        ...existing,
        status,
        phase: status,
        effect: isError ? "unknown" : "applied",
      };
    case "mcp":
    case "web_search":
      return { ...existing, status, phase: status, result };
    case "collaboration":
      // The tool result settles the spawning call. In particular, a successful
      // async acknowledgement does not prove that the child has finished.
      // Preserve the launch row; task_notification provides its own bookend.
      return {
        ...existing,
        status,
        action: "spawn",
        ...(isError ? { summary: boundText("Subagent launch failed"), error: {
          category: "internal" as const,
          message: boundDisplayText("Claude subagent launch failed."),
          code: "claude_subagent_launch_failed",
        } } : {}),
      };
    default:
      throw new Error("claude_tool_projection_kind_invalid");
  }
}

export function settleInterruptedClaudeTool(
  item: BackendItem,
  status: "interrupted" | "failed",
  completedAt: string,
): BackendItem {
  switch (item.semanticKind) {
    case "tool":
    case "command":
    case "file_read":
    case "file_change":
    case "mcp":
    case "web_search":
      return {
        ...item,
        status,
        phase: status,
        ...(item.semanticKind === "file_change" ? { effect: "unknown" } : {}),
        completedAt,
      };
    case "collaboration":
      return { ...item, status, action: "status", completedAt };
    default:
      return { ...item, status, completedAt };
  }
}

function genericTool(
  name: string,
  input: unknown,
  category = toolCategory(name),
): Extract<ClaudeProjectedTool, { semanticKind: "tool" }> {
  return {
    semanticKind: "tool",
    phase: "preflight_or_executing",
    toolName: boundDisplayText(name),
    title: boundDisplayText(name),
    category,
    arguments: boundValue(input),
  };
}

function claudeFileChange(
  name: "Write" | "Edit",
  input: Readonly<Record<string, unknown>>,
): Extract<ClaudeProjectedTool, { semanticKind: "file_change" }> | undefined {
  const path = safeAbsolutePath(ownString(input, "file_path"));
  if (path === undefined) return undefined;

  if (name === "Write") {
    const content = ownString(input, "content");
    if (content === undefined) return undefined;
    return {
      semanticKind: "file_change",
      phase: "preflight_or_executing",
      operation: "write",
      effect: "proposed",
      path: boundDisplayText(path),
      contentPreview: boundText(content, MAXIMUM_FILE_CHANGE_TEXT_BYTES),
      additions: countWholeFileLines(content),
      deletions: 0,
    };
  }

  const oldString = ownString(input, "old_string");
  const newString = ownString(input, "new_string");
  const replaceAll = ownOptionalBoolean(input, "replace_all");
  if (
    oldString === undefined ||
    newString === undefined ||
    oldString.length === 0 ||
    oldString === newString ||
    replaceAll === undefined ||
    replaceAll ||
    Buffer.byteLength(oldString, "utf8") +
      Buffer.byteLength(newString, "utf8") >
      MAXIMUM_EDIT_SOURCE_BYTES
  ) {
    return undefined;
  }
  return {
    semanticKind: "file_change",
    phase: "preflight_or_executing",
    operation: "edit",
    effect: "proposed",
    path: boundDisplayText(path),
    replacement: {
      before: boundText(oldString, MAXIMUM_FILE_CHANGE_TEXT_BYTES),
      after: boundText(newString, MAXIMUM_FILE_CHANGE_TEXT_BYTES),
    },
  };
}

function boundedResultText(
  result: ReturnType<typeof boundToolResult>,
): ReturnType<typeof boundText> | undefined {
  const text = result.content
    .filter((part) => part.kind === "text")
    .map((part) => part.value.text)
    .join("");
  return text.length === 0
    ? undefined
    : boundText(text, DEFAULT_PAYLOAD_LIMITS.maximumResultBytes);
}

function safeAbsolutePath(path: string | undefined): string | undefined {
  return path !== undefined &&
    path.length > 0 &&
    isAbsolute(path) &&
    path !== "/dev/null" &&
    path.trim() === path &&
    !/[\0-\x1f\x7f]/u.test(path) &&
    Buffer.byteLength(path, "utf8") <=
      DEFAULT_PAYLOAD_LIMITS.maximumDisplayTextBytes
    ? path
    : undefined;
}

function parseMcpToolName(
  name: string,
): { readonly server: string; readonly toolName: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const serverEnd = name.indexOf("__", 5);
  if (serverEnd < 6) return undefined;
  const server = name.slice(5, serverEnd);
  const toolName = name.slice(serverEnd + 2);
  return server.length > 0 &&
    toolName.length > 0 &&
    Buffer.byteLength(server, "utf8") <=
      DEFAULT_PAYLOAD_LIMITS.maximumDisplayTextBytes &&
    Buffer.byteLength(toolName, "utf8") <=
      DEFAULT_PAYLOAD_LIMITS.maximumDisplayTextBytes
    ? { server, toolName }
    : undefined;
}

function countWholeFileLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = content.endsWith("\n") ? 0 : 1;
  for (const character of content) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function ownNonemptyString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const candidate = ownString(value, key);
  return candidate === undefined || candidate.length === 0
    ? undefined
    : candidate;
}

function ownOptionalBoolean(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return false;
  return "value" in descriptor && typeof descriptor.value === "boolean"
    ? descriptor.value
    : undefined;
}

function ownPositiveSafeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  const candidate =
    descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
    ? candidate
    : undefined;
}

/** `undefined` means absent while `null` means present but invalid. */
function ownOptionalPositiveSafeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | null | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) return null;
  const candidate = descriptor.value;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
    ? candidate
    : null;
}

function toolCategory(
  name: string,
): "search" | "filesystem" | "network" | "computation" | "other" {
  const normalized = name.slice(0, 4_096).toLowerCase();
  if (/search|grep|glob|find/u.test(normalized)) return "search";
  if (/read|write|edit|file|directory|notebook/u.test(normalized))
    return "filesystem";
  if (/web|fetch|http|browser/u.test(normalized)) return "network";
  if (/bash|shell|command|python|execute/u.test(normalized))
    return "computation";
  return "other";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
