// Explicitly gated live provider probe. Uses a disposable native store and
// emits only accounting/lifecycle evidence, never credentials or message text.
import assert from "node:assert/strict";
import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RawCodexAppServerClient } from "./raw-app-server-client.mjs";
import { assertPinnedCodexRelease, codexBinary } from "./pinned-codex-release.mjs";

if (process.env.SEDES_REAL_CODEX_SUBAGENTS !== "1") {
  throw new Error("Set SEDES_REAL_CODEX_SUBAGENTS=1 to authorize live provider calls.");
}
const release = assertPinnedCodexRelease();
const root = await mkdtemp(path.join(os.tmpdir(), "sedes-child-usage-"));
const home = path.join(root, "codex");
const workspace = path.join(root, "workspace");
let client;
try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace);
  await copyFile(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json"), path.join(home, "auth.json"));
  await chmod(path.join(home, "auth.json"), 0o600);
  await writeFile(path.join(home, "config.toml"), '[features]\nmulti_agent = true\napps = false\nplugins = false\n', { mode: 0o600 });
  client = new RawCodexAppServerClient({ codexBinary, cwd: workspace,
    environment: { ...process.env, CODEX_HOME: home } });
  await client.start();
  const model = "gpt-5.6-luna";
  const catalog = await client.request("model/list", { limit: 100, includeHidden: true });
  assert(catalog.data.some(entry => entry.id === model && entry.supportedReasoningEfforts.some(e => e.reasoningEffort === "low")));
  const started = await client.request("thread/start", {
    model, cwd: workspace, sandbox: "read-only", approvalPolicy: "never", ephemeral: false,
  });
  const parentId = started.thread.id;
  await client.request("turn/start", {
    threadId: parentId, model, effort: "low", approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    input: [{ type: "text", text: "This is an authorized subagent accounting test. You must use spawn_agent exactly once to delegate this task: 'Reply with the word READY. Do not use tools.' Use gpt-5.6-luna with low reasoning if selectable. Wait for the child to finish, then reply DONE. Do not use shell, filesystem, network, or any other tools except agent spawning and waiting.", text_elements: [] }],
  });
  const deadline = Date.now() + 90_000;
  let child;
  while (Date.now() < deadline) {
    const event = await client.nextNotification("item/completed", Math.max(1, deadline - Date.now()));
    const item = event.params.item;
    if (event.params.threadId === parentId && item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && item.status === "completed") {
      assert.equal(item.receiverThreadIds.length, 1);
      child = { id: item.receiverThreadIds[0], parentThreadId: item.senderThreadId, model: item.model }; break;
    }
  }
  assert(child, "The provider must spawn a child thread.");
  const completed = new Set();
  while (!completed.has(parentId) || !completed.has(child.id)) {
    const event = await client.nextNotification("turn/completed", Math.max(1, deadline - Date.now()));
    assert.equal(event.params.turn.status, "completed");
    completed.add(event.params.threadId);
  }
  const usage = [];
  for (;;) {
    try {
      const event = await client.nextNotification("thread/tokenUsage/updated", 300);
      usage.push(event.params);
    } catch (error) {
      if (!String(error).includes("notification_timeout")) throw error;
      break;
    }
  }
  assert(usage.some(event => event.threadId === child.id && event.tokenUsage.total.totalTokens > 0));
  assert(usage.some(event => event.threadId === parentId && event.tokenUsage.total.totalTokens > 0));
  console.log(JSON.stringify({ release: release.release, explicitChildSubscriptions: 0, parentThreadId: parentId,
    child, usage }, null, 2));
} catch (error) {
  // Only inspect our own disposable test reply when delegation did not occur.
  for (const method of ["turn/completed", "error", "item/completed"]) {
    for (let index = 0; index < 20; index++) {
      try {
        const event = await client?.nextNotification(method, 100);
        if (!event) break;
        const { threadId, turn, item, error: failure } = event.params;
        console.error(JSON.stringify({ method, threadId, status: turn?.status, error: failure ?? turn?.error,
          item: item && { type: item.type, tool: item.tool, text: item.type === "agentMessage" ? item.text?.slice(0, 1500) : undefined } }));
      } catch { break; }
    }
  }
  throw error;
} finally {
  await client?.close();
  await rm(root, { recursive: true, force: true });
}
