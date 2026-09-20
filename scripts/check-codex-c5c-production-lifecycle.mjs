import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_EXECUTION_ENVIRONMENT_ID = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const codexBinary = await preflightLifecycleArtifacts();
// Codex 0.153 refuses to initialize PATH helper aliases when CODEX_HOME is
// beneath the process temporary directory and emits that refusal on stderr.
// The runtime version attestation intentionally rejects any stderr, so keep
// the disposable fixture beneath the account's private home even when the
// caller isolates HOME beneath /tmp.
const temporaryRoot = await mkdtemp(
  path.join(os.userInfo().homedir, ".sedes-c5c-production-lifecycle-"),
);
const ownedGroups = new Set();
const externalProcesses = new Set();
const managementCredentials = new Map();
let sedes;
let external;

async function preflightLifecycleArtifacts() {
  // The owned-stdio runtime guard and checked-in release attestation are
  // currently closed to linux/x64. Resolve that tuple through npm rather than
  // assuming a repository-local node_modules layout, and reject every other
  // host before creating temp state or starting a process.
  const supportedTargets = {
    "linux/x64": {
      packageName: "@openai/codex-linux-x64",
      packageVersion: "0.153.0-linux-x64",
      vendorTarget: "x86_64-unknown-linux-musl",
    },
  };
  const target = supportedTargets[`${process.platform}/${process.arch}`];
  if (!target) {
    throw new Error(
      `c5c_lifecycle_platform_unsupported: requires linux/x64; received ${process.platform}/${process.arch}`,
    );
  }

  const require = createRequire(path.join(repositoryRoot, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw new Error(
      `c5c_lifecycle_install_missing: run npm ci to install ${target.packageName}`,
    );
  }
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error("c5c_lifecycle_install_metadata_invalid: run npm ci");
  }
  if (packageMetadata?.version !== target.packageVersion) {
    throw new Error("c5c_lifecycle_install_version_invalid: run npm ci");
  }
  const executable = path.join(
    path.dirname(packageJsonPath),
    "vendor",
    target.vendorTarget,
    "bin",
    "codex",
  );
  const executableMetadata = await safeStat(executable);
  if (
    !executableMetadata?.isFile() ||
    (executableMetadata.mode & 0o111) === 0
  ) {
    throw new Error(
      `c5c_lifecycle_install_missing: run npm ci to install ${target.packageName}`,
    );
  }

  const builtServer = path.join(repositoryRoot, "dist", "server", "index.js");
  if (!(await safeStat(builtServer))?.isFile()) {
    throw new Error(
      "c5c_lifecycle_build_missing: run npm run build or npm run test:c5c-production-lifecycle",
    );
  }
  if (
    !(
      await safeStat(`/proc/${process.pid}/task/${process.pid}/children`)
    )?.isFile()
  ) {
    throw new Error(
      "c5c_lifecycle_procfs_unavailable: readable Linux procfs is required",
    );
  }
  return executable;
}

