import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultPiSdkSessionFactory,
  PiInteractionBridge,
  piUsage,
  type PiSdkSession,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import { piUsageObservation } from "../../src/server/backends/pi/pi-usage-accounting.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import type { PiExecutorWorkspaceServices } from "../../src/server/backends/pi/pi-remote-workspace.js";

const roots: string[] = [];
const sessions: PiSdkSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type CacheMode = "off" | "streaming" | "idle";
type Topology = "direct" | "remote" | "isolated";

async function createSession(topology: Topology, cacheWarming?: CacheMode) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-cache-usage-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const serviceCwd = path.join(root, "services");
  const workspacePath = path.join(root, "workspace");
  await Promise.all([
    mkdir(agentDir),
    mkdir(path.join(serviceCwd, ".pi"), { recursive: true }),
    mkdir(path.join(workspacePath, ".pi"), { recursive: true }),
  ]);
  // Even a trusted project cannot opt in to spending or override native global
  // policy. Put the conflicting project setting at both possible local cwds.
  const projectMode = cacheWarming === "idle" ? "off" : "idle";
  await Promise.all([
    writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ cacheWarming }),
    ),
    ...[serviceCwd, workspacePath].map((cwd) =>
      writeFile(
        path.join(cwd, ".pi", "settings.json"),
        JSON.stringify({ cacheWarming: projectMode }),
      ),
    ),
  ]);
  const executorWorkspace: PiExecutorWorkspaceServices = {
    semanticCwd: topology === "isolated" ? "/home/agent" : workspacePath,
    serviceCwd,
    sandboxWorkspaceAccess: "read_only",
    environmentLabel: topology,
    contextReader: { read: async () => ({ files: [], fingerprint: "empty" }) },
    executor: {
      read: vi.fn(),
      write: vi.fn(),
      edit: vi.fn(),
      list: vi.fn(),
      find: vi.fn(),
      grep: vi.fn(),
      startShell: vi.fn(),
    },
  };
  // Observe the constructed native session without replacing SDK behavior.
  const bindExtensions = vi.spyOn(AgentSession.prototype, "bindExtensions");
  const session = await new DefaultPiSdkSessionFactory({ agentDir }).create({
    manager: SessionManager.inMemory(workspacePath),
    workspace: {
      canonicalPath: workspacePath,
      summary: { trustState: "trusted" },
    } as ValidatedWorkspace,
    interactions: new PiInteractionBridge(),
    ...(topology === "remote" ? { remoteWorkspace: executorWorkspace } : {}),
    ...(topology === "isolated" ? { isolatedWorkspace: executorWorkspace } : {}),
  });
  sessions.push(session);
  await session.ready();
  const nativeSession = bindExtensions.mock.instances.at(-1)! as AgentSession;
  return { session, nativeSession, commandContextActions: bindExtensions.mock.calls.at(-1)![0].commandContextActions };
}

describe("Pi native cache-warming policy", () => {
  it.each(
    (["direct", "remote", "isolated"] as const).flatMap((topology) =>
      (["off", "streaming", "idle", undefined] as const).map((mode) => ({
        topology,
        mode,
      })),
    ),
  )(
    "keeps the global $mode policy for $topology construction and reload",
    async ({ topology, mode }) => {
      const { nativeSession } = await createSession(topology, mode);
      expect(nativeSession.settingsManager.getCacheWarmingMode()).toBe(
        mode ?? "streaming",
      );
      await nativeSession.reload();
      expect(nativeSession.settingsManager.getCacheWarmingMode()).toBe(
        mode ?? "streaming",
      );
    },
  );
});

describe("Pi application-owned tree actions", () => {
  it("cancels extension-driven native fork and tree navigation without generating summaries", async () => {
    const {session, commandContextActions}=await createSession("direct", "off");
    const before=session.sessionManager.getEntries();
    await expect(commandContextActions!.navigateTree("native-target",{summarize:true})).resolves.toEqual({cancelled:true});
    await expect(commandContextActions!.fork("native-target")).resolves.toEqual({cancelled:true});
    expect(session.sessionManager.getEntries()).toEqual(before);
  });
});

describe("Pi billed cache-warming usage", () => {
  it("counts warming requests across branches without counting them as assistant messages", async () => {
    const { session } = await createSession("direct", "off");
    const manager = session.sessionManager;
    const userId = manager.appendMessage({
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    const usage = {
      input: 2,
      output: 1,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 103,
      cost: { input: 0.1, output: 0.1, cacheRead: 0.3, cacheWrite: 0, total: 0.5 },
    };
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      api: "test",
      provider: "test",
      model: "model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    manager.appendUsage("cache_warm", "test", "model", usage);
    manager.branch(userId);
    manager.appendUsage("cache_warm", "test", "model", usage);
    expect(
      manager.getBranch().filter((entry) => entry.type === "usage"),
    ).toHaveLength(1);
    expect(piUsage(session)).toMatchObject({
      counters: {assistantMessages: 1, userMessages: 1, totalMessages: 2},
    });
    expect(piUsage(session)).not.toHaveProperty("tokens");
    expect(piUsage(session)).not.toHaveProperty("cost");
    expect(piUsage(session).counters).not.toHaveProperty("requests");
    const observations = manager.getEntries().flatMap((entry) => {
      const observation = piUsageObservation(entry, null, "history");
      return observation ? [observation] : [];
    });
    const facts = observations.flatMap((observation) => observation.facts);
    const sum = (metric: "input" | "uncachedInput" | "output" | "cacheRead" | "total" | "requests") =>
      facts.reduce((total, fact) => total + BigInt(fact.tokens[metric] ?? "0"), 0n).toString();
    expect(facts).toHaveLength(3);
    expect(facts.map((fact) => fact.sessionContribution)).toEqual(["additive", "additive", "additive"]);
    expect({input: sum("input"), uncachedInput: sum("uncachedInput"), output: sum("output"), cacheRead: sum("cacheRead"), total: sum("total"), requests: sum("requests")})
      .toEqual({input:"306",uncachedInput:"6",output:"3",cacheRead:"300",total:"309",requests:"3"});
    expect(facts.map((fact) => fact.costs)).toEqual(Array.from({length:3}, () => [{amount:"0.5",currency:"USD",kind:"estimated",provenance:"pi-ai 0.86.0 SDK pricing"}]));

    const extension = manager.appendUsage("extension_aggregate", "test", "model", usage);
    const unproven = piUsageObservation(extension, null, "history")!;
    expect(unproven.facts[0]).toMatchObject({sessionContribution:"none",reasons:["unknown_attribution"]});
    expect(unproven.facts[0]!.tokens.requests).toBeNull();
    expect(piUsage(session).counters).toEqual({assistantMessages:1,userMessages:1,totalMessages:2,toolCalls:0,toolResults:0,compactions:0});
  });
});
