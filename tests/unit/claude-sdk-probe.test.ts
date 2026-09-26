import type {
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type {
  ClaudeCliAuthStatus,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import {
  assertClaudeSubscriptionAuthStatus,
  probeClaudeSdkDirect,
} from "../../src/server/backends/claude/claude-sdk-probe.js";

const subscriptionAuth = Object.freeze({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "Claude Max",
}) satisfies ClaudeCliAuthStatus;

function facade(
  release = "2.1.283",
  streamedRelease: string | null = release,
  streamError?: Error,
  behavior?: {
    readonly endAfterInit?: boolean;
    readonly cleanupError?: Error;
    readonly initialization?: Partial<SDKControlInitializeResponse>;
  },
): ClaudeSdkFacade {
  const initialization = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    },
    ...behavior?.initialization,
  } satisfies SDKControlInitializeResponse;
  return {
    readCliRelease: vi.fn(async () => release),
    readCliAuthStatus: vi.fn(async () => subscriptionAuth),
    createQuery: vi.fn((input) => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
        if (streamedRelease) {
          yield {
            type: "system",
            subtype: "init",
            agents: [],
            apiKeySource: "oauth",
            betas: [],
            claude_code_version: streamedRelease,
            cwd: "/workspace",
            tools: [],
            mcp_servers: [],
            model: "claude-sonnet-5",
            permissionMode: "default",
            slash_commands: [],
            output_style: "default",
            skills: [],
            plugins: [],
            uuid: "00000000-0000-4000-8000-000000000001",
            session_id: input.options.sessionId!,
          } as SDKMessage;
        }
        if (streamError) throw streamError;
        if (!streamedRelease) return;
        if (behavior?.endAfterInit) return;
        await finished;
        if (behavior?.cleanupError) throw behavior.cleanupError;
      })();
      return Object.assign(stream, {
        initializationResult: async () => initialization,
        close: finish,
      }) as unknown as Query;
    }),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    hasSessionTranscript: vi.fn(async () => false),
    renameSession: vi.fn(async () => undefined),
  };
}

