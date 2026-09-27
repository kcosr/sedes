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
  projectClaudeHistoryPageAtIndex,
  projectClaudeLatestSnapshot,
  type ClaudeTerminalReceiptOverride,
} from "../../src/server/backends/claude/claude-history-projector.js";
import { claudeForkContextBoundaryText } from "../../src/server/backends/claude/claude-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import { claudeAttachmentEnvelope } from "../../src/server/backends/claude/claude-attachment-manifest.js";
import { claudeViewedImagePublicationKey } from "../../src/server/backends/claude/claude-viewed-images.js";
import type { OutputImageArtifactDescriptor } from "../../src/server/output-artifacts/contracts.js";
import { MAXIMUM_BACKEND_ITEMS_PER_TURN, type BackendConversationSnapshot } from "../../src/shared/protocol/backend.js";
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

describe("Claude turn completion from native stop reasons", () => {
  // Claude Code 2.1.28x writes one row per content block, and every row of a
  // message carries that message's final stop reason.
  let time = 0;
  function row(index: number, id: string, block: unknown, stopReason: string) {
    time += 1;
    return {
      ...assistant(uuid(index), [block]),
      timestamp: new Date(Date.UTC(2026, 8, 26, 0, 0, time)).toISOString(),
      message: { role: "assistant", id, content: [block], stop_reason: stopReason },
    };
  }
  const thinking = { type: "thinking", thinking: "Planning", signature: "s" };
  const toolUse = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "true" } });
  const toolResult = (index: number, id: string) => user(uuid(index), [{ type: "tool_result", tool_use_id: id, content: "ok" }]);
  const toolTurn = () => [
    user(uuid(1), "Inspect"),
    row(2, "msg-1", thinking, "tool_use"),
    row(3, "msg-1", { type: "text", text: "Checking" }, "tool_use"),
    row(4, "msg-1", toolUse("tool-1"), "tool_use"),
    toolResult(5, "tool-1"),
  ];

  it("keeps a turn that ended on a tool result unfinished, however its earlier rows ended", () => {
    const projection = projectClaudeHistory(toolTurn());
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]).toMatchObject({ status: "in_progress" });
    expect(projection.snapshot.turnsById[id]).not.toHaveProperty("forkUnavailableReason");
    expect(projection.snapshot).toMatchObject({ runState: "running", activeBackendTurnId: id });
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(id)).toBe(false);
    expect(projection.terminalAssistantUuidByBackendTurnId.has(id)).toBe(false);
  });

  it.each([1, 2])("never ends a turn at the first %s block rows of a message that stopped for a tool call", (rows) => {
    const projection = projectClaudeHistory(toolTurn().slice(0, rows + 1));
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]?.status).toBe("in_progress");
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(id)).toBe(false);
  });

  it("completes that turn at its final answer and forks from the answer's last row", () => {
    const projection = projectClaudeHistory([...toolTurn(),
      row(6, "msg-2", thinking, "end_turn"), row(7, "msg-2", { type: "text", text: "Done" }, "end_turn")]);
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]).toMatchObject({ status: "completed", endedBy: "agent_settled" });
    expect(projection.snapshot.turnsById[id]).not.toHaveProperty("forkUnavailableReason");
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(id)).toBe(uuid(7));
    expect(Object.values(projection.snapshot.itemsById).filter(item => item.semanticKind === "assistant_message")
      .map(item => [item.markdown.text, item.responsePhase])).toEqual([["Checking", "provisional"], ["Done", "final"]]);
  });

  it("reopens an answered turn that Claude continued (a blocking Stop hook's hidden row)", () => {
    const projection = projectClaudeHistory([user(uuid(1), "Answer"),
      row(2, "msg-1", { type: "text", text: "First answer" }, "end_turn"),
      row(3, "msg-2", toolUse("tool-2"), "tool_use"), toolResult(4, "tool-2")]);
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]?.status).toBe("in_progress");
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(id)).toBe(false);
  });

  it("completes a max_tokens response continued to its final answer", () => {
    const projection = projectClaudeHistory([user(uuid(1), "Write it"),
      row(2, "msg-1", { type: "text", text: "Part one" }, "max_tokens"),
      row(3, "msg-2", { type: "text", text: "Part two" }, "end_turn")]);
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]?.status).toBe("completed");
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(id)).toBe(uuid(3));
  });

  it("keeps a turn running while a steer folded after its answer awaits a response", () => {
    const steerOperations = new Map([[uuid(3), uuid(1)]]);
    const authentication = { ...historyAuthentication, steerOperations };
    const answered = [user(uuid(1), "Answer"), row(2, "msg-1", { type: "text", text: "Answer" }, "end_turn"),
      user(uuid(3), "Also this")];
    const pending = projectClaudeHistory(answered, [], authentication);
    const id = pending.snapshot.orderedBackendTurnIds[0]!;
    expect(pending.snapshot.orderedBackendTurnIds).toEqual([id]);
    expect(pending.snapshot.turnsById[id]).toMatchObject({ status: "in_progress", completionCorrelations: [uuid(1), uuid(3)] });
    const settled = projectClaudeHistory([...answered, row(4, "msg-2", { type: "text", text: "And that" }, "end_turn")], [], authentication);
    expect(settled.snapshot.turnsById[id]?.status).toBe("completed");
    expect(settled.terminalCheckpointUuidByBackendTurnId.get(id)).toBe(uuid(4));
  });

  it("closes a turn that ended on a tool result as interrupted when Claude Code resumes it", () => {
    const closure = { ...row(6, "msg-closure", { type: "text", text: "No response requested." }, "stop_sequence"),
      message: { role: "assistant", id: "msg-closure", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }], stop_reason: "stop_sequence" } };
    const projection = projectClaudeHistory([...toolTurn(), closure]);
    const id = projection.snapshot.orderedBackendTurnIds[0]!;
    expect(projection.snapshot.turnsById[id]).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
    expect(projection.snapshot.runState).toBe("idle");
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

