import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  it.each([
    { label: "fresh-thread agent context", previewPage: false },
    { label: "established-thread page preview", previewPage: true },
  ])("calls native Sedes tools with $label", async ({ previewPage }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-claude-mcp-"));
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const workspace = await realpath(workspacePath);
    const visualCode = randomBytes(4).toString("hex").toUpperCase();
    const sourcePath = path.join(workspace, "preview.html");
    if (previewPage) await writeFile(sourcePath, `<!doctype html><html><body style="margin:0;background:white;color:black"><p style="margin:24px;font:72px monospace">${visualCode}</p></body></html>`);
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
      enabledToolIds: ["agent.context", "thread.status", ...(previewPage ? ["page.publish", "page.preview"] : [])],
      pages: previewPage,
      ...(previewPage ? { pageSourceFiles: [sourcePath] } : {}),
    });
    const reference = listener.issue("mcp");
    const messages: SDKMessage[] = [];
    const permissionRequests: string[] = [];
    let settle!: () => void;
    let settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waitForTurn = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([settled, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("real_claude_mcp_turn_timed_out")), MODEL_TURN_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(timer); }
    };
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
          ...(previewPage ? ["mcp__sedes__sedes_page_publish", "mcp__sedes__sedes_page_preview"] : []),
        ]),
      );
      // The CLI arguments carry only a placeholder for the reference.
      expect(JSON.stringify(sdk.queryOptions.at(-1)?.mcpServers)).not.toContain(
        reference,
      );

      let greetingResult: SDKMessage | undefined;
      if (previewPage) {
        // A real first user turn consumes startup metadata. The actual page
        // request is a distinct human turn, never an automatic retry.
        session.send({ operationId: randomUUID(), content: "Hello. Please reply READY without using tools." });
        await waitForTurn();
        greetingResult = messages.findLast(message => message.type === "result" && message.num_turns > 0);
        expect(greetingResult).toMatchObject({ type: "result", subtype: "success" });
        settled = new Promise<void>(resolve => { settle = resolve; });
      }
      const promptIndex = messages.length;
      session.send({
        operationId: randomUUID(),
        content:
          previewPage
            ? `Please publish an HTML page titled Live preview using path ${JSON.stringify(sourcePath)} with a 600 by 240 viewport. Then use the page preview tool on that same path and viewport. Read the eight-character code visible in the returned screenshot; do not read the source through any other tool. Finally read the agent context. Reply with its threadId and a separate line IMAGE_CODE= followed by the exact screenshot code.`
            : "Call the mcp__sedes__sedes_agent_context tool exactly once with an empty object, then reply with only the threadId value it returned.",
      });
      await waitForTurn();
      if (greetingResult) expect(messages).toContain(greetingResult);

      const turn = messages.slice(promptIndex);
      const toolUses = turn.flatMap((message) =>
        message.type === "assistant"
          ? message.message.content.filter(
              (block): block is Extract<typeof block, { type: "tool_use" }> =>
                block.type === "tool_use",
            )
          : [],
      );
      const expectedTools = [...(previewPage ? ["mcp__sedes__sedes_page_publish", "mcp__sedes__sedes_page_preview"] : []), "mcp__sedes__sedes_agent_context"];
      if (toolUses.length === 0) {
        const terminal = turn.find(message => message.type === "result" && message.num_turns > 0);
        const diagnostic = terminal?.type === "result" ? { subtype: terminal.subtype,
          ...("result" in terminal ? { result: terminal.result } : { errors: terminal.errors }) } : { subtype: "missing" };
        throw new Error(`Claude completed without calling the required tool: ${JSON.stringify(diagnostic).slice(0, 4000)}`);
      }
      expect(toolUses.map(({ name }) => name)).toEqual(expectedTools);
      expect(permissionRequests).toEqual(expectedTools);
      const toolResults = turn.flatMap((message) =>
        message.type === "user" && Array.isArray(message.message.content)
          ? message.message.content.filter(
              (block) =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "tool_result",
            )
          : [],
      ) as { tool_use_id?: string; is_error?: boolean; content?: unknown }[];
      expect(toolResults).toHaveLength(expectedTools.length);
      expect(toolResults.every(result => !(result.is_error ?? false))).toBe(true);
      if (previewPage) {
        const previewUse = toolUses.find(use => use.name === "mcp__sedes__sedes_page_preview")!;
        const previewResult = toolResults.find(result => result.tool_use_id === previewUse.id)!;
        expect(JSON.stringify(previewResult.content)).toContain("image/png");
        expect(JSON.stringify(previewResult.content)).toContain('"type":"image"');
        expect(listener.pages!.list(listener.scope, listener.threadId).items).toHaveLength(1);
      }
      const contextUse = toolUses.find(use => use.name === "mcp__sedes__sedes_agent_context")!;
      const contextResult = toolResults.find(result => result.tool_use_id === contextUse.id)!;
      expect(JSON.stringify(contextResult.content)).toContain(
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
      if (previewPage) {
        const finalText = (result as Extract<SDKMessage, { type: "result"; subtype: "success" }>).result;
        expect(finalText.match(/IMAGE_CODE=([A-Z0-9]+)/)?.[1]).toBe(visualCode);
      }
      expect(
        listener.observed.filter(
          ({ url }) => url === "/api/agent-tool-invocations",
        ),
      ).toEqual(expectedTools.map(() => ({ method: "POST", url: "/api/agent-tool-invocations", sourceReference: reference })));
    } finally {
      await session.close();
      await listener.close();
    }
  }, 360_000);
});
