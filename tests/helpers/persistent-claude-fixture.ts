import { randomUUID } from "node:crypto";
import { ClaudeHistoryPager } from "../../src/server/backends/claude/claude-session-history.js";
import { vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeOwnedRuntimeClient,
  ClaudeOwnedRuntimeSession,
  ClaudeRuntimeClient,
  ClaudeRuntimeSession,
  ClaudeRuntimeSessionOptions,
} from "../../src/server/backends/claude/claude-runtime-client.js";
import type { ClaudeSdkSessionInitialization } from "../../src/server/backends/claude/claude-sdk-session.js";
import { runClaudeForkLaunch } from "../../src/server/backends/claude/claude-fork-launch.js";

export class FakePersistentClaudeSession implements ClaudeOwnedRuntimeSession {
  closed = false;
  readonly initialization: ClaudeSdkSessionInitialization = {
    models: [], commands: [], skillNames: [], terminalCommandNames: [], account: {},
    actualModel: "claude-sonnet-4-6", actualPermissionMode: "default", cliRelease: "2.1.283",
  };
  readonly startupProbeUuid = randomUUID();
  readonly safeSkills = [];
  readonly start = vi.fn(async () => this.initialization);
  readonly send = vi.fn<ClaudeRuntimeSession["send"]>();
  readonly interrupt = vi.fn(async () => undefined);
  readonly cancelQueuedInput = vi.fn<ClaudeOwnedRuntimeSession["cancelQueuedInput"]>(async () => false);
  readonly setModel = vi.fn(async () => undefined);
  readonly setEffort = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => { this.closed = true; this.#permissionAbort.abort(); });
  readonly #permissionAbort = new AbortController();
  constructor(readonly options: ClaudeRuntimeSessionOptions) {}
  async emit(message: SDKMessage): Promise<void> { await this.options.onMessage(message); }
  async askPermission(requestId = "permission-1", toolUseID = "tool-1") {
    if (!this.options.canUseTool) throw new Error("test_permission_callback_missing");
    const response = await this.options.canUseTool("Read", { file_path: "/workspace/example.txt" }, {
      requestId, toolUseID, signal: this.#permissionAbort.signal,
    });
    await this.options.onPermissionResponseDelivered?.({ requestId, toolUseID });
    return response;
  }
}

export function createFakePersistentClaudeRuntime() {
  const sessions: FakePersistentClaudeSession[] = [];
  const history = new ClaudeHistoryPager();
  const getSessionMessages = vi.fn<ClaudeRuntimeClient["getSessionMessages"]>(async () => []);
  const createSession = vi.fn((options: ClaudeRuntimeSessionOptions) => {
    const session = new FakePersistentClaudeSession(options);
    sessions.push(session);
    return session;
  });
  const runtime = {
    createSession,
    // The production one-shot launch over the fake sessions above.
    forkSession: vi.fn<ClaudeRuntimeClient["forkSession"]>(async (options) =>
      await runClaudeForkLaunch(createSession, options)),
    probe: vi.fn<ClaudeRuntimeClient["probe"]>(async () => ({
      cliRelease: "2.1.283", account: {}, models: [], commands: [], skillNames: [], terminalCommandNames: [],
    })),
    listSessions: vi.fn<ClaudeRuntimeClient["listSessions"]>(async () => []),
    getSessionInfo: vi.fn<ClaudeRuntimeClient["getSessionInfo"]>(async () => undefined),
    getSessionMessages,
    getSessionMessagesPage: vi.fn<ClaudeRuntimeClient["getSessionMessagesPage"]>(async (sessionId, options, environment) => {
      const { offset: _offset, limit: _limit, cursor: _cursor, maintenance: _maintenance, ...nativeOptions } = options;
      return history.getPage(sessionId, options, async () => structuredClone(await getSessionMessages(sessionId, nativeOptions, environment)));
    }),
    hasSessionTranscript: vi.fn<ClaudeRuntimeClient["hasSessionTranscript"]>(async () => false),
    renameSession: vi.fn<ClaudeRuntimeClient["renameSession"]>(async () => undefined),
    close: vi.fn(async () => { history.close(); await Promise.all(sessions.map(session => session.close())); }),
  } satisfies ClaudeOwnedRuntimeClient & { close(): Promise<void> };
  return { runtime, sessions };
}
