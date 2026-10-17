import type { ToolPolicyResolutionIssue } from "../../../shared/protocol/tool-policies.js";

export function toolPolicySourceLabel(source: string): string {
  return source === "default" ? "built-in defaults" : `${source === "agent" ? "Agent" : source} settings`;
}

export function missingToolPolicyMessage(
  issue: ToolPolicyResolutionIssue,
  context: "agent" | "thread",
): string {
  const level = issue.source === "agent" ? "Agent" : issue.source;
  const remedy = context === "thread"
    ? issue.source === "thread"
      ? "Choose another policy above. If this came from a template, update the template to save the change."
      : "Choose a thread policy above or repair that selection in Settings."
    : "Choose another Agent policy or repair that selection in Settings.";
  return `Needs attention: the ${level} policy set was deleted or is unavailable. ${remedy}`;
}
