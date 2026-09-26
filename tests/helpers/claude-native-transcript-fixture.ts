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
   */
  startupMessage(uuid: string = randomUUID()): string {
    this.#bookkeeping({ type: "queue-operation", operation: "enqueue", content: "" });
    this.#bookkeeping({ type: "queue-operation", operation: "dequeue" });
    const startup = this.from(this.#lastMessage).#append({ uuid, type: "user", isMeta: true, origin: { kind: "unclassified" },
      message: { role: "user", content: "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n(no content)" },
      promptId: randomUUID(), queueSkipAttachments: true, queueTranscriptOnly: true });
    this.#bookkeeping({ type: "last-prompt", leafUuid: startup });
    return startup;
  }

  /** One assistant message stored as one row per content block. */
  reply(blocks: readonly Row[], options: { readonly model?: string; readonly messageId?: string; readonly extra?: Row } = {}): string[] {
    const messageId = options.messageId ?? `msg_synthetic_${++this.#messages}`;
    return blocks.map((block) => this.#append({ type: "assistant", message: {
      id: messageId, type: "message", role: "assistant", model: options.model ?? "claude-synthetic-1",
      content: [block], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 },
    }, requestId: `req_synthetic_${this.#messages}`, ...options.extra }));
  }

  text(text: string): string {
    return this.reply([{ type: "text", text }])[0]!;
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
