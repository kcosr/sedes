import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Query, SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { CLAUDE_AGENT_SDK_RELEASE, OfficialClaudeSdkFacade, type ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { assertClaudeSubscriptionAuthStatus, probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";

const MODEL = "claude-sonnet-5-5";
const EFFORT = "low";
const CLI_RELEASE = "2.1.287";

/** Native authentication remains real; only tools and user configuration are disabled. */
class BoundedLiveCompactionSdk extends OfficialClaudeSdkFacade {
  constructor(readonly onFrame: (message: SDKMessage) => void) { super(); }

  override async readCliAuthStatus(...args: Parameters<OfficialClaudeSdkFacade["readCliAuthStatus"]>) {
    const status = await super.readCliAuthStatus(...args);
    assertClaudeSubscriptionAuthStatus(status);
    return status;
  }

  override createQuery(input: ClaudeQueryInput): Query {
    if (input.options.persistSession !== false &&
        (input.options.model !== MODEL || input.options.effort !== EFFORT || input.options.permissionMode !== "dontAsk")) {
      throw new Error("REAL_CLAUDE_BLOCKER: Sonnet 5.5/low/dontAsk required");
    }
    const native = super.createQuery({ ...input, options: {
      ...input.options, tools: [], allowedTools: [], strictMcpConfig: true, mcpServers: {},
      plugins: [], settingSources: [], settings: { disableAllHooks: true }, maxTurns: 4, maxBudgetUsd: 0.25,
      canUseTool: async () => ({ behavior: "deny", message: "The live compaction qualification cannot use tools." }),
    } });
    const iterator = native[Symbol.asyncIterator].bind(native);
    const onFrame = this.onFrame;
    native[Symbol.asyncIterator] = async function* () {
      for await (const message of { [Symbol.asyncIterator]: iterator }) {
        if (message.type === "system" && message.subtype === "init") {
          expect(message.claude_code_version).toBe(CLI_RELEASE);
          expect(message.tools).toEqual([]);
          expect(message.mcp_servers).toEqual([]);
        }
        onFrame(message); yield message;
      }
    };
    return native;
  }
}

it.runIf(process.env.SEDES_REAL_CLAUDE === "1")("live manual compaction retains a disposable conversation through a following prompt and native resume", async () => {
  // Refuse redirected providers and API-key overrides before the no-prompt
  // subscription probe. No authentication gate is simulated by this test.
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (process.env[key]) throw new Error(`REAL_CLAUDE_BLOCKER: ${key} must be unset`);
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sedes-live-manual-compaction-")));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude";
  const configDirectory = process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ?? path.join(os.homedir(), ".claude");
  const environment = Object.freeze({ ...process.env, CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048" });
  const frames: SDKMessage[] = [];
  const failures: unknown[] = [];
  const waiters = new Set<{ readonly predicate: (message: SDKMessage) => boolean; readonly resolve: (message: SDKMessage) => void }>();
  const waitFrame = (predicate: (message: SDKMessage) => boolean, fromIndex = frames.length) => new Promise<SDKMessage>(resolve => {
    const existing = frames.slice(fromIndex).find(predicate);
    if (existing) resolve(existing);
    else waiters.add({ predicate, resolve });
  });
  const sdk = new BoundedLiveCompactionSdk(message => {
    frames.push(message);
    for (const waiter of waiters) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message); }
  });
  let session: ClaudeSdkSession | undefined;
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const abortController = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    abortController.abort();
    rejectDeadline(new Error("REAL_CLAUDE_FAILURE: bounded manual-compaction qualification deadline"));
    void session?.close();
  }, 180_000);
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  const idle = (message: SDKMessage) => message.session_id === sessionId && message.type === "system" &&
    message.subtype === "session_state_changed" && message.state === "idle";
  async function drainStartup(current: ClaudeSdkSession) {
    const receipt = await bounded(waitFrame(message => message.type === "result" &&
      claudeResultUserMessageIds(message).includes(current.startupProbeUuid!), 0));
    await bounded(waitFrame(idle, frames.indexOf(receipt) + 1));
  }
  const results: SDKResultSuccess[] = [];
  async function send(text: string): Promise<SDKResultSuccess> {
    const inputId = randomUUID();
    const receipt = waitFrame(message => message.type === "result" && claudeResultUserMessageIds(message).includes(inputId));
    const settled = waitFrame(idle);
    session!.send({ operationId: inputId, content: text });
    const result = await bounded(receipt);
    if (result.type !== "result" || result.subtype !== "success" || result.is_error) {
      throw new Error("REAL_CLAUDE_FAILURE: ordinary prompt did not return a successful native result");
    }
    expect(result.num_turns).toBe(1);
    await bounded(settled);
    results.push(result);
    return result;
  }
  const createSession = (launch: "new" | "resume") => new ClaudeSdkSession({ sdk, executablePath,
    initializationTimeoutMs: 30_000, sessionId, cwd, launch, model: MODEL, effort: EFFORT,
    permissionMode: "dontAsk", environment, title: "Disposable Sedes manual-compaction qualification",
    onMessage: () => {}, onFailure: error => { failures.push(error); },
  });
  try {
    expect(CLAUDE_AGENT_SDK_RELEASE).toBe("0.3.287");
    const preflight = await bounded(probeClaudeSdkDirect({ sdk, executablePath, cwd, environment,
      timeoutMs: 30_000, signal: abortController.signal }));
    expect(preflight.cliRelease).toBe(CLI_RELEASE);
    expect(preflight.account.apiProvider).toBe("firstParty");
    expect(preflight.account.subscriptionType).toBeTruthy();
    // The production catalog drops the moving default alias in favor of an
    // explicit native row. Require one Sonnet 5.5 row advertising low effort.
    const eligibleModels = preflight.models.filter(model => model.value !== "default" && (model.resolvedModel ?? model.value) === MODEL &&
      model.supportsEffort && model.supportedEffortLevels?.includes(EFFORT));
    if (eligibleModels.length !== 1) throw new Error(`REAL_CLAUDE_BLOCKER: exactly one ${MODEL}/${EFFORT} catalog entry required; available ${JSON.stringify(preflight.models.map(model => ({ id: model.resolvedModel ?? model.value, efforts: model.supportedEffortLevels ?? [] })))}`);
    session = createSession("new");
    await bounded(session.start()); await drainStartup(session);
    expect((await send("Remember these disposable test facts: archive color is violet and archive number is 17. Reply with exactly SEDES_COMPACT_SETUP_OK. Do not use tools.")).result)
      .toBe("SEDES_COMPACT_SETUP_OK");
    expect((await send("Keep those two test facts. Reply with exactly SEDES_COMPACT_READY. Do not use tools.")).result)
      .toBe("SEDES_COMPACT_READY");
    const compactStart = frames.length;
    const settled = waitFrame(idle);
    const compact = await bounded(session.compact({ operationId, instructions: "Preserve the two disposable test facts." }));
    await bounded(settled);
    expect(compact).toMatchObject({ outcome: "compacted", nativeResult: { subtype: "success", is_error: false,
      num_turns: 0, local_command: "compact", user_message_uuid: operationId } });
    expect(compact.nativeResult).not.toHaveProperty("result");
    expect(compact.nativeResult).not.toHaveProperty("permission_denials");
    expect(await session.reconcileCompact({ operationId, instructions: "Preserve the two disposable test facts." }))
      .toMatchObject({ outcome: "accepted", pending: false, nativeResult: compact.nativeResult });
    const commandFrames = frames.slice(compactStart);
    expect(commandFrames.map(claudeCommandLifecycle).filter(frame => frame?.commandUuid === operationId).map(frame => frame!.state))
      .toEqual(["queued", "started", "completed"]);
    const boundary = commandFrames.findIndex(message => message.type === "system" && message.subtype === "compact_boundary");
    expect(commandFrames[boundary]).toMatchObject({ compact_metadata: { trigger: "manual" } });
    expect(commandFrames[boundary + 1]).toMatchObject({ type: "user", isSynthetic: true, parent_tool_use_id: null });
    expect(JSON.stringify(commandFrames[boundary + 1])).toContain("violet");
    expect((await send("Using the two test facts, reply with exactly violet 17. Do not use tools.")).result).toBe("violet 17");
    const before = projectClaudeHistory(await readClaudeSessionMessages(sessionId, { dir: cwd }, environment)).snapshot;
    expect(before.orderedBackendTurnIds).toHaveLength(3);
    expect(Object.values(before.itemsById).filter(item => item.semanticKind === "compaction")).toHaveLength(1);
    await session.close();
    session = createSession("resume");
    await bounded(session.start()); await drainStartup(session);
    const after = projectClaudeHistory(await readClaudeSessionMessages(sessionId, { dir: cwd }, environment)).snapshot;
    expect(after.orderedBackendTurnIds).toEqual(before.orderedBackendTurnIds);
    expect(after.itemsById).toEqual(before.itemsById);
    expect(results).toHaveLength(3);
    expect(results.every(result => result.permission_denials.length === 0)).toBe(true);
    expect(failures).toEqual([]);
    console.info(`[real-claude] manual compaction verified: SDK ${CLAUDE_AGENT_SDK_RELEASE}, CLI ${CLI_RELEASE}, ${MODEL}/${EFFORT}, session ${sessionId}, 3 ordinary prompts, one compaction, native resume; tools disabled; native history retained`);
  } finally {
    clearTimeout(timer);
    await session?.close();
    // As in the other live fixtures, remove the disposable workspace and leave
    // the authenticated CLI's persisted session history in its native store.
    await rm(root, { recursive: true, force: true });
  }
}, 210_000);
