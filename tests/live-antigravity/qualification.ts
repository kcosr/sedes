import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { AntigravityHost } from "../../src/server/backends/antigravity/host/native-host.js";
import { readAntigravityNativeHistory, removeAntigravityQualificationSession } from "./session-cleanup.js";
import { antigravityNativeActivity } from "../../src/server/backends/antigravity/host/native-activity.js";
import type { AntigravityAttachment, AntigravityEvent, AntigravityHistory, AntigravityIdentity, AntigravityOutcome, AntigravityPort, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";

export function gate() {
  if (process.env.SEDES_RUN_LIVE_ANTIGRAVITY !== "1") throw new Error("LIVE_ANTIGRAVITY_BLOCKER: explicit SEDES_RUN_LIVE_ANTIGRAVITY=1 is required");
  const executablePath = process.env.SEDES_LIVE_ANTIGRAVITY_EXECUTABLE, modelId = process.env.SEDES_LIVE_ANTIGRAVITY_MODEL;
  if (!executablePath || !path.isAbsolute(executablePath) || !modelId) throw new Error("LIVE_ANTIGRAVITY_BLOCKER: select an absolute stock executable and explicit model with SEDES_LIVE_ANTIGRAVITY_EXECUTABLE/MODEL");
  const geminiDirectory = process.env.SEDES_LIVE_ANTIGRAVITY_GEMINI_DIRECTORY ?? path.join(homedir(), ".gemini");
  if (!path.isAbsolute(geminiDirectory)) throw new Error("LIVE_ANTIGRAVITY_BLOCKER: native Gemini directory must be absolute");
  return { executablePath, modelId, geminiDirectory, thinkingLevel: process.env.SEDES_LIVE_ANTIGRAVITY_THINKING_LEVEL ?? "low" };
}
export async function localFixture() {
  const selected = gate(); const directory = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-live-antigravity-")));
  const cwd = path.join(directory, "workspace"); await mkdir(cwd, { mode: 0o700 });
  const configuration: AntigravityRuntimeConfiguration = { tenantId: randomUUID(), principalId: randomUUID(), backendInstanceId: randomUUID(), executionEnvironmentId: randomUUID(),
    executablePath: selected.executablePath, geminiDirectory: selected.geminiDirectory, initializationTimeoutMs: 30_000 };
  const channels = new LocalEnvironmentChannelProvider({ scope: configuration, executionEnvironmentId: configuration.executionEnvironmentId, environment: process.env });
  const host = new AntigravityHost({ configuration, channels, environment: process.env, readHistory: (identity, signal) => readAntigravityNativeHistory(configuration, identity, signal), observationWaitMs: 50 });
  let identity: AntigravityIdentity | undefined;
  try {
    const created = await newSession(host, cwd, value => { identity = value; });
    return { directory, cwd, configuration, host, ...created, async close() {
      // Only verified native history created by this fixture is eligible for
      // cleanup, and only after owned process cleanup is positively proven.
      await host.stop({ expectedRevision: host.snapshot().revision, force: true }); channels.close();
      if (identity) await removeAntigravityQualificationSession(configuration, identity, directory);
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) { await host.stop({ expectedRevision: host.snapshot().revision, force: true }); channels.close(); if (identity) await removeAntigravityQualificationSession(configuration, identity, directory); await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function newSession(port: AntigravityPort, cwd: string, created?: (identity: AntigravityIdentity) => void) {
  const selected = gate(); const operationId = randomUUID(); const identity = await port.create({ cwd, operationId });
  created?.(identity);
  const attachment = await port.attach(identity); expect(attachment.createdByOperationId).toBe(operationId);
  await port.acknowledgeCreation({ ...identity, operationId });
  const model = select(attachment, "model");
  expect(flatten(model.options).map(option => option.value)).toContain(selected.modelId);
  const modelResult = await command(port, attachment.handleId, { type: "set_config", configId: model.id, value: selected.modelId });
  const configs = (modelResult as { configOptions: AntigravityAttachment["setup"]["session"]["configOptions"] }).configOptions;
  const thinking = configs?.filter(option => option.category === "thought_level");
  if (thinking?.length) {
    if (thinking.length !== 1 || thinking[0]!.type !== "select") throw new Error("LIVE_ANTIGRAVITY_BLOCKER: invalid native thinking selector");
    expect(flatten(thinking[0]!.options).map(option => option.value)).toContain(selected.thinkingLevel);
    await command(port, attachment.handleId, { type: "set_config", configId: thinking[0]!.id, value: selected.thinkingLevel });
  }
  return { identity, attachment };
}
function select(attachment: AntigravityAttachment, category: string) {
  const options = attachment.setup.session.configOptions?.filter(option => option.category === category);
  if (options?.length !== 1 || options[0]!.type !== "select") throw new Error("LIVE_ANTIGRAVITY_BLOCKER: native selector unavailable"); return options[0]!;
}
function flatten(options: ReturnType<typeof select>["options"]) { return options.flatMap(option => "value" in option ? [option] : option.options); }
export async function command(port: AntigravityPort, handleId: string, input: Parameters<AntigravityPort["request"]>[0]["command"]) {
  const operationId = randomUUID(); await port.request({ handleId, operationId, command: input });
  const outcome = await waitOutcome(port, handleId, operationId);
  if (outcome.status !== "completed") throw new Error(`LIVE_ANTIGRAVITY_BLOCKER: ${JSON.stringify(outcome)}`);
  await port.acknowledgeOperation({ handleId, operationId }); return outcome.result;
}
export async function waitOutcome(port: AntigravityPort, handleId: string, operationId: string): Promise<AntigravityOutcome> {
  const end = performance.now() + 90_000;
  while (performance.now() < end) { const outcome = await port.outcome({ handleId, operationId }); if (outcome.status !== "pending") return outcome; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("LIVE_ANTIGRAVITY_BLOCKER: bounded native outcome deadline");
}
export function observer(port: AntigravityPort, attachment: AntigravityAttachment, approvedCommands: ReadonlySet<string> = new Set()) {
  let afterSequence = attachment.retainedAfterSequence; const events: AntigravityEvent[] = [];
  return { events, async poll() {
    const value = await port.observe({ handleId: attachment.handleId, afterSequence }); expect(value.retainedAfterSequence).toBeLessThanOrEqual(afterSequence);
    events.push(...value.events); afterSequence = value.throughSequence;
    for (const event of value.events) if (event.kind === "permission") {
      const raw = event.request.toolCall.rawInput as { CommandLine?: unknown } | undefined;
      const approved = raw && typeof raw.CommandLine === "string" && approvedCommands.has(raw.CommandLine);
      const option = approved ? event.request.options.find(option => option.kind === "allow_once") : undefined;
      await command(port, attachment.handleId, { type: "permission", requestId: event.requestId,
        response: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
      if (!option) throw new Error("LIVE_ANTIGRAVITY_BLOCKER: unexpected permission outside the bounded approved fixture");
    }
    await port.acknowledge({ handleId: attachment.handleId, throughSequence: afterSequence }); return value;
  } };
}
export async function untilNative(port: AntigravityPort, identity: AntigravityIdentity, observe: ReturnType<typeof observer>, predicate: (history: AntigravityHistory) => boolean) {
  const end = performance.now() + 90_000; let last: AntigravityHistory | undefined;
  while (performance.now() < end) { await observe.poll(); const history = last = await port.readHistory(identity); if (predicate(history)) return history; await new Promise(resolve => setTimeout(resolve, 50)); }
  const diagnostic = last?.native.steps.map(step => ({ index: step.index, type: step.type, status: step.status, subagents: step.subagents, task: step.task?.id, continuation: step.continuation && { kind: step.continuation.kind, sender: step.continuation.sender, recipient: step.continuation.recipient }, tool: step.tool?.name }));
  throw new Error(`LIVE_ANTIGRAVITY_BLOCKER: bounded native history deadline ${JSON.stringify({ activity: last && antigravityNativeActivity(last.native), steps: diagnostic })}`);
}
export const quiescent = (history: AntigravityHistory) => { const activity = antigravityNativeActivity(history.native); return !activity.active && !activity.unknown; };
