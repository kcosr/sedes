import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { correlatePiSubmissions } from "./pi-submission-marker.js";

export function completedAssistantEntryIdForTurn(
  entries: readonly SessionEntry[],
  backendTurnId: string,
): string | undefined {
  const start = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      entry.id === backendTurnId,
  );
  if (start < 0) return undefined;
  const submissionsByUserEntry = new Map(
    [...correlatePiSubmissions(entries).values()].flatMap(
      ({ invalid, marker, userEntryId }) =>
        userEntryId && !invalid ? [[userEntryId, marker] as const] : [],
    ),
  );
  const turnEntries: SessionEntry[] = [];
  for (const entry of entries.slice(start + 1)) {
    if (entry.type === "message" && entry.message.role === "user") {
      const marker = submissionsByUserEntry.get(entry.id);
      if (marker?.mode !== "steer") break;
    }
    turnEntries.push(entry);
  }
  return turnEntries.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "stop" ||
        entry.message.stopReason === "length") &&
      !entry.message.content.some((part) => part.type === "toolCall"),
  )?.id;
}

export function completedBackendTurnIdForLeaf(
  entries: readonly SessionEntry[],
  leafEntryId: string,
): string | undefined {
  const leafIndex = entries.findIndex(({ id }) => id === leafEntryId);
  if (leafIndex < 0) return undefined;
  const submissionsByUserEntry = new Map(
    [...correlatePiSubmissions(entries).values()].flatMap(
      ({ invalid, marker, userEntryId }) =>
        userEntryId && !invalid ? [[userEntryId, marker] as const] : [],
    ),
  );
  for (let index = leafIndex; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    if (submissionsByUserEntry.get(entry.id)?.mode === "steer") continue;
    return completedAssistantEntryIdForTurn(entries, entry.id) === leafEntryId
      ? entry.id
      : undefined;
  }
  return undefined;
}
