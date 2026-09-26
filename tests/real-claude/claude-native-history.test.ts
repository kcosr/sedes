import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionInfo,
  getSessionMessages,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { ClaudeConversationBackendDriver } from "../../src/server/backends/claude/claude-conversation-driver.js";
import { verifyClaudeRuntimeVersion } from "../../src/server/backends/claude/claude-release-guard.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { OfficialClaudeSdkFacade, type ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import type { AgentBackendInstance, AgentConnectionProfile, ConversationBinding } from "../../src/server/backends/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import type { BackendItem } from "../../src/shared/protocol/backend.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const REQUIRED_MODEL = "claude-sonnet-5";
const REQUIRED_EFFORT = "low";
const MODEL_TURN_TIMEOUT_MS = 240_000;
const scope = { tenantId: "real-claude-tenant", principalId: "real-claude-principal" };
const instance: AgentBackendInstance = {
  id: "real-claude-instance", tenantId: scope.tenantId, kind: "claude_agent_sdk", label: "Real Claude",
  enabled: true, configurationRevision: 1, protocolRelease: "0.3.274",
};
const connection: AgentConnectionProfile = {
  id: "real-claude-connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
  templateId: "real-claude-template", kind: "claude_agent_sdk", backendInstanceId: instance.id,
  executionEnvironmentId: "real-claude-environment", label: "Real Claude", enabled: true, configurationRevision: 1,
};
const agentTools: BackendAgentToolFacade = {
  eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [],
  readPolicy: () => ({ enabled: false, presentation: { surface: "cli", mode: "progressive" }, accessBoundary: "environment", enabledToolIds: [] }),
  invoke: async () => { throw new Error("real_claude_agent_tools_disabled"); },
};
const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude";
const configDirectory = process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ?? path.join(os.homedir(), ".claude");
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Safety decorator: only the named tools, only exact pre-approved invocations
 * (`dontAsk` denies everything else without prompting), and no MCP servers.
 */
class RestrictedOfficialClaudeSdkFacade extends OfficialClaudeSdkFacade {
  readonly persistentQueryOptions: ClaudeQueryInput["options"][] = [];
  readonly resultMessages: SDKResultMessage[] = [];

  constructor(readonly tools: readonly string[], readonly allowedTools: readonly string[]) {
    super();
  }

  override createQuery(input: ClaudeQueryInput): Query {
    const options = { ...input.options, tools: [...this.tools], allowedTools: [...this.allowedTools],
      strictMcpConfig: true, mcpServers: {} } satisfies ClaudeQueryInput["options"];
    if (options.persistSession !== false) this.persistentQueryOptions.push(options);
    return observeQuery(super.createQuery({ ...input, options }), (message) => {
      if (message.type === "result") this.resultMessages.push(message);
    });
  }
}

