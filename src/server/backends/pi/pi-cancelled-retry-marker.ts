import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { assertPiToolIdentityAuthentication, type PiToolIdentityAuthentication } from "./pi-tool-identity-marker.js";

export const piCancelledRetryMarkerType = "sedes.cancelled_retry.v1";

function tag(assistantEntryId: string, authentication: PiToolIdentityAuthentication): Buffer {
  assertPiToolIdentityAuthentication(authentication);
  return createHmac("sha256", authentication.installationKey)
    .update(JSON.stringify([piCancelledRetryMarkerType, authentication.conversationId, assistantEntryId]))
    .digest();
}

/** Non-message session metadata: never inserted into the provider's conversation. */
export function createPiCancelledRetryMarker(assistantEntryId: string, authentication: PiToolIdentityAuthentication) {
  return { assistantEntryId, tag: tag(assistantEntryId, authentication).toString("base64url") };
}

export function readPiCancelledRetryMarker(entry: SessionEntry, authentication: PiToolIdentityAuthentication): string | undefined {
  if (entry.type !== "custom" || entry.customType !== piCancelledRetryMarkerType) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object" || Object.keys(data).sort().join(",") !== "assistantEntryId,tag") return undefined;
  const { assistantEntryId, tag: encoded } = data as Record<string, unknown>;
  if (typeof assistantEntryId !== "string" || assistantEntryId.length === 0 || assistantEntryId.length > 512 || typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
  return timingSafeEqual(Buffer.from(encoded, "base64url"), tag(assistantEntryId, authentication)) ? assistantEntryId : undefined;
}

export function cancelledPiRetryEntries(entries: readonly SessionEntry[], authentication?: PiToolIdentityAuthentication): ReadonlySet<string> {
  const cancelled = new Set<string>();
  if (!authentication) return cancelled;
  let latestAssistantErrorId: string | undefined;
  for (const entry of entries) {
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      latestAssistantErrorId = entry.message.role === "assistant" && entry.message.stopReason === "error" ? entry.id : undefined;
    }
    const assistantEntryId = readPiCancelledRetryMarker(entry, authentication);
    if (assistantEntryId && assistantEntryId === latestAssistantErrorId) cancelled.add(assistantEntryId);
  }
  return cancelled;
}
