import type { GetSessionMessagesOptions, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { claudeConfigDirectory, type ClaudeChildEnvironment } from "./claude-child-environment.js";

/**
 * Sedes-owned reader for Claude Code's native JSONL transcripts.
 *
 * Claude Code appends every row of the active conversation as a child of the
 * row it last wrote. Rewind and edit append a new branch from an earlier row,
 * and the abandoned branch stays in the file, so the active branch always ends
 * at the last main-conversation user or assistant row in file order. That row
 * may be the meta row Claude Code persists for Sedes' startup message, or a
 * `<synthetic>` assistant row.
 *
 * SDK 0.3.274 `getSessionMessages` instead picks the file-latest childless row
 * that is not meta. Parallel tool calls leave childless sibling tool results,
 * so a transcript ending in the startup message reads back only to its last
 * parallel tool call. This reader walks from the true tip and otherwise
 * reproduces the SDK's conversion exactly: compaction relinking, parallel
 * fragment re-insertion, queued-command conversion, filtering, origin mapping,
 * and offset/limit slicing.
 *
 * The SDK, like Claude Code's own loader, stops at a compact boundary, whose
 * `parentUuid` is null: that segment is exactly what the model sees after the
 * compaction. This reader returns it unchanged as the newest segment and
 * prepends the conversation that the compaction summarized, so earlier turns
 * stay visible. Each earlier segment continues from the last conversation row
 * Claude Code wrote before the boundary. Rows that a later compaction
 * preserved appear once, in the later segment, where the model sees them.
 */

const TRANSCRIPT_ENTRY_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "progress", "system", "attachment"]);
const PARSE_YIELD_BYTES = 512 * 1024;
const RELINK_YIELD_ENTRIES = 8_192;
const PROJECT_DIRECTORY_NAME_LIMIT = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROJECT_DIRECTORY_OVERRIDE = /^[A-Za-z0-9_-]{1,64}$/u;
const RESERVED_PROJECT_DIRECTORY = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;
// Claude Code's reply markers; a queued command followed by one was answered.
const INTERRUPTION_MARKERS = [
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
  "[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]",
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]",
] as const;

/** One parsed transcript row with the fields this reader interprets. */
export type ClaudeTranscriptEntry = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly uuid: string;
};

export type ClaudeTranscriptReadOptions = Pick<GetSessionMessagesOptions, "includeSystemMessages" | "offset" | "limit"> & {
  /**
   * Sedes-private: read only the conversation Claude Code resumes, the newest
   * segment, exactly as the SDK reads it. Lifecycle maintenance that needs
   * only current provider evidence uses it; display reads never do.
   */
  readonly resumableOnly?: boolean;
};

export interface ClaudeTranscriptLocation {
  readonly filePath: string;
  readonly size: number;
}

/**
 * Locates the non-empty transcript Claude Code writes for a workspace. Only
 * the workspace's own native project directory is searched: Sedes binds each
 * session to its exact workspace, so the SDK's sibling-worktree and legacy
 * hash-prefix fallbacks could only find a session Sedes must reject.
 */
