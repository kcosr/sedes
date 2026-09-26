import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Row = Record<string, unknown>;

/**
 * Synthetic Claude Code transcript with the native row shapes Sedes reads:
 * content-block assistant rows, parallel tool results, meta startup messages,
 * attachments, bookkeeping rows, and compaction. All text is invented.
 */
export class ClaudeTranscriptFixture {
  readonly sessionId = randomUUID();
  readonly rows: Row[] = [];
  readonly #lines: string[] = [];
  readonly #cwd: string;
  #tip: string | null = null;
  #lastMessage: string | null = null;
  #lastConversational: string | null = null;
  #clock = Date.parse("2026-01-02T03:04:05.000Z");
  #messages = 0;

  constructor(cwd = "/synthetic/workspace") {
    this.#cwd = cwd;
  }

  /** The row the next appended row attaches to. */
  get tip(): string | null {
    return this.#tip;
  }

  /** Continue from an earlier row, as rewind or a later resume does. */
  from(parentUuid: string | null): this {
    this.#tip = parentUuid;
    return this;
  }

  prompt(text: string, extra: Row = {}): string {
    return this.#append({ type: "user", message: { role: "user", content: text },
      origin: { kind: "human" }, promptId: randomUUID(), ...extra });
  }

  /**
   * Claude Code's persisted form of Sedes' empty `shouldQuery: false` startup
   * message, attached to the last user or assistant row on every launch.
   * Releases before 2.1.280 omit `queueTranscriptOnly`, so the model also
   * received the label with the next prompt.
   */
  startupMessage(options: { readonly uuid?: string; readonly queueTranscriptOnly?: boolean } = {}): string {
    this.#bookkeeping({ type: "queue-operation", operation: "enqueue", content: "" });
    this.#bookkeeping({ type: "queue-operation", operation: "dequeue" });
    const startup = this.from(this.#lastMessage).#append({ uuid: options.uuid ?? randomUUID(), type: "user", isMeta: true,
      origin: { kind: "unclassified" },
      message: { role: "user", content: "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n(no content)" },
      promptId: randomUUID(), queueSkipAttachments: true,
      ...(options.queueTranscriptOnly === false ? {} : { queueTranscriptOnly: true }) });
    this.#bookkeeping({ type: "last-prompt", leafUuid: startup });
    return startup;
  }

  /**
   * The row Claude Code inserts, without calling the model, when it resumes a
   * session whose last row is a user or attachment row: a zero-usage
   * `<synthetic>` assistant message with exactly this text.
   */
  noResponseRequested(): string {
    return this.from(this.#lastConversational).#append({ type: "assistant", isApiErrorMessage: false, message: {
      diagnostics: null, id: randomUUID(), container: null, model: "<synthetic>", role: "assistant", stop_details: null,
      stop_reason: "stop_sequence", stop_sequence: "", type: "message",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: "text", text: "No response requested." }], context_management: null,
    } });
  }

  /**
   * One Sedes attach resuming the session: Claude Code 2.1.28x closes a
   * trailing user or attachment row, then persists the new startup message.
   */
  resume(options: { readonly queueTranscriptOnly?: boolean } = {}): { readonly closure?: string; readonly startup: string } {
    const last = this.rows.findLast((row) => row.uuid === this.#lastConversational);
    // A transcript-only task notification is left open, like Claude Code does.
    const transcriptOnlyNotification = last?.queueTranscriptOnly === true &&
      (last.origin as Row | undefined)?.kind === "task-notification";
    const closure = last && last.type !== "assistant" && !transcriptOnlyNotification ? this.noResponseRequested() : undefined;
    return { ...(closure ? { closure } : {}), startup: this.startupMessage(options) };
  }

  /** One assistant message stored as one row per content block. */
  reply(blocks: readonly Row[], options: {
    readonly model?: string; readonly messageId?: string; readonly stopReason?: string; readonly extra?: Row;
  } = {}): string[] {
    const messageId = options.messageId ?? `msg_synthetic_${++this.#messages}`;
    return blocks.map((block, index) => this.#append({ type: "assistant", message: {
      id: messageId, type: "message", role: "assistant", model: options.model ?? "claude-synthetic-1",
      content: [block], stop_reason: index === blocks.length - 1 ? options.stopReason ?? null : null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, requestId: `req_synthetic_${this.#messages}`, ...options.extra }));
  }

  text(text: string): string {
    return this.reply([{ type: "text", text }])[0]!;
  }

  /** A final reply as Claude Code persists it: the last row carries `end_turn`. */
  answer(text: string): string {
    return this.reply([{ type: "text", text }], { stopReason: "end_turn" })[0]!;
  }

  /** A provider-injected `<task-notification>` user row, as written on resume. */
  taskNotification(input: {
    readonly status: "completed" | "failed" | "stopped";
    readonly summary: string;
    readonly note?: string;
    readonly taskIds?: readonly string[];
    readonly toolUseId?: string;
  }): string {
    const lines = [
      "<task-notification>",
      ...(input.taskIds ?? ["asynthetic0000001"]).map((id) => `<task-id>${id}</task-id>`),
      ...(input.toolUseId ? [`<tool-use-id>${input.toolUseId}</tool-use-id>`] : []),
      `<status>${input.status}</status>`,
      `<summary>${input.summary}</summary>`,
      ...(input.note ? [`<note>${input.note}</note>`] : []),
      "</task-notification>",
    ];
    return this.#append({ type: "user", message: { role: "user", content: lines.join("\n") },
      origin: { kind: "task-notification" }, promptSource: "system", queueSkipAttachments: true, queueTranscriptOnly: true });
  }

  toolResult(toolUseId: string, parentUuid: string, text = `result of ${toolUseId}`): string {
    return this.from(parentUuid).#append({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: toolUseId, content: text },
    ] }, sourceToolAssistantUUID: parentUuid, toolUseResult: { stdout: text } });
  }

  /**
   * Parallel calls: the result of the last call is written first and becomes a
   * dead end; the conversation continues from the first call's result.
   */
  parallelToolCalls(label: string): { readonly deadEnd: string; readonly continued: string } {
    const [, first, second] = this.reply([
      { type: "text", text: `${label}: checking two things` },
      { type: "tool_use", id: `toolu_${label}_1`, name: "Read", input: { file_path: `/synthetic/${label}/1` } },
      { type: "tool_use", id: `toolu_${label}_2`, name: "Read", input: { file_path: `/synthetic/${label}/2` } },
    ]);
    const deadEnd = this.toolResult(`toolu_${label}_2`, second!);
    const continued = this.toolResult(`toolu_${label}_1`, first!);
    this.attachment({ type: "total_tokens_reminder", used: 1, total: 2 });
    return { deadEnd, continued };
  }

  attachment(attachment: Row, extra: Row = {}): string {
    return this.#append({ type: "attachment", attachment, ...extra });
  }

  system(subtype: string, extra: Row = {}): string {
    return this.#append({ type: "system", subtype, content: `synthetic ${subtype}`, level: "info", isMeta: false, ...extra });
  }

  /** Claude Code writes a null-parented boundary, then the summary as its child. */
  compaction(summary: string, compactMetadata: Row = { trigger: "auto", preTokens: 100 }): { readonly boundary: string; readonly summary: string } {
    const logicalParentUuid = this.#tip;
    const boundary = this.from(null).system("compact_boundary", { logicalParentUuid, compactMetadata });
    return { boundary, summary: this.prompt(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }) };
  }

  /**
   * An automatic compaction as Claude Code 2.1.28x persists it. The boundary
   * has a null parent and names the last row it summarized; three context
   * attachments follow, then the summary (the model's whole context for what
   * came before), then attachments that reload files. `preserved` lists the
   * newest rows the model keeps verbatim, oldest first: readers relink them
   * after the summary, and rows written later continue after them. A
   * `segment` without listed rows is the shape where nothing is relinked.
   */
  autoCompaction(options: {
    readonly preserved?: readonly string[];
    readonly segment?: { readonly headUuid: string; readonly tailUuid: string };
    readonly summary?: string;
  } = {}): { readonly boundary: string; readonly summary: string } {
    const logicalParentUuid = this.#tip;
    const summaryUuid = randomUUID();
    const preserved = options.preserved ?? [];
    const segment = preserved.length > 0
      ? { headUuid: preserved[0], anchorUuid: summaryUuid, tailUuid: preserved.at(-1) }
      : options.segment ? { ...options.segment, anchorUuid: summaryUuid } : undefined;
    const boundary = this.from(null).#append({ type: "system", subtype: "compact_boundary", content: "Conversation compacted",
      level: "info", logicalParentUuid, compactMetadata: {
        trigger: "auto", preTokens: 973_392, postTokens: 10_502, cumulativeDroppedTokens: 962_890, durationMs: 181_136,
        ...(segment ? { preservedSegment: segment } : {}),
        preservedMessages: { anchorUuid: summaryUuid, uuids: [...preserved], allUuids: [...preserved] },
      } });
    for (const type of ["instructions", "session_context", "date"]) this.attachment({ type });
    const summary = this.#append({ type: "user", uuid: summaryUuid, promptId: randomUUID(), isVisibleInTranscriptOnly: true,
      isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation " +
        "that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
        `${options.summary ?? "1. Synthetic request: refactor the synthetic parser."}\n\nContinue the conversation from where it left off.` } });
    this.attachment({ type: "compact_file_reference", filename: "/synthetic/file.ts" });
    this.attachment({ type: "prompt_snapshot" });
    return { boundary, summary };
  }

  bookkeeping(row: Row): void {
    this.#bookkeeping(row);
  }

  /** Append raw bytes, e.g. a line Claude Code has not finished writing. */
  raw(line: string): void {
    this.#lines.push(line);
  }

  jsonl(): string {
    return `${this.#lines.join("\n")}\n`;
  }

  /** Writes the transcript where Claude Code keeps it for `workspace`. */
  async write(configDirectory: string, workspace: string): Promise<string> {
    const directory = path.join(configDirectory, "projects", workspace.replace(/[^a-zA-Z0-9]/gu, "-"));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${this.sessionId}.jsonl`);
    await writeFile(file, this.jsonl());
    return file;
  }

  #append(row: Row): string {
    const uuid = typeof row.uuid === "string" ? row.uuid : randomUUID();
    const complete: Row = { parentUuid: this.#tip, isSidechain: false, ...row, uuid, timestamp: this.#timestamp(),
      userType: "external", entrypoint: "sdk-ts", cwd: this.#cwd, sessionId: this.sessionId,
      version: "2.1.283", gitBranch: "main" };
    this.rows.push(complete);
    this.#lines.push(JSON.stringify(complete));
    if (complete.isSidechain !== true) {
      this.#tip = uuid;
      if (complete.type === "user" || complete.type === "assistant") this.#lastMessage = uuid;
      if (complete.type === "user" || complete.type === "assistant" || complete.type === "attachment") {
        this.#lastConversational = uuid;
      }
    }
    return uuid;
  }

  #bookkeeping(row: Row): void {
    const complete = { ...row, sessionId: this.sessionId,
      ...(row.type === "queue-operation" ? { timestamp: this.#timestamp() } : {}) };
    this.rows.push(complete);
    this.#lines.push(JSON.stringify(complete));
  }

  #timestamp(): string {
    this.#clock += 1_000;
    return new Date(this.#clock).toISOString();
  }
}
