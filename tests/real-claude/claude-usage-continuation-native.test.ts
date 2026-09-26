import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runClaudeForkLaunch } from "../../src/server/backends/claude/claude-fork-launch.js";
import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { OfficialClaudeSdkFacade, type ClaudeCliAuthStatus, type ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";
import { ClaudeUsageAccounting } from "../../src/server/backends/claude/claude-usage-accounting.js";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { usageTimelineMigration } from "../../src/server/db/migrations/113-usage-timeline.js";
import { usageSubagentRecoveryIndexesMigration } from "../../src/server/db/migrations/114-usage-subagent-recovery-indexes.js";
import { nativeUsageMoney } from "../../src/server/usage/native-money.js";
import { UsageService } from "../../src/server/usage/usage-service.js";

const MODEL = "claude-sonnet-5";
const scope = { tenantId: "tenant", principalId: "principal" };

/**
 * The loopback CLI authenticates with a fixture API key. Sedes' subscription
 * gate is not what this file qualifies, so the facade reports one; everything
 * else is the pinned SDK and the native CLI, with no tools for determinism.
 */
class LoopbackClaudeSdkFacade extends OfficialClaudeSdkFacade {
  override async readCliAuthStatus(): Promise<ClaudeCliAuthStatus> {
    return { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "fixture" };
  }

  override createQuery(input: ClaudeQueryInput): Query {
    const query = super.createQuery({ ...input, options: { ...input.options, tools: [], strictMcpConfig: true } });
    return new Proxy(query, {
      get(target, property) {
        if (property === "initializationResult") {
          return async () => {
            const result = await target.initializationResult();
            return { ...result, account: { ...result.account, apiProvider: "firstParty", subscriptionType: "fixture" } };
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

/** Actual pinned SDK + native CLI against an isolated localhost Messages API.
 * From Claude Code 2.1.277 a resumed or forked query's pipeline totals continue
 * from those its transcript saved, so its startup result already carries the
 * earlier turns. Sedes' accounting must still count each request exactly once
 * across a new query, its resumption, and a fork child. No provider
 * credentials are used. */
it("counts a resumed query and a fork child's continued totals once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-claude-usage-continuation-"));
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  await mkdir(path.join(root, "workspace"), { mode: 0o700 });
  const workspace = await realpath(path.join(root, "workspace"));
  const errors: unknown[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* drain */ }
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(404).end();
        return;
      }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const ordinal = ++requests;
      expect(ordinal).toBeLessThanOrEqual(8);
      stream(response, `r${ordinal}`);
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const environment: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  Object.assign(environment, {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
  });
  const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude";
  const sdk = new LoopbackClaudeSdkFacade();
  const db = usageDatabase();
  const usage = new UsageService(db, { enabled: true });
  const sessionId = randomUUID(), childId = randomUUID();
  const binding = (thread: string, native: string) => ({ tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: thread,
    backendInstanceId: "claude", executionEnvironmentId: "environment", connectionProfileId: "connection", backendConversationId: native, createdAt: "2026-09-26T00:00:00Z" });
  bindThread(db, "parent", sessionId);
  bindThread(db, "child", childId);
  const totals = (thread: string) => {
    const { metrics, costs, reasons } = usage.read(scope, thread).summary;
    return { input: metrics.input.value, output: metrics.output.value, quality: metrics.input.quality, cost: costs[0]?.amount ?? null, reasons };
  };

  /** One Sedes query: the production session and startup message, fed to accounting as the handle does. */
  async function run(thread: string, native: string, launch: "new" | "resume", prompts: readonly string[]) {
    const accounting = new ClaudeUsageAccounting({ sink: usage, binding: binding(thread, native), nativeNamespace: "fixture-store", launch });
    const results: SDKResultMessage[] = [];
    let wake: (() => void) | undefined;
    const session: ClaudeSdkSession = new ClaudeSdkSession({
      sdk, executablePath, initializationTimeoutMs: 60_000, sessionId: native, cwd: workspace, launch, model: MODEL, environment,
      onMessage: (message: SDKMessage) => {
        if (message.type !== "result") return;
        accounting.admitQuery(session.startupProbeUuid, false);
        accounting.pipeline(message);
        results.push(message);
        wake?.();
      },
    });
    const settled = async (predicate: (message: SDKResultMessage) => boolean) => {
      const deadline = Date.now() + 60_000;
      while (!results.some(predicate)) {
        if (Date.now() > deadline) throw new Error("fixture_result_timeout");
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 250); });
      }
      return results.find(predicate)!;
    };
    try {
      await session.start();
      accounting.admitQuery(session.startupProbeUuid, false);
      const startup = await settled((message) => claudeResultUserMessageIds(message).includes(session.startupProbeUuid!));
      const replies: SDKResultMessage[] = [];
      for (const prompt of prompts) {
        const operationId = randomUUID();
        session.send({ operationId, content: prompt });
        replies.push(await settled((message) => claudeResultUserMessageIds(message).includes(operationId)));
      }
      return { startup, replies };
    } finally {
      await session.close();
      accounting.close();
    }
  }

  const inputTokens = (message: SDKResultMessage) => message.modelUsage[MODEL]?.inputTokens ?? 0;
  try {
    const first = await run("parent", sessionId, "new", ["one", "two"]);
    expect(requests).toBe(2);
    expect(inputTokens(first.startup)).toBe(0);
    expect(totals("parent")).toMatchObject({ input: "2", output: "2", quality: "complete" });

    const resumed = await run("parent", sessionId, "resume", ["three"]);
    expect(requests).toBe(3);
    // The CLI restored both earlier turns before this query made any request.
    expect(inputTokens(resumed.startup)).toBe(2);
    expect(resumed.startup.num_turns).toBe(0);
    expect(inputTokens(resumed.replies[0]!)).toBe(3);
    // Sedes counts three requests, not the five its two queries reported.
    expect(totals("parent")).toMatchObject({ input: "3", output: "3", quality: "complete" });
    expect(totals("parent").cost).toBe(nativeUsageMoney(resumed.replies[0]!.total_cost_usd));

    const leaf = (await transcript(home, sessionId)).filter((row) => row.type === "assistant").at(-1)?.uuid;
    if (typeof leaf !== "string") throw new Error("fixture_fork_leaf_missing");
    await runClaudeForkLaunch((options) => new ClaudeSdkSession({ ...options, sdk }), {
      executablePath, initializationTimeoutMs: 60_000, sessionId: childId, sourceSessionId: sessionId, resumeSessionAt: leaf,
      cwd: workspace, model: MODEL, environment,
    });
    expect(requests).toBe(3);

    const child = await run("child", childId, "resume", ["four"]);
    expect(requests).toBe(4);
    // The child's transcript copied the source's saved totals.
    expect(inputTokens(child.startup)).toBe(3);
    expect(inputTokens(child.replies[0]!)).toBe(4);
    expect(totals("child")).toMatchObject({ input: "1", output: "1", quality: "complete" });
    expect(totals("parent")).toMatchObject({ input: "3", output: "3" });
    expect(usage.analytics(scope, { from: null, to: new Date(Date.now() + 60_000).toISOString(), timeZone: "UTC", bucket: "day",
      filters: {}, groupBy: null, crossBy: null, breakdownLimit: 10, facets: false }).totals).toMatchObject({ input: "4", output: "4" });
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

function usageDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
CREATE TABLE application_threads(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,environment_id TEXT NOT NULL,workspace_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT 'Thread',last_activity_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,owner_principal_id,id));
CREATE TABLE agent_backend_instances(tenant_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL DEFAULT 'Backend',owner_principal_id TEXT,PRIMARY KEY(tenant_id,id));
CREATE TABLE execution_environments(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL);
CREATE TABLE workspaces(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,environment_id TEXT NOT NULL,id TEXT NOT NULL,canonical_path TEXT NOT NULL,display_name TEXT NOT NULL,removed_at INTEGER);
CREATE TABLE thread_principal_state(tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,thread_id TEXT NOT NULL,inventory_state TEXT NOT NULL);
CREATE TABLE conversation_bindings(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,backend_instance_id TEXT NOT NULL,execution_environment_id TEXT NOT NULL,backend_conversation_id TEXT NOT NULL,connection_profile_id TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 1790035200000);
CREATE TABLE conversation_creation_attempts(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,force_reset_at INTEGER,phase TEXT);
CREATE TABLE thread_lineage_closure(tenant_id TEXT, owner_principal_id TEXT, ancestor_thread_id TEXT, descendant_thread_id TEXT);
CREATE TABLE thread_fork_origins(tenant_id TEXT, owner_principal_id TEXT, child_thread_id TEXT, source_thread_id TEXT, creation_operation_id TEXT, source_thread_state TEXT);
CREATE TABLE claude_usage_ledgers(tenant_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,application_thread_id TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,request_count INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO agent_backend_instances(tenant_id,id,kind) VALUES('tenant','claude','claude_agent_sdk');`);
  for (const migration of [durableUsageAccountingMigration, usageGapSessionScopeMigration, usageSubagentsMigration, usageTimelineMigration, usageSubagentRecoveryIndexesMigration]) db.exec(migration.sql);
  return db;
}

function bindThread(db: Database.Database, thread: string, native: string): void {
  db.prepare("INSERT INTO application_threads(tenant_id,owner_principal_id,id,backend_instance_id,environment_id,workspace_id) VALUES('tenant','principal',?,'claude','environment','workspace')").run(thread);
  db.prepare("INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,execution_environment_id,backend_conversation_id,connection_profile_id) VALUES('tenant','principal',?,'claude','environment',?,'connection')").run(thread, native);
}

async function transcript(home: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const projects = path.join(home, ".claude", "projects");
  for (const project of await readdir(projects)) {
    const file = path.join(projects, project, `${sessionId}.jsonl`);
    const contents = await readFile(file, "utf8").catch(() => undefined);
    if (contents !== undefined) return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  throw new Error("fixture_transcript_missing");
}

function stream(response: ServerResponse, id: string): void {
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "SEDES_FIXTURE_DONE" } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  response.end();
}