export async function locateClaudeSessionTranscript(
  sessionId: string,
  dir: string,
  environment: ClaudeChildEnvironment,
): Promise<ClaudeTranscriptLocation | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const projects = path.join(claudeConfigDirectory(environment).normalize("NFC"), "projects");
  let workspace: string;
  try {
    workspace = await realpath(dir);
  } catch {
    workspace = dir;
  }
  if (process.platform === "darwin") workspace = workspace.normalize("NFC");
  const sanitized = projectDirectoryName(workspace);
  const override = environment.CLAUDE_CONFIG_DIR
    ? validProjectDirectoryOverride(environment.CLAUDE_CODE_PROJECT_DIR_NAME)
    : undefined;
  for (const name of override !== undefined && override !== sanitized ? [override, sanitized] : [sanitized]) {
    const filePath = path.join(projects, name, `${sessionId}.jsonl`);
    let details;
    try {
      details = await stat(filePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (details.isFile() && details.size > 0) return { filePath, size: details.size };
  }
  return undefined;
}

/**
 * Reads one session through its true tip. An absent transcript reads as empty,
 * like the SDK; unlike the SDK, an unreadable transcript fails closed.
 */
export async function readClaudeSessionMessages(
  sessionId: string,
  options: ClaudeTranscriptReadOptions & { readonly dir: string },
  environment: ClaudeChildEnvironment,
): Promise<SessionMessage[]> {
  const location = await locateClaudeSessionTranscript(sessionId, options.dir, environment);
  if (!location) return [];
  let contents: Buffer;
  try {
    contents = await readFile(location.filePath);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return await resolveClaudeSessionMessages(await parseClaudeTranscript(contents), options);
}

/**
 * Parses transcript lines exactly as the SDK does: a row that is not complete
 * JSON, including a final line Claude Code is still appending, is skipped.
 */
export async function parseClaudeTranscript(contents: Buffer): Promise<ClaudeTranscriptEntry[]> {
  const entries: ClaudeTranscriptEntry[] = [];
  let offset = 0;
  let nextYield = PARSE_YIELD_BYTES;
  while (offset < contents.length) {
    if (offset >= nextYield) {
      await yieldToEventLoop();
      nextYield = offset + PARSE_YIELD_BYTES;
    }
    let end = contents.indexOf(10, offset);
    if (end === -1) end = contents.length;
    let start = offset;
    while (start < end && contents[start]! <= 32) start++;
    offset = end + 1;
    if (start >= end) continue;
    let value: unknown;
    try {
      value = JSON.parse(contents.toString("utf8", start, end));
    } catch {
      continue;
    }
    if (isTranscriptEntry(value)) entries.push(value);
  }
  return entries;
}

/** Projects parsed rows to the SDK's `SessionMessage` shape from the true tip. */
export async function resolveClaudeSessionMessages(
  entries: readonly ClaudeTranscriptEntry[],
  options: ClaudeTranscriptReadOptions = {},
): Promise<SessionMessage[]> {
  const chain = await resolveActiveChain(entries, options.resumableOnly === true);
  const replies = replyFollows(chain);
  const chainUuids = new Set(chain.map(({ uuid }) => uuid));
  const includeSystemMessages = options.includeSystemMessages ?? false;
  const messages = chain
    .map((entry, index) => convertQueuedCommand(entry, replies[index]!, chainUuids))
    .filter((entry) => isVisible(entry, includeSystemMessages))
    .map(toSessionMessage);
  return page(messages, options);
}

async function resolveActiveChain(entries: readonly ClaudeTranscriptEntry[], resumableOnly: boolean): Promise<ClaudeTranscriptEntry[]> {
  const byUuid = new Map<string, ClaudeTranscriptEntry>();
  const lastIndex = new Map<string, number>();
  entries.forEach((entry, index) => {
    byUuid.set(entry.uuid, entry);
    lastIndex.set(entry.uuid, index);
  });
  // Relinking replaces map values, so the file's own parents stay available.
  const written = new Map(byUuid);
  const relinkedTails = await relinkPreservedCompaction(byUuid);
  // A summary written last still precedes the rows relinked after it.
  const continued = (entry: ClaudeTranscriptEntry | undefined) =>
    entry && byUuid.get(relinkedTails.get(entry.uuid) ?? entry.uuid);
  const tip = continued(activeTip(entries, lastIndex, entries.length));
  if (!tip) return [];
  const onChain = new Set<string>();
  // The newest segment is the SDK's chain: what the model sees now.
  const newest: ClaudeTranscriptEntry[] = [];
  for (let entry = byUuid.get(tip.uuid); entry && !onChain.has(entry.uuid); entry = parentOf(entry, byUuid)) {
    onChain.add(entry.uuid);
    newest.push(entry);
  }
  const segments = [newest.reverse()];
  for (let boundary = resumableOnly ? undefined : newest[0]; boundary && isCompactBoundary(boundary);) {
    const previousTip = continued(activeTip(entries, lastIndex, lastIndex.get(boundary.uuid)!));
    if (!previousTip) break;
    await yieldToEventLoop();
    const segment = summarizedSegment(previousTip, byUuid, written, onChain);
    if (segment.length === 0) break;
    segments.push(segment);
    boundary = segment[0];
  }
  const chain = segments.reverse().flat();
  await yieldToEventLoop();
  return reinsertParallelFragments(byUuid, chain, onChain);
}

/**
 * The conversation before a compact boundary, walked back from the last row
 * written before it. Rows a newer segment already holds are skipped: a
 * preserved row appears where the model sees it, after that compaction's
 * summary. A parent relinked into a newer segment is replaced by the parent
 * Claude Code wrote, so the walk stays in the summarized conversation.
 */
function summarizedSegment(
  tip: ClaudeTranscriptEntry,
  byUuid: ReadonlyMap<string, ClaudeTranscriptEntry>,
  written: ReadonlyMap<string, ClaudeTranscriptEntry>,
  onChain: Set<string>,
): ClaudeTranscriptEntry[] {
  const newer = new Set(onChain);
  const visited = new Set<string>();
  const segment: ClaudeTranscriptEntry[] = [];
  for (let entry = byUuid.get(tip.uuid); entry && !visited.has(entry.uuid);) {
    visited.add(entry.uuid);
    if (!newer.has(entry.uuid)) {
      onChain.add(entry.uuid);
      segment.push(entry);
    }
    const parent = parentOf(entry, byUuid);
    entry = parent && !newer.has(parent.uuid) ? parent : parentOf(written.get(entry.uuid) ?? entry, byUuid);
  }
  return segment.reverse();
}

function isCompactBoundary(entry: ClaudeTranscriptEntry): boolean {
  return entry.type === "system" && entry.subtype === "compact_boundary" && !entry.parentUuid;
}

/**
 * The last main-conversation user or assistant row written before `end`,
 * including meta rows. Claude Code appends each row of the active
 * conversation as a child of the row it last wrote.
 */
function activeTip(
  entries: readonly ClaudeTranscriptEntry[],
  lastIndex: ReadonlyMap<string, number>,
  end: number,
): ClaudeTranscriptEntry | undefined {
  for (let index = end - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (lastIndex.get(entry.uuid) !== index) continue;
    if ((entry.type === "user" || entry.type === "assistant") && !entry.isSidechain && !entry.teamName) return entry;
  }
  return undefined;
}

function parentOf(
  entry: ClaudeTranscriptEntry,
  byUuid: ReadonlyMap<string, ClaudeTranscriptEntry>,
): ClaudeTranscriptEntry | undefined {
  return typeof entry.parentUuid === "string" && entry.parentUuid ? byUuid.get(entry.parentUuid) : undefined;
}

/**
 * Applies the SDK's compact-boundary relinking of preserved rows: they follow
 * the summary, as the model sees them. The boundary keeps its null parent.
 * Returns each relinked anchor with the preserved tail that now follows it.
 */
async function relinkPreservedCompaction(byUuid: Map<string, ClaudeTranscriptEntry>): Promise<Map<string, string>> {
  const tails = new Map<string, string>();
  let visited = 0;
  for (const boundary of byUuid.values()) {
    if (boundary.type !== "system" || boundary.subtype !== "compact_boundary") continue;
    const metadata = boundary.compactMetadata;
    const preserved = property(metadata, "preservedMessages");
    const segment = property(metadata, "preservedSegment");
    if (preserved) {
      const uuids = property(preserved, "uuids");
      // The SDK rejects the whole read on this malformed shape.
      if (!Array.isArray(uuids)) throw new Error("claude_transcript_compaction_invalid");
      if (uuids.length === 0 || uuids.some((uuid) => !byUuid.has(uuid as string))) continue;
      const anchorUuid = property(preserved, "anchorUuid");
      let parentUuid = anchorUuid;
      for (const uuid of uuids as string[]) {
        byUuid.set(uuid, { ...byUuid.get(uuid)!, parentUuid });
        parentUuid = uuid;
      }
      const head = uuids[0];
      const tail = uuids.at(-1);
      for (const [uuid, entry] of byUuid) {
        if (++visited % RELINK_YIELD_ENTRIES === 0) await yieldToEventLoop();
        if (entry.parentUuid === anchorUuid && uuid !== head) byUuid.set(uuid, { ...entry, parentUuid: tail });
      }
      if (typeof anchorUuid === "string") tails.set(anchorUuid, tail as string);
    } else if (segment) {
      const headUuid = property(segment, "headUuid");
      const anchorUuid = property(segment, "anchorUuid");
      const tailUuid = property(segment, "tailUuid");
      const head = byUuid.get(headUuid as string);
      if (head) byUuid.set(head.uuid, { ...head, parentUuid: anchorUuid });
      for (const [uuid, entry] of byUuid) {
        if (++visited % RELINK_YIELD_ENTRIES === 0) await yieldToEventLoop();
        if (entry.parentUuid === anchorUuid && uuid !== headUuid) {
          byUuid.set(uuid, { ...entry, parentUuid: tailUuid });
        }
      }
      if (head && typeof anchorUuid === "string" && typeof tailUuid === "string" && byUuid.has(tailUuid)) {
        tails.set(anchorUuid, tailUuid);
      }
    }
  }
  return tails;
}

/**
 * Claude Code stores each assistant content block as its own row, and parallel
 * tool results hang off different blocks. Rows of an on-chain assistant
 * message that are off the chain are re-inserted after that message, followed
 * by their tool results, each group in timestamp order.
 */
function reinsertParallelFragments(
  byUuid: ReadonlyMap<string, ClaudeTranscriptEntry>,
  chain: readonly ClaudeTranscriptEntry[],
  onChain: Set<string>,
): ClaudeTranscriptEntry[] {
  const assistants = chain.filter(({ type }) => type === "assistant");
  if (assistants.length === 0) return [...chain];
  const lastOnChainByMessageId = new Map<string, ClaudeTranscriptEntry>();
  for (const entry of assistants) {
    const messageId = assistantMessageId(entry);
    if (messageId) lastOnChainByMessageId.set(messageId, entry);
  }
  const fragmentsByMessageId = new Map<string, ClaudeTranscriptEntry[]>();
  const toolResultsByParent = new Map<string, ClaudeTranscriptEntry[]>();
  for (const entry of byUuid.values()) {
    const messageId = assistantMessageId(entry);
    if (messageId) {
      const fragments = fragmentsByMessageId.get(messageId);
      if (fragments) fragments.push(entry);
      else fragmentsByMessageId.set(messageId, [entry]);
    } else if (isToolResult(entry)) {
      const parentUuid = entry.parentUuid as string;
      const results = toolResultsByParent.get(parentUuid);
      if (results) results.push(entry);
      else toolResultsByParent.set(parentUuid, [entry]);
    }
  }
  const seen = new Set<string>();
  const insertedAfter = new Map<string, ClaudeTranscriptEntry[]>();
  let inserted = 0;
  for (const entry of assistants) {
    const messageId = assistantMessageId(entry);
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    const fragments = fragmentsByMessageId.get(messageId) ?? [entry];
    const offChainFragments = fragments.filter(({ uuid }) => !onChain.has(uuid));
    const offChainResults: ClaudeTranscriptEntry[] = [];
    for (const fragment of fragments) {
      for (const result of toolResultsByParent.get(fragment.uuid) ?? []) {
        if (!onChain.has(result.uuid)) offChainResults.push(result);
      }
    }
    if (offChainFragments.length === 0 && offChainResults.length === 0) continue;
    offChainFragments.sort(byTimestamp);
    offChainResults.sort(byTimestamp);
    const group = [...offChainFragments, ...offChainResults];
    for (const member of group) onChain.add(member.uuid);
    inserted += group.length;
    insertedAfter.set(lastOnChainByMessageId.get(messageId)!.uuid, group);
  }
  if (inserted === 0) return [...chain];
  return chain.flatMap((entry) => [entry, ...(insertedAfter.get(entry.uuid) ?? [])]);
}

/** Marks rows whose next prompt-or-reply row, later in the chain, is a reply. */
function replyFollows(chain: readonly ClaudeTranscriptEntry[]): boolean[] {
  const replies: boolean[] = [];
  let next: "reply" | "prompt" | undefined;
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index]!;
    replies[index] = next === "reply";
    if (entry.type === "assistant" || isToolResult(entry) || isInterruptionMarker(entry)) next = "reply";
    else if (entry.type === "user" && !entry.isMeta && !entry.isCompactSummary) next = "prompt";
  }
  return replies;
}

