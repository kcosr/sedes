import { createAgentToolCliNamedPipeEndpoint } from "../../src/internal/agent-tool-cli-protocol/local-endpoint.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseCodexAgentToolCliEnvironmentProvider,
  withCodexAgentToolCliEnvironment,
  type CodexAgentToolCliEnvironmentResolution,
} from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import { codexEnvironmentFingerprintInput } from "../../src/server/backends/codex/runtime/codex-runtime-environment-fingerprint.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const sourceCapabilities = createFakeAgentToolSourceCapabilities();

beforeEach(() => {
  vi.clearAllMocks();
});

const available: Extract<
  CodexAgentToolCliEnvironmentResolution,
  { readonly availability: "available" }
> = {
  availability: "available",
  endpoint: "http://127.0.0.1:4784",
  executableDirectory: "/opt/sedes/bin",
  inheritedPath: "/usr/local/bin:/usr/bin",
  sourceCapability: "m3-test-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
  surface: "cli",
  mode: "progressive",
  closed: new Promise(() => undefined),
  release: () => undefined,
};

const agentTools = {
  readPolicy: () => ({
    enabled: true,
    presentation: { surface: "cli" as const, mode: "progressive" as const },
    accessBoundary: "environment" as const,
    enabledToolIds: ["agent.context"],
  }),
};

