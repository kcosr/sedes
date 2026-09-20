import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokHistoryProjector } from "../../src/server/backends/grok/grok-history-projector.js";
import type { GrokHistoryRecord } from "../../src/server/backends/grok/grok-history-projector.js";
import {
  locateGrokHistoryTurnWithGeneratedImages,
  projectGrokHistoryPage,
  projectGrokHistoryPageWithGeneratedImages,
  projectGrokLatestHistory,
  projectGrokLatestHistoryWithGeneratedImages,
  projectSelectedGrokHistoryPageWithGeneratedImages,
  projectSelectedGrokLatestHistoryWithGeneratedImages,
} from "../../src/server/backends/grok/grok-normalized-history.js";
import {
  grokSubmissionPromptId,
  grokSubmissionPromptIdReadCandidates,
  type GrokSubmissionCorrelationScope,
} from "../../src/server/backends/grok/grok-submission-correlation.js";
import type { OutputArtifactPublisher } from "../../src/server/output-artifacts/contracts.js";
import { DomainError } from "../../src/server/domain/errors.js";
import {
  backendItemSchema,
  MAXIMUM_BACKEND_ITEMS_PER_TURN,
} from "../../src/shared/protocol/backend.js";
import {
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../src/shared/protocol/payload.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const correlationScope: GrokSubmissionCorrelationScope = Object.freeze({
  installationKey: new Uint8Array(32).fill(0x47),
  tenantId: "tenant-grok",
  principalId: "principal-grok",
  backendInstanceId: "grok-backend",
  connectionProfileId: "grok-connection",
  executionEnvironmentId: "10000000-0000-4000-8000-000000000081",
  nativeNamespaceKey: "grok:test-native",
  canonicalWorkspacePath: "/workspace/project",
  sessionId: "session-1",
});

describe("Grok normalized authoritative history", () => {
  it("preserves long Unicode user and assistant blocks through live and retained projection", () => {
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native", sessionId: "session-1",
    });
    projector.sealReplay();
    const userText = "user 雪🙂\n".repeat(10_000);
    const chunks = ["assistant 雪🙂\n".repeat(10_000), "after the former cutoff"];
    const records: GrokHistoryRecord[] = [];
    for (const [index, [kind, text]] of [
      ["user_message_chunk", userText],
      ...chunks.map((text) => ["agent_message_chunk", text]),
    ].entries()) {
      const notification = update(kind as "user_message_chunk" | "agent_message_chunk", `text-${index}`, text!, "p1");
      notification._meta = { eventId: `text-${index}`, promptId: "p1" };
      const result = projector.ingestStandard(notification);
      expect(result.kind).toBe("accepted");
      if (result.kind === "accepted" && result.record) records.push(result.record);
    }
    for (const history of [records, projector.records()]) {
      const snapshot = projectGrokLatestHistory(history).snapshot;
      const items = Object.values(snapshot.itemsById);
      expect(items.find((item) => item.semanticKind === "user_message")).toMatchObject({
        content: [{ kind: "text", text: { text: userText } }],
      });
      const assistant = items.find((item) => item.semanticKind === "assistant_message");
      expect(assistant).toMatchObject({ markdown: { text: chunks.join("") } });
      // ACP chunks do not classify commentary versus final response text.
      expect(assistant).not.toHaveProperty("responsePhase");
      expect(backendItemSchema.safeParse(assistant).success).toBe(true);
    }
  });

  it("uses prompt/block evidence for stable turns and coalesced items", () => {
    const completedAtMs = Date.UTC(2026, 7, 16, 20, 15, 30);
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    projector.ingestStandard(update("user_message_chunk", "u1", "hel", "p1"));
    projector.ingestStandard(update("user_message_chunk", "u2", "lo", "p1"));
    projector.ingestStandard(
      update("agent_message_chunk", "a1", "world", "p1"),
    );
    projector.ingestSourceCandidateTurnCompleted({
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p1",
        stop_reason: "end_turn",
      },
      _meta: {
        eventId: "t1",
        promptId: "p1",
        isReplay: true,
        agentTimestampMs: completedAtMs,
      },
    });
    projector.sealReplay();

    const first = projectGrokLatestHistory(projector.records()).snapshot;
    const second = projectGrokLatestHistory(projector.records()).snapshot;
    expect(first).toEqual(second);
    // A terminal prompt outcome cannot identify which ACP text was the final answer.
    expect(Object.values(first.itemsById).find(item => item.semanticKind === "assistant_message"))
      .not.toHaveProperty("responsePhase");
    expect(first).toMatchObject({
      runState: "idle",
      orderedBackendTurnIds: [expect.stringMatching(/^grok-turn:/u)],
    });
    expect(first.turnsById[first.orderedBackendTurnIds[0]!]?.completedAt).toBe(
      "2026-08-16T20:15:30.000Z",
    );
    expect(Object.values(first.itemsById)).toMatchObject([
      {
        semanticKind: "user_message",
        content: [{ kind: "text", text: { text: "hello" } }],
      },
      { semanticKind: "assistant_message", markdown: { text: "world" } },
    ]);
  });

  it("projects a parent-side subagent spawn as normalized collaboration", () => {
    const history = records((projector) => {
      projector.ingestStandard(
        update("user_message_chunk", "u1", "review this", "p1"),
      );
      projector.ingestSubagentEvent({
        kind: "spawned",
        sessionId: "session-1",
        subagentId: "private-child-id",
        childSessionId: "private-child-id",
        parentSessionId: "session-1",
        parentPromptId: "p1",
        subagentType: "reviewer",
        description: "Review the latest commit",
        eventId: "spawn-1",
        replay: true,
      });
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "done", "p1"),
      );
      complete(projector, "p1", "t1");
    });

    const snapshot = projectGrokLatestHistory(history).snapshot;
    expect(Object.values(snapshot.itemsById)).toMatchObject([
      { semanticKind: "user_message" },
      {
        semanticKind: "collaboration",
        status: "streaming",
        action: "spawn",
        agentLabel: { text: "reviewer" },
        summary: { text: "Review the latest commit" },
      },
      { semanticKind: "assistant_message" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-child-id");

    const replay = records((projector) => {
      projector.ingestStandard(
        update("user_message_chunk", "replay-u", "review this", "p1"),
      );
      projector.ingestSubagentEvent({
        kind: "spawned",
        sessionId: "session-1",
        subagentId: "private-child-id",
        childSessionId: "private-child-id",
        parentSessionId: "session-1",
        parentPromptId: "p1",
        subagentType: "reviewer",
        description: "Review the latest commit",
        eventId: "replay-spawn",
        replay: true,
      });
      projector.ingestStandard(
        update("agent_message_chunk", "replay-a", "done", "p1"),
      );
      complete(projector, "p1", "replay-t");
    });
    const replaySnapshot = projectGrokLatestHistory(replay).snapshot;
    const collaborationId = Object.values(snapshot.itemsById).find(
      (item) => item.semanticKind === "collaboration",
    )?.backendItemId;
    const replayCollaborationId = Object.values(replaySnapshot.itemsById).find(
      (item) => item.semanticKind === "collaboration",
    )?.backendItemId;
    expect(replayCollaborationId).toBe(collaborationId);
  });

  it("projects failed subagent settlement through the common collaboration contract", () => {
    const history = records((projector) => {
      projector.ingestSubagentEvent({
        kind: "spawned",
        sessionId: "session-1",
        subagentId: "private-child-id",
        childSessionId: "private-child-id",
        parentSessionId: "session-1",
        parentPromptId: "p1",
        subagentType: "reviewer",
        description: "Review the latest commit",
        eventId: "spawn-1",
        replay: true,
      });
      projector.ingestSubagentEvent({
        kind: "finished",
        sessionId: "session-1",
        subagentId: "private-child-id",
        childSessionId: "private-child-id",
        eventId: "finish-1",
        replay: true,
        outcome: "failed",
        error: "Review failed",
        toolCalls: 2,
        turns: 1,
        durationMs: 20,
        tokensUsed: 4,
        willWake: false,
      });
      complete(projector, "p1", "t1");
    });
    expect(
      Object.values(projectGrokLatestHistory(history).snapshot.itemsById).find(
        (item) => item.semanticKind === "collaboration",
      ),
    ).toMatchObject({
      semanticKind: "collaboration",
      status: "failed",
      action: "result",
      summary: { text: "Review failed" },
      error: { category: "internal", code: "grok_subagent_failed" },
    });
  });

  it("projects only authenticated Sedes prompt correlation onto its turn and user item", () => {
    const applicationOperationId = "application-operation";
    const promptId = grokSubmissionPromptId({
      ...correlationScope,
      applicationOperationId,
      reconciliationToken: "reconciliation-token",
    });
    const history = records((projector) => {
      projector.ingestStandard(
        update("user_message_chunk", "u1", "hello", promptId),
      );
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "world", promptId),
      );
      complete(projector, promptId, "t1");
    });

    const snapshot = projectGrokLatestHistory(
      history,
      correlationScope,
    ).snapshot;
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    expect(turn.completionCorrelations).toEqual([applicationOperationId]);
    expect(
      turn.orderedBackendItemIds.map((itemId) => {
        const item = snapshot.itemsById[itemId];
        return item?.semanticKind === "user_message"
          ? item.deliveryOperationId
          : undefined;
      }),
    ).toEqual([applicationOperationId, undefined]);
    expect(
      projectGrokHistoryPage(history, { limit: 10 }, correlationScope)
        .turnsById[turn.backendTurnId]?.completionCorrelations,
    ).toEqual([applicationOperationId]);
  });

  it("preserves authenticated operation correlation from pre-rename prompt history", () => {
    const applicationOperationId = "legacy-application-operation";
    const legacyPromptId = grokSubmissionPromptIdReadCandidates({
      ...correlationScope,
      applicationOperationId,
      reconciliationToken: "legacy-reconciliation-token",
    })[1];
    const history = records((projector) => {
      projector.ingestStandard(
        update("user_message_chunk", "legacy-u1", "hello", legacyPromptId),
      );
      projector.ingestStandard(
        update("agent_message_chunk", "legacy-a1", "world", legacyPromptId),
      );
      complete(projector, legacyPromptId, "legacy-t1");
    });

    const snapshot = projectGrokLatestHistory(
      history,
      correlationScope,
    ).snapshot;
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    expect(turn.completionCorrelations).toEqual([applicationOperationId]);
    expect(snapshot.itemsById[turn.orderedBackendItemIds[0]!]).toMatchObject({
      deliveryOperationId: applicationOperationId,
    });
  });

  it("synthesizes an enrichable user item when replay contains only attachment echoes", () => {
    const applicationOperationId = "attachment-only-operation";
    const promptId = grokSubmissionPromptId({
      ...correlationScope,
      applicationOperationId,
      reconciliationToken: "attachment-only-token",
    });
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: correlationScope.nativeNamespaceKey,
      sessionId: correlationScope.sessionId,
    });
    projector.ingestStandard({
      sessionId: correlationScope.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "image",
          mimeType: "image/png",
          data: "cmF3LWltYWdlLXNlbnRpbmVs",
        },
      },
      _meta: { eventId: "image-echo", promptId, isReplay: true },
    });
    projector.ingestStandard({
      sessionId: correlationScope.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "resource_link",
          name: "remote.txt",
          uri: "file:///remote/private/staged-path.txt",
          mimeType: "application/octet-stream",
          size: 12,
        },
      },
      _meta: { eventId: "resource-echo", promptId, isReplay: true },
    });
    projector.ingestStandard(
      update("agent_message_chunk", "agent", "done", promptId),
    );
    complete(projector, promptId, "terminal");
    projector.sealReplay();

    const snapshot = projectGrokLatestHistory(
      projector.records(),
      correlationScope,
    ).snapshot;
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    expect(
      turn.orderedBackendItemIds.map((id) => snapshot.itemsById[id]),
    ).toMatchObject([
      {
        semanticKind: "user_message",
        deliveryOperationId: applicationOperationId,
        status: "completed",
        sourceOrder: 0,
        content: [{ kind: "text", text: { text: "" } }],
      },
      { semanticKind: "assistant_message", sourceOrder: 1 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("cmF3LWltYWdlLXNlbnRpbmVs");
    expect(JSON.stringify(snapshot)).not.toContain("staged-path.txt");
  });

  it("rejects malformed, forged, unscoped, and wrong-session Sedes prompt evidence", () => {
    const promptId = grokSubmissionPromptId({
      ...correlationScope,
      applicationOperationId: "application-operation",
      reconciliationToken: "reconciliation-token",
    });
    const historyFor = (candidate: string) =>
      records((projector) => {
        projector.ingestStandard(
          update("user_message_chunk", "u1", "hello", candidate),
        );
        complete(projector, candidate, "t1");
      });

    expect(() => projectGrokLatestHistory(historyFor(promptId))).toThrow(
      "grok_normalized_history_invalid",
    );
    expect(() =>
      projectGrokLatestHistory(historyFor(promptId), {
        ...correlationScope,
        canonicalWorkspacePath: "/workspace/other",
      }),
    ).toThrow("grok_normalized_history_invalid");
    expect(() =>
      projectGrokLatestHistory(historyFor(promptId), {
        ...correlationScope,
        sessionId: "other-session",
      }),
    ).toThrow("grok_normalized_history_invalid");
    expect(() =>
      projectGrokLatestHistory(
        historyFor("sedes-grok:v2:malformed"),
        correlationScope,
      ),
    ).toThrow("grok_normalized_history_invalid");
  });

  it("keeps normalized item IDs stable when replay rechunks with new event IDs", () => {
    const project = (
      prefix: string,
      userChunks: readonly string[],
      assistantChunks: readonly string[],
    ) => {
      const projector = new GrokHistoryProjector({
        nativeNamespaceKey: "grok:test-native",
        sessionId: "session-1",
      });
      userChunks.forEach((text, index) =>
        projector.ingestStandard(
          update("user_message_chunk", `${prefix}-u${index}`, text, "p1"),
        ),
      );
      assistantChunks.forEach((text, index) =>
        projector.ingestStandard(
          update("agent_message_chunk", `${prefix}-a${index}`, text, "p1"),
        ),
      );
      complete(projector, "p1", `${prefix}-terminal`);
      projector.sealReplay();
      return projectGrokLatestHistory(projector.records()).snapshot;
    };
    const live = project("live", ["hel", "lo"], ["wor", "ld"]);
    const replay = project("replay", ["hello"], ["world"]);
    const liveTurn = live.turnsById[live.orderedBackendTurnIds[0]!]!;
    const replayTurn = replay.turnsById[replay.orderedBackendTurnIds[0]!]!;
    expect(replayTurn.orderedBackendItemIds).toEqual(
      liveTurn.orderedBackendItemIds,
    );
    expect(replay.itemsById).toEqual(live.itemsById);
  });

  it("keeps one final unterminated prompt active and rejects guessed or unknown meanings", () => {
    const inProgress = records((projector) => {
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "partial", "p1"),
      );
    });
    const active = projectGrokLatestHistory(inProgress).snapshot;
    const activeTurn = active.turnsById[active.orderedBackendTurnIds[0]!]!;
    expect(active).toMatchObject({ runState: "running" });
    expect(activeTurn).toMatchObject({ status: "in_progress" });
    expect(activeTurn).not.toHaveProperty("endedBy");

    const missingPrompt = [
      {
        ...inProgress[0]!,
        identity: {
          nativeNamespaceKey: inProgress[0]!.identity.nativeNamespaceKey,
          eventId: inProgress[0]!.identity.eventId,
          blockId: inProgress[0]!.identity.blockId,
          blockOccurrence: inProgress[0]!.identity.blockOccurrence,
        },
      },
    ];
    expect(() => projectGrokLatestHistory(missingPrompt)).toThrow(
      "grok_normalized_history_invalid",
    );

    const unknownTerminal = records((projector) => {
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "answer", "p1"),
      );
      projector.ingestSourceCandidateTurnCompleted({
        sessionId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "future_reason",
        },
        _meta: { eventId: "t1", promptId: "p1", isReplay: true },
      });
    });
    expect(() => projectGrokLatestHistory(unknownTerminal)).toThrow(
      "grok_normalized_history_invalid",
    );
  });

  it("projects one final promptless user replay run as an uncorrelated active turn", () => {
    const history = records((projector) => {
      projector.ingestStandard(update("user_message_chunk", "u1", "first "));
      projector.ingestStandard(update("user_message_chunk", "u2", "message"));
    });

    const first = projectGrokLatestHistory(history).snapshot;
    const second = projectGrokLatestHistory(history).snapshot;
    const turn = first.turnsById[first.orderedBackendTurnIds[0]!]!;
    expect(second).toEqual(first);
    expect(first).toMatchObject({ runState: "running" });
    expect(turn).toMatchObject({ status: "in_progress" });
    expect(turn).not.toHaveProperty("completionCorrelations");
    expect(Object.values(first.itemsById)).toMatchObject([
      {
        semanticKind: "user_message",
        content: [{ kind: "text", text: { text: "first message" } }],
      },
    ]);
  });

  it("binds older-history cursors to the exact native transcript", () => {
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
      retainedCompletedPromptWindow: 20,
    });
    for (let index = 0; index < 12; index += 1) {
      projector.ingestStandard(
        update(
          "agent_message_chunk",
          `a${index}`,
          `answer-${index}`,
          `p${index}`,
        ),
      );
      complete(projector, `p${index}`, `t${index}`);
    }
    projector.sealReplay();
    const history = projector.records();
    const latest = projectGrokLatestHistory(history);
    expect(latest.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(latest.previousCursor).toBeDefined();
    const older = projectGrokHistoryPage(history, {
      cursor: latest.previousCursor,
      limit: 10,
    });
    expect(older.orderedBackendTurnIds).toHaveLength(2);
    projector.ingestStandard({
      ...update("agent_message_chunk", "live-a", "streaming", "p12"),
      _meta: { eventId: "live-a", promptId: "p12" },
    });
    const withActiveTail = projector.records();
    expect(
      projectGrokHistoryPage(withActiveTail, {
        cursor: latest.previousCursor,
        limit: 10,
      }).orderedBackendTurnIds,
    ).toEqual(older.orderedBackendTurnIds);
    expect(() =>
      projectGrokHistoryPage(history.slice(1), {
        cursor: latest.previousCursor,
        limit: 10,
      }),
    ).toThrow("grok_normalized_history_cursor_invalid");
  });

  it("binds cursors to exact text in older turns outside the visible window", () => {
    const build = (suffix: string) => {
      const projector = new GrokHistoryProjector({
        nativeNamespaceKey: "grok:test-native",
        sessionId: "session-1",
        retainedCompletedPromptWindow: 20,
      });
      for (let index = 0; index < 11; index += 1) {
        projector.ingestStandard(
          update(
            "agent_message_chunk",
            `answer-${index}`,
            index === 0 ? `${"x".repeat(20_000)}${suffix}` : `answer ${index}`,
            `p${index}`,
          ),
        );
        complete(projector, `p${index}`, `terminal-${index}`);
      }
      projector.sealReplay();
      return projectGrokLatestHistory(projector.records());
    };
    const first = build("A");
    const second = build("B");
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.previousCursor).not.toBe(second.previousCursor);
  });

  it("coalesces source chunks while rejecting text above the shared message limit", () => {
    const manyChunks: GrokHistoryRecord[] = Array.from(
      { length: 10_001 },
      (_, index) =>
        syntheticTextRecord({
          id: `chunk-${index}`,
          promptId: "many-chunks",
          blockId: "coalesced",
          text: "x",
        }),
    );
    manyChunks.push(syntheticTerminalRecord("many-chunks"));
    expect(
      projectGrokLatestHistory(manyChunks).snapshot.orderedBackendTurnIds,
    ).toHaveLength(1);

    const sourceOverSixteenMiB = [
      syntheticTextRecord({
        id: "large-source",
        promptId: "large-source",
        blockId: "large-source",
        text: "x".repeat(MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES + 1),
      }),
      syntheticTerminalRecord("large-source"),
    ];
    expect(() => projectGrokLatestHistory(sourceOverSixteenMiB)).toThrow(
      "normalized_payload_exceeds_serialized_byte_limit",
    );
  });

  it("uses the shared per-turn item contract", () => {
    const accepted = syntheticHistory(1, MAXIMUM_BACKEND_ITEMS_PER_TURN, "x");
    const snapshot = projectGrokLatestHistory(accepted).snapshot;
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    expect(turn.orderedBackendItemIds).toHaveLength(
      MAXIMUM_BACKEND_ITEMS_PER_TURN,
    );

    expect(() =>
      projectGrokLatestHistory(
        syntheticHistory(1, MAXIMUM_BACKEND_ITEMS_PER_TURN + 1, "x"),
      ),
    ).toThrow("grok_normalized_history_too_large");
  }, 15_000);

  it("selects a byte-adaptive latest whole-turn suffix with its actual omitted boundary", () => {
    const history = syntheticHistory(10, 110, "x".repeat(65_536));
    const allTurnIds = projectGrokHistoryPage(syntheticHistory(10, 1, "x"), {
      limit: 100,
    }).orderedBackendTurnIds;
    const latest = projectGrokLatestHistory(history);
    const page = projectGrokHistoryPage(history, { limit: 100 });

    expect(latest.snapshot.orderedBackendTurnIds.length).toBeGreaterThan(0);
    expect(latest.snapshot.orderedBackendTurnIds.length).toBeLessThan(10);
    expect(serializedUtf8Bytes(latest.snapshot)).toBeLessThanOrEqual(
      MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(latest.previousCursor).toBeDefined();
    expect(page.orderedBackendTurnIds.length).toBeGreaterThan(0);
    expect(page.orderedBackendTurnIds.length).toBeLessThan(10);
    expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(
      MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(page.previousCursor).toBeDefined();

    expect(page.orderedBackendTurnIds).toEqual(latest.snapshot.orderedBackendTurnIds);
    expect(page.previousCursor).toBe(latest.previousCursor);
    const loadedTurnIds = [...page.orderedBackendTurnIds];
    let cursor = page.previousCursor;
    while (cursor) {
      const older = projectGrokHistoryPage(history, { cursor, limit: 100 });
      expect(older.orderedBackendTurnIds.length).toBeGreaterThan(0);
      expect(serializedUtf8Bytes(older)).toBeLessThanOrEqual(MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES);
      loadedTurnIds.unshift(...older.orderedBackendTurnIds);
      cursor = older.previousCursor;
    }
    expect(loadedTurnIds).toEqual(allTurnIds);
  }, 30_000);

  it("rejects one oversized whole turn without splitting it", () => {
    const history = syntheticHistory(1, 1_100, "x".repeat(65_536));
    expect(() => projectGrokLatestHistory(history)).toThrow(
      "grok_normalized_history_too_large",
    );
    expect(() => projectGrokHistoryPage(history, { limit: 100 })).toThrow(
      "grok_normalized_history_too_large",
    );
  });

  it("validates provider-acquired latest and cursor-page limits", async () => {
    const context = emptyGeneratedImageContext();
    await expect(
      projectSelectedGrokHistoryPageWithGeneratedImages(
        [],
        { limit: 0, previousCursorByPromptId: {} },
        undefined,
        context,
      ),
    ).rejects.toThrow("grok_normalized_history_cursor_invalid");
    await expect(
      projectSelectedGrokHistoryPageWithGeneratedImages(
        [],
        {
          limit: 101,
          previousCursor: "provider-page-cursor",
          previousCursorByPromptId: {},
        },
        undefined,
        context,
      ),
    ).rejects.toThrow("grok_normalized_history_cursor_invalid");
  });

  it("locates across every retained identity without whole-page limits", async () => {
    const history = syntheticHistory(101, 1, "x");
    let visited = 0;
    const located = await locateGrokHistoryTurnWithGeneratedImages(
      history,
      {
        matchesBackendTurnId: () => {
          visited += 1;
          return visited === 101;
        },
        maximumTurnCandidates: 101,
      },
      undefined,
      emptyGeneratedImageContext(),
    );

    expect(visited).toBe(101);
    expect(located).toMatchObject({
      inspectedTurnCount: 101,
      retainedTurnCount: 101,
      page: { orderedBackendTurnIds: [expect.any(String)] },
    });
    expect(located.page).not.toHaveProperty("previousCursor");

    const bounded = await locateGrokHistoryTurnWithGeneratedImages(
      history,
      {
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 100,
      },
      undefined,
      emptyGeneratedImageContext(),
    );
    expect(bounded).toEqual({
      inspectedTurnCount: 100,
      retainedTurnCount: 101,
    });
  });

  it("byte-adapts provider-acquired pages and returns the exact selected prompt cursor", async () => {
    const history = syntheticHistory(10, 110, "x".repeat(65_536));
    const allTurnIds = projectGrokHistoryPage(syntheticHistory(10, 1, "x"), {
      limit: 100,
    }).orderedBackendTurnIds;
    const previousCursorByPromptId = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `synthetic-prompt-${index}`,
        `provider-before-${index}`,
      ]),
    );
    const page = await projectSelectedGrokHistoryPageWithGeneratedImages(
      history,
      {
        limit: 100,
        previousCursor: "provider-before-page",
        previousCursorByPromptId,
      },
      undefined,
      emptyGeneratedImageContext(),
    );

    expect(page.orderedBackendTurnIds.length).toBeGreaterThan(0);
    expect(page.orderedBackendTurnIds.length).toBeLessThan(10);
    expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(
      MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
    );
    const selectedStart = allTurnIds.indexOf(page.orderedBackendTurnIds[0]!);
    expect(selectedStart).toBeGreaterThan(0);
    expect(page.previousCursor).toBe(`provider-before-${selectedStart}`);
    expect(page.previousCursor).not.toBe("provider-before-page");
  }, 10_000);

  it("returns a provider-native cursor for the exact oldest selected latest turn", async () => {
    const history = syntheticHistory(10, 1, "x");
    const previousCursorByPromptId = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `synthetic-prompt-${index}`,
        `provider-before-${index}`,
      ]),
    );
    const projection =
      await projectSelectedGrokLatestHistoryWithGeneratedImages(
        history,
        { previousCursorByPromptId },
        undefined,
        emptyGeneratedImageContext(),
      );

    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(projection.previousCursor).toBe("provider-before-0");
    expect(projection.previousCursor).not.toMatch(/^grok-history:/u);
  });

  it("rejects an oversized provider-acquired turn as a request-local error", async () => {
    await expect(
      projectSelectedGrokHistoryPageWithGeneratedImages(
        syntheticHistory(1, 1_100, "x".repeat(65_536)),
        {
          limit: 100,
          previousCursor: "provider-before-page",
          previousCursorByPromptId: {},
        },
        undefined,
        emptyGeneratedImageContext(),
      ),
    ).rejects.toThrow("grok_normalized_history_too_large");
  });

  it("retains delayed same-prompt evidence after a terminal and rejects non-contiguous prompts", () => {
    const afterTerminal = records((projector) => {
      projector.ingestStandard(update("user_message_chunk", "u1", "go", "p1"));
      complete(projector, "p1", "t2", "cancelled");
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "delayed", "p1"),
      );
    });
    const afterTerminalSnapshot =
      projectGrokLatestHistory(afterTerminal).snapshot;
    const afterTerminalTurn =
      afterTerminalSnapshot.turnsById[
        afterTerminalSnapshot.orderedBackendTurnIds[0]!
      ]!;
    expect(afterTerminalTurn).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(
      afterTerminalTurn.orderedBackendItemIds.map(
        (itemId) => afterTerminalSnapshot.itemsById[itemId],
      ),
    ).toMatchObject([
      { semanticKind: "user_message", status: "completed" },
      {
        semanticKind: "assistant_message",
        status: "completed",
        markdown: { text: "delayed" },
      },
    ]);

    const unterminatedBeforeNext = records((projector) => {
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "first", "p1"),
      );
      projector.ingestStandard(
        update("agent_message_chunk", "a2", "second", "p2"),
      );
      complete(projector, "p2", "t2");
    });
    expect(() => projectGrokLatestHistory(unterminatedBeforeNext)).toThrow(
      "grok_normalized_history_invalid",
    );

    const applicationOperationId = "abandoned-operation";
    const authenticatedPromptId = grokSubmissionPromptId({
      ...correlationScope,
      applicationOperationId,
      reconciliationToken: "abandoned-reconciliation",
    });
    const abandonedBeforeNextUser = records((projector) => {
      projector.ingestStandard(
        update(
          "user_message_chunk",
          "abandoned-user",
          "first",
          authenticatedPromptId,
        ),
      );
      projector.ingestStandard(
        update(
          "agent_message_chunk",
          "abandoned-assistant",
          "partial",
          authenticatedPromptId,
        ),
      );
      projector.ingestStandard(
        update("user_message_chunk", "next-user", "second", "native-prompt"),
      );
      projector.ingestStandard(
        update(
          "agent_message_chunk",
          "next-assistant",
          "complete",
          "native-prompt",
        ),
      );
      complete(projector, "native-prompt", "next-terminal");
    });
    const recovered = projectGrokLatestHistory(
      abandonedBeforeNextUser,
      correlationScope,
    ).snapshot;
    const [abandonedTurnId, nextTurnId] = recovered.orderedBackendTurnIds;
    expect(recovered).toMatchObject({ runState: "idle" });
    expect(recovered.turnsById[abandonedTurnId!]).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
      completionCorrelations: [applicationOperationId],
    });
    expect(recovered.turnsById[nextTurnId!]).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
    });
    expect(() => projectGrokLatestHistory(abandonedBeforeNextUser)).toThrow(
      "grok_normalized_history_invalid",
    );
    expect(() =>
      projectGrokLatestHistory(abandonedBeforeNextUser, {
        ...correlationScope,
        canonicalWorkspacePath: "/workspace/other",
      }),
    ).toThrow("grok_normalized_history_invalid");
    expect(() =>
      projectGrokLatestHistory(
        abandonedBeforeNextUser.map((record, index) =>
          index === 0 ? { ...record, replay: false } : record,
        ),
        correlationScope,
      ),
    ).toThrow("grok_normalized_history_invalid");
    expect(() =>
      projectGrokLatestHistory(
        abandonedBeforeNextUser.map((record, index) =>
          index === 2 ? { ...record, replay: false } : record,
        ),
        correlationScope,
      ),
    ).toThrow("grok_normalized_history_invalid");

    const recurrentPrompt = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    expect(
      recurrentPrompt.ingestStandard(
        update("agent_message_chunk", "a1", "first", "p1"),
      ),
    ).toMatchObject({ kind: "accepted" });
    complete(recurrentPrompt, "p1", "t1");
    expect(
      recurrentPrompt.ingestStandard(
        update("agent_message_chunk", "a2", "second", "p2"),
      ),
    ).toMatchObject({ kind: "accepted" });
    complete(recurrentPrompt, "p2", "t2");
    expect(
      recurrentPrompt.ingestStandard(
        update("agent_message_chunk", "a3", "recurrent", "p1"),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "resnapshot_required",
        reason: "noncontiguous_prompt_history",
      }),
    );
  });

  it("retains contiguous same-prompt records after a terminal without reopening the turn", () => {
    const durableInterrupted = records((projector) => {
      projector.ingestStandard(
        update("user_message_chunk", "cancel-user", "stop this", "p1"),
      );
      complete(projector, "p1", "cancel-terminal", "cancelled");
      projector.ingestStandard(
        update(
          "agent_thought_chunk",
          "cancel-late-reasoning",
          "cleanup after cancellation",
          "p1",
        ),
      );
    });
    const snapshot = projectGrokLatestHistory(durableInterrupted).snapshot;
    const turnId = snapshot.orderedBackendTurnIds[0]!;
    expect(snapshot).toMatchObject({ runState: "idle" });
    expect(snapshot.turnsById[turnId]).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(Object.values(snapshot.itemsById)).toMatchObject([
      { semanticKind: "user_message", status: "completed" },
      {
        semanticKind: "reasoning",
        status: "completed",
        markdown: { text: "cleanup after cancellation" },
      },
    ]);

    const accepted = [
      records((projector) => {
        complete(projector, "p1", "end-terminal");
        projector.ingestStandard(
          update("agent_thought_chunk", "end-late-reasoning", "late", "p1"),
        );
      }),
      records((projector) => {
        complete(projector, "p1", "assistant-terminal", "cancelled");
        projector.ingestStandard(
          update("agent_message_chunk", "late-assistant", "late", "p1"),
        );
      }),
      records((projector) => {
        complete(projector, "p1", "user-terminal", "cancelled");
        projector.ingestStandard(
          update("user_message_chunk", "late-user", "late", "p1"),
        );
      }),
      records((projector) => {
        complete(projector, "p1", "tool-terminal", "cancelled");
        projector.ingestStandard(tool("late-tool", "p1", { status: "failed" }));
      }),
      records((projector) => {
        complete(projector, "p1", "live-terminal", "cancelled");
        const live = update(
          "agent_thought_chunk",
          "live-late-reasoning",
          "late",
          "p1",
        );
        projector.ingestStandard({
          ...live,
          _meta: { eventId: "live-late-reasoning", promptId: "p1" },
        });
      }),
    ];
    for (const history of accepted) {
      expect(() => projectGrokLatestHistory(history)).not.toThrow();
    }

    const crossPrompt = records((projector) => {
      complete(projector, "p1", "cross-terminal", "cancelled");
      projector.ingestStandard(
        update("agent_thought_chunk", "cross-reasoning", "late", "p2"),
      );
    });
    expect(() => projectGrokLatestHistory(crossPrompt)).toThrow(
      "grok_normalized_history_invalid",
    );
  });

  it("rejects mixed native session or namespace evidence", () => {
    const valid = records((projector) => {
      projector.ingestStandard(
        update("agent_message_chunk", "a1", "answer", "p1"),
      );
      complete(projector, "p1", "t1");
    });
    expect(() =>
      projectGrokLatestHistory([
        valid[0]!,
        { ...valid[1]!, sessionId: "other-session" },
      ]),
    ).toThrow("grok_normalized_history_invalid");
    expect(() =>
      projectGrokLatestHistory([
        valid[0]!,
        {
          ...valid[1]!,
          identity: {
            ...valid[1]!.identity,
            nativeNamespaceKey: "grok:other-native",
          },
        },
      ]),
    ).toThrow("grok_normalized_history_invalid");
  });

  it("projects structurally evidenced Grok reads through the normalized file-read contract", () => {
    const history = records((projector) => {
      projector.ingestStandard(
        tool("start", "p1", {
          title: "Inspect repository file",
          name: "read_file",
          kind: "read",
          status: "in_progress",
          rawInput: { target_file: "src/example.ts", offset: 9, limit: 1 },
          locations: [{ path: "src/example.ts", line: 9 }],
          _meta: {
            "x.ai/tool": {
              version: 1,
              name: "read_file",
              kind: "read",
              namespace: "grok_build",
              label: "Read",
              read_only: true,
              input: { path: "src/example.ts", offset: 9, limit: 1 },
            },
          },
        }),
      );
      projector.ingestStandard(
        tool("finish", "p1", {
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "contents" },
            },
            {
              type: "diff",
              path: "src/example.ts",
              oldText: "old",
              newText: "new",
            },
          ],
          rawOutput: { bytes: 8 },
        }),
      );
      complete(projector, "p1", "terminal");
    });
    const snapshot = projectGrokLatestHistory(history).snapshot;
    const item = Object.values(snapshot.itemsById).find(
      (candidate) => candidate.semanticKind === "file_read",
    );
    expect(item).toMatchObject({
      semanticKind: "file_read",
      status: "completed",
      phase: "completed",
      path: { text: "src/example.ts" },
      range: { startLine: 9, endLine: 9 },
      contentPreview: { text: "contents" },
    });
    expect(() => backendItemSchema.parse(item)).not.toThrow();
    expect(JSON.stringify(item)).toContain("src/example.ts");
    expect(projectGrokHistoryPage(history, { limit: 10 }).itemsById).toEqual(
      snapshot.itemsById,
    );
  });

  it("projects structurally evidenced file-change, web-search, and MCP variants without native envelopes", () => {
    const project = (patch: Record<string, unknown>) => {
      const history = records((projector) => {
        projector.ingestStandard(tool("tool", "p1", patch));
        complete(projector, "p1", "terminal");
      });
      const item = Object.values(
        projectGrokLatestHistory(history).snapshot.itemsById,
      ).find((candidate) => candidate.semanticKind !== "user_message")!;
      expect(() => backendItemSchema.parse(item)).not.toThrow();
      return item;
    };

    const fileChange = project({
      title: "Edit file",
      name: "search_replace",
      kind: "edit",
      status: "completed",
      rawInput: {
        file_path: "src/app.ts",
        old_string: "old",
        new_string: "new",
      },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "search_replace",
          kind: "edit",
          namespace: "grok_build",
          label: "Edit",
          read_only: false,
          input: { path: "src/app.ts" },
        },
      },
    });
    expect(fileChange).toMatchObject({
      semanticKind: "file_change",
      operation: "edit",
      effect: "applied",
      path: { text: "src/app.ts" },
      replacement: {
        before: { text: "old" },
        after: { text: "new" },
      },
    });

    const fileWrite = project({
      title: "Write `/tmp/temp.file`",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/tmp/temp.file",
          oldText: "",
          newText: "hello from write tool\n",
        },
      ],
      rawInput: {
        variant: "Write",
        file_path: "/tmp/temp.file",
        content: "hello from write tool\n",
      },
      rawOutput: {
        type: "SearchReplace",
        EditsApplied: {
          old_string: "",
          new_string: "hello from write tool\n",
        },
      },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "write",
          kind: "write",
          namespace: "opencode",
          label: "Write",
          read_only: false,
          input: { path: "/tmp/temp.file" },
        },
      },
    });
    expect(fileWrite).toMatchObject({
      semanticKind: "file_change",
      operation: "write",
      effect: "applied",
      path: { text: "/tmp/temp.file" },
      contentPreview: { text: "hello from write tool\n" },
    });
    expect(fileWrite).not.toHaveProperty("replacement");

    const fileDelete = project({
      title: "Delete file",
      name: "delete_file",
      kind: "delete",
      status: "completed",
      rawInput: { path: "src/obsolete.ts" },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "delete_file",
          kind: "delete",
          namespace: "grok_build",
          label: "Delete",
          read_only: false,
          input: { path: "src/obsolete.ts" },
        },
      },
    });
    expect(fileDelete).toMatchObject({
      semanticKind: "file_change",
      operation: "delete",
      effect: "applied",
      path: { text: "src/obsolete.ts" },
    });

    const fileMove = project({
      title: "Move file",
      name: "move_file",
      kind: "move",
      status: "completed",
      rawInput: {
        path: "src/old-name.ts",
        destination_path: "src/new-name.ts",
      },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "move_file",
          kind: "move",
          namespace: "grok_build",
          label: "Move",
          read_only: false,
          input: {
            path: "src/old-name.ts",
            destination_path: "src/new-name.ts",
          },
        },
      },
    });
    expect(fileMove).toMatchObject({
      semanticKind: "file_change",
      operation: "move",
      effect: "applied",
      path: { text: "src/old-name.ts" },
      destinationPath: { text: "src/new-name.ts" },
    });

    const webSearch = project({
      title: "Web search",
      name: "web_search",
      kind: "search",
      status: "completed",
      rawInput: { query: "ACP protocol" },
      rawOutput: {
        type: "WebSearch",
        query: "ACP protocol",
        content: "Search result",
        citations: ["https://example.com"],
        allowed_domains: null,
      },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "web_search",
          kind: "web_search",
          namespace: "grok_build",
          label: "Web Search",
          read_only: true,
        },
      },
    });
    expect(webSearch).toMatchObject({
      semanticKind: "web_search",
      query: { text: "ACP protocol" },
      result: {
        content: [{ kind: "text", value: { text: "Search result" } }],
      },
    });
    expect(JSON.stringify(webSearch)).not.toContain("rawOutput");

    const mcp = project({
      title: "Create issue",
      name: "linear__create_issue",
      kind: "other",
      status: "completed",
      rawInput: { title: "Bug" },
      rawOutput: {
        type: "MCP",
        tool_name: "create_issue",
        server_name: "linear",
        output: { OkayOutput: "ISSUE-1" },
      },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "linear__create_issue",
          kind: "other",
          namespace: "mcp",
          label: "Tool",
          read_only: false,
        },
      },
    });
    expect(mcp).toMatchObject({
      semanticKind: "mcp",
      server: { text: "linear" },
      toolName: { text: "create_issue" },
      result: {
        content: [{ kind: "text", value: { text: "ISSUE-1" } }],
      },
    });
    expect(JSON.stringify(mcp)).not.toContain("server_name");
  });

  it("publishes ImageGen once and preserves durable replay after source removal while rejecting changed source bytes", async () => {
    const { history, imagePath, nativeHome } = generatedImageHistoryFixture();
    const publications = new Map<
      string,
      Awaited<ReturnType<OutputArtifactPublisher["publishImage"]>>
    >();
    let publishCount = 0;
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: (_scope, _threadId, key) => publications.get(key),
      publishImage: async (input) => {
        const existing = publications.get(input.publicationKey);
        if (
          existing &&
          (existing.sha256 !== input.expectedSha256 ||
            existing.byteSize !== input.expectedByteSize ||
            existing.mediaType !== input.mediaType)
        ) {
          throw new DomainError(
            "invalid_transition",
            "Publication identity changed.",
          );
        }
        if (existing) return existing;
        publishCount += 1;
        const descriptor = {
          artifactId: "11111111-1111-4111-8111-111111111111",
          mediaType: input.mediaType,
          byteSize: input.bytes.byteLength,
          sha256: input.expectedSha256!,
        } as const;
        publications.set(input.publicationKey, descriptor);
        return descriptor;
      },
    };
    const context = {
      scope: { tenantId: "tenant-grok", principalId: "principal-grok" },
      applicationThreadId: "thread-grok",
      outputArtifacts,
      authority: {
        nativeHome,
        canonicalWorkspacePath: correlationScope.canonicalWorkspacePath,
        sessionId: correlationScope.sessionId,
      },
    };
    const historyIterator = vi.fn(() =>
      Array.prototype[Symbol.iterator].call(history),
    );
    const countedHistory = new Proxy(history, {
      get(target, property, receiver) {
        return property === Symbol.iterator
          ? historyIterator
          : Reflect.get(target, property, receiver);
      },
    });

    const first = (
      await projectGrokLatestHistoryWithGeneratedImages(
        countedHistory,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(historyIterator).toHaveBeenCalledTimes(1);
    const replay = (
      await projectGrokLatestHistoryWithGeneratedImages(
        countedHistory,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(historyIterator).toHaveBeenCalledTimes(2);
    const page = await projectGrokHistoryPageWithGeneratedImages(
      countedHistory,
      { limit: 10 },
      correlationScope,
      context,
    );
    expect(historyIterator).toHaveBeenCalledTimes(3);
    expect(publishCount).toBe(1);
    expect(replay).toEqual(first);
    expect(page.itemsById).toEqual(first.itemsById);
    const items = first.turnsById[
      first.orderedBackendTurnIds[0]!
    ]!.orderedBackendItemIds.map((id) => first.itemsById[id]!);
    expect(items.map(({ semanticKind }) => semanticKind)).toEqual([
      "user_message",
      "tool",
      "image",
      "assistant_message",
    ]);
    expect(items[2]).toMatchObject({
      semanticKind: "image",
      image: {
        representation: "artifact",
        mimeType: "image/jpeg",
        fileName: { text: "1.jpg" },
      },
    });
    expect(items[3]).toMatchObject({
      semanticKind: "assistant_message",
      markdown: { text: "Here it is:\n\nDone." },
    });
    const encoded = JSON.stringify(first);
    expect(encoded).not.toContain(imagePath);
    expect(encoded).not.toContain("images/1.jpg");
    expect(encoded).not.toContain("session_folder");

    unlinkSync(imagePath);
    const missingSource = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(missingSource).toEqual(first);

    const changedJpeg = Buffer.from(testJpeg());
    changedJpeg[10] = 2;
    writeFileSync(imagePath, changedJpeg);
    const changedSource = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(Object.values(changedSource.itemsById)).toContainEqual(
      expect.objectContaining({
        semanticKind: "image",
        image: expect.objectContaining({
          representation: "omitted",
          reason: "invalid_data",
        }),
      }),
    );
    expect(publishCount).toBe(1);

    const storageFailureContext = {
      ...context,
      outputArtifacts: {
        findImage: () => undefined,
        publishImage: async () => {
          throw new Error("storage_unavailable");
        },
      },
    };
    const storageFailure = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        correlationScope,
        storageFailureContext,
      )
    ).snapshot;
    expect(Object.values(storageFailure.itemsById)).toContainEqual(
      expect.objectContaining({
        semanticKind: "image",
        image: expect.objectContaining({
          representation: "omitted",
          reason: "unavailable",
        }),
      }),
    );
    expect(JSON.stringify(storageFailure)).not.toContain(imagePath);

    unlinkSync(imagePath);
    const replayAfterCleanup = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(publishCount).toBe(1);
    expect(replayAfterCleanup).toEqual(first);

    const changedBytes = testJpeg();
    changedBytes[10] = changedBytes[10]! ^ 0x01;
    writeFileSync(imagePath, changedBytes);
    const replayAfterSourceChange = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        correlationScope,
        context,
      )
    ).snapshot;
    expect(Object.values(replayAfterSourceChange.itemsById)).toContainEqual(
      expect.objectContaining({
        semanticKind: "image",
        image: expect.objectContaining({
          representation: "omitted",
          reason: "invalid_data",
        }),
      }),
    );
  });

  it("settles generated-image projection promptly when its signal is aborted", async () => {
    const { history, nativeHome } = generatedImageHistoryFixture();
    let publicationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const controller = new AbortController();
    const reason = new Error("grok_projection_cancelled_for_replacement");
    const projection = projectGrokLatestHistoryWithGeneratedImages(
      history,
      correlationScope,
      {
        scope: { tenantId: "tenant-grok", principalId: "principal-grok" },
        applicationThreadId: "thread-grok",
        outputArtifacts: {
          findImage: () => undefined,
          publishImage: async () => {
            publicationStarted();
            return await new Promise<never>(() => undefined);
          },
        },
        authority: {
          nativeHome,
          canonicalWorkspacePath: correlationScope.canonicalWorkspacePath,
          sessionId: correlationScope.sessionId,
        },
      },
      controller.signal,
    );

    await started;
    controller.abort(reason);

    await expect(projection).rejects.toBe(reason);
  });

  it("keeps generated-image publication state page-scoped across many old pages", async () => {
    const { nativeHome } = generatedImageHistoryFixture();
    const publications = new Map<
      string,
      Awaited<ReturnType<OutputArtifactPublisher["publishImage"]>>
    >();
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: (_scope, _threadId, key) => publications.get(key),
      publishImage: async (input) => {
        const existing = publications.get(input.publicationKey);
        if (existing) return existing;
        const descriptor = {
          artifactId: `11111111-1111-4111-8111-${String(publications.size).padStart(12, "0")}`,
          mediaType: input.mediaType,
          byteSize: input.bytes.byteLength,
          sha256: input.expectedSha256!,
        } as const;
        publications.set(input.publicationKey, descriptor);
        return descriptor;
      },
    };
    const context = Object.freeze({
      scope: { tenantId: "tenant-grok", principalId: "principal-grok" },
      applicationThreadId: "thread-grok",
      outputArtifacts,
      authority: {
        nativeHome,
        canonicalWorkspacePath: correlationScope.canonicalWorkspacePath,
        sessionId: correlationScope.sessionId,
      },
    });
    const contextKeys = Reflect.ownKeys(context);

    for (let index = 0; index < 40; index += 1) {
      const fileName = `${index + 1}.jpg`;
      const imagePath = path.join(
        nativeHome,
        "sessions",
        encodeURIComponent(correlationScope.canonicalWorkspacePath),
        correlationScope.sessionId,
        "images",
        fileName,
      );
      writeFileSync(imagePath, testJpeg());
      const promptId = grokSubmissionPromptId({
        ...correlationScope,
        applicationOperationId: `old-image-page-${index}`,
        reconciliationToken: `old-image-token-${index}`,
      });
      const pageHistory = records((projector) => {
        projector.ingestStandard(
          update("user_message_chunk", `user-${index}`, "image", promptId),
        );
        projector.ingestStandard(
          tool(`image-${index}`, promptId, {
            title: "image_gen",
            status: "completed",
            rawOutput: {
              type: "ImageGen",
              path: imagePath,
              filename: fileName,
              session_folder: "images",
            },
          }),
        );
        complete(projector, promptId, `terminal-${index}`);
      });

      const page = await projectGrokHistoryPageWithGeneratedImages(
        pageHistory,
        { limit: 1 },
        correlationScope,
        context,
      );
      expect(Object.values(page.itemsById)).toContainEqual(
        expect.objectContaining({
          semanticKind: "image",
          image: expect.objectContaining({ representation: "artifact" }),
        }),
      );
      expect(Reflect.ownKeys(context)).toEqual(contextKeys);
      expect(Object.values(context).some((value) => value instanceof Map)).toBe(
        false,
      );
      expect(Object.values(context).some((value) => value instanceof Set)).toBe(
        false,
      );
    }

    expect(publications.size).toBe(40);
  });

  it("keeps a missing ImageGen result readable as an omitted image", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grok-history-missing-"));
    temporaryRoots.push(root);
    const nativeHome = path.join(root, ".grok");
    const imagePath = path.join(
      nativeHome,
      "sessions",
      encodeURIComponent(correlationScope.canonicalWorkspacePath),
      correlationScope.sessionId,
      "images",
      "1.jpg",
    );
    mkdirSync(path.dirname(imagePath), { recursive: true });
    const history = records((projector) => {
      projector.ingestStandard(
        tool("image", "p1", {
          status: "completed",
          rawOutput: {
            type: "ImageGen",
            path: imagePath,
            filename: "1.jpg",
            session_folder: "images",
          },
        }),
      );
      complete(projector, "p1", "terminal");
    });
    const context = {
      scope: { tenantId: "tenant-grok", principalId: "principal-grok" },
      applicationThreadId: "thread-grok",
      outputArtifacts: {
        findImage: () => undefined,
        publishImage: async () => {
          throw new Error("must_not_publish_missing_image");
        },
      },
      authority: {
        nativeHome,
        canonicalWorkspacePath: correlationScope.canonicalWorkspacePath,
        sessionId: correlationScope.sessionId,
      },
    };
    const snapshot = (
      await projectGrokLatestHistoryWithGeneratedImages(
        history,
        undefined,
        context,
      )
    ).snapshot;
    expect(Object.values(snapshot.itemsById)).toContainEqual(
      expect.objectContaining({
        semanticKind: "image",
        image: expect.objectContaining({
          representation: "omitted",
          reason: "unavailable",
        }),
      }),
    );
  });

  it("converges live patch streams and consolidated replay onto the same stable tool item", () => {
    const project = (updates: readonly SessionNotification[]) => {
      const history = records((projector) => {
        for (const notification of updates) {
          projector.ingestStandard(notification);
        }
        complete(projector, "p1", `${updates.length}-terminal`);
      });
      const snapshot = projectGrokLatestHistory(history).snapshot;
      return Object.values(snapshot.itemsById).find(
        (candidate) => candidate.semanticKind === "command",
      )!;
    };
    const streamed = project([
      tool("live-start", "p1", {
        title: "Run tests",
        name: "shell",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "run_terminal_cmd",
            kind: "execute",
            namespace: "grok_build",
            label: "Run Command",
            read_only: false,
            input: { command: "npm test" },
          },
        },
      }),
      tool("live-end", "p1", {
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "ok" },
          },
        ],
        rawOutput: {
          type: "Bash",
          output: [112, 114, 111, 118, 105, 100, 101, 114],
          command: "npm test",
          current_dir: "/workspace",
          exit_code: 0,
        },
      }),
    ]);
    const replay = project([
      tool("replay-final", "p1", {
        title: "Run tests",
        name: "shell",
        kind: "execute",
        status: "completed",
        rawInput: { command: "npm test" },
        content: [
          {
            type: "content",
            content: { type: "text", text: "ok" },
          },
        ],
        rawOutput: {
          type: "Bash",
          output: [112, 114, 111, 118, 105, 100, 101, 114],
          command: "npm test",
          current_dir: "/workspace",
          exit_code: 0,
        },
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "run_terminal_cmd",
            kind: "execute",
            namespace: "grok_build",
            label: "Run Command",
            read_only: false,
            input: { command: "npm test" },
          },
        },
      }),
    ]);
    expect(replay.backendItemId).toBe(streamed.backendItemId);
    expect(replay).toMatchObject({
      semanticKind: "command",
      output: { text: "ok" },
      exitCode: 0,
    });
    expect(() => backendItemSchema.parse(replay)).not.toThrow();
    expect({ ...replay, revision: undefined }).toEqual({
      ...streamed,
      revision: undefined,
    });
  });

  it("defers an incomplete recognized rich tool and falls back to generic only at terminal", () => {
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    projector.sealReplay();
    projector.ingestStandard({
      ...tool("incomplete-read", "p1", {
        title: "Read pending",
        name: "read_file",
        kind: "read",
        status: "in_progress",
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "read_file",
            kind: "read",
            namespace: "grok_build",
            label: "Read",
            read_only: true,
          },
        },
      }),
      _meta: { eventId: "incomplete-read", promptId: "p1" },
    });
    expect(
      Object.values(
        projectGrokLatestHistory(projector.records()).snapshot.itemsById,
      ),
    ).toHaveLength(0);

    projector.ingestSourceCandidateTurnCompleted({
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p1",
        stop_reason: "end_turn",
      },
      _meta: { eventId: "terminal", promptId: "p1" },
    });
    const [fallback] = Object.values(
      projectGrokLatestHistory(projector.records()).snapshot.itemsById,
    );
    expect(fallback).toMatchObject({
      semanticKind: "tool",
      toolName: { text: "read_file" },
      category: "filesystem",
    });
    expect(() => backendItemSchema.parse(fallback)).not.toThrow();
  });

  it("keeps a published rich tool identity and source order stable through refinement", () => {
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    projector.sealReplay();
    const canonicalMeta = {
      "x.ai/tool": {
        version: 1,
        name: "run_terminal_cmd",
        kind: "execute",
        namespace: "grok_build",
        label: "Run Command",
        read_only: false,
        input: { command: "npm test" },
      },
    };
    projector.ingestStandard({
      ...tool("command-start", "p1", {
        title: "Run tests",
        name: "run_terminal_cmd",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
        _meta: canonicalMeta,
      }),
      _meta: { eventId: "command-start", promptId: "p1" },
    });
    const [pending] = Object.values(
      projectGrokLatestHistory(projector.records()).snapshot.itemsById,
    );
    expect(pending).toMatchObject({ semanticKind: "command" });

    projector.ingestStandard({
      ...tool("command-end", "p1", {
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "ok" },
          },
        ],
        rawOutput: {
          type: "Bash",
          output: [111, 107],
          command: "npm test",
          current_dir: "/workspace",
          exit_code: 0,
        },
        _meta: canonicalMeta,
      }),
      _meta: { eventId: "command-end", promptId: "p1" },
    });
    const [refined] = Object.values(
      projectGrokLatestHistory(projector.records()).snapshot.itemsById,
    );
    expect(refined).toMatchObject({
      semanticKind: "command",
      output: { text: "ok" },
    });
    expect(refined?.backendItemId).toBe(pending?.backendItemId);
    expect(refined?.sourceOrder).toBe(pending?.sourceOrder);
    expect(() => backendItemSchema.parse(refined)).not.toThrow();
  });

  it("keeps a parent-terminal generic latch when a background tool later gains rich evidence", () => {
    const projector = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    projector.sealReplay();
    const incompleteMeta = {
      "x.ai/tool": {
        version: 1,
        name: "run_terminal_cmd",
        kind: "execute",
        namespace: "grok_build",
        label: "Run Command",
        read_only: false,
      },
    };
    projector.ingestStandard({
      ...tool("background-start", "p1", {
        title: "Background command",
        name: "run_terminal_cmd",
        kind: "execute",
        status: "in_progress",
        _meta: incompleteMeta,
      }),
      _meta: { eventId: "background-start", promptId: "p1" },
    });
    projector.ingestSourceCandidateTurnCompleted({
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p1",
        stop_reason: "end_turn",
      },
      _meta: { eventId: "parent-terminal", promptId: "p1" },
    });
    const [atParentTerminal] = Object.values(
      projectGrokLatestHistory(projector.records()).snapshot.itemsById,
    );
    expect(atParentTerminal).toMatchObject({ semanticKind: "tool" });

    projector.ingestStandard({
      ...tool("background-finish", "p1", {
        status: "completed",
        rawInput: { command: "npm test" },
        rawOutput: {
          type: "Bash",
          output: [111, 107],
          command: "npm test",
          current_dir: "/workspace",
          exit_code: 0,
        },
        _meta: {
          "x.ai/tool": {
            ...incompleteMeta["x.ai/tool"],
            input: { command: "npm test" },
          },
        },
      }),
      _meta: { eventId: "background-finish", promptId: "p1" },
    });
    const [settled] = Object.values(
      projectGrokLatestHistory(projector.records()).snapshot.itemsById,
    );
    expect(settled).toMatchObject({
      semanticKind: "tool",
      status: "completed",
      result: {
        content: [{ kind: "text", value: { text: "ok" } }],
      },
    });
    expect(settled?.backendItemId).toBe(atParentTerminal?.backendItemId);
    expect(settled?.sourceOrder).toBe(atParentTerminal?.sourceOrder);
    expect(() => backendItemSchema.parse(settled)).not.toThrow();
  });

  it("projects failed Grok tools with a safe normalized error", () => {
    const history = records((projector) => {
      projector.ingestStandard(
        tool("failed", "p1", {
          title: "Run command",
          status: "failed",
          rawOutput: { stderr: "nope" },
        }),
      );
      complete(projector, "p1", "terminal");
    });
    const toolItem = Object.values(
      projectGrokLatestHistory(history).snapshot.itemsById,
    ).find((item) => item.semanticKind === "tool");
    expect(toolItem).toMatchObject({
      semanticKind: "tool",
      status: "failed",
      phase: "failed",
      error: {
        category: "internal",
        code: "grok_tool_failed",
        message: { text: "Grok tool execution failed." },
      },
      result: { isError: true },
    });
  });

  it("keeps sparse tool phases monotonic and permits background completion after the parent terminal", () => {
    const active = records((projector) => {
      projector.ingestStandard(
        tool("sparse", "p1", { title: "Preparing tool" }),
      );
      projector.ingestStandard(tool("pending", "p1", { status: "pending" }));
    });
    const item = Object.values(
      projectGrokLatestHistory(active).snapshot.itemsById,
    ).find((candidate) => candidate.semanticKind === "tool");
    expect(item).toMatchObject({
      semanticKind: "tool",
      status: "streaming",
      phase: "arguments_complete",
    });

    const background = new GrokHistoryProjector({
      nativeNamespaceKey: "grok:test-native",
      sessionId: "session-1",
    });
    expect(
      background.ingestStandard(
        tool("still-running", "p1", {
          title: "Still running",
          status: "in_progress",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    complete(background, "p1", "terminal");
    background.sealReplay();
    const parentSettled = projectGrokLatestHistory(
      background.records(),
    ).snapshot;
    const parentSettledTurn =
      parentSettled.turnsById[parentSettled.orderedBackendTurnIds[0]!]!;
    expect(parentSettled).toMatchObject({ runState: "idle" });
    expect(parentSettledTurn).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
    });
    expect(
      Object.values(parentSettled.itemsById).find(
        (candidate) => candidate.semanticKind === "tool",
      ),
    ).toMatchObject({
      semanticKind: "tool",
      status: "streaming",
      phase: "preflight_or_executing",
    });

    const laterTurn = records((projector) => {
      projector.ingestStandard(
        tool("still-running", "p1", {
          title: "Still running",
          status: "in_progress",
        }),
      );
      complete(projector, "p1", "terminal");
      projector.ingestStandard(
        update("user_message_chunk", "p2-user", "next", "p2"),
      );
    });
    const withLaterTurn = projectGrokLatestHistory(laterTurn).snapshot;
    const priorTurn =
      withLaterTurn.turnsById[withLaterTurn.orderedBackendTurnIds[0]!]!;
    expect(
      priorTurn.orderedBackendItemIds.map(
        (itemId) => withLaterTurn.itemsById[itemId],
      ),
    ).toContainEqual(
      expect.objectContaining({
        semanticKind: "tool",
        status: "streaming",
        phase: "preflight_or_executing",
      }),
    );

    expect(
      background.ingestStandard({
        ...tool("background-completed", "p1", {
          status: "completed",
          rawOutput: { result: "finished" },
        }),
        _meta: { eventId: "background-completed", promptId: "p1" },
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(
      Object.values(
        projectGrokLatestHistory(background.records()).snapshot.itemsById,
      ).find((candidate) => candidate.semanticKind === "tool"),
    ).toMatchObject({
      semanticKind: "tool",
      status: "completed",
      phase: "completed",
      result: { details: { kind: "object" } },
    });

    const terminalThenEnrichment = records((projector) => {
      projector.ingestStandard(
        tool("done", "p1", {
          title: "Done",
          status: "completed",
        }),
      );
      projector.ingestStandard(
        tool("late-output", "p1", { rawOutput: { value: "late" } }),
      );
      complete(projector, "p1", "terminal");
    });
    expect(
      Object.values(
        projectGrokLatestHistory(terminalThenEnrichment).snapshot.itemsById,
      ).find((candidate) => candidate.semanticKind === "tool"),
    ).toMatchObject({
      semanticKind: "tool",
      status: "completed",
      result: { details: { kind: "object" } },
    });
  });
});

function generatedImageHistoryFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-history-image-"));
  temporaryRoots.push(root);
  const nativeHome = path.join(root, ".grok");
  const imagePath = path.join(
    nativeHome,
    "sessions",
    encodeURIComponent(correlationScope.canonicalWorkspacePath),
    correlationScope.sessionId,
    "images",
    "1.jpg",
  );
  mkdirSync(path.dirname(imagePath), { recursive: true });
  writeFileSync(imagePath, testJpeg());
  const promptId = grokSubmissionPromptId({
    ...correlationScope,
    applicationOperationId: "image-operation",
    reconciliationToken: "image-token",
  });
  const history = records((projector) => {
    projector.ingestStandard(
      update("user_message_chunk", "user", "cat", promptId),
    );
    projector.ingestStandard(
      tool("image", promptId, {
        title: "image_gen",
        status: "completed",
        rawInput: { prompt: "a cat", aspect_ratio: "1:1" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({ path: imagePath, filename: "1.jpg" }),
            },
          },
        ],
        rawOutput: {
          type: "ImageGen",
          path: imagePath,
          filename: "1.jpg",
          session_folder: "images",
        },
      }),
    );
    projector.ingestStandard(
      update(
        "agent_message_chunk",
        "assistant",
        "Here it is:\n\n![Cat](images/1.jpg)\n\nDone.",
        promptId,
      ),
    );
    complete(projector, promptId, "terminal");
  });
  return { history, imagePath, nativeHome };
}

