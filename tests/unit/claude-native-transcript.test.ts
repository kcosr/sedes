import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  locateClaudeSessionTranscript,
  parseClaudeTranscript,
  readClaudeSessionMessages,
  resolveClaudeSessionMessages,
} from "../../src/server/backends/claude/claude-native-transcript.js";
import { claudeResumableHistoryStart, projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { OfficialClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { CLAUDE_STARTUP_MARKER_TEXT } from "../../src/server/backends/claude/claude-sdk-session.js";
import { ClaudeTranscriptFixture } from "../helpers/claude-native-transcript-fixture.js";

let root: string;
let configDirectory: string;
let workspace: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-claude-transcript-")));
  configDirectory = path.join(root, "claude");
  workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  // The pinned SDK reads the ambient store; the parity oracle uses the same one.
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const environment = () => ({ CLAUDE_CONFIG_DIR: configDirectory });

async function ours(fixture: ClaudeTranscriptFixture, options: { includeSystemMessages?: boolean; offset?: number; limit?: number; resumableOnly?: boolean } = {}) {
  await fixture.write(configDirectory, workspace);
  return await readClaudeSessionMessages(fixture.sessionId, { dir: workspace, ...options }, environment());
}

async function sdk(fixture: ClaudeTranscriptFixture, options: { includeSystemMessages?: boolean; offset?: number; limit?: number } = {}) {
  await fixture.write(configDirectory, workspace);
  return await getSessionMessages(fixture.sessionId, { dir: workspace, ...options });
}

function uuids(messages: readonly SessionMessage[]): string[] {
  return messages.map(({ uuid }) => uuid);
}

/**
 * A resumed "Refactor"-shaped conversation: parallel calls, then a later turn.
 * `legacyEmptyContent` writes the startup messages Sedes sent before the
 * session-start marker.
 */
function refactorShaped(legacyEmptyContent = false): { fixture: ClaudeTranscriptFixture; lastReply: string; deadEnds: string[] } {
  const fixture = new ClaudeTranscriptFixture(workspace);
  fixture.startupMessage({ legacyEmptyContent });
  fixture.prompt("Refactor the synthetic parser.");
  const first = fixture.parallelToolCalls("alpha");
  fixture.text("The parser splits lines twice.");
  fixture.system("turn_duration", { durationMs: 1234 });
  fixture.bookkeeping({ type: "custom-title", customTitle: "Synthetic refactor" });
  fixture.startupMessage({ legacyEmptyContent });
  fixture.prompt("Now simplify the tokenizer.");
  const second = fixture.parallelToolCalls("beta");
  const [, lastReply] = fixture.reply([
    { type: "thinking", thinking: "synthetic reasoning", signature: "c3ludGhldGlj" },
    { type: "text", text: "Tokenizer simplified." },
  ]);
  fixture.bookkeeping({ type: "last-prompt", leafUuid: fixture.tip, lastPrompt: "Now simplify the tokenizer." });
  return { fixture, lastReply: lastReply!, deadEnds: [first.deadEnd, second.deadEnd] };
}

describe("Claude native transcript reader", () => {
  it.each([false, true])("reads a startup-message tip through its true chain, as the pinned SDK now does (legacy empty content: %s)", async (legacyEmptyContent) => {
    const { fixture, lastReply, deadEnds } = refactorShaped(legacyEmptyContent);
    fixture.startupMessage({ legacyEmptyContent });

    const messages = await ours(fixture);
    expect(messages.at(-1)?.uuid).toBe(lastReply);
    expect(uuids(messages)).toEqual(expect.arrayContaining(deadEnds));
    expect(messages.some((message) => message.type === "user" && typeof message.message === "object" &&
      JSON.stringify(message.message).includes("NON-USER SOURCE"))).toBe(false);
    expect(JSON.stringify(messages)).not.toContain(CLAUDE_STARTUP_MARKER_TEXT);
    // SDK 0.3.274 skipped the meta tip and stopped at the file-latest dead end;
    // 0.3.283 walks from the meta tip too.
    expect(messages).toEqual(await sdk(fixture));
  });

  it("reads to the true tip when a trailing system notice is attached to an old row", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("First synthetic task.");
    fixture.answer("First synthetic answer.");
    const staleDuration = fixture.system("turn_duration", { durationMs: 883 });
    fixture.prompt("Second synthetic task.");
    const lastAnswer = fixture.answer("Second synthetic answer.");
    // Claude Code can write a later warning against a stale row, e.g. when
    // Remote Control disconnects at the end of a session.
    fixture.from(staleDuration).system("informational", { level: "warning" });

    const messages = await ours(fixture);
    expect(messages.at(-1)?.uuid).toBe(lastAnswer);
    // The pinned SDK walks up from the latest childless row, that notice, so
    // it stops at the first answer.
    const truncated = await sdk(fixture);
    expect(truncated).toEqual(messages.slice(0, 2));
  });

  it("matches the pinned SDK exactly when the tip is not a startup message", async () => {
    const { fixture } = refactorShaped();
    expect(await ours(fixture)).toEqual(await sdk(fixture));
    expect(await ours(fixture, { includeSystemMessages: true })).toEqual(await sdk(fixture, { includeSystemMessages: true }));
  });

  it.each([false, true])("matches the SDK once the next prompt follows a startup message (legacy empty content: %s)", async (legacyEmptyContent) => {
    const { fixture } = refactorShaped(legacyEmptyContent);
    fixture.startupMessage({ legacyEmptyContent });
    fixture.prompt("One more change.");
    fixture.text("Done.");
    const messages = await ours(fixture);
    expect(messages).toEqual(await sdk(fixture));
    expect(messages.at(-1)).toMatchObject({ type: "assistant" });
  });

  it("reads a plain linear conversation", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const prompt = fixture.prompt("Say hello.");
    const reply = fixture.text("Hello.");
    const messages = await ours(fixture);
    expect(uuids(messages)).toEqual([prompt, reply]);
    expect(messages[0]).toEqual({
      type: "user", uuid: prompt, session_id: fixture.sessionId,
      message: { role: "user", content: "Say hello." }, parent_tool_use_id: null, parent_agent_id: null,
      timestamp: fixture.rows.find((row) => row.uuid === prompt)!.timestamp, origin: { kind: "human" },
    });
    expect(messages).toEqual(await sdk(fixture));
  });

  it("follows the newest branch after a rewind, including through a startup message", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const first = fixture.prompt("First question.");
    const firstReply = fixture.text("First answer.");
    fixture.prompt("Abandoned question.");
    fixture.text("Abandoned answer.");
    // Rewind: the new prompt attaches to the earlier reply; the old branch stays in the file.
    fixture.from(firstReply);
    const rewritten = fixture.prompt("Rewritten question.");
    const rewrittenReply = fixture.text("Rewritten answer.");
    expect(uuids(await ours(fixture))).toEqual([first, firstReply, rewritten, rewrittenReply]);
    expect(await ours(fixture)).toEqual(await sdk(fixture));

    fixture.startupMessage();
    expect(uuids(await ours(fixture))).toEqual([first, firstReply, rewritten, rewrittenReply]);
  });

  it("ignores sidechain rows for tip selection and output", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const prompt = fixture.prompt("Delegate a search.");
    const reply = fixture.text("Delegating.");
    // Legacy in-file subagent rows; the fixture keeps them off the main tip.
    const task = fixture.prompt("Subagent task.", { isSidechain: true, parentUuid: null });
    fixture.reply([{ type: "text", text: "Subagent answer." }], { extra: { isSidechain: true, parentUuid: task } });
    const messages = await ours(fixture);
    expect(uuids(messages)).toEqual([prompt, reply]);
    expect(messages).toEqual(await sdk(fixture));
  });

  it("converts answered queued commands and drops unanswered, meta, and forwarded ones", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Start a long task.");
    const sourceUuid = randomUUID();
    const queued = fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Also check tests.",
      source_uuid: sourceUuid, origin: { kind: "human" } });
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Meta note.", isMeta: true });
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Forwarded.",
      forwardedIntent: { lineage: "synthetic-lineage", source: "relay" } });
    // A background task finished while Claude was running a tool.
    const notification = fixture.attachment({ type: "queued_command", commandMode: "task-notification",
      prompt: "<task-notification>\n<task-id>bsynthetic1</task-id>\n<status>completed</status>\n</task-notification>" });
    const scheduled = fixture.attachment({ type: "queued_command", commandMode: "task-notification", prompt: "Scheduled check.",
      origin: { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "manual", taskId: "private" } });
    const peer = fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Peer note.", origin: { kind: "peer" } });
    fixture.text("Checked both.");
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: [{ type: "text", text: "Unanswered." }] });
    fixture.prompt("Next prompt.");

    const messages = await ours(fixture);
    const converted = messages.find(({ uuid }) => uuid === sourceUuid);
    expect(converted).toMatchObject({ type: "user", message: { role: "user", content: "Also check tests." },
      origin: { kind: "human" }, isQueuedCommand: true });
    expect(uuids(messages)).not.toContain(queued);
    expect(messages.find(({ uuid }) => uuid === notification)).toMatchObject({
      type: "user", origin: { kind: "task-notification" }, isQueuedCommand: true });
    expect(messages.find(({ uuid }) => uuid === scheduled)).toMatchObject({
      origin: { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "manual" } });
    expect(messages.find(({ uuid }) => uuid === scheduled)).not.toHaveProperty("origin.taskId");
    expect(messages.find(({ uuid }) => uuid === peer)).toMatchObject({ origin: { kind: "peer" }, isQueuedCommand: true });
    expect(JSON.stringify(messages)).not.toContain("Meta note.");
    expect(JSON.stringify(messages)).not.toContain("Forwarded.");
    expect(JSON.stringify(messages)).not.toContain("Unanswered.");
    expect(messages).toEqual(await sdk(fixture));
  });

  it("marks a completed local command's rows and does not treat them as a prompt", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Start a synthetic task.");
    const unanswered = fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Queued before the command." });
    fixture.prompt("<local-command-caveat>Caveat: synthetic.</local-command-caveat>", { isMeta: true, origin: undefined });
    const record = fixture.prompt("<command-name>/synthetic</command-name>\n<command-message>synthetic</command-message>",
      { origin: undefined });
    const output = fixture.prompt("<local-command-stdout>Synthetic output.</local-command-stdout>", { origin: undefined });
    fixture.text("Continuing.");

    const messages = await ours(fixture);
    expect(messages.find(({ uuid }) => uuid === record)).toMatchObject({ isCompletedLocalCommand: true });
    expect(messages.find(({ uuid }) => uuid === output)).toMatchObject({ isCompletedLocalCommand: true });
    // The command rows are not a prompt, so the reply answers the queued command.
    expect(messages.find(({ uuid }) => uuid === unanswered)).toMatchObject({ isQueuedCommand: true });
    expect(messages).toEqual(await sdk(fixture));
  });

  it("re-inserts a parallel tool result linked to its call only by provenance", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Read two synthetic files.");
    const [, first, second] = fixture.reply([
      { type: "text", text: "Reading both." },
      { type: "tool_use", id: "toolu_indirect_1", name: "Read", input: { file_path: "/synthetic/1" } },
      { type: "tool_use", id: "toolu_indirect_2", name: "Read", input: { file_path: "/synthetic/2" } },
    ]);
    // The second result hangs off a hook attachment, naming its call by source.
    const hook = fixture.from(second!).attachment({ type: "hook_success", hookName: "PostToolUse" });
    const indirect = fixture.toolResult("toolu_indirect_2", hook, undefined, { sourceToolAssistantUUID: second });
    fixture.toolResult("toolu_indirect_1", first!);
    fixture.answer("Both read.");

    const messages = await ours(fixture);
    expect(uuids(messages)).toContain(indirect);
    expect(messages).toEqual(await sdk(fixture));
  });

  it("maps task-notification origins and hides meta peer hand-back rows", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Run the build in the background.");
    fixture.text("Started.");
    const handBack = fixture.prompt("<peer>synthetic hand-back</peer>", { isMeta: true, origin: { kind: "peer", peer: "synthetic" } });
    const notification = fixture.prompt("<task-notification>synthetic build done</task-notification>", {
      origin: { kind: "task-notification", subkind: "background_task", taskId: "task-synthetic", extra: { private: true } },
    });
    fixture.text("The build finished.");
    const messages = await ours(fixture);
    expect(uuids(messages)).not.toContain(handBack);
    expect(messages.find(({ uuid }) => uuid === notification)).toMatchObject({
      origin: { kind: "task-notification", subkind: "background_task" },
    });
    expect(messages.find(({ uuid }) => uuid === notification)).not.toHaveProperty("origin.taskId");
    expect(messages).toEqual(await sdk(fixture));
  });

  it("keeps synthetic assistant rows and resolves through a synthetic tip", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("A prompt the process never answered.");
    fixture.startupMessage();
    const synthetic = fixture.reply([{ type: "text", text: "No response requested." }], { model: "<synthetic>" })[0]!;
    const messages = await ours(fixture);
    expect(messages.at(-1)).toMatchObject({ uuid: synthetic, type: "assistant" });
    expect(messages).toEqual(await sdk(fixture));
    fixture.startupMessage();
    expect((await ours(fixture)).at(-1)?.uuid).toBe(synthetic);
  });

  it("continues across a compact boundary: the SDK's segment follows the history it summarized", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const before = fixture.prompt("Before compaction.");
    const oldAnswer = fixture.text("Old answer.");
    const { boundary, summary } = fixture.compaction("Synthetic summary of the earlier conversation.");
    const after = fixture.prompt("After compaction.");
    const newAnswer = fixture.text("New answer.");

    const messages = await ours(fixture);
    expect(uuids(messages)).toEqual([before, oldAnswer, summary, after, newAnswer]);
    expect(messages[2]).toMatchObject({ uuid: summary, isCompactSummary: true, is_meta: true });
    // The pinned SDK, like Claude Code's own loader, stops at the boundary.
    expect(messages.slice(2)).toEqual(await sdk(fixture));
    const withSystem = await ours(fixture, { includeSystemMessages: true });
    expect(uuids(withSystem)).toEqual([before, oldAnswer, boundary, summary, after, newAnswer]);
    expect(withSystem.slice(2)).toEqual(await sdk(fixture, { includeSystemMessages: true }));
    fixture.startupMessage();
    expect(await ours(fixture)).toEqual(messages);
  });

  it("shows relinked preserved rows once, after the summary like the SDK", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const old = fixture.prompt("Old prompt.");
    const kept = fixture.prompt("Kept prompt.");
    const keptReply = fixture.text("Kept answer.");
    // Preserved rows follow the summary; later rows continue after the preserved tail.
    const summary = randomUUID();
    fixture.from(null).system("compact_boundary", { compactMetadata: {
      trigger: "manual", preservedSegment: { headUuid: kept, anchorUuid: summary, tailUuid: keptReply },
    } });
    fixture.prompt("Summary.", { uuid: summary, isCompactSummary: true });
    const next = fixture.prompt("Continue.");

    const messages = await ours(fixture);
    expect(uuids(messages)).toEqual([old, summary, kept, keptReply, next]);
    expect(messages.slice(1)).toEqual(await sdk(fixture));
  });

  it("skips a half-written final line", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Complete prompt.");
    const reply = fixture.text("Complete answer.");
    fixture.raw(`{"parentUuid":"${reply}","isSidechain":false,"type":"user","message":{"role":"user","content":"trunc`);
    const messages = await ours(fixture);
    expect(messages.at(-1)?.uuid).toBe(reply);
    expect(messages).toEqual(await sdk(fixture));
  });

  it("slices offset and limit over the resolved chain like the SDK", async () => {
    const { fixture } = refactorShaped();
    fixture.startupMessage();
    const full = await ours(fixture);
    expect(await ours(fixture, { offset: 2, limit: 3 })).toEqual(full.slice(2, 5));
    expect(await ours(fixture, { offset: 4 })).toEqual(full.slice(4));
    expect(await ours(fixture, { limit: 0 })).toEqual(full);
  });

  it("pages one captured acquisition even when Claude Code appends mid-read", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Read two large files.");
    const [, call] = fixture.reply([{ type: "text", text: "Reading." },
      { type: "tool_use", id: "toolu_large", name: "Read", input: { file_path: "/synthetic/large" } }]);
    fixture.toolResult("toolu_large", call!, "x".repeat(3 * 1024 * 1024));
    fixture.text("y".repeat(3 * 1024 * 1024));
    fixture.startupMessage();
    await fixture.write(configDirectory, workspace);
    const adapter = new ClaudeSdkRuntimeAdapter(new OfficialClaudeSdkFacade());
    const first = await adapter.getSessionMessagesPage(fixture.sessionId, { dir: workspace }, process.env);
    expect(first.nextCursor).not.toBeNull();
    fixture.prompt("Appended while paging.");
    await fixture.write(configDirectory, workspace);
    const second = await adapter.getSessionMessagesPage(fixture.sessionId, { dir: workspace, cursor: first.nextCursor! }, process.env);
    expect(second.nextCursor).toBeNull();
    const captured = [...first.messages, ...second.messages];
    expect(captured.at(-1)).toMatchObject({ type: "assistant" });
    const fresh = await adapter.getSessionMessages(fixture.sessionId, { dir: workspace }, process.env);
    expect(fresh.slice(0, -1)).toEqual(captured);
    expect(fresh.at(-1)).toMatchObject({ message: { content: "Appended while paging." } });
  });

  it("reads the fork-child shape: a copied prefix ending in the startup message", async () => {
    const { fixture, lastReply } = refactorShaped();
    const prefix = await ours(fixture);
    fixture.startupMessage();
    expect(await ours(fixture)).toEqual(prefix);
    expect(prefix.at(-1)?.uuid).toBe(lastReply);
  });

  it("reads a transcript holding only a startup message as empty but present", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.bookkeeping({ type: "cost-state", totalCostUSD: 0 });
    await fixture.write(configDirectory, workspace);
    expect(await ours(fixture)).toEqual([]);
    expect(await locateClaudeSessionTranscript(fixture.sessionId, workspace, environment())).toMatchObject({
      filePath: path.join(configDirectory, "projects", workspace.replace(/[^a-zA-Z0-9]/gu, "-"), `${fixture.sessionId}.jsonl`),
    });
  });

  it("parses only the native entry types the SDK interprets", async () => {
    const entries = await parseClaudeTranscript(Buffer.from([
      "  ",
      JSON.stringify({ type: "user", uuid: "a" }),
      JSON.stringify({ type: "last-prompt", leafUuid: "a" }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
      JSON.stringify({ type: "assistant" }),
      "null",
      "[]",
      `\t${JSON.stringify({ type: "progress", uuid: "b" })}\r`,
      "{\"type\":\"user\"",
    ].join("\n")));
    expect(entries).toEqual([{ type: "user", uuid: "a" }, { type: "progress", uuid: "b" }]);
    expect(await resolveClaudeSessionMessages([])).toEqual([]);
  });
});

