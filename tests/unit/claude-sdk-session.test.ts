import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";
import { ClaudeRuntimeInstallationAdvisories } from "../../src/server/backends/claude/claude-runtime-installation-advisories.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";

function fakeQuery(
  input: {
    initialization?: Partial<SDKControlInitializeResponse>;
    onCreate?: (options: Options) => void;
    authStatus?: {
      readonly loggedIn: boolean;
      readonly authMethod?: string;
      readonly apiProvider?: string;
      readonly subscriptionType?: string;
      readonly apiKeySource?: string;
    };
    cliRelease?: string;
    streamRelease?: string;
    streamSessionId?: string;
    streamTools?: string[];
    streamSkills?: string[];
    terminalCommands?: string[];
    messages?: readonly SDKMessage[];
    emitStreamInit?: boolean;
    endStream?: boolean;
    streamGate?: Promise<void>;
    initializationGate?: Promise<void>;
    streamError?: Error;
  } = {},
): {
  readonly sdk: ClaudeSdkFacade;
  readonly prompt: () => AsyncIterable<SDKUserMessage>;
  readonly controls: {
    readonly interrupt: ReturnType<typeof vi.fn>;
    readonly setModel: ReturnType<typeof vi.fn>;
    readonly setPermissionMode: ReturnType<typeof vi.fn>;
    readonly applyFlagSettings: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    readonly initializationResult: ReturnType<typeof vi.fn>;
  };
  readonly abortSignal: () => AbortSignal;
} {
  let captured: ClaudeQueryInput | undefined;
  let releaseConsumer!: () => void;
  const consumerClosed = new Promise<void>((resolve) => {
    releaseConsumer = resolve;
  });
  const controls = {
    interrupt: vi.fn(async () => ({ still_queued: [] })),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    close: vi.fn(() => releaseConsumer()),
    initializationResult: vi.fn(async () => {
      await input.initializationGate;
      return initialization;
    }),
  };
  const initialization = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Balanced Claude model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
    account: {
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
      tokenSource: "oauth",
    },
    ...input.initialization,
  } satisfies SDKControlInitializeResponse;

  const sdk = {
    readCliRelease: vi.fn(async () => input.cliRelease ?? "2.1.274"),
    readCliAuthStatus: vi.fn(
      async () =>
        input.authStatus ?? {
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "Claude Max",
        },
    ),
    createQuery(queryInput: ClaudeQueryInput): Query {
      captured = queryInput;
      input.onCreate?.(queryInput.options);
      const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
        await input.streamGate;
        if (input.emitStreamInit !== false) {
          yield {
            type: "system",
            subtype: "init",
            apiKeySource: "oauth",
            claude_code_version: input.streamRelease ?? "2.1.274",
            cwd: queryInput.options.cwd!,
            tools: input.streamTools ?? [],
            mcp_servers: [],
            model: "claude-sonnet-5",
            permissionMode: "default",
            slash_commands: input.streamSkills ?? [],
            ...(input.terminalCommands
              ? { terminal_slash_commands: input.terminalCommands }
              : {}),
            output_style: "default",
            skills: input.streamSkills ?? [],
            plugins: [],
            uuid: crypto.randomUUID(),
            session_id:
              input.streamSessionId ?? "11111111-1111-4111-8111-111111111111",
          };
        }
        for (const message of input.messages ?? []) yield message;
        if (input.streamError) throw input.streamError;
        if (input.endStream) return;
        await consumerClosed;
      })();
      return Object.assign(stream, {
        initializationResult: controls.initializationResult,
        interrupt: controls.interrupt,
        setModel: controls.setModel,
        setPermissionMode: controls.setPermissionMode,
        applyFlagSettings: controls.applyFlagSettings,
        close: controls.close,
      }) as unknown as Query;
    },
    listSessions: vi.fn(),
    getSessionInfo: vi.fn(),
    getSessionMessages: vi.fn(),
    hasSessionTranscript: vi.fn(),
    renameSession: vi.fn(),
  } satisfies ClaudeSdkFacade;

  return {
    sdk,
    prompt: () => {
      if (!captured) throw new Error("query_not_created");
      return captured.prompt as AsyncIterable<SDKUserMessage>;
    },
    controls,
    abortSignal: () => {
      if (!captured?.options.abortController) {
        throw new Error("query_not_created");
      }
      return captured.options.abortController.signal;
    },
  };
}

