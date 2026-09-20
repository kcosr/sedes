import { describe, expect, it } from "vitest";
import type { BackendModuleConfigurationInput } from "../../src/server/backends/module.js";
import {
  parseCodexBackendConfiguration,
  type PreparedCodexBackendConfiguration,
} from "../../src/server/backends/codex/codex-backend-configuration.js";

function validInput(): BackendModuleConfigurationInput {
  return {
    backend: {
      id: "codex-primary",
      kind: "codex_app_server",
      protocolRelease: "0.153.0",
      enabled: true,
      modelPolicy: {
        type: "allowlist",
        allowed: [{ modelIds: ["gpt-5.6-luna", "gpt-5.6-codex"] }],
      },
      moduleConfiguration: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/codex/0.153.0/bin/codex",
            workingDirectory: "/var/lib/sedes/codex",
          },
        },
        policy: {
          allowedSandboxModes: ["read-only", "workspace-write"],
          allowedNetworkAccess: ["disabled", "enabled"],
          allowedApprovalPolicies: ["untrusted", "on-request", "never"],
          allowedApprovalReviewers: ["user", "auto_review"],
        },
      },
    },
    connections: [
      {
        id: "codex-balanced",
        kind: "codex_app_server",
        backendInstanceId: "codex-primary",
        executionEnvironmentId: "10000000-0000-4000-8000-000000000001",
        enabled: true,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "workspace-write",
            networkAccess: "enabled",
            approvalPolicy: "on-request",
            approvalReviewer: "auto_review",
            model: { type: "fixed", modelId: "gpt-5.6-luna" },
          },
        },
      },
      {
        id: "codex-read-only",
        kind: "codex_app_server",
        backendInstanceId: "codex-primary",
        executionEnvironmentId: "10000000-0000-4000-8000-000000000001",
        enabled: false,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "read-only",
            networkAccess: "disabled",
            approvalPolicy: "never",
            approvalReviewer: "user",
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          },
        },
      },
    ],
    executionEnvironments: [
      { id: "10000000-0000-4000-8000-000000000001", kind: "local" },
    ],
    environment: {},
  };
}

function cloneInput(): BackendModuleConfigurationInput {
  return structuredClone(validInput());
}

function parsed(
  mutate?: (input: BackendModuleConfigurationInput) => void,
): PreparedCodexBackendConfiguration {
  const input = cloneInput();
  mutate?.(input);
  return parseCodexBackendConfiguration(input);
}

