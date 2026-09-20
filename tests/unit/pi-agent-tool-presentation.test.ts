import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPiAgentToolCliEnvironment,
  resolvePiAgentToolTurnPresentation,
} from "../../src/server/backends/pi/pi-agent-tool-presentation.js";
import { createPiCliBashToolDefinition } from "../../src/server/backends/pi/pi-sdk-session.js";
import { PiToolIdentityCatalog } from "../../src/server/backends/pi/pi-tool-identities.js";
import {
  type AgentThreadControlToolServices,
  createThreadForkToolDefinition,
  createThreadMessagesToolDefinition,
  createThreadSendToolDefinition,
} from "../../src/server/agent-tools/tools/thread-control-tools.js";

const descriptors = [
  {
    toolName: "sedes_agent_context",
    toolId: "agent.context",
    schemaVersion: 2,
    readOnly: true,
  },
  {
    toolName: "sedes_workspace_write",
    toolId: "workspace.write",
    schemaVersion: 1,
    readOnly: false,
  },
] as const;

const environment = {
  SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
    "m3-test-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
  SEDES_AGENT_TOOL_CLI_MODE: "progressive",
  executableDirectory: "/opt/sedes/bin",
} as const;

afterEach(() => vi.unstubAllEnvs());

describe("Pi agent tool presentation", () => {
  it("builds CLI context from the strict local HTTP endpoint contract", () => {
    expect(
      createPiAgentToolCliEnvironment(
        {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
        environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY,
        "progressive",
      ),
    ).toEqual(environment);
  });

  it.each([
    "http://localhost:4784",
    "http://192.168.1.2:4784",
    "https://127.0.0.1:4784",
    "http://127.0.0.1:4784/api",
  ])("rejects unsupported Pi CLI endpoint %s", (endpoint) => {
    expect(() =>
      createPiAgentToolCliEnvironment(
        {
          availability: "available",
          endpoint,
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
        environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY,
        "progressive",
      ),
    ).toThrow("pi_agent_tool_cli_environment_invalid");
  });

  it("rejects an invalid CLI presentation mode", () => {
    expect(() =>
      createPiAgentToolCliEnvironment(
        {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
        environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY,
        "hybrid" as never,
      ),
    ).toThrow("pi_agent_tool_cli_environment_invalid");
  });

  it("classifies messages as read-only and send/fork as actions under stable native names", () => {
    const services = {} as AgentThreadControlToolServices;
    const definitions = [
      createThreadMessagesToolDefinition(services),
      createThreadSendToolDefinition(services),
      createThreadForkToolDefinition(services),
    ];
    const controlDescriptors = definitions.map((definition) => ({
      toolName: definition.adapters.pi!.name,
      toolId: definition.id,
      schemaVersion: definition.schemaVersion,
      readOnly: definition.effects.application === "read",
    }));

    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "native", mode: "individual" },
          accessBoundary: "environment",
          enabledToolIds: definitions.map(({ id }) => id),
        },
        controlDescriptors,
      ),
    ).toEqual({
      enabledNativeToolNames: new Set([
        "sedes_thread_messages",
        "sedes_thread_send",
        "sedes_thread_fork",
      ]),
      enabledReadOnlyNativeToolNames: new Set(["sedes_thread_messages"]),
    });
  });

  it("derives the exact native names in fixed descriptor order", () => {
    const result = resolvePiAgentToolTurnPresentation(
      {
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        enabledToolIds: ["workspace.write", "agent.context"],
      },
      descriptors,
    );

    expect([...result.enabledNativeToolNames]).toEqual([
      "sedes_agent_context",
      "sedes_workspace_write",
    ]);
    expect([...result.enabledReadOnlyNativeToolNames]).toEqual([
      "sedes_agent_context",
    ]);
  });

  it("exposes no native names in CLI or disabled mode and ignores stale native IDs", () => {
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context"],
        },
        descriptors,
      ).enabledNativeToolNames,
    ).toEqual(new Set());
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: false,
          presentation: { surface: "native", mode: "individual" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context"],
        },
        descriptors,
      ).enabledNativeToolNames,
    ).toEqual(new Set());
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "native", mode: "individual" },
          accessBoundary: "environment",
          enabledToolIds: ["not.eligible", "agent.context"],
        },
        descriptors,
      ).enabledNativeToolNames,
    ).toEqual(new Set(["sedes_agent_context"]));
  });

  it("exposes the stable progressive lanes from exact enabled effects", () => {
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context", "workspace.write"],
        },
        descriptors,
        "ask",
      ),
    ).toEqual({
      enabledNativeToolNames: new Set([
        "sedes_catalog",
        "sedes_read",
        "sedes_act",
      ]),
      enabledReadOnlyNativeToolNames: new Set(["sedes_catalog", "sedes_read"]),
    });
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context", "workspace.write"],
        },
        descriptors,
        "read_only",
      ).enabledNativeToolNames,
    ).toEqual(new Set(["sedes_catalog", "sedes_read"]));
  });

  it("keeps CLI presentation independent of runtime CLI availability", () => {
    expect(
      resolvePiAgentToolTurnPresentation(
        {
          enabled: true,
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context", "removed.tool"],
        },
        descriptors,
      ).enabledNativeToolNames,
    ).toEqual(new Set());
  });

  it("applies execution variables when agent-tool CLI integration is disabled", async () => {
    vi.stubEnv("REMOVE_THIS", "ambient");
    let observed: NodeJS.ProcessEnv | undefined;
    const tool = createPiCliBashToolDefinition("/workspace", undefined, {
      exec: async (_command, _cwd, options) => { observed = options.env; return { exitCode: 0 }; },
    }, { SESSION_VALUE: "scoped", REMOVE_THIS: null, EMPTY: "" });
    await tool.execute("env-call", { command: "true" }, undefined, undefined, { sessionManager: { getSessionId: () => "env-session", getSessionFile: () => undefined }, model: undefined, thinkingLevel: "low" } as never);
    expect(observed).toMatchObject({ SESSION_VALUE: "scoped", EMPTY: "" });
    expect(observed).not.toHaveProperty("REMOVE_THIS");
    expect(observed).not.toHaveProperty("SEDES_AGENT_TOOL_SOURCE_CAPABILITY");
    expect(process.env.REMOVE_THIS).toBe("ambient");
    expect(process.env.SESSION_VALUE).toBeUndefined();
  });

  it("isolates execution variables and explicit unsets in actual Pi SDK Bash subprocesses", async () => {
    vi.stubEnv("PROJECT_ENV_TEST_DROP", "ambient");
    const command = 'printf "%s|%s" "$PROJECT_ENV_TEST_VALUE" "${PROJECT_ENV_TEST_DROP-unset}"';
    const run = async (value: string, drop: string | null) => {
      const tool = createPiCliBashToolDefinition(process.cwd(), undefined, undefined, {
        PROJECT_ENV_TEST_VALUE: value, PROJECT_ENV_TEST_DROP: drop,
      });
      const result = await tool.execute("environment-isolation", { command }, undefined, undefined, {
        sessionManager: { getSessionId: () => value, getSessionFile: () => undefined },
        model: undefined, thinkingLevel: "low",
      } as never);
      return result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    };
    const [first, second] = await Promise.all([run("first", "set"), run("second", null)]);
    expect(first).toBe("first|set");
    expect(second).toBe("second|unset");
    expect(process.env.PROJECT_ENV_TEST_DROP).toBe("ambient");
    expect(process.env.PROJECT_ENV_TEST_VALUE).toBeUndefined();
  });

  it("injects only session-local Sedes variables while preserving bash", async () => {
    const processValueBefore = process.env.SEDES_AGENT_TOOL_SOURCE_CAPABILITY;
    vi.stubEnv("SEDES_AGENT_TOOL_CLIENT_TOKEN", "must-not-reach-pi");
    vi.stubEnv("SEDES_AGENT_TOOL_CLI_MODE", "individual");
    let observed:
      | {
          readonly command: string;
          readonly cwd: string;
          readonly env?: NodeJS.ProcessEnv;
        }
      | undefined;
    const tool = createPiCliBashToolDefinition("/workspace", environment, {
      exec: async (command, cwd, options) => {
        observed = { command, cwd, env: options.env };
        options.onData(Buffer.from("ok"));
        return { exitCode: 0 };
      },
    });

    expect(tool.name).toBe("bash");
    expect(
      Object.keys(
        (tool.parameters as unknown as { properties: object }).properties,
      ),
    ).toEqual(["command", "timeout"]);
    await tool.execute(
      "call-one",
      { command: "sedes tool list --json" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => "pi-session",
          getSessionFile: () => undefined,
        },
        model: undefined,
        thinkingLevel: "low",
      } as never,
    );
    expect(observed).toMatchObject({
      command: "sedes tool list --json",
      cwd: "/workspace",
      env: {
        SEDES_AGENT_TOOL_ENDPOINT: environment.SEDES_AGENT_TOOL_ENDPOINT,
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
          environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY,
        SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      },
    });
    expect(observed?.env?.PATH).toMatch(/^\/opt\/sedes\/bin:/);
    expect(observed?.env?.PATH).toContain(process.env.PATH);
    expect(observed?.env?.SEDES_AGENT_TOOL_CLIENT_TOKEN).toBeUndefined();
    expect(process.env.SEDES_AGENT_TOOL_SOURCE_CAPABILITY).toBe(
      processValueBefore,
    );
  });

  it("authenticates the exact SDK bash override as canonical builtin bash", () => {
    const identity = new PiToolIdentityCatalog(
      [
        {
          name: "bash",
          sourceInfo: { source: "sdk", path: "<sdk:bash>" },
        },
      ],
      [],
      [],
      new Set(["bash"]),
    ).require("bash");
    expect(identity).toEqual({
      registrationId: "pi:builtin:bash",
      origin: "pi_builtin",
      canonicalKind: "bash",
      displayName: "bash",
    });
    expect(
      () =>
        new PiToolIdentityCatalog(
          [
            {
              name: "bash",
              sourceInfo: { source: "sdk", path: "<sdk:other>" },
            },
          ],
          [],
          [],
          new Set(["bash"]),
        ),
    ).toThrow("pi_builtin_tool_override_untrusted");
  });
});
