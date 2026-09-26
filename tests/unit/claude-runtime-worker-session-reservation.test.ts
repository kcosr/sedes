import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeChildProcessSupervisor } from "../../src/server/backends/claude/worker/claude-child-process-supervisor.js";
import {
  ClaudeRuntimeWorkerHost,
  type ClaudeRuntimeWorkerProtocolPeer,
} from "../../src/server/backends/claude/worker/claude-runtime-worker-host.js";
import { TrackedClaudeSdkFacade } from "../../src/server/backends/claude/worker/tracked-claude-sdk-facade.js";
import { readProcessEntrySync } from "../../src/server/runtime/process-table.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const context = () => ({ requestId: randomUUID(), signal: new AbortController().signal });

/**
 * Answers the release and auth probes like Claude Code. As a session process
 * it reports its PID and, like a CLI flushing its transcript, exits only
 * 1 s after SIGTERM or stdin EOF.
 */
const FAKE_CLAUDE = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("2.1.274 (Claude Code)\\n"); process.exit(0); }
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "Claude Max" }));
  process.exit(0);
}
let exiting = false;
const exitSoon = () => { if (!exiting) { exiting = true; setTimeout(() => process.exit(0), 1_000); } };
process.on("SIGTERM", exitSoon);
process.stdin.on("end", exitSoon);
process.stdin.resume();
process.stdout.write(String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`;

interface Launch {
  readonly pid: Promise<number>;
  /** PIDs of earlier session processes still alive when this one launched. */
  readonly livePredecessors: readonly number[];
  readonly fail: (error: Error) => void;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const describeWithProcessTable =
  process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describeWithProcessTable("Claude runtime worker native session reservation", () => {
  it("keeps a closed query's session reserved until its Claude process has exited", async () => {
    const fixture = await processFixture();
    await fixture.open("33333333-3333-4333-8333-333333333333", "new");
    const first = await fixture.launches[0]!.pid;

    await fixture.host.handlers.closeQuery({ queryId: "33333333-3333-4333-8333-333333333333" }, context());
    // closeQuery is the caller's release point; the old writer must be gone.
    expect(processAlive(first)).toBe(false);

    await fixture.open("44444444-4444-4444-8444-444444444444", "resume");
    expect(fixture.launches[1]!.livePredecessors).toEqual([]);
    await fixture.host.handlers.closeQuery({ queryId: "44444444-4444-4444-8444-444444444444" }, context());
  }, 20_000);

  it("reopens a failed query's session only after its Claude process has exited", async () => {
    const fixture = await processFixture();
    await fixture.open("33333333-3333-4333-8333-333333333333", "new");
    const first = await fixture.launches[0]!.pid;

    fixture.launches[0]!.fail(new Error("provider_stream_failed"));
    await vi.waitFor(() => expect(fixture.peer.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "query.failed" }),
    ));
    expect(fixture.host.activeQueryCount).toBe(0);
    expect(processAlive(first)).toBe(true);

    await fixture.open("44444444-4444-4444-8444-444444444444", "resume");
    expect(fixture.launches[1]!.livePredecessors).toEqual([]);
    expect(processAlive(first)).toBe(false);
    await fixture.host.handlers.closeQuery({ queryId: "44444444-4444-4444-8444-444444444444" }, context());
  }, 20_000);
});

describe("Claude runtime worker session reservation contract", () => {
  it("waits for process retirement, honours caller aborts, and keeps unproven sessions reserved", async () => {
    const scopes: Array<{ settle: (error?: Error) => void }> = [];
    const fixture = await fakeFixture(() => {
      let settle!: (error?: Error) => void;
      const settled = new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      });
      settled.catch(() => undefined);
      scopes.push({ settle });
      return { settled: () => settled };
    });
    await fixture.open("33333333-3333-4333-8333-333333333333");
    let closed = false;
    const closing = Promise.resolve(fixture.host.handlers
      .closeQuery({ queryId: "33333333-3333-4333-8333-333333333333" }, context()))
      .then(() => { closed = true; });
    await vi.waitFor(() => expect(fixture.queryClosed).toHaveBeenCalledOnce());
    expect(fixture.host.activeQueryCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    const abandoned = new AbortController();
    const cancelledOpen = fixture.open("44444444-4444-4444-8444-444444444444", abandoned.signal);
    const waitingOpen = fixture.open("55555555-5555-4555-8555-555555555555");
    abandoned.abort(new Error("caller_cancelled"));
    await expect(cancelledOpen).rejects.toThrow("caller_cancelled");
    expect(fixture.sdk.createQuery).toHaveBeenCalledTimes(1);

    scopes[0]!.settle();
    await closing;
    await waitingOpen;
    expect(fixture.sdk.createQuery).toHaveBeenCalledTimes(2);

    const failedClose = Promise.resolve(fixture.host.handlers.closeQuery(
      { queryId: "55555555-5555-4555-8555-555555555555" }, context(),
    ));
    await vi.waitFor(() => expect(fixture.queryClosed).toHaveBeenCalledTimes(2));
    scopes[1]!.settle(new Error("claude_worker_child_cleanup_unproven"));
    await expect(failedClose).rejects.toThrow("claude_worker_child_cleanup_unproven");
    await expect(fixture.open("66666666-6666-4666-8666-666666666666")).rejects.toThrow(
      "claude_runtime_session_cleanup_unproven",
    );
    expect(fixture.sdk.createQuery).toHaveBeenCalledTimes(2);
  });
});

async function processFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-claude-reservation-"));
  const configDirectory = path.join(root, "config");
  await mkdir(configDirectory, { mode: 0o700 });
  const executablePath = path.join(root, "claude");
  await writeFile(executablePath, FAKE_CLAUDE, { mode: 0o700 });
  const supervisor = new ClaudeChildProcessSupervisor({
    gracefulCloseMilliseconds: 100,
    terminateMilliseconds: 100,
    killMilliseconds: 500,
    processGroupRegistrar: { register: async () => undefined, unregister: () => undefined, close: () => undefined },
  });
  const launches: Launch[] = [];
  const pids: number[] = [];
  const delegate = queryDelegate((input) => {
    const livePredecessors = pids.filter(processAlive);
    const spawned = input.options.spawnClaudeCodeProcess!({
      command: input.options.pathToClaudeCodeExecutable!,
      args: [],
      env: {},
      signal: input.options.abortController!.signal,
    });
    const pid = firstLine(spawned.stdout).then((line) => {
      const value = Number(line);
      pids.push(value);
      return value;
    });
    return { spawned, pid, livePredecessors };
  }, (launch) => launches.push(launch));
  const sdk = new TrackedClaudeSdkFacade({ delegate, supervisor });
  const peer = inertPeer();
  const host = new ClaudeRuntimeWorkerHost({
    sdk,
    peer,
    queryProcessScope: () => sdk.createQueryScope(),
  });
  cleanups.push(async () => {
    await host.close();
    await supervisor.close().catch(() => undefined);
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  await host.handlers.initialize({
    executablePath: await realpath(executablePath),
    configDirectory: await realpath(configDirectory),
    initializationTimeoutMs: 10_000,
  }, context());
  return {
    host,
    peer,
    launches,
    open: async (queryId: string, launch: "new" | "resume") =>
      await host.handlers.openQuery({
        queryId, sessionId: SESSION_ID, cwd: root, launch, enableCanUseTool: false, environment: {},
      }, context()),
  };
}

async function fakeFixture(scope: () => { settled: () => Promise<void> }) {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-claude-reservation-"));
  const configDirectory = path.join(root, "config");
  await mkdir(configDirectory, { mode: 0o700 });
  const queryClosed = vi.fn();
  const sdk = queryDelegate(() => undefined, () => undefined, queryClosed);
  const host = new ClaudeRuntimeWorkerHost({
    sdk,
    peer: inertPeer(),
    queryProcessScope: () => ({ sdk, ...scope() }),
  });
  cleanups.push(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.handlers.initialize({
    executablePath: process.execPath,
    configDirectory: await realpath(configDirectory),
    initializationTimeoutMs: 1_000,
  }, context());
  return {
    host,
    sdk,
    queryClosed,
    open: async (queryId: string, signal = new AbortController().signal) =>
      await host.handlers.openQuery({
        queryId, sessionId: SESSION_ID, cwd: root, launch: "new", enableCanUseTool: false, environment: {},
      }, { requestId: randomUUID(), signal }),
  };
}

function queryDelegate(
  launch: (input: { readonly options: Options }) => {
    readonly spawned: { readonly stdin: NodeJS.WritableStream };
    readonly pid: Promise<number>;
    readonly livePredecessors: readonly number[];
  } | undefined,
  record: (launch: Launch) => void,
  closed: () => void = () => undefined,
): ClaudeSdkFacade & { createQuery: ReturnType<typeof vi.fn> } {
  return {
    readCliRelease: vi.fn(async () => "2.1.274"),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "Claude Max",
    })),
    createQuery: vi.fn((input: { readonly options: Options }) => {
      const launched = launch(input);
      let finish!: (error?: Error) => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      });
      finished.catch(() => undefined);
      record({
        pid: launched?.pid ?? Promise.resolve(0),
        livePredecessors: launched?.livePredecessors ?? [],
        fail: (error) => finish(error),
      });
      const sessionId = typeof input.options.sessionId === "string"
        ? input.options.sessionId
        : String(input.options.resume);
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: "system", subtype: "init", apiKeySource: "oauth", claude_code_version: "2.1.274",
          cwd: "/workspace", tools: [], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "default",
          slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: randomUUID(), session_id: sessionId,
        } as SDKMessage;
        await finished;
      })();
      return Object.assign(stream, {
        initializationResult: async (): Promise<SDKControlInitializeResponse> => ({
          commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [],
          account: { apiProvider: "firstParty", subscriptionType: "Claude Max" },
        }),
        interrupt: async () => ({ still_queued: [] }),
        setModel: async () => undefined,
        setPermissionMode: async () => undefined,
        applyFlagSettings: async () => undefined,
        // Like the SDK: end stdin and stop reading without waiting for exit.
        close: () => {
          closed();
          launched?.spawned.stdin.end();
          finish();
        },
      }) as unknown as Query;
    }),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    renameSession: vi.fn(async () => undefined),
  };
}

function inertPeer(): ClaudeRuntimeWorkerProtocolPeer & { sendEvent: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async () => {
      throw new Error("unused");
    }) as ClaudeRuntimeWorkerProtocolPeer["call"],
    sendEvent: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function processAlive(pid: number): boolean {
  const entry = readProcessEntrySync(pid);
  return entry !== undefined && !entry.exited;
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffered = "";
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolve(buffered.slice(0, newline));
    });
    stream.once("error", reject);
  });
}
