import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RawCodexAppServerClient,
  probeEnvironment,
} from "./raw-app-server-client.mjs";
import { startMockResponsesServer } from "./mock-responses-server.mjs";
import {
  CODEX_APP_SERVER_RELEASE,
  decodeCodexServerNotificationParams,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  codexThreadListMethod,
  codexThreadReadMethod,
  codexThreadResumeMethod,
  codexThreadTurnsListMethod,
  codexThreadItemsListMethod,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  decodeCodexC2Notification,
  codexModelListMethod,
  codexThreadStartMethod,
  codexTurnStartMethod,
  codexThreadSettingsUpdateMethod,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import { codexThreadForkMethod } from "../../src/server/backends/codex/codex-c4-protocol.js";

import type { CodexRpcMethod } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";

import { CODEX_RUNTIME_TESTED_THROUGH_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import {
  verifyReviewedSchemaDelta,
  type ReviewedSchemaDelta,
} from "./reviewed-schema-delta.js";

type CandidateMetadata = {
  release: string;
  protocolRelease: string;
  platforms: {
    nodePlatform: string;
    nodeArch: string;
    executableSha256: string;
  }[];
};
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const baselineRoot = path.join(
  repositoryRoot,
  `protocol/codex-app-server/${CODEX_APP_SERVER_RELEASE}`,
);
const candidate = process.argv[2];
assert(
  candidate && path.isAbsolute(candidate),
  "Supply the absolute candidate executable path.",
);
const release = process.argv[3] ?? CODEX_RUNTIME_TESTED_THROUGH_RELEASE;
assert(/^\d+\.\d+\.\d+$/.test(release), "Supply a reviewed stable release.");
assert(
  process.argv.length <= 4,
  "Usage: verify:codex-runtime -- /absolute/path/to/codex [release]",
);
const metadata: CandidateMetadata = JSON.parse(
  await readFile(
    path.join(baselineRoot, `runtime-compatibility/${release}.json`),
    "utf8",
  ),
);
assert.equal(metadata.release, release);
assert.equal(metadata.protocolRelease, CODEX_APP_SERVER_RELEASE);
const schemaDelta: ReviewedSchemaDelta = JSON.parse(
  await readFile(
    path.join(
      baselineRoot,
      `runtime-compatibility/${release}-schema-delta.json`,
    ),
    "utf8",
  ),
);
assert.equal(schemaDelta.schemaVersion, 1);
assert.equal(schemaDelta.release, release);
assert.equal(schemaDelta.parserRelease, CODEX_APP_SERVER_RELEASE);
assert.deepEqual(Object.keys(schemaDelta.profiles).sort(), [
  "experimental/json-schema",
  "experimental/typescript",
  "stable/json-schema",
  "stable/typescript",
]);
const platform = metadata.platforms.find(
  (entry) =>
    entry.nodePlatform === process.platform && entry.nodeArch === process.arch,
);
assert(platform, "No reviewed candidate artifact for this platform.");
const sha256 = createHash("sha256")
  .update(await readFile(candidate))
  .digest("hex");
assert.equal(sha256, platform.executableSha256);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "sedes-codex-compatibility-"),
);
const codexHome = path.join(temporaryRoot, "home");
const workspace = path.join(temporaryRoot, "workspace");
const clients: QualificationClient[] = [];
let fixture: Awaited<ReturnType<typeof startMockResponsesServer>> | undefined;
const checkedMethods = new Set<string>();

