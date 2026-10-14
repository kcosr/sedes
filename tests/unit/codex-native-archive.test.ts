import { describe, expect, it } from "vitest";
import { isCodexNativeArchiveThreadMissing, isCodexThreadArchived, readCodexNativeArchiveSyncEnabled } from "../../src/server/backends/codex/codex-native-archive.js";
import { CodexRpcRemoteError } from "../../src/server/backends/codex/rpc/errors.js";

describe("Codex native archive interpretation", () => {
  it.each([
    ["/home/user/.codex/archived_sessions/rollout.jsonl", true],
    ["C:\\Users\\user\\.codex\\archived_sessions\\rollout.jsonl", true],
    ["C:/Users/user/.codex/archived_sessions/rollout.jsonl", true],
    ["/home/archived_sessions/.codex/sessions/2026/10/rollout.jsonl", false],
    ["/home/user/.codex/sessions/2026/10/rollout.jsonl", false],
    ["/home/user/.codex/not_archived_sessions/rollout.jsonl", false],
    [null, false],
  ] as const)("classifies provider-owned rollout path %s", (path, archived) => {
    expect(isCodexThreadArchived({ path })).toBe(archived);
  });

  it("defaults on and requires an explicit installation boolean", () => {
    expect(readCodexNativeArchiveSyncEnabled({})).toBe(true);
    expect(readCodexNativeArchiveSyncEnabled({ SEDES_CODEX_ARCHIVE_SYNC: "true" })).toBe(true);
    expect(readCodexNativeArchiveSyncEnabled({ SEDES_CODEX_ARCHIVE_SYNC: "false" })).toBe(false);
    expect(() => readCodexNativeArchiveSyncEnabled({ SEDES_CODEX_ARCHIVE_SYNC: "off" })).toThrow("must be true or false");
  });

  it.each(["thread not loaded: thread", "thread not found: thread", "no rollout found for thread id thread"])(
    "recognizes only the exact released read absence: %s", message => {
      const error = (overrides = {}) => new CodexRpcRemoteError({ code: -32600, message, method: "thread/read", generation: 1, ...overrides });
      expect(isCodexNativeArchiveThreadMissing(error(), "thread")).toBe(true);
      expect(isCodexNativeArchiveThreadMissing(error(), "different")).toBe(false);
      expect(isCodexNativeArchiveThreadMissing(error({ method: "thread/archive" }), "thread")).toBe(false);
      expect(isCodexNativeArchiveThreadMissing(error({ code: -32603 }), "thread")).toBe(false);
    },
  );
});
