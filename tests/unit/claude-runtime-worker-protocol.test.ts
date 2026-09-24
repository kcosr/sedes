import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/index.js";
import { SidecarProtocolDeliveryError } from "../../src/internal/sidecar-protocol/contracts.js";
import { readClaudeSessionHistory } from "../../src/server/backends/claude/claude-session-history.js";
import type { ClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";
import {
  CLAUDE_RUNTIME_MAXIMUM_HISTORY_RESPONSE_BYTES,
  CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES,
  claudeRuntimeCanUseToolOperation,
  claudeRuntimePermissionResponseAckOperation,
  claudeRuntimeInitializeOperation,
  claudeRuntimeProbeOperation,
  claudeRuntimeQueryOpenOperation,
  claudeRuntimeQueryOpenRequestSchema,
  claudeRuntimeQuerySendRequestSchema,
  claudeRuntimeWorkerOperations,
  registerClaudeRuntimeV1HostOperations,
  registerClaudeRuntimeV1WorkerOperations,
} from "../../src/server/backends/claude/worker/claude-runtime-v1.js";
import {
  ClaudeRuntimeWorkerHost,
  type ClaudeRuntimeWorkerProtocolPeer,
} from "../../src/server/backends/claude/worker/claude-runtime-worker-host.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const context = () => ({
  requestId: randomUUID(),
  signal: new AbortController().signal,
});

