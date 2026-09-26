import { getSessionMessages, type SessionMessage, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claudeContextExcerptEnvelope,
  inspectClaudeContextExcerptEnvelope,
} from "../../src/server/backends/claude/claude-context-excerpts.js";
import {
  ClaudeHistoryProjectionError,
  locateClaudeHistoryTurn,
  nextClaudeUserMessageOrdinal,
  projectClaudeHistory,
  projectClaudeHistoryPage,
  projectClaudeLatestSnapshot,
  type ClaudeTerminalReceiptOverride,
} from "../../src/server/backends/claude/claude-history-projector.js";
import { claudeForkContextBoundaryText } from "../../src/server/backends/claude/claude-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import { claudeAttachmentEnvelope } from "../../src/server/backends/claude/claude-attachment-manifest.js";
import {
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  MAXIMUM_MESSAGE_TEXT_BYTES,
  serializedUtf8Bytes,
} from "../../src/shared/protocol/payload.js";

const excerpt = {
  id: "3d2eb945-d747-4dda-bf03-e24a96f9a71e",
  excerpt: "The earlier answer remains relevant.",
  note: "Use this as quoted context.",
  source: {
    kind: "conversation_message" as const,
    itemId: "message-item-1",
    itemRevision: 2,
  },
  locator: {
    kind: "text_quote" as const,
    prefix: "Before ",
    suffix: " after.",
  },
};
const markerAuthentication = {
  installationKey: new Uint8Array(32).fill(7),
  tenantId: "tenant-1",
  principalId: "principal-1",
  backendInstanceId: "claude-1",
};
const attachmentProvenanceKey = new Uint8Array(32).fill(0x41);
const historyAuthentication = {
  attachmentProvenanceKey,
  forkBoundaryAuthentication: markerAuthentication,
};

describe("Claude assistant response classification", () => {
  function fragment(index: number, id: string | undefined, content: unknown, stopReason: string | null) {
    return {
      ...assistant(uuid(index), content),
      message: { role: "assistant", ...(id ? { id } : {}), content, stop_reason: stopReason },
    };
  }

  it.each(["end_turn", "stop_sequence", "receipt"])(
    "classifies whole native message groups using %s terminal evidence across history pages",
    (evidence) => {
      const messages = [
        user(uuid(1), "Inspect and explain"),
        fragment(2, "msg-tool", [{ type: "text", text: "Inspecting" }], null),
        fragment(3, "msg-tool", [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/file" } }], "tool_use"),
        user(uuid(4), [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }]),
        fragment(5, "msg-final", [{ type: "text", text: "First final paragraph" }], null),
        fragment(6, "msg-final", [{ type: "text", text: "Second final paragraph" }], evidence === "receipt" ? null : evidence),
      ];
      const turnId = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds[0]!;
      const receipts = evidence === "receipt" ? [{ backendTurnId: turnId, status: "completed" as const,
        providerTerminalReason: "success", providerResultUuid: uuid(7), terminalAt: 2_000 }] : [];
      const snapshot = projectClaudeHistory(messages, receipts).snapshot;
      expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "assistant_message")
        .map(item => [item.markdown.text, item.responsePhase])).toEqual([
        ["Inspecting", "provisional"], ["First final paragraph", "final"], ["Second final paragraph", "final"],
      ]);
      expect(projectClaudeHistoryPage(messages, { limit: 10, terminalReceipts: receipts }).itemsById).toEqual(snapshot.itemsById);
    },
  );

  it.each(["missing_evidence", "missing_identity", "missing_identity_terminal", "max_tokens", "failed", "interrupted"])(
    "keeps ambiguous or unsuccessful output unclassified (%s)", scenario => {
      const messages = [user(uuid(1), "Answer"), fragment(2, scenario.startsWith("missing_identity") ? undefined : "msg-one",
        [{ type: "text", text: "Partial answer" }], scenario === "max_tokens" ? "max_tokens" : scenario === "missing_identity_terminal" ? "end_turn" : null)];
      const turnId = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds[0]!;
      const receipts: ClaudeTerminalReceiptOverride[] = scenario === "missing_evidence" ? [] : [{ backendTurnId: turnId,
        status: scenario === "failed" || scenario === "interrupted" ? scenario : "completed" as const,
        providerTerminalReason: "success", providerResultUuid: uuid(3), terminalAt: 2_000 }];
      const snapshot = projectClaudeHistory(messages, receipts).snapshot;
      expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "assistant_message")
        .map(item => item.responsePhase)).toEqual([undefined]);
    },
  );

  it("retains an explicitly empty final message without treating earlier commentary as final", () => {
    const snapshot = projectClaudeHistory([user(uuid(1), "Answer"),
      fragment(2, "msg-first", [{ type: "text", text: "Checking" }], null),
      fragment(3, "msg-last", [{ type: "text", text: "" }], "end_turn")]).snapshot;
    expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "assistant_message")
      .map(item => [item.markdown.text, item.responsePhase])).toEqual([["Checking", "provisional"], ["", "final"]]);
  });
});

