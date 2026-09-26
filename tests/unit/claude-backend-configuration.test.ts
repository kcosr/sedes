import { describe, expect, it } from "vitest";
import { parseClaudeBackendConfiguration } from "../../src/server/backends/claude/claude-backend-configuration.js";
import {
  claudePermissionPolicyAllowsBypass,
  isClaudePermissionMode,
  isClaudePermissionModeAllowed,
} from "../../src/server/backends/claude/claude-permission-policy.js";

const input = {
  backend: {
    id: "claude-local",
    kind: "claude_agent_sdk" as const,
    protocolRelease: "0.3.283",
    enabled: true,
    modelPolicy: { type: "catalog" as const },
    moduleConfiguration: {
      executablePath: "/usr/local/bin/claude",
      configDirectory: "/home/operator/.claude",
      permissionPolicy: {
        allowedModes: [
          "default",
          "acceptEdits",
          "dontAsk",
          "auto",
          "bypassPermissions",
        ],
      },
    },
  },
  connections: [
    {
      id: "claude-local",
      kind: "claude_agent_sdk" as const,
      backendInstanceId: "claude-local",
      executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
      enabled: true,
      moduleConfiguration: {
        defaults: { permissionMode: "default" },
      },
    },
  ],
  executionEnvironments: [
    { id: "11111111-1111-4111-8111-111111111111", kind: "local" as const },
  ],
  environment: {},
};

