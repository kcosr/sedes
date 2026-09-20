/**
 * Grok-private decoding of the reviewed Grok Build tool identity envelope.
 * Provider spellings stop here; callers receive only candidate normalized
 * dispositions and must latch one before publishing an item.
 */

const GROK_TOOL_META_KEY = "x.ai/tool";
const GROK_TOOL_META_VERSION = 1;

const KNOWN_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "delete",
  "list_dir",
  "write",
  "move",
  "search",
  "lsp",
  "execute",
  "plan",
  "web_search",
  "web_fetch",
  "background_task_action",
  "wait_tasks_action",
  "kill_task_action",
  "list",
  "skill",
  "memory_search",
  "memory_get",
  "task",
  "enter_plan",
  "exit_plan",
  "ask_user",
  "image_gen",
  "video_gen",
  "image_to_video",
  "reference_to_video",
  "deploy_app",
  "search_tool",
  "use_tool",
  "monitor",
  "goal_update",
  "workflow",
  "other",
]);

export type GrokCanonicalToolKind =
  | "read"
  | "edit"
  | "delete"
  | "list_dir"
  | "write"
  | "move"
  | "search"
  | "lsp"
  | "execute"
  | "plan"
  | "web_search"
  | "web_fetch"
  | "background_task_action"
  | "wait_tasks_action"
  | "kill_task_action"
  | "list"
  | "skill"
  | "memory_search"
  | "memory_get"
  | "task"
  | "enter_plan"
  | "exit_plan"
  | "ask_user"
  | "image_gen"
  | "video_gen"
  | "image_to_video"
  | "reference_to_video"
  | "deploy_app"
  | "search_tool"
  | "use_tool"
  | "monitor"
  | "goal_update"
  | "workflow"
  | "other";

export interface GrokCanonicalToolMetadata {
  readonly version: 1;
  readonly name: string;
  /** Unknown additive source kinds deliberately degrade to `other`. */
  readonly kind: GrokCanonicalToolKind;
  /** Kept open as required by the source contract for out-of-tree consumers. */
  readonly namespace: string;
  readonly label: string;
  readonly readOnly: boolean;
  readonly input?: unknown;
}

export type GrokRawToolOutputVariant =
  "Bash" | "WebSearch" | "MCP" | "ImageGen" | "ImageEdit";

export type GrokCandidateToolDisposition =
  | {
      readonly semanticKind: "command";
      readonly command: string;
      readonly cwd?: string;
    }
  | {
      readonly semanticKind: "file_read";
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly semanticKind: "file_change";
      readonly operation: "write" | "edit" | "delete" | "move";
      readonly path: string;
      readonly destinationPath?: string;
    }
  | {
      readonly semanticKind: "web_search";
      readonly query?: string;
    }
  | {
      readonly semanticKind: "mcp";
      readonly server: string;
      readonly toolName: string;
    }
  | {
      readonly semanticKind: "tool";
      readonly toolName?: string;
      readonly title?: string;
      readonly category:
        "search" | "filesystem" | "network" | "computation" | "other";
    };

export interface GrokToolNormalizationEvidence {
  readonly metadata?: GrokCanonicalToolMetadata;
  readonly rawOutputVariant?: GrokRawToolOutputVariant;
  readonly disposition: GrokCandidateToolDisposition;
  /** A recognized rich shape is waiting for required structural fields. */
  readonly deferUntilRefinement: boolean;
}

/**
 * Decode the exact v1 envelope. Additive fields are projected away. A malformed
 * envelope is absent evidence rather than a partial authority source.
 */