try {
  const secureCodex = path.join(temporaryRoot, "codex");
  await copyFile(codexBinary, secureCodex);
  await chmod(secureCodex, 0o700);
  await checkExternalUdsLifecycle(secureCodex);
  await checkExternalTcpLifecycle(secureCodex);
  await checkUnavailableTcpCoexistence(secureCodex);
  await checkOwnedStdioLifecycle(secureCodex);
  process.stdout.write(
    "C5c production TERM/restart: authenticated TCP, external UDS, unavailable-backend coexistence, and owned stdio passed.\n",
  );
} finally {
  await stopChild(sedes, "SIGKILL", 2_000).catch(() => undefined);
  sedes = undefined;
  await stopProcessGroup(external, 2_000).catch(() => undefined);
  external = undefined;
  for (const child of externalProcesses) {
    await stopProcessGroup(child, 2_000).catch(() => undefined);
  }
  externalProcesses.clear();
  for (const processGroupId of ownedGroups) {
    stopKnownProcessGroup(processGroupId);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function checkExternalUdsLifecycle(secureCodex) {
  const root = path.join(temporaryRoot, "external");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const socketDirectory = path.join(root, "socket");
  const socketPath = path.join(socketDirectory, "app-server.sock");
  const stateDirectory = path.join(root, "state");
  const configurationFile = path.join(root, "backend.json");
  await prepareDirectories([
    root,
    codexHome,
    workspace,
    socketDirectory,
    stateDirectory,
  ]);
  await writeCodexHome(codexHome);
  await writeBackendConfiguration(configurationFile, {
    codexHome, workspace, stateDirectory,
    connection: {
      ownership: "external",
      channel: { type: "unix_websocket", socketPath },
    },
  });

  external = capturedSpawn(
    secureCodex,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(codexHome)}`,
      "--strict-config",
      "--listen",
      `unix://${socketPath}`,
    ],
    {
      cwd: workspace,
      detached: true,
      env: codexEnvironment(codexHome),
    },
  );
  await waitUntil(
    async () => {
      external.assertRunning("external_uds_process_failed");
      const metadata = await safeStat(socketPath);
      return metadata?.isSocket() === true;
    },
    5_000,
    "external_socket_not_ready",
  );
  const socketBefore = await stat(socketPath, { bigint: true });
  if ((socketBefore.mode & 0o777n) !== 0o600n) {
    throw new Error("external_socket_mode_invalid");
  }

  const port = await availablePort();
  const environment = sedesEnvironment({
    configurationFile,
    stateDirectory,
    workspace,
    port,
  });
  sedes = await startSedes(environment, port);
  await stopChild(sedes, "SIGTERM", 10_000);
  sedes = undefined;
  assertProcessAlive(external.pid, "external_daemon_stopped_by_sedes");
  await assertMissingLock(codexHome);

  sedes = await startSedes(environment, port);
  await stopChild(sedes, "SIGTERM", 10_000);
  sedes = undefined;
  assertProcessAlive(external.pid, "external_daemon_stopped_after_restart");
  await assertMissingLock(codexHome);
  const socketAfter = await stat(socketPath, { bigint: true });
  if (
    socketAfter.dev !== socketBefore.dev ||
    socketAfter.ino !== socketBefore.ino
  ) {
    throw new Error("external_socket_generation_changed");
  }

  await stopProcessGroup(external, 5_000);
  external = undefined;
}

async function checkOwnedStdioLifecycle(secureCodex) {
  const canonicalSecureCodex = await realpath(secureCodex);
  const root = path.join(temporaryRoot, "owned");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const stateDirectory = path.join(root, "state");
  const configurationFile = path.join(root, "backend.json");
  await prepareDirectories([root, codexHome, workspace, stateDirectory]);
  await writeCodexHome(codexHome);
  await writeBackendConfiguration(configurationFile, {
    codexHome, workspace, stateDirectory,
    connection: {
      ownership: "owned",
      channel: {
        type: "process_stdio",
        executablePath: secureCodex,
        workingDirectory: workspace,
      },
    },
  });

  const port = await availablePort();
  const environment = sedesEnvironment({
    configurationFile,
    stateDirectory,
    workspace,
    port,
  });
  let priorProcessGroupId;
  for (let generation = 0; generation < 2; generation += 1) {
    const discoveredGroups = new Set();
    const discoverOwnedGroups = async (sedesChild) => {
      for (const processGroupId of await ownedCodexProcessGroups(
        sedesChild.pid,
        canonicalSecureCodex,
      )) {
        ownedGroups.add(processGroupId);
        discoveredGroups.add(processGroupId);
      }
    };
    sedes = await startSedes(environment, port, [], undefined, {
      observeDirectChildren: discoverOwnedGroups,
    });
    const processGroupId = await waitUntil(
      async () => {
        await discoverOwnedGroups(sedes);
        const aliveGroups = [...discoveredGroups].filter(processGroupAlive);
        if (aliveGroups.length > 1) {
          throw new Error("owned_process_group_ambiguous");
        }
        return aliveGroups[0];
      },
      5_000,
      "owned_process_not_found",
    );
    if (priorProcessGroupId === processGroupId) {
      throw new Error("owned_process_generation_not_replaced");
    }
    priorProcessGroupId = processGroupId;
    assertProcessGroupAlive(processGroupId, "owned_process_group_missing");
    const lock = await safeStat(
      path.join(codexHome, ".harness-codex-runtime.lock"),
    );
    if (!lock?.isDirectory()) throw new Error("owned_lock_missing");

    const lockOrder = assertLockHeldUntilProcessGroupDies(
      processGroupId,
      codexHome,
      10_000,
    );
    await Promise.all([stopChild(sedes, "SIGTERM", 10_000), lockOrder]);
    sedes = undefined;
    await waitUntil(
      () => [...discoveredGroups].every((group) => !processGroupAlive(group)),
      5_000,
      "owned_process_group_survived",
    );
    for (const group of discoveredGroups) ownedGroups.delete(group);
    await assertMissingLock(codexHome);
  }
}