describe("claude_runtime@1 protocol", () => {
  it("admits bounded permission metadata with explicit false hints", () => {
    expect(claudeRuntimeCanUseToolOperation.requestSchema.safeParse({
      queryId: QUERY_ID, toolName: "Read", input: {},
      options: { toolUseID: "tool-1", requestId: "permission-1", defaultToNo: false,
        suppressAlwaysAllowRule: false, mcpServer: { name: "fixture", source: "sdk" } },
    }).success).toBe(true);
  });

  it.each([
    { defaultToNo: "yes" },
    { suppressAlwaysAllowRule: "no" },
    { mcpServer: { name: "", source: "sdk" } },
    { mcpServer: { name: "x".repeat(513), source: "sdk" } },
    { mcpServer: { name: "fixture", source: "x".repeat(121) } },
    { mcpServer: { name: "fixture", source: "sdk", trusted: true } },
  ])("rejects malformed permission metadata %j", (metadata) => {
    expect(
      claudeRuntimeCanUseToolOperation.requestSchema.safeParse({
        queryId: QUERY_ID,
        toolName: "Read",
        input: {},
        options: { toolUseID: "tool-1", requestId: "permission-1", ...metadata },
      }).success,
    ).toBe(false);
  });

  it("publishes one exact closed worker inventory and the parked reverse operation", () => {
    const workerRegistry = new SidecarOperationRegistry();
    const noHandler = vi.fn(async () => ({})) as never;
    registerClaudeRuntimeV1WorkerOperations(workerRegistry, {
      initialize: noHandler,
      probe: noHandler,
      listSessions: noHandler,
      getSessionInfo: noHandler,
      getSessionMessages: noHandler,
      renameSession: noHandler,
      openQuery: noHandler,
      sendQuery: noHandler,
      interruptQuery: noHandler,
      setQueryModel: noHandler,
      setQueryEffort: noHandler,
      setQueryPermissionMode: noHandler,
      closeQuery: noHandler,
    });
    expect(workerRegistry.capabilities()).toEqual([
      {
        capabilityId: "claude_runtime",
        majorVersion: 1,
        operations: [
          "query.close",
          "query.interrupt",
          "query.open",
          "query.send",
          "query.set_effort",
          "query.set_model",
          "query.set_permission_mode",
          "runtime.initialize",
          "runtime.probe",
          "session.info",
          "session.list",
          "session.messages",
          "session.rename",
        ],
      },
    ]);
    expect(claudeRuntimeWorkerOperations).toHaveLength(13);

    const hostRegistry = new SidecarOperationRegistry();
    registerClaudeRuntimeV1HostOperations(hostRegistry, {
      canUseTool: noHandler,
      acknowledgePermissionResponse: noHandler,
    });
    expect(hostRegistry.capabilities()).toEqual([
      {
        capabilityId: "claude_runtime",
        majorVersion: 1,
        operations: ["query.can_use_tool", "query.permission_response_ack"],
      },
    ]);
    expect(claudeRuntimeCanUseToolOperation.maximumDeadlineMilliseconds).toBe(
      "caller_abort",
    );
    expect(claudeRuntimeInitializeOperation.maximumDeadlineMilliseconds).toBe(
      "caller_abort",
    );
    expect(claudeRuntimeProbeOperation.maximumDeadlineMilliseconds).toBe(
      "caller_abort",
    );
    expect(claudeRuntimeQueryOpenOperation.maximumDeadlineMilliseconds).toBe(
      "caller_abort",
    );
    expect(CLAUDE_RUNTIME_MAXIMUM_HISTORY_RESPONSE_BYTES).toBeLessThan(
      CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES,
    );
  });

  it("rejects ambiguous query launches and recaptures SDK data as bounded JSON", () => {
    expect(
      claudeRuntimeQueryOpenRequestSchema.safeParse({
        queryId: QUERY_ID,
        sessionId: SESSION_ID,
        cwd: "/workspace",
        launch: "fork",
        enableCanUseTool: false,
        environment: {},
      }).success,
    ).toBe(false);
    expect(
      claudeRuntimePermissionResponseAckOperation.requestSchema.safeParse({
        queryId: QUERY_ID,
        requestId: "permission-1",
        toolUseID: "tool-1",
      }).success,
    ).toBe(false);
    expect(
      claudeRuntimePermissionResponseAckOperation.requestSchema.safeParse({
        queryId: QUERY_ID,
        requestId: "permission-1",
        toolUseID: "tool-1",
        adopted: false,
      }).success,
    ).toBe(true);
    expect(
      claudeRuntimeQueryOpenRequestSchema.safeParse({
        queryId: QUERY_ID,
        sessionId: SESSION_ID,
        cwd: "/workspace",
        launch: "new",
        enableCanUseTool: false,
        environment: { ANTHROPIC_API_KEY: "forbidden" },
      }).success,
    ).toBe(false);
    expect(
      claudeRuntimeQueryOpenRequestSchema.safeParse({
        queryId: QUERY_ID,
        sessionId: SESSION_ID,
        cwd: "/workspace",
        launch: "new",
        enableCanUseTool: true,
        environment: {
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "a".repeat(32),
          SEDES_AGENT_TOOL_CLI_MODE: "progressive",
          PATH: "/worker/bin:/usr/bin",
        },
      }).success,
    ).toBe(true);
    expect(
      claudeRuntimeQueryOpenRequestSchema.safeParse({
        queryId: QUERY_ID,
        sessionId: SESSION_ID,
        cwd: "relative",
        launch: "new",
        enableCanUseTool: false,
        environment: {},
      }).success,
    ).toBe(false);
    expect(
      claudeRuntimeQueryOpenRequestSchema.safeParse({
        queryId: QUERY_ID,
        sessionId: SESSION_ID,
        cwd: "/workspace",
        launch: "new",
        sourceSessionId: SESSION_ID,
        enableCanUseTool: false,
        environment: {},
      }).success,
    ).toBe(false);

    const parsed = claudeRuntimeQuerySendRequestSchema.parse({
      queryId: QUERY_ID,
      operationId: OPERATION_ID,
      content: [{ type: "text", text: "hello" }],
    });
    expect(Object.isFrozen(parsed.content)).toBe(true);
    expect(Object.isFrozen((parsed.content as readonly object[])[0])).toBe(
      true,
    );
    expect(
      Object.getPrototypeOf((parsed.content as readonly object[])[0]),
    ).toBe(null);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(
      claudeRuntimeQuerySendRequestSchema.safeParse({
        queryId: QUERY_ID,
        operationId: OPERATION_ID,
        content: cyclic,
      }).success,
    ).toBe(false);
  });
});