describe.sequential("real Claude native history", () => {
  beforeEach(() => {
    // The pinned SDK oracle reads the same store as the CLI children.
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads a resumed transcript with parallel tool calls through its startup-message tip", async () => {
    // A dead end needs a call still running when the next tool_use arrives; a
    // fast concurrency-safe tool is executed during streaming and stays linear.
    const live = await liveDriver(["Bash"], [
      "Bash(sleep 3 && echo SEDES_ALPHA_7F3)", "Bash(sleep 3)", "Bash(echo SEDES_ALPHA_7F3)", "Bash(echo SEDES_BETA_2C9)",
    ]);
    const thread = await live.createThread();
    let handle = await live.driver.attach(thread.attachment);
    try {
      await handle.establishProjection({ signal: new AbortController().signal });
      await live.completeTurn(handle, "Make exactly two Bash tool calls in one message, in parallel, without waiting for either result: first `sleep 3 && echo SEDES_ALPHA_7F3`, second `echo SEDES_BETA_2C9`. After both results arrive, reply with exactly the two outputs separated by one space.");
      await handle.close();
      // Reopening resumes the session, which persists the startup message at the tip.
      handle = await live.driver.attach(thread.attachment);
      const reopened = await handle.establishProjection({ signal: new AbortController().signal });
      expect(finalAssistantText(reopened.snapshot.itemsById)).toContain("SEDES_ALPHA_7F3 SEDES_BETA_2C9");
      expect(reopened.snapshot.orderedBackendTurnIds).toHaveLength(1);

      const rows = await transcriptRows(thread.sessionId, live.workspace.canonicalPath);
      const tip = rows.filter((row) => (row.type === "user" || row.type === "assistant") && !row.isSidechain).at(-1);
      expect(tip).toMatchObject({ type: "user", isMeta: true });
      const parents = new Set(rows.map((row) => row.parentUuid));
      const deadEnds = rows.filter((row) => row.type === "user" && !parents.has(row.uuid) && JSON.stringify(row.message).includes("tool_result"));
      if (deadEnds.length === 0) throw new Error("REAL_CLAUDE_BLOCKER: Claude did not issue parallel tool calls, so no dead-end tool result exists.");

      const ours = await live.sdk.getSessionMessages(thread.sessionId, { dir: live.workspace.canonicalPath }, live.childEnvironment);
      const theirs = await getSessionMessages(thread.sessionId, { dir: live.workspace.canonicalPath });
      expect(ours.at(-1)).toMatchObject({ type: "assistant" });
      expect(JSON.stringify(ours.at(-1)?.message)).toContain("SEDES_ALPHA_7F3 SEDES_BETA_2C9");
      expect(ours.map(({ uuid }) => uuid)).toEqual(expect.arrayContaining(deadEnds.map(({ uuid }) => uuid as string)));
      // The pinned SDK's leaf heuristic stops at the dead end instead.
      expect(theirs.at(-1)?.uuid).not.toBe(ours.at(-1)?.uuid);
      expect(theirs.length).toBeLessThan(ours.length);
      console.info(`[real-claude] parallel resume: ${ours.length} messages through the true tip; SDK ${theirs.length}; dead ends ${deadEnds.length}`);
    } finally {
      await handle.close();
      await live.close();
    }
  });

  it("reopens a thread whose transcript holds only the startup message", async () => {
    const live = await liveDriver([], []);
    const thread = await live.createThread();
    let handle = await live.driver.attach(thread.attachment);
    try {
      expect((await handle.establishProjection({ signal: new AbortController().signal })).snapshot.orderedBackendTurnIds).toEqual([]);
      await handle.close();
      const rows = await transcriptRows(thread.sessionId, live.workspace.canonicalPath);
      const messages = rows.filter((row) => row.type === "user" || row.type === "assistant");
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((row) => row.isMeta === true)).toBe(true);
      await expect(getSessionInfo(thread.sessionId, { dir: live.workspace.canonicalPath })).resolves.toBeUndefined();

      handle = await live.driver.attach(thread.attachment);
      expect(live.sdk.persistentQueryOptions.at(-1)).toMatchObject({ resume: thread.sessionId });
      expect(live.sdk.persistentQueryOptions.at(-1)).not.toHaveProperty("sessionId");
      // Resuming answers the dangling startup message with a `<synthetic>`
      // "No response requested." row, which is never a turn.
      const reopened = await handle.establishProjection({ signal: new AbortController().signal });
      expect(reopened.snapshot.orderedBackendTurnIds).toEqual([]);
      await live.completeTurn(handle, "Reply with exactly SEDES_CLAUDE_REOPEN_OK. Do not use tools.");
      const settled = await handle.establishProjection({ signal: new AbortController().signal });
      expect(settled.snapshot.orderedBackendTurnIds).toHaveLength(1);
      expect(finalAssistantText(settled.snapshot.itemsById)).toContain("SEDES_CLAUDE_REOPEN_OK");
      await handle.close();
      const read = await live.driver.read(thread.attachment);
      expect(read.snapshot.orderedBackendTurnIds).toEqual(settled.snapshot.orderedBackendTurnIds);

      // The first reopen finds the reply at the tip; the second closes the
      // startup message the first one left. Neither adds a turn or an answer.
      for (let reopen = 0; reopen < 2; reopen += 1) {
        handle = await live.driver.attach(thread.attachment);
        const again = await handle.establishProjection({ signal: new AbortController().signal });
        expect(again.snapshot.orderedBackendTurnIds).toEqual(settled.snapshot.orderedBackendTurnIds);
        expect(finalAssistantText(again.snapshot.itemsById)).toBe(finalAssistantText(settled.snapshot.itemsById));
        await handle.close();
      }
      const reread = await live.driver.read(thread.attachment);
      expect(reread.snapshot).toEqual(read.snapshot);
      expect(JSON.stringify(reread.snapshot)).not.toContain("No response requested.");
      const synthetic = (await transcriptRows(thread.sessionId, live.workspace.canonicalPath))
        .filter((row) => row.type === "assistant" && (row.message as { model?: string }).model === "<synthetic>");
      // One closure for the startup-only reopen and one for the last reopen.
      expect(synthetic.length).toBeGreaterThanOrEqual(2);
      console.info(`[real-claude] startup-only thread reopened three times; provider synthetic rows: ${synthetic.length}`);
    } finally {
      await handle.close();
      await live.close();
    }
  });
});