describe("probeClaudeSdk", () => {
  it("proves subscription control and stream initialization without a model turn", async () => {
    const sdk = facade();
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).resolves.toMatchObject({
      cliRelease: "2.1.283",
      account: {
        apiProvider: "firstParty",
        subscriptionType: "Claude Max",
      },
    });
    expect(sdk.createQuery).toHaveBeenCalledOnce();
    expect(sdk.readCliRelease).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      "/workspace",
      undefined,
    );
    expect(sdk.readCliAuthStatus).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      "/workspace",
      undefined,
    );
    expect(sdk.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
          persistSession: false,
          sessionId: expect.any(String),
        }),
      }),
    );
  });

  it("threads caller cancellation into the active CLI release probe", async () => {
    const sdk = facade();
    const controller = new AbortController();
    const cancelled = new Error("probe cancelled");
    vi.mocked(sdk.readCliRelease).mockImplementationOnce(
      async (_executable, _timeout, _environment, _cwd, signal) =>
        await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const probing = probeClaudeSdkDirect({
      sdk,
      executablePath: "/usr/local/bin/claude",
      cwd: "/workspace",
      timeoutMs: 1_000,
      environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sdk.readCliRelease).toHaveBeenCalledOnce());

    controller.abort(cancelled);
    await expect(probing).rejects.toBe(cancelled);
    expect(sdk.readCliRelease).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      "/workspace",
      controller.signal,
    );
    expect(sdk.readCliAuthStatus).not.toHaveBeenCalled();
  });

  it("threads caller cancellation into the active CLI auth probe", async () => {
    const sdk = facade();
    const controller = new AbortController();
    const cancelled = new Error("auth probe cancelled");
    vi.mocked(sdk.readCliAuthStatus).mockImplementationOnce(
      async (_executable, _timeout, _environment, _cwd, signal) =>
        await new Promise<ClaudeCliAuthStatus>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const probing = probeClaudeSdkDirect({
      sdk,
      executablePath: "/usr/local/bin/claude",
      cwd: "/workspace",
      timeoutMs: 1_000,
      environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(sdk.readCliAuthStatus).toHaveBeenCalledOnce(),
    );

    controller.abort(cancelled);
    await expect(probing).rejects.toBe(cancelled);
    expect(sdk.readCliRelease).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      "/workspace",
      controller.signal,
    );
    expect(sdk.readCliAuthStatus).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      "/workspace",
      controller.signal,
    );
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("rejects a successful control initialization when stream init is missing", async () => {
    const sdk = facade("2.1.283", null);
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_sdk_stream_initialization_missing");
  });

  it("propagates an iterator failure despite successful control initialization", async () => {
    const sdk = facade(
      "2.1.283",
      "2.1.283",
      new Error("claude_sdk_iterator_failed"),
    );
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_sdk_iterator_failed");
  });

  it("rejects natural stream termination after validated initialization", async () => {
    const sdk = facade("2.1.283", "2.1.283", undefined, {
      endAfterInit: true,
    });
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_sdk_stream_ended_unexpectedly");
  });

  it("ignores iterator errors caused by successful owner cleanup", async () => {
    const sdk = facade("2.1.283", "2.1.283", undefined, {
      cleanupError: new Error("claude_sdk_cleanup_error"),
    });
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).resolves.toMatchObject({ cliRelease: "2.1.283" });
  });

  it("preserves an original admission failure over owner cleanup errors", async () => {
    const sdk = facade("2.1.283", "2.1.283", undefined, {
      cleanupError: new Error("claude_sdk_cleanup_error"),
      initialization: {
        account: { apiProvider: "firstParty" },
      },
    });
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_subscription_auth_unavailable");
  });

  it("rejects a CLI release below the compatibility floor before SDK initialization", async () => {
    const sdk = facade("2.1.240");
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_cli_release_below_minimum");
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("accepts a newer CLI release and reports the compatibility warning", async () => {
    const sdk = facade("2.1.284");
    const onNewerVersion = vi.fn();
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
        onNewerVersion,
      }),
    ).resolves.toMatchObject({ cliRelease: "2.1.284" });
    expect(onNewerVersion).toHaveBeenCalledWith({
      testedThroughVersion: "2.1.283",
      observedVersion: "2.1.284",
    });
  });

  it("rejects an API-key override before SDK initialization", async () => {
    const sdk = facade();
    vi.mocked(sdk.readCliAuthStatus).mockResolvedValueOnce({
      ...subscriptionAuth,
      subscriptionType: undefined,
      apiKeySource: "ANTHROPIC_API_KEY",
    });
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
      }),
    ).rejects.toThrow("claude_subscription_auth_unavailable");
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("accepts a newer compatible streamed CLI release", async () => {
    const sdk = facade("2.1.283", "2.1.284");
    const onNewerVersion = vi.fn();
    await expect(
      probeClaudeSdkDirect({
        sdk,
        executablePath: "/usr/local/bin/claude",
        cwd: "/workspace",
        timeoutMs: 1_000,
        environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
        onNewerVersion,
      }),
    ).resolves.toMatchObject({ cliRelease: "2.1.283" });
    expect(onNewerVersion).toHaveBeenCalledWith({
      testedThroughVersion: "2.1.283",
      observedVersion: "2.1.284",
    });
  });

  it.each([
    ["2.1.240", "claude_cli_release_below_minimum"],
    ["2.1.284-beta.1", "claude_cli_release_prerelease_unsupported"],
  ])(
    "retains incompatible streamed CLI release %s during cleanup",
    async (streamRelease, expectedError) => {
      const sdk = facade("2.1.283", streamRelease);
      await expect(
        probeClaudeSdkDirect({
          sdk,
          executablePath: "/usr/local/bin/claude",
          cwd: "/workspace",
          timeoutMs: 1_000,
          environment: { HOME: "/operator", CLAUDE_CONFIG_DIR: "/claude" },
        }),
      ).rejects.toThrow(expectedError);
    },
  );
});

describe("assertClaudeSubscriptionAuthStatus", () => {
  it.each([
    { ...subscriptionAuth, loggedIn: false },
    { ...subscriptionAuth, authMethod: "console" },
    { ...subscriptionAuth, apiProvider: "bedrock" },
    { ...subscriptionAuth, subscriptionType: undefined },
    { ...subscriptionAuth, apiKeySource: "user" },
    { ...subscriptionAuth, apiKeySource: "oauth" },
  ])("rejects a non-subscription active credential %#", (status) => {
    expect(() => assertClaudeSubscriptionAuthStatus(status)).toThrow(
      "claude_subscription_auth_unavailable",
    );
  });
});