async function checkExternalTcpLifecycle(secureCodex) {
  const root = path.join(temporaryRoot, "external-tcp");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const stateDirectory = path.join(root, "state");
  const configurationFile = path.join(root, "backend.json");
  const tokenFile = path.join(root, "app-server-token");
  const token = randomBytes(32).toString("base64url");
  const tcpPort = await availablePort();
  await prepareDirectories([root, codexHome, workspace, stateDirectory]);
  await writeCodexHome(codexHome);
  await writeFile(tokenFile, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeBackendConfiguration(configurationFile, {
    codexHome, workspace, stateDirectory,
    connection: {
      ownership: "external",
      channel: {
        type: "tcp_websocket",
        url: `ws://127.0.0.1:${tcpPort}`,
        authentication: {
          type: "capability_token",
          secret: {
            source: "environment",
            variable: "SEDES_CODEX_LIFECYCLE_TOKEN",
          },
        },
      },
    },
  });

  external = capturedSpawn(
    secureCodex,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(codexHome)}`,
      "--strict-config",
      "--listen",
      `ws://127.0.0.1:${tcpPort}`,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenFile,
    ],
    {
      cwd: workspace,
      detached: true,
      env: codexEnvironment(codexHome),
      sensitiveValues: [token],
    },
  );
  await waitForTcpListener(tcpPort, 5_000, "external_tcp_not_ready", external);

  const sedesPort = await availablePort();
  const environment = {
    ...sedesEnvironment({
      configurationFile,
      stateDirectory,
      workspace,
      port: sedesPort,
    }),
    SEDES_CODEX_LIFECYCLE_TOKEN: token,
  };
  sedes = await startSedes(environment, sedesPort, [token]);
  await stopChild(sedes, "SIGTERM", 10_000);
  sedes.assertNoSensitiveDiagnostics();
  sedes = undefined;
  assertProcessAlive(external.pid, "external_tcp_daemon_stopped_by_sedes");
  await waitForTcpListener(
    tcpPort,
    2_000,
    "external_tcp_not_accepting_after_disconnect",
  );
  await assertMissingLock(codexHome);

  sedes = await startSedes(environment, sedesPort, [token]);
  await stopChild(sedes, "SIGTERM", 10_000);
  sedes.assertNoSensitiveDiagnostics();
  sedes = undefined;
  assertProcessAlive(external.pid, "external_tcp_daemon_stopped_after_restart");
  await waitForTcpListener(
    tcpPort,
    2_000,
    "external_tcp_not_accepting_after_restart",
  );
  await assertMissingLock(codexHome);

  external.assertNoSensitiveDiagnostics();
  await stopProcessGroup(external, 5_000);
  external = undefined;
}

