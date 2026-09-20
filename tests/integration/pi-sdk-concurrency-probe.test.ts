import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_EXCLUDED_TOOL_NAMES,
  PI_SUPPORTED_BUILTIN_TOOL_NAMES,
} from "../../src/server/backends/pi/pi-builtin-tool-policy.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function disposeSession(session: AgentSession): Promise<void> {
  session.clearQueue();
  await session.abort();
  await session.settingsManager.flush();
  session.dispose();
}

function assistantMessage(
  text: string,
): Parameters<SessionManager["appendMessage"]>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "sdk-probe",
    model: "no-provider-call",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function isolatedModel(id: string): Parameters<AgentSession["setModel"]>[0] {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "http://127.0.0.1.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
}

describe("Pi 0.86.0 isolated multi-session construction gate", () => {
  it("keeps two owners isolated across concurrent construction, mutation, disposal, and reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-web-sdk-probe-"));
    temporaryRoots.push(root);
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    const sessionStore = path.join(root, "sessions");
    const agentDir = path.join(root, "agent");
    await Promise.all([
      mkdir(workspaceA),
      mkdir(workspaceB),
      mkdir(sessionStore),
      mkdir(agentDir),
    ]);
    await Promise.all([
      mkdir(path.join(workspaceA, ".pi")),
      mkdir(path.join(workspaceB, ".pi")),
    ]);
    await Promise.all([
      writeFile(path.join(workspaceA, "AGENTS.md"), "workspace-a-only-context"),
      writeFile(path.join(workspaceB, "AGENTS.md"), "workspace-b-only-context"),
      writeFile(
        path.join(workspaceA, ".pi", "settings.json"),
        JSON.stringify({ steeringMode: "all", followUpMode: "all" }),
      ),
      writeFile(
        path.join(workspaceB, ".pi", "settings.json"),
        JSON.stringify({
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
        }),
      ),
    ]);

    const sessionIdA = randomUUID();
    const sessionIdB = randomUUID();
    const managerA = SessionManager.create(workspaceA, sessionStore, {
      id: sessionIdA,
    });
    const managerB = SessionManager.create(workspaceB, sessionStore, {
      id: sessionIdB,
    });
    const settingsA = SettingsManager.create(workspaceA, agentDir, {
      projectTrusted: true,
    });
    const settingsB = SettingsManager.create(workspaceB, agentDir, {
      projectTrusted: true,
    });
    const modelA = isolatedModel("probe-model-a");
    const modelB = isolatedModel("probe-model-b");

    const [createdA, createdB] = await Promise.all([
      createAgentSession({
        cwd: workspaceA,
        agentDir,
        sessionManager: managerA,
        settingsManager: settingsA,
        model: modelA,
        scopedModels: [{ model: modelA, thinkingLevel: "low" }],
        thinkingLevel: "low",
      }),
      createAgentSession({
        cwd: workspaceB,
        agentDir,
        sessionManager: managerB,
        settingsManager: settingsB,
        model: modelB,
        scopedModels: [{ model: modelB, thinkingLevel: "high" }],
        thinkingLevel: "high",
      }),
    ]);
    const sessionA = createdA.session;
    const sessionB = createdB.session;
    const eventsA: AgentSessionEvent[] = [];
    const eventsB: AgentSessionEvent[] = [];
    const unsubscribeA = sessionA.subscribe((event) => eventsA.push(event));
    const unsubscribeB = sessionB.subscribe((event) => eventsB.push(event));

    expect(sessionA.sessionId).toBe(sessionIdA);
    expect(sessionB.sessionId).toBe(sessionIdB);
    expect(sessionA.sessionManager.getCwd()).toBe(workspaceA);
    expect(sessionB.sessionManager.getCwd()).toBe(workspaceB);
    expect(sessionA.settingsManager).not.toBe(sessionB.settingsManager);
    expect(sessionA.modelRuntime).not.toBe(sessionB.modelRuntime);
    expect(sessionA.model?.id).toBe("probe-model-a");
    expect(sessionB.model?.id).toBe("probe-model-b");
    expect(sessionA.scopedModels.map(({ model }) => model.id)).toEqual([
      "probe-model-a",
    ]);
    expect(sessionB.scopedModels.map(({ model }) => model.id)).toEqual([
      "probe-model-b",
    ]);
    expect(sessionA.steeringMode).toBe("all");
    expect(sessionB.steeringMode).toBe("one-at-a-time");
    expect(sessionA.followUpMode).toBe("all");
    expect(sessionB.followUpMode).toBe("one-at-a-time");
    expect(sessionA.thinkingLevel).toBe("low");
    expect(sessionB.thinkingLevel).toBe("high");
    const resourcesA = JSON.stringify(sessionA.resourceLoader.getAgentsFiles());
    const resourcesB = JSON.stringify(sessionB.resourceLoader.getAgentsFiles());
    expect(resourcesA).toContain("workspace-a-only-context");
    expect(resourcesA).not.toContain("workspace-b-only-context");
    expect(resourcesB).toContain("workspace-b-only-context");
    expect(resourcesB).not.toContain("workspace-a-only-context");
    expect(sessionA.sessionFile).not.toBe(sessionB.sessionFile);
    await expect(access(sessionA.sessionFile!)).rejects.toThrow();
    await expect(access(sessionB.sessionFile!)).rejects.toThrow();

    sessionA.setSessionName("probe-a");
    sessionB.setSessionName("probe-b");
    sessionA.setActiveToolsByName(["read", "ls"]);
    sessionB.setActiveToolsByName(["read", "grep", "find"]);

    expect(sessionA.sessionName).toBe("probe-a");
    expect(sessionB.sessionName).toBe("probe-b");
    expect(sessionA.getActiveToolNames().sort()).toEqual(["ls", "read"]);
    expect(sessionB.getActiveToolNames().sort()).toEqual([
      "find",
      "grep",
      "read",
    ]);
    expect(eventsA.some((event) => event.type === "session_info_changed")).toBe(
      true,
    );
    expect(eventsB.some((event) => event.type === "session_info_changed")).toBe(
      true,
    );
    expect(
      eventsA.some(
        (event) =>
          event.type === "session_info_changed" && event.name === "probe-b",
      ),
    ).toBe(false);
    expect(
      eventsB.some(
        (event) =>
          event.type === "session_info_changed" && event.name === "probe-a",
      ),
    ).toBe(false);

    managerA.appendMessage({
      role: "user",
      content: "probe A",
      timestamp: Date.now(),
    });
    managerA.appendMessage(assistantMessage("result A"));
    managerB.appendMessage({
      role: "user",
      content: "probe B",
      timestamp: Date.now(),
    });
    managerB.appendMessage(assistantMessage("result B"));

    const fileA = managerA.getSessionFile();
    const fileB = managerB.getSessionFile();
    expect(fileA).toBeTypeOf("string");
    expect(fileB).toBeTypeOf("string");
    expect(fileA).not.toBe(fileB);

    unsubscribeA();
    unsubscribeB();
    await Promise.all([disposeSession(sessionA), disposeSession(sessionB)]);

    const [reopenedA, reopenedB] = await Promise.all([
      createAgentSession({
        cwd: workspaceA,
        agentDir,
        sessionManager: SessionManager.open(fileA!, sessionStore),
        settingsManager: SettingsManager.create(workspaceA, agentDir, {
          projectTrusted: true,
        }),
        model: modelA,
        scopedModels: [{ model: modelA, thinkingLevel: "low" }],
      }),
      createAgentSession({
        cwd: workspaceB,
        agentDir,
        sessionManager: SessionManager.open(fileB!, sessionStore),
        settingsManager: SettingsManager.create(workspaceB, agentDir, {
          projectTrusted: true,
        }),
        model: modelB,
        scopedModels: [{ model: modelB, thinkingLevel: "high" }],
      }),
    ]);

    expect(reopenedA.session.sessionId).toBe(sessionIdA);
    expect(reopenedB.session.sessionId).toBe(sessionIdB);
    const reopenedBranchA = reopenedA.session.sessionManager.getBranch();
    const reopenedBranchB = reopenedB.session.sessionManager.getBranch();
    expect(reopenedBranchA.length).toBeGreaterThanOrEqual(4);
    expect(reopenedBranchB.length).toBeGreaterThanOrEqual(4);
    expect(
      reopenedBranchA.some((entry) =>
        reopenedBranchB.some((otherEntry) => entry.id === otherEntry.id),
      ),
    ).toBe(false);
    expect(reopenedA.session.steeringMode).toBe("all");
    expect(reopenedB.session.steeringMode).toBe("one-at-a-time");
    expect(reopenedA.session.model?.id).toBe("probe-model-a");
    expect(reopenedB.session.model?.id).toBe("probe-model-b");
    expect(
      JSON.stringify(reopenedA.session.resourceLoader.getAgentsFiles()),
    ).toContain("workspace-a-only-context");
    expect(
      JSON.stringify(reopenedB.session.resourceLoader.getAgentsFiles()),
    ).toContain("workspace-b-only-context");
    expect(JSON.stringify(reopenedA.session.messages)).toContain("result A");
    expect(JSON.stringify(reopenedA.session.messages)).not.toContain(
      "result B",
    );
    expect(JSON.stringify(reopenedB.session.messages)).toContain("result B");
    expect(JSON.stringify(reopenedB.session.messages)).not.toContain(
      "result A",
    );
    reopenedA.session.setActiveToolsByName(["read", "ls"]);
    reopenedB.session.setActiveToolsByName(["read", "grep", "find"]);
    expect(reopenedA.session.getActiveToolNames().sort()).toEqual([
      "ls",
      "read",
    ]);
    expect(reopenedB.session.getActiveToolNames().sort()).toEqual([
      "find",
      "grep",
      "read",
    ]);

    await Promise.all([
      disposeSession(reopenedA.session),
      disposeSession(reopenedB.session),
    ]);

    await rm(root, { force: true, recursive: true });
    temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
    await expect(access(root)).rejects.toThrow();
  });
});