/** An answered human queued-command attachment reads as the prompt it carried. */
function convertQueuedCommand(
  entry: ClaudeTranscriptEntry,
  answered: boolean,
  chainUuids: Set<string>,
): ClaudeTranscriptEntry {
  if (!answered || entry.type !== "attachment") return entry;
  const attachment = record(entry.attachment);
  if (!attachment) return entry;
  const prompt = attachment.prompt;
  const origin = typeof attachment.origin === "object" && attachment.origin !== null ? attachment.origin : undefined;
  const originKind = property(origin, "kind");
  if (
    attachment.type !== "queued_command" ||
    attachment.commandMode !== "prompt" ||
    Boolean(attachment.isMeta) ||
    !(origin === undefined || originKind === "human" || originKind === "auto-continuation") ||
    (typeof prompt !== "string" && !Array.isArray(prompt)) ||
    isForwardedIntent(attachment.forwardedIntent)
  ) {
    return entry;
  }
  const uuid = typeof attachment.source_uuid === "string" && attachment.source_uuid ? attachment.source_uuid : entry.uuid;
  if (uuid !== entry.uuid && chainUuids.has(uuid)) return entry;
  chainUuids.add(uuid);
  return {
    type: "user",
    uuid,
    parentUuid: entry.parentUuid,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    message: { role: "user", content: prompt },
    isMeta: false,
    ...(origin !== undefined ? { origin } : {}),
    isSidechain: entry.isSidechain,
    teamName: entry.teamName,
  };
}