// The existing bounded transport initializes in stable mode. Override only the
// initialize capability for a second connection; framing and cleanup stay shared.
class QualificationClient extends RawCodexAppServerClient {
  experimental: boolean;
  constructor(experimental: boolean) {
    super({
      codexBinary: candidate,
      cwd: workspace,
      environment: probeEnvironment(codexHome),
    });
    this.experimental = experimental;
  }
  async request(method: string, params: any, timeoutMs?: number) {
    if (method === "initialize")
      params = {
        ...params,
        capabilities: { experimentalApi: this.experimental },
      };
    return super.request(method, params, timeoutMs);
  }
}
async function call<Params, Result>(
  client: QualificationClient,
  codec: CodexRpcMethod<Params, Result>,
  params: Params,
): Promise<Result> {
  const result = codec.decodeResult(
    await client.request(codec.method, codec.encodeParams(params)),
  );
  checkedMethods.add(codec.method);
  return result;
}
async function tree(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of (
    await readdir(path.join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      for (const [name, bytes] of await tree(root, relative))
        result.set(name, bytes);
    else result.set(relative, await readFile(path.join(root, relative)));
  }
  return result;
}
try {
  await Promise.all([mkdir(codexHome), mkdir(workspace)]);
  const environment = probeEnvironment(codexHome);
  assert.equal(
    execFileSync(candidate, ["--version"], {
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    `codex-cli ${metadata.release}`,
  );
  const inventories: Record<string, number> = {};
  for (const profile of ["stable", "experimental"]) {
    for (const [format, command] of [
      ["typescript", "generate-ts"],
      ["json-schema", "generate-json-schema"],
    ]) {
      const output = path.join(temporaryRoot, `${profile}-${format}`);
      await mkdir(output);
      execFileSync(
        candidate,
        [
          "app-server",
          command,
          ...(profile === "experimental" ? ["--experimental"] : []),
          "--out",
          output,
        ],
        { env: environment, stdio: "pipe", timeout: 60_000 },
      );
      const expected = await tree(
        path.join(baselineRoot, "official", profile, format),
      );
      const actual = await tree(output);
      verifyReviewedSchemaDelta(
        expected,
        actual,
        schemaDelta.profiles[`${profile}/${format}`]!,
      );
      inventories[`${profile}/${format}`] = actual.size;
    }
  }
  fixture = await startMockResponsesServer();
  await writeFile(
    path.join(codexHome, "config.toml"),
    `model = "sedes-fixture"\nmodel_provider = "sedes_fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.sedes_fixture]\nname = "Sedes deterministic fixture"\nbase_url = "${fixture.baseUrl}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\n`,
    { mode: 0o600 },
  );
  const stable = new QualificationClient(false);
  clients.push(stable);
  await stable.start();
  await call(stable, codexThreadListMethod, { limit: 1, sourceKinds: [] });
  await assert.rejects(
    stable.request("thread/settings/update", {
      threadId: "00000000-0000-0000-0000-000000000000",
    }),
    (error: any) =>
      error.rpcError?.code === -32600 &&
      error.rpcError.message ===
        "thread/settings/update requires experimentalApi capability",
  );
  await stable.close();
  const client = new QualificationClient(true);
  clients.push(client);
  await client.start();
  const models = await call(client, codexModelListMethod, {
    includeHidden: true,
  });
  const started = await call(client, codexThreadStartMethod, {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    historyMode: "paginated",
  });
  const threadId = started.thread.id;
  const notification = await client.nextNotification("thread/started");
  decodeCodexServerNotificationParams("thread/started", notification.params);
  assert.equal(notification.params.thread.id, threadId);
  await call(client, codexThreadSettingsUpdateMethod, {
    threadId,
    model: "sedes-fixture",
  });
  fixture.enqueue([
    { type: "response.created", response: { id: "qualification-response" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "qualification-message",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "qualification-message",
      delta: "fixture complete",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "qualification-message",
        content: [{ type: "output_text", text: "fixture complete" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "qualification-response",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
  const turn = await call(client, codexTurnStartMethod, {
    threadId,
    input: [
      { type: "text", text: "Return the fixture response.", text_elements: [] },
    ],
  });
  const completed = await client.nextNotification("turn/completed");
  decodeCodexC2Notification("turn/completed", completed.params);
  for (const method of ["item/started", "item/completed"] as const) {
    let assistantSeen = false;
    for (let index = 0; index < 2; index++) {
      const event = await client.nextNotification(method);
      decodeCodexC2Notification(method, event.params);
      assert.equal(event.params.threadId, threadId);
      assistantSeen ||= event.params.item.type === "agentMessage";
    }
    assert(assistantSeen);
  }
  const delta = await client.nextNotification("item/agentMessage/delta");
  decodeCodexC2Notification("item/agentMessage/delta", delta.params);
  assert.equal(delta.params.delta, "fixture complete");
  assert.equal(delta.params.threadId, threadId);
  assert.equal(completed.params.threadId, threadId);
  assert.equal(completed.params.turn.id, turn.turn.id);
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(fixture.requestCount, 1);
  await client.close();
  const resumedClient = new QualificationClient(true);
  clients.push(resumedClient);
  await resumedClient.start();
  const read = await call(resumedClient, codexThreadReadMethod, {
    threadId,
    includeTurns: true,
  });
  assert.equal(read.thread.turns.length, 1);
  assert(
    read.thread.turns[0].items.some(
      (item) =>
        item.type === "agentMessage" && item.text === "fixture complete",
    ),
  );
  const resumed = await call(resumedClient, codexThreadResumeMethod, {
    threadId,
    excludeTurns: true,
  });
  assert.equal(resumed.thread.id, threadId);
  const turns = await call(resumedClient, codexThreadTurnsListMethod, {
    threadId,
    limit: 10,
    itemsView: "notLoaded",
  });
  assert.equal(turns.data.length, 1);
  const items = await call(resumedClient, codexThreadItemsListMethod, {
    threadId,
    turnId: turn.turn.id,
    limit: 10,
  });
  assert(items.data.length > 0);
  const fork = await call(resumedClient, codexThreadForkMethod, { threadId });
  assert.notEqual(fork.thread.id, threadId);
  const forkRead = await call(resumedClient, codexThreadReadMethod, {
    threadId: fork.thread.id,
    includeTurns: true,
  });
  assert.equal(forkRead.thread.turns.length, 1);
  assert(
    forkRead.thread.turns[0].items.some(
      (item) =>
        item.type === "agentMessage" && item.text === "fixture complete",
    ),
  );
  console.log(
    JSON.stringify(
      {
        release: metadata.release,
        parserRelease: CODEX_APP_SERVER_RELEASE,
        platform: `${process.platform}/${process.arch}`,
        executableSha256: sha256,
        reviewedOfficialArtifactInventories: inventories,
        schemaDeltaVerified: true,
        experimentalGateRejected: true,
        notificationsValidated: [
          "thread/started",
          "turn/completed",
          "item/started",
          "item/completed",
          "item/agentMessage/delta",
        ],
        methodsValidated: [...checkedMethods].sort(),
        modelIds: models.data.map((model) => model.id),
        deterministicProviderRequests: fixture.requestCount,
        persistentTurnResumedAfterRestart: true,
        forkHistoryPreserved: true,
        liveProviderVerified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (fixture) await fixture.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
