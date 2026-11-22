#!/usr/bin/env node
import readline from "node:readline";
import { randomUUID } from "node:crypto";

let sessionId;
let pendingPrompt;
let permissionPrompt;
let permissionRequestId;
let queuedSteer;
let history;
let currentModel = "fixture-model";
let thinking = "low";
let mode = "default";
const geminiFlag = process.argv.indexOf("--gemini-dir");
const geminiDirectory = geminiFlag >= 0 ? process.argv[geminiFlag + 1] : undefined;
const openHistory = geminiDirectory ? (await import("./native-history-fixture.mjs")).openFixtureHistory : undefined;

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const update = value => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })}\n`);
function configOptions() {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel,
      options: [{ value: "fixture-model", name: "Fixture Model" }, { value: "fixture-alt", name: "Fixture Alternate" }] },
    { id: "thought_level", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: thinking,
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "xhigh" }] },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode,
      options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ];
}
const setup = () => ({ configOptions: configOptions(), modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } });
function stream(text) { update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); }
function finish(prompt, content, stopReason = "end_turn") {
  if (prompt.index !== undefined) history.response(prompt.index, content, stopReason === "cancelled" ? 16 : 2);
  reply(prompt.id, { stopReason });
}
function requestPermission() {
  permissionRequestId = randomUUID();
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: permissionRequestId, method: "session/request_permission", params: {
    sessionId, toolCall: { toolCallId: `tool-${permissionRequestId}`, title: "Read file", status: "pending" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
  } })}\n`);
}

try {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (!message.method) {
      if (message.id === permissionRequestId && permissionPrompt) {
        if (queuedSteer && message.result?.outcome?.optionId !== "allow") {
          // Native cancellation can end at the denied tool with no final
          // assistant response. The queued steer was never consumed.
          if (permissionPrompt.index !== undefined) history.cancelAtPermission(permissionPrompt.index);
          reply(permissionPrompt.id, { stopReason: "cancelled" });
          reply(queuedSteer.id, { stopReason: "cancelled" });
          permissionPrompt = undefined;
          queuedSteer = undefined;
          continue;
        }
        const text = `Permission ${message.result?.outcome?.optionId === "allow" ? "allowed" : "declined"}.`;
        stream(text);
        finish(permissionPrompt, text);
        permissionPrompt = undefined;
        if (queuedSteer) {
          finish({ id: queuedSteer.id, index: history?.begin(queuedSteer.stored) }, "Queued steer consumed.");
          queuedSteer = undefined;
        }
      }
      continue;
    }
    switch (message.method) {
      case "initialize": reply(message.id, { protocolVersion: 1, agentInfo: { name: "antigravity", version: process.env.AGY_FIXTURE_VERSION ?? "1.5.14" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} }, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [] }); break;
      case "session/new":
        sessionId = randomUUID();
        history?.close();
        history = openHistory?.(geminiDirectory, sessionId, message.params.cwd);
        reply(message.id, { sessionId, ...setup() });
        break;
      case "session/load":
        sessionId = message.params.sessionId;
        history?.close();
        history = openHistory?.(geminiDirectory, sessionId, message.params.cwd);
        reply(message.id, setup());
        break;
      case "session/list": reply(message.id, { sessions: [] }); break;
      case "session/set_config_option": {
        const { configId, value } = message.params;
        if (configId === "model") { currentModel = value; thinking = "low"; }
        if (configId === "thought_level") thinking = value;
        if (configId === "mode") mode = value;
        reply(message.id, { configOptions: configOptions() }); break;
      }
      case "session/set_mode": mode = message.params.modeId; reply(message.id, {}); break;
      case "session/prompt": {
        const stored = message.params.prompt.find(block => block.type === "text")?.text ?? "";
        // Persist the exact ACP text so main must authenticate its correlation.
        const userText = stored.startsWith("<sedes-antigravity-") ? stored.slice(stored.indexOf(">\n") + 2) : stored;
        if (userText === "steer into permission" && pendingPrompt?.permissionAfterSteer) {
          queuedSteer = { id: message.id, stored };
          permissionPrompt = pendingPrompt;
          pendingPrompt = undefined;
          requestPermission();
          break;
        }
        const prompt = { id: message.id, index: history?.begin(stored) };
        if (userText === "permission") {
          permissionPrompt = prompt;
          requestPermission(); break;
        }
        if (userText === "wait" || userText === "permission after steer") {
          pendingPrompt = { ...prompt, permissionAfterSteer: userText === "permission after steer" };
          const text = userText === "wait" ? `Streaming ${currentModel} at ${thinking} effort in ${mode} mode.` : "Waiting for a steer before requesting permission.";
          if (prompt.index !== undefined) history.response(prompt.index, text);
          stream(text);
          break;
        }
        if (userText === "background") {
          update({ sessionUpdate: "tool_call", toolCallId: "command-background", kind: "execute", title: "Command", status: "in_progress" });
          finish(prompt, "Background command started.");
          setTimeout(() => {
            update({ sessionUpdate: "tool_call_update", toolCallId: "command-background", status: "completed" });
            stream("Background command finished.");
          }, 100); break;
        }
        stream("Fixture response.");
        finish(prompt, "Fixture response.");
        break;
      }
      case "session/cancel":
        if (pendingPrompt) {
          finish(pendingPrompt, `Streaming ${currentModel} at ${thinking} effort in ${mode} mode.`, "cancelled");
          pendingPrompt = undefined;
        }
        break;
      default:
        if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } })}\n`);
    }
  }
} finally {
  history?.close();
}