/**
 * Claude Code behaviours on resume that Sedes' reader and projector depend on,
 * as native rows: the persisted startup message, its `<synthetic>` closure on
 * the next resume, and provider notifications about unfinished background work.
 */
describe("Claude Code resume shapes", () => {
  const unansweredNotice = "Claude Code exited before this turn finished and closed it without a response when the conversation resumed.";

  async function project(fixture: ClaudeTranscriptFixture) {
    const messages = await ours(fixture);
    // No shape here has a parallel dead end, so the pinned SDK agrees.
    expect(messages).toEqual(await sdk(fixture));
    return projectClaudeHistory(messages);
  }

  function statuses(projection: ReturnType<typeof projectClaudeHistory>): string[] {
    return projection.snapshot.orderedBackendTurnIds.map((id) => projection.snapshot.turnsById[id]!.status);
  }

  /** User, assistant, and notice text per turn, in order. */
  function transcript(projection: ReturnType<typeof projectClaudeHistory>): string[][] {
    const { snapshot } = projection;
    return snapshot.orderedBackendTurnIds.map((turnId) => snapshot.turnsById[turnId]!.orderedBackendItemIds.flatMap((itemId) => {
      const item = snapshot.itemsById[itemId]!;
      if (item.semanticKind === "user_message") return item.content.flatMap((part) => part.kind === "text" ? [`user: ${part.text.text}`] : []);
      if (item.semanticKind === "assistant_message") return [`assistant: ${item.markdown.text}`];
      if (item.semanticKind === "notice") return [`notice: ${item.text.text}`];
      return [item.semanticKind];
    }));
  }

  function closures(fixture: ClaudeTranscriptFixture) {
    return fixture.rows.filter((row) => row.type === "assistant" && (row.message as { model?: string }).model === "<synthetic>");
  }

  it.each([
    { queueTranscriptOnly: true, legacyEmptyContent: false, text: CLAUDE_STARTUP_MARKER_TEXT },
    { queueTranscriptOnly: true, legacyEmptyContent: true, text: "(no content)" },
    { queueTranscriptOnly: false, legacyEmptyContent: true, text: "(no content)" },
  ])("hides the startup message and parents the next prompt on it (%o)", async ({ queueTranscriptOnly, legacyEmptyContent, text }) => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const startup = fixture.startupMessage({ queueTranscriptOnly, legacyEmptyContent });
    const prompt = fixture.prompt("Describe the synthetic module.");
    const answer = fixture.answer("It parses synthetic input.");
    // From 2.1.280 the row carries `queueTranscriptOnly`; on every release the
    // model still receives it, label and text, merged into this prompt.
    expect(fixture.rows.find(({ uuid }) => uuid === startup)).toMatchObject({ isMeta: true,
      message: { role: "user", content: `[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${text}` } });
    expect(fixture.rows.find(({ uuid }) => uuid === startup)?.queueTranscriptOnly).toBe(queueTranscriptOnly || undefined);
    expect(fixture.rows.find(({ uuid }) => uuid === prompt)).toMatchObject({ parentUuid: startup });

    const projection = await project(fixture);
    expect(statuses(projection)).toEqual(["completed"]);
    expect(transcript(projection)).toEqual([["user: Describe the synthetic module.", "assistant: It parses synthetic input."]]);
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(projection.snapshot.orderedBackendTurnIds[0]!)).toBe(answer);
  });

  it("accumulates a startup message per attach and a closure per later resume without changing history", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.prompt("Summarize the synthetic notes.");
    const answer = fixture.answer("There are three synthetic notes.");
    const settled = await project(fixture);

    // The first reopen finds the answer at the tip; every later one finds the previous startup message.
    const resumes = Array.from({ length: 9 }, () => fixture.resume());
    expect(resumes[0]!.closure).toBeUndefined();
    for (const [index, resume] of resumes.entries()) {
      if (index === 0) continue;
      expect(fixture.rows.find(({ uuid }) => uuid === resume.closure)).toMatchObject({ parentUuid: resumes[index - 1]!.startup });
    }
    expect(fixture.rows.filter((row) => row.isMeta === true)).toHaveLength(10);
    expect(closures(fixture)).toHaveLength(8);

    const messages = await ours(fixture);
    expect(messages.filter(({ type }) => type === "assistant")).toHaveLength(9);
    const reopened = await project(fixture);
    expect(reopened.snapshot).toEqual(settled.snapshot);
    expect(reopened.usage).toEqual(settled.usage);
    expect(reopened.terminalCheckpointUuidByBackendTurnId).toEqual(settled.terminalCheckpointUuidByBackendTurnId);
    expect([...reopened.terminalCheckpointUuidByBackendTurnId.values()]).toEqual([answer]);
  });

  it("projects no turn for a thread reopened several times before its first prompt", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    for (let attach = 0; attach < 3; attach += 1) fixture.resume();
    expect(closures(fixture)).toHaveLength(3);
    const reopened = await project(fixture);
    expect(reopened.snapshot.orderedBackendTurnIds).toEqual([]);
    expect(reopened.snapshot.runState).toBe("idle");

    fixture.prompt("First synthetic prompt.");
    fixture.answer("First synthetic answer.");
    const sent = await project(fixture);
    expect(statuses(sent)).toEqual(["completed"]);
    expect(transcript(sent)).toEqual([["user: First synthetic prompt.", "assistant: First synthetic answer."]]);
  });

  it("ends a prompt left unanswered by a process that died as interrupted, stably across resumes", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.prompt("Earlier synthetic prompt.");
    fixture.answer("Earlier synthetic answer.");
    fixture.resume();
    fixture.prompt("A synthetic prompt nobody answered.");
    const reminder = fixture.attachment({ type: "synthetic_reminder", content: "synthetic" });
    const { closure } = fixture.resume();
    // Claude Code closes the trailing row, here an attachment after the prompt.
    expect(fixture.rows.find(({ uuid }) => uuid === closure)).toMatchObject({ parentUuid: reminder });

    const projection = await project(fixture);
    expect(statuses(projection)).toEqual(["completed", "interrupted"]);
    expect(transcript(projection)[1]).toEqual(["user: A synthetic prompt nobody answered.", `notice: ${unansweredNotice}`]);
    expect(projection.snapshot.runState).toBe("idle");
    const ended = projection.snapshot.orderedBackendTurnIds[1]!;
    expect(projection.snapshot.turnsById[ended]).toMatchObject({ endedBy: "interrupted",
      completedAt: fixture.rows.find(({ uuid }) => uuid === closure)!.timestamp });
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(ended)).toBe(false);

    fixture.resume();
    fixture.resume();
    expect((await project(fixture)).snapshot).toEqual(projection.snapshot);
  });

  it.each([false, true])("ends a turn cut off after a tool result (hidden Continue row before 2.1.281: %s)", async (hiddenContinue) => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.prompt("Read the synthetic file.");
    const [call] = fixture.reply([{ type: "tool_use", id: "toolu_synthetic_read", name: "Read", input: { file_path: "/synthetic/file" } }],
      { stopReason: "tool_use" });
    fixture.toolResult("toolu_synthetic_read", call!);
    if (hiddenContinue) {
      fixture.prompt("Continue from where you left off.", { isMeta: true, origin: undefined, promptId: undefined,
        message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } });
    }
    expect(fixture.resume().closure).toBeDefined();

    const projection = await project(fixture);
    expect(statuses(projection)).toEqual(["interrupted"]);
    expect(transcript(projection)).toEqual([["user: Read the synthetic file.", "file_read", `notice: ${unansweredNotice}`]]);
    const tool = Object.values(projection.snapshot.itemsById).find((item) => item.semanticKind === "file_read");
    expect(tool?.status).toBe("completed");
  });

  it("keeps a user-interrupted turn interrupted without a phantom answer", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.prompt("Start a long synthetic task.");
    fixture.text("Working on the synthetic task");
    fixture.prompt("[Request interrupted by user]", { origin: undefined, promptId: undefined,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(fixture.resume().closure).toBeDefined();

    const projection = await project(fixture);
    expect(statuses(projection)).toEqual(["interrupted"]);
    expect(transcript(projection)).toEqual([["user: Start a long synthetic task.", "assistant: Working on the synthetic task"]]);
  });

  it("keeps a task notification Claude read while running a tool inside that turn", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    fixture.prompt("Run the synthetic build, then check the synthetic lint.");
    const [call] = fixture.reply([{ type: "tool_use", id: "toolu_synthetic_lint", name: "Bash", input: { command: "true" } }],
      { stopReason: "tool_use" });
    fixture.toolResult("toolu_synthetic_lint", call!);
    const folded = fixture.attachment({ type: "queued_command", commandMode: "task-notification",
      prompt: "<task-notification>\n<task-id>bsynthetic1</task-id>\n<status>completed</status>\n</task-notification>" });
    fixture.answer("Build and lint both passed.");

    const messages = await ours(fixture);
    expect(messages.find(({ uuid }) => uuid === folded)).toMatchObject({ origin: { kind: "task-notification" }, isQueuedCommand: true });
    const projection = await project(fixture);
    expect(statuses(projection)).toEqual(["completed"]);
    expect(transcript(projection)).toEqual([["user: Run the synthetic build, then check the synthetic lint.", "command",
      "assistant: Build and lint both passed."]]);
  });

  it("counts a queued command followed by an interrupted-call marker as answered", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Start a synthetic task.");
    fixture.reply([{ type: "tool_use", id: "toolu_synthetic_lost", name: "Bash", input: { command: "true" } }],
      { stopReason: "tool_use" });
    const steer = fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Also check the synthetic docs.",
      origin: { kind: "human" } });
    const marker = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is " +
      "unknown. Check whether it took effect before relying on it or running it again.]";
    fixture.prompt(marker, { origin: undefined, promptId: undefined, message: { role: "user", content: [{ type: "text", text: marker }] } });
    expect(uuids(await ours(fixture))).toContain(steer);
    expect(await ours(fixture)).toEqual(await sdk(fixture));
  });

  describe("unfinished background work reported on resume", () => {
    const variants = [
      ["an agent with no completion record", { status: "stopped", summary: "Background agent \"synthetic survey\" didn't finish before the previous session ended",
        note: "Synthetic note: no completion record was found in the previous session." }],
      ["an agent lost with its process", { status: "failed", summary: "Background agent \"synthetic survey\" didn't finish before the previous session ended",
        note: "Synthetic note: it was running when the previous process exited." }],
      ["several agents", { status: "stopped", taskIds: ["asynthetic0000001", "asynthetic0000002"],
        summary: "2 background agents didn't finish before the previous session ended: \"synthetic a\" (asynthetic0000001), \"synthetic b\" (asynthetic0000002)." }],
      ["a shell command", { status: "stopped", toolUseId: "toolu_synthetic_shell",
        summary: "Background shell command didn't finish before the previous session ended" }],
      ["the older wording", { status: "stopped",
        summary: "No completion record was found for background agent \"synthetic survey\" from the previous session." }],
    ] as const;

    function beforeResume() {
      const fixture = new ClaudeTranscriptFixture(workspace);
      fixture.startupMessage();
      fixture.prompt("Start a synthetic background survey.");
      fixture.answer("The synthetic survey is running in the background.");
      return fixture;
    }

    it.each(variants)("drops an unanswered notification about %s and its later closure", async (_label, notification) => {
      const fixture = beforeResume();
      const settled = await project(fixture);
      // Claude Code writes the notification on resume, before the startup message.
      const row = fixture.taskNotification(notification);
      fixture.startupMessage();
      expect((await ours(fixture)).find(({ uuid }) => uuid === row)).toMatchObject({ origin: { kind: "task-notification" } });
      expect((await project(fixture)).snapshot).toEqual(settled.snapshot);
      expect(fixture.resume().closure).toBeDefined();
      const reopened = await project(fixture);
      expect(reopened.snapshot).toEqual(settled.snapshot);
      expect(reopened.terminalCheckpointUuidByBackendTurnId).toEqual(settled.terminalCheckpointUuidByBackendTurnId);
    });

    it("shows a turn Claude starts for a resume notification", async () => {
      const fixture = beforeResume();
      fixture.taskNotification(variants[0][1]);
      const answer = fixture.answer("The synthetic survey stopped; it can be resumed.");
      fixture.startupMessage();
      fixture.resume();
      const projection = await project(fixture);
      expect(statuses(projection)).toEqual(["completed", "completed"]);
      expect(transcript(projection)[1]).toEqual(["assistant: The synthetic survey stopped; it can be resumed."]);
      expect(projection.terminalCheckpointUuidByBackendTurnId.get(projection.snapshot.orderedBackendTurnIds[1]!)).toBe(answer);
    });
  });
});

