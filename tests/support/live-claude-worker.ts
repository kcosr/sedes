import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { installClaudeWorkerBundle } from "../../src/server/backends/claude/worker/claude-sidecar-worker-artifact.js";
import { LIVE_CLAUDE_MODEL } from "./live-claude-model.js";

/** Decorate the real facade solely for the live suite's pre-existing safety
 * contract. All worker ownership, supervision, stdio, and artifact admission
 * code remains production code; no provider messages are fabricated. */
export async function buildToolDisabledWorker(root: string, auditPath: string) {
  const buildId = "real-claude-persistent";
  const filename = "sedes-claude-runtime-worker.mjs";
  const result = await build({
    entryPoints: [path.resolve("src/server/backends/claude/worker/claude-runtime-worker-main.ts")],
    outfile: path.join(root, filename), bundle: true, platform: "node", format: "esm",
    target: "node24", packages: "bundle", write: false, legalComments: "none",
    define: { __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: JSON.stringify(buildId) },
    plugins: [{ name: "real-provider-tools-disabled", setup(builder) {
      builder.onLoad({ filter: /[/\\]tracked-claude-sdk-facade\.ts$/ }, async args => ({
        loader: "ts", resolveDir: path.dirname(args.path),
        contents: `${await readFile(args.path, "utf8")}
import { appendFileSync as appendLiveAudit } from "node:fs";
const liveAudit = entry => appendLiveAudit(${JSON.stringify(auditPath)}, JSON.stringify(entry) + "\\n", { mode: 0o600 });
const originalLiveAuth = TrackedClaudeSdkFacade.prototype.readCliAuthStatus;
TrackedClaudeSdkFacade.prototype.readCliAuthStatus = async function (...args) {
  const status = await originalLiveAuth.apply(this, args);
  const authVerified = status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty" && !!status.subscriptionType && status.apiKeySource === undefined;
  if (!authVerified) throw new Error("REAL_CLAUDE_BLOCKER: subscription authentication required");
  liveAudit({ authVerified });
  return status;
};
`,
      }));
      builder.onLoad({ filter: /[/\\]claude-sdk-facade\.ts$/ }, async args => ({
        loader: "ts", resolveDir: path.dirname(args.path),
        contents: `${await readFile(args.path, "utf8")}
import { appendFileSync as appendLiveAudit } from "node:fs";
const liveAudit = entry => appendLiveAudit(${JSON.stringify(auditPath)}, JSON.stringify(entry) + "\\n", { mode: 0o600 });
import { createLiveClaudeQuery } from ${JSON.stringify(path.resolve("tests/support/live-claude-model.ts"))};
const originalLiveQuery = OfficialClaudeSdkFacade.prototype.createQuery;
OfficialClaudeSdkFacade.prototype.createQuery = function (input) {
  const options = { ...input.options, tools: [], strictMcpConfig: true, mcpServers: {} };
  const fork = options.forkSession === true;
  // A fork launch runs locked down in default mode with a deny-all callback.
  const lockedDown = fork && Array.isArray(options.settingSources) && options.settingSources.length === 0 &&
    options.settings?.disableAllHooks === true && typeof options.canUseTool === "function" && !options.allowDangerouslySkipPermissions;
  if (options.persistSession !== false && (options.model !== ${JSON.stringify(LIVE_CLAUDE_MODEL)} || options.effort !== "low" ||
      options.permissionMode !== (fork ? "default" : "dontAsk") || (fork && !lockedDown))) {
    throw new Error("REAL_CLAUDE_BLOCKER: Haiku 5.5 low dontAsk (or a locked-down default fork launch) required");
  }
  liveAudit({ persistent: options.persistSession !== false, pid: process.pid, model: options.model, effort: options.effort, permissionMode: options.permissionMode, toolsDisabled: true, ...(fork ? { fork, lockedDown } : {}) });
  const nativeQuery = createLiveClaudeQuery({ ...input, options }, guarded => originalLiveQuery.call(this, guarded));
  const nativeIterator = nativeQuery[Symbol.asyncIterator].bind(nativeQuery);
  nativeQuery[Symbol.asyncIterator] = async function* () {
    for await (const message of { [Symbol.asyncIterator]: nativeIterator }) {
      if (message.type !== "stream_event" || ["message_start", "message_stop"].includes(message.event?.type)) {
        const frame = { type: message.type, at: Date.now() };
        if (message.subtype) frame.subtype = message.subtype;
        if (message.type === "stream_event") frame.event = message.event.type;
        if (message.type === "command_lifecycle") { frame.commandUuid = message.command_uuid; frame.state = message.state; }
        if (message.type === "system" && message.subtype === "session_state_changed") frame.state = message.state;
        if (message.type === "system" && message.subtype === "background_tasks_changed") frame.taskCount = message.tasks?.length;
        if (message.type === "result") { frame.numTurns = message.num_turns; frame.isError = message.is_error; frame.terminalReason = message.terminal_reason; }
        if (message.user_message_uuid) frame.inputUuid = message.user_message_uuid;
        if (message.user_message_uuids) frame.inputUuids = message.user_message_uuids;
        liveAudit({ frame });
      }
      yield message;
    }
  };
  return nativeQuery;
};`,
      }));
    } }],
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error("real_claude_worker_build_missing");
  return installClaudeWorkerBundle(root, { source, manifest: JSON.stringify({
    schemaVersion: 1, artifactId: "openai.sedes.claude-runtime-worker", filename,
    modes: ["claude_runtime"], sha256: createHash("sha256").update(source).digest("hex"),
    bytes: Buffer.byteLength(source), buildId, minimumNodeVersion: "24.18.0",
  }) });
}
