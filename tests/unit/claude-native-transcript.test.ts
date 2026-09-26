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
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { OfficialClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";
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

async function ours(fixture: ClaudeTranscriptFixture, options: { includeSystemMessages?: boolean; offset?: number; limit?: number } = {}) {
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

/** A resumed "Refactor"-shaped conversation: parallel calls, then a later turn. */
function refactorShaped(): { fixture: ClaudeTranscriptFixture; lastReply: string; deadEnds: string[] } {
  const fixture = new ClaudeTranscriptFixture(workspace);
  fixture.startupMessage();
  fixture.prompt("Refactor the synthetic parser.");
  const first = fixture.parallelToolCalls("alpha");
  fixture.text("The parser splits lines twice.");
  fixture.system("turn_duration", { durationMs: 1234 });
  fixture.bookkeeping({ type: "custom-title", customTitle: "Synthetic refactor" });
  fixture.startupMessage();
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
  it("reads a startup-message tip through its true chain where the SDK stops at a parallel dead end", async () => {
    const { fixture, lastReply, deadEnds } = refactorShaped();
    fixture.startupMessage();

    const messages = await ours(fixture);
    expect(messages.at(-1)?.uuid).toBe(lastReply);
    expect(uuids(messages)).toEqual(expect.arrayContaining(deadEnds));
    expect(messages.some((message) => message.type === "user" && typeof message.message === "object" &&
      JSON.stringify(message.message).includes("NON-USER SOURCE"))).toBe(false);

    // The pinned SDK's leaf heuristic skips the meta tip and picks the file-latest dead end.
    const truncated = await sdk(fixture);
    expect(truncated.length).toBeLessThan(messages.length);
    expect(uuids(truncated)).not.toContain(lastReply);
    expect(uuids(truncated)).toContain(deadEnds[1]);
  });

  it("matches the pinned SDK exactly when the tip is not a startup message", async () => {
    const { fixture } = refactorShaped();
    expect(await ours(fixture)).toEqual(await sdk(fixture));
    expect(await ours(fixture, { includeSystemMessages: true })).toEqual(await sdk(fixture, { includeSystemMessages: true }));
  });

  it("matches the SDK once the next prompt follows a startup message", async () => {
    const { fixture } = refactorShaped();
    fixture.startupMessage();
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

  it("converts answered human queued commands and drops unanswered, meta, and forwarded ones", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Start a long task.");
    const sourceUuid = randomUUID();
    const queued = fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Also check tests.",
      source_uuid: sourceUuid, origin: { kind: "human" } });
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Meta note.", isMeta: true });
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: "Forwarded.",
      forwardedIntent: { lineage: "synthetic-lineage", source: "relay" } });
    fixture.text("Checked both.");
    fixture.attachment({ type: "queued_command", commandMode: "prompt", prompt: [{ type: "text", text: "Unanswered." }] });
    fixture.prompt("Next prompt.");

    const messages = await ours(fixture);
    const converted = messages.find(({ uuid }) => uuid === sourceUuid);
    expect(converted).toMatchObject({ type: "user", message: { role: "user", content: "Also check tests." }, origin: { kind: "human" } });
    expect(uuids(messages)).not.toContain(queued);
    expect(JSON.stringify(messages)).not.toContain("Meta note.");
    expect(JSON.stringify(messages)).not.toContain("Forwarded.");
    expect(JSON.stringify(messages)).not.toContain("Unanswered.");
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

  it("stops at a compact boundary and marks the summary like the SDK", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const before = fixture.prompt("Before compaction.");
    fixture.text("Old answer.");
    const { summary } = fixture.compaction("Synthetic summary of the earlier conversation.");
    const after = fixture.prompt("After compaction.");
    fixture.text("New answer.");

    const messages = await ours(fixture);
    expect(uuids(messages)).not.toContain(before);
    expect(messages[0]).toMatchObject({ uuid: summary, isCompactSummary: true, is_meta: true });
    expect(uuids(messages)).toContain(after);
    expect(messages).toEqual(await sdk(fixture));
    expect(await ours(fixture, { includeSystemMessages: true })).toEqual(await sdk(fixture, { includeSystemMessages: true }));
    fixture.startupMessage();
    expect(await ours(fixture)).toEqual(messages);
  });

  it("relinks a preserved compaction segment like the SDK", async () => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    fixture.prompt("Old prompt.");
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
    expect(uuids(messages)).toEqual([summary, kept, keptReply, next]);
    expect(messages).toEqual(await sdk(fixture));
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

  it.each([true, false])("hides the startup message and parents the next prompt on it (queueTranscriptOnly: %s)", async (queueTranscriptOnly) => {
    const fixture = new ClaudeTranscriptFixture(workspace);
    const startup = fixture.startupMessage({ queueTranscriptOnly });
    const prompt = fixture.prompt("Describe the synthetic module.");
    const answer = fixture.answer("It parses synthetic input.");
    // Before 2.1.280 the row lacked `queueTranscriptOnly`, so the model also
    // received its "NON-USER SOURCE" label merged into this prompt.
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
