import type { BackendItem } from "../../../shared/protocol/backend.js";
import {
  boundDisplayText,
  boundText,
  boundToolResult,
  boundValue,
} from "../../conversations/payload-policy.js";
import type { GrokHistoryToolPatch } from "./grok-history-projector.js";
import { inspectGrokGeneratedImageOutput } from "./grok-generated-image.js";
import {
  inspectDecodedGrokToolNormalization,
  type GrokCandidateToolDisposition,
  type GrokCanonicalToolMetadata,
  type GrokRawToolOutputVariant,
} from "./grok-tool-normalization.js";

export interface GrokMutableToolBlock {
  readonly kind: "tool";
  readonly backendItemId: string;
  readonly sourceOrder: number;
  readonly toolCallId: string;
  title?: string;
  name?: string;
  toolKind?:
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "switch_mode"
    | "other";
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: GrokHistoryToolPatch["content"];
  locations?: GrokHistoryToolPatch["locations"];
  rawInput?: unknown;
  rawOutput?: unknown;
  canonicalToolMetadata?: GrokCanonicalToolMetadata;
  rawOutputVariant?: GrokRawToolOutputVariant;
  semanticDisposition?: GrokCandidateToolDisposition;
}

export class GrokToolProjectionError extends Error {
  constructor() {
    super("grok_tool_projection_invalid");
    this.name = "GrokToolProjectionError";
  }
}

export function createGrokToolBlock(
  backendItemId: string,
  sourceOrder: number,
  toolCallId: string,
  patch: GrokHistoryToolPatch,
): GrokMutableToolBlock {
  const block: GrokMutableToolBlock = {
    kind: "tool",
    backendItemId,
    sourceOrder,
    toolCallId,
  };
  applyGrokToolPatch(block, patch);
  return block;
}

export function applyGrokToolPatch(
  block: GrokMutableToolBlock,
  patch: GrokHistoryToolPatch,
): void {
  const previousStatus = block.status;
  if (
    (previousStatus === "completed" || previousStatus === "failed") &&
    patch.status != null &&
    patch.status !== previousStatus
  ) {
    invalid();
  }
  if (patch.title != null) block.title = patch.title;
  if (patch.name != null) block.name = patch.name;
  if (patch.toolKind != null) block.toolKind = patch.toolKind;
  if (patch.status != null) {
    if (!toolStatusMayAdvance(previousStatus, patch.status)) invalid();
    block.status = patch.status;
  }
  if (patch.content != null) block.content = patch.content;
  if (patch.locations != null) block.locations = patch.locations;
  if (Object.hasOwn(patch, "rawInput")) block.rawInput = patch.rawInput;
  if (Object.hasOwn(patch, "rawOutput")) block.rawOutput = patch.rawOutput;
  if (patch.canonicalToolMetadata !== undefined) {
    block.canonicalToolMetadata = mergeCanonicalToolMetadata(
      block.canonicalToolMetadata,
      patch.canonicalToolMetadata,
    );
  }
  if (patch.rawOutputVariant !== undefined) {
    if (
      block.rawOutputVariant !== undefined &&
      block.rawOutputVariant !== patch.rawOutputVariant
    ) {
      invalid();
    }
    block.rawOutputVariant = patch.rawOutputVariant;
  }
  if (patch.semanticDisposition !== undefined) {
    if (
      block.semanticDisposition !== undefined &&
      block.semanticDisposition.semanticKind !==
        patch.semanticDisposition.semanticKind
    ) {
      invalid();
    }
    block.semanticDisposition ??= patch.semanticDisposition;
  }
  latchSemanticDisposition(block);
  if (
    block.semanticDisposition === undefined &&
    (block.status === "completed" || block.status === "failed")
  ) {
    block.semanticDisposition = genericDisposition(block);
  }
}

export function mergeGrokToolPatches(
  previous: GrokHistoryToolPatch,
  next: GrokHistoryToolPatch,
): GrokHistoryToolPatch {
  const state: GrokMutableToolBlock = {
    kind: "tool",
    backendItemId: "private-tool-state",
    sourceOrder: 0,
    toolCallId: "private-tool-state",
  };
  applyGrokToolPatch(state, previous);
  applyGrokToolPatch(state, next);
  return snapshotGrokToolPatch(state);
}