function emptyGeneratedImageContext() {
  const outputArtifacts: OutputArtifactPublisher = {
    findImage: () => undefined,
    publishImage: async () => {
      throw new Error("unexpected_generated_image_publication");
    },
  };
  return {
    scope: { tenantId: "tenant-grok", principalId: "principal-grok" },
    applicationThreadId: "thread-grok",
    outputArtifacts,
    authority: {
      nativeHome: "/nonexistent",
      canonicalWorkspacePath: correlationScope.canonicalWorkspacePath,
      sessionId: correlationScope.sessionId,
    },
  };
}

function records(populate: (projector: GrokHistoryProjector) => void) {
  const projector = new GrokHistoryProjector({
    nativeNamespaceKey: "grok:test-native",
    sessionId: "session-1",
  });
  populate(projector);
  projector.sealReplay();
  return projector.records();
}

function syntheticHistory(
  turnCount: number,
  itemsPerTurn: number,
  text: string,
): GrokHistoryRecord[] {
  return Array.from({ length: turnCount }, (_, turnIndex) => {
    const promptId = `synthetic-prompt-${turnIndex}`;
    return [
      ...Array.from({ length: itemsPerTurn }, (_, itemIndex) =>
        syntheticTextRecord({
          id: `synthetic-${turnIndex}-${itemIndex}`,
          promptId,
          blockId: `synthetic-block-${turnIndex}-${itemIndex}`,
          text,
        }),
      ),
      syntheticTerminalRecord(promptId),
    ];
  }).flat();
}