export function decodeGrokCanonicalToolMetadata(
  meta: unknown,
): GrokCanonicalToolMetadata | undefined {
  const envelope = ownRecordValue(meta, GROK_TOOL_META_KEY);
  if (!isRecord(envelope)) return undefined;

  const version = ownValue(envelope, "version");
  const name = ownValue(envelope, "name");
  const sourceKind = ownValue(envelope, "kind");
  const namespace = ownValue(envelope, "namespace");
  const label = ownValue(envelope, "label");
  const readOnly = ownValue(envelope, "read_only");
  if (
    version !== GROK_TOOL_META_VERSION ||
    typeof name !== "string" ||
    typeof sourceKind !== "string" ||
    typeof namespace !== "string" ||
    typeof label !== "string" ||
    typeof readOnly !== "boolean"
  ) {
    return undefined;
  }

  const kind = KNOWN_TOOL_KINDS.has(sourceKind)
    ? (sourceKind as GrokCanonicalToolKind)
    : "other";
  const input = ownValue(envelope, "input");
  return Object.freeze({
    version: GROK_TOOL_META_VERSION,
    name,
    kind,
    namespace,
    label,
    readOnly,
    ...(input === undefined ? {} : { input }),
  });
}

/** Decode only the source-reviewed, case-sensitive ToolOutput discriminants. */
export function decodeGrokRawToolOutputVariant(
  rawOutput: unknown,
): GrokRawToolOutputVariant | undefined {
  if (!isRecord(rawOutput)) return undefined;
  const type = ownValue(rawOutput, "type");
  switch (type) {
    case "Bash":
    case "WebSearch":
    case "MCP":
    case "ImageGen":
    case "ImageEdit":
      return type;
    default:
      return undefined;
  }
}

/**
 * Compute a candidate from provider structures only. No title, label, or tool
 * name substring is interpreted as semantic evidence.
 */
export function inspectGrokToolNormalization(
  meta: unknown,
  rawInput: unknown,
  rawOutput: unknown,
): GrokToolNormalizationEvidence {
  const metadata = decodeGrokCanonicalToolMetadata(meta);
  return inspectDecodedGrokToolNormalization(metadata, rawInput, rawOutput);
}

export function inspectDecodedGrokToolNormalization(
  metadata: GrokCanonicalToolMetadata | undefined,
  rawInput: unknown,
  rawOutput: unknown,
): GrokToolNormalizationEvidence {
  const rawOutputVariant = decodeGrokRawToolOutputVariant(rawOutput);
  const disposition = candidateDisposition(
    metadata,
    rawInput,
    rawOutputVariant,
    rawOutput,
  );
  const deferUntilRefinement = richDispositionIncomplete(
    metadata,
    rawOutputVariant,
    disposition,
  );
  return Object.freeze({
    ...(metadata === undefined ? {} : { metadata }),
    ...(rawOutputVariant === undefined ? {} : { rawOutputVariant }),
    disposition,
    deferUntilRefinement,
  });
}