describe("Claude tool calls stopped by the user", () => {
  const timestamp = "2026-09-26T10:00:05.000Z";
  // Claude Code 2.1.281-2.1.283's exact results for a call an interrupt stopped.
  const stopped = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const cancelled = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
  const correctionNote = "\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";
  const prompt = user(uuid(1), "Run the checks");
  const call = (index: number, messageId: string, id: string, name = "Bash", input: unknown = { command: `sleep ${index}` }) => ({
    ...assistant(uuid(index), [{ type: "tool_use", id, name, input }]),
    message: { role: "assistant", id: messageId, content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" },
  });
  const result = (index: number, id: string, content: unknown, isError = true) =>
    ({ ...user(uuid(index), [{ type: "tool_result", tool_use_id: id, content, is_error: isError }]),
      timestamp: `2026-09-26T10:00:04.${String(index).padStart(3, "0")}Z` });
  const marker = (index: number, text = "[Request interrupted by user for tool use]") =>
    ({ ...user(uuid(index), [{ type: "text", text }]), timestamp });
  const tools = (messages: readonly unknown[]) => {
    const snapshot = projectClaudeHistory(messages).snapshot;
    expect(projectClaudeHistoryPage(messages, { limit: 10 }).itemsById).toEqual(snapshot.itemsById);
    return Object.values(snapshot.itemsById).filter(item => item.semanticKind !== "user_message" && item.semanticKind !== "assistant_message");
  };
  const outcomes = (messages: readonly unknown[]) =>
    tools(messages).map(item => [item.status, "phase" in item ? item.phase : undefined, item.completedAt]);

  it("ends a running call interrupted when the tool-use marker follows its stop result", () => {
    const [command] = tools([prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", stopped), marker(4)]);
    expect(command).toMatchObject({ semanticKind: "command", status: "interrupted", phase: "interrupted", completedAt: timestamp,
      output: { text: stopped } });
  });

  it("keeps a parallel call's own failure failed while Stop interrupts its running sibling", () => {
    // Claude Code runs both; one exits 1, then Stop aborts the other.
    const failure = "Exit code 1\ncat: missing.txt: No such file or directory";
    const unstopped = [prompt, call(2, "msg-1", "tool-a"), call(3, "msg-1", "tool-b"), result(4, "tool-a", failure)];
    const live = [...unstopped, result(5, "tool-b", stopped), marker(6)];
    const reordered = [prompt, live[1], live[3], live[2], live[4], live[5]];
    const [ownFailure] = tools(unstopped);
    expect(ownFailure).toMatchObject({ status: "failed", phase: "failed", output: { text: failure } });
    expect(ownFailure).not.toHaveProperty("completedAt");
    for (const messages of [live, reordered]) {
      const [failed, interrupted] = tools(messages);
      // The failure is exactly what Claude reported: no Stop status or time.
      expect(failed).toEqual(ownFailure);
      expect(interrupted).toMatchObject({ status: "interrupted", phase: "interrupted", completedAt: timestamp, output: { text: stopped } });
    }
  });

  it("keeps a successful sibling completed, in live and reordered history order", () => {
    const live = [prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", "done", false), call(4, "msg-1", "tool-b"),
      result(5, "tool-b", stopped), marker(6)];
    const reordered = [prompt, live[1], live[3], live[2], live[4], live[5]];
    for (const messages of [live, reordered]) {
      expect(outcomes(messages)).toEqual([["completed", "completed", undefined], ["interrupted", "interrupted", timestamp]]);
    }
  });

  it("interrupts every call of a batch Stop stopped, running, queued, or reaching execution late", () => {
    const messages = [prompt, call(2, "msg-1", "tool-a"), call(3, "msg-1", "tool-b"), call(4, "msg-1", "tool-c"),
      call(5, "msg-1", "tool-d"), result(6, "tool-a", stopped), result(7, "tool-b", stopped + correctionNote),
      result(8, "tool-c", cancelled), result(9, "tool-d", cancelled + correctionNote), marker(10)];
    expect(outcomes(messages)).toEqual(Array.from({ length: 4 }, () => ["interrupted", "interrupted", timestamp]));
  });

  it("keeps a permission Sedes denied failed in a stopped batch and interrupts a prompt Stop closed", () => {
    // Sedes' callback supplies its own denial text, which Claude Code writes
    // as the result; Claude Code writes its stop result when Stop closes an
    // open prompt instead.
    const denied = [prompt, call(2, "msg-1", "tool-a"), call(3, "msg-1", "tool-b"),
      result(4, "tool-a", "User denied permission."), result(5, "tool-b", stopped), marker(6)];
    expect(outcomes(denied)).toEqual([["failed", "failed", undefined], ["interrupted", "interrupted", timestamp]]);
    const promptClosed = [prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", stopped), marker(4)];
    expect(outcomes(promptClosed)).toEqual([["interrupted", "interrupted", timestamp]]);
  });

  it("requires Claude Code's exact stop result on the call itself", () => {
    for (const content of ["The user doesn't want to proceed with this tool use.", `${stopped} `, `Error: ${stopped}`,
      [{ type: "text", text: stopped }], "Permission request cancelled."]) {
      expect(outcomes([prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", content), marker(4)]))
        .toEqual([["failed", "failed", undefined]]);
    }
    expect(outcomes([prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", stopped, false), marker(4)]))
      .toEqual([["completed", "completed", undefined]]);
  });

  it("keeps a denial or an earlier batch's failure failed", () => {
    const denied = [prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", "User denied permission.")];
    expect(tools(denied)[0]).toMatchObject({ status: "failed", phase: "failed" });
    const continued = [...denied, {
      ...assistant(uuid(4), [{ type: "text", text: "It was denied." }]),
      message: { role: "assistant", id: "msg-2", content: [{ type: "text", text: "It was denied." }], stop_reason: "end_turn" },
    }];
    expect(tools(continued)[0]).toMatchObject({ status: "failed", phase: "failed" });
    const laterStop = [...denied, call(4, "msg-2", "tool-b"), result(5, "tool-b", stopped), marker(6)];
    expect(tools(laterStop).map(item => item.status)).toEqual(["failed", "interrupted"]);
    // A stop result from an earlier batch is not this marker's evidence.
    const earlier = [prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", stopped), call(4, "msg-2", "tool-b"),
      result(5, "tool-b", "exit 1"), marker(6)];
    expect(tools(earlier).map(item => item.status)).toEqual(["failed", "failed"]);
  });

  it("keeps stop results failed after the streaming interruption marker or a subagent's marker", () => {
    for (const content of ["exit 1", stopped]) {
      const failed = [prompt, call(2, "msg-1", "tool-a"), result(3, "tool-a", content)];
      expect(tools([...failed, marker(4, "[Request interrupted by user]")])[0]).toMatchObject({ status: "failed" });
      const child = { ...marker(4), parent_tool_use_id: "tool-agent" };
      expect(tools([...failed, child])[0]).toMatchObject({ status: "failed" });
    }
  });

  it("interrupts a stopped subagent launch without calling it a launch failure", () => {
    const [launch] = tools([prompt, call(2, "msg-1", "tool-agent", "Agent", { description: "Review", prompt: "Review it" }),
      result(3, "tool-agent", stopped), marker(4)]);
    expect(launch).toMatchObject({ semanticKind: "collaboration", status: "interrupted", completedAt: timestamp,
      summary: { text: "Started subagent · Review" } });
    expect(launch).not.toHaveProperty("error");
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


describe("Claude resume closure rows", () => {
  const notice = "Claude Code exited before this turn finished and closed it without a response when the conversation resumed.";
  /** Claude Code's resume closure: a zero-usage `<synthetic>` assistant row. */
  function closure(index: number, overrides: { model?: string; content?: unknown } = {}) {
    return {
      ...assistant(uuid(index), overrides.content ?? [{ type: "text", text: "No response requested." }]),
      timestamp: `2026-09-20T00:00:${String(index).padStart(2, "0")}.000Z`,
      message: { id: `8d7c6b5a-0000-4000-8000-${String(index).padStart(12, "0")}`, model: overrides.model ?? "<synthetic>",
        role: "assistant", stop_reason: "stop_sequence", stop_sequence: "", type: "message",
        content: overrides.content ?? [{ type: "text", text: "No response requested." }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    };
  }
  const answered = [user(uuid(1), "Explain the parser"), {
    ...assistant(uuid(2), [{ type: "text", text: "It splits lines." }]),
    message: { id: "msg-answer", role: "assistant", model: "claude-synthetic-1", stop_reason: "end_turn",
      content: [{ type: "text", text: "It splits lines." }], usage: { input_tokens: 1, output_tokens: 1 } },
  }];
  const texts = (snapshot: ReturnType<typeof projectClaudeHistory>["snapshot"]) =>
    Object.values(snapshot.itemsById).flatMap((item) =>
      item.semanticKind === "assistant_message" ? [item.markdown.text] : item.semanticKind === "notice" ? [`notice:${item.text.text}`] : []);

  it("drops closures of the startup message after a settled turn without touching its identity or checkpoint", () => {
    const original = projectClaudeHistory(answered);
    for (const closures of [[closure(10)], [closure(10), closure(11), closure(12)]]) {
      const reopened = projectClaudeHistory([...answered, ...closures]);
      expect(reopened.snapshot).toEqual(original.snapshot);
      expect(reopened.usage).toEqual(original.usage);
      expect(reopened.terminalCheckpointUuidByBackendTurnId).toEqual(new Map([[original.snapshot.orderedBackendTurnIds[0]!, uuid(2)]]));
      expect(reopened.terminalAssistantUuidByBackendTurnId).toEqual(original.terminalAssistantUuidByBackendTurnId);
      expect([...reopened.backendTurnIdByMessageUuid.keys()]).toEqual([uuid(2)]);
      expect(nextClaudeUserMessageOrdinal([...answered, ...closures] as SessionMessage[], markerAuthentication)).toBe(1);
    }
  });

  it("projects no turn for a thread that was reopened without ever being sent", () => {
    const projection = projectClaudeHistory([closure(10), closure(11)]);
    expect(projection.snapshot.orderedBackendTurnIds).toEqual([]);
    expect(projection.snapshot.runState).toBe("idle");
    expect(projection.usage?.counters).toMatchObject({ assistantMessages: 0, totalMessages: 0 });
    expect(nextClaudeUserMessageOrdinal([closure(10)] as SessionMessage[], markerAuthentication)).toBe(0);
    const next = projectClaudeHistory([closure(10), closure(11), ...answered]);
    expect(next.snapshot).toEqual(projectClaudeHistory(answered).snapshot);
  });

  it("ends an unanswered prompt as interrupted with a stable diagnostic instead of a completed answer", () => {
    const prompt = user(uuid(1), "A prompt the process never answered");
    const projection = projectClaudeHistory([prompt, closure(10)]);
    const [turnId] = projection.snapshot.orderedBackendTurnIds;
    expect(projection.snapshot.orderedBackendTurnIds).toEqual([projectClaudeHistory([prompt]).snapshot.orderedBackendTurnIds[0]]);
    expect(projection.snapshot.turnsById[turnId!]).toMatchObject({
      status: "interrupted", endedBy: "interrupted", completedAt: "2026-09-20T00:00:10.000Z",
    });
    expect(texts(projection.snapshot)).toEqual([`notice:${notice}`]);
    expect(Object.values(projection.snapshot.itemsById).find((item) => item.semanticKind === "notice")).toMatchObject({ tone: "warning" });
    expect(projection.snapshot.runState).toBe("idle");
    expect(projection.terminalCheckpointUuidByBackendTurnId.size).toBe(0);
    expect(projection.terminalAssistantUuidByBackendTurnId.size).toBe(0);
    expect(projection.nativeUserMessageUuidByBackendTurnId.get(turnId!)).toBe(uuid(1));
    // Later resumes close the startup message again; the ended turn is unchanged.
    expect(projectClaudeHistory([prompt, closure(10), closure(11), closure(12)]).snapshot).toEqual(projection.snapshot);
    const followUp = projectClaudeHistory([prompt, closure(10), closure(11), ...answered.map((message, index) => ({ ...message, uuid: uuid(20 + index) }))]);
    expect(followUp.snapshot.orderedBackendTurnIds).toHaveLength(2);
    expect(followUp.snapshot.turnsById[turnId!]).toEqual(projection.snapshot.turnsById[turnId!]);
  });

  it.each(["completed", "interrupted", "failed"] as const)("defers to a %s Sedes receipt for the closed turn", (status) => {
    const prompt = user(uuid(1), "Receipt-settled prompt");
    const turnId = projectClaudeHistory([prompt]).snapshot.orderedBackendTurnIds[0]!;
    const receipt: ClaudeTerminalReceiptOverride = { backendTurnId: turnId, status, providerTerminalReason: null,
      providerResultUuid: null, terminalAt: 5_000 };
    const projection = projectClaudeHistory([prompt, closure(10)], [receipt]);
    expect(projection.snapshot.turnsById[turnId]).toMatchObject({ status, completedAt: new Date(5_000).toISOString() });
    expect(texts(projection.snapshot)).toEqual([]);
  });

  it("ends a turn cut off after a tool result or partial output, settling unresolved tools", () => {
    const call = { ...assistant(uuid(2), [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/file" } }]),
      message: { id: "msg-call", role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/file" } }] } };
    const result = user(uuid(3), [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }]);
    const afterResult = projectClaudeHistory([user(uuid(1), "Read it"), call, result, closure(10)]).snapshot;
    expect(Object.values(afterResult.turnsById).map((turn) => turn.status)).toEqual(["interrupted"]);
    expect(texts(afterResult)).toEqual([`notice:${notice}`]);

    const partial = { ...assistant(uuid(4), [{ type: "text", text: "Starting" }]),
      message: { id: "msg-partial", role: "assistant", stop_reason: null, content: [{ type: "text", text: "Starting" }] } };
    const afterPartial = projectClaudeHistory([user(uuid(1), "Read it"), partial, closure(10)]).snapshot;
    expect(Object.values(afterPartial.turnsById).map((turn) => turn.status)).toEqual(["interrupted"]);
    expect(texts(afterPartial)).toEqual(["Starting", `notice:${notice}`]);

    const unresolved = projectClaudeHistory([user(uuid(1), "Read it"), call, closure(10)]).snapshot;
    expect(Object.values(unresolved.turnsById).map((turn) => turn.status)).toEqual(["interrupted"]);
    expect(Object.values(unresolved.itemsById).find((item) => item.semanticKind === "file_read")?.status).toBe("interrupted");
  });

  it("keeps an interruption marker's turn as it was", () => {
    const marker = { ...user(uuid(3), [{ type: "text", text: "[Request interrupted by user]" }]), timestamp: "2026-09-20T00:00:03.000Z" };
    const history = [user(uuid(1), "Long task"), assistant(uuid(2), [{ type: "text", text: "Working" }]), marker];
    expect(projectClaudeHistory([...history, closure(10)]).snapshot).toEqual(projectClaudeHistory(history).snapshot);
  });

  it("drops a closure of an unanswered task notification with the notification itself", () => {
    const notification = { ...user(uuid(3), "<task-notification>\n<task-id>child</task-id>\n<status>stopped</status>\n<summary>Background agent \"survey\" didn't finish before the previous session ended</summary>\n</task-notification>"),
      origin: { kind: "task-notification" } };
    const projection = projectClaudeHistory([...answered, notification, closure(10)]);
    expect(projection.snapshot).toEqual(projectClaudeHistory(answered).snapshot);
    expect(projection.terminalCheckpointUuidByBackendTurnId).toEqual(projectClaudeHistory(answered).terminalCheckpointUuidByBackendTurnId);
  });

  it.each([
    ["an API error", { content: [{ type: "text", text: "API Error: synthetic failure" }] }],
    ["a model reply with the same text", { model: "claude-synthetic-1" }],
    ["extra content", { content: [{ type: "text", text: "No response requested." }, { type: "text", text: "More." }] }],
    ["different text", { content: [{ type: "text", text: "No response requested" }] }],
  ])("keeps %s as an ordinary assistant message", (_label, overrides) => {
    const snapshot = projectClaudeHistory([user(uuid(1), "Prompt"), closure(10, overrides)]).snapshot;
    expect(Object.values(snapshot.turnsById).map((turn) => turn.status)).toEqual(["completed"]);
    expect(texts(snapshot).length).toBeGreaterThan(0);
    expect(texts(snapshot).some((text) => text.startsWith("notice:"))).toBe(false);
  });

  it("recognizes only the timestamped native closure shape", () => {
    const { timestamp: _timestamp, ...untimed } = closure(10);
    const snapshot = projectClaudeHistory([...answered, untimed]).snapshot;
    expect(texts(snapshot)).toContain("No response requested.");
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

  it("explains why a completed turn without an exact final entry cannot be a fork boundary", () => {
    const messages = [user(uuid(1), "Answer"), assistant(uuid(2), [{ type: "text", text: "Answer" }]),
      user(uuid(3), "Return structured output"),
      assistant(uuid(4), [{ type: "tool_use", id: "result-tool", name: "StructuredOutput", input: {} }]),
      user(uuid(5), [{ type: "tool_result", tool_use_id: "result-tool", content: "ok" }])];
    const [ordinary, structured] = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds;
    const projection = projectClaudeHistory(messages, [{ backendTurnId: structured!, status: "completed",
      providerTerminalReason: "success", providerResultUuid: uuid(6), terminalAt: 2_000 }]);
    expect(projection.snapshot.turnsById[structured!]).toMatchObject({ status: "completed", forkUnavailableReason: { text:
      "Claude cannot fork exactly after this turn: it ended without a final answer, for example on a tool result or attachment." } });
    expect(projection.snapshot.turnsById[ordinary!]).not.toHaveProperty("forkUnavailableReason");
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(structured!)).toBe(false);
  });

  it("explains why turns before or at Claude's latest compaction cannot be forked", () => {
    const summary = { ...user(uuid(3), "This session is being continued. Summary: synthetic."), isCompactSummary: true };
    const messages = [user(uuid(1), "Before"), assistant(uuid(2), [{ type: "text", text: "Earlier answer" }]), summary,
      user(uuid(4), "After"), assistant(uuid(5), [{ type: "text", text: "Later answer" }])];
    const projection = projectClaudeHistory(messages);
    // The summary joins the turn it followed; that turn precedes the compaction.
    const [earlier, later] = projection.snapshot.orderedBackendTurnIds;
    expect(projection.snapshot.turnsById[earlier!]).toMatchObject({ status: "completed", forkUnavailableReason: { text:
      "Claude cannot fork before its latest compaction. Fork a turn after the compaction summary instead." } });
    expect(projection.snapshot.turnsById[later!]).not.toHaveProperty("forkUnavailableReason");
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(later!)).toBe(uuid(5));
    // A summary with no turn to join is its own settled turn, never a fork point.
    const resumed = projectClaudeHistory(messages.slice(2));
    const [compaction] = resumed.snapshot.orderedBackendTurnIds;
    expect(resumed.snapshot.turnsById[compaction!]).toMatchObject({ status: "completed", forkUnavailableReason: { text:
      "A compaction summary is not a fork point; fork a later turn instead." } });
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

describe("Claude image reads", () => {
  // Claude Code 2.1.283's persisted Read result for an image: one base64 block.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1])
    .toString("base64");
  const imageContent = (data = png, mediaType = "image/png") =>
    [{ type: "image", source: { type: "base64", data, media_type: mediaType } }];
  const prompt = user(uuid(1), "Look at the screenshots");
  const read = (index: number, messageId: string, id: string, filePath: string) => ({
    ...assistant(uuid(index), [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }]),
    message: { role: "assistant", id: messageId, content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }],
      stop_reason: "tool_use" },
  });
  const result = (index: number, id: string, content: unknown, isError = false) =>
    user(uuid(index), [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
  const answer = (index: number) => ({
    ...assistant(uuid(index), [{ type: "text", text: "Both screenshots show the settings page." }]),
    message: { role: "assistant", id: `msg-answer-${index}`, content: [{ type: "text", text: "Both screenshots show the settings page." }],
      stop_reason: "end_turn" },
  });
  const descriptor = (index: number): OutputImageArtifactDescriptor => ({
    artifactId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    mediaType: "image/png", byteSize: 24, sha256: String(index).repeat(64).slice(0, 64),
  });
  /** A retained-association lookup that records every key it was asked for. */
  const retained = (entries: ReadonlyMap<string, OutputImageArtifactDescriptor> = new Map()) => {
    const asked: string[] = [];
    return { asked, viewedImages: { find: (key: string) => { asked.push(key); return entries.get(key); } } };
  };
  const ordered = (snapshot: BackendConversationSnapshot) => {
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    return turn.orderedBackendItemIds.map(id => snapshot.itemsById[id]!);
  };

  it("projects an image read as a streaming view that keeps its identity through completion", () => {
    const running = projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shots/Settings.PNG")]).snapshot;
    const [, streaming] = ordered(running);
    expect(streaming).toEqual({
      backendItemId: expect.any(String), backendTurnId: running.orderedBackendTurnIds[0], sourceOrder: 2,
      status: "streaming", semanticKind: "viewed_image", fileName: { text: "Settings.PNG" },
    });
    const completed = projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shots/Settings.PNG"),
      result(3, "toolu-1", "The file was read.")]);
    const [, view] = ordered(completed.snapshot);
    expect(view).toEqual({ ...streaming, status: "completed" });
    expect(completed.nativeToolUseIds).toEqual(new Set(["toolu-1"]));
    expect(completed.usage?.counters).toMatchObject({ toolCalls: 1, toolResults: 1 });
    // A text result is not an image: completed, with nothing to publish.
    expect(completed.pendingViewedImages).toEqual([]);
    expect(JSON.stringify(completed.snapshot)).not.toContain("/workspace");
  });

  it.each(["a.png", "a.jpg", "a.JPEG", "a.Gif", "a.webp"])("recognizes %s as Claude Code does", (name) => {
    const [, view] = ordered(projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", `/workspace/${name}`)]).snapshot);
    expect(view).toMatchObject({ semanticKind: "viewed_image", fileName: { text: name } });
  });

  it.each(["/workspace/notes.txt", "/workspace/diagram.svg", "/workspace/report.pdf", "/workspace/.png", "/workspace/png"])(
    "keeps %s a file read", (filePath) => {
      const [, item] = ordered(projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", filePath)]).snapshot);
      expect(item).toMatchObject({ semanticKind: "file_read", path: { text: filePath } });
    });

  it("reports an unpublished image as pending and shows a retained one after its read", () => {
    const messages = [prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png"), result(3, "toolu-1", imageContent()), answer(4)];
    const unpublished = retained();
    const before = projectClaudeHistory(messages, [], { ...historyAuthentication, viewedImages: unpublished.viewedImages });
    const [, view] = ordered(before.snapshot);
    expect(ordered(before.snapshot).map(item => item.semanticKind)).toEqual(["user_message", "viewed_image", "assistant_message"]);
    expect(before.pendingViewedImages).toEqual([{
      viewedBackendItemId: view!.backendItemId,
      identity: { backendItemId: expect.stringMatching(/^claude-item-image:/u), backendTurnId: view!.backendTurnId, sourceOrder: 3 },
      publicationKey: expect.any(String),
      image: { mediaType: "image/png", data: png },
    }]);
    const [pending] = before.pendingViewedImages;
    expect(pending!.publicationKey).toBe(claudeViewedImagePublicationKey(pending!.identity.backendItemId));
    expect(unpublished.asked).toEqual([pending!.publicationKey]);

    const published = retained(new Map([[pending!.publicationKey, descriptor(1)]]));
    const after = projectClaudeHistory(messages, [], { ...historyAuthentication, viewedImages: published.viewedImages });
    expect(after.pendingViewedImages).toEqual([]);
    expect(ordered(after.snapshot)).toEqual([
      expect.objectContaining({ semanticKind: "user_message" }),
      { ...view, status: "completed" },
      { ...pending!.identity, status: "completed", semanticKind: "image", origin: { kind: "viewed", capture: "provider_input" },
        image: { representation: "artifact", artifactId: descriptor(1).artifactId, mimeType: "image/png", byteSize: 24,
          sha256: descriptor(1).sha256, fileName: { text: "shot.png" } } },
      expect.objectContaining({ semanticKind: "assistant_message", sourceOrder: 4 }),
    ]);
    expect(after.snapshot.turnsById[after.snapshot.orderedBackendTurnIds[0]!]).toMatchObject({ status: "completed" });
    // Publication adds an item but moves no turn, so page cursors stay valid.
    const page = projectClaudeHistoryPage([...messages, user(uuid(5), "Next"), answer(6)], { limit: 1 });
    expect(projectClaudeHistoryPage([...messages, user(uuid(5), "Next"), answer(6)], {
      limit: 1, cursor: page.previousCursor!, authentication: { ...historyAuthentication, viewedImages: published.viewedImages },
    }).itemsById[pending!.identity.backendItemId]).toBeDefined();
  });

  it("pairs parallel reads in one message with their own images, whatever order the results arrive", () => {
    const first = { type: "tool_use", id: "toolu-a", name: "Read", input: { file_path: "/workspace/a.png" } };
    const second = { type: "tool_use", id: "toolu-b", name: "Read", input: { file_path: "/workspace/b.gif" } };
    const row = (index: number, block: unknown) => ({ ...assistant(uuid(index), [block]),
      message: { role: "assistant", id: "msg-parallel", content: [block], stop_reason: "tool_use" } });
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
    // Claude Code writes the results in completion order; history relinks them.
    const live = [prompt, row(2, first), row(3, second), result(4, "toolu-b", imageContent(gif, "image/gif")),
      result(5, "toolu-a", imageContent()), answer(6)];
    const reordered = [prompt, row(2, first), result(5, "toolu-a", imageContent()), row(3, second),
      result(4, "toolu-b", imageContent(gif, "image/gif")), answer(6)];
    const unpublished = projectClaudeHistory(live);
    const fileNameOf = (viewedBackendItemId: string) => {
      const view = unpublished.snapshot.itemsById[viewedBackendItemId]!;
      return view.semanticKind === "viewed_image" ? view.fileName?.text : undefined;
    };
    const keyByFile = new Map(unpublished.pendingViewedImages.map(candidate =>
      [fileNameOf(candidate.viewedBackendItemId), candidate] as const));
    expect(keyByFile.get("a.png")!.image).toEqual({ mediaType: "image/png", data: png });
    expect(keyByFile.get("b.gif")!.image).toEqual({ mediaType: "image/gif", data: gif });
    const associations = new Map([[keyByFile.get("a.png")!.publicationKey, descriptor(1)],
      [keyByFile.get("b.gif")!.publicationKey, { ...descriptor(2), mediaType: "image/gif" as const, byteSize: 10 }]]);
    const views: unknown[] = [];
    for (const messages of [live, reordered]) {
      const items = ordered(projectClaudeHistory(messages, [], { ...historyAuthentication,
        viewedImages: retained(associations).viewedImages }).snapshot);
      expect(items.map(item => [item.semanticKind, item.sourceOrder,
        item.semanticKind === "viewed_image" ? item.fileName?.text : undefined,
        item.semanticKind === "image" && item.image.representation === "artifact"
          ? [item.image.fileName?.text, item.image.artifactId, item.image.mimeType] : undefined])).toEqual([
        ["user_message", 0, undefined, undefined],
        ["viewed_image", 2, "a.png", undefined],
        ["image", 3, undefined, ["a.png", descriptor(1).artifactId, "image/png"]],
        ["viewed_image", 4, "b.gif", undefined],
        ["image", 5, undefined, ["b.gif", descriptor(2).artifactId, "image/gif"]],
        ["assistant_message", 6, undefined, undefined],
      ]);
      expect(items[2]!.backendItemId).toBe(keyByFile.get("a.png")!.identity.backendItemId);
      expect(items[4]!.backendItemId).toBe(keyByFile.get("b.gif")!.identity.backendItemId);
      views.push(items);
    }
    expect(views[1]).toEqual(views[0]);
  });

  it("fails a read Claude could not perform without its path-bearing error, and publishes nothing", () => {
    const error = "File does not exist. Note: your current working directory is /home/someone/private-project.";
    const projection = projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/home/someone/private-project/missing.png"),
      result(3, "toolu-1", error, true)]);
    const [, view] = ordered(projection.snapshot);
    expect(view).toMatchObject({ semanticKind: "viewed_image", status: "failed", fileName: { text: "missing.png" },
      error: { category: "unavailable", message: { text: "Claude could not read this image." }, code: "claude_viewed_image_read_failed" } });
    expect(JSON.stringify(projection.snapshot)).not.toContain("private-project");
    expect(projection.pendingViewedImages).toEqual([]);
  });

  it.each([
    ["an undeclared media type", imageContent(png, "image/bmp")],
    ["a URL source", [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }]],
    ["two images", [...imageContent(), ...imageContent()]],
    ["an image beyond the output ceiling", imageContent("A".repeat(Math.ceil((16 * 1_024 * 1_024) / 3) * 4 + 4))],
  ])("completes a read whose result carries %s with no image to publish", (_label, content) => {
    const projection = projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png"), result(3, "toolu-1", content)]);
    expect(ordered(projection.snapshot).map(item => [item.semanticKind, item.status]))
      .toEqual([["user_message", "completed"], ["viewed_image", "completed"]]);
    expect(projection.pendingViewedImages).toEqual([]);
  });

  it("interrupts a read Stop stopped and ends an unfinished one with its turn", () => {
    const stopped = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
    const timestamp = "2026-09-26T10:00:05.000Z";
    const marker = { ...user(uuid(4), [{ type: "text", text: "[Request interrupted by user for tool use]" }]), timestamp };
    const [, interrupted] = ordered(projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png"),
      result(3, "toolu-1", stopped, true), marker]).snapshot);
    expect(interrupted).toEqual({ backendItemId: expect.any(String), backendTurnId: expect.any(String), sourceOrder: 2,
      semanticKind: "viewed_image", status: "interrupted", completedAt: timestamp, fileName: { text: "shot.png" } });
    const lost = projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png")]);
    const [receiptTurn] = lost.snapshot.orderedBackendTurnIds;
    const [, settled] = ordered(projectClaudeHistory([prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png")], [{
      backendTurnId: receiptTurn!, status: "interrupted", providerTerminalReason: "process_lost", providerResultUuid: null,
      terminalAt: Date.parse(timestamp) }]).snapshot);
    expect(settled).toMatchObject({ semanticKind: "viewed_image", status: "interrupted", completedAt: timestamp });
  });

  it("interrupts a read still without a result when its turn fails, and fails the other tools as before", () => {
    const timestamp = "2026-09-26T10:00:05.000Z";
    const command = { type: "tool_use", id: "toolu-cmd", name: "Bash", input: { command: "sleep 9" } };
    const shot = { type: "tool_use", id: "toolu-shot", name: "Read", input: { file_path: "/workspace/shot.png" } };
    const messages = [prompt, { ...assistant(uuid(2), [command, shot]),
      message: { role: "assistant", id: "msg-1", content: [command, shot], stop_reason: "tool_use" } }];
    const [turnId] = projectClaudeHistory(messages).snapshot.orderedBackendTurnIds;
    const snapshot = projectClaudeHistory(messages, [{ backendTurnId: turnId!, status: "failed",
      providerTerminalReason: "error_during_execution", providerResultUuid: uuid(3), terminalAt: Date.parse(timestamp) }]).snapshot;
    expect(snapshot.turnsById[turnId!]).toMatchObject({ status: "failed" });
    const [, failed, view] = ordered(snapshot);
    expect(failed).toMatchObject({ semanticKind: "command", status: "failed", phase: "failed", completedAt: timestamp });
    expect(view).toEqual({ backendItemId: expect.any(String), backendTurnId: turnId, sourceOrder: 4,
      semanticKind: "viewed_image", status: "interrupted", completedAt: timestamp, fileName: { text: "shot.png" } });
  });

  it("gives a fork or import its own image identities and keys", () => {
    const messages = [prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png"), result(3, "toolu-1", imageContent())];
    const source = projectClaudeHistory(messages).pendingViewedImages;
    const copied = projectClaudeHistory(messages.map(message => ({ ...message, session_id: uuid(901) }))).pendingViewedImages;
    expect(source).toHaveLength(1);
    expect(copied).toHaveLength(1);
    expect(copied[0]!.identity.backendItemId).not.toBe(source[0]!.identity.backendItemId);
    expect(copied[0]!.publicationKey).not.toBe(source[0]!.publicationKey);
    expect(copied[0]!.image).toEqual(source[0]!.image);
  });

  it("limits pending reads to the returned window, page, or located turn", () => {
    const turn = (base: number, name: string) => [user(uuid(base), `Look at ${name}`), read(base + 1, `msg-${base}`, `toolu-${base}`, `/workspace/${name}`),
      result(base + 2, `toolu-${base}`, imageContent()), answer(base + 3)];
    const messages = [...turn(10, "old.png"), ...Array.from({ length: 10 }, (_, index) => [user(uuid(100 + index * 2), "More"),
      answer(101 + index * 2)]).flat(), ...turn(200, "new.png")];
    const turnIds = projectClaudeHistory(messages).usageTurns.map(({ backendTurnId }) => backendTurnId);
    const [oldTurn, newTurn] = [turnIds[0]!, turnIds.at(-1)!];
    const latest = projectClaudeLatestSnapshot(messages, [], historyAuthentication);
    expect(latest.snapshot.orderedBackendTurnIds).not.toContain(oldTurn);
    expect(latest.pendingViewedImages.map(({ identity }) => identity.backendTurnId)).toEqual([newTurn]);
    const page = projectClaudeHistoryPageAtIndex(messages, { before: 1, limit: 1, authentication: historyAuthentication });
    expect(page.page.orderedBackendTurnIds).toEqual([oldTurn]);
    expect(page.pendingViewedImages.map(({ identity }) => identity.backendTurnId)).toEqual([oldTurn]);
    const located = locateClaudeHistoryTurn(messages, { matchesBackendTurnId: id => id === oldTurn, maximumTurnCandidates: 20 });
    if (located.status !== "found") throw new Error("expected located turn");
    expect(located.pendingViewedImages.map(({ identity }) => identity.backendTurnId)).toEqual([oldTurn]);
  });

  it("never separates a read from its image when trimming an oversized current turn", () => {
    const build = (finalCharacters: number) => [prompt,
      { ...assistant(uuid(2), [{ type: "text", text: "x".repeat(2_000_000) }]),
        message: { role: "assistant", id: "msg-1", content: [{ type: "text", text: "x".repeat(2_000_000) }], stop_reason: "tool_use" } },
      { ...read(3, "msg-1", "toolu-1", "/workspace/shot.png") }, result(4, "toolu-1", imageContent()),
      { ...assistant(uuid(5), [{ type: "text", text: "y".repeat(finalCharacters) }]),
        message: { role: "assistant", id: "msg-2", content: [{ type: "text", text: "y".repeat(finalCharacters) }], stop_reason: "end_turn" } }];
    const [pending] = projectClaudeHistory(build(1)).pendingViewedImages;
    const authentication = { ...historyAuthentication,
      viewedImages: retained(new Map([[pending!.publicationKey, descriptor(1)]])).viewedImages };
    const shapes = new Set<string>();
    // Across the sizes where the trim reaches the read, the read and its
    // image are kept or omitted together.
    for (let headroom = 5_200; headroom >= 2_000; headroom -= 400) {
      const snapshot = projectClaudeHistory(build(MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - headroom), [], authentication).snapshot;
      expect(serializedUtf8Bytes(snapshot)).toBeLessThanOrEqual(MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES);
      const items = ordered(snapshot);
      const shape = items.map(item => item.semanticKind).join(",");
      shapes.add(shape);
      for (const [index, item] of items.entries()) {
        if (item.semanticKind !== "image") continue;
        expect(items[index - 1]).toMatchObject({ semanticKind: "viewed_image", backendItemId: pending!.viewedBackendItemId });
        expect(item.backendItemId).toBe(pending!.identity.backendItemId);
      }
    }
    expect(shapes).toEqual(new Set([
      "user_message,notice,viewed_image,image,assistant_message",
      "user_message,notice,assistant_message",
    ]));
  });

  const texts = (count: number, firstRow = 10_000) => Array.from({ length: Math.ceil(count / 2_000) }, (_, row) =>
    assistant(uuid(firstRow + row), Array.from({ length: Math.min(2_000, count - row * 2_000) }, () => ({ type: "text", text: "x" }))));
  const associateAll = (messages: readonly unknown[]) => {
    const pending = projectClaudeHistory(messages).pendingViewedImages;
    return { pending, projection: projectClaudeHistory(messages, [], { ...historyAuthentication, viewedImages: retained(
      new Map(pending.map(({ publicationKey }, index) => [publicationKey, descriptor(index + 1)]))).viewedImages }) };
  };

  it("holds an image's slot when its result arrives, if its turn has room", () => {
    const project = (textCount: number) => {
      const { pending, projection } = associateAll([prompt, ...texts(textCount), read(3, "msg-1", "toolu-1", "/workspace/shot.png"),
        result(4, "toolu-1", imageContent())]);
      const items = ordered(projection.snapshot);
      return { pending: pending.length, items: items.length, last: items.at(-1)!.semanticKind };
    };
    // A user message, the texts, and the read, with room for its image.
    expect(project(MAXIMUM_BACKEND_ITEMS_PER_TURN - 3)).toEqual({ pending: 1, items: MAXIMUM_BACKEND_ITEMS_PER_TURN, last: "image" });
    // The read took the last slot: it completes without its image.
    expect(project(MAXIMUM_BACKEND_ITEMS_PER_TURN - 2)).toEqual({ pending: 0, items: MAXIMUM_BACKEND_ITEMS_PER_TURN, last: "viewed_image" });
  });

  it("keeps a shown image as its turn fills, so a live turn only grows", () => {
    const messages = (textCount: number) => [prompt, read(2, "msg-1", "toolu-1", "/workspace/shot.png"),
      result(3, "toolu-1", imageContent()), ...texts(textCount)];
    const early = associateAll(messages(10)).projection;
    const full = associateAll(messages(MAXIMUM_BACKEND_ITEMS_PER_TURN - 3)).projection;
    const earlyIds = ordered(early.snapshot).map(item => item.backendItemId);
    const fullItems = ordered(full.snapshot);
    expect(fullItems).toHaveLength(MAXIMUM_BACKEND_ITEMS_PER_TURN);
    expect(fullItems.slice(0, earlyIds.length).map(item => item.backendItemId)).toEqual(earlyIds);
    expect(fullItems[2]).toMatchObject({ semanticKind: "image" });
    // One more transcript item exceeds the turn, as it would without images.
    expect(() => projectClaudeHistory(messages(MAXIMUM_BACKEND_ITEMS_PER_TURN - 2))).toThrowError(
      expect.objectContaining({ code: "history_too_large" }));
  });

  it("reports several pending images up to the cap and none beyond it", () => {
    const reads = ["a", "b", "c"].flatMap((name, index) => [read(3 + index * 2, `msg-${name}`, `toolu-${name}`, `/workspace/${name}.png`),
      result(4 + index * 2, `toolu-${name}`, imageContent())]);
    const { pending, projection } = associateAll([prompt, ...texts(MAXIMUM_BACKEND_ITEMS_PER_TURN - 6), ...reads]);
    const fileName = (candidate: (typeof pending)[number]) => {
      const view = projection.snapshot.itemsById[candidate.viewedBackendItemId]!;
      return view.semanticKind === "viewed_image" ? view.fileName?.text : undefined;
    };
    expect(pending.map(fileName)).toEqual(["a.png", "b.png"]);
    const items = ordered(projection.snapshot);
    expect(items).toHaveLength(MAXIMUM_BACKEND_ITEMS_PER_TURN);
    expect(items.slice(-5).map(item => [item.semanticKind, item.status])).toEqual([
      ["viewed_image", "completed"], ["image", "completed"], ["viewed_image", "completed"], ["image", "completed"],
      ["viewed_image", "completed"],
    ]);
  });

  it("reserves enough bytes for an image with the longest escaped file name", () => {
    const name = `${"\"".repeat(250)}.png`;
    const messages = [prompt, read(2, "msg-1", "toolu-1", `/workspace/${name}`), result(3, "toolu-1", imageContent())];
    const without = projectClaudeHistory(messages).snapshot;
    const { projection } = associateAll(messages);
    const image = ordered(projection.snapshot)[2]!;
    expect(image).toMatchObject({ semanticKind: "image", image: { fileName: { text: name } } });
    expect(serializedUtf8Bytes(projection.snapshot) - serializedUtf8Bytes(without)).toBeLessThanOrEqual(2_048);
    expect(serializedUtf8Bytes(projection.snapshot) - serializedUtf8Bytes(without)).toBeGreaterThan(1_000);
  });
});