function syntheticTextRecord(input: {
  readonly id: string;
  readonly promptId: string;
  readonly blockId: string;
  readonly text: string;
}): GrokHistoryRecord {
  return {
    kind: "assistant_text",
    id: input.id,
    sessionId: "session-1",
    identity: {
      nativeNamespaceKey: "grok:test-native",
      eventId: input.id,
      promptId: input.promptId,
      blockId: input.blockId,
      blockOccurrence: 0,
    },
    text: { text: input.text },
    exactTextDigest: createHash("sha256")
      .update(input.text)
      .digest("base64url"),
    replay: true,
  };
}

function syntheticTerminalRecord(promptId: string): GrokHistoryRecord {
  const id = `${promptId}-terminal`;
  return {
    kind: "turn_completed",
    id,
    sessionId: "session-1",
    identity: {
      nativeNamespaceKey: "grok:test-native",
      eventId: id,
      promptId,
      blockId: id,
      blockOccurrence: 0,
    },
    stopReason: "end_turn",
    replay: true,
  };
}

function update(
  sessionUpdate:
    "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  eventId: string,
  text: string,
  promptId?: string,
): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate,
      content: { type: "text", text },
    },
    _meta: {
      eventId,
      isReplay: true,
      ...(promptId ? { promptId } : {}),
    },
  };
}

function tool(
  eventId: string,
  promptId: string,
  patch: Record<string, unknown>,
): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      ...patch,
    },
    _meta: { eventId, promptId, isReplay: true },
  } as SessionNotification;
}

function complete(
  projector: GrokHistoryProjector,
  promptId: string,
  eventId: string,
  stopReason = "end_turn",
): void {
  projector.ingestSourceCandidateTurnCompleted({
    sessionId: "session-1",
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: stopReason,
    },
    _meta: { eventId, promptId, isReplay: true },
  });
}

function testJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
}
