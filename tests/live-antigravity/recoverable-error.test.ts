import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { projectAntigravityHistory } from "../../src/server/backends/antigravity/history.js";
import type { AntigravityAttachment, AntigravityIdentity, AntigravityPort, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";
import { buildAntigravityPrompt, type AntigravitySubmissionScope } from "../../src/server/backends/antigravity/submission.js";
import { localFixture, newSession, observer, quiescent, readPortHistory, untilNative, waitOutcome } from "./qualification.js";
import { sshFixture } from "./ssh-fixture.js";

async function qualifiesRecoverableRead(input: {
  port: AntigravityPort;
  cwd: string;
  configuration: AntigravityRuntimeConfiguration;
  identity: AntigravityIdentity;
  attachment: AntigravityAttachment;
}) {
  const { port, cwd, configuration, identity, attachment } = input;
  const operationId = randomUUID(), expected = `SEDES_RECOVERED_${randomUUID()}`;
  const missingPath = path.join(cwd, `missing-${randomUUID()}.txt`), readablePath = path.join(cwd, "recovery-marker.txt");
  await writeFile(readablePath, `${expected}\n`, { flag: "wx", mode: 0o600 });
  const scope: AntigravitySubmissionScope = { key: randomBytes(32), binding: {
    version: 1, sessionId: identity.sessionId, canonicalWorkspacePath: cwd,
    tenantId: configuration.tenantId, principalId: configuration.principalId,
    backendInstanceId: configuration.backendInstanceId, executionEnvironmentId: configuration.executionEnvironmentId,
    connectionProfileId: "live-recoverable-error", nativeNamespaceKey: "live-recoverable-error",
  } };
  const prompt = await buildAntigravityPrompt(scope, {
    applicationOperationId: operationId, mutationId: operationId, reconciliationToken: randomUUID(), source: { kind: "user" },
    text: `This is a bounded recoverable tool-error integration test. Use only read_file and do not change any file. First call read_file with Path ${JSON.stringify(missingPath)}, StartLine 1, EndLine 1. That file intentionally does not exist. Wait for its error; do not batch another tool call with it. The error is expected and you must continue. Then call read_file with Path ${JSON.stringify(readablePath)}, StartLine 1, EndLine 1. After that succeeds, finish by replying exactly with the marker read from the second file. Do not use shell, network, subagent, timer, or other tools.`,
    contextExcerpts: [], taskContexts: [], attachments: [],
  });
  const observe = observer(port, attachment);
  await port.request({ handleId: attachment.handleId, operationId, command: { type: "prompt", prompt } });
  const history = await untilNative(port, identity, observe, history => {
    const failed = history.native.steps.find(step => step.tool?.name === "read_file" && step.status === 7 && Boolean(step.error));
    if (!failed) return false;
    expect(JSON.parse(failed.tool!.argumentsJson)).toMatchObject({ Path: missingPath });
    // Project the actual native prefix at the failed tool, even if the next
    // planner step arrived between observation polls. A later executor receipt
    // must not be lent backward to this earlier, recoverable point in the turn.
    const prefix = { ...history.native, steps: history.native.steps.filter(step => step.index <= failed.index),
      executions: history.native.executions.filter(receipt => receipt.lastStepIndex <= failed.index) };
    const atFailure = projectAntigravityHistory(prefix, scope).snapshot;
    expect(Object.values(atFailure.turnsById)).toHaveLength(1);
    expect(Object.values(atFailure.turnsById)[0]?.status).toBe("in_progress");
    expect(Object.values(atFailure.itemsById)).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticKind: "tool", toolName: { text: "read_file" }, status: "failed" }),
      expect.objectContaining({ semanticKind: "notice", tone: "error" }),
    ]));
    const projected = projectAntigravityHistory(history.native, scope).snapshot;
    expect(Object.values(projected.turnsById).some(turn => turn.status === "failed" || turn.status === "interrupted")).toBe(false);
    return quiescent(history) && Object.values(projected.turnsById).some(turn => turn.status === "completed");
  });
  const failedIndex = history.native.steps.find(step => step.tool?.name === "read_file" && step.status === 7)!.index;
  expect(history.native.steps.some(step => step.index > failedIndex && step.response)).toBe(true);
  expect(history.native.steps.some(step => step.index > failedIndex && step.tool?.name === "read_file" && step.status === 3 &&
    JSON.parse(step.tool.argumentsJson).Path === readablePath)).toBe(true);
  const projection = projectAntigravityHistory(history.native, scope).snapshot;
  expect(Object.values(projection.turnsById)).toEqual([expect.objectContaining({ status: "completed", completionCorrelations: [operationId] })]);
  const finalMessage = Object.values(projection.itemsById).findLast(item => item.semanticKind === "assistant_message" && item.responsePhase === "final");
  expect(finalMessage?.semanticKind === "assistant_message" && finalMessage.markdown.text.trim()).toBe(expected);
  expect(await waitOutcome(port, attachment.handleId, operationId)).toMatchObject({ status: "completed", result: { stopReason: "end_turn" } });
  await port.acknowledgeOperation({ handleId: attachment.handleId, operationId });
  expect(projectAntigravityHistory((await readPortHistory(port, identity)).native, scope).snapshot).toEqual(projection);
}

it("keeps a real failed file read nonterminal until continued planning finishes locally", async () => {
  const f = await localFixture();
  try { await qualifiesRecoverableRead({ ...f, port: f.host }); }
  finally { await f.close(); }
});

it.skipIf(process.env.SEDES_LIVE_ANTIGRAVITY_SSH !== "1")("keeps a real failed file read nonterminal through the SSH sidecar", async () => {
  const f = await sshFixture();
  try {
    const port = f.newPort(), session = await newSession(port, f.cwd, f.setIdentity);
    await qualifiesRecoverableRead({ ...f, port, ...session });
  } finally { await f.close(); }
});
