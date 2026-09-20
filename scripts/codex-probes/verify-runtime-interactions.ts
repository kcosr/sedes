import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
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
  decodeCodexServerRequestParams,
  encodeCodexServerRequestResult,
  decodeCodexServerNotificationParams,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  codexThreadStartMethod,
  codexTurnStartMethod,
} from "../../src/server/backends/codex/codex-c2-protocol.js";

import { CODEX_RUNTIME_TESTED_THROUGH_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";

const candidate = process.argv[2];
const release = process.argv[3] ?? CODEX_RUNTIME_TESTED_THROUGH_RELEASE;
assert(
  candidate && path.isAbsolute(candidate),
  "Supply the absolute candidate executable path.",
);
assert(/^\d+\.\d+\.\d+$/.test(release));
const metadata = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL(
        `../../protocol/codex-app-server/${CODEX_APP_SERVER_RELEASE}/runtime-compatibility/${release}.json`,
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);
assert.equal(metadata.release, release);
assert.equal(metadata.protocolRelease, CODEX_APP_SERVER_RELEASE);
const platform = metadata.platforms.find(
  (entry: { nodePlatform: string; nodeArch: string }) =>
    entry.nodePlatform === process.platform && entry.nodeArch === process.arch,
);
assert(platform);
const sha256 = createHash("sha256")
  .update(await readFile(candidate))
  .digest("hex");
assert.equal(sha256, platform.executableSha256);
const root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-interactions-"));
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const marker = path.join(workspace, "command-must-not-run");
let fixture: Awaited<ReturnType<typeof startMockResponsesServer>> | undefined;
let client: RawCodexAppServerClient | undefined;
let approvals = 0;
let threadId: string;
try {
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const environment = probeEnvironment(home);
  assert.equal(
    execFileSync(candidate, ["--version"], {
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    `codex-cli ${release}`,
  );
  fixture = await startMockResponsesServer();
  await writeFile(
    path.join(home, "config.toml"),
    `model = "sedes-fixture"\nmodel_provider = "sedes_fixture"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.sedes_fixture]\nname = "Sedes deterministic fixture"\nbase_url = "${fixture.baseUrl}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\n`,
    { mode: 0o600 },
  );
  client = new RawCodexAppServerClient({
    codexBinary: candidate,
    cwd: workspace,
    environment,
    serverRequestHandler: (request: { method: string; params: unknown }) => {
      const method = "item/commandExecution/requestApproval";
      assert.equal(request.method, method);
      const params = decodeCodexServerRequestParams(method, request.params);
      assert.equal(params.threadId, threadId);
      assert.equal(params.cwd, workspace);
      assert(params.command?.includes("command-must-not-run"));
      approvals++;
      return encodeCodexServerRequestResult(method, { decision: "decline" });
    },
  });
  await client.start();
  const started = codexThreadStartMethod.decodeResult(
    await client.request(
      codexThreadStartMethod.method,
      codexThreadStartMethod.encodeParams({
        cwd: workspace,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ephemeral: true,
      }),
    ),
  );
  threadId = started.thread.id;
  // Decline the escalation before execution so no sandbox implementation or
  // external service is required, and verify the model receives the rejection.
  fixture.enqueue([
    { type: "response.created", response: { id: "approval-response" } },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "approval-command",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "touch command-must-not-run",
          sandbox_permissions: "require_escalated",
          justification: "Deterministic approval rejection probe",
          yield_time_ms: 1000,
        }),
      },
    },
    {
      type: "response.completed",
      response: {
        id: "approval-response",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
  await client.request(
    codexTurnStartMethod.method,
    codexTurnStartMethod.encodeParams({
      threadId,
      input: [
        {
          type: "text",
          text: "Exercise the deterministic approval fixture.",
          text_elements: [],
        },
      ],
    }),
  );
  const completed = await client.nextNotification("turn/completed", 30_000);
  decodeCodexServerNotificationParams("turn/completed", completed.params);
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(approvals, 1);
  assert.equal(fixture.requestCount, 2);
  await assert.rejects(access(marker), { code: "ENOENT" });
  const followup = JSON.parse(fixture.requestBodies[1]);
  assert(
    followup.input.some(
      (item: { type: string; call_id?: string; output?: string }) =>
        item.type === "function_call_output" &&
        item.call_id === "approval-command" &&
        item.output?.includes("rejected"),
    ),
    "Provider must observe the declined command.",
  );
  console.log(
    JSON.stringify(
      {
        release,
        parserRelease: CODEX_APP_SERVER_RELEASE,
        platform: `${process.platform}/${process.arch}`,
        executableSha256: sha256,
        commandApprovalDecoded: true,
        declineEncoded: true,
        declinedCommandNotExecuted: true,
        deterministicProviderRequests: fixture.requestCount,
        liveProviderVerified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