async function liveDriver(tools: readonly string[], allowedTools: readonly string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-claude-history-"));
  temporaryRoots.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspace: ValidatedWorkspace = {
    canonicalPath: await realpath(workspacePath), authorityRevision: 0,
    summary: { id: `real-claude-workspace-${randomUUID()}`, environmentId: connection.executionEnvironmentId,
      displayName: "real-claude-workspace", displayPath: workspacePath, availability: "available", trustState: "trusted", revision: 0 },
  };
  const sdk = new RestrictedOfficialClaudeSdkFacade(tools, allowedTools);
  const childEnvironment = Object.freeze({ ...process.env, CLAUDE_CONFIG_DIR: configDirectory });
  // A no-prompt initialization gates provider capacity on the subscription contract.
  const preflight = await probeClaudeSdkDirect({ sdk, executablePath, cwd: workspace.canonicalPath, timeoutMs: 30_000, environment: childEnvironment });
  expect(() => verifyClaudeRuntimeVersion(preflight.cliRelease)).not.toThrow();
  expect(preflight.account.apiProvider).toBe("firstParty");
  expect(preflight.account.subscriptionType).toBeTruthy();

  const database = new Database(":memory:");
  initializeEmptyBackendNormalizedDatabase(database);
  database.pragma("foreign_keys = OFF");
  const settings = new ClaudeThreadRepository(database);
  const driver = new ClaudeConversationBackendDriver({
    usage: NO_USAGE_SINK, nativeNamespace: "claude-test-native", instance, connection,
    runtimeClient: new ClaudeSdkRuntimeAdapter(sdk), executablePath, initializationTimeoutMs: 30_000,
    probeDirectory: configDirectory, permissionPolicy: { allowedModes: ["dontAsk"] },
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"), settings,
    toolProvenanceKey: new Uint8Array(32).fill(7), childEnvironment,
    agentToolSourceCapabilities: createFakeAgentToolSourceCapabilities().issuer, agentTools,
    attachmentProvenanceKey: new Uint8Array(32).fill(0x43),
  });
  const catalog = await driver.catalog({ scope, workspace });
  if (catalog.models.filter((model) => model.id === REQUIRED_MODEL && model.supportedReasoningEfforts?.includes(REQUIRED_EFFORT)).length !== 1) {
    throw new Error(`REAL_CLAUDE_BLOCKER: expected exactly one ${REQUIRED_MODEL}/${REQUIRED_EFFORT} catalog entry.`);
  }
  return {
    sdk, workspace, childEnvironment, driver,
    async createThread() {
      const applicationThreadId = randomUUID();
      const sessionId = randomUUID();
      settings.initialize(scope, applicationThreadId, {
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId,
      }, { model: REQUIRED_MODEL, effort: REQUIRED_EFFORT, permissionMode: "dontAsk" }, Date.now());
      const created = await driver.create({ scope, workspace, applicationThreadId, applicationOperationId: randomUUID(),
        requestedBackendConversationId: sessionId, source: { kind: "user" }, title: "Disposable Sedes real-Claude history verification" });
      const binding: ConversationBinding = { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId,
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId: sessionId, createdAt: new Date().toISOString() };
      return { sessionId, attachment: { scope, workspace, binding, opaqueBindingDetail: created.opaqueBindingDetail } };
    },
    async completeTurn(handle: Awaited<ReturnType<ClaudeConversationBackendDriver["attach"]>>, text: string) {
      const applicationOperationId = randomUUID();
      await handle.submit({ applicationOperationId, mutationId: randomUUID(), source: { kind: "user" }, reconciliationToken: randomUUID(),
        text, contextExcerpts: [], attachments: [], taskContexts: [] });
      const deadline = Date.now() + MODEL_TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = sdk.resultMessages.find((message) => claudeResultUserMessageIds(message).includes(applicationOperationId));
        if (result?.is_error) throw new Error(`REAL_CLAUDE_FAILURE: provider result was ${result.terminal_reason ?? result.subtype}.`);
        if (result) {
          const projection = await handle.establishProjection({ signal: new AbortController().signal });
          const turn = Object.values(projection.snapshot.turnsById).find((candidate) => candidate.completionCorrelations?.includes(applicationOperationId));
          if (turn?.status === "completed") return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("REAL_CLAUDE_FAILURE: timed out waiting for the terminal turn.");
    },
    async close() {
      await driver.close();
      database.close();
    },
  };
}

async function transcriptRows(sessionId: string, workspace: string): Promise<Record<string, unknown>[]> {
  const file = path.join(configDirectory, "projects", workspace.replace(/[^a-zA-Z0-9]/gu, "-"), `${sessionId}.jsonl`);
  return (await readFile(file, "utf8")).split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function finalAssistantText(items: Readonly<Record<string, BackendItem>>): string {
  return Object.values(items).flatMap((item) =>
    item.semanticKind === "assistant_message" && item.responsePhase === "final" ? [item.markdown.text] : []).join("\n\n");
}

function observeQuery(query: Query, onMessage: (message: SDKMessage) => void): Query {
  let observed: Query;
  observed = new Proxy(query, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => observed;
      if (property === "next") {
        return async (...arguments_: Parameters<Query["next"]>) => {
          const result = await target.next(...arguments_);
          if (!result.done) onMessage(result.value);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return observed;
}