describe("parseClaudeBackendConfiguration", () => {
  it("applies bounded runtime defaults", () => {
    const prepared = parseClaudeBackendConfiguration(input);
    expect(prepared).toMatchObject({
      backendInstanceId: "claude-local",
      runtime: {
        executablePath: "/usr/local/bin/claude",
        configDirectory: "/home/operator/.claude",
        initializationTimeoutMs: 20_000,
        permissionPolicy: {
          allowedModes: [
            "default",
            "acceptEdits",
            "dontAsk",
            "auto",
            "bypassPermissions",
          ],
        },
      },
      connections: [
        {
          id: "claude-local",
          enabled: true,
          configuration: {
            defaults: { permissionMode: "default" },
          },
        },
      ],
      modelPolicy: { policy: { type: "catalog" } },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(
      Object.isFrozen(prepared.runtime.permissionPolicy.allowedModes),
    ).toBe(true);
  });

  it("defaults executable discovery to the target environment PATH", () => {
    const prepared = parseClaudeBackendConfiguration({
      ...input,
      backend: {
        ...input.backend,
        moduleConfiguration: {
          configDirectory: input.backend.moduleConfiguration.configDirectory,
          permissionPolicy: input.backend.moduleConfiguration.permissionPolicy,
        },
      },
    });

    expect(prepared.runtime.executablePath).toBeUndefined();
  });

  it.each(["local", "ssh", "outbound"] as const)("leaves the native directory default for the %s execution account to resolve", (kind) => {
    const prepared = parseClaudeBackendConfiguration({
      ...input,
      environment: { HOME: "/main/home", CLAUDE_CONFIG_DIR: "/main/claude" },
      executionEnvironments: [{ ...input.executionEnvironments[0]!, kind }],
      backend: {
        ...input.backend,
        moduleConfiguration: { permissionPolicy: input.backend.moduleConfiguration.permissionPolicy },
      },
    });

    expect(prepared.runtime).not.toHaveProperty("configDirectory");
  });

  it("rejects credentials and executable shortcuts from module config", () => {
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        backend: {
          ...input.backend,
          moduleConfiguration: {
            executablePath: "claude",
            configDirectory: "/home/operator/.claude",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        backend: {
          ...input.backend,
          moduleConfiguration: {
            ...input.backend.moduleConfiguration,
            maxConcurrentSessions: 8,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        backend: {
          ...input.backend,
          moduleConfiguration: {
            executablePath: "/usr/local/bin/claude",
            configDirectory: "/home/operator/.claude",
            apiKey: "not-accepted",
          },
        },
      }),
    ).toThrow();
  });

  it("requires canonical absolute paths for overrides in the selected environment", () => {
    for (const [field, value] of [
      ["executablePath", "claude"],
      ["executablePath", "/usr/local/../bin/claude"],
      ["executablePath", "C:claude.exe"],
      ["configDirectory", "~/.claude"],
      ["configDirectory", "/home/operator/.claude/"],
      ["configDirectory", "/home/operator/../operator/.claude"],
    ] as const) {
      expect(() =>
        parseClaudeBackendConfiguration({
          ...input,
          backend: {
            ...input.backend,
            moduleConfiguration: {
              ...input.backend.moduleConfiguration,
              [field]: value,
            },
          },
        }),
      ).toThrow(/Claude environment paths/u);
    }
  });

  it("rejects invalid per-target provider configuration", () => {
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        connections: [
          {
            ...input.connections[0]!,
            moduleConfiguration: {
              defaults: { permissionMode: "default" },
              model: "sonnet",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("requires a non-empty, unique allowlist of supported non-plan modes", () => {
    for (const allowedModes of [
      [],
      ["default", "default"],
      ["default", "plan"],
      ["default", "futureMode"],
    ]) {
      expect(() =>
        parseClaudeBackendConfiguration({
          ...input,
          backend: {
            ...input.backend,
            moduleConfiguration: {
              executablePath: "/usr/local/bin/claude",
              configDirectory: "/home/operator/.claude",
              permissionPolicy: { allowedModes },
            },
          },
        }),
      ).toThrow();
    }
  });

  it("requires an allowed safe target default", () => {
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        backend: {
          ...input.backend,
          moduleConfiguration: {
            executablePath: "/usr/local/bin/claude",
            configDirectory: "/home/operator/.claude",
            permissionPolicy: { allowedModes: ["dontAsk"] },
          },
        },
      }),
    ).toThrow("claude_connection_defaults_outside_backend_policy");

    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        connections: [
          {
            ...input.connections[0]!,
            moduleConfiguration: {
              defaults: { permissionMode: "bypassPermissions" },
            },
          },
        ],
      }),
    ).toThrow(/cannot be a Claude connection default/u);

    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        connections: [
          {
            ...input.connections[0]!,
            moduleConfiguration: {
              defaults: { permissionMode: "plan" },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects provider matchers because Claude has no native provider axis", () => {
    expect(() =>
      parseClaudeBackendConfiguration({
        ...input,
        backend: {
          ...input.backend,
          modelPolicy: {
            type: "allowlist",
            allowed: [{ providerIds: ["anthropic"] }],
          },
        },
      }),
    ).toThrow(/does not expose a native provider identity/u);
  });

  it("requires the canonical target defaults shape", () => {
    for (const moduleConfiguration of [
      undefined,
      {},
      { permissionMode: "default" },
      { defaults: {} },
      { defaults: { permissionMode: "default", extra: true } },
    ]) {
      expect(() =>
        parseClaudeBackendConfiguration({
          ...input,
          connections: [
            {
              ...input.connections[0]!,
              moduleConfiguration,
            },
          ],
        }),
      ).toThrow();
    }
  });
});

describe("Claude permission policy", () => {
  it("recognizes only supported non-plan modes and applies the exact ceiling", () => {
    expect(isClaudePermissionMode("auto")).toBe(true);
    expect(isClaudePermissionMode("plan")).toBe(false);
    expect(isClaudePermissionMode("futureMode")).toBe(false);

    const policy = { allowedModes: ["default", "bypassPermissions"] } as const;
    expect(isClaudePermissionModeAllowed("default", policy)).toBe(true);
    expect(isClaudePermissionModeAllowed("acceptEdits", policy)).toBe(false);
    expect(claudePermissionPolicyAllowsBypass(policy)).toBe(true);
    expect(
      claudePermissionPolicyAllowsBypass({ allowedModes: ["default"] }),
    ).toBe(false);
  });
});

it("retains canonical execution-host Windows overrides without main-host path resolution", () => {
  const prepared = parseClaudeBackendConfiguration({ ...input, backend: { ...input.backend,
    moduleConfiguration: { ...input.backend.moduleConfiguration,
      executablePath: "C:\\Tools\\claude.exe", configDirectory: "C:\\Users\\operator\\.claude" } } });
  expect(prepared.runtime.executablePath).toBe("C:\\Tools\\claude.exe");
  expect(prepared.runtime.configDirectory).toBe("C:\\Users\\operator\\.claude");
});