describe("Pi 0.86.0 built-in exclusion gate", () => {
  it("removes PowerShell without hiding the seven supported built-ins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-web-sdk-tools-probe-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const sessionStore = path.join(root, "sessions");
    const agentDir = path.join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(sessionStore), mkdir(agentDir)]);

    const created = await createAgentSession({
      cwd: workspace,
      agentDir,
      sessionManager: SessionManager.create(workspace, sessionStore, {
        id: randomUUID(),
      }),
      settingsManager: SettingsManager.inMemory(),
      excludeTools: [...PI_EXCLUDED_TOOL_NAMES],
    });
    try {
      const names = created.session.getAllTools().map(({ name }) => name);
      expect(names).not.toContain("powershell");
      expect(names).toEqual(
        expect.arrayContaining([...PI_SUPPORTED_BUILTIN_TOOL_NAMES]),
      );
    } finally {
      await disposeSession(created.session);
    }
  });
});

describe("Pi 0.86.0 session-scoped model and thinking mutations", () => {
  it("changes transcript state without rewriting global defaults", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pi-web-sdk-settings-probe-"),
    );
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const sessionStore = path.join(root, "sessions");
    const agentDir = path.join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(sessionStore), mkdir(agentDir)]);

    const settings = SettingsManager.create(workspace, agentDir, {
      projectTrusted: true,
    });
    settings.setDefaultModelAndProvider("openai", "global-default-model");
    settings.setDefaultThinkingLevel("medium");
    settings.setModelThinkingLevel("openai", "target-model", "low");
    await settings.flush();

    const initialModel = isolatedModel("initial-model");
    const targetModel = isolatedModel("target-model");
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "pi-sdk-settings-probe";
    let session: AgentSession | undefined;
    try {
      const created = await createAgentSession({
        cwd: workspace,
        agentDir,
        sessionManager: SessionManager.create(workspace, sessionStore, {
          id: randomUUID(),
        }),
        settingsManager: settings,
        model: initialModel,
        thinkingLevel: "high",
      });
      session = created.session;
      const initialEntryCount = session.sessionManager.getBranch().length;

      await session.setModel(targetModel);
      expect(session.model?.id).toBe("target-model");
      expect(session.thinkingLevel).toBe("low");

      session.setThinkingLevel("high");
      expect(session.thinkingLevel).toBe("high");
      await settings.flush();

      const reloaded = SettingsManager.create(workspace, agentDir, {
        projectTrusted: true,
      });
      expect(reloaded.getDefaultProvider()).toBe("openai");
      expect(reloaded.getDefaultModel()).toBe("global-default-model");
      expect(reloaded.getDefaultThinkingLevel()).toBe("medium");
      expect(reloaded.getModelThinkingLevel("openai", "target-model")).toBe(
        "low",
      );

      expect(
        session.sessionManager
          .getBranch()
          .slice(initialEntryCount)
          .filter(
            (entry) =>
              entry.type === "model_change" ||
              entry.type === "thinking_level_change",
          )
          .map((entry) =>
            entry.type === "model_change"
              ? `model:${entry.provider}/${entry.modelId}`
              : `thinking:${entry.thinkingLevel}`,
          ),
      ).toEqual(["model:openai/target-model", "thinking:low", "thinking:high"]);
    } finally {
      if (session) await disposeSession(session);
      if (priorOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAiKey;
      }
    }
  });
});