/**
 * Automatic compaction as Claude Code 2.1.28x persists it (see
 * `autoCompaction`). Sedes shows the summarized history, a compaction marker
 * where the summary sits, and Claude's current context after it.
 */
describe("Claude automatic compaction", () => {
  async function read(fixture: ClaudeTranscriptFixture) {
    const messages = await ours(fixture);
    // The newest segment is exactly the SDK's read: the model's context.
    const context = await sdk(fixture);
    expect(messages.slice(messages.length - context.length)).toEqual(context);
    // Lifecycle maintenance reads only that segment.
    for (const includeSystemMessages of [false, true]) {
      expect(await ours(fixture, { includeSystemMessages, resumableOnly: true }))
        .toEqual(await sdk(fixture, { includeSystemMessages }));
    }
    return { messages, projection: projectClaudeHistory(messages) };
  }

  /** Item kinds and texts per turn, in order. */
  function turns(projection: ReturnType<typeof projectClaudeHistory>): string[][] {
    const { snapshot } = projection;
    return snapshot.orderedBackendTurnIds.map((turnId) => snapshot.turnsById[turnId]!.orderedBackendItemIds.map((itemId) => {
      const item = snapshot.itemsById[itemId]!;
      if (item.semanticKind === "user_message") return `user: ${item.content.flatMap((part) => part.kind === "text" ? [part.text.text] : []).join("")}`;
      if (item.semanticKind === "assistant_message") return `assistant: ${item.markdown.text}`;
      if (item.semanticKind === "notice") return `notice: ${item.text.text}`;
      return item.semanticKind;
    }));
  }

  function statuses(projection: ReturnType<typeof projectClaudeHistory>): string[] {
    return projection.snapshot.orderedBackendTurnIds.map((id) => projection.snapshot.turnsById[id]!.status);
  }

  /** A settled turn, then a turn Claude compacts after its first tool round. */
  function midTurn() {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.startupMessage();
    const first = fixture.prompt("Summarize the synthetic notes.");
    const firstAnswer = fixture.answer("There are three synthetic notes.");
    fixture.startupMessage();
    const prompt = fixture.prompt("Refactor the synthetic parser.");
    fixture.attachment({ type: "total_tokens_reminder" });
    const [thinking, text, call] = fixture.reply([
      { type: "thinking", thinking: "synthetic reasoning", signature: "c3ludGhldGlj" },
      { type: "text", text: "Reading the parser first." },
      { type: "tool_use", id: "toolu_parser", name: "Read", input: { file_path: "/synthetic/parser.ts" } },
    ], { stopReason: "tool_use" });
    const result = fixture.toolResult("toolu_parser", call!);
    const reminder = fixture.attachment({ type: "total_tokens_reminder" });
    return { fixture, first, firstAnswer, prompt, preserved: [thinking!, text!, call!, result, reminder] };
  }

  it("keeps the turns before a mid-turn compaction and marks it inside the turn it interrupted", async () => {
    const { fixture, first, firstAnswer, prompt, preserved } = midTurn();
    const before = await read(fixture);
    const { summary } = fixture.autoCompaction({ preserved });
    const answer = fixture.answer("The parser is refactored.");

    const { messages, projection } = await read(fixture);
    // The prompt the compaction summarized stays; the rows the model kept follow the summary.
    expect(uuids(messages)).toEqual([first, firstAnswer, prompt, summary, ...preserved.slice(0, 4), answer]);
    expect(projection.snapshot.orderedBackendTurnIds).toEqual(before.projection.snapshot.orderedBackendTurnIds);
    expect(statuses(projection)).toEqual(["completed", "completed"]);
    expect(turns(projection)).toEqual([
      ["user: Summarize the synthetic notes.", "assistant: There are three synthetic notes."],
      ["user: Refactor the synthetic parser.", "compaction", "reasoning", "assistant: Reading the parser first.", "file_read",
        "assistant: The parser is refactored."],
    ]);
    const marker = Object.values(projection.snapshot.itemsById).find((item) => item.semanticKind === "compaction");
    expect(marker).toMatchObject({ status: "completed", summary: { text: expect.stringContaining("Synthetic request") } });
    expect(projection.usage?.counters).toMatchObject({ userMessages: 2, compactions: 1 });
    // Claude Code resumes only from the summary; earlier turns cannot anchor a fork.
    const [settled, compacted] = projection.snapshot.orderedBackendTurnIds;
    expect(before.projection.terminalCheckpointUuidByBackendTurnId.get(settled!)).toBe(firstAnswer);
    expect(projection.terminalCheckpointUuidByBackendTurnId.has(settled!)).toBe(false);
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(compacted!)).toBe(answer);
    expect(claudeResumableHistoryStart(messages)).toBe(3);
    expect(claudeResumableHistoryStart(before.messages)).toBe(0);
  });

  it("keeps summarized rows in place when the compaction lists none to relink", async () => {
    const { fixture, prompt, preserved } = midTurn();
    const [, text, call, result] = preserved;
    // The shape with a segment but no listed rows: neither Claude Code nor the SDK relinks it.
    const { summary } = fixture.autoCompaction({ segment: { headUuid: preserved[0]!, tailUuid: preserved.at(-1)! } });
    const answer = fixture.answer("The parser is refactored.");

    const { messages, projection } = await read(fixture);
    expect(uuids(messages).slice(2)).toEqual([prompt, preserved[0], text, call, result, summary, answer]);
    expect(turns(projection)[1]).toEqual(["user: Refactor the synthetic parser.", "reasoning", "assistant: Reading the parser first.",
      "file_read", "compaction", "assistant: The parser is refactored."]);
    expect(statuses(projection)).toEqual(["completed", "completed"]);
  });

  it("keeps every turn across several compactions and forks only after the latest", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const first = fixture.prompt("First synthetic task.");
    fixture.answer("First synthetic answer.");
    const second = fixture.prompt("Second synthetic task.");
    const { summary: early } = fixture.autoCompaction({ summary: "1. Synthetic early summary." });
    fixture.answer("Second synthetic answer.");
    const third = fixture.prompt("Third synthetic task.");
    const [call] = fixture.reply([{ type: "tool_use", id: "toolu_third", name: "Read", input: { file_path: "/synthetic/third" } }],
      { stopReason: "tool_use" });
    const result = fixture.toolResult("toolu_third", call!);
    const { summary: late } = fixture.autoCompaction({ preserved: [call!, result], summary: "1. Synthetic late summary." });
    const answer = fixture.answer("Third synthetic answer.");

    const { messages, projection } = await read(fixture);
    expect(uuids(messages).filter((uuid) => [first, second, early, third, late, answer].includes(uuid)))
      .toEqual([first, second, early, third, late, answer]);
    expect(turns(projection)).toEqual([
      ["user: First synthetic task.", "assistant: First synthetic answer."],
      ["user: Second synthetic task.", "compaction", "assistant: Second synthetic answer."],
      ["user: Third synthetic task.", "compaction", "file_read", "assistant: Third synthetic answer."],
    ]);
    expect(projection.usage?.counters).toMatchObject({ userMessages: 3, compactions: 2 });
    expect([...projection.terminalCheckpointUuidByBackendTurnId.values()]).toEqual([answer]);
  });

  it("reads the same after a resume, and ends a turn whose process died right after compacting", async () => {
    const settled = midTurn();
    settled.fixture.autoCompaction({ preserved: settled.preserved });
    settled.fixture.answer("The parser is refactored.");
    const compacted = await read(settled.fixture);
    // The SDK misreads a startup-message tip, so only Sedes' read is compared from here.
    expect(settled.fixture.resume().closure).toBeUndefined();
    expect(await ours(settled.fixture)).toEqual(compacted.messages);

    const { fixture, preserved } = midTurn();
    fixture.autoCompaction({ preserved });
    const running = await read(fixture);
    expect(uuids(running.messages).slice(3, 8)).toEqual([running.messages[3]!.uuid, ...preserved.slice(0, 4)]);
    expect(statuses(running.projection)).toEqual(["completed", "in_progress"]);
    expect(running.projection.snapshot.runState).toBe("running");
    // Claude Code closes the trailing attachment when the session resumes.
    expect(fixture.resume().closure).toBeDefined();
    const projection = projectClaudeHistory(await ours(fixture));
    expect(statuses(projection)).toEqual(["completed", "interrupted"]);
    expect(turns(projection)[1]).toEqual(["user: Refactor the synthetic parser.", "compaction", "reasoning",
      "assistant: Reading the parser first.", "file_read",
      "notice: Claude Code exited before this turn finished and closed it without a response when the conversation resumed."]);
    expect(projection.snapshot.runState).toBe("idle");
  });

  it("reads a fork of a compacted conversation, which starts at the summary", async () => {
    // Claude Code copies what it resumes: the boundary, the summary, and the rows after it.
    const fixture = new ClaudeTranscriptFixture(workspace);
    const { summary } = fixture.autoCompaction();
    fixture.from(summary);
    fixture.reply([{ type: "text", text: "Continuing the synthetic refactor." }]);
    const answer = fixture.answer("The synthetic refactor is complete.");
    const { messages, projection } = await read(fixture);
    expect(messages).toEqual(await sdk(fixture));
    // The child's first attach persists a startup message after its copy.
    fixture.startupMessage();
    expect(await ours(fixture)).toEqual(messages);
    expect(turns(projection)).toEqual([["compaction", "assistant: Continuing the synthetic refactor.",
      "assistant: The synthetic refactor is complete."]]);
    expect(statuses(projection)).toEqual(["completed"]);
    expect([...projection.terminalCheckpointUuidByBackendTurnId.values()]).toEqual([answer]);
    expect(claudeResumableHistoryStart(messages)).toBe(0);
  });

  it("marks a compaction alone as a settled turn", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.autoCompaction();
    const { projection } = await read(fixture);
    expect(turns(projection)).toEqual([["compaction"]]);
    expect(statuses(projection)).toEqual(["completed"]);
    expect(projection.snapshot.runState).toBe("idle");
    expect(projection.terminalCheckpointUuidByBackendTurnId.size).toBe(0);
  });

  it("puts a compaction before a notification turn's first response into that turn", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Start a synthetic background survey.");
    fixture.answer("The synthetic survey is running.");
    fixture.taskNotification({ status: "completed", summary: "Background agent \"synthetic survey\" completed" });
    fixture.autoCompaction();
    const answer = fixture.answer("The synthetic survey found two issues.");

    const { projection } = await read(fixture);
    expect(turns(projection)).toEqual([
      ["user: Start a synthetic background survey.", "assistant: The synthetic survey is running."],
      ["compaction", "assistant: The synthetic survey found two issues."],
    ]);
    expect(projection.terminalCheckpointUuidByBackendTurnId.get(projection.snapshot.orderedBackendTurnIds[1]!)).toBe(answer);
  });
});

