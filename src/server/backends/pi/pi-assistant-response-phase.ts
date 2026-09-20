/** Native message evidence; a terminal candidate becomes final only at settlement. */
export function piAssistantResponseEvidence(
  message: unknown,
): "provisional" | "terminal_candidate" | "unclassified" {
  if (message === null || typeof message !== "object") return "unclassified";
  const content = Object.getOwnPropertyDescriptor(message, "content")?.value;
  const stopReason = Object.getOwnPropertyDescriptor(message, "stopReason")
    ?.value;
  if (!Array.isArray(content)) return "unclassified";
  for (let index = 0; index < content.length; index++) {
    const part: unknown = Object.getOwnPropertyDescriptor(content, String(index))
      ?.value;
    if (
      part !== null &&
      typeof part === "object" &&
      Object.getOwnPropertyDescriptor(part, "type")?.value === "toolCall"
    ) {
      return "provisional";
    }
  }
  return stopReason === "stop" || stopReason === "length"
    ? "terminal_candidate"
    : "unclassified";
}