function systemInitMessage(release: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: release,
    cwd: "/workspace",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: crypto.randomUUID(),
    session_id: "11111111-1111-4111-8111-111111111111",
  };
}

describe("ClaudeSdkSession", () => {
  it.each(["acknowledged", "rejected", "wedged"])("attempts bounded protocol interruption before owned CLI close: %s", async outcome => {
    const fixture = fakeQuery();
    const session = new ClaudeSdkSession({ sdk: fixture.sdk, executablePath: "/usr/local/bin/claude", initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/workspace", launch: "new", environment: { HOME: "/home/test" }, onMessage: () => undefined });
    await session.start();
    if (outcome === "rejected") fixture.controls.interrupt.mockRejectedValue(new Error("native_interrupt_failed"));
    if (outcome === "wedged") fixture.controls.interrupt.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const closing = session.close();
      expect(session.closed).toBe(true);
      expect(session.close()).toBe(closing);
      await expect(session.setModel("other")).rejects.toThrow("not_ready");
      await Promise.resolve();
      expect(fixture.controls.interrupt).toHaveBeenCalledOnce();
      if (outcome === "wedged") {
        expect(fixture.controls.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await closing;
      expect(fixture.controls.close).toHaveBeenCalledOnce();
      expect(fixture.controls.interrupt.mock.invocationCallOrder[0]).toBeLessThan(fixture.controls.close.mock.invocationCallOrder[0]!);
      expect(fixture.abortSignal().aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("admits only classified nonterminal skills and lets command changes revoke them", async () => {
    const fixture = fakeQuery({
      initialization: {
        commands: [
          { name: "review", description: "Review", argumentHint: "" },
          { name: "doctor", description: "Doctor", argumentHint: "" },
        ],
      },
      streamSkills: ["review", "doctor"],
      terminalCommands: ["doctor"],
      messages: [
        {
          type: "system",
          subtype: "commands_changed",
          commands: [
            { name: "review", description: "Changed review", argumentHint: "" },
            { name: "new-skill", description: "New", argumentHint: "" },
          ],
          uuid: crypto.randomUUID(),
          session_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });

    await session.start();
    expect(session.initialization).toMatchObject({
      skillNames: ["review", "doctor"],
      terminalCommandNames: ["doctor"],
    });
    await vi.waitFor(() => expect(session.safeSkills).toEqual([]));
    await session.close();
  });

  it("readmits a retained command only after a fresh init classifies it", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const fixture = fakeQuery({
      initialization: {
        commands: [{ name: "review", description: "Review", argumentHint: "" }],
      },
      streamSkills: ["review"],
      messages: [
        {
          type: "system",
          subtype: "commands_changed",
          commands: [
            { name: "review", description: "Changed review", argumentHint: "" },
          ],
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        },
        {
          type: "system",
          subtype: "init",
          agents: [],
          apiKeySource: "oauth",
          claude_code_version: "2.1.274",
          cwd: "/workspace",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: ["review"],
          terminal_slash_commands: [],
          output_style: "default",
          skills: ["review"],
          plugins: [],
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        },
      ],
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId,
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });

    await session.start();
    await vi.waitFor(() =>
      expect(session.safeSkills).toEqual([
        expect.objectContaining({ commandName: "review" }),
      ]),
    );
    await session.close();
  });

  it("keeps Claude's run-state events enabled over an inherited environment value", async () => {
    const fixture = fakeQuery();
    let observedOptions: Options | undefined;
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/home/test/.local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "0" },
      onMessage: () => undefined,
    });
    const originalCreate = fixture.sdk.createQuery.bind(fixture.sdk);
    fixture.sdk.createQuery = (input) => {
      observedOptions = input.options;
      return originalCreate(input);
    };
    await session.start();
    expect(observedOptions?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    await session.close();
  });

  it("uses the external CLI and subscription login without configuring auth", async () => {
    const fixture = fakeQuery();
    let observedOptions: Options | undefined;
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/home/test/.local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: true,
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });
    const originalCreate = fixture.sdk.createQuery.bind(fixture.sdk);
    fixture.sdk.createQuery = (input) => {
      observedOptions = input.options;
      return originalCreate(input);
    };

    const initialized = await session.start();
    expect(initialized).toMatchObject({
      cliRelease: "2.1.274",
      actualModel: "claude-sonnet-5",
      actualPermissionMode: "default",
      account: {
        apiProvider: "firstParty",
        subscriptionType: "Claude Max",
      },
    });
    expect(observedOptions).toMatchObject({
      cwd: "/workspace",
      pathToClaudeCodeExecutable: "/home/test/.local/bin/claude",
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    });
    // Claude reports its own run state only when Sedes asks for it.
    expect(observedOptions?.env).toEqual({
      HOME: "/home/test",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    });
    expect(fixture.sdk.readCliRelease).toHaveBeenCalledWith(
      "/home/test/.local/bin/claude",
      1_000,
      { HOME: "/home/test" },
      "/workspace",
      expect.any(AbortSignal),
    );
    expect(fixture.sdk.readCliAuthStatus).toHaveBeenCalledWith(
      "/home/test/.local/bin/claude",
      1_000,
      { HOME: "/home/test" },
      "/workspace",
      expect.any(AbortSignal),
    );

    const promptIterator = fixture.prompt()[Symbol.asyncIterator]();
    expect(await promptIterator.next()).toMatchObject({
      done: false,
      value: {
        type: "user",
        message: { role: "user", content: "" },
        isSynthetic: true,
        shouldQuery: false,
      },
    });
    session.send({
      operationId: "22222222-2222-4222-8222-222222222222",
      content: "hello",
    });
    expect(await promptIterator.next()).toMatchObject({
      done: false,
      value: {
        type: "user",
        uuid: "22222222-2222-4222-8222-222222222222",
        session_id: "11111111-1111-4111-8111-111111111111",
        message: { role: "user", content: "hello" },
        origin: { kind: "human" },
      },
    });
    const imageContent = [
      { type: "text" as const, text: "inspect" },
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          data: "aGVsbG8=",
        },
      },
    ];
    session.send({
      operationId: "33333333-3333-4333-8333-333333333333",
      content: imageContent,
    });
    expect(await promptIterator.next()).toMatchObject({
      done: false,
      value: {
        uuid: "33333333-3333-4333-8333-333333333333",
        message: { role: "user", content: imageContent },
      },
    });

    await session.setModel("sonnet");
    await session.setEffort("medium");
    await session.setPermissionMode("dontAsk");
    await session.interrupt();
    expect(fixture.controls.setModel).toHaveBeenCalledWith("sonnet");
    expect(fixture.controls.setPermissionMode).toHaveBeenCalledWith("dontAsk");
    expect(fixture.controls.applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: "medium",
    });
    await session.setEffort(undefined);
    expect(fixture.controls.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: null,
    });
    expect(fixture.controls.interrupt).toHaveBeenCalledOnce();
    await session.close();
  });

  it("rejects API-key-only initialization", async () => {
    const fixture = fakeQuery({
      initialization: {
        account: { apiProvider: "firstParty", apiKeySource: "user" },
      },
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });
    await expect(session.start()).rejects.toThrow(
      "claude_subscription_auth_unavailable",
    );
    expect(session.closed).toBe(true);
  });

  it("rejects an active API-key source before creating a query", async () => {
    const onCreate = vi.fn();
    const fixture = fakeQuery({
      onCreate,
      authStatus: {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
      },
    });
    const environment = {
      HOME: "/home/test",
      PATH: "/usr/local/bin:/usr/bin",
      ANTHROPIC_API_KEY: "not-printed",
    };
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment,
      onMessage: () => undefined,
    });

    await expect(session.start()).rejects.toThrow(
      "claude_subscription_auth_unavailable",
    );
    expect(fixture.sdk.readCliAuthStatus).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      environment,
      "/workspace",
      expect.any(AbortSignal),
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(session.launched).toBe(false);
  });

  it("locks a fork launch down and rejects caller permissions or tools", async () => {
    const onCreate = vi.fn();
    const fixture = fakeQuery({ onCreate });
    const fork = {
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sourceSessionId: "33333333-3333-4333-8333-333333333333",
      resumeSessionAt: "44444444-4444-4444-8444-444444444444",
      cwd: "/workspace",
      launch: "fork" as const,
      environment: {},
      onMessage: () => undefined,
    };
    for (const widened of [
      { permissionMode: "bypassPermissions" as const },
      { allowDangerouslySkipPermissions: true as const },
      { canUseTool: async () => ({ behavior: "allow" as const }) },
      { agentToolMcp: { command: "/usr/bin/sedes", mode: "individual" as const, endpoint: "http://127.0.0.1:4784", sourceCapability: "x".repeat(40) } },
    ]) {
      expect(() => new ClaudeSdkSession({ ...fork, ...widened })).toThrow("claude_sdk_fork_options_invalid");
    }
    const session = new ClaudeSdkSession(fork);
    expect(session.launched).toBe(false);
    await session.start();
    expect(session.launched).toBe(true);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true, tools: [],
      permissionMode: "default", resume: fork.sourceSessionId, forkSession: true, sessionId: fork.sessionId,
      resumeSessionAt: fork.resumeSessionAt,
    }));
    const options = onCreate.mock.calls[0]![0] as Options;
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options).not.toHaveProperty("mcpServers");
    await expect(options.canUseTool!("Write", {}, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" } as never))
      .resolves.toMatchObject({ behavior: "deny", interrupt: true });
    await session.close();
  });

  it("accepts a newer compatible stream release and reports it", async () => {
    const onFailure = vi.fn();
    const onNewerVersion = vi.fn();
    const fixture = fakeQuery({ streamRelease: "2.1.275" });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
      onFailure,
      onNewerVersion,
    });

    await expect(session.start()).resolves.toMatchObject({
      cliRelease: "2.1.275",
    });
    expect(session.closed).toBe(false);
    expect(onNewerVersion).toHaveBeenCalledWith({
      testedThroughVersion: "2.1.274",
      observedVersion: "2.1.275",
    });
    expect(onFailure).not.toHaveBeenCalled();
    await session.close();
  });

  it("clears newer-version evidence when a later init is incompatible", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const advisories = new ClaudeRuntimeInstallationAdvisories();
    const observation = advisories.beginObservation("conversation_session");
    const onFailure = vi.fn();
    const fixture = fakeQuery({
      cliRelease: "2.1.275",
      streamRelease: "2.1.275",
      messages: [systemInitMessage("2.1.240")],
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onVersionAssessment: observation.observeVersionAssessment,
      onVersionAssessmentFailed: observation.failed,
      onMessage: () => undefined,
      onFailure,
    });

    await session.start();
    await vi.waitFor(() => expect(session.closed).toBe(true));
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "claude_cli_release_below_minimum",
      }),
    );
    expect(advisories.active()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("retains newer-version evidence for unrelated later stream failures", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const advisories = new ClaudeRuntimeInstallationAdvisories();
    const observation = advisories.beginObservation("conversation_session");
    const fixture = fakeQuery({
      cliRelease: "2.1.275",
      streamRelease: "2.1.275",
      streamError: new Error("claude_unrelated_stream_failure"),
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onVersionAssessment: observation.observeVersionAssessment,
      onVersionAssessmentFailed: observation.failed,
      onMessage: () => undefined,
    });

    await session.start();
    await vi.waitFor(() => expect(session.closed).toBe(true));
    expect(advisories.active()[0]?.message.text).toContain("Running 2.1.275");
    vi.restoreAllMocks();
  });

  it("rejects a CLI release below the floor before creating a query", async () => {
    const onCreate = vi.fn();
    const onVersionAssessmentFailed = vi.fn();
    const fixture = fakeQuery({ cliRelease: "2.1.240", onCreate });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onVersionAssessmentFailed,
      onMessage: () => undefined,
    });

    await expect(session.start()).rejects.toThrow(
      "claude_cli_release_below_minimum",
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onVersionAssessmentFailed).toHaveBeenCalledOnce();
  });

  it("rejects a stream initialized for another native session", async () => {
    const fixture = fakeQuery({
      streamSessionId: "99999999-9999-4999-8999-999999999999",
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });

    await expect(session.start()).rejects.toThrow(
      "claude_session_identity_mismatch",
    );
    expect(session.closed).toBe(true);
    expect(fixture.controls.close).toHaveBeenCalledOnce();
  });

  it("rejects an init that still enables reset-producing plan tools", async () => {
    const fixture = fakeQuery({ streamTools: ["Read", "ExitPlanMode"] });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });

    await expect(session.start()).rejects.toThrow(
      "claude_reset_producing_tools_enabled",
    );
    expect(session.closed).toBe(true);
  });

  it("terminates when a later event belongs to another native session", async () => {
    const onFailure = vi.fn();
    const onMessage = vi.fn();
    const fixture = fakeQuery({
      messages: [
        {
          type: "system",
          subtype: "session_state_changed",
          state: "running",
          uuid: "99999999-9999-4999-8999-999999999999",
          session_id: "88888888-8888-4888-8888-888888888888",
        },
      ],
    });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "resume",
      environment: { HOME: "/home/test" },
      onMessage,
      onFailure,
    });

    await session.start();
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "claude_session_identity_mismatch",
        }),
      );
    });
    expect(session.closed).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(fixture.controls.close).toHaveBeenCalledOnce();
  });

  it("rejects and closes when the stream ends before init", async () => {
    const onFailure = vi.fn();
    const fixture = fakeQuery({ emitStreamInit: false, endStream: true });
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
      onFailure,
    });

    await expect(session.start()).rejects.toThrow(
      "claude_sdk_session_ended_unexpectedly",
    );
    expect(session.closed).toBe(true);
    expect(fixture.controls.close).toHaveBeenCalledOnce();
    expect(fixture.abortSignal().aborted).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not resolve from control initialization before delayed stream validation", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const fixture = fakeQuery({
      streamGate,
      streamRelease: "2.1.275",
    });
    const onNewerVersion = vi.fn();
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
      onNewerVersion,
    });
    let outcome = "pending";
    const started = session.start().then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : "unknown";
      },
    );
    await vi.waitFor(() => {
      expect(fixture.controls.initializationResult).toHaveBeenCalledOnce();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toBe("pending");

    releaseStream();
    await started;
    expect(outcome).toBe("resolved");
    expect(session.closed).toBe(false);
    expect(onNewerVersion).toHaveBeenCalledWith({
      testedThroughVersion: "2.1.274",
      observedVersion: "2.1.275",
    });
    await session.close();
  });

  it("reports direct permission callback delivery success and failure", async () => {
    let queryOptions: Options | undefined;
    const fixture = fakeQuery({
      onCreate: (options) => {
        queryOptions = options;
      },
    });
    const canUseTool = vi
      .fn()
      .mockResolvedValueOnce({
        behavior: "allow",
        toolUseID: "tool-1",
        decisionClassification: "user_temporary",
      })
      .mockRejectedValueOnce(new Error("permission callback failed"));
    const deliveredGate = deferred<void>();
    const delivered = vi.fn(async () => await deliveredGate.promise);
    const deliveryFailed = vi.fn();
    const session = new ClaudeSdkSession({
      sdk: fixture.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace",
      launch: "new",
      environment: { HOME: "/home/test" },
      canUseTool,
      onPermissionResponseDelivered: delivered,
      onPermissionResponseDeliveryFailed: deliveryFailed,
      onMessage: () => undefined,
    });
    await session.start();
    const callback = queryOptions?.canUseTool;
    if (!callback) throw new Error("can_use_tool_not_installed");

    const allowed = callback(
      "Read",
      {},
      {
        signal: new AbortController().signal,
        requestId: "request-1",
        toolUseID: "tool-1",
      },
    );
    let allowedSettled = false;
    void allowed.then(() => {
      allowedSettled = true;
    });
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(allowedSettled).toBe(false);
    deliveredGate.resolve();
    await expect(allowed).resolves.toMatchObject({ behavior: "allow" });
    expect(delivered).toHaveBeenCalledWith({
      requestId: "request-1",
      toolUseID: "tool-1",
    });
    expect(deliveryFailed).not.toHaveBeenCalled();

    await expect(
      callback(
        "Read",
        {},
        {
          signal: new AbortController().signal,
          requestId: "request-2",
          toolUseID: "tool-2",
        },
      ),
    ).rejects.toThrow("permission callback failed");
    expect(deliveryFailed).toHaveBeenCalledWith({
      requestId: "request-2",
      toolUseID: "tool-2",
      error: expect.objectContaining({ message: "permission callback failed" }),
    });
    await session.close();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle as (value?: T) => void;
  });
  return { promise, resolve };
}