async function checkUnavailableTcpCoexistence(secureCodex) {
  const root = path.join(temporaryRoot, "coexistence");
  const udsCodexHome = path.join(root, "uds-codex-home");
  const tcpCodexHome = path.join(root, "tcp-codex-home");
  const workspace = path.join(root, "workspace");
  const socketDirectory = path.join(root, "socket");
  const socketPath = path.join(socketDirectory, "app-server.sock");
  const stateDirectory = path.join(root, "state");
  const configurationFile = path.join(root, "backend.json");
  const tokenFile = path.join(root, "app-server-token");
  const token = randomBytes(32).toString("base64url");
  const tcpPort = await availablePort();
  const badTcpPort = await availablePort();
  const tcpEndpoint = `ws://127.0.0.1:${tcpPort}`;
  const badTcpEndpoint = `ws://127.0.0.1:${badTcpPort}`;
  await prepareDirectories([
    root,
    udsCodexHome,
    tcpCodexHome,
    workspace,
    socketDirectory,
    stateDirectory,
  ]);
  await Promise.all([
    writeCodexHome(udsCodexHome),
    writeCodexHome(tcpCodexHome),
  ]);
  await writeFile(tokenFile, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeCoexistenceBackendConfiguration(configurationFile, {
    workspace, stateDirectory,
    udsCodexHome,
    tcpCodexHome,
    socketPath,
    tcpEndpoint,
    badTcpEndpoint,
  });

  const udsExternal = capturedSpawn(
    secureCodex,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(udsCodexHome)}`,
      "--strict-config",
      "--listen",
      `unix://${socketPath}`,
    ],
    {
      cwd: workspace,
      detached: true,
      env: codexEnvironment(udsCodexHome),
    },
  );
  externalProcesses.add(udsExternal);
  const tcpExternal = capturedSpawn(
    secureCodex,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(tcpCodexHome)}`,
      "--strict-config",
      "--listen",
      tcpEndpoint,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenFile,
    ],
    {
      cwd: workspace,
      detached: true,
      env: codexEnvironment(tcpCodexHome),
      sensitiveValues: [token],
    },
  );
  externalProcesses.add(tcpExternal);

  try {
    await Promise.all([
      waitUntil(
        async () => {
          udsExternal.assertRunning("coexistence_uds_process_failed");
          return (await safeStat(socketPath))?.isSocket() === true;
        },
        5_000,
        "coexistence_uds_not_ready",
      ),
      waitForTcpListener(
        tcpPort,
        5_000,
        "coexistence_tcp_not_ready",
        tcpExternal,
      ),
    ]);
    const socketBefore = await stat(socketPath, { bigint: true });
    if ((socketBefore.mode & 0o777n) !== 0o600n) {
      throw new Error("coexistence_uds_socket_mode_invalid");
    }

    const sedesPort = await availablePort();
    const sensitiveValues = [token, tcpEndpoint, badTcpEndpoint, socketPath];
    const environment = {
      ...sedesEnvironment({
        configurationFile,
        stateDirectory,
        workspace,
        port: sedesPort,
      }),
      SEDES_CODEX_COEXISTENCE_TOKEN: token,
    };
    const requiredBackendLabels = [
      "Pi coexistence",
      "Codex UDS coexistence",
      "Codex TCP coexistence",
    ];

    for (let generation = 0; generation < 2; generation += 1) {
      sedes = await startSedes(
        environment,
        sedesPort,
        sensitiveValues,
        requiredBackendLabels,
      );
      const application = await readApplication(sedesPort);
      assertCoexistenceTargets(application.snapshot, sensitiveValues);
      await assertUnavailableTargetResponse(
        sedesPort,
        application,
        workspace,
        sensitiveValues,
      );
      const healthyAfterBadTarget = await readApplication(sedesPort);
      assertCoexistenceTargets(healthyAfterBadTarget.snapshot, sensitiveValues);
      await assertApplicationHealthy(sedesPort);

      await stopChild(sedes, "SIGTERM", 10_000);
      sedes.assertNoSensitiveDiagnostics();
      sedes = undefined;
      assertProcessAlive(udsExternal.pid, "coexistence_uds_stopped_by_sedes");
      assertProcessAlive(tcpExternal.pid, "coexistence_tcp_stopped_by_sedes");
      await waitForTcpListener(
        tcpPort,
        2_000,
        "coexistence_tcp_not_accepting_after_sedes_term",
      );
      const socketAfter = await stat(socketPath, { bigint: true });
      if (
        socketAfter.dev !== socketBefore.dev ||
        socketAfter.ino !== socketBefore.ino
      ) {
        throw new Error("coexistence_uds_generation_changed");
      }
      await Promise.all([
        assertMissingLock(udsCodexHome),
        assertMissingLock(tcpCodexHome),
      ]);
    }

    udsExternal.assertNoSensitiveDiagnostics();
    tcpExternal.assertNoSensitiveDiagnostics();
  } finally {
    await stopProcessGroup(udsExternal, 5_000);
    externalProcesses.delete(udsExternal);
    await stopProcessGroup(tcpExternal, 5_000);
    externalProcesses.delete(tcpExternal);
  }
}

async function writeCodexHome(codexHome) {
  await writeFile(
    path.join(codexHome, "config.toml"),
    `model = "gpt-5.6-codex"
