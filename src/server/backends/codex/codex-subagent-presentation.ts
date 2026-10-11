import { boundText } from "../../conversations/payload-policy.js";
import type { CodexThreadItem } from "./codex-c1-protocol.js";

export interface CodexSubagentParentSettings {
  readonly model: string;
  readonly reasoningEffort: string | null;
}

/** Creation evidence belongs to one resident parent handle, never usage attribution. */
export type CodexSubagentCreationSettings = ReadonlyMap<string, CodexSubagentParentSettings | null>;

export function codexSubagentActivitySummary(
  item: Extract<CodexThreadItem, { readonly type: "subAgentActivity" }>,
  parent: CodexSubagentParentSettings | null | undefined,
): string {
  const prefix = item.kind === "started" ? "Started"
    : item.kind === "interacted" ? "Interacted with"
      : item.kind === "completed" ? "Completed" : "Interrupted";
  const model = item.model?.trim() || null;
  const effort = item.reasoningEffort?.trim() || null;
  const sameSettings = parent != null && model !== null && effort !== null &&
    item.model === parent.model && item.reasoningEffort === parent.reasoningEffort;
  const showSettings = !sameSettings && (model !== null || effort !== null);
  // Keep both settings visible even when the provider supplies a long path/model.
  const path = boundText(item.agentPath.trim().replace(/\s+/gu, " ") || "agent",
    showSettings ? 3_000 : 4_000).text;
  if (!showSettings) return `${prefix} \`${path}\``;
  const modelLabel = model === null ? "Model unknown"
    : boundText(model.replace(/\s+/gu, " "), 512).text;
  const effortLabel = effort === null ? "Reasoning unknown"
    : boundText(effort.replace(/\s+/gu, " "), 256).text;
  return `${prefix} \`${path}\` · ${modelLabel} · ${effortLabel}`;
}