describe("ClaudeRuntimeWorkerHost", () => {
  it("resolves the first Claude executable from the worker PATH", async () => {
    const previousPath = process.env.PATH;
    const root = await mkdtemp("/tmp/sedes-claude-worker-path-test-");
    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    const configDirectory = path.join(root, "config");
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
    ]);
    await symlink(process.execPath, path.join(firstDirectory, "claude"));
    await symlink("/missing/claude", path.join(secondDirectory, "claude"));
    process.env.PATH = `${firstDirectory}${path.delimiter}${secondDirectory}`;
    const sdk = helperFacade();
    const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
    try {
      await expect(
        host.handlers.initialize(
          {
            executablePath: "claude",
            configDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).resolves.toMatchObject({ initialized: true, configDirectory });
      await expect(
        host.handlers.probe({ cwd: "/workspace" }, context()),
      ).rejects.toThrow("claude_subscription_auth_unavailable");
      expect(sdk.readCliRelease).toHaveBeenCalledWith(
        process.execPath,
        1_000,
        expect.any(Object),
        "/workspace",
        expect.any(AbortSignal),
      );
    } finally {
      await host.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true });
    }
  });

  it("initializes one native namespace and executes session helpers there", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    await chmod(configDirectory, 0o775);
    const sdk = helperFacade();
    const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
    try {
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).resolves.toEqual({
        initialized: true,
        configDirectory,
      });
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(configDirectory);

      await expect(
        host.handlers.getSessionMessages(
          { sessionId: SESSION_ID, dir: "/workspace", maintenance: true },
          context(),
        ),
      ).resolves.toEqual({
        nextCursor: null,
        messages: [
          expect.objectContaining({
            session_id: SESSION_ID,
            timestamp: "2026-08-27T12:00:00.000Z",
            origin: { kind: "task-notification" },
          }),
        ],
      });
      expect(sdk.getSessionMessages).toHaveBeenCalledWith(
        SESSION_ID,
        { dir: "/workspace" },
        expect.objectContaining({ CLAUDE_CONFIG_DIR: configDirectory }),
      );
      await host.handlers.renameSession(
        { sessionId: SESSION_ID, title: "Remote title", dir: "/workspace" },
        context(),
      );
      expect(sdk.renameSession).toHaveBeenCalledWith(
        SESSION_ID,
        "Remote title",
        { dir: "/workspace" },
        expect.objectContaining({ CLAUDE_CONFIG_DIR: configDirectory }),
      );
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory: "/other/config",
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).rejects.toThrow("claude_runtime_initialization_mismatch");
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  it.each(["environment", "home", "symlink"] as const)(
    "resolves the omitted native config directory inside the worker from %s",
    async (source) => {
      const root = await mkdtemp("/tmp/sedes-claude-default-");
      const previousConfig = process.env.CLAUDE_CONFIG_DIR;
      const previousHome = process.env.HOME;
      const actualDirectory = path.join(root, "actual-config");
      const sdk = helperFacade();
      const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
      try {
        process.env.HOME = root;
        delete process.env.CLAUDE_CONFIG_DIR;
        await mkdir(actualDirectory, { mode: 0o700 });
        let expected = actualDirectory;
        if (source === "environment")
          process.env.CLAUDE_CONFIG_DIR = actualDirectory;
        else if (source === "symlink")
          await symlink(actualDirectory, path.join(root, ".claude"));
        else {
          expected = path.join(root, ".claude");
          await mkdir(expected, { mode: 0o700 });
        }
        const request = {
          executablePath: process.execPath,
          initializationTimeoutMs: 1_000,
        };
        await expect(
          host.handlers.initialize(request, context()),
        ).resolves.toEqual({ initialized: true, configDirectory: expected });
        const expectedOverride =
          source === "environment" ? expected : undefined;
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(expectedOverride);
        await host.handlers.getSessionMessages(
          { sessionId: SESSION_ID, dir: "/workspace" },
          context(),
        );
        const environment = vi
          .mocked(sdk.getSessionMessages)
          .mock.calls.at(-1)![2];
        if (expectedOverride === undefined)
          expect(environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
        else
          expect(environment).toMatchObject({
            CLAUDE_CONFIG_DIR: expectedOverride,
          });
        // Native initialization may rewrite process.env, but unchanged desired
        // omission stays the same namespace and cannot silently become explicit.
        await expect(
          host.handlers.initialize(request, context()),
        ).resolves.toEqual({ initialized: true, configDirectory: expected });
        await expect(
          host.handlers.initialize(
            { ...request, configDirectory: expected },
            context(),
          ),
        ).rejects.toThrow("claude_runtime_initialization_mismatch");
      } finally {
        await host.close();
        if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfig;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(root, { recursive: true });
      }
    },
  );

  it("fails closed when the execution account's default native store does not exist", async () => {
    const root = await mkdtemp("/tmp/sedes-claude-missing-default-");
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousHome = process.env.HOME;
    const sdk = helperFacade();
    const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
    try {
      process.env.HOME = root;
      delete process.env.CLAUDE_CONFIG_DIR;
      await expect(
        host.handlers.initialize(
          { executablePath: process.execPath, initializationTimeoutMs: 1_000 },
          context(),
        ),
      ).rejects.toThrow("claude_runtime_config_directory_invalid");
      expect(sdk.getSessionMessages).not.toHaveBeenCalled();
    } finally {
      await host.close();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { recursive: true });
    }
  });

  it("keeps explicit overrides authoritative and rejects their noncanonical aliases", async () => {
    const root = await mkdtemp("/tmp/sedes-claude-override-");
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const actualDirectory = path.join(root, "actual-config");
    const alias = path.join(root, "config-alias");
    const host = new ClaudeRuntimeWorkerHost({
      sdk: helperFacade(),
      peer: inertPeer(),
    });
    try {
      await mkdir(actualDirectory, { mode: 0o700 });
      await symlink(actualDirectory, alias);
      process.env.CLAUDE_CONFIG_DIR = "/not/the/selected/native/store";
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory: alias,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).rejects.toThrow("claude_runtime_config_directory_invalid");
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory: actualDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).resolves.toEqual({
        initialized: true,
        configDirectory: actualDirectory,
      });
    } finally {
      await host.close();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      await rm(root, { recursive: true });
    }
  });

  it("rejects a world-writable native config directory", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    await chmod(configDirectory, 0o777);
    const host = new ClaudeRuntimeWorkerHost({
      sdk: helperFacade(),
      peer: inertPeer(),
    });
    try {
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).rejects.toThrow("claude_runtime_config_directory_invalid");
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("retries initialization after configuration verification rejects", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const host = new ClaudeRuntimeWorkerHost({
      sdk: helperFacade(),
      peer: inertPeer(),
    });
    try {
      await expect(
        host.handlers.initialize(
          {
            executablePath: "/missing/claude",
            configDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).rejects.toThrow("claude_runtime_executable_invalid");
      await expect(
        host.handlers.initialize(
          {
            executablePath: process.execPath,
            configDirectory,
            initializationTimeoutMs: 1_000,
          },
          context(),
        ),
      ).resolves.toMatchObject({ initialized: true, configDirectory });
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("owns one SDK query, emits bounded messages, and reverses permissions", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const events: unknown[] = [];
    const queryFixture = queryFacade();
    const peer: ClaudeRuntimeWorkerProtocolPeer = {
      call: vi.fn(async (definition) =>
        definition.operation === "query.permission_response_ack"
          ? { acknowledged: true as const }
          : {
              behavior: "allow" as const,
              toolUseID: "tool-1",
              decisionClassification: "user_temporary" as const,
            },
      ) as ClaudeRuntimeWorkerProtocolPeer["call"],
      sendEvent: vi.fn(async (event) => {
        events.push(event);
      }),
      close: vi.fn(async () => undefined),
    };
    const host = new ClaudeRuntimeWorkerHost({ sdk: queryFixture.sdk, peer });
    try {
      await host.handlers.initialize(
        {
          executablePath: process.execPath,
          configDirectory,
          initializationTimeoutMs: 1_000,
          startupEnvironmentVariables: { FROM_STARTUP: { kind: "literal", value: "startup" }, REMOVED: { kind: "literal", value: "startup" } },
          startupEnvironment: { FROM_STARTUP: "startup", REMOVED: "startup", PATH: "/applied/startup/bin" },
        },
        context(),
      );
      const opened = await host.handlers.openQuery(
        {
          queryId: QUERY_ID,
          sessionId: SESSION_ID,
          cwd: "/workspace",
          launch: "new",
          enableCanUseTool: true,
          environment: { SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "x".repeat(40), SEDES_AGENT_TOOL_CLI_MODE: "progressive", PATH: "/trusted/cli:/wrong/ambient/bin" },
          executionEnvironment: { SESSION_VALUE: "query", REMOVED: null },
        },
        context(),
      );
      expect(queryFixture.options().env).toMatchObject({ FROM_STARTUP: "startup", SESSION_VALUE: "query", PATH: "/trusted/cli:/applied/startup/bin" });
      expect(queryFixture.options().env).not.toHaveProperty("REMOVED");
      expect(process.env.SESSION_VALUE).toBeUndefined();
      expect(opened.queryId).toBe(QUERY_ID);
      expect(opened.startupProbeUuid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(events).toEqual([
        expect.objectContaining({
          event: "query.message",
          payload: expect.objectContaining({ queryId: QUERY_ID }),
        }),
      ]);
      const canUseTool = queryFixture.options().canUseTool!;
      await expect(
        canUseTool(
          "Read",
          { file_path: "/workspace/file" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
            requestId: "permission-1",
            defaultToNo: true,
            suppressAlwaysAllowRule: false,
            mcpServer: {
              name: "untrusted-server-label",
              source: "future-config-source",
            },
          },
        ),
      ).resolves.toMatchObject({ behavior: "allow", toolUseID: "tool-1" });
      expect(peer.call).toHaveBeenCalledWith(
        claudeRuntimeCanUseToolOperation,
        expect.objectContaining({
          queryId: QUERY_ID,
          toolName: "Read",
          options: expect.objectContaining({
            defaultToNo: true,
            suppressAlwaysAllowRule: false,
            mcpServer: {
              name: "untrusted-server-label",
              source: "future-config-source",
            },
          }),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(peer.call).toHaveBeenCalledWith(
        claudeRuntimePermissionResponseAckOperation,
        {
          queryId: QUERY_ID,
          requestId: "permission-1",
          toolUseID: "tool-1",
          adopted: true,
        },
      );
      vi.mocked(peer.call)
        .mockImplementationOnce(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-2",
          decisionClassification: "user_temporary" as const,
        }))
        .mockRejectedValueOnce(new Error("permission_ack_unavailable"));
      await expect(
        canUseTool(
          "Read",
          { file_path: "/workspace/other" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-2",
            requestId: "permission-2",
          },
        ),
      ).rejects.toThrow("permission_ack_unavailable");
      expect(peer.close).toHaveBeenCalledWith(
        "claude_runtime_permission_acknowledgement_failed",
      );
      await host.handlers.closeQuery({ queryId: QUERY_ID }, context());
      expect(host.activeQueryCount).toBe(0);
      expect(queryFixture.close).toHaveBeenCalledOnce();
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  it("omits invalid descriptive MCP provenance without closing the worker or losing permission hints", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const queryFixture = queryFacade();
    const peer: ClaudeRuntimeWorkerProtocolPeer = {
      ...inertPeer(),
      call: vi.fn(async (definition) =>
        definition.operation === "query.permission_response_ack"
          ? { acknowledged: true as const }
          : { behavior: "deny" as const, message: "Denied by main." },
      ) as ClaudeRuntimeWorkerProtocolPeer["call"],
    };
    const host = new ClaudeRuntimeWorkerHost({ sdk: queryFixture.sdk, peer });
    try {
      await host.handlers.initialize(
        { executablePath: process.execPath, configDirectory, initializationTimeoutMs: 1_000 },
        context(),
      );
      await host.handlers.openQuery(
        { queryId: QUERY_ID, sessionId: SESSION_ID, cwd: "/workspace", launch: "new",
          enableCanUseTool: true, environment: {} },
        context(),
      );
      const canUseTool = queryFixture.options().canUseTool!;
      for (const mcpServer of [
        { name: "x".repeat(513), source: "project" },
        { name: "fixture", source: "x".repeat(121) },
        { name: "", source: "project" },
        { name: "fixture", source: "" },
        { name: "fixture", source: "sdk" },
      ]) {
        vi.mocked(peer.call).mockClear();
        await expect(canUseTool("Read", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-1", requestId: randomUUID(),
          defaultToNo: true, suppressAlwaysAllowRule: true, mcpServer,
        })).resolves.toMatchObject({ behavior: "deny", message: "Denied by main." });
        const permissionCall = vi.mocked(peer.call).mock.calls.find(
          ([definition]) => definition.operation === claudeRuntimeCanUseToolOperation.operation,
        )!;
        const request = claudeRuntimeCanUseToolOperation.requestSchema.parse(permissionCall[1]);
        expect(request.options).toMatchObject({ defaultToNo: true, suppressAlwaysAllowRule: true });
        if (mcpServer.source === "sdk") expect(request.options.mcpServer).toEqual(mcpServer);
        else expect(request.options).not.toHaveProperty("mcpServer");
        expect(peer.close).not.toHaveBeenCalled();
        expect(host.activeQueryCount).toBe(1);
        expect(queryFixture.close).not.toHaveBeenCalled();
      }
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  it("treats caller-cancelled permission requests as benign and keeps the query usable", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const queryFixture = queryFacade();
    let permissionCalls = 0;
    let failNegativeAck = false;
    const peer: ClaudeRuntimeWorkerProtocolPeer = {
      call: vi.fn(async (definition, request, options) => {
        if (definition.operation === "query.permission_response_ack") {
          if (
            failNegativeAck &&
            (request as { adopted?: boolean }).adopted === false
          ) {
            throw new Error("negative_ack_unavailable");
          }
          return { acknowledged: true as const };
        }
        permissionCalls += 1;
        if (
          permissionCalls === 1 ||
          (request as { options?: { toolUseID?: string } }).options
            ?.toolUseID === "tool-3"
        ) {
          return await new Promise((_resolve, reject) => {
            options!.signal!.addEventListener(
              "abort",
              () =>
                reject(
                  new SidecarProtocolDeliveryError(
                    "sidecar_request_cancelled",
                    "sent_outcome_unknown",
                  ),
                ),
              { once: true },
            );
          });
        }
        return {
          behavior: "allow" as const,
          toolUseID: "tool-2",
          decisionClassification: "user_temporary" as const,
        };
      }) as ClaudeRuntimeWorkerProtocolPeer["call"],
      sendEvent: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const host = new ClaudeRuntimeWorkerHost({ sdk: queryFixture.sdk, peer });
    try {
      await host.handlers.initialize(
        {
          executablePath: process.execPath,
          configDirectory,
          initializationTimeoutMs: 1_000,
        },
        context(),
      );
      await host.handlers.openQuery(
        {
          queryId: QUERY_ID,
          sessionId: SESSION_ID,
          cwd: "/workspace",
          launch: "new",
          enableCanUseTool: true,
          environment: {},
        },
        context(),
      );
      const canUseTool = queryFixture.options().canUseTool!;
      const cancellation = new AbortController();
      const denied = canUseTool(
        "Read",
        {},
        {
          signal: cancellation.signal,
          toolUseID: "tool-1",
          requestId: "permission-1",
        },
      );
      const closing = host.handlers.closeQuery(
        { queryId: QUERY_ID },
        context(),
      );
      cancellation.abort(new Error("permission_cancelled"));
      await expect(denied).resolves.toMatchObject({ behavior: "deny" });
      await closing;
      expect(peer.close).not.toHaveBeenCalled();
      expect(peer.call).toHaveBeenCalledWith(
        claudeRuntimePermissionResponseAckOperation,
        {
          queryId: QUERY_ID,
          requestId: "permission-1",
          toolUseID: "tool-1",
          adopted: false,
        },
      );

      const secondQueryId = "44444444-4444-4444-8444-444444444444";
      const secondSessionId = "55555555-5555-4555-8555-555555555555";
      await host.handlers.openQuery(
        {
          queryId: secondQueryId,
          sessionId: secondSessionId,
          cwd: "/workspace",
          launch: "new",
          enableCanUseTool: true,
          environment: {},
        },
        context(),
      );
      await expect(
        queryFixture.options().canUseTool!(
          "Read",
          {},
          {
            signal: new AbortController().signal,
            toolUseID: "tool-2",
            requestId: "permission-2",
          },
        ),
      ).resolves.toMatchObject({ behavior: "allow", toolUseID: "tool-2" });
      expect(
        vi
          .mocked(peer.call)
          .mock.calls.filter(
            ([definition]) =>
              definition.operation === "query.permission_response_ack",
          ),
      ).toHaveLength(2);
      await expect(
        host.handlers.setQueryModel(
          { queryId: secondQueryId, model: "claude-sonnet-5" },
          context(),
        ),
      ).resolves.toEqual({ updated: true });

      failNegativeAck = true;
      const thirdCancellation = new AbortController();
      const third = queryFixture.options().canUseTool!(
        "Read",
        {},
        {
          signal: thirdCancellation.signal,
          toolUseID: "tool-3",
          requestId: "permission-3",
        },
      );
      thirdCancellation.abort(new Error("permission_cancelled"));
      await expect(third).rejects.toThrow("negative_ack_unavailable");
      expect(peer.close).toHaveBeenCalledWith(
        "claude_runtime_permission_acknowledgement_failed",
      );
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("removes and closes a query whose open is caller-aborted", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const initializationGate = deferred<SDKControlInitializeResponse>();
    const queryFixture = queryFacade(initializationGate.promise);
    const host = new ClaudeRuntimeWorkerHost({
      sdk: queryFixture.sdk,
      peer: inertPeer(),
    });
    const abortController = new AbortController();
    try {
      await host.handlers.initialize(
        {
          executablePath: process.execPath,
          configDirectory,
          initializationTimeoutMs: 1_000,
        },
        context(),
      );
      const opened = host.handlers.openQuery(
        {
          queryId: QUERY_ID,
          sessionId: SESSION_ID,
          cwd: "/workspace",
          launch: "new",
          enableCanUseTool: false,
          environment: {},
        },
        {
          ...context(),
          signal: abortController.signal,
        },
      );
      const rejected = expect(opened).rejects.toThrow("test_cancelled");
      await vi.waitFor(() =>
        expect(queryFixture.sdk.createQuery).toHaveBeenCalledOnce(),
      );
      abortController.abort(new Error("test_cancelled"));
      await rejected;
      expect(host.activeQueryCount).toBe(0);
      expect(queryFixture.close).toHaveBeenCalledOnce();
    } finally {
      initializationGate.resolve(queryInitialization());
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("closes a probe query when its caller aborts", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const initializationGate = deferred<SDKControlInitializeResponse>();
    const queryFixture = queryFacade(initializationGate.promise);
    const host = new ClaudeRuntimeWorkerHost({
      sdk: queryFixture.sdk,
      peer: inertPeer(),
    });
    const abortController = new AbortController();
    try {
      await host.handlers.initialize(
        {
          executablePath: process.execPath,
          configDirectory,
          initializationTimeoutMs: 1_000,
        },
        context(),
      );
      const probed = host.handlers.probe(
        { cwd: "/workspace" },
        { ...context(), signal: abortController.signal },
      );
      await vi.waitFor(() =>
        expect(queryFixture.sdk.createQuery).toHaveBeenCalledOnce(),
      );
      abortController.abort(new Error("probe_cancelled"));
      await expect(probed).rejects.toThrow("probe_cancelled");
      expect(queryFixture.close).toHaveBeenCalledOnce();
    } finally {
      initializationGate.resolve(queryInitialization());
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("pages aggregate native history above 32 MiB through bounded worker responses", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const sdk = helperFacade();
    const history: SessionMessage[] = ["a", "b"].map(text => ({
      type: "user", uuid: randomUUID(), session_id: SESSION_ID,
      message: { role: "user", content: text.repeat(18 * 1024 * 1024) },
      parent_tool_use_id: null, parent_agent_id: null,
    }));
    vi.mocked(sdk.getSessionMessages).mockResolvedValue(history);
    const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
    try {
      await host.handlers.initialize({
        executablePath: process.execPath, configDirectory,
        initializationTimeoutMs: 1_000,
      }, context());
      const responseBytes: number[] = [];
      const messages = await readClaudeSessionHistory(async options => {
        const page = await host.handlers.getSessionMessages({ sessionId: SESSION_ID, ...options }, context());
        responseBytes.push(Buffer.byteLength(JSON.stringify(page)));
        return page;
      }, {});
      expect(messages.map(message => message.uuid)).toEqual(history.map(message => message.uuid));
      expect(messages.map(message => (message.message as { content: string }).content.length))
        .toEqual([18 * 1024 * 1024, 18 * 1024 * 1024]);
      expect(responseBytes).toHaveLength(2);
      expect(responseBytes.every(bytes => bytes < CLAUDE_RUNTIME_MAXIMUM_HISTORY_RESPONSE_BYTES)).toBe(true);
      expect(sdk.getSessionMessages).toHaveBeenCalledOnce();
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });

  it("fails closed for an individual history message above the response cap", async () => {
    const configDirectory = await mkdtemp("/tmp/sedes-claude-worker-test-");
    const sdk = helperFacade();
    vi.mocked(sdk.getSessionMessages).mockResolvedValueOnce([
      {
        type: "user",
        uuid: OPERATION_ID,
        session_id: SESSION_ID,
        message: {
          role: "user",
          content: "x".repeat(CLAUDE_RUNTIME_MAXIMUM_HISTORY_RESPONSE_BYTES),
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      } as never,
    ]);
    const host = new ClaudeRuntimeWorkerHost({ sdk, peer: inertPeer() });
    try {
      await host.handlers.initialize(
        {
          executablePath: process.execPath,
          configDirectory,
          initializationTimeoutMs: 1_000,
        },
        context(),
      );
      await expect(
        host.handlers.getSessionMessages({ sessionId: SESSION_ID }, context()),
      ).rejects.toThrow("claude_runtime_history_response_too_large");
    } finally {
      await host.close();
      await rm(configDirectory, { recursive: true });
    }
  });
});

function helperFacade(): ClaudeSdkFacade {
  return {
    readCliRelease: vi.fn(async () => "2.1.274"),
    readCliAuthStatus: vi.fn(async () => ({ loggedIn: true })),
    createQuery: vi.fn(() => {
      throw new Error("unused");
    }),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => [
      {
        type: "user",
        uuid: OPERATION_ID,
        session_id: SESSION_ID,
        message: { role: "user", content: "hello" },
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: "2026-08-27T12:00:00.000Z",
        origin: { kind: "task-notification" },
      } as never,
    ]),
    renameSession: vi.fn(async () => undefined),
  };
}

function queryFacade(
  initializationResult: Promise<SDKControlInitializeResponse> = Promise.resolve(
    queryInitialization(),
  ),
): {
  readonly sdk: ClaudeSdkFacade;
  readonly close: ReturnType<typeof vi.fn>;
  readonly options: () => Options;
} {
  let options: Options | undefined;
  const close = vi.fn();
  const sdk: ClaudeSdkFacade = {
    readCliRelease: vi.fn(async () => "2.1.274"),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    })),
    createQuery: vi.fn((input) => {
      options = input.options;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const emittedSessionId =
        "sessionId" in input.options &&
        typeof input.options.sessionId === "string"
          ? input.options.sessionId
          : SESSION_ID;
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "oauth",
          claude_code_version: "2.1.274",
          cwd: "/workspace",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: OPERATION_ID,
          session_id: emittedSessionId,
        } as SDKMessage;
        await finished;
      })();
      return Object.assign(stream, {
        initializationResult: async () => await initializationResult,
        interrupt: async () => ({ still_queued: [] }),
        setModel: async () => undefined,
        setPermissionMode: async () => undefined,
        applyFlagSettings: async () => undefined,
        close: () => {
          close();
          finish();
        },
      }) as unknown as Query;
    }),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    renameSession: vi.fn(async () => undefined),
  };
  return {
    sdk,
    close,
    options: () => {
      if (!options) throw new Error("query_not_created");
      return options;
    },
  };
}

function queryInitialization(): SDKControlInitializeResponse {
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: { apiProvider: "firstParty", subscriptionType: "Claude Max" },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function inertPeer(): ClaudeRuntimeWorkerProtocolPeer {
  return {
    call: vi.fn(async () => {
      throw new Error("unused");
    }) as ClaudeRuntimeWorkerProtocolPeer["call"],
    sendEvent: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}