function isVisible(entry: ClaudeTranscriptEntry, includeSystemMessages: boolean): boolean {
  if (entry.type !== "user" && entry.type !== "assistant" && !(entry.type === "system" && includeSystemMessages)) return false;
  return !entry.isMeta && !entry.isSidechain && !entry.teamName;
}

function toSessionMessage(entry: ClaudeTranscriptEntry): SessionMessage {
  const origin = entry.origin !== undefined && entry.origin !== null ? sessionOrigin(entry.origin) : undefined;
  return {
    type: entry.type as SessionMessage["type"],
    uuid: entry.uuid,
    session_id: entry.sessionId as string,
    message: entry.message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...(entry.interruptedByShutdown === true ? { interruptedByShutdown: true } : {}),
    ...(entry.isCompactSummary === true ? { isCompactSummary: true } : {}),
    ...(entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true
      ? { is_meta: true }
      : {}),
    timestamp: entry.timestamp as string,
    ...(origin ? { origin } : {}),
  } as SessionMessage;
}

/** Task notifications expose only their kind and subkind, like the SDK. */
function sessionOrigin(origin: unknown): unknown {
  const value = record(origin);
  if (value?.kind !== "task-notification") return origin;
  return { kind: "task-notification", ...(value.subkind !== undefined ? { subkind: value.subkind } : {}) };
}