describe("Claude native transcript location", () => {
  it("finds the workspace project directory through a symlinked path", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Hello.");
    await fixture.write(configDirectory, workspace);
    const link = path.join(root, "link");
    await symlink(workspace, link);
    expect(await locateClaudeSessionTranscript(fixture.sessionId, link, environment())).toBeDefined();
    expect(await locateClaudeSessionTranscript(randomUUID(), workspace, environment())).toBeUndefined();
    expect(await locateClaudeSessionTranscript("not-a-session", workspace, environment())).toBeUndefined();
  });

  it("honours the configured project directory override and hashes long workspace paths", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Hello.");
    const overridden = path.join(configDirectory, "projects", "synthetic-project");
    await mkdir(overridden, { recursive: true });
    await writeFile(path.join(overridden, `${fixture.sessionId}.jsonl`), fixture.jsonl());
    const override = { CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_PROJECT_DIR_NAME: "synthetic-project" };
    expect((await locateClaudeSessionTranscript(fixture.sessionId, workspace, override))?.filePath)
      .toBe(path.join(overridden, `${fixture.sessionId}.jsonl`));
    expect(await locateClaudeSessionTranscript(fixture.sessionId, workspace, environment())).toBeUndefined();

    const long = path.join(root, "a".repeat(120), "b".repeat(120));
    await mkdir(long, { recursive: true });
    const longFixture = new ClaudeTranscriptFixture(long);
    longFixture.prompt("Long path.");
    const reply = longFixture.text("Found.");
    // Claude Code truncates the sanitized path at 200 characters and appends a portable hash.
    let hash = 0;
    for (let index = 0; index < long.length; index++) hash = ((hash << 5) - hash + long.charCodeAt(index)) | 0;
    const directory = path.join(configDirectory, "projects", `${long.replace(/[^a-zA-Z0-9]/gu, "-").slice(0, 200)}-${Math.abs(hash).toString(36)}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${longFixture.sessionId}.jsonl`), longFixture.jsonl());
    const messages = await readClaudeSessionMessages(longFixture.sessionId, { dir: long }, environment());
    expect(messages.at(-1)?.uuid).toBe(reply);
    expect(messages).toEqual(await getSessionMessages(longFixture.sessionId, { dir: long }));
  });

  it("treats empty files and directories as absent", async () => {
    const sessionId = randomUUID();
    const directory = path.join(configDirectory, "projects", workspace.replace(/[^a-zA-Z0-9]/gu, "-"));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${sessionId}.jsonl`), "");
    expect(await locateClaudeSessionTranscript(sessionId, workspace, environment())).toBeUndefined();
    const other = randomUUID();
    await mkdir(path.join(directory, `${other}.jsonl`));
    expect(await locateClaudeSessionTranscript(other, workspace, environment())).toBeUndefined();
    expect(await readClaudeSessionMessages(other, { dir: workspace }, environment())).toEqual([]);
  });

  it("requires a workspace directory and the runtime's own native store through the facade", async () => {
    const facade = new OfficialClaudeSdkFacade();
    await expect(facade.getSessionMessages(randomUUID(), {}, process.env)).rejects.toThrow(
      "claude_session_history_directory_required",
    );
    await expect(facade.hasSessionTranscript(randomUUID(), { dir: workspace }, { CLAUDE_CONFIG_DIR: path.join(root, "other") }))
      .rejects.toThrow("claude_sdk_helper_environment_mismatch");
  });
});