export function settleGrokToolPatchAtParentTerminal(
  patch: GrokHistoryToolPatch,
): GrokHistoryToolPatch {
  const state: GrokMutableToolBlock = {
    kind: "tool",
    backendItemId: "private-tool-state",
    sourceOrder: 0,
    toolCallId: "private-tool-state",
  };
  applyGrokToolPatch(state, patch);
  prepareGrokToolBlockForPublication(state, "parent_terminal");
  return snapshotGrokToolPatch(state);
}

function snapshotGrokToolPatch(
  state: GrokMutableToolBlock,
): GrokHistoryToolPatch {
  return Object.freeze({
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.name === undefined ? {} : { name: state.name }),
    ...(state.toolKind === undefined ? {} : { toolKind: state.toolKind }),
    ...(state.status === undefined ? {} : { status: state.status }),
    ...(state.content === undefined ? {} : { content: state.content }),
    ...(state.locations === undefined ? {} : { locations: state.locations }),
    ...(Object.hasOwn(state, "rawInput") ? { rawInput: state.rawInput } : {}),
    ...(Object.hasOwn(state, "rawOutput")
      ? { rawOutput: state.rawOutput }
      : {}),
    ...(state.canonicalToolMetadata === undefined
      ? {}
      : { canonicalToolMetadata: state.canonicalToolMetadata }),
    ...(state.rawOutputVariant === undefined
      ? {}
      : { rawOutputVariant: state.rawOutputVariant }),
    ...(state.semanticDisposition === undefined
      ? {}
      : { semanticDisposition: state.semanticDisposition }),
  });
}

export function prepareGrokToolBlockForPublication(
  block: GrokMutableToolBlock,
  turnStopReason: string | undefined,
): boolean {
  latchSemanticDisposition(block);
  if (block.semanticDisposition !== undefined) return true;
  if (
    block.status !== "completed" &&
    block.status !== "failed" &&
    turnStopReason === undefined
  ) {
    return false;
  }
  block.semanticDisposition = genericDisposition(block);
  return true;
}

