import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, symlinkSync, unlinkSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isValidEnvironmentAssuredTcpStreamIdentity,
  isValidEnvironmentPrivateUnixStreamIdentity,
  isValidEnvironmentSecretIdentity,
  isValidEnvironmentOwnedPtyIdentity,
  type EnvironmentAssuredTcpStreamChannel,
  type EnvironmentPrivateUnixStreamChannel,
  type EnvironmentPrivateUnixStreamIdentity,
  type EnvironmentOwnedPtyChannel,
  type PreparedEnvironmentOwnedProcess,
} from "../../src/server/execution/environment-channel.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const scope = Object.freeze({
  tenantId: "tenant-environment",
  principalId: "principal-environment",
  backendInstanceId: "codex-environment",
  executionEnvironmentId: "local-environment",
});
const execFileAsync = promisify(execFile);

describe("LocalEnvironmentChannelProvider", () => {
  const temporaryDirectories: string[] = [];
  const privateUnixChannels: EnvironmentPrivateUnixStreamChannel[] = [];
  const assuredTcpChannels: EnvironmentAssuredTcpStreamChannel[] = [];
  const ownedPtyChannels: EnvironmentOwnedPtyChannel[] = [];
  const privateUnixServers: Server[] = [];
  const privateUnixPeerSockets: Socket[] = [];
  const tcpServers: Server[] = [];
  const tcpPeerSockets: Socket[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const channel of privateUnixChannels.splice(0)) {
      channel.destroyClient("test_cleanup");
      await channel.closed;
    }
    for (const channel of assuredTcpChannels.splice(0)) {
      channel.destroyClient("test_cleanup");
      await channel.closed;
    }
    for (const channel of ownedPtyChannels.splice(0)) {
      await channel.close("test_cleanup").catch(() => undefined);
      await channel.closed;
    }
    for (const socket of privateUnixPeerSockets.splice(0)) socket.destroy();
    for (const socket of tcpPeerSockets.splice(0)) socket.destroy();
    await Promise.all(
      privateUnixServers.splice(0).map(async (server) => {
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }),
    );
    await Promise.all(
      tcpServers.splice(0).map(async (server) => {
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }),
    );
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("returns environment-scoped canonical identities without raw process handles", async () => {
    const directory = await mkdtemp(
      path.join(os.homedir(), ".sedes-environment-channel-"),
    );
    temporaryDirectories.push(directory);
    const provider = providerFor(scope);
    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: process.execPath,
      workingDirectory: directory,
    });
    const channel = await provider.openOwnedProcess(
      scope,
      {
        prepared,
        arguments: ["-e", "process.stdout.write('ready')"],
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        cleanup: cleanupPolicy,
      },
      new AbortController().signal,
    );

    expect(prepared).toMatchObject({
      kind: "owned_process",
      scope,
      executable: { canonicalPath: await realpath(process.execPath) },
      workingDirectory: { canonicalPath: await realpath(directory) },
    });
    expect(channel.identity.scope).toEqual(scope);
    expect(channel).not.toHaveProperty("child");
    expect(channel).not.toHaveProperty("process");
    expect(channel).not.toHaveProperty("socket");
    expect(channel.stdout).not.toHaveProperty("pipe");
    expect(channel.stdout).not.toHaveProperty("destroy");
    expect(channel.stderr).not.toHaveProperty("pipe");
    expect(channel.stderr).not.toHaveProperty("destroy");
    const chunks: Buffer[] = [];
    for await (const chunk of channel.stdout) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("ready");
    await channel.close("test_complete");
    await expect(channel.closed).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
    });
  });

  it("resolves operator executables from PATH unless an explicit path is configured", async () => {
    const root = await mkdtemp(
      path.join(os.homedir(), ".sedes-executable-resolution-"),
    );
    temporaryDirectories.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const commandName = "provider-command";
    await writeFile(path.join(first, commandName), "not executable\n", {
      mode: 0o600,
    });
    const executable = path.join(second, commandName);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    const provider = providerFor(scope, {
      PATH: [first, second].join(path.delimiter),
    });

    await expect(
      provider.resolveOwnedProcessExecutable(scope, { commandName }),
    ).resolves.toEqual({
      kind: "executable",
      canonicalPath: await realpath(executable),
    });

    await expect(
      provider.resolveOwnedProcessExecutable(scope, {
        commandName,
        configuredPath: path.join(root, "missing"),
      }),
    ).rejects.toThrow();
    await expect(
      provider.resolveOwnedProcessExecutable(scope, {
        commandName: "../provider-command",
      }),
    ).rejects.toThrow("environment_channel_executable_command_invalid");

    const relativeDirectory = path.join(root, "relative");
    await mkdir(relativeDirectory);
    const relativeExecutable = path.join(relativeDirectory, commandName);
    await writeFile(relativeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const absoluteOnlyProvider = providerFor(scope, {
      PATH: [
        path.relative(process.cwd(), relativeDirectory),
        "",
        second,
      ].join(path.delimiter),
    });
    await expect(
      absoluteOnlyProvider.resolveOwnedProcessExecutable(scope, {
        commandName,
      }),
    ).resolves.toEqual({
      kind: "executable",
      canonicalPath: await realpath(executable),
    });
  });

  it.skipIf(process.platform === "win32")(
    "opens a raw-byte PTY, accepts input, and applies terminal resizes",
    async () => {
    const provider = providerFor(scope);
    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: "/bin/sh",
      workingDirectory: path.dirname(process.execPath),
    });
    const channel = await provider.openOwnedPty(
      scope,
      {
        prepared,
        arguments: [
          "-c",
          "stty size; printf '\\377'; IFS= read -r value; stty size; printf 'got:%s\\n' \"$value\"",
        ],
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        initialSize: { columns: 80, rows: 24 },
        terminalType: "xterm-256color",
        cleanup: cleanupPolicy,
      },
      new AbortController().signal,
    );
    ownedPtyChannels.push(channel);

    expect(channel.identity).toMatchObject({
      kind: "owned_pty",
      scope,
      executable: { canonicalPath: await realpath("/bin/sh") },
    });
    expect(isValidEnvironmentOwnedPtyIdentity(channel.identity)).toBe(true);
    expect(isValidEnvironmentOwnedPtyIdentity({ ...channel.identity })).toBe(
      false,
    );
    expect(channel.identity).not.toHaveProperty("providerProcessIdentity");
    expect(channel).not.toHaveProperty("pty");
    expect(channel).not.toHaveProperty("process");
    expect(channel.bytes).not.toHaveProperty("pipe");

    const iterator = channel.bytes[Symbol.asyncIterator]();
    const initialChunks: Uint8Array[] = [];
    for (;;) {
      const initial = await iterator.next();
      expect(initial.done).toBe(false);
      initialChunks.push(initial.value ?? new Uint8Array());
      const received = Buffer.concat(
        initialChunks.map((chunk) => Buffer.from(chunk)),
      );
      if (
        received.includes(0xff) &&
        received.toString("latin1").includes("24 80")
      ) {
        expect(received.includes(0xff)).toBe(true);
        break;
      }
    }

    channel.resize({ columns: 100, rows: 40 });
    await channel.write(Buffer.from("hello\n"));
    await expect(channel.closed).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
    });
    const remaining: Uint8Array[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) break;
      remaining.push(result.value);
    }
    const output = Buffer.concat(remaining.map((chunk) => Buffer.from(chunk)));
    expect(output.toString("utf8")).toContain("40 100");
    expect(output.toString("utf8")).toContain("got:hello");
    },
  );

  it.runIf(process.platform === "win32")(
    "opens and closes a native Windows raw-byte PTY",
    async () => {
      const provider = providerFor(scope);
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const prepared = await provider.prepareOwnedProcess(scope, {
        executablePath: powershell,
        workingDirectory: path.dirname(process.execPath),
      });
      const channel = await provider.openOwnedPty(
        scope,
        {
          prepared,
          arguments: [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$line = [Console]::ReadLine(); [Console]::WriteLine('got:' + $line)",
          ],
          environment: {
            PATH: process.env.PATH ?? "",
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          },
          initialSize: { columns: 80, rows: 24 },
          terminalType: "xterm-256color",
          cleanup: cleanupPolicy,
        },
        new AbortController().signal,
      );
      ownedPtyChannels.push(channel);

      expect(channel.identity.executable.canonicalPath).toBe(
        await realpath(powershell),
      );
      channel.resize({ columns: 100, rows: 40 });
      await channel.write(Buffer.from("hello\r\n"));
      const chunks: Uint8Array[] = [];
      for await (const chunk of channel.bytes) chunks.push(chunk);
      await expect(channel.closed).resolves.toMatchObject({
        reason: "exit",
        exitCode: 0,
      });
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()).toContain(
        "got:hello",
      );
    },
  );

  it("rejects invalid PTY scope, geometry, terminal type, and aborted opens", async () => {
    const provider = providerFor(scope);
    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: process.execPath,
      workingDirectory: path.dirname(process.execPath),
    });
    const validInput = {
      prepared,
      arguments: [] as string[],
      environment: {},
      initialSize: { columns: 80, rows: 24 },
      terminalType: "xterm-256color",
      cleanup: cleanupPolicy,
    };

    await expect(
      provider.openOwnedPty(
        { ...scope, backendInstanceId: "wrong-backend" },
        validInput,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_owned_pty_preparation_invalid");
    await expect(
      provider.openOwnedPty(
        scope,
        { ...validInput, initialSize: { columns: 0, rows: 24 } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_owned_pty_size_invalid");
    await expect(
      provider.openOwnedPty(
        scope,
        { ...validInput, terminalType: "xterm\nunsafe" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_owned_pty_terminal_type_invalid");
    const aborted = new AbortController();
    aborted.abort(new Error("test_aborted"));
    await expect(
      provider.openOwnedPty(scope, validInput, aborted.signal),
    ).rejects.toThrow("test_aborted");
  });

  it.skipIf(process.platform === "win32")(
    "closes a PTY's complete process group within the cleanup bounds",
    async () => {
    const provider = providerFor(scope);
    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: "/bin/sh",
      workingDirectory: path.dirname(process.execPath),
    });
    const channel = await provider.openOwnedPty(
      scope,
      {
        prepared,
        arguments: [
          "-c",
          "trap '' HUP TERM; sleep 60 & child=$!; printf '%s\\n' \"$child\"; wait",
        ],
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        initialSize: { columns: 80, rows: 24 },
        terminalType: "xterm-256color",
        cleanup: {
          gracefulCloseMilliseconds: 50,
          terminateMilliseconds: 50,
          killMilliseconds: 1_000,
        },
      },
      new AbortController().signal,
    );
    ownedPtyChannels.push(channel);
    const first = await channel.bytes[Symbol.asyncIterator]().next();
    const childProcessId = Number.parseInt(
      Buffer.from(first.value ?? [])
        .toString("utf8")
        .trim(),
      10,
    );
    expect(childProcessId).toBeGreaterThan(0);

    await channel.close("test_complete");
    await channel.closed;
    expect(processExists(childProcessId)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans up active PTYs when the environment owner closes",
    async () => {
    const provider = providerFor(scope);
    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: "/bin/sh",
      workingDirectory: path.dirname(process.execPath),
    });
    const channel = await provider.openOwnedPty(
      scope,
      {
        prepared,
        arguments: ["-c", "printf 'ready\\n'; sleep 60"],
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        initialSize: { columns: 80, rows: 24 },
        terminalType: "xterm-256color",
        cleanup: cleanupPolicy,
      },
      new AbortController().signal,
    );
    ownedPtyChannels.push(channel);
    await channel.bytes[Symbol.asyncIterator]().next();

    provider.close();

    await expect(channel.closed).resolves.toMatchObject({ reason: "exit" });
    },
  );

  it("rejects wrong tenant, principal, backend, or environment scope before spawn", async () => {
    const provider = providerFor(scope);
    for (const mismatch of [
      { ...scope, tenantId: "wrong-tenant" },
      { ...scope, principalId: "wrong-principal" },
      { ...scope, executionEnvironmentId: "wrong-environment" },
    ]) {
      await expect(
        provider.prepareOwnedProcess(mismatch, {
          executablePath: process.execPath,
          workingDirectory: path.dirname(process.execPath),
        }),
      ).rejects.toThrow("execution_environment_channel_unavailable");
    }

    const prepared = await provider.prepareOwnedProcess(scope, {
      executablePath: process.execPath,
      workingDirectory: path.dirname(process.execPath),
    });
    await expect(
      provider.openOwnedProcess(
        { ...scope, backendInstanceId: "wrong-backend" },
        {
          prepared,
          arguments: [],
          environment: {},
          cleanup: cleanupPolicy,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_owned_process_preparation_invalid");
  });

  it("rejects structurally forged process preparations", async () => {
    const provider = providerFor(scope);
    const forged = Object.freeze({
      kind: "owned_process" as const,
      scope,
      executable: Object.freeze({
        kind: "executable" as const,
        canonicalPath: await realpath(process.execPath),
      }),
      workingDirectory: Object.freeze({
        kind: "directory" as const,
        canonicalPath: await realpath(path.dirname(process.execPath)),
      }),
    }) satisfies PreparedEnvironmentOwnedProcess;

    await expect(
      provider.openOwnedProcess(
        scope,
        {
          prepared: forged,
          arguments: [],
          environment: {},
          cleanup: cleanupPolicy,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_owned_process_preparation_invalid");
  });

  it("rejects noncanonical paths and becomes unavailable after ownership cleanup", async () => {
    const provider = providerFor(scope);
    await expect(
      provider.resolveDirectory(scope, `${path.dirname(process.execPath)}/..`),
    ).rejects.toThrow("environment_channel_path_invalid");
    provider.close();
    provider.close();
    await expect(
      provider.resolveDirectory(scope, path.dirname(process.execPath)),
    ).rejects.toThrow("execution_environment_channel_unavailable");
  });

  it("prepares current process-visible endpoints", async () => {
    const fixture = await privateUnixFixture();
    const provider = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
    });
    await expect(
      provider.prepareManagedProcessEndpoint(
        scope,
        {
          kind: "private_unix_websocket",
          socketPath: fixture.socketPath,
        },
        4,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "managed_process_endpoint",
      processAddress: `unix://${fixture.socketPath}`,
      endpointIdentity: expect.stringMatching(/^unix:/u),
    });
    provider.close();
  });

  it("opens an assured scope-bound private Unix stream without exposing a raw socket", async () => {
    const fixture = await privateUnixFixture();
    const provider = providerFor(scope);
    const channel = await provider.openPrivateUnixStream(
      scope,
      fixture.socketPath,
      new AbortController().signal,
    );
    privateUnixChannels.push(channel);

    expect(channel.identity).toMatchObject({
      kind: "private_unix_stream",
      scope,
      filesystemIdentity: {
        ownerVerified: true,
        parentMode: "0700",
        socketMode: "0600",
      },
    });
    expect(channel.identity.socketIdentity).not.toContain(fixture.socketPath);
    expect(isValidEnvironmentPrivateUnixStreamIdentity(channel.identity)).toBe(
      true,
    );
    expect(channel).not.toHaveProperty("socket");
    expect(channel).not.toHaveProperty("path");
    expect(channel.bytes).not.toHaveProperty("pipe");
    expect(channel.bytes).not.toHaveProperty("destroy");
    await expect(channel.revalidateIdentity()).resolves.toBeUndefined();
    const preAbortedWrite = new AbortController();
    preAbortedWrite.abort(new Error("write-aborted-before-send"));
    await expect(
      channel.write(Buffer.from("must-not-send"), {
        signal: preAbortedWrite.signal,
      }),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    const iterator = channel.bytes[Symbol.asyncIterator]();
    await channel.write(Buffer.from("private-uds-message"));
    const received = await iterator.next();
    expect(received.done).toBe(false);
    expect(Buffer.from(received.value!).toString("utf8")).toBe(
      "private-uds-message",
    );

    await channel.closeClient("test_complete");
    await expect(channel.closed).resolves.toEqual({ reason: "client_closed" });
    expect(isValidEnvironmentPrivateUnixStreamIdentity(channel.identity)).toBe(
      false,
    );

    const replacementClient = await provider.openPrivateUnixStream(
      scope,
      fixture.socketPath,
      new AbortController().signal,
    );
    privateUnixChannels.push(replacementClient);
    expect(replacementClient.identity.channelId).not.toBe(
      channel.identity.channelId,
    );
    expect(replacementClient.identity.socketIdentity).toBe(
      channel.identity.socketIdentity,
    );
    provider.close();
    provider.close();
    await expect(replacementClient.closed).resolves.toEqual({
      reason: "client_closed",
    });
    expect(
      isValidEnvironmentPrivateUnixStreamIdentity(replacementClient.identity),
    ).toBe(false);
  });

  it("rejects structurally forged or wrong-scope Unix stream identities", async () => {
    const fixture = await privateUnixFixture();
    const channel = await providerFor(scope).openPrivateUnixStream(
      scope,
      fixture.socketPath,
      new AbortController().signal,
    );
    privateUnixChannels.push(channel);
    const forged = Object.freeze({
      ...channel.identity,
      scope: Object.freeze({ ...scope, principalId: "forged-principal" }),
    }) as EnvironmentPrivateUnixStreamIdentity;

    expect(isValidEnvironmentPrivateUnixStreamIdentity(forged)).toBe(false);
    expect(channel.identity.scope).toEqual(scope);

    const provider = providerFor(scope);
    for (const mismatch of [
      { ...scope, tenantId: "wrong-tenant" },
      { ...scope, principalId: "wrong-principal" },
      { ...scope, executionEnvironmentId: "wrong-environment" },
    ]) {
      await expect(
        provider.openPrivateUnixStream(
          mismatch,
          fixture.socketPath,
          new AbortController().signal,
        ),
      ).rejects.toThrow("execution_environment_channel_unavailable");
    }
  });

  it.each([
    ["missing", undefined, "environment_secret_unavailable"],
    ["empty", "", "environment_secret_malformed"],
    ["whitespace", " ", "environment_secret_malformed"],
    ["short", "too-short", "environment_secret_malformed"],
    [
      "embedded whitespace",
      "valid-token-value with-space",
      "environment_secret_malformed",
    ],
    ["control", "valid-token-value\nsecond", "environment_secret_malformed"],
    ["non-ASCII", "valid-token-value-é", "environment_secret_malformed"],
    ["overlong", "a".repeat(4_097), "environment_secret_malformed"],
  ] as const)(
    "fails closed with a redacted code for a %s environment secret",
    async (_label, value, code) => {
      const variable = "SEDES_CODEX_PRIMARY_TOKEN";
      const provider = providerFor(scope, { [variable]: value });
      let failure: unknown;
      try {
        await provider.resolveSecret(
          scope,
          { source: "environment", variable },
          1,
          new AbortController().signal,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(code);
      expect(JSON.stringify(failure)).not.toContain(variable);
      if (value) {
        expect((failure as Error).message).not.toContain(value);
      }
    },
  );

  it("accepts only the approved environment-secret namespace and revokes discarded generations", async () => {
    const token = "valid-capability-token-12345";
    const provider = providerFor(scope, {
      SEDES_CODEX_PRIMARY_TOKEN: token,
      OPENAI_API_KEY: token,
    });
    await expect(
      provider.resolveSecret(
        scope,
        { source: "environment", variable: "OPENAI_API_KEY" },
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_secret_reference_invalid");

    const first = await provider.resolveSecret(
      scope,
      { source: "environment", variable: "SEDES_CODEX_PRIMARY_TOKEN" },
      1,
      new AbortController().signal,
    );
    const second = await provider.resolveSecret(
      scope,
      { source: "environment", variable: "SEDES_CODEX_PRIMARY_TOKEN" },
      2,
      new AbortController().signal,
    );
    expect(first.value).toBe(token);
    expect(first.identity.scope).toEqual(scope);
    expect(first.identity.connectionGeneration).toBe(1);
    expect(first.identity.secretIdentity).not.toContain(token);
    expect(second.identity.secretIdentity).not.toBe(
      first.identity.secretIdentity,
    );
    expect(isValidEnvironmentSecretIdentity(first.identity)).toBe(true);
    first.discard();
    first.discard();
    expect(isValidEnvironmentSecretIdentity(first.identity)).toBe(false);
    expect(isValidEnvironmentSecretIdentity(second.identity)).toBe(true);
    provider.close();
    expect(isValidEnvironmentSecretIdentity(second.identity)).toBe(false);
  });

  it("does not return an environment secret when close wins its resolution checkpoint", async () => {
    const token = "closing-environment-capability-token-12345";
    const provider = providerFor(scope, {
      SEDES_CODEX_CLOSING_TOKEN: token,
    });
    let returned:
      Awaited<ReturnType<typeof provider.resolveSecret>> | undefined;
    const resolution = provider
      .resolveSecret(
        scope,
        {
          source: "environment",
          variable: "SEDES_CODEX_CLOSING_TOKEN",
        },
        1,
        new AbortController().signal,
      )
      .then((value) => {
        returned = value;
        return value;
      });
    provider.close();

    await expect(resolution).rejects.toThrow(
      "execution_environment_channel_unavailable",
    );
    expect(returned).toBeUndefined();
    await expect(
      provider.resolveSecret(
        scope,
        {
          source: "environment",
          variable: "SEDES_CODEX_CLOSING_TOKEN",
        },
        2,
        new AbortController().signal,
      ),
    ).rejects.toThrow("execution_environment_channel_unavailable");
  });

  it.each([0o400, 0o600])(
    "resolves a protected regular secret file with mode %s and revokes it",
    async (mode) => {
      const directory = await privateDirectory();
      const secretPath = path.join(directory, `token-${mode.toString(8)}`);
      const token = "protected-capability-token-12345";
      await writeFile(secretPath, `${token}\n`, { mode });
      await chmod(secretPath, mode);
      const provider = providerFor(scope);
      const resolved = await provider.resolveSecret(
        scope,
        { source: "protected_file", path: secretPath },
        7,
        new AbortController().signal,
      );

      expect(resolved.value).toBe(token);
      expect(resolved.identity).toMatchObject({
        kind: "environment_secret",
        scope,
        connectionGeneration: 7,
      });
      expect(resolved.identity.secretIdentity).not.toContain(secretPath);
      expect(resolved.identity.secretIdentity).not.toContain(token);
      expect(isValidEnvironmentSecretIdentity(resolved.identity)).toBe(true);
      resolved.discard();
      expect(isValidEnvironmentSecretIdentity(resolved.identity)).toBe(false);
    },
  );

  it("rejects unsafe protected-file identity and content with fixed redacted codes", async () => {
    const directory = await privateDirectory();
    const provider = providerFor(scope);
    const token = "protected-capability-token-12345";
    const validPath = path.join(directory, "valid-token");
    await writeFile(validPath, token, { mode: 0o600 });

    const symlinkPath = path.join(directory, "symlink-token");
    await symlink(validPath, symlinkPath);
    await expectSecretFailure(
      provider,
      symlinkPath,
      "environment_secret_file_path_unsafe",
      token,
    );

    const permissivePath = path.join(directory, "permissive-token");
    await writeFile(permissivePath, token, { mode: 0o640 });
    await chmod(permissivePath, 0o640);
    await expectSecretFailure(
      provider,
      permissivePath,
      "environment_secret_file_identity_invalid",
      token,
    );

    const hardlinkedPath = path.join(directory, "hardlinked-token");
    const hardlinkAlias = path.join(directory, "hardlinked-token-alias");
    await writeFile(hardlinkedPath, token, { mode: 0o600 });
    await link(hardlinkedPath, hardlinkAlias);
    await expectSecretFailure(
      provider,
      hardlinkedPath,
      "environment_secret_file_identity_invalid",
      token,
    );

    const unreadablePath = path.join(directory, "unreadable-token");
    await writeFile(unreadablePath, token, { mode: 0o600 });
    await chmod(unreadablePath, 0o000);
    await expectSecretFailure(
      provider,
      unreadablePath,
      "environment_secret_file_unavailable",
      token,
    );

    const invalidUtf8Path = path.join(directory, "invalid-utf8-token");
    await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]), {
      mode: 0o600,
    });
    await expectSecretFailure(
      provider,
      invalidUtf8Path,
      "environment_secret_malformed",
      token,
    );

    const getEffectiveUserId = process.geteuid;
    if (!getEffectiveUserId) throw new Error("test_requires_effective_user_id");
    const wrongOwnerPath = path.join(directory, "wrong-owner-token");
    await writeFile(wrongOwnerPath, token, { mode: 0o600 });
    vi.spyOn(process, "geteuid").mockReturnValue(getEffectiveUserId() + 1);
    await expectSecretFailure(
      provider,
      wrongOwnerPath,
      "environment_secret_file_identity_invalid",
      token,
    );
  });

  it("rejects a FIFO secret within a bounded wait", async () => {
    const directory = await privateDirectory();
    const fifoPath = path.join(directory, "fifo-token");
    const token = "protected-capability-token-12345";
    await execFileAsync("mkfifo", [fifoPath]);
    await chmod(fifoPath, 0o600);
    const provider = providerFor(scope);
    const resolution = provider.resolveSecret(
      scope,
      { source: "protected_file", path: fifoPath },
      1,
      new AbortController().signal,
    );
    const outcome = await Promise.race([
      resolution.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "deadline" }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "deadline" }), 250);
        timer.unref();
      }),
    ]);
    if (outcome.kind === "deadline") {
      // Release a regressed blocking O_RDONLY FIFO open so the worker and test
      // process can still shut down cleanly after reporting the failure.
      const writer = await open(
        fifoPath,
        fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
      );
      await writer.close();
      await resolution.catch(() => undefined);
    }
    expect(outcome).toMatchObject({
      kind: "rejected",
      error: expect.objectContaining({
        message: "environment_secret_file_identity_invalid",
      }),
    });
    expect(JSON.stringify(outcome)).not.toContain(fifoPath);
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it("rejects a protected secret beneath a symlinked or group-accessible parent", async () => {
    const directory = await privateDirectory();
    const secretPath = path.join(directory, "parent-protected-token");
    const token = "protected-capability-token-12345";
    await writeFile(secretPath, token, { mode: 0o600 });
    const provider = providerFor(scope);

    await chmod(directory, 0o750);
    await expectSecretFailure(
      provider,
      secretPath,
      "environment_secret_file_identity_invalid",
      token,
    );

    await chmod(directory, 0o700);
    const alias = `${directory}-alias`;
    await symlink(directory, alias, "dir");
    temporaryDirectories.push(alias);
    await expectSecretFailure(
      provider,
      path.join(alias, path.basename(secretPath)),
      "environment_secret_file_path_unsafe",
      token,
    );
  });

  it("re-resolves a replaced protected file and fences its prior secret generation", async () => {
    const directory = await privateDirectory();
    const secretPath = path.join(directory, "rotated-token");
    const firstToken = "first-capability-token-12345";
    const secondToken = "second-capability-token-67890";
    await writeFile(secretPath, firstToken, { mode: 0o600 });
    const provider = providerFor(scope);
    const first = await provider.resolveSecret(
      scope,
      { source: "protected_file", path: secretPath },
      1,
      new AbortController().signal,
    );

    unlinkSync(secretPath);
    await writeFile(secretPath, secondToken, { mode: 0o600 });
    const second = await provider.resolveSecret(
      scope,
      { source: "protected_file", path: secretPath },
      2,
      new AbortController().signal,
    );

    expect(first.value).toBe(firstToken);
    expect(second.value).toBe(secondToken);
    expect(second.identity.secretIdentity).not.toBe(
      first.identity.secretIdentity,
    );
    await expect(
      provider.openAssuredTcpStream(
        scope,
        { security: "loopback_plaintext", host: "127.0.0.1", port: 9 },
        2,
        first.identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_assured_tcp_stream_authentication_invalid");
    first.discard();
    second.discard();
  });

  it("rejects a protected file replaced after its bytes are read", async () => {
    const directory = await privateDirectory();
    const secretPath = path.join(directory, "raced-token");
    const replacementPath = path.join(directory, "replacement-token");
    const firstToken = "first-capability-token-12345";
    const secondToken = "second-capability-token-67890";
    await writeFile(secretPath, firstToken, { mode: 0o600 });
    await writeFile(replacementPath, secondToken, { mode: 0o600 });
    await runAfterNextFileHandleRead(secretPath, async () => {
      await rename(replacementPath, secretPath);
    });

    await expectSecretFailure(
      providerFor(scope),
      secretPath,
      "environment_secret_file_identity_replaced",
      firstToken,
    );
  });

  it("rejects a protected file whose parent is replaced after its bytes are read", async () => {
    const directory = await privateDirectory();
    const originalDirectory = `${directory}-original`;
    const replacementDirectory = `${directory}-replacement`;
    temporaryDirectories.push(originalDirectory, replacementDirectory);
    const secretPath = path.join(directory, "raced-parent-token");
    const token = "parent-race-capability-token-12345";
    await writeFile(secretPath, token, { mode: 0o600 });
    await mkdir(replacementDirectory, { mode: 0o700 });
    await writeFile(
      path.join(replacementDirectory, path.basename(secretPath)),
      token,
      {
        mode: 0o600,
      },
    );
    await runAfterNextFileHandleRead(secretPath, async () => {
      await rename(directory, originalDirectory);
      await rename(replacementDirectory, directory);
    });

    await expectSecretFailure(
      providerFor(scope),
      secretPath,
      "environment_secret_file_identity_replaced",
      token,
    );
  });

  it("does not return protected-file material when close occurs during its read", async () => {
    const directory = await privateDirectory();
    const secretPath = path.join(directory, "closing-file-token");
    const token = "closing-file-capability-token-12345";
    await writeFile(secretPath, token, { mode: 0o600 });
    const provider = providerFor(scope);
    await runAfterNextFileHandleRead(secretPath, async () => provider.close());
    let returned:
      Awaited<ReturnType<typeof provider.resolveSecret>> | undefined;
    let failure: unknown;
    try {
      returned = await provider.resolveSecret(
        scope,
        { source: "protected_file", path: secretPath },
        1,
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    }

    expect(returned).toBeUndefined();
    expect(failure).toEqual(
      expect.objectContaining({
        message: "execution_environment_channel_unavailable",
      }),
    );
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(
      token,
    );
  });

  it("opens a generation- and authentication-bound loopback TCP stream without exposing handles", async () => {
    const fixture = await tcpFixture();
    const token = "loopback-capability-token-12345";
    const provider = providerFor(scope, {
      SEDES_CODEX_LOOPBACK_TOKEN: token,
    });
    const secret = await provider.resolveSecret(
      scope,
      {
        source: "environment",
        variable: "SEDES_CODEX_LOOPBACK_TOKEN",
      },
      4,
      new AbortController().signal,
    );
    const channel = await provider.openAssuredTcpStream(
      scope,
      {
        security: "loopback_plaintext",
        host: "127.0.0.1",
        port: fixture.port,
      },
      4,
      secret.identity,
      new AbortController().signal,
    );
    assuredTcpChannels.push(channel);

    expect(channel.identity).toMatchObject({
      kind: "assured_tcp_stream",
      scope,
      connectionGeneration: 4,
      authenticationIdentity: secret.identity,
      transportSecurity: {
        type: "loopback_plaintext",
        loopbackVerified: true,
      },
    });
    expect(channel.identity.routeIdentity).not.toContain("127.0.0.1");
    expect(channel.identity.routeIdentity).not.toContain(String(fixture.port));
    expect(isValidEnvironmentAssuredTcpStreamIdentity(channel.identity)).toBe(
      true,
    );
    expect(channel).not.toHaveProperty("socket");
    expect(channel).not.toHaveProperty("host");
    expect(channel).not.toHaveProperty("port");
    expect(channel).not.toHaveProperty("token");
    expect(channel.bytes).not.toHaveProperty("pipe");

    const iterator = channel.bytes[Symbol.asyncIterator]();
    await channel.write(Buffer.from("tcp-message"));
    const received = await iterator.next();
    expect(received.done).toBe(false);
    expect(Buffer.from(received.value!).toString("utf8")).toBe("tcp-message");

    await channel.closeClient("test_complete");
    await expect(channel.closed).resolves.toEqual({ reason: "client_closed" });
    expect(fixture.server.listening).toBe(true);
    expect(isValidEnvironmentAssuredTcpStreamIdentity(channel.identity)).toBe(
      false,
    );
    expect(isValidEnvironmentSecretIdentity(secret.identity)).toBe(false);

    const replacementSecret = await provider.resolveSecret(
      scope,
      {
        source: "environment",
        variable: "SEDES_CODEX_LOOPBACK_TOKEN",
      },
      5,
      new AbortController().signal,
    );
    const replacementChannel = await provider.openAssuredTcpStream(
      scope,
      {
        security: "loopback_plaintext",
        host: "127.0.0.1",
        port: fixture.port,
      },
      5,
      replacementSecret.identity,
      new AbortController().signal,
    );
    assuredTcpChannels.push(replacementChannel);
    expect(replacementChannel.identity.channelId).not.toBe(
      channel.identity.channelId,
    );
    expect(fixture.server.listening).toBe(true);
    await replacementChannel.closeClient("replacement_complete");
  });

  it("does not return an assured TCP channel when close wins an in-flight connect", async () => {
    const fixture = await tcpFixture();
    const provider = providerFor(scope, {
      SEDES_CODEX_CLOSING_TCP_TOKEN: "closing-tcp-capability-token-12345",
    });
    const secret = await provider.resolveSecret(
      scope,
      {
        source: "environment",
        variable: "SEDES_CODEX_CLOSING_TCP_TOKEN",
      },
      1,
      new AbortController().signal,
    );
    let returned: EnvironmentAssuredTcpStreamChannel | undefined;
    const opening = provider
      .openAssuredTcpStream(
        scope,
        {
          security: "loopback_plaintext",
          host: "127.0.0.1",
          port: fixture.port,
        },
        1,
        secret.identity,
        new AbortController().signal,
      )
      .then((channel) => {
        returned = channel;
        return channel;
      });
    provider.close();

    await expect(opening).rejects.toThrow(
      "execution_environment_channel_unavailable",
    );
    expect(returned).toBeUndefined();
    expect(isValidEnvironmentSecretIdentity(secret.identity)).toBe(false);
  });

  it("rejects stale, wrong-scope, and unsafe TCP routes before opening a channel", async () => {
    const token = "loopback-capability-token-12345";
    const provider = providerFor(scope, {
      SEDES_CODEX_LOOPBACK_TOKEN: token,
    });
    const secret = await provider.resolveSecret(
      scope,
      {
        source: "environment",
        variable: "SEDES_CODEX_LOOPBACK_TOKEN",
      },
      1,
      new AbortController().signal,
    );
    const forgedIdentity = Object.freeze({
      ...secret.identity,
      secretIdentity: "structural-copy",
    });
    await expect(
      provider.openAssuredTcpStream(
        scope,
        { security: "loopback_plaintext", host: "127.0.0.1", port: 9 },
        1,
        forgedIdentity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_assured_tcp_stream_authentication_invalid");
    await expect(
      provider.openAssuredTcpStream(
        scope,
        { security: "loopback_plaintext", host: "127.0.0.1", port: 9 },
        2,
        secret.identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_assured_tcp_stream_authentication_invalid");
    await expect(
      provider.openAssuredTcpStream(
        { ...scope, principalId: "wrong-principal" },
        { security: "loopback_plaintext", host: "127.0.0.1", port: 9 },
        1,
        secret.identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("execution_environment_channel_unavailable");
    await expect(
      provider.openAssuredTcpStream(
        scope,
        {
          security: "loopback_plaintext",
          host: "192.0.2.1" as "127.0.0.1",
          port: 443,
        },
        1,
        secret.identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_assured_tcp_stream_route_invalid");
    await expect(
      provider.openAssuredTcpStream(
        scope,
        {
          security: "tls",
          host: "codex.example",
          port: 443,
          trustPolicy: "platform",
        },
        1,
        secret.identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "environment_assured_tcp_stream_remote_environment_required",
    );
    secret.discard();
  });

  it("rejects unsafe parent and socket permissions and the wrong owner", async () => {
    const fixture = await privateUnixFixture();
    const provider = providerFor(scope);

    await chmod(fixture.directory, 0o750);
    await expect(
      provider.openPrivateUnixStream(
        scope,
        fixture.socketPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_parent_mode_invalid");

    await chmod(fixture.directory, 0o700);
    await chmod(fixture.socketPath, 0o660);
    await expect(
      provider.openPrivateUnixStream(
        scope,
        fixture.socketPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_socket_mode_invalid");

    await chmod(fixture.socketPath, 0o600);
    const getEffectiveUserId = process.geteuid;
    if (!getEffectiveUserId) throw new Error("test_requires_effective_user_id");
    const effectiveUserId = getEffectiveUserId();
    vi.spyOn(process, "geteuid").mockReturnValue(effectiveUserId + 1);
    await expect(
      provider.openPrivateUnixStream(
        scope,
        fixture.socketPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_owner_invalid");
  });

  it.each([false, true])("accepts a private final socket alias (relative=%s)", async relative => {
    const fixture = await privateUnixFixture();
    const aliasParent = await privateDirectory();
    const alias = path.join(aliasParent, "configured.sock");
    await symlink(relative ? path.relative(aliasParent, fixture.socketPath) : fixture.socketPath, alias);
    const provider = providerFor(scope);
    await expect(provider.prepareManagedProcessEndpoint(scope,
      {kind: "private_unix_websocket", socketPath: alias}, 1, new AbortController().signal))
      .resolves.toMatchObject({processAddress: `unix://${fixture.socketPath}`});
    const channel = await provider.openPrivateUnixStream(scope, alias, new AbortController().signal);
    privateUnixChannels.push(channel);
    await expect(channel.revalidateIdentity()).resolves.toBeUndefined();
    expect(isValidEnvironmentPrivateUnixStreamIdentity(channel.identity)).toBe(true);
    expect(channel.identity.filesystemIdentity).toEqual({ownerVerified: true, parentMode: "0700", socketMode: "0600"});
    await channel.write(new Uint8Array([65]));
    const echoed = await channel.bytes[Symbol.asyncIterator]().next();
    expect(echoed.value).toEqual(new Uint8Array([65]));
  });

  it("requires private modes on both alias and target parents and the target socket", async () => {
    const fixture = await privateUnixFixture();
    const aliasParent = await privateDirectory();
    const alias = path.join(aliasParent, "configured.sock");
    await symlink(fixture.socketPath, alias);
    const provider = providerFor(scope);
    for (const directory of [aliasParent, fixture.directory]) {
      await chmod(directory, 0o750);
      await expect(provider.openPrivateUnixStream(scope, alias, new AbortController().signal))
        .rejects.toThrow("environment_private_unix_stream_parent_mode_invalid");
      await chmod(directory, 0o700);
    }
    await chmod(fixture.socketPath, 0o660);
    await expect(provider.openPrivateUnixStream(scope, alias, new AbortController().signal))
      .rejects.toThrow("environment_private_unix_stream_socket_mode_invalid");
  });

  it("rejects wrong types, alias chains, ancestor symlinks, and noncanonical paths", async () => {
    const provider = providerFor(scope);
    const wrongTypeDirectory = await privateDirectory();
    const wrongTypePath = path.join(wrongTypeDirectory, "not-a-socket");
    await writeFile(wrongTypePath, "not a socket", { mode: 0o600 });
    await expect(
      provider.openPrivateUnixStream(
        scope,
        wrongTypePath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_type_invalid");

    const finalSymlinkFixture = await privateUnixFixture("real.sock");
    const finalSymlinkPath = path.join(
      finalSymlinkFixture.directory,
      "alias.sock",
    );
    await symlink(finalSymlinkFixture.socketPath, finalSymlinkPath);
    const chainedAliasPath = path.join(finalSymlinkFixture.directory, "chained.sock");
    await symlink(finalSymlinkPath, chainedAliasPath);
    await expect(
      provider.openPrivateUnixStream(
        scope,
        chainedAliasPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_path_unsafe");

    const ancestorFixture = await privateUnixFixture();
    const ancestorAlias = `${ancestorFixture.directory}-alias`;
    await symlink(ancestorFixture.directory, ancestorAlias, "dir");
    temporaryDirectories.push(ancestorAlias);
    await expect(
      provider.openPrivateUnixStream(
        scope,
        path.join(ancestorAlias, path.basename(ancestorFixture.socketPath)),
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_path_unsafe");

    const noncanonicalPath = `${ancestorFixture.directory}/../${path.basename(ancestorFixture.directory)}/${path.basename(ancestorFixture.socketPath)}`;
    await expect(
      provider.openPrivateUnixStream(
        scope,
        noncanonicalPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_channel_path_invalid");
  });

  it("rejects a final alias retargeted during connection", async () => {
    const fixture = await privateUnixFixture();
    const replacement = await privateUnixFixture();
    const aliasParent = await privateDirectory();
    const alias = path.join(aliasParent, "configured.sock");
    await symlink(fixture.socketPath, alias);
    fixture.server.once("connection", () => {
      unlinkSync(alias);
      symlinkSync(replacement.socketPath, alias);
    });
    await expect(providerFor(scope).openPrivateUnixStream(scope, alias, new AbortController().signal))
      .rejects.toThrow("environment_private_unix_stream_identity_replaced");
  });

  it.each(["retarget", "same-target", "target-removed"] as const)("invalidates a connected socket alias after %s", async change => {
    const fixture = await privateUnixFixture();
    const replacement = await privateUnixFixture();
    const aliasParent = await privateDirectory();
    const alias = path.join(aliasParent, "configured.sock");
    await symlink(fixture.socketPath, alias);
    const channel = await providerFor(scope).openPrivateUnixStream(scope, alias, new AbortController().signal);
    privateUnixChannels.push(channel);
    if (change === "target-removed") unlinkSync(fixture.socketPath);
    else {
      unlinkSync(alias);
      symlinkSync(change === "retarget" ? replacement.socketPath : fixture.socketPath, alias);
    }
    await expect(channel.revalidateIdentity()).rejects.toThrow("environment_private_unix_stream_identity_replaced");
    await expect(channel.closed).resolves.toEqual({reason: "client_closed"});
    expect(isValidEnvironmentPrivateUnixStreamIdentity(channel.identity)).toBe(false);
  });

  it("rejects a socket path replaced between the pre-connect and post-connect checks", async () => {
    const fixture = await privateUnixFixture();
    fixture.server.once("connection", () => unlinkSync(fixture.socketPath));

    await expect(
      providerFor(scope).openPrivateUnixStream(
        scope,
        fixture.socketPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("environment_private_unix_stream_identity_replaced");
  });

  it("invalidates the client when post-Upgrade identity revalidation detects replacement", async () => {
    const fixture = await privateUnixFixture();
    const channel = await providerFor(scope).openPrivateUnixStream(
      scope,
      fixture.socketPath,
      new AbortController().signal,
    );
    privateUnixChannels.push(channel);
    unlinkSync(fixture.socketPath);

    await expect(channel.revalidateIdentity()).rejects.toThrow(
      "environment_private_unix_stream_identity_replaced",
    );
    await expect(channel.closed).resolves.toEqual({ reason: "client_closed" });
    expect(isValidEnvironmentPrivateUnixStreamIdentity(channel.identity)).toBe(
      false,
    );
  });

  it("aborts before connection without opening or leaking an endpoint", async () => {
    const fixture = await privateUnixFixture();
    const controller = new AbortController();
    controller.abort(new Error("expected-test-abort"));

    await expect(
      providerFor(scope).openPrivateUnixStream(
        scope,
        fixture.socketPath,
        controller.signal,
      ),
    ).rejects.toThrow("expected-test-abort");
  });

  async function privateDirectory(): Promise<string> {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-private-unix-"),
    );
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    return directory;
  }

  async function privateUnixFixture(socketName = "app-server.sock"): Promise<{
    readonly directory: string;
    readonly socketPath: string;
    readonly server: Server;
  }> {
    const directory = await privateDirectory();
    const socketPath = path.join(directory, socketName);
    const server = createServer((socket) => {
      privateUnixPeerSockets.push(socket);
      socket.once("close", () => {
        const index = privateUnixPeerSockets.indexOf(socket);
        if (index >= 0) privateUnixPeerSockets.splice(index, 1);
      });
      socket.on("data", (chunk) => socket.write(chunk));
    });
    privateUnixServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    return { directory, socketPath, server };
  }

  async function tcpFixture(): Promise<{
    readonly port: number;
    readonly server: Server;
  }> {
    const server = createServer((socket) => {
      tcpPeerSockets.push(socket);
      socket.once("close", () => {
        const index = tcpPeerSockets.indexOf(socket);
        if (index >= 0) tcpPeerSockets.splice(index, 1);
      });
      socket.on("data", (chunk) => socket.write(chunk));
    });
    tcpServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("tcp_fixture_address_invalid");
    }
    return { port: address.port, server };
  }

  async function expectSecretFailure(
    provider: LocalEnvironmentChannelProvider,
    secretPath: string,
    expectedCode: string,
    forbiddenSecret: string,
  ): Promise<void> {
    let failure: unknown;
    try {
      await provider.resolveSecret(
        scope,
        { source: "protected_file", path: secretPath },
        1,
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedCode);
    expect((failure as Error).message).not.toContain(secretPath);
    expect((failure as Error).message).not.toContain(forbiddenSecret);
  }

  async function runAfterNextFileHandleRead(
    filename: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const probe = await open(filename, fsConstants.O_RDONLY);
    const prototype = Object.getPrototypeOf(probe) as {
      readFile: typeof probe.readFile;
    };
    const originalReadFile = prototype.readFile;
    await probe.close();
    vi.spyOn(prototype, "readFile").mockImplementationOnce(async function (
      this: typeof probe,
    ) {
      const bytes = await originalReadFile.call(this);
      await action();
      return bytes;
    });
  }
});

const cleanupPolicy = Object.freeze({
  gracefulCloseMilliseconds: 100,
  terminateMilliseconds: 100,
  killMilliseconds: 500,
});

function providerFor(
  input: typeof scope,
  environment?: Readonly<Record<string, string | undefined>>,
): LocalEnvironmentChannelProvider {
  return new LocalEnvironmentChannelProvider({
    scope: input,
    executionEnvironmentId: input.executionEnvironmentId,
    ...(environment ? { environment } : {}),
  });
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
