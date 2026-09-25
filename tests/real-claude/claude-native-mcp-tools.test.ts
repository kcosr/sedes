import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  OfficialClaudeSdkFacade,
  type ClaudeCliAuthStatus,
  type ClaudeQueryInput,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { startLiveAgentToolListener } from "../helpers/live-agent-tool-listener.js";

const REQUIRED_MODEL = "claude-sonnet-5";
const MODEL_TURN_TIMEOUT_MS = 240_000;
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function configuration(workspace: string): ConfigurationDocument {
  return {
    executionEnvironments: [{
      id: environmentId,
      kind: "local",
      label: "Local",
      workspaceRoots: [workspace],
      workspaceIsolation: {
        kind: "bubblewrap",
        networkProfiles: ["isolated", "execution_host"],
      },
    }],
    backends: [{
      id: "claude-primary",
      kind: "claude_agent_sdk",
      label: "Claude",
      enabled: true,
      modelPolicy: { type: "catalog" },
      moduleConfiguration: {
        initializationTimeoutMs: 20_000,
        permissionPolicy: { allowedModes: ["default"] },
      },
    }],
    targets: [{
      id: "claude-local",
      kind: "claude_agent_sdk",
      label: "Claude",
      backendInstanceId: "claude-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
      moduleConfiguration: { defaults: { permissionMode: "default" } },
    }],
    defaultTargetId: "claude-local",
    webSearch: null,
  };
}

/**
 * Keeps the query deterministic: no built-in tools and no MCP servers from
 * the operator's settings, while the production session adds the Sedes server.
 */
class SedesOnlyClaudeSdkFacade extends OfficialClaudeSdkFacade {
  readonly queryOptions: ClaudeQueryInput["options"][] = [];
  readonly authStatuses: ClaudeCliAuthStatus[] = [];

  override async readCliAuthStatus(
    ...input: Parameters<OfficialClaudeSdkFacade["readCliAuthStatus"]>
  ): Promise<ClaudeCliAuthStatus> {
    const status = await super.readCliAuthStatus(...input);
    this.authStatuses.push(status);
    return status;
  }

  override createQuery(input: ClaudeQueryInput): Query {
    const options = {
      ...input.options,
      tools: [],
      strictMcpConfig: true,
    } satisfies ClaudeQueryInput["options"];
    this.queryOptions.push(options);
    return super.createQuery({ ...input, options });
  }
}

describe.sequential("real Claude Native Sedes MCP tools", () => {
  it("calls an individual Sedes tool through the query's MCP server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-claude-mcp-"));
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const workspace = await realpath(workspacePath);
    const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude";
    const environment = Object.freeze({
      ...process.env,
      CLAUDE_CONFIG_DIR:
        process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ??
        path.join(os.homedir(), ".claude"),
    });
    const sdk = new SedesOnlyClaudeSdkFacade();

    // No-prompt preflight: refuse to spend capacity outside the subscription.
    const preflight = await probeClaudeSdkDirect({
      sdk,
      executablePath,
      cwd: workspace,
      timeoutMs: 30_000,
      environment,
    });
    expect(preflight.account.apiProvider).toBe("firstParty");
    expect(sdk.authStatuses[0]).toMatchObject({
      loggedIn: true,
      authMethod: "claude.ai",
    });

    const listener = await startLiveAgentToolListener({
      root,
      workspace,
      configuration: configuration(workspace),
      environmentId,
      targetId: "claude-local",
      presentation: { surface: "native", mode: "individual" },
      enabledToolIds: ["agent.context", "thread.status"],
    });
    const reference = listener.issue("mcp");
    const messages: SDKMessage[] = [];
    const permissionRequests: string[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // The startup handshake reports its own zero-turn result, which can
    // arrive after the prompt is sent.
    const session = new ClaudeSdkSession({
      sdk,
      executablePath,
      initializationTimeoutMs: 60_000,
      sessionId: randomUUID(),
      cwd: workspace,
      launch: "new",
      model: REQUIRED_MODEL,
      effort: "low",
      permissionMode: "default",
      // The Sedes UI would ask the user; this approves only Sedes tools.
      canUseTool: async (toolName, input) => {
        permissionRequests.push(toolName);
        return toolName.startsWith("mcp__sedes__")
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Only Sedes tools are allowed." };
      },
      environment,
      agentToolMcp: {
        command: path.resolve("dist/cli/provider-bin/sedes"),
        mode: "individual",
        endpoint: listener.endpoint,
        sourceCapability: reference,
      },
      onMessage: (message) => {
        messages.push(message);
        if (message.type === "result" && message.num_turns > 0) settle();
      },
    });
    try {
      await session.start();
      const init = messages.find(
        (message) => message.type === "system" && message.subtype === "init",
      ) as Extract<SDKMessage, { type: "system"; subtype: "init" }>;
      expect(init.mcp_servers).toContainEqual(
        expect.objectContaining({ name: "sedes", status: "connected" }),
      );
      expect(init.tools).toEqual(
        expect.arrayContaining([
          "mcp__sedes__sedes_agent_context",
          "mcp__sedes__sedes_thread_status",
        ]),
      );
      // The CLI arguments carry only a placeholder for the reference.
      expect(JSON.stringify(sdk.queryOptions.at(-1)?.mcpServers)).not.toContain(
        reference,
      );

      const promptIndex = messages.length;
      session.send({
        operationId: randomUUID(),
        content:
          "Call the mcp__sedes__sedes_agent_context tool exactly once with an empty object, then reply with only the threadId value it returned.",
      });
      await Promise.race([
        settled,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("real_claude_mcp_turn_timed_out")),
            MODEL_TURN_TIMEOUT_MS,
          ),
        ),
      ]);

      const turn = messages.slice(promptIndex);
      const toolUses = turn.flatMap((message) =>
        message.type === "assistant"
          ? message.message.content.filter(
              (block): block is Extract<typeof block, { type: "tool_use" }> =>
                block.type === "tool_use",
            )
          : [],
      );
      expect(toolUses.map(({ name }) => name)).toEqual([
        "mcp__sedes__sedes_agent_context",
      ]);
      expect(permissionRequests).toEqual(["mcp__sedes__sedes_agent_context"]);
      const toolResults = turn.flatMap((message) =>
        message.type === "user" && Array.isArray(message.message.content)
          ? message.message.content.filter(
              (block) =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "tool_result",
            )
          : [],
      ) as { is_error?: boolean; content?: unknown }[];
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.is_error ?? false).toBe(false);
      expect(JSON.stringify(toolResults[0]!.content)).toContain(
        listener.threadId,
      );
      const result = turn.find(
        (message) => message.type === "result" && message.num_turns > 0,
      );
      expect(result).toMatchObject({ subtype: "success" });
      expect(
        (result as Extract<SDKMessage, { type: "result"; subtype: "success" }>)
          .result,
      ).toContain(listener.threadId);
      expect(
        listener.observed.filter(
          ({ url }) => url === "/api/agent-tool-invocations",
        ),
      ).toEqual([
        {
          method: "POST",
          url: "/api/agent-tool-invocations",
          sourceReference: reference,
        },
      ]);
    } finally {
      await session.close();
      await listener.close();
    }
  }, 360_000);
});
