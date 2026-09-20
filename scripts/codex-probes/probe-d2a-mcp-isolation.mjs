import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeEnvironment,
  RawCodexAppServerClient,
} from "./raw-app-server-client.mjs";
import {
  assertPinnedCodexRelease,
  codexBinary,
} from "./pinned-codex-release.mjs";
import { startMockResponsesServer } from "./mock-responses-server.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const releaseRoot = path.join(
  repositoryRoot,
  "protocol",
  "codex-app-server",
  "0.153.0",
);
const evidenceFilename = path.join(
  releaseRoot,
  "evidence",
  "d2a-mcp-isolation.json",
);
const mcpServer = path.join(
  repositoryRoot,
  "scripts",
  "codex-probes",
  "d2a-mcp-server.mjs",
);
const pinnedRelease = assertPinnedCodexRelease();
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "sedes-codex-d2a-probe-"),
);
const codexHome = path.join(temporaryRoot, "codex-home");
const workspace = path.join(temporaryRoot, "workspace");
const logs = path.join(temporaryRoot, "mcp-logs");
await Promise.all([
  mkdir(codexHome, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(logs, { recursive: true }),
]);
const modelServer = await startMockResponsesServer();
await writeFile(
  path.join(codexHome, "config.toml"),
  `
model = "sedes-fixture"
model_provider = "sedes_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_fixture]
name = "Sedes deterministic fixture"
base_url = "${modelServer.baseUrl}"
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

const secrets = [];
const stderrCaptures = [];
const activeClients = new Set();
try {
  const initialSharedClient = await startClient();
  const sharedAppServerPid = initialSharedClient.pid;
  const [alpha, beta] = await Promise.all([
    startThread(initialSharedClient, "alpha", secret("alpha-run-1")),
    startThread(initialSharedClient, "beta", secret("beta-run-1")),
  ]);

  const [alphaIdentity, betaIdentity] = await Promise.all([
    callIdentity(initialSharedClient, alpha),
    callIdentity(initialSharedClient, beta),
  ]);
  assertIdentity(alphaIdentity, alpha);
  assertIdentity(betaIdentity, beta);
  if (alphaIdentity.tokenFingerprint === betaIdentity.tokenFingerprint) {
    throw new Error("d2a_concurrent_credentials_collapsed");
  }
  const alphaStarted = findSingleStartedEvent(
    await readEvents(alpha.logFilename),
  );
  const betaStarted = findSingleStartedEvent(
    await readEvents(beta.logFilename),
  );
  if (alphaStarted.pid === betaStarted.pid) {
    throw new Error("d2a_concurrent_mcp_processes_collapsed");
  }
  let crossCatalogDenied = false;
  try {
    await initialSharedClient.request("mcpServer/tool/call", {
      threadId: alpha.threadId,
      server: "sedes",
      tool: "identity_beta",
      arguments: {},
      _meta: { threadId: beta.threadId },
    });
  } catch (error) {
    if (
      error?.rpcError?.code !== -32602 ||
      error.rpcError.message !== "tool_not_authorized"
    ) {
      throw new Error(
        `d2a_cross_catalog_unexpected_rejection: ${JSON.stringify(error?.rpcError)}`,
        { cause: error },
      );
    }
    crossCatalogDenied = true;
  }
  if (!crossCatalogDenied) throw new Error("d2a_cross_catalog_call_allowed");

  await materializeConcurrently(initialSharedClient, [
    alpha.threadId,
    beta.threadId,
  ]);
  await initialSharedClient.request("thread/unsubscribe", {
    threadId: alpha.threadId,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const alphaAfterUnsubscribe = await readEvents(alpha.logFilename);
  const sharedDaemonMcpChildStoppedAfterUnsubscribe =
    alphaAfterUnsubscribe.some((event) => event.event === "stopped");
  if (sharedDaemonMcpChildStoppedAfterUnsubscribe) {
    throw new Error("d2a_expected_retained_shared_mcp_session");
  }
  const callsBeforeRetainedCall = alphaAfterUnsubscribe.filter(
    (event) => event.event === "tool_called",
  ).length;
  assertIdentity(await callIdentity(initialSharedClient, alpha), alpha);
  const alphaAfterRetainedCall = await readEvents(alpha.logFilename);
  const retainedStarted = findSingleStartedEvent(alphaAfterRetainedCall);
  const callsAfterRetainedCall = alphaAfterRetainedCall.filter(
    (event) => event.event === "tool_called",
  ).length;
  const sharedDaemonSameMcpSessionCallableAfterUnsubscribe =
    retainedStarted.pid === alphaStarted.pid &&
    callsAfterRetainedCall === callsBeforeRetainedCall + 1 &&
    !alphaAfterRetainedCall.some((event) => event.event === "stopped");
  if (!sharedDaemonSameMcpSessionCallableAfterUnsubscribe) {
    throw new Error("d2a_retained_shared_mcp_session_not_observed");
  }
  await initialSharedClient.request("thread/unsubscribe", {
    threadId: beta.threadId,
  });
  await closeClient(initialSharedClient);
  await Promise.all([
    waitForStopped(alpha.logFilename),
    waitForStopped(beta.logFilename),
  ]);

  const conversationClient = await startClient();
  const alphaIsolated = {
    catalog: "alpha_isolated",
    token: secret("alpha-isolated-run-1"),
    logFilename: path.join(logs, "alpha-isolated-run-1.jsonl"),
    threadId: alpha.threadId,
  };
  const betaIsolated = {
    catalog: "beta_isolated",
    token: secret("beta-isolated-run-1"),
    logFilename: path.join(logs, "beta-isolated-run-1.jsonl"),
    threadId: beta.threadId,
  };
  const [alphaRunClient, betaRunClient] = await Promise.all([
    startClient(),
    startClient(),
  ]);
  await Promise.all([
    alphaRunClient.request("thread/resume", {
      threadId: alpha.threadId,
      ...resumeConfiguration(alphaIsolated),
    }),
    betaRunClient.request("thread/resume", {
      threadId: beta.threadId,
      ...resumeConfiguration(betaIsolated),
    }),
  ]);
  const [isolatedAlphaIdentity, isolatedBetaIdentity] = await Promise.all([
    callIdentity(alphaRunClient, alphaIsolated),
    callIdentity(betaRunClient, betaIsolated),
  ]);
  assertIdentity(isolatedAlphaIdentity, alphaIsolated);
  assertIdentity(isolatedBetaIdentity, betaIsolated);
  const concurrentlyListed = await conversationClient.request("thread/list", {
    limit: 100,
    sourceKinds: [],
  });
  if (
    !concurrentlyListed.data.some((thread) => thread.id === alpha.threadId) ||
    !concurrentlyListed.data.some((thread) => thread.id === beta.threadId)
  ) {
    throw new Error("d2a_concurrent_native_store_visibility_failed");
  }
  const workspaceCommandDirectEnvironmentExcludedCredential =
    await observeWorkspaceCommandDirectEnvironment(
      alphaRunClient,
      alpha.threadId,
    );
  await closeClient(alphaRunClient);
  await waitForStopped(alphaIsolated.logFilename);
  await closeClient(betaRunClient);
  await waitForStopped(betaIsolated.logFilename);

  const alphaRotated = {
    catalog: "alpha_rotated",
    token: secret("alpha-isolated-run-2"),
    logFilename: path.join(logs, "alpha-isolated-run-2.jsonl"),
    threadId: alpha.threadId,
  };
  const rotatedRunClient = await startClient();
  await rotatedRunClient.request("thread/resume", {
    threadId: alpha.threadId,
    ...resumeConfiguration(alphaRotated),
  });
  assertIdentity(
    await callIdentity(rotatedRunClient, alphaRotated),
    alphaRotated,
  );
  if (
    tokenFingerprint(alphaRotated.token) ===
    isolatedAlphaIdentity.tokenFingerprint
  ) {
    throw new Error("d2a_rotation_reused_credential");
  }
  const fork = {
    catalog: "fork_isolated",
    token: secret("fork-run-1"),
    logFilename: path.join(logs, "fork-run-1.jsonl"),
  };
  const forked = await rotatedRunClient.request("thread/fork", {
    threadId: alpha.threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    threadSource: `sedes_d2a_fork_${randomUUID()}`,
    config: mcpConfiguration(fork),
  });
  fork.threadId = forked.thread.id;
  assertIdentity(await callIdentity(rotatedRunClient, fork), fork);
  await closeClient(rotatedRunClient);
  await Promise.all([
    waitForStopped(alphaRotated.logFilename),
    waitForStopped(fork.logFilename),
  ]);

  await closeClient(conversationClient);
  const restartedConversationClient = await startClient();
  const alphaRestarted = {
    catalog: "alpha_restarted",
    token: secret("alpha-run-after-restart"),
    logFilename: path.join(logs, "alpha-run-after-restart.jsonl"),
    threadId: alpha.threadId,
  };
  const restartedRunClient = await startClient();
  await restartedRunClient.request("thread/resume", {
    threadId: alpha.threadId,
    ...resumeConfiguration(alphaRestarted),
  });
  assertIdentity(
    await callIdentity(restartedRunClient, alphaRestarted),
    alphaRestarted,
  );
  await closeClient(restartedRunClient);
  await waitForStopped(alphaRestarted.logFilename);
  await closeClient(restartedConversationClient);

  await assertSecretsAbsent(temporaryRoot, secrets);
  for (const stderr of stderrCaptures) {
    assertTextHasNoSecrets(stderr, secrets, "app-server stderr");
  }
  for (const body of modelServer.requestBodies) {
    assertTextHasNoSecrets(body, secrets, "model request");
  }

  const evidence = {
    schemaVersion: 1,
    release: pinnedRelease.release,
    nativeExecutableSha256: pinnedRelease.nativeExecutableSha256,
    topologyDecision:
      "principal-scoped shared conversation daemon with no Sedes tools",
    sharedAppServerPidObserved: Number.isSafeInteger(sharedAppServerPid),
    concurrentThreadsObserved: 2,
    distinctPerThreadMcpProcessesObserved: alphaStarted.pid !== betaStarted.pid,
    distinctPerThreadConfiguredSecretsObserved: true,
    distinctPerThreadCatalogsObserved: true,
    providerInjectedThreadIdObserved: true,
    untrustedCallerThreadMetadataOverwritten: true,
    unknownCrossCatalogToolRejected: crossCatalogDenied,
    sharedDaemonMcpChildStoppedAfterUnsubscribe,
    sharedDaemonSameMcpSessionCallableAfterUnsubscribe,
    promptSharedDaemonRunRotationAvailable: false,
    multipleAppServersSameHomeDifferentThreadsObserved: true,
    sameHomeConcurrentMutationSafetyProven: false,
    activeRunAuthorizationProven: false,
    retainedClientRevocationProven: false,
    isolatedProcessThreadConfinementProven: false,
    hardCrashDescendantCleanupProven: false,
    workspaceCommandDirectEnvironmentExcludedCredential,
    sameUidProcessCredentialNonObservabilityProven: false,
    gracefulAppServerCloseProducedMcpStoppedEvent: true,
    freshResumeConfigurationObserved: true,
    freshForkConfigurationObserved: true,
    freshConfigurationAfterAppServerRestartObserved: true,
    staleCredentialRejectionAfterResumeForkReloadRestartProven: false,
    rawSecretsFoundInPostRunTempScan: false,
    decision:
      "C0b keeps one principal/backend shared daemon for normal conversation traffic and exposes no Sedes tools. A later production broker plus native-thread lease and isolated-process RPC confinement must pass active-run authorization, retained-client revocation, hostile same-UID secret inspection, concurrent native-store mutation, hard-crash cleanup, and negative resume/fork/reload/restart tests before T2 may enable Sedes MCP. No process-wide Sedes credential is permitted.",
  };
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.argv.includes("--write-evidence")) {
    await mkdir(path.dirname(evidenceFilename), { recursive: true });
    await writeFile(evidenceFilename, encoded, "utf8");
  }
  console.log(encoded.trimEnd());
} finally {
  for (const activeClient of [...activeClients]) {
    await closeClient(activeClient);
  }
  await modelServer.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function secret(label) {
  const value = `sedes-d2a-${label}-${randomUUID()}`;
  secrets.push(value);
  return value;
}

async function startClient() {
  const next = new RawCodexAppServerClient({
    codexBinary,
    cwd: workspace,
    environment: probeEnvironment(codexHome),
  });
  await next.start();
  activeClients.add(next);
  return next;
}

async function closeClient(activeClient) {
  if (!activeClients.delete(activeClient)) return;
  stderrCaptures.push(activeClient.stderr);
  await activeClient.close();
}

async function startThread(activeClient, catalog, token) {
  const fixture = {
    catalog,
    token,
    logFilename: path.join(logs, `${catalog}-run-1.jsonl`),
  };
  const response = await activeClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    threadSource: `sedes_d2a_${catalog}_${randomUUID()}`,
    config: mcpConfiguration(fixture),
  });
  return { ...fixture, threadId: response.thread.id };
}

function resumeConfiguration(fixture) {
  return {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: mcpConfiguration(fixture),
  };
}

function mcpConfiguration(fixture) {
  return {
    "mcp_servers.sedes": {
      command: process.execPath,
      args: [mcpServer, fixture.logFilename, fixture.catalog],
      env: {
        SEDES_D2A_TOKEN: fixture.token,
      },
      required: true,
      startup_timeout_sec: 10,
      tool_timeout_sec: 10,
    },
  };
}

async function callIdentity(activeClient, fixture) {
  const response = await activeClient.request("mcpServer/tool/call", {
    threadId: fixture.threadId,
    server: "sedes",
    tool: `identity_${fixture.catalog}`,
    arguments: {},
    _meta: { threadId: `untrusted-${randomUUID()}` },
  });
  return response.structuredContent;
}

function assertIdentity(identity, fixture) {
  if (
    identity?.catalog !== fixture.catalog ||
    identity?.tokenFingerprint !== tokenFingerprint(fixture.token) ||
    identity?.threadId !== fixture.threadId
  ) {
    throw new Error("d2a_identity_assertion_failed");
  }
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function materializeConcurrently(activeClient, threadIds) {
  await Promise.all(
    threadIds.map((threadId) =>
      activeClient.request("turn/start", {
        threadId,
        clientUserMessageId: `d2a-materialize-${randomUUID()}`,
        input: [
          {
            type: "text",
            text: "Materialize the D2a fixture.",
            text_elements: [],
          },
        ],
      }),
    ),
  );
  const completed = new Set();
  while (completed.size < threadIds.length) {
    const notification = await activeClient.nextNotification("turn/completed");
    if (threadIds.includes(notification.params.threadId)) {
      completed.add(notification.params.threadId);
    }
  }
}

async function observeWorkspaceCommandDirectEnvironment(
  activeClient,
  threadId,
) {
  const responseId = `environment-${randomUUID()}`;
  modelServer.enqueue([
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "d2a-environment-check",
        name: "shell_command",
        arguments: JSON.stringify({
          command:
            'if [ -n "${SEDES_D2A_TOKEN+x}" ]; then printf leaked; else printf absent; fi',
          timeout_ms: 10_000,
        }),
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]);
  modelServer.enqueue([
    {
      type: "response.created",
      response: { id: `${responseId}-final` },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `${responseId}-message`,
        content: [{ type: "output_text", text: "environment checked" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: `${responseId}-final`,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]);
  await activeClient.request("turn/start", {
    threadId,
    clientUserMessageId: `d2a-environment-${randomUUID()}`,
    input: [
      {
        type: "text",
        text: "Run the deterministic environment isolation fixture.",
        text_elements: [],
      },
    ],
  });
  const completed = await activeClient.nextNotification("turn/completed");
  if (
    completed.params.threadId !== threadId ||
    completed.params.turn.status !== "completed"
  ) {
    throw new Error("d2a_environment_turn_failed");
  }
  const followupBody = modelServer.requestBodies.at(-1);
  return (
    followupBody?.includes("d2a-environment-check") === true &&
    /Output:\\nabsent(?:\\n|")/.test(followupBody)
  );
}

function findSingleStartedEvent(events) {
  const started = events.filter(
    (event) => event.event === "started" && Number.isSafeInteger(event.pid),
  );
  if (started.length !== 1) {
    throw new Error("d2a_expected_one_mcp_started_event");
  }
  return started[0];
}

async function waitForStopped(filename) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const events = await readEvents(filename);
      if (events.some((event) => event.event === "stopped")) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("d2a_stale_mcp_process_remained_open");
}

async function readEvents(filename) {
  const source = await readFile(filename, "utf8");
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertSecretsAbsent(root, forbidden) {
  for (const filename of await listFiles(root)) {
    const contents = await readFile(filename);
    for (const secretValue of forbidden) {
      if (contents.includes(Buffer.from(secretValue, "utf8"))) {
        throw new Error(
          `d2a_secret_persisted:${path.relative(root, filename)}`,
        );
      }
    }
  }
}

function assertTextHasNoSecrets(text, forbidden, label) {
  for (const secretValue of forbidden) {
    if (text.includes(secretValue)) {
      throw new Error(`d2a_secret_in_${label}`);
    }
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(filename)));
    } else if (entry.isFile()) {
      files.push(filename);
    }
  }
  return files;
}