export function projectGrokToolBlock(
  block: GrokMutableToolBlock,
  backendTurnId: string,
  turnStopReason: string | undefined,
  sourceOrder = block.sourceOrder,
): BackendItem {
  if (!prepareGrokToolBlockForPublication(block, turnStopReason)) invalid();
  const effectiveStatus: "completed" | "failed" | "streaming" =
    block.status === "completed"
      ? "completed"
      : block.status === "failed"
        ? "failed"
        : "streaming";
  const outputPresent =
    block.content !== undefined || Object.hasOwn(block, "rawOutput");
  const phase:
    | "arguments_streaming"
    | "arguments_complete"
    | "preflight_or_executing"
    | "result_streaming"
    | "completed"
    | "failed" =
    effectiveStatus === "completed" || effectiveStatus === "failed"
      ? effectiveStatus
      : block.status === undefined
        ? "arguments_streaming"
        : block.status === "pending"
          ? "arguments_complete"
          : outputPresent
            ? "result_streaming"
            : "preflight_or_executing";
  const disposition = block.semanticDisposition!;
  const title = block.title ?? block.name ?? "Grok tool";
  const toolName = block.name ?? block.title ?? "unknown";
  const argumentsValue = toolArguments(block);
  const generatedImage = inspectGrokGeneratedImageOutput(block);
  const result = outputPresent
    ? generatedImage
      ? boundToolResult("Grok generated an image.", false)
      : toolResult(block, effectiveStatus === "failed")
    : undefined;
  const base = {
    backendItemId: block.backendItemId,
    backendTurnId,
    status: effectiveStatus,
    sourceOrder,
    phase,
    ...(effectiveStatus === "failed"
      ? {
          error: {
            category: "internal" as const,
            message: boundDisplayText("Grok tool execution failed."),
            code: "grok_tool_failed",
          },
        }
      : {}),
  };
  switch (disposition.semanticKind) {
    case "command": {
      const bash = decodeGrokBashOutput(block.rawOutput);
      const commandOutput = toolContentText(block) ?? bash?.output;
      const cwd = disposition.cwd ?? bash?.currentDir;
      return {
        ...base,
        semanticKind: "command",
        command: boundDisplayText(disposition.command),
        ...(cwd === undefined ? {} : { cwd: boundDisplayText(cwd) }),
        ...(commandOutput === undefined
          ? {}
          : { output: boundText(commandOutput) }),
        ...(bash?.exitCode === undefined ? {} : { exitCode: bash.exitCode }),
      };
    }
    case "file_read": {
      const endLine =
        disposition.offset !== undefined &&
        disposition.limit !== undefined &&
        disposition.limit > 0
          ? disposition.offset + disposition.limit - 1
          : undefined;
      return {
        ...base,
        semanticKind: "file_read",
        path: boundDisplayText(disposition.path),
        ...(disposition.offset !== undefined &&
        disposition.offset > 0 &&
        endLine !== undefined &&
        Number.isSafeInteger(endLine)
          ? { range: { startLine: disposition.offset, endLine } }
          : {}),
        ...(toolContentText(block) === undefined
          ? {}
          : { contentPreview: boundText(toolContentText(block)!) }),
      };
    }
    case "file_change": {
      const content = fileChangeContentProjection(block, disposition);
      return {
        ...base,
        semanticKind: "file_change",
        operation: disposition.operation,
        effect:
          block.status === "completed"
            ? "applied"
            : block.status === "failed"
              ? "not_applied"
              : block.status === "pending" || block.status === "in_progress"
                ? "proposed"
                : "unknown",
        path: boundDisplayText(disposition.path),
        ...(disposition.destinationPath === undefined
          ? {}
          : { destinationPath: boundDisplayText(disposition.destinationPath) }),
        ...content,
      };
    }
    case "web_search":
      return {
        ...base,
        semanticKind: "web_search",
        ...(disposition.query === undefined
          ? {}
          : { query: boundDisplayText(disposition.query) }),
        ...(outputPresent
          ? {
              result: specializedToolResult(
                block,
                effectiveStatus === "failed",
                "WebSearch",
              ),
            }
          : {}),
      };
    case "mcp":
      return {
        ...base,
        semanticKind: "mcp",
        server: boundDisplayText(disposition.server),
        toolName: boundDisplayText(disposition.toolName),
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        ...(outputPresent
          ? {
              result: specializedToolResult(
                block,
                effectiveStatus === "failed",
                "MCP",
              ),
            }
          : {}),
      };
    case "tool":
      return {
        ...base,
        semanticKind: "tool",
        toolName: boundDisplayText(disposition.toolName ?? toolName),
        title: boundDisplayText(disposition.title ?? title),
        category: disposition.category,
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        ...(result === undefined ? {} : { result }),
      };
  }
}

function toolStatusMayAdvance(
  previous: GrokMutableToolBlock["status"],
  next: NonNullable<GrokMutableToolBlock["status"]>,
): boolean {
  if (previous === undefined || previous === next) return true;
  if (previous === "pending") return true;
  return next === "completed" || next === "failed";
}

function mergeCanonicalToolMetadata(
  previous: GrokCanonicalToolMetadata | undefined,
  next: GrokCanonicalToolMetadata,
): GrokCanonicalToolMetadata {
  if (previous === undefined) return next;
  if (
    previous.version !== next.version ||
    previous.name !== next.name ||
    previous.kind !== next.kind ||
    previous.namespace !== next.namespace ||
    previous.label !== next.label ||
    previous.readOnly !== next.readOnly
  ) {
    invalid();
  }
  return Object.freeze({
    ...previous,
    ...(Object.hasOwn(next, "input") ? { input: next.input } : {}),
  });
}

function latchSemanticDisposition(block: GrokMutableToolBlock): void {
  if (block.semanticDisposition !== undefined) return;
  const evidence = inspectDecodedGrokToolNormalization(
    block.canonicalToolMetadata,
    block.rawInput,
    block.rawOutput,
  );
  if (evidence.deferUntilRefinement) return;
  if (
    evidence.disposition.semanticKind === "file_change" &&
    !hasRepresentableFileChangeEvidence(block, evidence.disposition)
  ) {
    return;
  }
  if (
    block.canonicalToolMetadata === undefined &&
    block.status !== "completed" &&
    block.status !== "failed" &&
    block.rawOutputVariant === undefined &&
    block.toolKind !== undefined &&
    block.toolKind !== "other"
  ) {
    // A sparse ACP classification can be refined by the canonical nested
    // metadata on a later update. Do not publish a generic item first.
    return;
  }
  block.semanticDisposition = evidence.disposition;
}