describe("Codex agent-tool CLI environment", () => {
  it("preserves a Windows named-pipe capability and uses the execution host PATH grammar", () => {
    const endpoint = createAgentToolCliNamedPipeEndpoint();
    const resolution = { ...available, endpoint, executableDirectory: "C:\\Sedes\\bin", inheritedPath: "C:\\Windows\\System32;C:\\Tools" };
    expect(withCodexAgentToolCliEnvironment({ shell_environment_policy: { set: { Path: "stale", EXISTING: "kept" } } }, { resolution, applicationThreadId: "thread-1" })).toMatchObject({
      shell_environment_policy: { set: {
        SEDES_AGENT_TOOL_ENDPOINT: endpoint,
        PATH: "C:\\Sedes\\bin;C:\\Windows\\System32;C:\\Tools", EXISTING: "kept",
      } },
    });
    const projected = withCodexAgentToolCliEnvironment({ shell_environment_policy: { set: { Path: "stale" } } }, { resolution, applicationThreadId: "thread-1" });
    expect((projected.shell_environment_policy as { set: Record<string, string> }).set).not.toHaveProperty("Path");
    for (const invalid of [endpoint.replace(/.$/u, endpoint.endsWith("0") ? "1" : "0"), "npipe://./pipe/other#" + "a".repeat(64)]) {
      expect(() => withCodexAgentToolCliEnvironment({}, { resolution: { ...resolution, endpoint: invalid }, applicationThreadId: "thread-1" })).toThrow("codex_agent_tool_cli_endpoint_invalid");
    }
  });

  it("preserves config and shell policy while installing isolated thread context", () => {
    expect(
      withCodexAgentToolCliEnvironment(
        {
          model_reasoning_effort: "low",
          shell_environment_policy: {
            inherit: "core",
            include_only: ["HOME", "PATH", "SEDES_AGENT_TOOL_CLIENT_TOKEN"],
            exclude: ["AWS_*"],
            set: {
              EXISTING: "kept",
              SEDES_AGENT_TOOL_ENDPOINT: "replaced",
              SEDES_AGENT_TOOL_CLIENT_TOKEN: "must-not-reach-codex",
              SEDES_AGENT_TOOL_CLI_MODE: "individual",
            },
          },
        },
        { resolution: available, applicationThreadId: "thread-1" },
      ),
    ).toEqual({
      model_reasoning_effort: "low",
      shell_environment_policy: {
        inherit: "core",
        include_only: [
          "HOME",
          "PATH",
          "SEDES_AGENT_TOOL_ENDPOINT",
          "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
          "SEDES_AGENT_TOOL_CLI_MODE",
        ],
        exclude: [
          "AWS_*",
          "SEDES_AGENT_TOOL_ENDPOINT",
          "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
          "SEDES_AGENT_TOOL_CLIENT_TOKEN",
          "SEDES_AGENT_TOOL_CLI_MODE",
        ],
        set: {
          EXISTING: "kept",
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "m3-test-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
          SEDES_AGENT_TOOL_CLI_MODE: "progressive",
          PATH: "/opt/sedes/bin:/usr/local/bin:/usr/bin",
        },
      },
    });
  });

  it("starts the thread's sedes MCP server instead of exposing CLI context in Native presentation", () => {
    const config = withCodexAgentToolCliEnvironment(
      {
        model_reasoning_effort: "low",
        shell_environment_policy: {
          set: {
            EXISTING: "kept",
            SEDES_AGENT_TOOL_ENDPOINT: "stale",
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "stale",
          },
        },
      },
      {
        resolution: { ...available, surface: "native", mode: "individual" },
        applicationThreadId: "thread-1",
      },
    );
    expect(config).toEqual({
      model_reasoning_effort: "low",
      shell_environment_policy: {
        exclude: [
          "SEDES_AGENT_TOOL_ENDPOINT",
          "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
          "SEDES_AGENT_TOOL_CLIENT_TOKEN",
          "SEDES_AGENT_TOOL_CLI_MODE",
        ],
        set: { EXISTING: "kept" },
      },
      "mcp_servers.sedes": {
        command: "/opt/sedes/bin/sedes",
        args: ["mcp", "--mode", "individual"],
        env: {
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "m3-test-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
        },
        startup_timeout_sec: 30,
        tool_timeout_sec: 86_400,
      },
    });
    const sidecar = withCodexAgentToolCliEnvironment({}, {
      resolution: {
        ...available,
        surface: "native",
        endpoint: "unix:///run/user/1000/sedes/agent-tools.sock",
        executableDirectory: "/home/user/.local/state/sedes/sidecar",
      },
      applicationThreadId: "thread-1",
    });
    expect(sidecar["mcp_servers.sedes"]).toMatchObject({
      command: "/home/user/.local/state/sedes/sidecar/sedes",
      args: ["mcp", "--mode", "progressive"],
      env: { SEDES_AGENT_TOOL_ENDPOINT: "unix:///run/user/1000/sedes/agent-tools.sock" },
    });
    expect(() =>
      withCodexAgentToolCliEnvironment({}, {
        resolution: {
          ...available,
          surface: "native",
          endpoint: createAgentToolCliNamedPipeEndpoint(),
          executableDirectory: "C:\\Sedes\\bin",
        },
        applicationThreadId: "thread-1",
      }),
    ).toThrow("codex_agent_tool_mcp_platform_unsupported");
  });

  it("projects only MCP environment names into durable runtime fingerprints", () => {
    const params = {
      threadId: "native-thread",
      config: withCodexAgentToolCliEnvironment({}, {
        resolution: { ...available, surface: "native" },
        applicationThreadId: "thread-1",
      }),
    };
    const projected = JSON.stringify(
      codexEnvironmentFingerprintInput("thread/resume", params),
    );
    expect(projected).not.toContain(available.sourceCapability);
    expect(projected).toContain("SEDES_AGENT_TOOL_SOURCE_CAPABILITY");
    expect(projected).toContain("/opt/sedes/bin/sedes");
    expect(codexEnvironmentFingerprintInput("turn/start", params)).toBe(params);
  });

  it("does not install context when composition cannot prove eligibility", () => {
    expect(
      withCodexAgentToolCliEnvironment(
        { model_reasoning_effort: "high" },
        {
          resolution: {
            availability: "unavailable",
            reason: "imported_thread",
          },
          applicationThreadId: "thread-1",
        },
      ),
    ).toEqual({
      model_reasoning_effort: "high",
      shell_environment_policy: {
        exclude: [
          "SEDES_AGENT_TOOL_ENDPOINT",
          "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
          "SEDES_AGENT_TOOL_CLIENT_TOKEN",
          "SEDES_AGENT_TOOL_CLI_MODE",
        ],
      },
    });
  });

  it("keeps concurrent thread capabilities isolated", () => {
    const firstResolution = {
      ...available,
      sourceCapability:
        "codex-thread-a-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
    };
    const secondResolution = {
      ...available,
      sourceCapability:
        "codex-thread-b-capability-4Vn8M2sR6wY0aD3fH7jL1cB5qP9tK",
    };
    const first = withCodexAgentToolCliEnvironment(
      {},
      {
        resolution: firstResolution,
        applicationThreadId: "thread-a",
      },
    );
    const second = withCodexAgentToolCliEnvironment(
      {},
      {
        resolution: secondResolution,
        applicationThreadId: "thread-b",
      },
    );
    expect(first).toMatchObject({
      shell_environment_policy: {
        set: {
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "codex-thread-a-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
        },
      },
    });
    expect(second).toMatchObject({
      shell_environment_policy: {
        set: {
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "codex-thread-b-capability-4Vn8M2sR6wY0aD3fH7jL1cB5qP9tK",
        },
      },
    });
    expect(first).not.toMatchObject({
      shell_environment_policy: {
        set: {
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "codex-thread-b-capability-4Vn8M2sR6wY0aD3fH7jL1cB5qP9tK",
        },
      },
    });
    expect(second).not.toMatchObject({
      shell_environment_policy: {
        set: {
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "codex-thread-a-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB",
        },
      },
    });
  });

  it.each([
    ["non-loopback URL", { ...available, endpoint: "http://192.168.1.2:4784" }],
    ["URL path", { ...available, endpoint: "http://127.0.0.1:4784/api" }],
    [
      "relative executable directory",
      { ...available, executableDirectory: "bin" },
    ],
  ])("rejects an invalid trusted %s", (_label, resolution) => {
    expect(() =>
      withCodexAgentToolCliEnvironment(
        {},
        {
          resolution: resolution as CodexAgentToolCliEnvironmentResolution,
          applicationThreadId: "thread-1",
        },
      ),
    ).toThrow();
  });

  it("rejects an invalid CLI presentation mode", () => {
    expect(() =>
      withCodexAgentToolCliEnvironment(
        {},
        {
          resolution: { ...available, mode: "hybrid" as never },
          applicationThreadId: "thread-1",
        },
      ),
    ).toThrow("codex_agent_tool_cli_mode_invalid");
  });

  it.each([
    [undefined, "unverifiable_thread_context"],
    [{ networkAccess: "enabled", sedesCreated: 0 }, "imported_thread"],
    [{ networkAccess: "disabled", sedesCreated: 1 }, "network_disabled"],
  ])("fails closed for unsupported thread facts %#", async (row, reason) => {
    const provider = databaseProvider(row);
    await expect(provider.acquire(scope, "thread-1")).resolves.toEqual({
      availability: "unavailable",
      reason,
    });
  });

  it("prefixes applied owned PATH while explicit execution PATH and unset retain precedence", async () => {
    const provider = databaseProvider({ networkAccess: "enabled", sedesCreated: 1 }, async () => "/owned/applied/bin");
    const resolution = await provider.acquire(scope, "thread-1");
    expect(resolution).toMatchObject({ inheritedPath: "/owned/applied/bin" });
    for (const [executionEnvironment, expected] of [[{}, "/opt/sedes/bin:/owned/applied/bin"], [{ PATH: "/thread/bin" }, "/opt/sedes/bin:/thread/bin"], [{ PATH: null }, "/opt/sedes/bin"]] as const) {
      expect(withCodexAgentToolCliEnvironment({}, { resolution, applicationThreadId: "thread-1", executionEnvironment })).toMatchObject({ shell_environment_policy: { set: { PATH: expected } } });
    }
    await expect(databaseProvider({ networkAccess: "enabled", sedesCreated: 1 }, async () => { throw new Error("unavailable"); }).acquire(scope, "thread-1")).resolves.toEqual({ availability: "unavailable", reason: "sidecar_unavailable" });
  });

  it("returns isolated context only for a network-enabled Sedes-created thread", async () => {
    await expect(
      databaseProvider({ networkAccess: "enabled", sedesCreated: 1 }).acquire(
        scope,
        "thread-1",
      ),
    ).resolves.toMatchObject({
      availability: "available",
      endpoint: available.endpoint,
      executableDirectory: available.executableDirectory,
      inheritedPath: available.inheritedPath,
    });
  });

  it("issues an MCP-bound reference for a Native thread", async () => {
    const resolution = await databaseProvider(
      { networkAccess: "enabled", sedesCreated: 1 },
      undefined,
      { surface: "native" },
    ).acquire(scope, "thread-1");
    expect(resolution).toMatchObject({
      availability: "available",
      surface: "native",
      mode: "progressive",
    });
    expect(sourceCapabilities.issue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceThreadId: "thread-1" }),
      "management_http",
      "mcp",
    );
  });

  it("fails Native presentation closed on a Windows execution host", async () => {
    const release = vi.fn();
    const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "enabled", sedesCreated: 1 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime: {
        availability: "managed",
        provider: {
          acquire: async () => ({
            availability: "available" as const,
            endpoint: createAgentToolCliNamedPipeEndpoint(),
            executableDirectory: "C:\\Sedes\\sidecar",
            inheritedPath: "C:\\Windows",
            closed: new Promise<never>(() => undefined),
            release,
          }),
        },
      },
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools: {
        readPolicy: () => ({
          ...agentTools.readPolicy(),
          presentation: { surface: "native" as const, mode: "individual" as const },
        }),
      },
    });
    await expect(provider.acquire(scope, "thread-1")).resolves.toEqual({
      availability: "unavailable",
      reason: "presentation_unavailable",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(sourceCapabilities.issue).not.toHaveBeenCalled();
  });

  it.each(["local", "managed"] as const)(
    "provisions %s CLI authority while access is disabled and no tools are selected",
    async (topology) => {
      const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
        database: {
          prepare: () => ({
            get: () => ({ networkAccess: "enabled", sedesCreated: 1 }),
          }),
        } as never,
        backendInstanceId: "codex-1",
        runtime:
          topology === "local"
            ? available
            : {
                availability: "managed",
                provider: {
                  acquire: async () => ({
                    ...available,
                    endpoint: "unix:///remote/agent-tools.sock",
                  }),
                },
              },
        sourceCapabilities: sourceCapabilities.issuer,
        agentTools: {
          readPolicy: () => ({
            ...agentTools.readPolicy(),
            enabled: false,
            enabledToolIds: [],
          }),
        },
      });
      const resolution = await provider.acquire(scope, "thread-1");
      expect(resolution.availability).toBe("available");
      expect(
        withCodexAgentToolCliEnvironment(
          {},
          {
            resolution,
            applicationThreadId: "thread-1",
          },
        ),
      ).toMatchObject({
        shell_environment_policy: {
          set: {
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: expect.any(String),
            SEDES_AGENT_TOOL_CLI_MODE: "progressive",
          },
        },
      });
      expect(sourceCapabilities.issue).toHaveBeenCalledWith(
        expect.objectContaining({ sourceThreadId: "thread-1" }),
        topology === "local"
          ? "management_http"
          : "execution_environment_sidecar",
        "cli",
      );
      if (resolution.availability === "available") resolution.release();
    },
  );

  it("inspects thread state for external local runtimes when composition opts in", async () => {
    const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "enabled", sedesCreated: 1 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime: {
        availability: "available",
        endpoint: available.endpoint,
        executableDirectory: available.executableDirectory,
        inheritedPath: available.inheritedPath,
      },
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools,
    });
    await expect(provider.acquire(scope, "thread-1")).resolves.toMatchObject({
      availability: "available",
      endpoint: available.endpoint,
      executableDirectory: available.executableDirectory,
      inheritedPath: available.inheritedPath,
    });
    expect(sourceCapabilities.issue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceThreadId: "thread-1" }),
      "management_http",
      "cli",
    );
  });

  it("acquires a managed runtime only after thread eligibility is proven", async () => {
    const release = vi.fn();
    const runtimeAcquire = vi.fn(async () => ({
      ...available,
      release,
    }));
    const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "enabled", sedesCreated: 1 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime: {
        availability: "managed",
        provider: { acquire: runtimeAcquire },
      },
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools,
    });
    const signal = new AbortController().signal;

    const resolution = await provider.acquire(scope, "thread-1", { signal });
    expect(resolution).toMatchObject({
      availability: "available",
      endpoint: available.endpoint,
    });
    expect(runtimeAcquire).toHaveBeenCalledWith({ signal });
    expect(sourceCapabilities.issue).toHaveBeenCalledOnce();
    if (resolution.availability !== "available") {
      throw new Error("expected available CLI resolution");
    }
    resolution.release();
    resolution.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("binds exact source facts while independently releasing the runtime", async () => {
    const runtimeRelease = vi.fn();
    const issue = vi.fn(
      () => "codex-capability-lifecycle-1234567890abcdefghijklmnop",
    );
    const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({
            networkAccess: "enabled",
            sedesCreated: 1,
            workspaceId: "workspace-1",
            environmentId: "environment-1",
          }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime: {
        availability: "managed",
        provider: {
          acquire: async () => ({ ...available, release: runtimeRelease }),
        },
      },
      sourceCapabilities: { issue },
      agentTools,
    });

    const resolution = await provider.acquire(scope, "thread-1");
    expect(issue).toHaveBeenCalledWith(
      {
        scope,
        sourceThreadId: "thread-1",
        sourceWorkspaceId: "workspace-1",
        sourceEnvironmentId: "environment-1",
        backendKind: "codex_app_server",
      },
      "execution_environment_sidecar",
      "cli",
    );
    expect(resolution).toMatchObject({
      availability: "available",
      sourceCapability: "codex-capability-lifecycle-1234567890abcdefghijklmnop",
    });
    if (resolution.availability !== "available") throw new Error("unreachable");
    resolution.release();
    resolution.release();
    expect(runtimeRelease).toHaveBeenCalledTimes(1);
  });

  it("does not touch a managed runtime for imported or network-disabled threads", async () => {
    const runtimeAcquire = vi.fn(async () => available);
    const runtime = {
      availability: "managed" as const,
      provider: { acquire: runtimeAcquire },
    };
    const imported = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "enabled", sedesCreated: 0 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime,
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools,
    });
    const networkDisabled = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "disabled", sedesCreated: 1 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime,
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools,
    });

    await expect(imported.acquire(scope, "thread-1")).resolves.toMatchObject({
      availability: "unavailable",
      reason: "imported_thread",
    });
    await expect(
      networkDisabled.acquire(scope, "thread-1"),
    ).resolves.toMatchObject({
      availability: "unavailable",
      reason: "network_disabled",
    });
    expect(runtimeAcquire).not.toHaveBeenCalled();
  });

  it("releases malformed managed metadata and reports it as unavailable", async () => {
    const release = vi.fn();
    const onError = vi.fn();
    const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
      database: {
        prepare: () => ({
          get: () => ({ networkAccess: "enabled", sedesCreated: 1 }),
        }),
      } as never,
      backendInstanceId: "codex-1",
      runtime: {
        availability: "managed",
        provider: {
          acquire: async () => ({
            ...available,
            endpoint: "unix://relative.sock",
            release,
          }),
        },
      },
      sourceCapabilities: sourceCapabilities.issuer,
      agentTools,
      onError,
    });

    await expect(provider.acquire(scope, "thread-1")).resolves.toEqual({
      availability: "unavailable",
      reason: "sidecar_unavailable",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each(["remote_environment", "cli_unavailable"] as const)(
    "propagates %s without inspecting thread state",
    async (reason) => {
      const provider = new DatabaseCodexAgentToolCliEnvironmentProvider({
        database: {
          prepare: () => {
            throw new Error("database must not be consulted");
          },
        } as never,
        backendInstanceId: "codex-1",
        runtime: {
          availability: "unavailable",
          reason,
        },
        sourceCapabilities: sourceCapabilities.issuer,
        agentTools,
      });
      await expect(provider.acquire(scope, "thread-1")).resolves.toEqual({
        availability: "unavailable",
        reason,
      });
    },
  );
});

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

function databaseProvider(
  row: unknown,
  appliedOwnedPath?: () => Promise<string>,
  options: {
    readonly surface?: "cli" | "native";
    readonly executableDirectory?: string;
  } = {},
) {
  return new DatabaseCodexAgentToolCliEnvironmentProvider({
    database: {
      prepare: () => ({ get: () => row }),
    } as never,
    backendInstanceId: "codex-1",
    ...(appliedOwnedPath ? { appliedOwnedPath } : {}),
    runtime: {
      availability: "available",
      endpoint: available.endpoint,
      executableDirectory:
        options.executableDirectory ?? available.executableDirectory,
      inheritedPath: available.inheritedPath,
    },
    sourceCapabilities: sourceCapabilities.issuer,
    agentTools: {
      readPolicy: () => ({
        ...agentTools.readPolicy(),
        presentation: {
          surface: options.surface ?? ("cli" as const),
          mode: "progressive" as const,
        },
      }),
    },
  });
}
