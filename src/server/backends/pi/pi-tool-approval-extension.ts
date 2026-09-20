import type {
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  PI_PROTECTED_MUTATING_TOOLS,
  PI_TOOL_APPROVAL_TITLE,
  type PiToolAccessController,
} from "./pi-tool-access.js";

const maximumDetailCharacters = 1_500;
const maximumEditHunksInDetail = 4;

export const PI_TOOL_APPROVAL_EXTENSION_NAME = "sedes-tool-approval";
export const PI_TOOL_APPROVAL_EXTENSION_PATH = `<inline:${PI_TOOL_APPROVAL_EXTENSION_NAME}>`;

export interface PiToolApprovalExtensionOptions {
  readonly toolAccess: PiToolAccessController;
  readonly workspacePath: string;
  readonly remoteEnvironmentLabel?: string;
  readonly requestApproval: PiToolApprovalRequester;
  /** Exact trusted generated tool names whose effects are not read-only. */
  readonly protectedAgentToolNames?: ReadonlySet<string>;
  readonly resolveAgentToolApproval?: PiAgentToolApprovalResolver;
  readonly recordAgentToolApproval?: PiAgentToolApprovalRecorder;
}

export interface PiResolvedAgentToolApproval {
  readonly fingerprint: string;
  readonly title: string;
  readonly detail: string;
}

export type PiAgentToolApprovalResolver = (input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly parameters: unknown;
}) => PiResolvedAgentToolApproval | undefined;

export type PiAgentToolApprovalRecorder = (input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly fingerprint: string;
}) => void;

export type PiToolApprovalDecision = "approve_once" | "deny" | undefined;

/** Dedicated bridge owned by the managed extension, never ordinary Pi UI. */
export type PiToolApprovalRequester = (input: {
  readonly title: string;
  readonly detail: string;
}) => Promise<PiToolApprovalDecision>;

/**
 * Sedes-owned inline Pi extension that blocks bash/write/edit in `ask` mode
 * until the user approves through the shared interaction UI. Injected last via
 * resourceLoaderOptions.extensionFactories so it observes final tool arguments.
 *
 * Authorization uses the executable built-in identity from the assistant tool
 * call (session branch), not argument-shape inference. Final validated
 * arguments are still taken from the tool_call event after ordinary extensions.
 */
export function createPiToolApprovalExtension(
  options: PiToolApprovalExtensionOptions,
): InlineExtension {
  const protectedAgentToolNames = new Set(
    options.protectedAgentToolNames ?? [],
  );
  return {
    name: PI_TOOL_APPROVAL_EXTENSION_NAME,
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event, ctx) => {
        const capturedMode = options.toolAccess.mode;
        if (capturedMode !== "ask") return undefined;

        let executableToolName: string;
        try {
          executableToolName = resolveExecutableToolName(event, ctx);
        } catch {
          return unverifiedIdentityDenial();
        }
        if (
          !PI_PROTECTED_MUTATING_TOOLS.has(executableToolName) &&
          !protectedAgentToolNames.has(executableToolName)
        ) {
          return undefined;
        }

        const capturedToolCallId = event.toolCallId;
        const capturedExecutableName = executableToolName;
        let resolvedApproval: PiResolvedAgentToolApproval | undefined;
        try {
          resolvedApproval = options.resolveAgentToolApproval?.({
            toolCallId: event.toolCallId,
            toolName: executableToolName,
            parameters: event.input,
          });
        } catch {
          return {
            block: true,
            reason: "Tool call denied: Sedes operation is unavailable.",
          };
        }
        const capturedInputFingerprint =
          resolvedApproval?.fingerprint ?? stableJson(event.input);
        const detail =
          resolvedApproval?.detail ??
          formatApprovalDetail(
            executableToolName,
            event.input,
            options.workspacePath,
            options.remoteEnvironmentLabel,
          );

        let decision: PiToolApprovalDecision;
        try {
          decision = await options.requestApproval({
            title: resolvedApproval?.title ?? PI_TOOL_APPROVAL_TITLE,
            detail,
          });
        } catch {
          return {
            block: true,
            reason: "Tool call denied: approval prompt failed.",
          };
        }

        if (options.toolAccess.mode === "read_only") {
          return {
            block: true,
            reason:
              "Tool call denied: tool access changed to read only before approval completed.",
          };
        }
        let currentExecutableName: string;
        try {
          currentExecutableName = resolveExecutableToolName(event, ctx);
        } catch {
          return unverifiedIdentityDenial();
        }
        let currentInputFingerprint: string;
        try {
          currentInputFingerprint =
            options.resolveAgentToolApproval?.({
              toolCallId: event.toolCallId,
              toolName: currentExecutableName,
              parameters: event.input,
            })?.fingerprint ?? stableJson(event.input);
        } catch {
          return {
            block: true,
            reason:
              "Tool call denied: Sedes operation changed before approval completed.",
          };
        }
        if (
          event.toolCallId !== capturedToolCallId ||
          currentExecutableName !== capturedExecutableName ||
          currentInputFingerprint !== capturedInputFingerprint
        ) {
          return {
            block: true,
            reason:
              "Tool call denied: call identity or arguments changed after the approval prompt.",
          };
        }
        if (decision !== "approve_once") {
          return {
            block: true,
            reason:
              decision === "deny"
                ? "Tool call denied by user."
                : "Tool call denied: approval was cancelled.",
          };
        }
        if (resolvedApproval) {
          try {
            options.recordAgentToolApproval?.({
              toolCallId: capturedToolCallId,
              toolName: capturedExecutableName,
              fingerprint: capturedInputFingerprint,
            });
          } catch {
            return {
              block: true,
              reason: "Tool call denied: approval could not be recorded.",
            };
          }
        }
        return undefined;
      });
    },
  };
}

