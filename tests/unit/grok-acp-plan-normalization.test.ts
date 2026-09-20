import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { backendItemSchema } from "../../src/shared/protocol/backend.js";
import { PAYLOAD_LIMITS } from "../../src/shared/protocol/payload.js";
import {
  GrokAcpPlanNormalizationError,
  projectGrokAcpPlanReplacement,
  settleGrokAcpPlanAtTerminal,
} from "../../src/server/backends/grok/grok-acp-plan-normalization.js";

const nativeNamespaceKey = "grok-native-namespace";

function planNotification(
  entries: Extract<
    SessionNotification["update"],
    { readonly sessionUpdate: "plan" }
  >["entries"],
  input: {
    readonly eventId?: string;
    readonly promptId?: string;
    readonly replay?: true;
  } = {},
): SessionNotification {
  return {
    sessionId: "session-1",
    update: { sessionUpdate: "plan", entries },
    _meta: {
      eventId: input.eventId ?? "event-1",
      promptId: input.promptId ?? "prompt-1",
      ...(input.replay ? { isReplay: true } : {}),
    },
  };
}

describe("Grok stable ACP Plan normalization", () => {
  it("projects a full replacement into the common plan entry shape", () => {
    const projected = projectGrokAcpPlanReplacement({
      nativeNamespaceKey,
      notification: planNotification([
        { content: "Inspect", priority: "high", status: "completed" },
        { content: "Implement", priority: "medium", status: "in_progress" },
        {
          content: "Obsolete",
          priority: "low",
          status: "completed",
          _meta: { cancelled: true, ignored: "private" },
        },
      ]),
    });

    expect(projected).toMatchObject({
      eventId: "event-1",
      promptId: "prompt-1",
      planId: expect.stringMatching(/^grok-plan:/u),
      backendItemId: expect.stringMatching(/^grok-item:/u),
      entries: [
        { text: { text: "Inspect" }, status: "completed" },
        { text: { text: "Implement" }, status: "in_progress" },
        { text: { text: "Obsolete" }, status: "cancelled" },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("priority");
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(() =>
      backendItemSchema.parse({
        backendItemId: projected!.backendItemId,
        backendTurnId: "turn-1",
        status: "streaming",
        sourceOrder: 1,
        semanticKind: "plan",
        entries: projected!.entries,
      }),
    ).not.toThrow();
  });

  it("keeps prompt, item, and ordinal entry identities stable across replacement and replay", () => {
    const first = projectGrokAcpPlanReplacement({
      nativeNamespaceKey,
      notification: planNotification(
        [
          { content: "First", priority: "low", status: "pending" },
          { content: "Second", priority: "high", status: "in_progress" },
        ],
        { eventId: "live-event" },
      ),
    })!;
    const replayedReplacement = projectGrokAcpPlanReplacement({
      nativeNamespaceKey,
      notification: planNotification(
        [
          { content: "Renamed", priority: "high", status: "completed" },
          { content: "Still second", priority: "low", status: "completed" },
        ],
        { eventId: "replay-event", replay: true },
      ),
    })!;

    expect(replayedReplacement.eventId).not.toBe(first.eventId);
    expect(replayedReplacement.planId).toBe(first.planId);
    expect(replayedReplacement.backendItemId).toBe(first.backendItemId);
    expect(replayedReplacement.entries.map(({ id }) => id)).toEqual(
      first.entries.map(({ id }) => id),
    );
  });

  it("derives only in-progress turn-end settlement without mutating durable input", () => {
    const projected = projectGrokAcpPlanReplacement({
      nativeNamespaceKey,
      notification: planNotification([
        { content: "Pending", priority: "low", status: "pending" },
        { content: "Active", priority: "high", status: "in_progress" },
        {
          content: "Cancelled",
          priority: "medium",
          status: "completed",
          _meta: { cancelled: true },
        },
      ]),
    })!;
    const settled = settleGrokAcpPlanAtTerminal(projected);

    expect(projected.entries.map(({ status }) => status)).toEqual([
      "pending",
      "in_progress",
      "cancelled",
    ]);
    expect(settled.entries.map(({ status }) => status)).toEqual([
      "pending",
      "completed",
      "cancelled",
    ]);
    expect(settled.backendItemId).toBe(projected.backendItemId);
    expect(settleGrokAcpPlanAtTerminal(settled)).toBe(settled);
  });

  it("ignores only the exact metadata-free transient cleanup", () => {
    const notification = planNotification([
      { content: "Active", priority: "high", status: "completed" },
    ]);
    delete notification._meta;
    expect(
      projectGrokAcpPlanReplacement({ nativeNamespaceKey, notification }),
    ).toBeUndefined();

    expect(() =>
      projectGrokAcpPlanReplacement({
        nativeNamespaceKey,
        notification: {
          ...planNotification([]),
          _meta: { eventId: "event-without-prompt" },
        },
      }),
    ).toThrow(GrokAcpPlanNormalizationError);
  });

  it("uses the existing shared collection ceiling and rejects no smaller plan", () => {
    const entries = Array.from(
      { length: PAYLOAD_LIMITS.collectionEntries },
      (_, index) => ({
        content: `Step ${index}`,
        priority: "medium" as const,
        status: "pending" as const,
      }),
    );
    expect(
      projectGrokAcpPlanReplacement({
        nativeNamespaceKey,
        notification: planNotification(entries),
      })?.entries,
    ).toHaveLength(PAYLOAD_LIMITS.collectionEntries);

    expect(() =>
      projectGrokAcpPlanReplacement({
        nativeNamespaceKey,
        notification: planNotification([
          ...entries,
          { content: "One too many", priority: "low", status: "pending" },
        ]),
      }),
    ).toThrow(GrokAcpPlanNormalizationError);
  });

  it("rejects non-Plan updates and malformed stable fields", () => {
    expect(() =>
      projectGrokAcpPlanReplacement({
        nativeNamespaceKey,
        notification: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
          _meta: { eventId: "event", promptId: "prompt" },
        },
      }),
    ).toThrow(GrokAcpPlanNormalizationError);

    const malformed = planNotification([
      {
        content: "Bad cancellation",
        priority: "high",
        status: "completed",
        _meta: { cancelled: "yes" },
      },
    ] as never);
    expect(() =>
      projectGrokAcpPlanReplacement({
        nativeNamespaceKey,
        notification: malformed,
      }),
    ).toThrow(GrokAcpPlanNormalizationError);
  });
});
