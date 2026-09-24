import { randomUUID } from "node:crypto";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarOperationError } from "../../src/internal/sidecar-protocol/operation-registry.js";
import {
  ClaudeHistoryPager, readClaudeSessionHistory, iterateClaudeSessionHistory,
  CLAUDE_HISTORY_SNAPSHOT_IDLE_MS, CLAUDE_HISTORY_LOAD_TIMEOUT_MS,
  CLAUDE_HISTORY_MAXIMUM_SNAPSHOTS,
  type ClaudeHistoryPageOptions,
} from "../../src/server/backends/claude/claude-session-history.js";

const sessionId = randomUUID();
function message(text: string): SessionMessage {
  return { type: "user", uuid: randomUUID(), session_id: sessionId,
    parent_tool_use_id: null, parent_agent_id: null,
    message: { role: "user", content: text } };
}
function fixture(history = Array.from({ length: 600 }, (_, index) => message(String(index).padEnd(8_192, "x")))) {
  const pager = new ClaudeHistoryPager();
  const load = vi.fn(async () => structuredClone(history));
  const read = (options: ClaudeHistoryPageOptions) => pager.getPage(sessionId, options, load);
  return { pager, history, load, read };
}
afterEach(() => vi.useRealTimers());

describe("bounded Claude history transfer", () => {
  it("transfers history above 32 MiB from one native read", async () => {
    const { history, load, read } = fixture([message("a".repeat(18 * 1024 * 1024)), message("b".repeat(18 * 1024 * 1024))]);
    const readPage = vi.fn(read);
    const result = await readClaudeSessionHistory(readPage, {});
    expect(result.map(entry => entry.uuid)).toEqual(history.map(entry => entry.uuid));
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce();
    expect((result[1]!.message as { content: string }).content.length).toBe(18 * 1024 * 1024);
  });

  it.each(["append", "rewrite", "truncate"])("finishes one immutable snapshot across provider %s; new acquisition sees changes", async change => {
    const { history, load, read } = fixture();
    const expected = structuredClone(history);
    let changed = false;
    const result = await readClaudeSessionHistory(async options => {
      if (options.cursor && !changed) {
        changed = true;
        if (change === "append") history.push(message("new"));
        if (change === "rewrite") (history[25]!.message as { content: string }).content = "revised";
        if (change === "truncate") history.splice(20);
      }
      return read(options);
    }, {});
    expect(result).toEqual(expected);
    expect(load).toHaveBeenCalledOnce();
    expect(await readClaudeSessionHistory(read, {})).toEqual(history);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("expires abandoned acquisitions and restarts fully without mixing snapshots", async () => {
    vi.useFakeTimers();
    const { history, load, read } = fixture();
    let expired = false;
    const result = await readClaudeSessionHistory(async options => {
      if (options.cursor && !expired) {
        expired = true;
        (history[25]!.message as { content: string }).content = "replacement";
        await vi.advanceTimersByTimeAsync(CLAUDE_HISTORY_SNAPSHOT_IDLE_MS);
      }
      return read(options);
    }, {});
    expect(result).toEqual(history);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds retries on repeated expiry and does not retry unrelated errors", async () => {
    vi.useFakeTimers();
    const { load, read } = fixture();
    await expect(readClaudeSessionHistory(async options => {
      if (options.cursor) await vi.advanceTimersByTimeAsync(CLAUDE_HISTORY_SNAPSHOT_IDLE_MS);
      return read(options);
    }, {})).rejects.toMatchObject({ code: "claude_runtime_history_snapshot_expired" });
    expect(load).toHaveBeenCalledTimes(3);
    const failure = vi.fn(async () => { throw new SidecarOperationError("claude_runtime_history_response_too_large"); });
    await expect(readClaudeSessionHistory(failure, {})).rejects.toThrow("claude_runtime_history_response_too_large");
    expect(failure).toHaveBeenCalledOnce();
  });

  it("binds continuation to its acquisition, session and read options without releasing another reader", async () => {
    const { pager, load, read } = fixture();
    const first = await read({});
    const continuation = { cursor: first.nextCursor! };
    await expect(pager.getPage("other-session", continuation, load)).rejects.toThrow("snapshot_invalid");
    await expect(read({ ...continuation, includeSystemMessages: true })).rejects.toThrow("snapshot_invalid");
    await expect(read({ ...continuation, maintenance: true })).rejects.toThrow("snapshot_invalid");
    await expect(read({ cursor: { ...continuation.cursor, offset: 1 } })).rejects.toThrow("snapshot_invalid");
    expect((await read(continuation)).nextCursor).toBeNull();
    await expect(read(continuation)).rejects.toThrow("snapshot_expired");
    expect(load).toHaveBeenCalledOnce();
  });

  it("allows page roundtrips over two seconds and progressing transfers over sixty seconds", async () => {
    vi.useFakeTimers();
    const { history, load, read } = fixture(Array.from({ length: 8 }, () => message("x".repeat(2 * 1024 * 1024))));
    const result = await readClaudeSessionHistory(async options => {
      if (options.cursor) await vi.advanceTimersByTimeAsync(10_000);
      return read(options);
    }, {});
    expect(result).toEqual(history);
    expect(load).toHaveBeenCalledOnce();
  });

  it("serves independent readers while another native load takes more than three seconds", async () => {
    vi.useFakeTimers();
    const { pager, read } = fixture();
    let complete!: (messages: SessionMessage[]) => void;
    const slow = pager.getPage("slow-session", {}, () => new Promise(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await read({ limit: 1 })).messages).toHaveLength(1);
    complete([message("slow result")]);
    expect((await slow).messages).toHaveLength(1);
    pager.close();
  });

  it("keeps interleaved acquisitions independent even for the same session", async () => {
    const { history, read, load } = fixture();
    const first = await read({});
    const second = await read({});
    expect(first.nextCursor!.snapshotId).not.toBe(second.nextCursor!.snapshotId);
    expect([...first.messages, ...(await read({ cursor: first.nextCursor! })).messages]).toEqual(history);
    expect([...second.messages, ...(await read({ cursor: second.nextCursor! })).messages]).toEqual(history);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts least recently used snapshots only when the global count limit is reached", async () => {
    const pager = new ClaudeHistoryPager();
    const history = Array.from({ length: 8_193 }, () => message("small"));
    const first = await pager.getPage("first", {}, async () => history);
    for (let index = 1; index < CLAUDE_HISTORY_MAXIMUM_SNAPSHOTS; index++) {
      await pager.getPage(String(index), {}, async () => history);
    }
    // One-page reads do not retain a snapshot or evict an unfinished reader.
    await pager.getPage("one-page", {}, async () => [message("small")]);
    const survivor = await pager.getPage("new", {}, async () => history);
    await expect(pager.getPage("first", { cursor: first.nextCursor! }, async () => history)).rejects.toThrow("snapshot_expired");
    expect((await pager.getPage("new", { cursor: survivor.nextCursor! }, async () => history)).nextCursor).toBeNull();
    pager.close();
  });

  it("preserves a foreground snapshot when maintenance would exceed the shared byte budget", async () => {
    const pager = new ClaudeHistoryPager();
    const text = "x".repeat(31 * 1024 * 1024);
    const history = Array.from({ length: 8 }, () => message(text));
    const first = await pager.getPage("large", {}, async () => history);
    const otherHistory = [message("y".repeat(5 * 1024 * 1024)), message("z".repeat(5 * 1024 * 1024))];
    await expect(pager.getPage("other", { maintenance: true }, async () => otherHistory))
      .rejects.toMatchObject({ code: "claude_runtime_history_snapshot_busy", retryable: true });
    const continued = await pager.getPage("large", { cursor: first.nextCursor! }, async () => []);
    expect(continued.messages[0]!.uuid).toBe(history[1]!.uuid);
    // Foreground acquisition retains its explicit LRU admission policy.
    await pager.getPage("other", {}, async () => otherHistory);
    await expect(pager.getPage("large", { cursor: continued.nextCursor! }, async () => [])).rejects.toThrow("snapshot_expired");
    pager.close();
  });

  it("times out native loads without installing late snapshots or admitting unlimited hung reads", async () => {
    vi.useFakeTimers();
    const pager = new ClaudeHistoryPager();
    const completions: ((messages: SessionMessage[]) => void)[] = [];
    const pending = Array.from({ length: 32 }, (_, index) => pager.getPage(String(index), {}, () => new Promise(resolve => {
      completions.push(resolve);
    })));
    const rejected = pending.map(promise => expect(promise).rejects.toThrow("snapshot_load_timeout"));
    await vi.advanceTimersByTimeAsync(CLAUDE_HISTORY_LOAD_TIMEOUT_MS);
    await Promise.all(rejected);
    const load = vi.fn(async () => [message("new")]);
    await expect(pager.getPage("new", {}, load)).rejects.toThrow("snapshot_busy");
    expect(load).not.toHaveBeenCalled();
    completions[0]!([message("late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await pager.getPage("new", {}, load)).messages[0]!.message).toEqual({ role: "user", content: "new" });
    expect(load).toHaveBeenCalledOnce();
    pager.close();
    for (const complete of completions.slice(1)) complete([]);
  });

  it("closes captured acquisitions and rejects pending loads without invoking a just-disposed loader", async () => {
    const { pager, load, read } = fixture();
    const first = await read({});
    const pending = read({ limit: 1 });
    const rejected = expect(pending).rejects.toThrow("snapshot_closed");
    pager.close();
    await rejected;
    await expect(read({ cursor: first.nextCursor! })).rejects.toThrow("snapshot_closed");
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps offset/limit selection and releases on invalid oversized message", async () => {
    const { history, read } = fixture();
    expect(await readClaudeSessionHistory(read, { offset: 4, limit: 520 })).toEqual(history.slice(4, 524));
    const pager = new ClaudeHistoryPager();
    await expect(pager.getPage(sessionId, {}, async () => [message("x".repeat(32 * 1024 * 1024))]))
      .rejects.toThrow("claude_runtime_history_response_too_large");
    expect((await pager.getPage(sessionId, {}, async () => [message("small")])).messages).toHaveLength(1);
  });

  it("validates streamed page continuity before yielding malformed pages", async () => {
    const initial = { messages: [message("first")], nextCursor: { snapshotId: randomUUID(), offset: 1, end: 3 } };
    for (const second of [
      { messages: [], nextCursor: initial.nextCursor },
      { messages: [message("second")], nextCursor: { ...initial.nextCursor, offset: 1 } },
      { messages: [message("second")], nextCursor: { ...initial.nextCursor, snapshotId: randomUUID(), offset: 2 } },
      { messages: [message("second")], nextCursor: null },
    ]) {
      const read = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(second);
      const iterator = iterateClaudeSessionHistory(read, {});
      expect((await iterator.next()).value).toEqual(initial);
      await expect(iterator.next()).rejects.toThrow("claude_runtime_history_page_invalid");
    }
  });
});
