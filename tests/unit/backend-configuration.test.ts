import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultBackendConfiguration,
  localWorkspaceIsolationPolicy,
  loadBackendConfigurationFile,
  parseBackendConfiguration,
  resolveBackendConfigurationFilename,
} from "../../src/server/config/backend-configuration.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";

const roots: string[] = [];
const localEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const sshEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";
const secondSshEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978407";

const validConfiguration = {
  schemaVersion: 10,
  packagedClients: [],
  executionEnvironments: [
    {
      id: localEnvironmentId,
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "local-pi",
      kind: "pi",
      label: "Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-pi-sdk",
      kind: "pi_sdk",
      label: "Local SDK",
      backendInstanceId: "local-pi",
      executionEnvironmentId: localEnvironmentId,
      enabled: true,
    },
  ],
  defaultTargetId: "local-pi-sdk",
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("backend operator configuration", () => {
  it("resolves the production server configuration file from an explicit override or XDG", () => {
    expect(
      resolveBackendConfigurationFilename({
        SEDES_CONFIG_FILE: "  /srv/sedes/custom.json  ",
        XDG_CONFIG_HOME: "/ignored",
      }),
    ).toBe("/srv/sedes/custom.json");
    expect(
      resolveBackendConfigurationFilename({
        XDG_CONFIG_HOME: "/var/lib/operator-config",
      }),
    ).toBe("/var/lib/operator-config/sedes/server.json");
    expect(
      resolveBackendConfigurationFilename({
        SEDES_CONFIG_FILE: "   ",
        XDG_CONFIG_HOME: "/var/lib/operator-config",
      }),
    ).toBe("/var/lib/operator-config/sedes/server.json");
    expect(resolveBackendConfigurationFilename({ XDG_CONFIG_HOME: "" })).toBe(
      path.join(os.homedir(), ".config", "sedes", "server.json"),
    );
    expect(
      resolveBackendConfigurationFilename({
        HOME: "/srv/service-account",
        XDG_CONFIG_HOME: "",
      }),
    ).toBe("/srv/service-account/.config/sedes/server.json");
    expect(resolveBackendConfigurationFilename({})).toBe(
      path.join(os.homedir(), ".config", "sedes", "server.json"),
    );
  });

  it("rejects relative production configuration roots", () => {
    expect(() =>
      resolveBackendConfigurationFilename({
        SEDES_CONFIG_FILE: "config/legacy-import/server.json",
      }),
    ).toThrow("SEDES_CONFIG_FILE must be an absolute path");
    expect(() =>
      resolveBackendConfigurationFilename({ XDG_CONFIG_HOME: "relative" }),
    ).toThrow("XDG_CONFIG_HOME must be an absolute path");
    expect(() =>
      resolveBackendConfigurationFilename({ HOME: "relative" }),
    ).toThrow("HOME must be an absolute path");
  });

  it("normalizes omitted packaged clients to disabled", () => {
    const {
      packagedClients: _packagedClients,
      ...configurationWithoutPackagedClients
    } = validConfiguration;
    expect(
      parseBackendConfiguration(configurationWithoutPackagedClients)
        .packagedClients,
    ).toEqual([]);
  });

  it.each([
    [[]],
    [["android"]],
    [["electron"]],
    [["android", "electron"]],
  ] as const)("accepts canonical packaged clients: %j", (packagedClients) => {
    expect(
      parseBackendConfiguration({
        ...validConfiguration,
        packagedClients,
      }).packagedClients,
    ).toEqual(packagedClients);
  });

  it.each([
    null,
    true,
    "android",
    {},
    ["electron", "android"],
    ["android", "android"],
    ["electron", "electron"],
    ["android", "electron", "android"],
    ["browser"],
    ["Android"],
  ])("rejects invalid packaged clients: %j", (packagedClients) => {
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        packagedClients,
      }),
    ).toThrow();
  });

  it("rejects the obsolete schema-v9 operator configuration", () => {
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 9,
      }),
    ).toThrow();
  });

  it("accepts an optional canonical Grok home for provider-neutral web search", () => {
    expect(
      parseBackendConfiguration({
        ...validConfiguration,
        webSearch: {
          provider: "grok_cli",
          grokHome: "/var/lib/sedes/grok-web-search",
        },
      }).webSearch,
    ).toEqual({
      provider: "grok_cli",
      grokHome: "/var/lib/sedes/grok-web-search",
    });
    expect(
      parseBackendConfiguration(validConfiguration).webSearch,
    ).toBeUndefined();
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        webSearch: { provider: "grok_cli", grokHome: "relative" },
      }),
    ).toThrow(/canonical absolute/i);
  });

  it("defaults local Bubblewrap authority to isolated networking only", () => {
    const configuration = parseBackendConfiguration(validConfiguration);
    const local = configuration.executionEnvironments[0]!;
    if (local.kind !== "local") throw new Error("Expected local environment.");

    expect(localWorkspaceIsolationPolicy(local)).toEqual({
      kind: "bubblewrap",
      networkProfiles: ["isolated"],
    });
  });

  it("requires an explicit canonical opt-in for execution-host networking", () => {
    const configuration = parseBackendConfiguration({
      ...validConfiguration,
      executionEnvironments: [
        {
          ...validConfiguration.executionEnvironments[0],
          workspaceIsolation: {
            kind: "bubblewrap",
            networkProfiles: ["isolated", "execution_host"],
          },
        },
      ],
    });
    const local = configuration.executionEnvironments[0]!;
    if (local.kind !== "local") throw new Error("Expected local environment.");
    expect(localWorkspaceIsolationPolicy(local).networkProfiles).toEqual([
      "isolated",
      "execution_host",
    ]);

    for (const networkProfiles of [
      ["execution_host"],
      ["execution_host", "isolated"],
      ["isolated", "isolated"],
      ["isolated", "unknown"],
    ]) {
      expect(() =>
        parseBackendConfiguration({
          ...validConfiguration,
          executionEnvironments: [
            {
              ...validConfiguration.executionEnvironments[0],
              workspaceIsolation: {
                kind: "bubblewrap",
                networkProfiles,
              },
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("keeps the checked-in Claude configuration example valid", async () => {
    const example = compiledBackendModuleCatalog.resolveConfiguration(
      await loadBackendConfigurationFile(
        path.resolve("config/legacy-import/server.claude.example.json"),
      ),
    );

    expect(defaultBackendConfiguration(example)).toMatchObject({
      backend: {
        kind: "claude_agent_sdk",
        protocolRelease: "0.3.283",
      },
      target: { kind: "claude_agent_sdk" },
    });
  });

  it("imports remote Claude while preserving enabled targets and historical definition IDs", async () => {
    const local = await loadBackendConfigurationFile(path.resolve("config/legacy-import/server.claude.example.json"));
    const remote = compiledBackendModuleCatalog.resolveConfiguration(parseBackendConfiguration({
      ...local,
      executionEnvironments: [...local.executionEnvironments, { id: sshEnvironmentId, kind: "ssh", label: "Remote retained", hostAlias: "legacy-host", workspaceRoots: ["/workspace"], operations: { kind: "none" } }],
      targets: local.targets.map(target => ({ ...target, executionEnvironmentId: sshEnvironmentId })),
    }));
    const input = { configuration: remote, localWorkspaceRoots: ["/workspace"], sourceLabel: "test" };
    const imported = convertLegacyConfiguration(input);
    expect(imported.document.targets.map(target => ({ id: target.id, enabled: target.enabled, executionEnvironmentId: target.executionEnvironmentId }))).toEqual(
      remote.targets.map(target => ({ id: target.id, enabled: target.enabled, executionEnvironmentId: sshEnvironmentId })),
    );
    expect(imported.document.backends.map(backend => backend.enabled)).toEqual(remote.backends.map(backend => backend.enabled));
    expect(imported.document.defaultTargetId).toBe(remote.defaultTargetId);
  });

  it("keeps every checked-in schema-v10 configuration example valid", async () => {
    const filenames = [
      "server.example.json",
      "server.grok.example.json",
      "server.claude.example.json",
      "server.codex.example.json",
      "server.codex-uds.example.json",
      "server.codex-tcp.example.json",
      "server.codex-ssh-uds.example.json",
      "server.codex-ssh-uds-sidecar.example.json",
      "server.pi-ssh-sidecar.example.json",
    ];
    const examples = await Promise.all(
      filenames.map((filename) =>
        loadBackendConfigurationFile(path.resolve("config/legacy-import", filename)),
      ),
    );

    expect(examples.every(({ schemaVersion }) => schemaVersion === 10)).toBe(
      true,
    );
    expect(examples[0]?.packagedClients).toEqual([]);
    expect(
      examples.every(({ packagedClients }) => packagedClients.length === 0),
    ).toBe(true);
    for (const example of examples) {
      const preparedExample = compiledBackendModuleCatalog.resolveConfiguration(
        {
          ...example,
          backends: example.backends.map((backend) =>
            backend.kind === "claude_agent_sdk"
              ? {
                  ...backend,
                  moduleConfiguration: {
                    ...backend.moduleConfiguration,
                    executablePath: process.execPath,
                  },
                }
              : backend,
          ),
        },
      );
      expect(() =>
        compiledBackendModuleCatalog.prepare({
          backends: preparedExample.backends,
          connections: preparedExample.targets,
          executionEnvironments: preparedExample.executionEnvironments.map(
            ({ id, kind }) => ({ id, kind }),
          ),
          environment: {
            PI_CODING_AGENT_DIR: "/tmp/sedes-doc-example-pi-agent",
            PI_CODING_AGENT_SESSION_DIR: "/tmp/sedes-doc-example-pi-sessions",
            SEDES_CODEX_LOCAL_TOKEN: "documentation-example-token",
          },
        }),
      ).not.toThrow();
    }
    const sidecar = examples.at(-2)!;
    expect(sidecar.executionEnvironments[1]).toMatchObject({
      kind: "ssh",
      operations: {
        kind: "sidecar",
        enabledCapabilities: [
          "directory_browser",
          "workspace_files",
          "composer_attachments",
          "agent_tools_cli",
          "interactive_terminal",
        ],
      },
    });
    expect(sidecar.targets[0]?.moduleConfiguration).toMatchObject({
      defaults: { networkAccess: "enabled" },
    });
    const remotePi = examples.at(-1)!;
    expect(remotePi.executionEnvironments[1]).toMatchObject({
      kind: "ssh",
      operations: {
        kind: "sidecar",
        enabledCapabilities: [
          "workspace_files",
          "workspace_tools",
          "workspace_context",
          "workspace_skills",
          "interactive_terminal",
        ],
      },
    });
    expect(remotePi.targets[0]).toMatchObject({
      kind: "pi_sdk",
      executionEnvironmentId: sshEnvironmentId,
    });
  });

  it("rejects operator release pins and stamps Claude's compiled release", () => {
    const configuration = {
      schemaVersion: 10,
      executionEnvironments: [
        {
          id: localEnvironmentId,
          kind: "local",
          label: "Local",
        },
      ],
      backends: [
        {
          id: "claude-local",
          kind: "claude_agent_sdk",
          label: "Claude",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
      ],
      targets: [
        {
          id: "claude-local-default",
          kind: "claude_agent_sdk",
          label: "Claude",
          backendInstanceId: "claude-local",
          executionEnvironmentId: localEnvironmentId,
          enabled: true,
        },
      ],
      defaultTargetId: "claude-local-default",
    } as const;

    const parsed = parseBackendConfiguration(configuration);
    expect(parsed).toEqual({ ...configuration, packagedClients: [] });
    expect(
      compiledBackendModuleCatalog.resolveConfiguration(parsed).backends[0]
        ?.protocolRelease,
    ).toBe("0.3.283");
    expect(() =>
      parseBackendConfiguration({
        ...configuration,
        backends: [
          { ...configuration.backends[0], protocolRelease: "0.3.225" },
        ],
      }),
    ).toThrow();
  });

  it("rejects operator release pins and stamps Grok's compiled release", () => {
    const configuration = {
      schemaVersion: 10,
      executionEnvironments: [
        { id: localEnvironmentId, kind: "local", label: "Local" },
      ],
      backends: [
        {
          id: "grok-local",
          kind: "grok_build",
          label: "Grok",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
      ],
      targets: [
        {
          id: "grok-local-default",
          kind: "grok_acp",
          label: "Grok",
          backendInstanceId: "grok-local",
          executionEnvironmentId: localEnvironmentId,
          enabled: true,
        },
      ],
      defaultTargetId: "grok-local-default",
    } as const;
    const parsed = parseBackendConfiguration(configuration);
    expect(parsed).toEqual({ ...configuration, packagedClients: [] });
    expect(
      compiledBackendModuleCatalog.resolveConfiguration(parsed).backends[0]
        ?.protocolRelease,
    ).toBe("1.x");
    expect(() =>
      parseBackendConfiguration({
        ...configuration,
        backends: [{ ...configuration.backends[0], protocolRelease: "1.0.4" }],
      }),
    ).toThrow();
    expect(() =>
      parseBackendConfiguration({
        ...configuration,
        executionEnvironments: [
          { id: localEnvironmentId, kind: "local", label: "Local" },
          {
            id: sshEnvironmentId,
            kind: "ssh",
            label: "Remote",
            hostAlias: "srv",
            workspaceRoots: ["/srv/workspaces"],
            operations: { kind: "none" },
          },
        ],
        targets: [
          {
            ...configuration.targets[0],
            executionEnvironmentId: sshEnvironmentId,
          },
        ],
      }),
    ).toThrow(/Grok target.*local execution environment/i);
  });

  it("accepts a Claude Agent SDK target in an SSH environment without optional operations", () => {
    expect(
      parseBackendConfiguration({
        schemaVersion: 10,
        executionEnvironments: [
          ...validConfiguration.executionEnvironments,
          {
            id: sshEnvironmentId,
            kind: "ssh",
            label: "Remote",
            hostAlias: "srv",
            workspaceRoots: ["/srv/workspaces"],
            operations: { kind: "none" },
          },
        ],
        backends: [
          {
            id: "claude-local",
            kind: "claude_agent_sdk",
            label: "Claude",
            enabled: true,
            modelPolicy: { type: "catalog" },
          },
        ],
        targets: [
          {
            id: "claude-remote",
            kind: "claude_agent_sdk",
            label: "Claude",
            backendInstanceId: "claude-local",
            executionEnvironmentId: sshEnvironmentId,
            enabled: true,
          },
        ],
        defaultTargetId: "claude-remote",
      }).targets[0],
    ).toMatchObject({
      kind: "claude_agent_sdk",
      executionEnvironmentId: sshEnvironmentId,
    });
  });

  it("accepts multiple enabled compatible targets and resolves the default", () => {
    const multiple = {
      ...validConfiguration,
      backends: [
        ...validConfiguration.backends,
        {
          ...validConfiguration.backends[0],
          id: "second-pi",
          label: "Second Pi",
        },
      ],
      targets: [
        ...validConfiguration.targets,
        {
          ...validConfiguration.targets[0],
          id: "second-pi-sdk",
          backendInstanceId: "second-pi",
          label: "Second SDK",
        },
      ],
    } as const;
    const parsed = parseBackendConfiguration(multiple);
    expect(defaultBackendConfiguration(parsed)).toEqual({
      backend: multiple.backends[0],
      target: multiple.targets[0],
    });
  });

  it("rejects obsolete schema versions, unsupported, duplicate, and dangling targets", () => {
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 1,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 3,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 4,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 5,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 6,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 7,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        schemaVersion: 8,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        unknown: true,
      }),
    ).toThrow();

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        backends: [
          ...validConfiguration.backends,
          validConfiguration.backends[0],
        ],
      }),
    ).toThrow(/duplicated/i);

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        targets: [
          {
            ...validConfiguration.targets[0],
            backendInstanceId: "missing-backend",
          },
        ],
      }),
    ).toThrow(/unknown backend/i);

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        targets: [
          {
            ...validConfiguration.targets[0],
            executionEnvironmentId: sshEnvironmentId,
          },
        ],
      }),
    ).toThrow(/unknown execution environment/i);
  });

  it("requires exactly one local environment and allows multiple SSH environments", () => {
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [],
      }),
    ).toThrow();
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [
          validConfiguration.executionEnvironments[0],
          {
            ...validConfiguration.executionEnvironments[0],
            id: sshEnvironmentId,
          },
        ],
      }),
    ).toThrow(/exactly one local/i);
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [
          validConfiguration.executionEnvironments[0],
          validConfiguration.executionEnvironments[0],
        ],
      }),
    ).toThrow(/duplicated/i);
    expect(
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [
          validConfiguration.executionEnvironments[0],
          {
            id: sshEnvironmentId,
            kind: "ssh",
            label: "srv",
            hostAlias: "srv",
            workspaceRoots: ["/srv/worktrees"],
            operations: { kind: "none" },
          },
          {
            id: secondSshEnvironmentId,
            kind: "ssh",
            label: "other",
            hostAlias: "other",
            workspaceRoots: ["/srv/worktrees"],
            operations: { kind: "none" },
          },
        ],
      }).executionEnvironments,
    ).toHaveLength(3);
  });

  it("accepts canonical SSH environments for external Codex UDS targets", () => {
    const remote = {
      schemaVersion: 10,
      executionEnvironments: [
        validConfiguration.executionEnvironments[0],
        {
          id: sshEnvironmentId,
          kind: "ssh",
          label: "srv",
          hostAlias: "srv",
          workspaceRoots: ["/home/operator/projects"],
          operations: { kind: "none" },
        },
      ],
      backends: [
        {
          id: "remote-codex",
          kind: "codex_app_server",
          label: "Remote Codex",
          enabled: true,
          modelPolicy: { type: "catalog" },
          moduleConfiguration: {
            connection: {
              ownership: "external",
              channel: {
                type: "unix_websocket",
                socketPath: "/home/operator/.codex/app-server.sock",
              },
            },
          },
        },
      ],
      targets: [
        {
          id: "remote-codex",
          kind: "codex_app_server",
          label: "Remote Codex",
          backendInstanceId: "remote-codex",
          executionEnvironmentId: sshEnvironmentId,
          enabled: true,
        },
      ],
      defaultTargetId: "remote-codex",
    } as const;

    expect(parseBackendConfiguration(remote)).toEqual({
      ...remote,
      packagedClients: [],
    });
    expect(() =>
      parseBackendConfiguration({
        ...remote,
        targets: [
          ...remote.targets,
          {
            ...remote.targets[0],
            id: "local-codex",
            executionEnvironmentId: localEnvironmentId,
          },
        ],
      }),
    ).toThrow(/cannot span execution environments/i);

    for (const workspaceRoot of [
      "relative",
      "/home/operator/../root",
      "/home/operator/",
      "/home//operator",
      "/home/operator\\forbidden",
    ]) {
      expect(() =>
        parseBackendConfiguration({
          ...remote,
          executionEnvironments: [
            remote.executionEnvironments[0],
            {
              ...remote.executionEnvironments[1],
              workspaceRoots: [workspaceRoot],
            },
          ],
        }),
      ).toThrow(/canonical absolute POSIX/i);
    }
  });

  it("requires one closed operations policy on every SSH environment", () => {
    const baseSshEnvironment = {
      id: sshEnvironmentId,
      kind: "ssh",
      label: "srv",
      hostAlias: "srv",
      workspaceRoots: ["/home/operator/projects"],
    } as const;
    const configurationWith = (operations: unknown) => ({
      ...validConfiguration,
      executionEnvironments: [
        validConfiguration.executionEnvironments[0],
        { ...baseSshEnvironment, operations },
      ],
    });

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [
          validConfiguration.executionEnvironments[0],
          baseSshEnvironment,
        ],
      }),
    ).toThrow();
    expect(
      parseBackendConfiguration(configurationWith({ kind: "none" })),
    ).toBeDefined();
    for (const enabledCapabilities of [
      ["directory_browser"],
      ["workspace_files"],
      ["composer_attachments"],
      ["agent_tools_cli"],
      ["workspace_tools", "workspace_context"],
      ["workspace_skills"],
      ["workspace_files", "composer_attachments"],
      ["workspace_files", "agent_tools_cli"],
      ["composer_attachments", "agent_tools_cli"],
      ["workspace_files", "composer_attachments", "agent_tools_cli"],
      [
        "directory_browser",
        "workspace_files",
        "workspace_tools",
        "workspace_context",
        "workspace_skills",
        "composer_attachments",
        "agent_tools_cli",
      ],
    ]) {
      expect(
        parseBackendConfiguration(
          configurationWith({
            kind: "sidecar",
            deployment: "managed",
            carrier: { kind: "ssh_stdio" },
            enabledCapabilities,
          }),
        ),
      ).toBeDefined();
    }

    for (const operations of [
      { kind: "none", extra: true },
      { kind: "sidecar" },
      {
        kind: "sidecar",
        deployment: "external",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_files"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "tcp" },
        enabledCapabilities: ["workspace_files"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: [],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_files", "workspace_files"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_files", "directory_browser"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["composer_attachments", "workspace_files"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["agent_tools_cli", "workspace_files"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["agent_tools_cli", "composer_attachments"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: [
          "workspace_files",
          "agent_tools_cli",
          "composer_attachments",
        ],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_tools"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_context"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["workspace_context", "workspace_tools"],
      },
      {
        kind: "sidecar",
        deployment: "managed",
        carrier: { kind: "ssh_stdio" },
        enabledCapabilities: ["shell"],
      },
    ]) {
      expect(() =>
        parseBackendConfiguration(configurationWith(operations)),
      ).toThrow();
    }

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: [
          {
            ...validConfiguration.executionEnvironments[0],
            operations: { kind: "none" },
          },
        ],
      }),
    ).toThrow();
  });

  it("admits SSH Pi only with its complete sidecar bundle and keeps other SSH backends unsupported", () => {
    const environments = [
      validConfiguration.executionEnvironments[0],
      {
        id: sshEnvironmentId,
        kind: "ssh",
        label: "srv",
        hostAlias: "srv",
        workspaceRoots: ["/home/operator/projects"],
        operations: { kind: "none" },
      },
    ] as const;
    const remotePi = (enabledCapabilities: readonly string[]) => ({
      ...validConfiguration,
      executionEnvironments: [
        environments[0],
        {
          ...environments[1],
          operations: {
            kind: "sidecar" as const,
            deployment: "managed" as const,
            carrier: { kind: "ssh_stdio" as const },
            enabledCapabilities,
          },
        },
      ],
      targets: [
        {
          ...validConfiguration.targets[0],
          executionEnvironmentId: sshEnvironmentId,
        },
      ],
    });
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: environments,
        targets: [
          {
            ...validConfiguration.targets[0],
            executionEnvironmentId: sshEnvironmentId,
          },
        ],
      }),
    ).toThrow(
      /Pi target.*complete managed workspace_tools.*workspace_context/i,
    );
    expect(() =>
      parseBackendConfiguration(remotePi(["workspace_tools"])),
    ).toThrow(/complete managed workspace_tools.*workspace_context/i);
    expect(() =>
      parseBackendConfiguration(remotePi(["workspace_context"])),
    ).toThrow(/complete managed workspace_tools.*workspace_context/i);
    expect(
      parseBackendConfiguration(
        remotePi(["workspace_tools", "workspace_context"]),
      ).targets[0]?.executionEnvironmentId,
    ).toBe(sshEnvironmentId);

    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        executionEnvironments: environments,
        backends: [
          {
            id: "remote-codex",
            kind: "codex_app_server",
            label: "Remote Codex",
            enabled: true,
            modelPolicy: { type: "catalog" },
            moduleConfiguration: {
              connection: {
                ownership: "external",
                channel: {
                  type: "tcp_websocket",
                  url: "ws://127.0.0.1:4500",
                },
              },
            },
          },
        ],
        targets: [
          {
            id: "remote-codex",
            kind: "codex_app_server",
            label: "Remote Codex",
            backendInstanceId: "remote-codex",
            executionEnvironmentId: sshEnvironmentId,
            enabled: true,
          },
        ],
        defaultTargetId: "remote-codex",
      }),
    ).toThrow(/external Codex Unix-WebSocket/i);
  });

  it("rejects disabled and missing defaults and bounds module configuration", () => {
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        targets: [{ ...validConfiguration.targets[0], enabled: false }],
      }),
    ).toThrow(/enabled/i);
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        defaultTargetId: "missing-target",
      }),
    ).toThrow(/does not exist/i);
    expect(() =>
      parseBackendConfiguration({
        ...validConfiguration,
        backends: [
          {
            ...validConfiguration.backends[0],
            moduleConfiguration: { payload: "x".repeat(17_000) },
          },
        ],
      }),
    ).toThrow(/byte limit/i);
  });

  it("requires an absolute path and reads strict JSON", async () => {
    await expect(
      loadBackendConfigurationFile("relative-config.json"),
    ).rejects.toThrow("must be an absolute path");

    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-config-"));
    roots.push(root);
    const filename = path.join(root, "sedes.json");
    await writeFile(filename, JSON.stringify(validConfiguration), "utf8");
    await expect(loadBackendConfigurationFile(filename)).resolves.toEqual({
      ...validConfiguration,
      packagedClients: [],
    });

    await writeFile(filename, "{", "utf8");
    await expect(loadBackendConfigurationFile(filename)).rejects.toThrow(
      "not valid JSON",
    );

    const missingFilename = path.join(root, "missing.json");
    await expect(loadBackendConfigurationFile(missingFilename)).rejects.toThrow(
      `Server configuration file not found at "${missingFilename}". Create it from a checked-in example or set SEDES_CONFIG_FILE to another absolute path.`,
    );
  });
});