model_provider = "sedes_lifecycle"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_lifecycle]
name = "Sedes production lifecycle"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[features]
apps = false
plugins = false
`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function writeBackendConfiguration(filename, { codexHome, connection, workspace, stateDirectory }) {
  const configuredConnection =
    connection.ownership === "owned"
      ? {
          ...connection,
          channel: { ...connection.channel, codexHome },
        }
      : connection;
  const configuration = {
    schemaVersion: 10,
    executionEnvironments: [
      {
        id: LOCAL_EXECUTION_ENVIRONMENT_ID,
        kind: "local",
        label: "Local",
      },
    ],
    backends: [
      {
        id: "pi-production-lifecycle",
        kind: "pi",
        label: "Pi production lifecycle",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      {
        id: "codex-production-lifecycle",
        kind: "codex_app_server",
        label: "Codex production lifecycle",
        enabled: true,
        modelPolicy: { type: "catalog" },
        moduleConfiguration: {
          connection: configuredConnection,
          policy: {
            allowedSandboxModes: ["read-only"],
            allowedNetworkAccess: ["disabled"],
            allowedApprovalPolicies: ["never"],
            allowedApprovalReviewers: ["user"],
          },
        },
      },
    ],
    targets: [
      {
        id: "pi-production-lifecycle-target",
        kind: "pi_sdk",
        label: "Pi production lifecycle",
        backendInstanceId: "pi-production-lifecycle",
        executionEnvironmentId: LOCAL_EXECUTION_ENVIRONMENT_ID,
        enabled: true,
      },
      {
        id: "codex-production-lifecycle-target",
        kind: "codex_app_server",
        label: "Codex production lifecycle",
        backendInstanceId: "codex-production-lifecycle",
        executionEnvironmentId: LOCAL_EXECUTION_ENVIRONMENT_ID,
        enabled: true,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "read-only",
            networkAccess: "disabled",
            approvalPolicy: "never",
            approvalReviewer: "user",
            model: { type: "catalogDefault" },
          },
        },
      },
    ],
    defaultTargetId: "pi-production-lifecycle-target",
  };
  await importFixtureConfiguration(filename, configuration, { workspace, stateDirectory });
}

async function writeCoexistenceBackendConfiguration(filename, input) {
  const codexBackend = (id, label, connection) => ({
    id,
    kind: "codex_app_server",
    label,
    enabled: true,
    modelPolicy: { type: "catalog" },
    moduleConfiguration: {
      connection,
      policy: {
        allowedSandboxModes: ["read-only"],
        allowedNetworkAccess: ["disabled"],
        allowedApprovalPolicies: ["never"],
        allowedApprovalReviewers: ["user"],
      },
    },
  });
  const codexTarget = (id, label, backendInstanceId) => ({
    id,
    kind: "codex_app_server",
    label,
    backendInstanceId,
    executionEnvironmentId: LOCAL_EXECUTION_ENVIRONMENT_ID,
    enabled: true,
    moduleConfiguration: {
      defaults: {
        sandboxMode: "read-only",
        networkAccess: "disabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
        model: { type: "catalogDefault" },
      },
    },
  });
  const configuration = {
    schemaVersion: 10,
    executionEnvironments: [
      {
        id: LOCAL_EXECUTION_ENVIRONMENT_ID,
        kind: "local",
        label: "Local",
      },
    ],
    backends: [
      {
        id: "pi-coexistence",
        kind: "pi",
        label: "Pi coexistence",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
      codexBackend("codex-uds-coexistence", "Codex UDS coexistence", {
        ownership: "external",
        channel: {
          type: "unix_websocket",
          socketPath: input.socketPath,
        },
      }),
      codexBackend("codex-tcp-coexistence", "Codex TCP coexistence", {
        ownership: "external",
        channel: {
          type: "tcp_websocket",
          url: input.tcpEndpoint,
          authentication: {
            type: "capability_token",
            secret: {
              source: "environment",
              variable: "SEDES_CODEX_COEXISTENCE_TOKEN",
            },
          },
        },
      }),
      codexBackend("codex-bad-tcp-coexistence", "Codex bad TCP coexistence", {
        ownership: "external",
        channel: {
          type: "tcp_websocket",
          url: input.badTcpEndpoint,
          authentication: {
            type: "capability_token",
            secret: {
              source: "environment",
              variable: "SEDES_CODEX_COEXISTENCE_TOKEN",
            },
          },
        },
      }),
    ],
    targets: [
      {
        id: "pi-coexistence-target",
        kind: "pi_sdk",
        label: "Pi coexistence target",
        backendInstanceId: "pi-coexistence",
        executionEnvironmentId: LOCAL_EXECUTION_ENVIRONMENT_ID,
        enabled: true,
      },
      codexTarget(
        "codex-uds-coexistence-target",
        "Codex UDS coexistence target",
        "codex-uds-coexistence",
      ),
      codexTarget(
        "codex-tcp-coexistence-target",
        "Codex TCP coexistence target",
        "codex-tcp-coexistence",
      ),
      codexTarget(
        "codex-bad-tcp-coexistence-target",
        "Codex bad TCP coexistence target",
        "codex-bad-tcp-coexistence",
      ),
    ],
    defaultTargetId: "pi-coexistence-target",
  };
  await importFixtureConfiguration(filename, configuration, input);
}

/** One-time offline setup; restarts load the database without reimporting. */
async function importFixtureConfiguration(filename, configuration, { workspace, stateDirectory }) {
  const importFilename = `${filename}.import.json`;
  await writeFile(importFilename, JSON.stringify(configuration), {
    encoding: "utf8", mode: 0o600,
  });
  const importEnvironment = { ...process.env };
  delete importEnvironment.NODE_ENV;
  delete importEnvironment.WORKSPACE_ROOTS;
  await promisify(execFile)(process.execPath, [
    "--import", "tsx", path.join(repositoryRoot, "scripts", "configuration", "import.ts"),
    "--file", importFilename, "--state-directory", stateDirectory,
    "--workspace-roots", workspace,
  ], {
    cwd: repositoryRoot, env: importEnvironment,
    timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  await writeFile(filename, JSON.stringify({ schemaVersion: 11, packagedClients: [] }), {
    encoding: "utf8", mode: 0o600,
  });
}

async function startSedes(
  environment,
  port,
  sensitiveValues = [],
  requiredBackendLabels = ["Codex production lifecycle"],
  options = {},
) {
  const { AuthenticationRepository } = await import(pathToFileURL(
    path.join(repositoryRoot, "dist", "server", "authentication", "authentication-repository.js"),
  ).href);
  const authentication = new AuthenticationRepository(environment.APP_STATE_DIR);
  let credential;
  try {
    const pairing = authentication.createPairing({ kind: "management" });
    const result = authentication.exchangePairing({
      token: pairing.token, clientName: "Production lifecycle probe", kind: "device",
    });
    if (!result) throw new Error("lifecycle_probe_pairing_failed");
    credential = result.credential;
  } finally {
    authentication.close();
  }
  managementCredentials.set(`http://127.0.0.1:${port}`, credential);
  const child = capturedSpawn(
    process.execPath,
    [path.join(repositoryRoot, "dist", "server", "index.js")],
    { cwd: repositoryRoot, env: environment, sensitiveValues: [...sensitiveValues, credential] },
  );
  try {
    await waitUntil(
      async () => {
        child.assertRunning("sedes_exited_during_startup");
        await options.observeDirectChildren?.(child);
        try {
          const response = await fetchSedes(port, "/api/application/snapshot",
            { signal: AbortSignal.timeout(500) },
          );
          if (!response.ok) return false;
          const body = await response.json();
          const labels = new Set(
            body?.executionTargets?.map(
              (target) => target?.backend?.label?.text,
            ) ?? [],
          );
          return requiredBackendLabels.every((label) => labels.has(label));
        } catch {
          return false;
        }
      },
      15_000,
      "sedes_startup_timeout",
    );
    await options.observeDirectChildren?.(child);
    return child;
  } catch (error) {
    await options.observeDirectChildren?.(child).catch(() => undefined);
    await stopChild(child, "SIGKILL", 2_000).catch(() => undefined);
    throw error;
  }
}