function page(messages: SessionMessage[], options: ClaudeTranscriptReadOptions): SessionMessage[] {
  const offset = options.offset ?? 0;
  if (options.limit !== undefined && options.limit > 0) return messages.slice(offset, offset + options.limit);
  return offset > 0 ? messages.slice(offset) : messages;
}

function assistantMessageId(entry: ClaudeTranscriptEntry): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const id = record(entry.message)?.id;
  return typeof id === "string" ? id : undefined;
}

function isToolResult(entry: ClaudeTranscriptEntry): boolean {
  if (entry.type !== "user" || !entry.parentUuid) return false;
  const content = record(entry.message)?.content;
  return Array.isArray(content) && content.some((block) => record(block)?.type === "tool_result");
}

function isInterruptionMarker(entry: ClaudeTranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const content = record(entry.message)?.content;
  if (typeof content === "string") return startsWithMarker(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => {
    const value = record(block);
    const text = value?.type === "text" ? value.text : value?.type === "tool_result" && value.is_error === true ? value.content : undefined;
    return typeof text === "string" && startsWithMarker(text);
  });
}

function startsWithMarker(text: string): boolean {
  return INTERRUPTION_MARKERS.some((marker) => text.startsWith(marker));
}

/** A forwarded queued command belongs to another session's lineage. */
function isForwardedIntent(value: unknown): boolean {
  const intent = record(value);
  return typeof intent?.lineage === "string" && intent.lineage.length > 0;
}

function byTimestamp(left: ClaudeTranscriptEntry, right: ClaudeTranscriptEntry): number {
  return String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
}

function projectDirectoryName(workspace: string): string {
  const sanitized = workspace.replace(/[^a-zA-Z0-9]/gu, "-");
  if (sanitized.length <= PROJECT_DIRECTORY_NAME_LIMIT) return sanitized;
  let hash = 0;
  for (let index = 0; index < workspace.length; index++) hash = ((hash << 5) - hash + workspace.charCodeAt(index)) | 0;
  return `${sanitized.slice(0, PROJECT_DIRECTORY_NAME_LIMIT)}-${Math.abs(hash).toString(36)}`;
}

function validProjectDirectoryOverride(value: string | undefined): string | undefined {
  return value && PROJECT_DIRECTORY_OVERRIDE.test(value) && !RESERVED_PROJECT_DIRECTORY.test(value) ? value : undefined;
}

function isTranscriptEntry(value: unknown): value is ClaudeTranscriptEntry {
  const entry = record(value);
  return entry !== undefined && typeof entry.type === "string" && TRANSCRIPT_ENTRY_TYPES.has(entry.type) &&
    typeof entry.uuid === "string";
}

/** Property access with JavaScript's semantics for any non-null value. */
function property(value: unknown, key: string): unknown {
  return value === undefined || value === null ? undefined : (value as Record<string, unknown>)[key];
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