describe("Claude native interruption markers", () => {
  const timestamp = "2026-09-17T07:16:01.463Z";
  const prompt = user(uuid(1), "Keep working");
  const working = assistant(uuid(2), [{ type: "tool_use", id: "tool-stop", name: "Bash", input: { command: "sleep 20" } }]);
  const marker = (text = "[Request interrupted by user]") => ({
    ...user(uuid(3), [{ type: "text", text }]), timestamp,
  });

  it.each(["[Request interrupted by user]", "[Request interrupted by user for tool use]"])(
    "restores %s as an interrupted turn without needing a saved result receipt", text => {
      const messages = [prompt, working, marker(text)];
      const projection = projectClaudeHistory(messages);
      const id = projection.snapshot.orderedBackendTurnIds[0]!;
      expect(projection.snapshot.orderedBackendTurnIds).toEqual([id]);
      expect(projection.snapshot.runState).toBe("idle");
      expect(projection.snapshot.activeBackendTurnId).toBeUndefined();
      expect(projection.snapshot.turnsById[id]).toMatchObject({ status: "interrupted", endedBy: "interrupted", completedAt: timestamp, completionCorrelations: [uuid(1)] });
      expect(Object.values(projection.snapshot.itemsById).find(item => item.semanticKind === "command")).toMatchObject({ status: "interrupted", phase: "interrupted" });
      expect(JSON.stringify(projection.snapshot)).not.toContain("[Request interrupted");
      expect(projection.usage?.counters?.userMessages).toBe(1);
      expect(nextClaudeUserMessageOrdinal(messages as SessionMessage[], markerAuthentication)).toBe(1);
      expect(projectClaudeHistoryPage(messages, { limit: 10 }).turnsById[id]).toEqual(projection.snapshot.turnsById[id]);
      expect(projection.terminalCheckpointUuidByBackendTurnId.has(id)).toBe(false);
      const continued = projectClaudeHistory([...messages, user(uuid(4), "Continue"), assistant(uuid(5), [{ type: "text", text: "Done" }])]);
      expect(continued.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(continued.snapshot.turnsById[id]?.status).toBe("interrupted");
    },
  );

  it("preserves authenticated literal user input, explicit human provenance, and quoted text", () => {
    for (const [message, authentication] of [
      [marker(), { ...historyAuthentication, isApplicationInputOperation: (id: string) => id === uuid(3) }],
      [{ ...marker(), origin: { kind: "human" } }, historyAuthentication],
      [marker("Explain [Request interrupted by user]"), historyAuthentication],
      [user(uuid(3), "[Request interrupted by user]"), historyAuthentication],
    ] as const) {
      const projection = projectClaudeHistory([prompt, working, message], [], authentication);
      expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(JSON.stringify(projection.snapshot)).toContain("[Request interrupted by user]");
      expect(projection.snapshot.runState).toBe("running");
    }
    expect(projectClaudeHistory([marker()]).usage?.counters?.userMessages).toBe(1);
  });
});

describe("Claude targeted history lookup", () => {
  const messages = Array.from({ length: 4 }, (_, index) => [
    user(uuid(index * 2 + 1), `prompt ${index}`),
    assistant(uuid(index * 2 + 2), [{ type: "text", text: `answer ${index}` }]),
  ]).flat();
  const turnIds = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds;

  it("tests retained candidates newest-first and returns one cursor-free turn", () => {
    const candidates: string[] = [];
    const located = locateClaudeHistoryTurn(messages, {
      maximumTurnCandidates: 4,
      matchesBackendTurnId: (candidate) => {
        candidates.push(candidate);
        return candidate === turnIds[1];
      },
    });

    expect(candidates).toEqual([turnIds[3], turnIds[2], turnIds[1]]);
    expect(located).toMatchObject({
      status: "found",
      page: { orderedBackendTurnIds: [turnIds[1]] },
    });
    if (located.status !== "found") throw new Error("expected located turn");
    expect(located.page.previousCursor).toBeUndefined();
    expect(Object.keys(located.page.turnsById)).toEqual([turnIds[1]]);
    expect(JSON.stringify(located.page.itemsById)).toContain("answer 1");
    expect(JSON.stringify(located.page.itemsById)).not.toContain("answer 0");
  });

  it("distinguishes exhausted history from a remaining bounded search", () => {
    expect(
      locateClaudeHistoryTurn(messages, {
        maximumTurnCandidates: turnIds.length,
        matchesBackendTurnId: () => false,
      }),
    ).toEqual({ status: "not_found" });
    expect(
      locateClaudeHistoryTurn(messages, {
        maximumTurnCandidates: turnIds.length - 1,
        matchesBackendTurnId: () => false,
      }),
    ).toEqual({ status: "search_limit_reached" });
  });

  it("rejects a non-positive candidate bound", () => {
    expect(() =>
      locateClaudeHistoryTurn(messages, {
        maximumTurnCandidates: 0,
        matchesBackendTurnId: () => false,
      }),
    ).toThrowError(ClaudeHistoryProjectionError);
  });
});

describe("Claude context excerpt envelopes", () => {
  it("round-trips ordered excerpts and returns the ordinary prompt separately", () => {
    const envelope = claudeContextExcerptEnvelope(
      {
        operationId: uuid(1),
        contextExcerpts: [excerpt, { ...excerpt, id: uuid(99) }],
        prompt: "Explain the consequence.",
      },
      markerAuthentication,
    );
    expect(
      inspectClaudeContextExcerptEnvelope(envelope, markerAuthentication),
    ).toEqual({
      type: "envelope",
      contextExcerpts: [excerpt, { ...excerpt, id: uuid(99) }],
      prompt: "Explain the consequence.",
    });
  });

  it("keeps every byte of malformed lookalikes visible as ordinary prompt text", () => {
    const malformed = claudeContextExcerptEnvelope(
      {
        operationId: uuid(1),
        contextExcerpts: [excerpt],
        prompt: "Visible prompt",
      },
      markerAuthentication,
    ).replace('version="2"', 'version="3"');
    expect(
      inspectClaudeContextExcerptEnvelope(malformed, markerAuthentication),
    ).toEqual({
      type: "ordinary_prompt",
      contextExcerpts: [],
      prompt: malformed,
    });
  });

  it("keeps a canonical envelope for another native user UUID visible", () => {
    const remapped = claudeContextExcerptEnvelope(
      {
        operationId: uuid(1),
        contextExcerpts: [excerpt],
        prompt: "Visible external prompt",
      },
      markerAuthentication,
    );
    expect(
      inspectClaudeContextExcerptEnvelope(remapped, markerAuthentication),
    ).toEqual({
      type: "envelope",
      contextExcerpts: [excerpt],
      prompt: "Visible external prompt",
    });
  });
});

describe("Claude history projection", () => {
  it.each([
    ["ASCII beyond the former 16 KiB preview", "complete paragraph\n".repeat(2_000)],
    ["Unicode beyond 64K characters and 512 KiB", "😀漢字 e\u0301\n".repeat(60_000)],
  ])("preserves ordinary user and assistant %s in snapshots and history pages", (_label, text) => {
    const messages = [
      user(uuid(1), text),
      assistant(uuid(2), [
        { type: "thinking", thinking: text },
        { type: "text", text },
      ]),
    ];
    for (const projection of [
      projectClaudeHistory(messages).snapshot,
      projectClaudeHistoryPage(messages, { limit: 1 }),
    ]) {
      const items = Object.values(projection.itemsById);
      expect(items.find((item) => item.semanticKind === "user_message")).toMatchObject({
        content: [{ kind: "text", text: { text } }],
      });
      expect(items.find((item) => item.semanticKind === "assistant_message")).toMatchObject({
        markdown: { text },
      });
      const reasoning = items.find((item) => item.semanticKind === "reasoning");
      expect(reasoning?.semanticKind).toBe("reasoning");
      if (reasoning?.semanticKind !== "reasoning") throw new Error("missing reasoning");
      expect(reasoning.markdown.text.length).toBeLessThan(text.length);
      expect(reasoning.markdown.truncation?.truncated).toBe(true);
    }
  });

  it.each(["user", "assistant"])("rejects oversized %s text instead of truncating or omitting it", (role) => {
    const text = "x".repeat(MAXIMUM_MESSAGE_TEXT_BYTES);
    const messages = role === "user"
      ? [user(uuid(1), text)]
      : [user(uuid(1), "prompt"), assistant(uuid(2), [{ type: "text", text }])];
    for (const project of [
      () => projectClaudeHistory(messages),
      () => projectClaudeHistoryPage(messages, { limit: 1 }),
    ]) expect(project).toThrowError(expect.objectContaining({ code: "claude_message_payload_too_large" }));
  });

  it("rejects an oversized complete user item even when each text part fits", () => {
    const content = [0, 1].map(() => ({
      type: "text",
      text: "x".repeat(MAXIMUM_MESSAGE_ITEM_BYTES / 2),
    }));
    expect(() => projectClaudeHistory([user(uuid(1), content)])).toThrowError(
      expect.objectContaining({ code: "claude_message_payload_too_large" }),
    );
  });

  it("preserves native user messages with more parts than the composer accepts", () => {
    const content = Array.from({ length: 100 }, (_, index) => ({
      type: "text", text: `Native part ${index}`,
    }));
    const projected = projectClaudeHistory([user(uuid(1), content)]).snapshot;
    expect(Object.values(projected.itemsById)).toContainEqual(expect.objectContaining({
      semanticKind: "user_message",
      content: content.map(({ text }) => ({ kind: "text", text: { text } })),
    }));
  });

  it("authenticates remapped context envelopes and keeps forged envelopes visible", () => {
    const envelope = claudeContextExcerptEnvelope(
      {
        operationId: uuid(1),
        contextExcerpts: [excerpt],
        prompt: "Use it.",
      },
      markerAuthentication,
    );
    const remapped = projectClaudeHistory(
      [
        user(uuid(88), envelope),
        assistant(uuid(89), [{ type: "text", text: "Done" }]),
      ],
      [],
      historyAuthentication,
    );
    expect(JSON.stringify(remapped.snapshot)).toContain(excerpt.excerpt);
    expect(JSON.stringify(remapped.snapshot)).not.toContain(
      "sedes-context-excerpts",
    );

    const forged = envelope.replace(/"tag":"./u, '"tag":"A');
    const forgedProjection = projectClaudeHistory(
      [
        user(uuid(90), forged),
        assistant(uuid(91), [{ type: "text", text: "Done" }]),
      ],
      [],
      historyAuthentication,
    );
    expect(JSON.stringify(forgedProjection.snapshot)).toContain(
      "sedes-context-excerpts",
    );
  });

  it("hides an authenticated fork boundary after UUID remapping and exposes a forgery", () => {
    const operationId = uuid(40);
    const marker = claudeForkContextBoundaryText(
      operationId,
      USER_FORK_CONTEXT_BOUNDARY,
      markerAuthentication,
    );
    expect(marker).toContain(USER_FORK_CONTEXT_BOUNDARY.content);
    const remapped = projectClaudeHistory(
      [user(uuid(41), marker)],
      [],
      historyAuthentication,
    );
    expect(remapped.snapshot.orderedBackendTurnIds).toEqual([]);
    expect(
      remapped.authenticatedForkContextBoundaryOperationIds.has(operationId),
    ).toBe(true);

    const forged = projectClaudeHistory(
      [user(uuid(42), marker.replace(/:[A-Za-z0-9_-]/u, ":A"))],
      [],
      historyAuthentication,
    );
    expect(forged.snapshot.orderedBackendTurnIds).toHaveLength(1);
  });

  it("hides an authenticated legacy fork boundary and exposes a forged legacy marker", () => {
    const operationId = uuid(43);
    const encodedOperationId = Buffer.from(operationId, "utf8").toString(
      "base64url",
    );
    const tag = claudeLegacyTag([
      "harness.claude-fork-boundary.v1",
      markerAuthentication.tenantId,
      markerAuthentication.principalId,
      markerAuthentication.backendInstanceId,
      operationId,
      String(USER_FORK_CONTEXT_BOUNDARY.version),
      USER_FORK_CONTEXT_BOUNDARY.content,
    ]);
    const marker = `harness-claude-fork-boundary:v1:${encodedOperationId}:${tag}\n${USER_FORK_CONTEXT_BOUNDARY.content}`;

    const projection = projectClaudeHistory(
      [user(uuid(44), marker)],
      [],
      historyAuthentication,
    );
    expect(projection.snapshot.orderedBackendTurnIds).toEqual([]);
    expect(
      projection.authenticatedForkContextBoundaryOperationIds.has(operationId),
    ).toBe(true);

    const forged = projectClaudeHistory(
      [
        user(
          uuid(45),
          marker.replace(
            `:${tag}\n`,
            `:${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}\n`,
          ),
        ),
      ],
      [],
      historyAuthentication,
    );
    expect(forged.snapshot.orderedBackendTurnIds).toHaveLength(1);
  });

  it("redacts a staged-path lookalike signed without the server provenance key", () => {
    const operationId = uuid(1);
    const trustedKey = new Uint8Array(32).fill(0x41);
    const forged = claudeAttachmentEnvelope({
      key: new Uint8Array(32).fill(0x42),
      operationId,
      attachments: [
        {
          id: uuid(20),
          kind: "file",
          fileName: "private.bin",
          mediaType: "application/octet-stream",
          byteSize: 4,
          sha256: "a".repeat(64),
          agentPath: "/private/staging/private.bin",
        },
      ],
      prompt: "Visible suffix.",
    });
    const projection = projectClaudeHistory([user(operationId, forged)], [], {
      attachmentProvenanceKey: trustedKey,
      forkBoundaryAuthentication: markerAuthentication,
    });
    const turn =
      projection.snapshot.turnsById[
        projection.snapshot.orderedBackendTurnIds[0]!
      ]!;
    const projected = turn.orderedBackendItemIds.map(
      (id) => projection.snapshot.itemsById[id],
    );
    expect(JSON.stringify(projected)).not.toContain("/private/staging");
    expect(projected[0]).toMatchObject({
      semanticKind: "user_message",
      content: [{ kind: "text", text: { text: "Visible suffix." } }],
    });
  });

  it("restores a persisted Claude skill badge outside attachment and context envelopes", () => {
    const operationId = uuid(1);
    const contextPrompt = claudeContextExcerptEnvelope(
      {
        operationId,
        contextExcerpts: [excerpt],
        prompt: "Inspect the server change.",
      },
      markerAuthentication,
    );
    const envelope = claudeAttachmentEnvelope({
      key: attachmentProvenanceKey,
      operationId,
      attachments: [
        {
          id: uuid(20),
          kind: "file",
          fileName: "notes.txt",
          mediaType: "application/octet-stream",
          byteSize: 4,
          sha256: "a".repeat(64),
          agentPath: "/private/staging/notes.txt",
        },
      ],
      prompt: contextPrompt,
    });
    const projection = projectClaudeHistory(
      [
        user(operationId, `/review ${envelope}`),
        assistant(uuid(2), [{ type: "text", text: "Reviewed." }]),
      ],
      [],
      {
        ...historyAuthentication,
        resolveSkillName: (nativeUuid) =>
          nativeUuid === operationId ? "review" : undefined,
      },
    );
    const turn =
      projection.snapshot.turnsById[
        projection.snapshot.orderedBackendTurnIds[0]!
      ]!;
    const projected = turn.orderedBackendItemIds.map(
      (id) => projection.snapshot.itemsById[id],
    );
    expect(projected[0]).toMatchObject({
      semanticKind: "user_message",
      deliveryOperationId: operationId,
      content: [
        { kind: "skill", name: { text: "review" } },
        { kind: "attachment", attachment: { fileName: "notes.txt" } },
        { kind: "context_excerpt", excerpt },
        { kind: "text", text: { text: "Inspect the server change." } },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("/private/staging");
  });

  it("does not infer a skill badge from unowned or token-prefix slash text", () => {
    for (const value of ["/review ordinary", "/reviewer ordinary"]) {
      const projection = projectClaudeHistory([user(uuid(1), value)], [], {
        ...historyAuthentication,
        resolveSkillName: () =>
          value.startsWith("/reviewer") ? "review" : undefined,
      });
      expect(Object.values(projection.snapshot.itemsById)[0]).toMatchObject({
        semanticKind: "user_message",
        content: [{ kind: "text", text: { text: value } }],
      });
    }
  });

  it("authenticates a persisted skill only on the leading text block", () => {
    const operationId = uuid(1);
    const projection = projectClaudeHistory(
      [
        user(operationId, [
          { type: "text", text: "/review first" },
          { type: "text", text: "/review second" },
        ]),
      ],
      [],
      {
        ...historyAuthentication,
        resolveSkillName: () => "review",
      },
    );
    expect(Object.values(projection.snapshot.itemsById)[0]).toMatchObject({
      semanticKind: "user_message",
      content: [
        { kind: "skill", name: { text: "review" } },
        { kind: "text", text: { text: "first" } },
        { kind: "text", text: { text: "/review second" } },
      ],
    });
  });

  it("deduplicates only native images authenticated by the preceding attachment envelope", () => {
    const operationId = uuid(1);
    const envelope = claudeAttachmentEnvelope({
      key: attachmentProvenanceKey,
      operationId,
      attachments: [
        {
          id: uuid(20),
          kind: "image",
          fileName: "diagram.png",
          mediaType: "image/png",
          byteSize: 16,
          sha256: "a".repeat(64),
          agentPath: "/private/staging/diagram.png",
        },
        {
          id: uuid(21),
          kind: "file",
          fileName: "notes.txt",
          mediaType: "application/octet-stream",
          byteSize: 4,
          sha256: "b".repeat(64),
          agentPath: "/private/staging/notes.txt",
        },
      ],
      prompt: "Inspect both.",
    });
    const projection = projectClaudeHistory(
      [
        user(operationId, [
          { type: "text", text: envelope },
          { type: "image", source: { type: "base64", data: "ignored" } },
          { type: "image", source: { type: "base64", data: "extra" } },
        ]),
      ],
      [],
      historyAuthentication,
    );
    const item = Object.values(projection.snapshot.itemsById)[0];
    expect(item?.semanticKind).toBe("user_message");
    if (item?.semanticKind !== "user_message") throw new Error("wrong_item");
    expect(item.content).toEqual([
      {
        kind: "attachment",
        attachment: {
          id: uuid(20),
          kind: "image",
          fileName: "diagram.png",
          mediaType: "image/png",
          byteSize: 16,
        },
      },
      {
        kind: "attachment",
        attachment: {
          id: uuid(21),
          kind: "file",
          fileName: "notes.txt",
          mediaType: "application/octet-stream",
          byteSize: 4,
        },
      },
      { kind: "text", text: { text: "Inspect both." } },
      { kind: "image", omitted: true },
    ]);

    const uncorrelated = projectClaudeHistory([
      user(uuid(2), [
        { type: "text", text: "Provider-native image" },
        { type: "image", source: { type: "base64", data: "ignored" } },
      ]),
    ]);
    const uncorrelatedItem = Object.values(uncorrelated.snapshot.itemsById)[0];
    expect(uncorrelatedItem?.semanticKind).toBe("user_message");
    if (uncorrelatedItem?.semanticKind !== "user_message") {
      throw new Error("wrong_item");
    }
    expect(uncorrelatedItem.content).toContainEqual({
      kind: "image",
      omitted: true,
    });
  });

  it("projects main-thread messages, reasoning, tools, results, usage, and native indexes", () => {
    const userUuid = uuid(1);
    const assistantToolUuid = uuid(2);
    const assistantFinalUuid = uuid(4);
    const projection = projectClaudeHistory(
      [
        user(
          userUuid,
          claudeContextExcerptEnvelope(
            {
              operationId: userUuid,
              contextExcerpts: [excerpt],
              prompt: "Please inspect it.",
            },
            markerAuthentication,
          ),
        ),
        assistant(
          assistantToolUuid,
          [
            {
              type: "thinking",
              thinking: "I should inspect the file.",
              signature: "secret",
            },
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "tool-use-1",
              name: "Read",
              input: { file_path: "/workspace/file.ts" },
            },
          ],
          {
            input_tokens: 12,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        ),
        user(uuid(3), [
          {
            type: "tool_result",
            tool_use_id: "tool-use-1",
            content: [{ type: "text", text: "file contents" }],
          },
        ]),
        assistant(assistantFinalUuid, [{ type: "text", text: "Done." }], {
          input_tokens: 5,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
        // A subagent message does not belong in the main conversation timeline.
        {
          ...assistant(uuid(5), [{ type: "text", text: "private subagent" }]),
          parent_tool_use_id: "tool-use-1",
        },
      ],
      [],
      historyAuthentication,
    );

    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(1);
    const turnId = projection.snapshot.orderedBackendTurnIds[0]!;
    const turn = projection.snapshot.turnsById[turnId]!;
    expect(turn.status).toBe("completed");
    expect(turn.completionCorrelations).toEqual([userUuid]);
    expect(projection.nativeUserMessageUuidByBackendTurnId.get(turnId)).toBe(
      userUuid,
    );
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(turnId)).toBe(
      assistantFinalUuid,
    );
    const items = turn.orderedBackendItemIds.map(
      (itemId) => projection.snapshot.itemsById[itemId]!,
    );
    expect(items.map((item) => item.semanticKind)).toEqual([
      "user_message",
      "reasoning",
      "assistant_message",
      "file_read",
      "assistant_message",
    ]);
    expect(items[1]).toMatchObject({
      semanticKind: "reasoning",
      markdown: { text: "I should inspect the file." },
    });
    expect(items[1]).not.toHaveProperty("summaryParts");
    const userItem = items[0];
    expect(userItem?.semanticKind).toBe("user_message");
    if (userItem?.semanticKind !== "user_message") throw new Error("user item");
    expect(userItem.content).toEqual([
      { kind: "context_excerpt", excerpt },
      { kind: "text", text: { text: "Please inspect it." } },
    ]);
    const tool = items.find((item) => item.semanticKind === "file_read");
    expect(tool).toMatchObject({
      semanticKind: "file_read",
      status: "completed",
      phase: "completed",
      path: { text: "/workspace/file.ts" },
      contentPreview: { text: "file contents" },
    });
    expect(JSON.stringify(projection.snapshot)).not.toContain(
      "private subagent",
    );
    expect(projection.usage).toMatchObject({
      counters: {
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
      },
    });
  });

  it("projects durable Claude built-in tool semantics and terminal results", () => {
    const invocations = [
      {
        type: "tool_use",
        id: "bash-1",
        name: "Bash",
        input: { command: "npm test", timeout: 30_000 },
      },
      {
        type: "tool_use",
        id: "read-1",
        name: "Read",
        input: { file_path: "/workspace/file.ts", offset: 3, limit: 4 },
      },
      {
        type: "tool_use",
        id: "notebook-1",
        name: "NotebookEdit",
        input: {
          notebook_path: "/workspace/notebook.ipynb",
          cell_id: "cell-1",
          new_source: "print('updated')",
          edit_mode: "replace",
        },
      },
      {
        type: "tool_use",
        id: "search-1",
        name: "WebSearch",
        input: { query: "Claude Agent SDK" },
      },
      {
        type: "tool_use",
        id: "fetch-1",
        name: "WebFetch",
        input: { url: "https://example.com", prompt: "Summarize" },
      },
      {
        type: "tool_use",
        id: "mcp-1",
        name: "mcp__docs__lookup",
        input: { query: "sessions" },
      },
      {
        type: "tool_use",
        id: "agent-1",
        name: "Agent",
        input: {
          description: "Inspect session recovery",
          prompt: "Audit the durable transcript.",
          subagent_type: "Explore",
        },
      },
    ];
    const results = [
      ["bash-1", "tests passed"],
      ["read-1", "line 3\nline 4\n"],
      ["notebook-1", "Notebook updated"],
      ["search-1", "Search results"],
      ["fetch-1", "Fetched page"],
      ["mcp-1", "SDK session documentation"],
      ["agent-1", "Recovery audit complete"],
    ].map(([toolUseId, text]) => ({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [{ type: "text", text }],
    }));
    const projection = projectClaudeHistory([
      user(uuid(1), "inspect everything"),
      assistant(uuid(2), invocations),
      user(uuid(3), results),
      assistant(uuid(4), "done"),
    ]);
    const turnId = projection.snapshot.orderedBackendTurnIds[0]!;
    const items = projection.snapshot.turnsById[
      turnId
    ]!.orderedBackendItemIds.map(
      (itemId) => projection.snapshot.itemsById[itemId]!,
    );

    expect(items.find((item) => item.semanticKind === "command")).toMatchObject(
      {
        semanticKind: "command",
        status: "completed",
        phase: "completed",
        command: { text: "npm test" },
        timeoutMs: 30_000,
        output: { text: "tests passed" },
      },
    );
    expect(
      items.find((item) => item.semanticKind === "file_read"),
    ).toMatchObject({
      semanticKind: "file_read",
      path: { text: "/workspace/file.ts" },
      range: { startLine: 3, endLine: 6 },
      contentPreview: { text: "line 3\nline 4\n" },
    });
    expect(
      items.find(
        (item) =>
          item.semanticKind === "file_change" &&
          item.path.text === "/workspace/notebook.ipynb",
      ),
    ).toMatchObject({
      semanticKind: "file_change",
      operation: "edit",
      effect: "applied",
      contentPreview: { text: "print('updated')" },
    });
    expect(
      items.find((item) => item.semanticKind === "web_search"),
    ).toMatchObject({
      semanticKind: "web_search",
      query: { text: "Claude Agent SDK" },
      result: {
        content: [{ kind: "text", value: { text: "Search results" } }],
      },
    });
    expect(
      items.find(
        (item) =>
          item.semanticKind === "tool" && item.toolName.text === "WebFetch",
      ),
    ).toMatchObject({ semanticKind: "tool", category: "network" });
    expect(items.find((item) => item.semanticKind === "mcp")).toMatchObject({
      semanticKind: "mcp",
      server: { text: "docs" },
      toolName: { text: "lookup" },
      result: {
        content: [
          { kind: "text", value: { text: "SDK session documentation" } },
        ],
      },
    });
    const collaboration = items.find(
      (item) => item.semanticKind === "collaboration",
    );
    expect(collaboration).toMatchObject({
      semanticKind: "collaboration",
      status: "completed",
      action: "spawn",
      agentLabel: { text: "Explore" },
      summary: { text: "Started subagent · Inspect session recovery" },
    });
    expect(
      items.filter((item) => item.semanticKind === "collaboration"),
    ).toHaveLength(1);
  });

  it("fails rich Claude tool projection closed on incomplete evidence", () => {
    const projection = projectClaudeHistory([
      user(uuid(1), "inspect malformed calls"),
      assistant(uuid(2), [
        { type: "tool_use", id: "bash", name: "Bash", input: {} },
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "relative.ts" },
        },
        {
          type: "tool_use",
          id: "mcp",
          name: "mcp__missing-boundary",
          input: {},
        },
        {
          type: "tool_use",
          id: "agent",
          name: "Agent",
          input: { description: "missing prompt" },
        },
      ]),
    ]);
    const items = Object.values(projection.snapshot.itemsById);
    expect(items.filter((item) => item.semanticKind === "tool")).toHaveLength(
      4,
    );
  });

  it.each([
    { invalidField: "offset", input: { offset: 0, limit: 5 } },
    { invalidField: "limit", input: { offset: 3, limit: "5" } },
  ])(
    "keeps Read generic when present $invalidField evidence is invalid",
    ({ input }) => {
      const projection = projectClaudeHistory([
        user(uuid(1), "read a range"),
        assistant(uuid(2), [
          {
            type: "tool_use",
            id: "read-invalid-range",
            name: "Read",
            input: { file_path: "/workspace/file.ts", ...input },
          },
        ]),
      ]);
      expect(
        Object.values(projection.snapshot.itemsById).find(
          (item) => item.semanticKind !== "user_message",
        ),
      ).toMatchObject({
        semanticKind: "tool",
        toolName: { text: "Read" },
        category: "filesystem",
      });
      expect(
        Object.values(projection.snapshot.itemsById).some(
          (item) => item.semanticKind === "file_read",
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      kind: "generic",
      invocation: {
        type: "tool_use",
        id: "duplicate-result",
        name: "CustomTool",
        input: { value: 1 },
      },
    },
    {
      kind: "collaboration",
      invocation: {
        type: "tool_use",
        id: "duplicate-result",
        name: "Agent",
        input: {
          description: "Inspect recovery",
          prompt: "Check the transcript.",
        },
      },
    },
  ])(
    "rejects same and conflicting duplicate $kind tool results",
    ({ invocation }) => {
      const result = {
        type: "tool_result",
        tool_use_id: "duplicate-result",
        content: "done",
      };
      expect(() =>
        projectClaudeHistory([
          user(uuid(1), "run it"),
          assistant(uuid(2), [invocation]),
          user(uuid(3), [result, { ...result }]),
        ]),
      ).toThrowError(ClaudeHistoryProjectionError);
      expect(() =>
        projectClaudeHistory([
          user(uuid(4), "run it"),
          assistant(uuid(5), [invocation]),
          user(uuid(6), [
            result,
            { ...result, content: "failed", is_error: true },
          ]),
        ]),
      ).toThrowError(ClaudeHistoryProjectionError);
    },
  );

  it("settles rich Claude operation items from durable terminal receipts", () => {
    const messages = [
      user(uuid(1), "run it"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "npm test" },
        },
      ]),
    ];
    const initial = projectClaudeHistory(messages);
    const turnId = initial.snapshot.orderedBackendTurnIds[0]!;
    const projection = projectClaudeHistory(messages, [
      {
        backendTurnId: turnId,
        status: "interrupted",
        providerTerminalReason: null,
        providerResultUuid: null,
        terminalAt: 2_000,
      },
    ]);
    expect(
      Object.values(projection.snapshot.itemsById).find(
        (item) => item.semanticKind === "command",
      ),
    ).toMatchObject({
      semanticKind: "command",
      status: "interrupted",
      phase: "interrupted",
      completedAt: "1970-01-01T00:00:02.000Z",
    });
  });

  it("settles a null-stop assistant block only from its durable success receipt", () => {
    const messages = [
      user(uuid(1), "answer"),
      {
        ...assistant(uuid(2), [{ type: "text", text: "Done." }]),
        message: {
          id: "msg-success",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stop_reason: null,
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      },
    ];
    const initial = projectClaudeHistory(messages);
    const turnId = initial.snapshot.orderedBackendTurnIds[0]!;
    expect(initial.snapshot.turnsById[turnId]?.status).toBe("in_progress");

    const projection = projectClaudeHistory(messages, [
      {
        backendTurnId: turnId,
        status: "completed",
        providerTerminalReason: "success",
        providerResultUuid: uuid(3),
        terminalAt: 2_000,
      },
    ]);
    expect(projection.snapshot.turnsById[turnId]).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
      completedAt: "1970-01-01T00:00:02.000Z",
    });
  });

  it("projects Write and Edit from recovery-stable Claude tool inputs", () => {
    const messages = [
      user(uuid(1), "write the file"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "write-1",
          name: "Write",
          input: {
            file_path: "/workspace/example.ts",
            content: "const first = true;\nconst value = 1;\n",
          },
        },
      ]),
      user(uuid(3), [
        {
          type: "tool_result",
          tool_use_id: "write-1",
          content: "File written successfully.",
        },
      ]),
      assistant(uuid(4), [{ type: "text", text: "Written." }]),
      user(uuid(5), "change the value"),
      assistant(uuid(6), [
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "/workspace/example.ts",
            old_string:
              "const first = true;\nconst value = 1;\nreturn value;\n",
            new_string:
              "const first = true;\nconst value = 2;\nreturn value;\n",
            replace_all: false,
          },
        },
      ]),
      user(uuid(7), [
        {
          type: "tool_result",
          tool_use_id: "edit-1",
          content: "The file has been updated successfully.",
        },
      ]),
      assistant(uuid(8), [{ type: "text", text: "Edited." }]),
    ];

    const projection = projectClaudeHistory(messages);
    const fileChanges = Object.values(projection.snapshot.itemsById).filter(
      (item) => item.semanticKind === "file_change",
    );

    expect(fileChanges).toEqual([
      expect.objectContaining({
        semanticKind: "file_change",
        status: "completed",
        phase: "completed",
        operation: "write",
        effect: "applied",
        path: { text: "/workspace/example.ts" },
        contentPreview: {
          text: "const first = true;\nconst value = 1;\n",
        },
        additions: 2,
        deletions: 0,
      }),
      expect.objectContaining({
        semanticKind: "file_change",
        status: "completed",
        phase: "completed",
        operation: "edit",
        effect: "applied",
        path: { text: "/workspace/example.ts" },
        replacement: {
          before: {
            text: "const first = true;\nconst value = 1;\nreturn value;\n",
          },
          after: {
            text: "const first = true;\nconst value = 2;\nreturn value;\n",
          },
        },
      }),
    ]);
    expect(fileChanges[1]).not.toHaveProperty("additions");
    expect(fileChanges[1]).not.toHaveProperty("deletions");
  });

  it("preserves a replacement that changes only final-newline state", () => {
    const projection = projectClaudeHistory([
      user(uuid(1), "add a final newline"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "edit-newline",
          name: "Edit",
          input: {
            file_path: "/workspace/example.txt",
            old_string: "value",
            new_string: "value\n",
          },
        },
      ]),
    ]);

    expect(
      Object.values(projection.snapshot.itemsById).find(
        (item) => item.semanticKind === "file_change",
      ),
    ).toMatchObject({
      semanticKind: "file_change",
      replacement: {
        before: { text: "value" },
        after: { text: "value\n" },
      },
    });
    const replacement = Object.values(projection.snapshot.itemsById).find(
      (item) => item.semanticKind === "file_change",
    );
    expect(replacement).not.toHaveProperty("additions");
    expect(replacement).not.toHaveProperty("deletions");
  });

  it.each([
    {
      label: "insertion",
      before: "head\r\ntail\r\n",
      after: "head\r\ninserted\r\ntail\r\n",
    },
    {
      label: "deletion",
      before: "head\r\ndeleted\r\ntail\r\n",
      after: "head\r\ntail\r\n",
    },
  ])(
    "preserves exact CRLF text for a one-sided $label",
    ({ before, after }) => {
      const projection = projectClaudeHistory([
        user(uuid(1), "edit"),
        assistant(uuid(2), [
          {
            type: "tool_use",
            id: "edit-one-sided",
            name: "Edit",
            input: {
              file_path: "/workspace/example.txt",
              old_string: before,
              new_string: after,
            },
          },
        ]),
      ]);

      expect(
        Object.values(projection.snapshot.itemsById).find(
          (item) => item.semanticKind === "file_change",
        ),
      ).toMatchObject({
        semanticKind: "file_change",
        replacement: {
          before: { text: before },
          after: { text: after },
        },
      });
    },
  );

  it("only promotes bounded single-replacement Edits with absolute paths", () => {
    const oversizedEdit = "before".repeat(12_000);
    const oversizedWrite = "written".repeat(20_000);
    const projection = projectClaudeHistory([
      user(uuid(1), "change files"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "replace-all",
          name: "Edit",
          input: {
            file_path: "/workspace/all.ts",
            old_string: "before",
            new_string: "after",
            replace_all: true,
          },
        },
        {
          type: "tool_use",
          id: "malformed-boolean",
          name: "Edit",
          input: {
            file_path: "/workspace/malformed.ts",
            old_string: "before",
            new_string: "after",
            replace_all: "false",
          },
        },
        {
          type: "tool_use",
          id: "empty-old-string",
          name: "Edit",
          input: {
            file_path: "/workspace/empty.ts",
            old_string: "",
            new_string: "after",
          },
        },
        {
          type: "tool_use",
          id: "relative-write",
          name: "Write",
          input: { file_path: "relative.ts", content: "content\n" },
        },
        {
          type: "tool_use",
          id: "oversized-edit",
          name: "Edit",
          input: {
            file_path: "/workspace/oversized.ts",
            old_string: oversizedEdit,
            new_string: `${oversizedEdit}after`,
          },
        },
        {
          type: "tool_use",
          id: "marker-edit",
          name: "Edit",
          input: {
            file_path: "/workspace/markers.ts",
            old_string: "--flag\n",
            new_string: "++flag\n",
          },
        },
        {
          type: "tool_use",
          id: "bounded-write",
          name: "Write",
          input: {
            file_path: "/workspace/large.ts",
            content: oversizedWrite,
          },
        },
      ]),
      user(
        uuid(3),
        [
          "replace-all",
          "malformed-boolean",
          "empty-old-string",
          "relative-write",
          "oversized-edit",
          "marker-edit",
          "bounded-write",
        ].map((toolUseId) => ({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "Done.",
        })),
      ),
      assistant(uuid(4), [{ type: "text", text: "Done." }]),
    ]);
    const items = Object.values(projection.snapshot.itemsById);
    const genericTools = items.filter((item) => item.semanticKind === "tool");
    const fileChanges = items.filter(
      (item) => item.semanticKind === "file_change",
    );

    expect(genericTools).toHaveLength(5);
    expect(fileChanges).toEqual([
      expect.objectContaining({
        semanticKind: "file_change",
        operation: "edit",
        path: { text: "/workspace/markers.ts" },
        replacement: {
          before: { text: "--flag\n" },
          after: { text: "++flag\n" },
        },
      }),
      expect.objectContaining({
        semanticKind: "file_change",
        operation: "write",
        path: { text: "/workspace/large.ts" },
        contentPreview: {
          text: expect.any(String),
          truncation: expect.objectContaining({
            truncated: true,
            reason: "byte_limit",
          }),
        },
        additions: 1,
        deletions: 0,
      }),
    ]);
  });

  it("keeps failed and malformed Claude file tools truthful", () => {
    const failed = projectClaudeHistory([
      user(uuid(1), "edit"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "/workspace/example.ts",
            old_string: "before",
            new_string: "after",
          },
        },
      ]),
      user(uuid(3), [
        {
          type: "tool_result",
          tool_use_id: "edit-1",
          content: "No match found.",
          is_error: true,
        },
      ]),
      assistant(uuid(4), [{ type: "text", text: "It failed." }]),
      user(uuid(5), "write"),
      assistant(uuid(6), [
        {
          type: "tool_use",
          id: "write-1",
          name: "Write",
          input: { file_path: "/workspace/example.ts" },
        },
      ]),
      user(uuid(7), [
        {
          type: "tool_result",
          tool_use_id: "write-1",
          content: "Invalid input.",
          is_error: true,
        },
      ]),
      assistant(uuid(8), [{ type: "text", text: "It failed." }]),
    ]);
    const items = Object.values(failed.snapshot.itemsById);

    expect(
      items.find((item) => item.semanticKind === "file_change"),
    ).toMatchObject({
      semanticKind: "file_change",
      status: "failed",
      phase: "failed",
      operation: "edit",
      effect: "unknown",
    });
    expect(
      items.find(
        (item) =>
          item.semanticKind === "tool" && item.toolName.text === "Write",
      ),
    ).toMatchObject({
      semanticKind: "tool",
      status: "failed",
      phase: "failed",
    });
  });

  it("does not treat a malformed user UUID as an operation correlation", () => {
    const projection = projectClaudeHistory([
      user("provider-generated-id", "hello"),
      assistant(uuid(1), [{ type: "text", text: "hi" }]),
    ]);
    const turnId = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(
      projection.snapshot.turnsById[turnId]?.completionCorrelations,
    ).toBeUndefined();
    expect(projection.nativeUserMessageUuidByBackendTurnId.has(turnId)).toBe(
      false,
    );
  });

  it("labels omitted assistant images and unknown native content accurately", () => {
    const projection = projectClaudeHistory([
      user(uuid(1), "show the output"),
      assistant(uuid(2), [
        { type: "image", source: { type: "base64", data: "ignored" } },
        { type: "redacted_thinking", data: "provider-private" },
      ]),
    ]);
    const notices = Object.values(projection.snapshot.itemsById).filter(
      (item) => item.semanticKind === "notice",
    );
    expect(notices).toMatchObject([
      {
        semanticKind: "notice",
        text: { text: "Claude assistant image content omitted." },
      },
      {
        semanticKind: "notice",
        text: {
          text: "Unsupported Claude content block: redacted_thinking",
        },
      },
    ]);
  });

  it("keeps failed status readable when optional stored diagnostic is malformed", () => {
    const messages = [user(uuid(1), "hello")];
    const turnId = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds[0]!;
    const projected = projectClaudeHistory(messages, [{
      backendTurnId: turnId, status: "failed", providerTerminalReason: null,
      providerResultUuid: null, terminalAt: 1, failureMessage: 42 as unknown as string,
    }]);
    expect(projected.snapshot.turnsById[turnId]).toMatchObject({
      status: "failed", failure: { message: { text: "The provider reported a failure but supplied no explanation." } },
    });
  });

  it.each([null, "Invalid model configuration"])("applies durable failed terminal evidence after transcript projection (%s)", (failureMessage) => {
    const messages = [
      user(uuid(1), "hello"),
      assistant(uuid(2), [{ type: "text", text: "partial answer" }]),
    ];
    const initial = projectClaudeHistory(messages);
    const turnId = initial.snapshot.orderedBackendTurnIds[0]!;
    const projection = projectClaudeHistory(messages, [
      {
        backendTurnId: turnId,
        status: "failed",
        failureMessage,
        providerTerminalReason: "error_during_execution",
        providerResultUuid: uuid(3),
        terminalAt: 1_000,
      },
    ]);

    expect(projection.snapshot.runState).toBe("failed");
    expect(projection.snapshot.activeBackendTurnId).toBeUndefined();
    expect(projection.snapshot.turnsById[turnId]).toMatchObject({
      status: "failed",
      endedBy: "failed",
      completedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(projection.snapshot.turnsById[turnId]!.failure?.message.text).toBe(
      failureMessage ?? "The provider reported a failure but supplied no explanation.",
    );
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(turnId)).toBe(
      false,
    );
  });

  it("projects the provider-authored terminal assistant timestamp", () => {
    const projection = projectClaudeHistory([
      { ...user(uuid(1), "hello"), timestamp: "2026-08-16T20:14:00.000Z" },
      {
        ...assistant(uuid(2), [{ type: "text", text: "answer" }]),
        timestamp: "2026-08-16T20:15:30.000Z",
      },
    ]);
    const turnId = projection.snapshot.orderedBackendTurnIds[0]!;

    expect(projection.snapshot.turnsById[turnId]).toMatchObject({
      status: "completed",
      completedAt: "2026-08-16T20:15:30.000Z",
    });
    expect(() =>
      projectClaudeHistory([
        user(uuid(3), "hello"),
        { ...assistant(uuid(4), "answer"), timestamp: "not-a-timestamp" },
      ]),
    ).toThrowError(ClaudeHistoryProjectionError);
  });

  it("terminates unresolved tool items and validates receipt identity", () => {
    const messages = [
      user(uuid(1), "inspect"),
      assistant(uuid(2), [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ]),
    ];
    const initial = projectClaudeHistory(messages);
    const turnId = initial.snapshot.orderedBackendTurnIds[0]!;
    const projection = projectClaudeHistory(messages, [
      {
        backendTurnId: turnId,
        status: "interrupted",
        providerTerminalReason: null,
        providerResultUuid: null,
        terminalAt: 2_000,
      },
    ]);
    const turn = projection.snapshot.turnsById[turnId]!;
    expect(turn).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(
      projection.snapshot.itemsById[turn.orderedBackendItemIds[1]!],
    ).toMatchObject({
      semanticKind: "tool",
      status: "interrupted",
      phase: "interrupted",
    });
    expect(
      projectClaudeHistory(messages, [
        {
          backendTurnId: "claude-turn:unknown",
          status: "failed",
          providerTerminalReason: null,
          providerResultUuid: null,
          terminalAt: 2_000,
        },
      ]).snapshot.orderedBackendTurnIds,
    ).toEqual([turnId]);
  });

  it("terminates an unresolved Claude file change without claiming it applied", () => {
    const messages = [
      user(uuid(1), "edit"),
      assistant(uuid(2), [
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "/workspace/example.ts",
            old_string: "before",
            new_string: "after",
          },
        },
      ]),
    ];
    const initial = projectClaudeHistory(messages);
    const turnId = initial.snapshot.orderedBackendTurnIds[0]!;
    const projection = projectClaudeHistory(messages, [
      {
        backendTurnId: turnId,
        status: "interrupted",
        providerTerminalReason: null,
        providerResultUuid: null,
        terminalAt: 2_000,
      },
    ]);
    const turn = projection.snapshot.turnsById[turnId]!;

    expect(
      projection.snapshot.itemsById[turn.orderedBackendItemIds[1]!],
    ).toMatchObject({
      semanticKind: "file_change",
      status: "interrupted",
      phase: "interrupted",
      operation: "edit",
      effect: "unknown",
    });
  });

  it("returns a latest-ten snapshot and deterministic whole-turn history pages", () => {
    const messages = Array.from({ length: 13 }, (_, index) => [
      user(uuid(index * 2 + 1), `prompt ${index}`),
      assistant(uuid(index * 2 + 2), [
        { type: "text", text: `answer ${index}` },
      ]),
    ]).flat();
    const projection = projectClaudeHistory(messages);
    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(projection.history.previousCursor).toBeTruthy();

    const older = projectClaudeHistoryPage(messages, {
      cursor: projection.history.previousCursor,
      limit: 2,
    });
    expect(older.orderedBackendTurnIds).toHaveLength(2);
    expect(
      older.orderedBackendTurnIds.every(
        (turnId) => older.turnsById[turnId]?.orderedBackendItemIds.length === 2,
      ),
    ).toBe(true);
    expect(older.previousCursor).toBeTruthy();
    const oldest = projectClaudeHistoryPage(messages, {
      cursor: older.previousCursor,
      limit: 100,
    });
    expect(oldest.orderedBackendTurnIds).toHaveLength(1);
    expect(oldest.previousCursor).toBeUndefined();
  });

  it("exposes exact coordinates for an incrementally retained live projection tail", () => {
    const messages = Array.from({ length: 13 }, (_, index) => [
      user(uuid(index * 2 + 1), `prompt ${index}`),
      assistant(uuid(index * 2 + 2), [
        { type: "text", text: `answer ${index}` },
      ]),
    ]).flat();
    const full = projectClaudeHistory(messages);
    expect(full.window).toEqual({
      sourceTurnCount: 13,
      latestStartTurnIndex: 3,
      retainedStartTurnIndex: 2,
      retainedNativeMessageStartIndex: 4,
      retainedUserMessageOrdinal: 2,
    });

    const retained = messages.slice(
      full.window.retainedNativeMessageStartIndex,
    );
    const advanced = projectClaudeLatestSnapshot(
      [
        ...retained,
        user(uuid(100), "next prompt"),
        assistant(uuid(101), [{ type: "text", text: "next answer" }]),
      ],
      [],
      undefined,
      {
        turnOffset: full.window.retainedStartTurnIndex,
        userMessageOrdinalBase: full.window.retainedUserMessageOrdinal,
      },
    );
    expect(advanced.window).toEqual({
      sourceTurnCount: 14,
      latestStartTurnIndex: 4,
      retainedStartTurnIndex: 3,
      retainedNativeMessageStartIndex: 2,
      retainedUserMessageOrdinal: 3,
    });
    expect(advanced.snapshot.orderedBackendTurnIds).toHaveLength(10);
  });

  it("keeps an oversized latest turn attachable with a deterministic omission notice", () => {
    const messages = [
      user(uuid(1), "large current turn"),
      assistant(
        uuid(2),
        Array.from({ length: 1_100 }, (_, index) => ({
          type: "text",
          text: `${index}:`.padEnd(65_536, "x"),
        })),
      ),
    ];

    const projection = projectClaudeHistory(messages);
    const turnId = projection.snapshot.orderedBackendTurnIds[0]!;
    const items = projection.snapshot.turnsById[
      turnId
    ]!.orderedBackendItemIds.map(
      (itemId) => projection.snapshot.itemsById[itemId]!,
    );
    expect(serializedUtf8Bytes(projection.snapshot)).toBeLessThanOrEqual(
      MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(items[0]?.semanticKind).toBe("user_message");
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "notice",
          tone: "warning",
          text: expect.objectContaining({
            text: expect.stringContaining("oversized current turn"),
          }),
        }),
      ]),
    );
    expect(() => projectClaudeHistoryPage(messages, { limit: 1 })).toThrowError(
      ClaudeHistoryProjectionError,
    );
  });

  it("does not reject valid history at the former 20,000-message ceiling", () => {
    const messages = [
      ...Array.from({ length: 20_001 }, (_, index) => ({
        type: "system",
        uuid: uuid(index + 1_000),
        session_id: uuid(900),
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "system", content: "provider checkpoint" },
      })),
      user(uuid(30_000), "still available"),
      assistant(uuid(30_001), [{ type: "text", text: "still projected" }]),
    ];

    const projection = projectClaudeHistory(messages);

    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(1);
    expect(JSON.stringify(projection.snapshot)).toContain("still projected");
  });

  it("rejects stale cursors and malformed runtime transcript shapes", () => {
    const messages = [
      user(uuid(1), "one"),
      assistant(uuid(2), [{ type: "text", text: "two" }]),
    ];
    expect(() =>
      projectClaudeHistoryPage(messages, {
        cursor: "claude-history:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1",
        limit: 10,
      }),
    ).toThrowError(ClaudeHistoryProjectionError);
    expect(() =>
      projectClaudeHistory([{ ...messages[0], parent_tool_use_id: 4 }]),
    ).toThrowError(ClaudeHistoryProjectionError);
  });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function claudeLegacyTag(fields: readonly string[]): string {
  const hmac = createHmac("sha256", markerAuthentication.installationKey);
  for (const field of fields) {
    hmac.update(String(Buffer.byteLength(field, "utf8"))).update(":");
    hmac.update(field).update("\0");
  }
  return hmac.digest("base64url");
}