function hasRepresentableFileChangeEvidence(
  block: GrokMutableToolBlock,
  disposition: Extract<
    GrokCandidateToolDisposition,
    { readonly semanticKind: "file_change" }
  >,
): boolean {
  if (
    block.content?.some(
      (part) => part.type === "diff" && part.path === disposition.path,
    )
  ) {
    return true;
  }
  if (disposition.operation === "delete") return true;
  if (disposition.operation === "move") {
    return disposition.destinationPath !== undefined;
  }
  if (!isRecord(block.rawInput)) return false;
  if (disposition.operation === "edit") {
    return (
      typeof ownValue(block.rawInput, "old_string") === "string" &&
      typeof ownValue(block.rawInput, "new_string") === "string"
    );
  }
  if (disposition.operation === "write") {
    return typeof ownValue(block.rawInput, "content") === "string";
  }
  return false;
}

function genericDisposition(
  block: GrokMutableToolBlock,
): Extract<GrokCandidateToolDisposition, { readonly semanticKind: "tool" }> {
  const metadata = block.canonicalToolMetadata;
  const candidate =
    metadata === undefined
      ? undefined
      : inspectDecodedGrokToolNormalization(metadata, undefined, undefined)
          .disposition;
  return Object.freeze({
    semanticKind: "tool",
    ...(metadata === undefined
      ? {}
      : { toolName: metadata.name, title: metadata.label }),
    category:
      candidate?.semanticKind === "tool"
        ? candidate.category
        : toolCategory(block.toolKind),
  });
}

function toolArguments(block: GrokMutableToolBlock) {
  const hasInput = Object.hasOwn(block, "rawInput");
  const hasLocations = block.locations != null && block.locations.length > 0;
  if (!hasInput && !hasLocations) return undefined;
  if (!hasLocations) return boundValue(block.rawInput);
  return boundValue({
    ...(hasInput ? { input: block.rawInput } : {}),
    locations: block.locations!.map((location) => ({
      path: location.path,
      ...(location.line == null ? {} : { line: location.line }),
    })),
  });
}

function toolResult(block: GrokMutableToolBlock, isError: boolean) {
  const content = (block.content ?? []).flatMap((part) =>
    part.type === "content" &&
    (part.content.type === "text" || part.content.type === "image")
      ? [part.content]
      : [],
  );
  const diffs = (block.content ?? []).flatMap((part) =>
    part.type === "diff"
      ? [
          {
            path: part.path,
            oldText: part.oldText ?? null,
            newText: part.newText,
          },
        ]
      : [],
  );
  const hasRawOutput = Object.hasOwn(block, "rawOutput");
  const decodedOutput = decodeGrokBashOutput(block.rawOutput)?.output;
  const retainRawOutput = hasRawOutput && decodedOutput === undefined;
  return boundToolResult(
    {
      content: [
        ...content,
        ...(decodedOutput === undefined
          ? []
          : [{ type: "text" as const, text: decodedOutput }]),
      ],
      ...(retainRawOutput || diffs.length > 0
        ? {
            details: {
              ...(retainRawOutput ? { rawOutput: block.rawOutput } : {}),
              ...(diffs.length > 0 ? { diffs } : {}),
            },
          }
        : {}),
    },
    isError,
  );
}

function specializedToolResult(
  block: GrokMutableToolBlock,
  isError: boolean,
  variant: "WebSearch" | "MCP",
) {
  const content = (block.content ?? []).flatMap((part) =>
    part.type === "content" &&
    (part.content.type === "text" || part.content.type === "image")
      ? [part.content]
      : [],
  );
  if (content.length > 0) return boundToolResult({ content }, isError);
  const rawText =
    variant === "WebSearch"
      ? ownString(block.rawOutput, "content")
      : decodeGrokMcpOutputText(block.rawOutput);
  return boundToolResult(
    rawText === undefined ? { content: [] } : rawText,
    isError,
  );
}

