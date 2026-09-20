import { describe, expect, it } from "vitest";
import { parseGrokBackendConfiguration } from "../../src/server/backends/grok/grok-backend-configuration.js";
import type { BackendModelPolicy } from "../../src/server/backends/model-policy.js";

const localId = "10000000-0000-4000-8000-000000000001";

function input() {
  return {
    backend: {
      id: "grok-primary",
      kind: "grok_build" as const,
      protocolRelease: "1.x",
      enabled: true,
      modelPolicy: { type: "catalog" as const },
      moduleConfiguration: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/grok/bin/grok",
            workingDirectoryPolicy: "workspace",
          },
        },
        authentication: {
          type: "native",
        },
        security: {
          profile: "unrestricted_v1",
          sandboxProfile: "off",
          networkAccess: "enabled",
          approvalMode: "full_access",
        },
      },
    },
    connections: [
      {
        id: "grok-default",
        kind: "grok_acp" as const,
        backendInstanceId: "grok-primary",
        executionEnvironmentId: localId,
        enabled: true,
        moduleConfiguration: {
          defaults: {
            model: { type: "catalogDefault" },
            reasoningEffort: { type: "modelDefault" },
          },
        },
      },
    ],
    executionEnvironments: [{ id: localId, kind: "local" as const }],
  };
}

describe("Grok backend configuration scaffold", () => {
  it("deep-freezes the closed provider configuration", () => {
    const prepared = parseGrokBackendConfiguration(input());
    expect(prepared).toMatchObject({
      backendInstanceId: "grok-primary",
      enabled: true,
      executionEnvironmentId: localId,
      runtime: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/grok/bin/grok",
          },
        },
      },
      modelPolicy: { policy: { type: "catalog" } },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.runtime.connection.channel)).toBe(true);
    expect(
      Object.isFrozen(prepared.connections[0]!.configuration.defaults),
    ).toBe(true);
  });

  it("defaults the executable to Grok on the local environment PATH", () => {
    const value = input();
    delete (
      value.backend.moduleConfiguration.connection.channel as {
        executablePath?: string;
      }
    ).executablePath;

    const prepared = parseGrokBackendConfiguration(value);
    expect(prepared.runtime.connection.channel).toEqual({
      type: "process_stdio",
      workingDirectoryPolicy: "workspace",
    });
  });

  it("rejects aliases, arbitrary argv/env, literals, and unknown fields", () => {
    for (const mutate of [
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration, { apiKey: "secret" });
      },
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration.connection.channel, {
          arguments: ["agent", "stdio"],
        });
      },
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration.connection.channel, {
          environment: { XAI_API_KEY: "secret" },
        });
      },
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration.connection.channel, {
          grokHome: "/var/lib/sedes/grok",
          processHome: "/var/lib/sedes/home",
        });
      },
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration.authentication, {
          type: "cached_token",
          token: "secret",
        });
      },
      (value: ReturnType<typeof input>) => {
        Object.assign(value.backend.moduleConfiguration.authentication, {
          declaredAccountAuthorityId: "legacy-account",
        });
      },
    ]) {
      const value = input();
      mutate(value);
      expect(() => parseGrokBackendConfiguration(value)).toThrow();
    }
  });

  it("requires canonical executable paths and one local enabled environment", () => {
    const relative = input();
    relative.backend.moduleConfiguration.connection.channel.executablePath =
      "grok";
    expect(() => parseGrokBackendConfiguration(relative)).toThrow();

    const ssh = input();
    (
      ssh.executionEnvironments as Array<{
        id: string;
        kind: "local" | "ssh";
      }>
    )[0]!.kind = "ssh";
    expect(() => parseGrokBackendConfiguration(ssh)).toThrow(
      "grok_execution_environment_invalid",
    );
  });

  it("rejects fixed defaults outside model policy", () => {
    const value = input();
    (value.backend as { modelPolicy: BackendModelPolicy }).modelPolicy = {
      type: "allowlist",
      allowed: [{ modelIds: ["grok-allowed"] }],
    };
    (
      value.connections[0]!.moduleConfiguration.defaults as {
        model: { type: string; modelId?: string };
      }
    ).model = {
      type: "fixed",
      modelId: "grok-denied",
    };
    expect(() => parseGrokBackendConfiguration(value)).toThrow(
      "grok_connection_defaults_outside_model_policy",
    );

    const unresolvedModel = input();
    (
      unresolvedModel.connections[0]!.moduleConfiguration.defaults as {
        reasoningEffort: { type: string; effortId?: string };
      }
    ).reasoningEffort = { type: "fixed", effortId: "high" };
    expect(() => parseGrokBackendConfiguration(unresolvedModel)).toThrow(
      "grok_fixed_effort_requires_fixed_model",
    );
  });
});