function user(id: string, content: unknown) {
  return {
    type: "user",
    uuid: id,
    session_id: uuid(900),
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content },
  };
}

function assistant(
  id: string,
  content: unknown,
  usage: Readonly<Record<string, unknown>> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
) {
  return {
    type: "assistant",
    uuid: id,
    session_id: uuid(900),
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "assistant", content, usage },
  };
}

describe("Claude stable subagent lifecycle ordering", () => {
  it("keeps terminal row identity stable when agents finish out of order and the parent continues", () => {
    const messages = [user(uuid(1), "Run both"), assistant(uuid(2), [
      { type: "tool_use", id: "call-a", name: "Agent", input: { description: "A", prompt: "Work" } },
      { type: "tool_use", id: "call-b", name: "Agent", input: { description: "B", prompt: "Work" } },
    ]), user(uuid(3), [
      { type: "tool_result", tool_use_id: "call-a", content: "Async launched" },
      { type: "tool_result", tool_use_id: "call-b", content: "Async launched" },
    ])];
    const receipts = [
      { nativeTaskId: "a", nativeToolUseId: "call-a", description: "A", startedAt: 1, terminalStatus: null, terminalAt: null },
      { nativeTaskId: "b", nativeToolUseId: "call-b", description: "B", startedAt: 2, terminalStatus: "completed" as const, terminalAt: 3 },
    ];
    const first = projectClaudeHistory(messages, [], { ...historyAuthentication, taskLifecycleReceipts: receipts }).snapshot;
    const b = Object.values(first.itemsById).find(item => item.semanticKind === "collaboration" && item.summary?.text === "Subagent completed · B")!;
    const second = projectClaudeHistory([...messages, assistant(uuid(4), "Parent continues")], [], {
      ...historyAuthentication,
      taskLifecycleReceipts: [{ ...receipts[0]!, terminalStatus: "completed", terminalAt: 4 }, receipts[1]!],
    }).snapshot;
    expect(second.itemsById[b.backendItemId]).toEqual(b);
    const turn = second.turnsById[second.orderedBackendTurnIds[0]!]!;
    const orderedItems = turn.orderedBackendItemIds.map(id => second.itemsById[id]!);
    expect(orderedItems.map(item => item.sourceOrder)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(orderedItems.filter(item => item.semanticKind === "collaboration").map(item => item.summary?.text)).toEqual([
      "Started subagent · A", "Subagent completed · A", "Started subagent · B", "Subagent completed · B",
    ]);
  });
});


describe("Claude internal task notification history", () => {
  const envelope = "<task-notification>\n<task-id>child</task-id>\n<tool-use-id>call</tool-use-id>\n<status>completed</status>\n<summary>Finished</summary>\n</task-notification>";
  const notification = { ...user(uuid(3), envelope), origin: { kind: "task-notification" } };
  const beginning = [user(uuid(1), "Start background work"), assistant(uuid(2), "Started")];

  it("uses the real SDK's retained origin, keeps the assistant follow-up, and excludes notification prompt counts", async () => {
    const entries: SessionStoreEntry[] = [...beginning, notification, assistant(uuid(4), "The agent finished")].map((message, index, messages) => ({
      ...message, sessionId: uuid(900), parentUuid: index ? messages[index - 1]!.uuid : null,
      timestamp: `2026-09-17T01:00:0${index}.000Z`, isSidechain: false,
    }));
    const messages = await getSessionMessages(uuid(900), { dir: "/fixture", includeSystemMessages: true,
      sessionStore: { append: async () => undefined, load: async () => entries } });
    expect(messages[2]).toMatchObject({ origin: { kind: "task-notification" } });
    const projection = projectClaudeHistory(messages);
    const items = Object.values(projection.snapshot.itemsById);
    expect(items.filter(item => item.semanticKind === "user_message")).toHaveLength(1);
    expect(items.filter(item => item.semanticKind === "assistant_message")).toHaveLength(2);
    expect(JSON.stringify(projection.snapshot)).not.toContain("<task-notification>");
    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(2);
    expect(projection.nativeUserMessageUuidByBackendTurnId.size).toBe(1);
    expect(nextClaudeUserMessageOrdinal(messages, markerAuthentication)).toBe(1);
    expect(projection.snapshot.runState).toBe("idle");
  });

  it("does not invent an empty running turn for a trailing internal notification", () => {
    const original = projectClaudeHistory(beginning);
    const after = projectClaudeHistory([...beginning, notification]);
    expect(after.snapshot).toEqual(original.snapshot);
    expect(after.terminalCheckpointUuidByBackendTurnId).toEqual(original.terminalCheckpointUuidByBackendTurnId);
    expect(nextClaudeUserMessageOrdinal([...beginning, notification] as SessionMessage[], markerAuthentication)).toBe(1);
  });

  it("shows one notice on the fork-point turn for background work a fork did not carry", () => {
    const orphan = (id: number) => ({ ...user(uuid(id), "<task-notification>\n<task-id>running</task-id>\n<status>failed</status>\n<summary>Background agent didn't finish</summary>\n</task-notification>"),
      origin: { kind: "task-notification" } });
    const messages = [...beginning, orphan(5), orphan(6)] as SessionMessage[];
    const plain = projectClaudeHistory(beginning);
    const projection = projectClaudeHistory(messages, [], {
      attachmentProvenanceKey: new Uint8Array(32), forkBoundaryAuthentication: markerAuthentication,
      forkOmittedTaskNotifications: new Set([uuid(5), uuid(6)]),
    });
    const [turnId] = projection.snapshot.orderedBackendTurnIds;
    expect(projection.snapshot.orderedBackendTurnIds).toEqual(plain.snapshot.orderedBackendTurnIds);
    const notices = projection.snapshot.turnsById[turnId!]!.orderedBackendItemIds
      .map(id => projection.snapshot.itemsById[id]!).filter(item => item.semanticKind === "notice");
    expect(notices).toEqual([expect.objectContaining({ tone: "warning", text: { text:
      "Background work started before this fork point was not carried into the fork. Claude was told it did not finish; its results, if any, are in the source thread." } })]);
    // The fork point stays an exact checkpoint, and nothing reads as running.
    expect(projection.terminalCheckpointUuidByBackendTurnId).toEqual(plain.terminalCheckpointUuidByBackendTurnId);
    expect(projection.snapshot.runState).toBe("idle");
    expect(JSON.stringify(projection.snapshot)).not.toContain("<task-notification>");
  });

  describe("turns Claude starts itself", () => {
    const answer = (id: string, messageId: string, text: string) => ({
      ...assistant(id, [{ type: "text", text }]),
      message: { id: messageId, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} },
    });
    const followUp = answer(uuid(4), "msg-notified", "The agent finished");
    const liveMarker = { type: "system", uuid: uuid(700), session_id: uuid(900),
      parent_tool_use_id: null, parent_agent_id: null, message: {} };
    const live = { ...historyAuthentication, providerTurnBoundaries: new Map([[uuid(700), "msg-notified"]]) };
    const turnShape = (snapshot: ReturnType<typeof projectClaudeHistory>["snapshot"]) =>
      snapshot.orderedBackendTurnIds.map(id => ({ ...snapshot.turnsById[id],
        items: snapshot.turnsById[id]!.orderedBackendItemIds.map(itemId => snapshot.itemsById[itemId]) }));

    it("identifies a notification turn by its first response so live and reload agree", () => {
      const reloaded = projectClaudeLatestSnapshot([...beginning, notification, followUp], [], historyAuthentication);
      // Claude streams no notification row; the live path marks the boundary.
      const observed = projectClaudeLatestSnapshot([...beginning, liveMarker, followUp], [], live);
      expect(reloaded.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(turnShape(observed.snapshot)).toEqual(turnShape(reloaded.snapshot));
      expect(reloaded.nativeUserMessageUuidByBackendTurnId.size).toBe(1);
    });

    it("keeps a live marker's turn open before its first complete response", () => {
      const observed = projectClaudeLatestSnapshot([...beginning, liveMarker], [], live);
      const id = observed.snapshot.orderedBackendTurnIds.at(-1)!;
      expect(observed.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(observed.snapshot.turnsById[id]).toMatchObject({ status: "in_progress", orderedBackendItemIds: [] });
      expect(id).toBe(projectClaudeLatestSnapshot([...beginning, notification, followUp], [], historyAuthentication)
        .snapshot.orderedBackendTurnIds.at(-1));
    });

    it("ignores a live marker already covered by merged provider history", () => {
      const reloaded = projectClaudeLatestSnapshot([...beginning, notification, followUp], [], historyAuthentication);
      const merged = projectClaudeLatestSnapshot([...beginning, notification, followUp, liveMarker], [], live);
      expect(turnShape(merged.snapshot)).toEqual(turnShape(reloaded.snapshot));
    });

    it("opens one turn for coalesced notifications and none when stopped before a response", () => {
      const second = { ...notification, uuid: uuid(5) };
      const coalesced = projectClaudeHistory([...beginning, notification, second, followUp]);
      expect(coalesced.snapshot.orderedBackendTurnIds).toHaveLength(2);
      const stopped = projectClaudeHistory([...beginning, notification,
        { ...user(uuid(6), [{ type: "text", text: "[Request interrupted by user]" }]), timestamp: "2026-09-17T07:16:01.463Z" }]);
      expect(stopped.snapshot).toEqual(projectClaudeHistory(beginning).snapshot);
    });
  });

  it.each([undefined, { kind: "human" }, { kind: "task-notification", subkind: "scheduled-trigger" },
    { kind: "task-notification", subkind: "peer-send-message" }])("preserves identical text when origin is %j", origin => {
    const projection = projectClaudeHistory([{ ...notification, origin }]);
    expect(Object.values(projection.snapshot.itemsById).filter(item => item.semanticKind === "user_message")).toHaveLength(1);
    expect(JSON.stringify(projection.snapshot)).toContain("<task-notification>");
  });

  it("preserves task-origin prompts that are not a complete notification envelope", () => {
    const projection = projectClaudeHistory([{ ...notification, message: { role: "user", content: "Please inspect this <task-notification> example" } }]);
    expect(Object.values(projection.snapshot.itemsById).filter(item => item.semanticKind === "user_message")).toHaveLength(1);
  });
});
