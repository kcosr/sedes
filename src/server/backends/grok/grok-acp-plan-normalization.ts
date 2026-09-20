import { createHash } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { BackendItem } from "../../../shared/protocol/backend.js";
import { PAYLOAD_LIMITS } from "../../../shared/protocol/payload.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

const MAXIMUM_IDENTIFIER_BYTES = 1_024;

type BackendPlanItem = Extract<BackendItem, { readonly semanticKind: "plan" }>;

export interface GrokAcpPlanReplacement {
  readonly eventId: string;
  readonly promptId: string;
  /** Stable provider-private identity for the prompt's one replacement plan. */
  readonly planId: string;
  /** Stable normalized item identity shared by live, replay, and reopen. */
  readonly backendItemId: string;
  readonly entries: readonly BackendPlanItem["entries"][number][];
}

export class GrokAcpPlanNormalizationError extends Error {
  readonly code = "grok_acp_plan_invalid" as const;

  constructor() {
    super("grok_acp_plan_invalid");
    this.name = "GrokAcpPlanNormalizationError";
  }
}

/**
 * Projects Grok's stable ACP `SessionUpdate::Plan` as one full replacement.
 *
 * Grok's source-backed turn-end cleanup is deliberately transient and carries
 * no notification metadata. Returning undefined for that exact case keeps it
 * from becoming invented durable evidence; terminal settlement below derives
 * the same visible cleanup from the durable turn boundary.
 */
export function projectGrokAcpPlanReplacement(input: {
  readonly nativeNamespaceKey: string;
  readonly notification: SessionNotification;
}): GrokAcpPlanReplacement | undefined {
  const { nativeNamespaceKey, notification } = input;
  if (
    !boundedIdentifier(nativeNamespaceKey) ||
    !boundedIdentifier(notification.sessionId) ||
    notification.update.sessionUpdate !== "plan"
  ) {
    invalid();
  }
  if (notification._meta === undefined || notification._meta === null) {
    return undefined;
  }
  if (!isRecord(notification._meta)) invalid();
  const eventId = notification._meta.eventId;
  const promptId = notification._meta.promptId;
  if (
    !boundedIdentifier(eventId) ||
    !boundedIdentifier(promptId) ||
    (notification._meta.isReplay !== undefined &&
      notification._meta.isReplay !== true) ||
    !Array.isArray(notification.update.entries) ||
    notification.update.entries.length > PAYLOAD_LIMITS.collectionEntries
  ) {
    invalid();
  }

  const planId = stableId("grok-plan", [
    nativeNamespaceKey,
    notification.sessionId,
    promptId,
  ]);
  const backendItemId = stableId("grok-item", [
    nativeNamespaceKey,
    notification.sessionId,
    promptId,
    planId,
  ]);
  const entries = notification.update.entries.map((entry, ordinal) => {
    if (
      !isRecord(entry) ||
      typeof entry.content !== "string" ||
      (entry.priority !== "high" &&
        entry.priority !== "medium" &&
        entry.priority !== "low") ||
      (entry.status !== "pending" &&
        entry.status !== "in_progress" &&
        entry.status !== "completed") ||
      (entry._meta !== undefined &&
        entry._meta !== null &&
        !isRecord(entry._meta))
    ) {
      invalid();
    }
    const cancelled = entry._meta?.cancelled;
    if (cancelled !== undefined && typeof cancelled !== "boolean") invalid();
    return Object.freeze({
      id: stableId("grok-plan-entry", [
        nativeNamespaceKey,
        notification.sessionId,
        promptId,
        ordinal,
      ]),
      text: boundDisplayText(entry.content),
      status:
        entry.status === "completed" && cancelled === true
          ? ("cancelled" as const)
          : entry.status,
    });
  });

  return Object.freeze({
    eventId,
    promptId,
    planId,
    backendItemId,
    entries: Object.freeze(entries),
  });
}

/** Reproduces Grok's non-persisted turn-end Plan cleanup from durable truth. */
export function settleGrokAcpPlanAtTerminal(
  replacement: GrokAcpPlanReplacement,
): GrokAcpPlanReplacement {
  const unsettled = replacement.entries.some(
    ({ status }) => status === "in_progress",
  );
  if (!unsettled) return replacement;
  return Object.freeze({
    ...replacement,
    entries: Object.freeze(
      replacement.entries.map((entry) =>
        entry.status === "in_progress"
          ? Object.freeze({ ...entry, status: "completed" as const })
          : entry,
      ),
    ),
  });
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_IDENTIFIER_BYTES &&
    !value.includes("\0")
  );
}

function stableId(prefix: string, values: readonly unknown[]): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("base64url")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new GrokAcpPlanNormalizationError();
}