function candidateDisposition(
  metadata: GrokCanonicalToolMetadata | undefined,
  rawInput: unknown,
  rawOutputVariant: GrokRawToolOutputVariant | undefined,
  rawOutput: unknown,
): GrokCandidateToolDisposition {
  const canonicalInput = isRecord(metadata?.input) ? metadata.input : undefined;

  if (metadata?.kind === "execute" || rawOutputVariant === "Bash") {
    const command =
      ownString(canonicalInput, "command") ??
      ownString(rawInput, "command") ??
      ownString(rawOutput, "command");
    if (command !== undefined) {
      const cwd =
        ownString(canonicalInput, "cwd") ?? ownString(rawInput, "cwd");
      return Object.freeze({
        semanticKind: "command",
        command,
        ...(cwd === undefined ? {} : { cwd }),
      });
    }
  }

  if (metadata?.kind === "read") {
    const path =
      ownString(canonicalInput, "path") ??
      ownString(rawInput, "target_file") ??
      ownString(rawInput, "path");
    if (path !== undefined) {
      const offset = ownNonnegativeSafeInteger(canonicalInput, "offset");
      const limit = ownNonnegativeSafeInteger(canonicalInput, "limit");
      return Object.freeze({
        semanticKind: "file_read",
        path,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      });
    }
  }

  const fileOperation = fileChangeOperation(metadata?.kind);
  if (fileOperation !== undefined) {
    const path =
      ownString(canonicalInput, "path") ??
      ownString(rawInput, "file_path") ??
      ownString(rawInput, "path") ??
      ownString(rawInput, "target_file");
    if (path !== undefined) {
      const destinationPath =
        ownString(canonicalInput, "destination_path") ??
        ownString(rawInput, "destination_path");
      if (fileOperation !== "move" || destinationPath !== undefined) {
        return Object.freeze({
          semanticKind: "file_change",
          operation: fileOperation,
          path,
          ...(destinationPath === undefined ? {} : { destinationPath }),
        });
      }
    }
  }

  if (metadata?.kind === "web_search" || rawOutputVariant === "WebSearch") {
    const action = ownRecordValue(rawOutput, "action");
    const query =
      ownString(canonicalInput, "query") ??
      ownString(rawInput, "query") ??
      ownString(rawOutput, "query") ??
      ownString(action, "query");
    return Object.freeze({
      semanticKind: "web_search",
      ...(query === undefined ? {} : { query }),
    });
  }

  if (metadata?.namespace === "mcp" || rawOutputVariant === "MCP") {
    const outputServer = ownString(rawOutput, "server_name");
    const outputTool = ownString(rawOutput, "tool_name");
    const qualified =
      outputServer !== undefined && outputTool !== undefined
        ? { server: outputServer, toolName: outputTool }
        : metadata?.namespace === "mcp"
          ? parseMcpQualifiedToolName(metadata.name)
          : undefined;
    if (qualified !== undefined) {
      return Object.freeze({ semanticKind: "mcp", ...qualified });
    }
  }

  return Object.freeze({
    semanticKind: "tool",
    ...(metadata === undefined
      ? {}
      : { toolName: metadata.name, title: metadata.label }),
    category: genericToolCategory(metadata?.kind),
  });
}

function richDispositionIncomplete(
  metadata: GrokCanonicalToolMetadata | undefined,
  rawOutputVariant: GrokRawToolOutputVariant | undefined,
  disposition: GrokCandidateToolDisposition,
): boolean {
  if (disposition.semanticKind !== "tool") return false;
  return (
    rawOutputVariant === "Bash" ||
    rawOutputVariant === "MCP" ||
    metadata?.kind === "execute" ||
    metadata?.kind === "read" ||
    metadata?.kind === "edit" ||
    metadata?.kind === "write" ||
    metadata?.kind === "delete" ||
    metadata?.kind === "move" ||
    metadata?.namespace === "mcp"
  );
}

function parseMcpQualifiedToolName(
  name: string,
): { readonly server: string; readonly toolName: string } | undefined {
  const boundaries: number[] = [];
  for (let index = 0; index < name.length - 1; index += 1) {
    if (name[index] === "_" && name[index + 1] === "_") boundaries.push(index);
  }
  if (boundaries.length !== 1) return undefined;
  const boundary = boundaries[0]!;
  const server = name.slice(0, boundary);
  const toolName = name.slice(boundary + 2);
  return server.length > 0 && toolName.length > 0
    ? { server, toolName }
    : undefined;
}

function fileChangeOperation(
  kind: GrokCanonicalToolKind | undefined,
): "write" | "edit" | "delete" | "move" | undefined {
  switch (kind) {
    case "write":
    case "edit":
    case "delete":
    case "move":
      return kind;
    default:
      return undefined;
  }
}

function genericToolCategory(
  kind: GrokCanonicalToolKind | undefined,
): "search" | "filesystem" | "network" | "computation" | "other" {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "list_dir":
    case "write":
    case "move":
    case "list":
      return "filesystem";
    case "search":
    case "web_search":
    case "memory_search":
    case "search_tool":
      return "search";
    case "web_fetch":
      return "network";
    case "execute":
    case "lsp":
    case "plan":
      return "computation";
    default:
      return "other";
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownNonnegativeSafeInteger(
  value: unknown,
  key: string,
): number | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

function ownRecordValue(value: unknown, key: string): unknown {
  const candidate = ownValue(value, key);
  return isRecord(candidate) ? candidate : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