describe("Codex backend configuration", () => {
  it("accepts execution-host Windows paths independently of the main host", () => {
    const input = validInput();
    const channel = (input.backend.moduleConfiguration as { connection: { channel: { executablePath: string; workingDirectory: string } } }).connection.channel;
    channel.executablePath = "C:\\Tools\\codex.exe";
    channel.workingDirectory = "C:\\Users\\alex\\work";
    expect(parseCodexBackendConfiguration(input).configuration.connection.channel).toMatchObject(channel);
    channel.executablePath = "C:\\Tools\\codex.exe:stream";
    expect(() => parseCodexBackendConfiguration(input)).toThrow();
  });

  it("parses one exact owned process-stdio backend and bounded connection defaults", () => {
    const result = parsed();

    expect(result).toMatchObject({
      backendInstanceId: "codex-primary",
      protocolRelease: "0.153.0",
      configuration: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/codex/0.153.0/bin/codex",
            workingDirectory: "/var/lib/sedes/codex",
          },
        },
      },
      connections: [
        {
          id: "codex-balanced",
          enabled: true,
          configuration: {
            defaults: {
              sandboxMode: "workspace-write",
              networkAccess: "enabled",
              approvalPolicy: "on-request",
              approvalReviewer: "auto_review",
              model: { type: "fixed", modelId: "gpt-5.6-luna" },
            },
          },
        },
        { id: "codex-read-only", enabled: false },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.configuration.connection)).toBe(true);
    expect(Object.isFrozen(result.configuration.connection.channel)).toBe(true);
    expect(Object.isFrozen(result.modelPolicy.policy)).toBe(true);
    expect(Object.isFrozen(result.connections)).toBe(true);
  });

  it("accepts an optional Codex home override only for owned process stdio", () => {
    const result = parsed((input) => {
      const channel = (
        input.backend.moduleConfiguration as {
          connection: { channel: Record<string, unknown> };
        }
      ).connection.channel;
      channel.codexHome = "/var/lib/sedes/codex/principal-one";
    });

    expect(result.configuration.connection).toEqual({
      ownership: "owned",
      channel: {
        type: "process_stdio",
        executablePath: "/opt/codex/0.153.0/bin/codex",
        workingDirectory: "/var/lib/sedes/codex",
        codexHome: "/var/lib/sedes/codex/principal-one",
      },
    });
    expect(Object.isFrozen(result.configuration.connection.channel)).toBe(true);
  });

  it("defaults an owned process executable to Codex on the environment PATH", () => {
    const result = parsed((input) => {
      const channel = (
        input.backend.moduleConfiguration as {
          connection: { channel: Record<string, unknown> };
        }
      ).connection.channel;
      delete channel.executablePath;
    });

    expect(result.configuration.connection).toEqual({
      ownership: "owned",
      channel: {
        type: "process_stdio",
        workingDirectory: "/var/lib/sedes/codex",
      },
    });
  });

  it("uses the exact generated protocol profile", () => {
    expect(parsed().protocolRelease).toBe("0.153.0");
  });

  it("retains a disabled backend without admitting it", () => {
    const disabled = parsed((input) => {
      (input.backend as { enabled: boolean }).enabled = false;
      for (const connection of input.connections) {
        (connection as { enabled: boolean }).enabled = false;
      }
    });

    expect(disabled.protocolRelease).toBe("0.153.0");
    expect(disabled.connections.every(({ enabled }) => !enabled)).toBe(true);

    expect(() =>
      parsed((input) => {
        (input.backend as { enabled: boolean }).enabled = false;
        (
          input.backend.moduleConfiguration as {
            connection: { channel: { executablePath: string } };
          }
        ).connection.channel.executablePath = "relative/codex";
      }),
    ).toThrow();
  });

  it("rejects every backend or connection outside the Codex-owned pairing", () => {
    expect(() =>
      parsed((input) => {
        (input.backend as { kind: string }).kind = "pi";
      }),
    ).toThrow("codex_backend_release_configuration_invalid");
    expect(() =>
      parsed((input) => {
        (
          input.connections[0] as {
            kind: string;
          }
        ).kind = "pi_sdk";
      }),
    ).toThrow("codex_connection_configuration_invalid");
    expect(() =>
      parsed((input) => {
        (
          input.connections[0] as {
            backendInstanceId: string;
          }
        ).backendInstanceId = "another-backend";
      }),
    ).toThrow("codex_connection_configuration_invalid");
  });

  it.each([
    ["relative executable", "channel", "executablePath", "bin/codex"],
    [
      "noncanonical Codex home",
      "channel",
      "codexHome",
      "/var/lib/sedes/../codex",
    ],
    ["relative working directory", "channel", "workingDirectory", "."],
    [
      "control-bearing working directory",
      "channel",
      "workingDirectory",
      "/var/lib/sedes/codex\ninjected",
    ],
    ["overlong Codex home", "channel", "codexHome", `/${"a".repeat(4_096)}`],
  ])("rejects %s", (_label, objectName, fieldName, invalidValue) => {
    expect(() =>
      parsed((input) => {
        const configuration = input.backend.moduleConfiguration as Record<
          string,
          unknown
        >;
        const object = (configuration.connection as Record<string, unknown>)
          .channel as Record<string, unknown>;
        object[fieldName] = invalidValue;
      }),
    ).toThrow();
  });

  it("rejects a noncanonical managed TUI executable override", () => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).tuiExecutablePath = "/opt/codex/../bin/codex";
      }),
    ).toThrow();
  });

  it("accepts the frozen external Unix and TCP WebSocket contracts", () => {
    const unix = parsed((input) => {
      const moduleConfiguration = input.backend.moduleConfiguration as Record<
        string,
        unknown
      >;
      moduleConfiguration.tuiExecutablePath = "/opt/codex/bin/codex";
      moduleConfiguration.connection = {
        ownership: "external",
        channel: {
          type: "unix_websocket",
          socketPath: "/run/sedes/codex.sock",
        },
      };
    });
    expect(unix.configuration.connection).toEqual({
      ownership: "external",
      channel: {
        type: "unix_websocket",
        socketPath: "/run/sedes/codex.sock",
      },
    });
    expect(unix.configuration.tuiExecutablePath).toBe("/opt/codex/bin/codex");

    const tcpEnvironmentSecret = parsed((input) => {
      (
        input.backend.moduleConfiguration as Record<string, unknown>
      ).connection = {
        ownership: "external",
        channel: {
          type: "tcp_websocket",
          url: "wss://codex.example:443",
          authentication: {
            type: "capability_token",
            secret: {
              source: "environment",
              variable: "SEDES_CODEX_TOKEN",
            },
          },
        },
      };
    });
    expect(tcpEnvironmentSecret.configuration.connection).toMatchObject({
      ownership: "external",
      channel: {
        type: "tcp_websocket",
        url: "wss://codex.example:443",
        authentication: {
          secret: {
            source: "environment",
            variable: "SEDES_CODEX_TOKEN",
          },
        },
      },
    });

    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).connection = {
          ownership: "external",
          channel: {
            type: "tcp_websocket",
            url: "ws://[::1]:4500",
            authentication: {
              type: "capability_token",
              secret: {
                source: "protected_file",
                path: "/run/secrets/codex-token",
              },
            },
          },
        };
      }),
    ).not.toThrow();
  });

  it.each(["unix_websocket", "tcp_websocket"])(
    "rejects Codex home and removed server identity for external %s",
    (channelType) => {
      const externalChannel =
        channelType === "unix_websocket"
          ? {
              type: "unix_websocket",
              socketPath: "/run/sedes/codex.sock",
            }
          : {
              type: "tcp_websocket",
              url: "wss://codex.example:443",
              authentication: {
                type: "capability_token",
                secret: {
                  source: "environment",
                  variable: "SEDES_CODEX_TOKEN",
                },
              },
            };

      expect(() =>
        parsed((input) => {
          (
            input.backend.moduleConfiguration as Record<string, unknown>
          ).connection = {
            ownership: "external",
            channel: {
              ...externalChannel,
              codexHome: "/var/lib/sedes/codex/principal-one",
            },
          };
        }),
      ).toThrow();

      expect(() =>
        parsed((input) => {
          const configuration = input.backend.moduleConfiguration as Record<
            string,
            unknown
          >;
          configuration.connection = {
            ownership: "external",
            channel: externalChannel,
          };
          configuration.serverIdentity = {
            codexHome: "/var/lib/sedes/codex/principal-one",
          };
        }),
      ).toThrow();
    },
  );

  it("rejects a Unix socket path that cannot fit the local sockaddr", () => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).connection = {
          ownership: "external",
          channel: {
            type: "unix_websocket",
            socketPath: `/run/${"x".repeat(104)}`,
          },
        };
      }),
    ).toThrow(/filesystem-socket limit/i);
  });

  it.each([
    [
      "removed monolithic transport",
      {
        transport: {
          type: "stdio",
          executablePath: "/opt/codex/0.153.0/bin/codex",
          codexHome: "/var/lib/sedes/codex/principal-one",
          workingDirectory: "/var/lib/sedes/codex",
        },
      },
    ],
    [
      "owned Unix socket",
      {
        connection: {
          ownership: "owned",
          channel: {
            type: "unix_websocket",
            socketPath: "/run/sedes/codex.sock",
          },
        },
      },
    ],
    [
      "external process stdio",
      {
        connection: {
          ownership: "external",
          channel: {
            type: "process_stdio",
            executablePath: "/opt/codex/0.153.0/bin/codex",
            workingDirectory: "/var/lib/sedes/codex",
          },
        },
      },
    ],
    [
      "environment-prefixed channel",
      {
        connection: {
          ownership: "owned",
          channel: {
            type: "local_process_stdio",
            executablePath: "/opt/codex/0.153.0/bin/codex",
            workingDirectory: "/var/lib/sedes/codex",
          },
        },
      },
    ],
    [
      "fallback channel list",
      {
        connection: {
          ownership: "owned",
          channels: [
            {
              type: "process_stdio",
              executablePath: "/opt/codex/0.153.0/bin/codex",
              workingDirectory: "/var/lib/sedes/codex",
            },
          ],
        },
      },
    ],
  ])("rejects %s", (_label, replacement) => {
    expect(() =>
      parsed((input) => {
        const configuration = input.backend.moduleConfiguration as Record<
          string,
          unknown
        >;
        if ("transport" in replacement) {
          delete configuration.connection;
          configuration.transport = replacement.transport;
        } else {
          configuration.connection = replacement.connection;
        }
      }),
    ).toThrow();
  });

  it.each([
    "wss://codex.example",
    "wss://codex.example:443/",
    "wss://user@codex.example:443",
    "wss://user:password@codex.example:443",
    "wss://codex.example:443/path",
    "wss://codex.example:443?query=true",
    "wss://codex.example:443#fragment",
    "wss://codex.example:443\\path",
    "wss://codex.example:443\n",
    "ws://codex.example:4500",
    "ws://localhost:4500",
    "tcp://127.0.0.1:4500",
    "http://127.0.0.1:4500",
    "https://codex.example:443",
    "wss://codex.example:0",
    "wss://codex.example:65536",
    "WSS://codex.example:443",
    "wss://CODEX.example:443",
    "wss://%63odex.example:443",
    "wss://codex.example.:443",
    "wss://codex.example:0443",
    "wss://127.000.000.001:443",
    "wss://[0:0:0:0:0:0:0:1]:443",
  ])("rejects unsafe TCP WebSocket URL %s", (url) => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).connection = {
          ownership: "external",
          channel: {
            type: "tcp_websocket",
            url,
            authentication: {
              type: "capability_token",
              secret: {
                source: "environment",
                variable: "SEDES_CODEX_TOKEN",
              },
            },
          },
        };
      }),
    ).toThrow();
  });

  it.each([
    "literal-secret",
    { source: "literal", value: "literal-secret" },
    { source: "environment", variable: "" },
    { source: "environment", variable: "1INVALID" },
    { source: "environment", variable: "OPENAI_API_KEY" },
    { source: "environment", variable: "SEDES_CODEX_SECRET" },
    { source: "environment", variable: "SEDES_CODEX_primary_TOKEN" },
    { source: "environment", variable: "SEDES_CODEX_TOKEN-NAME" },
    { source: "environment", variable: "SEDES_TOKEN", extra: true },
    { source: "file", path: "/run/secrets/codex-token" },
    { source: "protected_file", path: "run/secrets/codex-token" },
    {
      source: "protected_file",
      path: "/run/secrets/../codex-token",
    },
  ])("rejects literal or malformed secret reference %#", (secret) => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).connection = {
          ownership: "external",
          channel: {
            type: "tcp_websocket",
            url: "wss://codex.example:443",
            authentication: {
              type: "capability_token",
              secret,
            },
          },
        };
      }),
    ).toThrow();
  });

  it.each([
    ["connection", "connection"],
    ["channel", "channel"],
  ])("rejects unknown %s fields", (_label, location) => {
    expect(() =>
      parsed((input) => {
        const configuration = input.backend.moduleConfiguration as Record<
          string,
          unknown
        >;
        if (location === "connection") {
          (configuration.connection as Record<string, unknown>).extra = true;
        } else {
          (
            (configuration.connection as Record<string, unknown>)
              .channel as Record<string, unknown>
          ).extra = true;
        }
      }),
    ).toThrow();
  });

  it.each(["untrusted", "on-request", "never"])(
    "accepts unrestricted defaults with enabled network and allowed %s approvals",
    (approvalPolicy) => {
      const result = parsed((input) => {
        const backend = input.backend.moduleConfiguration as {
          policy: { allowedSandboxModes: string[] };
        };
        backend.policy.allowedSandboxModes.push("danger-full-access");
        const configuration = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        configuration.defaults.sandboxMode = "danger-full-access";
        configuration.defaults.approvalPolicy = approvalPolicy;
      });
      expect(result.connections[0]!.configuration.defaults).toMatchObject({
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        approvalPolicy,
      });
    },
  );

  it("rejects unrestricted defaults with disabled network even when both values are allowed", () => {
    expect(() =>
      parsed((input) => {
        const backend = input.backend.moduleConfiguration as {
          policy: { allowedSandboxModes: string[] };
        };
        backend.policy.allowedSandboxModes.push("danger-full-access");
        const configuration = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        configuration.defaults.sandboxMode = "danger-full-access";
        configuration.defaults.networkAccess = "disabled";
      }),
    ).toThrow("codex_connection_defaults_invalid");
  });

  it("rejects unknown connection fields and defaults outside backend policy", () => {
    expect(() =>
      parsed((input) => {
        const configuration = input.connections[0]!
          .moduleConfiguration as Record<string, unknown>;
        configuration.url = "ws://127.0.0.1:4500";
      }),
    ).toThrow();

    expect(() =>
      parsed((input) => {
        const configuration = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        configuration.defaults.sandboxMode = "danger-full-access";
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");
    expect(() =>
      parsed((input) => {
        const backend = input.backend.moduleConfiguration as {
          policy: { allowedSandboxModes: string[] };
        };
        backend.policy.allowedSandboxModes = ["read-only"];
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");
    expect(() =>
      parsed((input) => {
        const backend = input.backend.moduleConfiguration as {
          policy: { allowedNetworkAccess: string[] };
        };
        backend.policy.allowedNetworkAccess = ["disabled"];
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");
    expect(() =>
      parsed((input) => {
        const configuration = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        configuration.defaults.model = {
          type: "fixed",
          modelId: "gpt-unapproved",
        };
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");
    expect(() =>
      parsed((input) => {
        const configuration = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        configuration.defaults.model = { type: "catalogDefault" };
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");
  });

  it("rejects a fixed default that a denylist excludes at every effort", () => {
    expect(() =>
      parsed((input) => {
        (input.backend as { modelPolicy: unknown }).modelPolicy = {
          type: "denylist",
          denied: [{ modelIds: ["gpt-5.6-luna"] }],
        };
      }),
    ).toThrow("codex_connection_defaults_outside_backend_policy");

    expect(() =>
      parsed((input) => {
        (input.backend as { modelPolicy: unknown }).modelPolicy = {
          type: "denylist",
          denied: [
            {
              modelIds: ["gpt-5.6-luna"],
              reasoningEfforts: ["high"],
            },
          ],
        };
      }),
    ).not.toThrow();
  });

  it("rejects the obsolete bundled permission profile shape", () => {
    expect(() =>
      parsed((input) => {
        const policy = (
          input.backend.moduleConfiguration as {
            policy: Record<string, unknown>;
          }
        ).policy;
        delete policy.allowedSandboxModes;
        delete policy.allowedNetworkAccess;
        delete policy.allowedApprovalPolicies;
        delete policy.allowedApprovalReviewers;
        policy.allowedPermissionProfiles = ["read_only"];
      }),
    ).toThrow();
    expect(() =>
      parsed((input) => {
        const defaults = input.connections[0]!.moduleConfiguration as {
          defaults: Record<string, unknown>;
        };
        delete defaults.defaults.sandboxMode;
        delete defaults.defaults.networkAccess;
        delete defaults.defaults.approvalPolicy;
        delete defaults.defaults.approvalReviewer;
        defaults.defaults.defaultPermissionProfile = "read_only";
      }),
    ).toThrow();
  });

  it("requires explicit, nonempty, unique policy allowlists", () => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.modelPolicy as unknown as { allowed: unknown[] }
        ).allowed = [];
      }),
    ).toThrow();
    expect(() =>
      parsed((input) => {
        const configuration = input.backend.moduleConfiguration as {
          policy: { allowedApprovalPolicies: string[] };
        };
        configuration.policy.allowedApprovalPolicies = [
          "on-request",
          "on-request",
        ];
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parsed((input) => {
        const configuration = input.backend.moduleConfiguration as {
          policy: {
            allowedSandboxModes: string[];
            allowedNetworkAccess: string[];
          };
        };
        configuration.policy.allowedSandboxModes = ["danger-full-access"];
        configuration.policy.allowedNetworkAccess = ["disabled"];
      }),
    ).toThrow(/no valid setting tuple/i);
  });

  it("supports catalog policy with either catalog-default or fixed model selection", () => {
    const catalogDefault = parsed((input) => {
      (input.backend as { modelPolicy: unknown }).modelPolicy = {
        type: "catalog",
      };
      for (const connection of input.connections) {
        const configuration = connection.moduleConfiguration as {
          defaults: { model: unknown };
        };
        configuration.defaults.model = { type: "catalogDefault" };
      }
    });
    expect(catalogDefault.connections[0]!.configuration.defaults.model).toEqual(
      { type: "catalogDefault" },
    );

    const fixed = parsed((input) => {
      (input.backend as { modelPolicy: unknown }).modelPolicy = {
        type: "catalog",
      };
    });
    expect(fixed.connections[0]!.configuration.defaults.model).toEqual({
      type: "fixed",
      modelId: "gpt-5.6-luna",
    });
  });

  it("rejects the removed account-identity policy", () => {
    expect(() =>
      parsed((input) => {
        (
          input.backend.moduleConfiguration as Record<string, unknown>
        ).expectedAccount = { type: "chatgpt" };
      }),
    ).toThrow();
  });
});