/**
 * Resolve the immutable, model-issued tool name Pi will execute for this call.
 * Pi persists the current assistant message before running tool preflight, so
 * the newest assistant message is the authoritative source. Missing history,
 * no exact ID match, or duplicate matches are authentication failures.
 */
export function resolveExecutableToolName(
  event: { readonly toolCallId: string },
  ctx: Pick<ExtensionContext, "sessionManager">,
): string {
  const branch = ctx.sessionManager.getBranch();
  const assistantEntry = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (
    assistantEntry?.type !== "message" ||
    !("content" in assistantEntry.message)
  ) {
    throw new Error("pi_tool_identity_assistant_message_missing");
  }
  const content = assistantEntry.message.content;
  if (!Array.isArray(content)) {
    throw new Error("pi_tool_identity_content_invalid");
  }
  const matches = content.filter(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "toolCall" &&
      "id" in part &&
      part.id === event.toolCallId,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "pi_tool_identity_not_found"
        : "pi_tool_identity_ambiguous",
    );
  }
  const match = matches[0]!;
  if (!("name" in match) || typeof match.name !== "string" || !match.name) {
    throw new Error("pi_tool_identity_name_invalid");
  }
  return match.name;
}

export function formatApprovalDetail(
  toolName: string,
  input: unknown,
  workspacePath: string,
  remoteEnvironmentLabel?: string,
): string {
  if (toolName === "bash") {
    const command = stringField(input, "command");
    return [
      `bash: ${truncate(command, maximumDetailCharacters)}`,
      `cwd: ${truncate(workspacePath, 500)}`,
      ...(remoteEnvironmentLabel
        ? [
            `environment: ${truncate(remoteEnvironmentLabel, 500)} (remote account resolved by OpenSSH configuration)`,
            "This command is not filesystem-, process-, or network-sandboxed.",
          ]
        : []),
    ].join("\n");
  }
  if (toolName === "write") {
    const path = stringField(input, "path");
    const content = stringField(input, "content");
    const lines = [
      `write: ${truncate(path, 500)}`,
      `bytes: ${utf8ByteLength(content)}`,
    ];
    if (content.length > 0) {
      lines.push(`preview: ${truncate(content, 400)}`);
    }
    return lines.join("\n");
  }
  if (toolName === "edit") {
    const path = stringField(input, "path");
    const lines = [`edit: ${truncate(path, 500)}`];
    const hunks = editHunks(input);
    if (hunks.length === 0) {
      const oldText =
        stringField(input, "oldText") || stringField(input, "old_string");
      const newText =
        stringField(input, "newText") || stringField(input, "new_string");
      if (oldText.length > 0 || newText.length > 0) {
        lines.push(`- ${truncate(oldText, 300)}`);
        lines.push(`+ ${truncate(newText, 300)}`);
      }
      return lines.join("\n");
    }
    lines.push(`hunks: ${hunks.length}`);
    for (const hunk of hunks.slice(0, maximumEditHunksInDetail)) {
      lines.push(`- ${truncate(hunk.oldText, 200)}`);
      lines.push(`+ ${truncate(hunk.newText, 200)}`);
    }
    if (hunks.length > maximumEditHunksInDetail) {
      lines.push(`… ${hunks.length - maximumEditHunksInDetail} more hunk(s)`);
    }
    return lines.join("\n");
  }
  return `${toolName}: approval required`;
}

function editHunks(
  input: unknown,
): readonly { readonly oldText: string; readonly newText: string }[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }
  const edits = (input as Record<string, unknown>).edits;
  if (!Array.isArray(edits)) return [];
  return edits.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const oldText =
      typeof record.oldText === "string"
        ? record.oldText
        : typeof record.old_string === "string"
          ? record.old_string
          : "";
    const newText =
      typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : "";
    if (oldText.length === 0 && newText.length === 0) return [];
    return [{ oldText, newText }];
  });
}

function stringField(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncate(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters <= 1) return "…";
  return `${value.slice(0, maximumCharacters - 1)}…`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        ordered[key] = record[key];
      }
      return ordered;
    }
    return entry;
  });
}

function unverifiedIdentityDenial(): {
  readonly block: true;
  readonly reason: string;
} {
  return {
    block: true,
    reason: "Tool call denied: executable tool identity could not be verified.",
  };
}
