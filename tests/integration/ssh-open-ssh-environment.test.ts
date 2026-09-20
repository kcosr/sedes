import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SshEnvironmentChannelProvider } from "../../src/server/execution/ssh-environment-channel.js";
import { RemoteExecutionEnvironment } from "../../src/server/execution/remote-execution-environment.js";

const ignoredAvailability = Object.freeze({
  reportBackendObservation: async () => undefined,
});

const SSH = "/usr/bin/ssh";
const SSHD = "/usr/sbin/sshd";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const execFile = promisify(execFileCallback);
const fixtures: OpenSshFixture[] = [];

const scope = Object.freeze({
  tenantId: "tenant-openssh",
  principalId: "principal-openssh",
});
const channelScope = Object.freeze({
  ...scope,
  backendInstanceId: "codex-openssh",
  executionEnvironmentId: "ssh-openssh",
});

const openSshAvailable = [SSH, SSHD, SSH_KEYGEN].every((executable) => {
  try {
    accessSync(executable, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
});

afterEach(async () => {
  await Promise.allSettled(
    fixtures.splice(0).map((fixture) => fixture.close()),
  );
});

describe.skipIf(!openSshAvailable)(
  "SSH execution environment over real OpenSSH",
  () => {
    it("validates a workspace and carries private UDS bytes without owning the remote service", async () => {
      const fixture = await OpenSshFixture.create();
      fixtures.push(fixture);

      const execution = new RemoteExecutionEnvironment({
        kind: "ssh",
        platform: "linux",
        environmentId: channelScope.executionEnvironmentId,
        scope,
        allowedRoots: [fixture.workspaceRoot],
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        directoryBrowser: () => undefined,
      });
      const workspace = await execution.validateWorkspace(
        scope,
        channelScope.executionEnvironmentId,
        fixture.workspace,
      );
      expect(workspace).toMatchObject({
        canonicalPath: fixture.workspace,
        summary: {
          environmentId: channelScope.executionEnvironmentId,
          displayName: "project",
          trustState: "untrusted",
        },
      });
      expect(await fixture.sshInvocationCount()).toBe(0);
      await expect(
        execution.validateWorkspace(
          scope,
          channelScope.executionEnvironmentId,
          fixture.directory,
        ),
      ).rejects.toThrow("workspace_not_allowed");
      expect(await fixture.sshInvocationCount()).toBe(0);

      const channels = new SshEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: channelScope.executionEnvironmentId,
        host: fixture.hostAlias,
        configurationRevision: 4,
        activeConfigurationRevision: () => 4,
        availability: ignoredAvailability,
        sshExecutable: fixture.sshWrapper,
      });
      fixture.manage(channels);
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = fixture.carrierRoot;
      let channel;
      try {
        channel = await channels.openPrivateUnixStream(
          channelScope,
          fixture.remoteSocket,
          new AbortController().signal,
        );
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
      }

      const carrierDirectories = await readdir(fixture.carrierRoot);
      expect(carrierDirectories).toHaveLength(1);
      expect(carrierDirectories[0]).toMatch(/^h-ssh-/);

      await channel.write(Buffer.from("real-openssh-streamlocal"));
      const iterator = channel.bytes[Symbol.asyncIterator]();
      const received = await withTimeout(iterator.next(), 5_000);
      expect(received.done).toBe(false);
      expect(Buffer.from(received.value ?? new Uint8Array()).toString()).toBe(
        "real-openssh-streamlocal",
      );
      await channel.revalidateIdentity();
      expect(await fixture.sshInvocationCount()).toBe(1);

      await channel.closeClient("integration_complete");
      await channel.closed;
      await channels.close();
      expect(await readdir(fixture.carrierRoot)).toEqual([]);

      // Closing Sedes's foreground carrier must not signal, unlink, or stop
      // the already-running service on the remote execution environment.
      expect((await lstat(fixture.remoteSocket)).isSocket()).toBe(true);
      expect(await fixture.echoDirectly("remote-service-survived")).toBe(
        "remote-service-survived",
      );

      await fixture.installWrongKnownHost();
      const rejected = new SshEnvironmentChannelProvider({
        executionEnvironmentId: channelScope.executionEnvironmentId,
        scope,
        host: fixture.hostAlias,
        sshExecutable: fixture.sshWrapper,
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        availability: ignoredAvailability,
      });
      fixture.manage(rejected);
      await expect(
        rejected.openPrivateUnixStream(
          channelScope,
          fixture.remoteSocket,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(await fixture.sshInvocationCount()).toBe(2);
    }, 45_000);


  },
);

class OpenSshFixture {
  readonly directory: string;
  readonly hostAlias = "sedes-openssh-fixture";
  readonly sshWrapper: string;
  readonly workspaceRoot: string;
  readonly workspace: string;
  readonly remoteSocket: string;
  readonly carrierRoot: string;
  readonly #sshInvocationLog: string;
  readonly #knownHosts: string;
  readonly #sshd: ChildProcess;
  #remoteServer: Server;
  #remoteClients: Set<Socket>;
  readonly #managedProviders = new Set<SshEnvironmentChannelProvider>();
  #closed = false;

  private constructor(input: {
    directory: string;
    sshWrapper: string;
    workspaceRoot: string;
    workspace: string;
    remoteSocket: string;
    carrierRoot: string;
    sshInvocationLog: string;
    knownHosts: string;
    sshd: ChildProcess;
    remoteServer: Server;
    remoteClients: Set<Socket>;
  }) {
    this.directory = input.directory;
    this.sshWrapper = input.sshWrapper;
    this.workspaceRoot = input.workspaceRoot;
    this.workspace = input.workspace;
    this.remoteSocket = input.remoteSocket;
    this.carrierRoot = input.carrierRoot;
    this.#sshInvocationLog = input.sshInvocationLog;
    this.#knownHosts = input.knownHosts;
    this.#sshd = input.sshd;
    this.#remoteServer = input.remoteServer;
    this.#remoteClients = input.remoteClients;
  }

  static async create(): Promise<OpenSshFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), "h-openssh-real-"));
    await chmod(directory, 0o700);
    const workspaceRoot = path.join(directory, "workspaces");
    const workspace = path.join(workspaceRoot, "project");
    const remoteParent = path.join(directory, "remote-private");
    const remoteSocket = path.join(remoteParent, "codex.sock");
    const carrierRoot = path.join(directory, "carriers");
    for (const item of [workspaceRoot, workspace, remoteParent, carrierRoot]) {
      await mkdir(item, { recursive: true, mode: 0o700 });
      await chmod(item, 0o700);
    }

    const hostKey = path.join(directory, "host-key");
    const clientKey = path.join(directory, "client-key");
    await generateKey(hostKey);
    await generateKey(clientKey);
    const authorizedKeys = path.join(directory, "authorized_keys");
    const nodePath = [
      path.dirname(process.execPath),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":");
    await writeFile(
      authorizedKeys,
      `environment="PATH=${nodePath}" ${(await readFile(`${clientKey}.pub`, "utf8")).trim()}\n`,
    );
    await chmod(authorizedKeys, 0o600);

    const port = await unusedLoopbackPort();
    const hostPublicKey = await readFile(`${hostKey}.pub`, "utf8");
    const knownHosts = path.join(directory, "known_hosts");
    await writeKnownHost(knownHosts, port, hostPublicKey);
    const sshConfig = path.join(directory, "ssh_config");
    await writeFile(
      sshConfig,
      [
        "Host sedes-openssh-fixture",
        "  HostName 127.0.0.1",
        `  Port ${port}`,
        `  User ${userInfo().username}`,
        `  IdentityFile ${clientKey}`,
        `  UserKnownHostsFile ${knownHosts}`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  PubkeyAuthentication yes",
        "  CheckHostIP no",
        "  SendEnv -LANG -LC_*",
        "  LogLevel ERROR",
        "",
      ].join("\n"),
    );
    await chmod(sshConfig, 0o600);
    const sshWrapper = path.join(directory, "ssh-fixture");
    const sshInvocationLog = path.join(directory, "ssh-invocations");
    await writeFile(sshInvocationLog, "");
    await writeFile(
      sshWrapper,
      `#!/bin/sh\nprintf 'x\\n' >> '${sshInvocationLog}'\nexec ${SSH} -F '${sshConfig}' "$@"\n`,
    );
    await chmod(sshWrapper, 0o700);

    const sshdConfig = path.join(directory, "sshd_config");
    await writeFile(
      sshdConfig,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        `PidFile ${path.join(directory, "sshd.pid")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "PermitUserEnvironment yes",
        "AuthenticationMethods publickey",
        "UsePAM no",
        "StrictModes no",
        `AllowUsers ${userInfo().username}`,
        "AllowAgentForwarding no",
        "AllowTcpForwarding yes",
        "AllowStreamLocalForwarding yes",
        "GatewayPorts no",
        "PermitTTY no",
        "X11Forwarding no",
        "PermitUserEnvironment no",
        "LogLevel VERBOSE",
        "",
      ].join("\n"),
    );
    const sshd = spawn(SSHD, ["-D", "-e", "-f", sshdConfig], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let sshdStderr = "";
    sshd.stderr?.on("data", (chunk: Buffer) => {
      sshdStderr += chunk.toString("utf8");
    });
    try {
      await waitForLoopbackServer(port, sshd, () => sshdStderr);
      const remoteClients = new Set<Socket>();
      const remoteServer = await startEchoServer(remoteSocket, remoteClients);
      const fixture = new OpenSshFixture({
        directory,
        sshWrapper,
        workspaceRoot,
        workspace,
        remoteSocket,
        carrierRoot,
        sshInvocationLog,
        knownHosts,
        sshd,
        remoteServer,
        remoteClients,
      });
      return fixture;
    } catch (error) {
      await terminateChild(sshd);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async echoDirectly(message: string): Promise<string> {
    const socket = createConnection({ path: this.remoteSocket });
    const received = new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (bytes) => resolve(bytes.toString("utf8")));
    });
    socket.end(message);
    return await withTimeout(received, 5_000);
  }

  async sshInvocationCount(): Promise<number> {
    return (await readFile(this.#sshInvocationLog, "utf8"))
      .split("\n")
      .filter(Boolean).length;
  }

  manage(provider: SshEnvironmentChannelProvider): void {
    this.#managedProviders.add(provider);
  }

  async installWrongKnownHost(): Promise<void> {
    const wrongKey = path.join(this.directory, "wrong-host-key");
    await generateKey(wrongKey);
    const wrongPublicKey = await readFile(`${wrongKey}.pub`, "utf8");
    const portMatch = /^\[127\.0\.0\.1\]:(\d+) /.exec(
      await readFile(this.#knownHosts, "utf8"),
    );
    if (!portMatch?.[1]) throw new Error("fixture_known_host_invalid");
    await writeKnownHost(
      this.#knownHosts,
      Number(portMatch[1]),
      wrongPublicKey,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#managedProviders].map((provider) => provider.close()),
    );
    this.#managedProviders.clear();
    await closeServer(this.#remoteServer, this.#remoteClients);
    await terminateChild(this.#sshd);
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function generateKey(file: string): Promise<void> {
  await execFile(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", file]);
}

async function writeKnownHost(
  file: string,
  port: number,
  publicKey: string,
): Promise<void> {
  const [kind, encoded] = publicKey.trim().split(/\s+/, 3);
  if (!kind || !encoded) throw new Error("fixture_public_key_invalid");
  await writeFile(file, `[127.0.0.1]:${port} ${kind} ${encoded}\n`);
  await chmod(file, 0o600);
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fixture_port_unavailable");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForLoopbackServer(
  port: number,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`fixture_sshd_exited: ${stderr()}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture_sshd_start_timeout: ${stderr()}`);
}

async function startEchoServer(
  socketPath: string,
  clients: Set<Socket>,
): Promise<Server> {
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("data", (bytes) => socket.write(bytes));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return server;
}

async function closeServer(
  server: Server,
  clients: Set<Socket>,
): Promise<void> {
  for (const client of clients) client.destroy();
  clients.clear();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("fixture_operation_timeout")),
        milliseconds,
      ),
    ),
  ]);
}
