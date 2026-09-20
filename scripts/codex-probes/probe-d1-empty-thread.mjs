import { randomUUID } from "node:crypto";
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
  "d1-empty-thread.json",
);
const v2SchemaFilename = path.join(
  releaseRoot,
  "generated",
  "json-schema",
  "codex_app_server_protocol.v2.schemas.json",
);
const pinnedRelease = assertPinnedCodexRelease();
const allThreadSourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "sedes-codex-d1-probe-"),
);
const codexHome = path.join(temporaryRoot, "codex-home");
const workspace = path.join(temporaryRoot, "workspace");
await Promise.all([
  mkdir(codexHome, { recursive: true }),
  mkdir(workspace, { recursive: true }),
]);
const modelServer = await startMockResponsesServer();
const threadStartProperties = await readThreadStartProperties();
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

try {
  const confirmed = await createEmptyThread("confirmed");
  await assertNoDurableThread([confirmed.threadId, confirmed.threadSource]);

  const responseBeforeBindingCrash = await createEmptyThread(
    "response-before-binding-crash",
    "SIGKILL",
  );
  await assertNoDurableThread([
    responseBeforeBindingCrash.threadId,
    responseBeforeBindingCrash.threadSource,
  ]);

  const acceptedSource = `sedes_creation_accepted_${randomUUID()}`;
  const acceptedClient = await startClient({
    withholdResponseMethods: ["thread/start"],
  });
  const pending = acceptedClient.request(
    "thread/start",
    startParams(acceptedSource),
  );
  const captured = await acceptedClient.nextCapturedResponse("thread/start");
  if (
    captured?.message?.result?.thread?.id === undefined ||
    captured.message.result.thread.threadSource !== acceptedSource
  ) {
    throw new Error("d1_accepted_start_response_not_captured");
  }
  await acceptedClient.terminate("SIGKILL");
  const callerOutcome = await pending.then(
    () => "response_observed",
    () => "response_unknown",
  );
  await acceptedClient.close();
  if (callerOutcome !== "response_unknown") {
    throw new Error("d1_accepted_start_response_reached_caller");
  }
  await assertNoDurableThread([
    acceptedSource,
    captured.message.result.thread.id,
  ]);

  const materialized = await createBoundAndMaterializedThread();

  const evidence = {
    schemaVersion: 2,
    release: pinnedRelease.release,
    nativeExecutableSha256: pinnedRelease.nativeExecutableSha256,
    creationIdempotencyKey: Object.hasOwn(
      threadStartProperties,
      "idempotencyKey",
    ),
    clientAssignedThreadId: Object.hasOwn(threadStartProperties, "threadId"),
    responseAndNotificationCorrelated: true,
    confirmedEmptyStartDurableAfterRestart: false,
    crashAfterResponseBeforeBindingDurableAfterRestart: false,
    acceptedStartResponseCapturedBeforeCrash: true,
    acceptedStartResponseWithheldFromCaller: true,
    acceptedStartCallerOutcomeAfterCrash: callerOutcome,
    acceptedStartDurableAfterRestart: false,
    fixtureBindingRecordWrittenBeforeFirstTurn: true,
    materializedThreadDurableAfterRestart: materialized,
    candidateCreationSequence:
      "persist Sedes intent; start once; correlate within generation; persist binding; only then start first turn; invalidate generation and never retry on uncertainty",
    gateDisposition:
      "requires explicit user approval of empty-orphan risk or import-only creation before C3",
  };
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.argv.includes("--write-evidence")) {
    await mkdir(path.dirname(evidenceFilename), { recursive: true });
    await writeFile(evidenceFilename, encoded, "utf8");
  }
  console.log(encoded.trimEnd());
} finally {
  await modelServer.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function readThreadStartProperties() {
  const schemas = JSON.parse(await readFile(v2SchemaFilename, "utf8"));
  const properties = schemas?.definitions?.ThreadStartParams?.properties;
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    throw new Error("d1_thread_start_schema_properties_missing");
  }
  return properties;
}

async function createEmptyThread(label, crashSignal) {
  const client = await startClient();
  const threadSource = `sedes_creation_${label}_${randomUUID()}`;
  try {
    const response = await client.request(
      "thread/start",
      startParams(threadSource),
    );
    const notification = await client.nextNotification("thread/started");
    if (
      typeof response?.thread?.id !== "string" ||
      response.thread.id !== notification?.params?.thread?.id ||
      response.thread.threadSource !== threadSource ||
      notification.params.thread.threadSource !== threadSource
    ) {
      throw new Error("d1_thread_start_correlation_failed");
    }
    if (crashSignal) {
      await client.terminate(crashSignal);
    }
    return { threadId: response.thread.id, threadSource };
  } finally {
    await client.close();
  }
}

function startParams(threadSource) {
  return {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    threadSource,
  };
}

async function startClient(faultInjection) {
  const client = new RawCodexAppServerClient({
    codexBinary,
    cwd: workspace,
    environment: probeEnvironment(codexHome),
    faultInjection,
  });
  await client.start();
  return client;
}

async function createBoundAndMaterializedThread() {
  const client = await startClient();
  const threadSource = `sedes_creation_bound_${randomUUID()}`;
  const clientUserMessageId = `sedes-message-${randomUUID()}`;
  let threadId;
  try {
    const response = await client.request(
      "thread/start",
      startParams(threadSource),
    );
    threadId = response.thread.id;
    await client.nextNotification("thread/started");
    await writeFile(
      path.join(temporaryRoot, "committed-sedes-binding.json"),
      `${JSON.stringify({ threadId })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await client.request("turn/start", {
      threadId,
      clientUserMessageId,
      input: [
        {
          type: "text",
          text: "Materialize this bound fixture thread.",
          text_elements: [],
        },
      ],
    });
    const completed = await client.nextNotification("turn/completed");
    if (
      completed?.params?.threadId !== threadId ||
      completed?.params?.turn?.status !== "completed"
    ) {
      throw new Error("d1_first_turn_did_not_complete");
    }
  } finally {
    await client.close();
  }

  const restarted = await startClient();
  try {
    const listed = await restarted.request("thread/list", {
      limit: 100,
      sourceKinds: allThreadSourceKinds,
    });
    const match = listed?.data?.find((thread) => thread.id === threadId);
    if (!match) {
      throw new Error("d1_bound_first_turn_not_listed_after_restart");
    }
    const read = await restarted.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    if (
      read?.thread?.id !== threadId ||
      read.thread.threadSource !== threadSource ||
      read.thread.turns?.length !== 1 ||
      read.thread.turns[0]?.status !== "completed"
    ) {
      throw new Error("d1_bound_first_turn_not_readable_after_restart");
    }
    return true;
  } finally {
    await restarted.close();
  }
}

async function assertNoDurableThread(forbiddenValues) {
  const client = await startClient();
  try {
    const listed = await client.request("thread/list", {
      limit: 100,
      sourceKinds: allThreadSourceKinds,
    });
    if (!Array.isArray(listed?.data) || listed.data.length !== 0) {
      throw new Error("d1_empty_thread_was_listed_after_restart");
    }
  } finally {
    await client.close();
  }
  const files = await listFiles(codexHome);
  for (const filename of files) {
    const contents = await readFile(filename);
    for (const forbidden of forbiddenValues) {
      if (contents.includes(Buffer.from(forbidden, "utf8"))) {
        throw new Error(
          `d1_empty_thread_identifier_persisted:${path.relative(codexHome, filename)}`,
        );
      }
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
