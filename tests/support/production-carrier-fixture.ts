import { build } from "esbuild";
import { loadSidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const SSH = "/usr/bin/ssh", SSHD = "/usr/sbin/sshd", SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const productionOpenSshAvailable = [SSH, SSHD, SSH_KEYGEN].every(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
/** Actual OpenSSH transport; only the fixture account/PATH and ssh config are selected. */
export async function startProductionSshServer(input: { directory: string; binDirectory: string; remoteHome: string; environment?: Readonly<NodeJS.ProcessEnv>; nodeExecutable?: string }) {
  const { directory, binDirectory, remoteHome } = input;
  const hostKey = path.join(directory, "host-key");
  const clientKey = path.join(directory, "client-key");
  await generateKey(hostKey);
  await generateKey(clientKey);
  const authorizedKeys = path.join(directory, "authorized_keys");
  await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`));
  await chmod(authorizedKeys, 0o600);

  const sshPort = await unusedLoopbackPort();
  const hostPublicKey = await readFile(`${hostKey}.pub`, "utf8");
  const knownHosts = path.join(directory, "known_hosts");
  await writeKnownHost(knownHosts, sshPort, hostPublicKey);
  const sshConfig = path.join(directory, "ssh_config");
  await writeFile(
    sshConfig,
    [
      "Host sedes-production-fixture",
      "  HostName 127.0.0.1",
      `  Port ${sshPort}`,
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
  const remotePrefix = input.environment ? `exec env -i ${Object.entries({ ...input.environment, HOME: remoteHome, PATH: `${binDirectory}:/usr/local/bin:/usr/bin:/bin` }).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")} ` : `export PATH=${binDirectory}:/usr/local/bin:/usr/bin:/bin; export HOME=${remoteHome}; `;
  const sshWrapper = path.join(binDirectory, "ssh");
  const sshInvocationLog = path.join(directory, "ssh-invocations.log");
  await writeFile(sshInvocationLog, "");
  await writeFile(
    sshWrapper,
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(sshInvocationLog)}\nargs=("$@")\nlast_index=$((\${#args[@]} - 1))\nlast="\${args[$last_index]}"\nif [[ "$last" == "exec node "* ]]; then\n  args[$last_index]=${shellQuote(remotePrefix)}"${input.environment ? "${last#exec }" : "$last"}"\nfi\nexec ${SSH} -F ${shellQuote(sshConfig)} "\${args[@]}"\n`,
  );
  await chmod(sshWrapper, 0o700);
  const nodeWrapper = path.join(binDirectory, "node");
  await writeFile(
    nodeWrapper,
    `#!/bin/sh\nexec ${shellQuote(input.nodeExecutable ?? process.execPath)} "$@"\n`,
  );
  await chmod(nodeWrapper, 0o700);

  const sshdConfig = path.join(directory, "sshd_config");
  await writeFile(
    sshdConfig,
    [
      `Port ${sshPort}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      `PidFile ${path.join(directory, "sshd.pid")}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
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
      "LogLevel ERROR",
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

  try { await waitForLoopbackServer(sshPort, sshd, () => sshdStderr); }
  catch (error) { await terminateChild(sshd); throw error; }
  return { child: sshd, port: sshPort, invocationLog: sshInvocationLog, configPath: sshConfig };
}
async function generateKey(file: string): Promise<void> { await execFile(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", file]); }
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

export async function unusedLoopbackPort(): Promise<number> {
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
      throw new Error(`fixture_sshd_exited:${stderr()}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const client = createConnection({ host: "127.0.0.1", port });
      client.once("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(20);
  }
  throw new Error(`fixture_sshd_start_timeout:${stderr()}`);
}

export async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(1_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}


/** The same release artifact and connector used by production composition. */
export async function buildProductionSidecarArtifact(directory: string) {
  const { NODE_ENV: _nodeEnvironment, ...environment } = process.env;
  await execFile(process.execPath, ["scripts/build-sidecar.mjs", "--output-directory", directory],
    { cwd: process.cwd(), env: environment, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  return loadSidecarArtifactRegistration(path.join(directory, "manifest.json"));
}
export async function buildProductionOutboundConnector(connectorPath: string) {
  await build({ entryPoints: [path.resolve("src/server/sidecar/outbound-connector-main.ts")], outfile: connectorPath,
    bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    define: { __SEDES_CONNECTOR_VERSION__: JSON.stringify("production-test"), "process.env.WS_NO_BUFFER_UTIL": "true", "process.env.WS_NO_UTF_8_VALIDATE": "true" } });
}