function decodeGrokMcpOutputText(value: unknown): string | undefined {
  if (!isRecord(value) || ownValue(value, "type") !== "MCP") return undefined;
  const output = ownValue(value, "output");
  if (!isRecord(output)) return undefined;
  const okay = ownValue(output, "OkayOutput");
  if (typeof okay === "string") return okay;
  const error = ownValue(output, "Error");
  return typeof error === "string" ? error : undefined;
}

function fileChangeContentProjection(
  block: GrokMutableToolBlock,
  disposition: Extract<
    GrokCandidateToolDisposition,
    { readonly semanticKind: "file_change" }
  >,
):
  | {
      readonly replacement: {
        readonly before: ReturnType<typeof boundText>;
        readonly after: ReturnType<typeof boundText>;
      };
    }
  | { readonly contentPreview: ReturnType<typeof boundText> }
  | Record<string, never> {
  const diff = block.content?.find(
    (part) => part.type === "diff" && part.path === disposition.path,
  );
  if (diff?.type === "diff" && disposition.operation === "edit") {
    const replacement = exactReplacement(diff.oldText, diff.newText);
    return replacement === undefined ||
      !canCarryExactReplacement(disposition.path)
      ? { contentPreview: boundText(diff.newText) }
      : { replacement };
  }
  if (!isRecord(block.rawInput)) return {};
  if (disposition.operation === "edit") {
    const replacement = exactReplacement(
      ownString(block.rawInput, "old_string"),
      ownString(block.rawInput, "new_string"),
    );
    return replacement === undefined ||
      !canCarryExactReplacement(disposition.path)
      ? replacement === undefined
        ? {}
        : { contentPreview: replacement.after }
      : { replacement };
  }
  if (disposition.operation === "write") {
    const content = ownString(block.rawInput, "content");
    return content === undefined ? {} : { contentPreview: boundText(content) };
  }
  return {};
}

function canCarryExactReplacement(path: string): boolean {
  const bounded = boundDisplayText(path);
  return (
    bounded.truncation === undefined &&
    bounded.text.length > 0 &&
    bounded.text !== "/dev/null" &&
    bounded.text.trim() === bounded.text &&
    !/[\0-\x1f\x7f]/u.test(bounded.text)
  );
}

function exactReplacement(
  before: unknown,
  after: unknown,
):
  | {
      readonly before: ReturnType<typeof boundText>;
      readonly after: ReturnType<typeof boundText>;
    }
  | undefined {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    before === after
  ) {
    return undefined;
  }
  const boundedBefore = boundText(before);
  const boundedAfter = boundText(after);
  return boundedBefore.truncation === undefined &&
    boundedAfter.truncation === undefined
    ? Object.freeze({ before: boundedBefore, after: boundedAfter })
    : undefined;
}

function decodeGrokBashOutput(value: unknown):
  | {
      readonly output?: string;
      readonly exitCode?: number;
      readonly currentDir?: string;
    }
  | undefined {
  if (!isRecord(value) || ownValue(value, "type") !== "Bash") return undefined;
  const bytes = ownValue(value, "output");
  const exitCode = ownValue(value, "exit_code");
  const currentDir = ownString(value, "current_dir");
  const output =
    Array.isArray(bytes) &&
    bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ? Buffer.from(bytes).toString("utf8")
      : undefined;
  return Object.freeze({
    ...(output === undefined ? {} : { output }),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode)
      ? { exitCode }
      : {}),
    ...(currentDir === undefined ? {} : { currentDir }),
  });
}

function toolContentText(block: GrokMutableToolBlock): string | undefined {
  const text = (block.content ?? []).flatMap((part) =>
    part.type === "content" && part.content.type === "text"
      ? [part.content.text]
      : [],
  );
  return text.length === 0 ? undefined : text.join("\n");
}

function toolCategory(
  kind: GrokMutableToolBlock["toolKind"],
): Extract<BackendItem, { semanticKind: "tool" }>["category"] {
  if (kind === "search") return "search";
  if (
    kind === "read" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move"
  ) {
    return "filesystem";
  }
  if (kind === "fetch") return "network";
  if (kind === "execute" || kind === "think") return "computation";
  return "other";
}

function ownValue(value: unknown, key: string): unknown {
  return isRecord(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function ownString(value: unknown, key: string): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new GrokToolProjectionError();
}