function fetchSedes(port, pathname, init = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(pathname, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
    throw new Error("lifecycle_probe_request_origin_invalid");
  }
  const credential = managementCredentials.get(origin);
  if (!credential) throw new Error("lifecycle_probe_not_authenticated");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${credential}`);
  return fetch(url, { ...init, headers, redirect: "error" });
}

async function readApplication(port) {
  const [sessionResponse, snapshotResponse] = await Promise.all([
    fetchSedes(port, "/api/application/session", {
      signal: AbortSignal.timeout(2_000),
    }),
    fetchSedes(port, "/api/application/snapshot", {
      signal: AbortSignal.timeout(2_000),
    }),
  ]);
  if (!sessionResponse.ok || !snapshotResponse.ok) {
    throw new Error("coexistence_application_unavailable");
  }
  return {
    session: await sessionResponse.json(),
    snapshot: await snapshotResponse.json(),
  };
}

function assertCoexistenceTargets(snapshot, sensitiveValues) {
  const targets = snapshot?.executionTargets;
  if (!Array.isArray(targets)) {
    throw new Error("coexistence_target_catalog_invalid");
  }
  const expected = new Map([
    ["Pi coexistence", "Pi coexistence target"],
    ["Codex UDS coexistence", "Codex UDS coexistence target"],
    ["Codex TCP coexistence", "Codex TCP coexistence target"],
  ]);
  const observed = new Map(
    targets.map((target) => [target?.backend?.label?.text, target]),
  );
  for (const [backendLabel, targetLabel] of expected) {
    const target = observed.get(backendLabel);
    if (target?.label?.text !== targetLabel || target?.available !== true) {
      throw new Error("coexistence_healthy_target_missing");
    }
  }
  const unavailable = observed.get("Codex bad TCP coexistence");
  if (
    unavailable?.label?.text !== "Codex bad TCP coexistence target" ||
    unavailable?.available !== false ||
    typeof unavailable?.unavailableReason?.text !== "string" ||
    unavailable.unavailableReason.text.length === 0 ||
    new Set(targets.map((target) => target?.id)).size !== targets.length ||
    new Set(targets.map((target) => target?.label?.text)).size !==
      targets.length
  ) {
    throw new Error("coexistence_target_isolation_invalid");
  }
  assertPrivateMaterialAbsent(JSON.stringify(snapshot), sensitiveValues);
}

async function assertUnavailableTargetResponse(
  port,
  application,
  workspacePath,
  sensitiveValues,
) {
  const csrfToken = application?.session?.csrfToken;
  if (typeof csrfToken !== "string") {
    throw new Error("coexistence_session_identity_invalid");
  }
  let workspaceId = application?.snapshot?.workspaces?.[0]?.id;
  if (typeof workspaceId !== "string") {
    const workspaceResponse = await fetchSedes(port, "/api/workspaces/open",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          environmentId: LOCAL_EXECUTION_ENVIRONMENT_ID,
          path: workspacePath,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const openedWorkspace = await workspaceResponse.json();
    if (
      workspaceResponse.status !== 201 ||
      typeof openedWorkspace?.id !== "string"
    ) {
      throw new Error("coexistence_workspace_open_invalid");
    }
    assertPrivateMaterialAbsent(
      JSON.stringify(openedWorkspace),
      sensitiveValues,
    );
    workspaceId = openedWorkspace.id;
  }
  const badTargetId = application?.snapshot?.executionTargets?.find(
    (target) => target?.backend?.label?.text === "Codex bad TCP coexistence",
  )?.id;
  if (typeof badTargetId !== "string") {
    throw new Error("coexistence_bad_target_identity_invalid");
  }
  const response = await fetchSedes(port, "/api/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({
      workspaceId,
      title: "Unavailable target probe",
      executionWorkspace: { kind: "direct" },
      configuration: { kind: "custom", targetId: badTargetId },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  if (
    response.status !== 503 ||
    body?.error?.code !== "runtime_unavailable" ||
    body?.error?.message !==
      "The selected agent target is not currently available for thread creation." ||
    body?.error?.retryable !== true
  ) {
    throw new Error("coexistence_bad_target_diagnostic_invalid");
  }
  assertPrivateMaterialAbsent(JSON.stringify(body), sensitiveValues);
}

async function assertApplicationHealthy(port) {
  const response = await fetchSedes(port, "/api/health", {
    signal: AbortSignal.timeout(2_000),
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "ok") {
    throw new Error("coexistence_application_health_invalid");
  }
}

function assertPrivateMaterialAbsent(serialized, sensitiveValues) {
  for (const value of [
    ...sensitiveValues,
    "tcp_websocket",
    "unix_websocket",
    "capability_token",
    "Authorization",
  ]) {
    if (serialized.includes(value)) {
      throw new Error("coexistence_private_material_leaked");
    }
  }
}

function capturedSpawn(command, arguments_, inputOptions) {
  const { sensitiveValues = [], ...options } = inputOptions;
  let diagnosticTail = "";
  let spawnFailure;
  const child = spawn(command, arguments_, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ChildProcess emits `error` asynchronously for failures such as ENOENT or
  // EACCES. Capture it synchronously after spawn so it can never escape the
  // surrounding cleanup boundary as an unhandled EventEmitter error.
  child.on("error", (error) => {
    spawnFailure ??= error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      diagnosticTail = `${diagnosticTail}${chunk}`.slice(-16_384);
    });
  }
  child.safeDiagnostic = () => {
    let diagnostic = diagnosticTail.replaceAll(
      temporaryRoot,
      "[temporary-root]",
    );
    for (const value of sensitiveValues) {
      diagnostic = diagnostic.replaceAll(value, "[redacted-sensitive]");
    }
    return diagnostic.trim();
  };
  child.assertNoSensitiveDiagnostics = () => {
    for (const value of sensitiveValues) {
      if (diagnosticTail.includes(value)) {
        throw new Error("sensitive_value_reached_process_diagnostics");
      }
    }
  };
  child.assertRunning = (code) => {
    if (spawnFailure) {
      const failureCode =
        typeof spawnFailure.code === "string"
          ? spawnFailure.code
          : "spawn_error";
      throw new Error(`${code}:${failureCode}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${code}:${child.safeDiagnostic()}`);
    }
  };
  child.spawnFailure = () => spawnFailure;
  return child;
}

async function stopChild(child, signal, timeoutMilliseconds) {
  if (!child) return;
  if (
    child.spawnFailure?.() ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    if (signal === "SIGTERM") {
      throw new Error("child_exited_before_graceful_shutdown");
    }
    return;
  }
  child.kill(signal);
  if (!(await waitForExit(child, timeoutMilliseconds))) {
    child.kill("SIGKILL");
    if (!(await waitForExit(child, 2_000))) {
      throw new Error("child_shutdown_deadline_exceeded");
    }
    if (signal === "SIGTERM") {
      throw new Error("child_graceful_shutdown_deadline_exceeded");
    }
  }
}

async function stopProcessGroup(child, timeoutMilliseconds) {
  if (!child?.pid) return;
  if (!processGroupAlive(child.pid)) return;
  signalProcessGroup(child.pid, "SIGTERM");
  if (
    !(await waitUntilBoolean(
      () => !processGroupAlive(child.pid),
      timeoutMilliseconds,
    ))
  ) {
    signalProcessGroup(child.pid, "SIGKILL");
    if (!(await waitUntilBoolean(() => !processGroupAlive(child.pid), 2_000))) {
      throw new Error("external_process_group_survived");
    }
  }
}

function stopKnownProcessGroup(processGroupId) {
  if (!processGroupAlive(processGroupId)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertProcessAlive(processId, code) {
  try {
    process.kill(processId, 0);
  } catch {
    throw new Error(code);
  }
}

function assertProcessGroupAlive(processGroupId, code) {
  if (!processGroupAlive(processGroupId)) throw new Error(code);
}

function processGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(child, timeoutMilliseconds) {
  if (
    child.spawnFailure?.() ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return true;
  }
  let timer;
  let settle;
  try {
    return await Promise.race([
      new Promise((resolve) => {
        settle = () => resolve(true);
        child.once("exit", settle);
        child.once("close", settle);
        child.once("error", settle);
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (settle) {
      child.removeListener("exit", settle);
      child.removeListener("close", settle);
      child.removeListener("error", settle);
    }
  }
}

async function waitUntil(read, timeoutMilliseconds, errorCode) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(25);
  }
  throw new Error(errorCode);
}

async function waitUntilBoolean(read, timeoutMilliseconds) {
  try {
    await waitUntil(() => read() || undefined, timeoutMilliseconds, "deadline");
    return true;
  } catch {
    return false;
  }
}

async function directChildren(processId) {
  try {
    const value = await readFile(
      `/proc/${processId}/task/${processId}/children`,
      "utf8",
    );
    return value
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function ownedCodexProcessGroups(sedesProcessId, expectedExecutable) {
  const groups = [];
  for (const processId of await directChildren(sedesProcessId)) {
    let executable;
    try {
      executable = await readlink(`/proc/${processId}/exe`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (executable !== expectedExecutable) continue;
    const processGroupId = await linuxProcessGroupId(processId);
    if (processGroupId !== processId) {
      throw new Error("owned_process_group_identity_invalid");
    }
    groups.push(processGroupId);
  }
  return groups;
}

async function linuxProcessGroupId(processId) {
  const value = await readFile(`/proc/${processId}/stat`, "utf8");
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("owned_process_stat_invalid");
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error("owned_process_group_identity_invalid");
  }
  return processGroupId;
}

async function assertMissingLock(codexHome) {
  if (await safeStat(path.join(codexHome, ".harness-codex-runtime.lock"))) {
    throw new Error("codex_native_lock_not_released");
  }
}

async function assertLockHeldUntilProcessGroupDies(
  processGroupId,
  codexHome,
  timeoutMilliseconds,
) {
  const lockPath = path.join(codexHome, ".harness-codex-runtime.lock");
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupAlive(processGroupId)) {
    const lock = await safeStat(lockPath);
    if (!lock?.isDirectory() && processGroupAlive(processGroupId)) {
      throw new Error("owned_lock_released_before_process_group_death");
    }
    if (Date.now() >= deadline) {
      throw new Error("owned_process_group_death_order_timeout");
    }
    await delay(5);
  }
}

async function safeStat(filename) {
  try {
    return await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepareDirectories(directories) {
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

function codexEnvironment(codexHome) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: codexHome,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

function sedesEnvironment({
  configurationFile,
  stateDirectory,
  workspace,
  port,
}) {
  const environment = { ...process.env };
  delete environment.WORKSPACE_ROOTS;
  return {
    ...environment,
    SEDES_CONFIG_FILE: configurationFile,
    APP_STATE_DIR: stateDirectory,
    SEDES_QUIESCENT_CUTOVER_CONFIRMED: "1",
    PORT: String(port),
    NODE_ENV: "production",
  };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("port_unavailable");
  }
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTcpListener(
  port,
  timeoutMilliseconds,
  errorCode,
  process,
) {
  await waitUntil(
    async () => {
      process?.assertRunning(`${errorCode}_process_failed`);
      const socket = net.createConnection({ host: "127.0.0.1", port });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("tcp_probe_timeout"));
          }, 250);
          timer.unref();
          socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        return true;
      } catch {
        return false;
      } finally {
        socket.destroy();
      }
    },
    timeoutMilliseconds,
    errorCode,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
