import path from "node:path";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { resolveCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import { CODEX_APP_SERVER_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const scope = Object.freeze({
  tenantId: "tenant-one",
  principalId: "principal-one",
});
const instance: AgentBackendInstance = Object.freeze({
  id: "codex-one",
  tenantId: scope.tenantId,
  kind: "codex_app_server",
  label: "Codex",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: CODEX_APP_SERVER_RELEASE,
});
const connection: AgentConnectionProfile = Object.freeze({
  id: "connection-one",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "template-one",
  kind: "codex_app_server",
  backendInstanceId: instance.id,
  executionEnvironmentId: "environment-one",
  label: "Codex account",
  enabled: true,
  configurationRevision: 1,
});

describe("Codex runtime configuration", () => {
  let temporaryDirectory: string;
  let canonicalTemporaryDirectory: string;
  let defaultHome: string;
  let canonicalDefaultCodexHome: string;
  let secureExecutablePath: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(homedir(), ".sedes-codex-runtime-config-"),
    );
    canonicalTemporaryDirectory = await realpath(temporaryDirectory);
    const canonicalDefaultHome = path.join(
      temporaryDirectory,
      "canonical-home",
    );
    await mkdir(path.join(canonicalDefaultHome, ".codex"), {
      recursive: true,
    });
    defaultHome = path.join(temporaryDirectory, "home");
    await symlink(canonicalDefaultHome, defaultHome, "dir");
    canonicalDefaultCodexHome = await realpath(
      path.join(defaultHome, ".codex"),
    );
    secureExecutablePath = path.join(temporaryDirectory, "codex");
    const release = JSON.parse(
      await readFile(
        new URL(
          "../../protocol/codex-app-server/0.153.0/release.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      generation: {
        supportedPlatforms: Array<{
          nodePlatform: string;
          nodeArch: string;
          nativePackage: string;
          executableRelativePath: string;
        }>;
      };
    };
    const platform = release.generation.supportedPlatforms.find(
      (candidate) =>
        candidate.nodePlatform === process.platform &&
        candidate.nodeArch === process.arch,
    );
    if (platform === undefined) throw new Error("test_platform_unsupported");
    await link(
      path.resolve(
        "node_modules",
        platform.nativePackage,
        ...platform.executableRelativePath.split("/"),
      ),
      secureExecutablePath,
    );
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("uses HOME/.codex by default without setting a Codex home override", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
    });
    const resolved = await resolveCodexRuntimeConfiguration({
      scope,
      instance,
      startupEnvironmentVariables: { CUSTOM_START: { kind: "literal", value: "startup" }, LANG: { kind: "unset" } },
      connections: [connection],
      connection: {
        ownership: "owned",
        channel: {
          type: "process_stdio",
          executablePath: secureExecutablePath,
          workingDirectory: temporaryDirectory,
        },
      },
      environmentChannel,
      environment: {
        HOME: defaultHome,
        CODEX_HOME: "/parent/codex",
        CODEX_SQLITE_HOME: "/parent/sqlite",
        OPENAI_API_KEY: "must-not-be-forwarded",
        CODEX_ACCESS_TOKEN: "must-not-be-forwarded",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.test",
      },
    });

    expect(resolved.codexHome).toBe(path.join(defaultHome, ".codex"));
    expect(resolved.nativeStoreHome).toBe(canonicalDefaultCodexHome);
    expect(resolved.executionEnvironmentId).toBe(
      connection.executionEnvironmentId,
    );
    expect(resolved.connection.ownership).toBe("owned");
    if (resolved.connection.ownership !== "owned") {
      throw new Error("test_expected_owned_connection");
    }
    expect(resolved.connection.channel.workingDirectory).toBe(
      canonicalTemporaryDirectory,
    );
    expect(resolved.childEnvironment).toMatchObject({ CUSTOM_START: "startup" });
    expect(resolved.childEnvironment).not.toHaveProperty("LANG");
    expect(resolved.childEnvironment).toEqual({
      CUSTOM_START: "startup",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.test",
      HOME: defaultHome,
      NO_COLOR: "1",
      TERM: "dumb",
    });
    expect(resolved.connection.channel.executable.version).toBe(
      CODEX_APP_SERVER_RELEASE,
    );
    expect(resolved.connection.channel.executable.path).toBe(
      await realpath(secureExecutablePath),
    );
  });

  it("resolves an omitted owned executable from the target environment PATH", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
      environment: { PATH: temporaryDirectory },
    });
    const resolved = await resolveCodexRuntimeConfiguration({
      scope,
      instance,
      connections: [connection],
      connection: {
        ownership: "owned",
        channel: {
          type: "process_stdio",
          workingDirectory: temporaryDirectory,
        },
      },
      environmentChannel,
      environment: {
        HOME: defaultHome,
        PATH: temporaryDirectory,
      },
    });

    if (resolved.connection.ownership !== "owned") {
      throw new Error("test_expected_owned_connection");
    }
    expect(resolved.connection.channel.executable.path).toBe(
      await realpath(secureExecutablePath),
    );
    expect(resolved.connection.channel.process.executable.canonicalPath).toBe(
      await realpath(secureExecutablePath),
    );
  });

  it("sets only CODEX_HOME when owned stdio explicitly overrides it", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
    });
    const resolved = await resolveCodexRuntimeConfiguration({
      scope,
      instance,
      connections: [connection],
      connection: {
        ownership: "owned",
        channel: {
          type: "process_stdio",
          executablePath: secureExecutablePath,
          workingDirectory: temporaryDirectory,
          codexHome: temporaryDirectory,
        },
      },
      environmentChannel,
      environment: {
        HOME: defaultHome,
        CODEX_HOME: "/parent/codex",
        CODEX_SQLITE_HOME: "/parent/sqlite",
        PATH: "/usr/bin",
      },
    });

    expect(resolved.codexHome).toBe(canonicalTemporaryDirectory);
    expect(resolved.nativeStoreHome).toBe(canonicalTemporaryDirectory);
    expect(resolved.childEnvironment).toEqual({
      PATH: "/usr/bin",
      HOME: defaultHome,
      CODEX_HOME: canonicalTemporaryDirectory,
      NO_COLOR: "1",
      TERM: "dumb",
    });
  });

  it("rejects a connection outside the exact principal-owned runtime scope", async () => {
    await expect(
      resolveCodexRuntimeConfiguration({
        scope,
        instance,
        connections: [{ ...connection, ownerPrincipalId: "another-principal" }],
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: "/does/not/matter",
            workingDirectory: temporaryDirectory,
          },
        },
        environmentChannel: new LocalEnvironmentChannelProvider({
          scope,
          executionEnvironmentId: connection.executionEnvironmentId,
        }),
        environment: {},
      }),
    ).rejects.toThrow("codex_runtime_scope_invalid");
  });

  it("rejects mixed execution environments before process preparation", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
    });
    const prepare = vi.spyOn(environmentChannel, "prepareOwnedProcess");
    await expect(
      resolveCodexRuntimeConfiguration({
        scope,
        instance,
        connections: [
          connection,
          {
            ...connection,
            id: "connection-two",
            executionEnvironmentId: "environment-two",
          },
        ],
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: secureExecutablePath,
            workingDirectory: temporaryDirectory,
          },
        },
        environmentChannel,
        environment: {},
      }),
    ).rejects.toThrow("codex_runtime_scope_invalid");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("defers private Unix socket proof to each connection generation", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
    });
    const openPrivateUnixStream = vi.spyOn(
      environmentChannel,
      "openPrivateUnixStream",
    );
    const resolveDirectory = vi.spyOn(environmentChannel, "resolveDirectory");
    const prepareOwnedProcess = vi.spyOn(
      environmentChannel,
      "prepareOwnedProcess",
    );
    const socketPath = path.join(temporaryDirectory, "app-server.sock");
    const resolved = await resolveCodexRuntimeConfiguration({
      scope,
      instance,
      connections: [connection],
      connection: {
        ownership: "external",
        channel: { type: "unix_websocket", socketPath },
      },
      environmentChannel,
      environment: new Proxy(
        {},
        {
          get() {
            throw new Error("external_environment_must_not_be_read");
          },
        },
      ),
    });

    expect(resolved.connection).toEqual({
      ownership: "external",
      channel: { type: "unix_websocket", socketPath },
    });
    expect(resolved).not.toHaveProperty("codexHome");
    expect(resolved).not.toHaveProperty("nativeStoreHome");
    expect(resolved).not.toHaveProperty("childEnvironment");
    expect(resolveDirectory).not.toHaveBeenCalled();
    expect(prepareOwnedProcess).not.toHaveBeenCalled();
    expect(openPrivateUnixStream).not.toHaveBeenCalled();
  });

  it("defers TCP secret resolution and route assurance to each connection generation", async () => {
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: connection.executionEnvironmentId,
      environment: {
        SEDES_CODEX_RUNTIME_TOKEN: "must-not-resolve-during-composition",
      },
    });
    const resolveSecret = vi.spyOn(environmentChannel, "resolveSecret");
    const openAssuredTcpStream = vi.spyOn(
      environmentChannel,
      "openAssuredTcpStream",
    );
    const resolveDirectory = vi.spyOn(environmentChannel, "resolveDirectory");
    const prepareOwnedProcess = vi.spyOn(
      environmentChannel,
      "prepareOwnedProcess",
    );
    const resolved = await resolveCodexRuntimeConfiguration({
      scope,
      instance,
      connections: [connection],
      connection: {
        ownership: "external",
        channel: {
          type: "tcp_websocket",
          url: "ws://127.0.0.1:4500",
          authentication: {
            type: "capability_token",
            secret: {
              source: "environment",
              variable: "SEDES_CODEX_RUNTIME_TOKEN",
            },
          },
        },
      },
      environmentChannel,
      environment: new Proxy(
        {},
        {
          get() {
            throw new Error("external_environment_must_not_be_read");
          },
        },
      ),
    });

    expect(resolved.connection).toEqual({
      ownership: "external",
      channel: {
        type: "tcp_websocket",
        url: "ws://127.0.0.1:4500",
        authentication: {
          type: "capability_token",
          secret: {
            source: "environment",
            variable: "SEDES_CODEX_RUNTIME_TOKEN",
          },
        },
      },
    });
    expect(resolved).not.toHaveProperty("codexHome");
    expect(resolved).not.toHaveProperty("nativeStoreHome");
    expect(resolved).not.toHaveProperty("childEnvironment");
    expect(resolveDirectory).not.toHaveBeenCalled();
    expect(prepareOwnedProcess).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(openAssuredTcpStream).not.toHaveBeenCalled();
  });

  it("drains rejected version-probe output without an unhandled rejection", async () => {
    const noisyExecutable = path.join(temporaryDirectory, "noisy-codex");
    await writeFile(
      noisyExecutable,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(5000)); process.exitCode = 1;\n",
      { mode: 0o700 },
    );
    await chmod(noisyExecutable, 0o700);

    await expect(
      resolveCodexRuntimeConfiguration({
        scope,
        instance,
        connections: [connection],
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: noisyExecutable,
            workingDirectory: temporaryDirectory,
          },
        },
        environmentChannel: new LocalEnvironmentChannelProvider({
          scope,
          executionEnvironmentId: connection.executionEnvironmentId,
        }),
        environment: { PATH: process.env.PATH },
      }),
    ).rejects.toThrow("codex_executable_version_probe_nonzero_exit");
  });
});
