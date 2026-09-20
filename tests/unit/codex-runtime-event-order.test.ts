import { expect, it } from "vitest";
import { CodexRuntimeEventOrder } from "../../src/server/backends/codex/runtime/codex-runtime-event-order.js";
import type { CodexRuntimeCommand } from "../../src/server/backends/codex/runtime/codex-runtime-wire.js";
import type { CodexRuntimePendingRequest } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";

const authority = { scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" }, runtimeId: "runtime", controllerId: "1" };
const submission = (operationId: string): Extract<CodexRuntimeCommand, { action: "submit" }> => ({
  action: "submit", authority, input: { operationId, generation: 1, method: "thread/name/set", params: { threadId: "thread-b", name: "name" }, timeoutMilliseconds: 1000 },
});
const question = (id: string): CodexRuntimePendingRequest => ({
  generation: 1, sequence: 1, id, method: "item/tool/requestUserInput",
  params: { threadId: "thread-b", turnId: "turn", itemId: "item", questions: [], isBlocking: false },
});
const outcome = (operationId: string): CodexRuntimeCommand => ({ action: "outcome", authority, operationId });
const reply = (requestId: string): CodexRuntimeCommand => ({ action: "respond", authority, input: { generation: 1, requestId, result: { answers: {} } } });

it("bounds pending affinities and releases them on acknowledgement, rejection, request settlement, and detach", async () => {
  const order = new CodexRuntimeEventOrder();
  for (let index = 0; index < 128; index++) {
    order.reserveSubmission(submission(`operation-${index}`));
    order.rememberRequest(question(`question-${index}`));
  }
  order.reserveSubmission(submission("overflow"));
  order.rememberRequest(question("overflow"));
  expect(order.commandAffinity(outcome("overflow"))).toBeUndefined();
  expect(order.commandAffinity(reply("overflow"))).toBeUndefined();

  order.acknowledge("operation-0");
  const reject = order.reserveSubmission(submission("replacement"));
  expect(order.commandAffinity(outcome("replacement"))).toBe("thread-b");
  reject();
  expect(order.commandAffinity(outcome("replacement"))).toBeUndefined();
  await order.enqueue({ type: "server_request_settled", generation: 1, requestId: "question-0" }, async () => {});
  order.rememberRequest(question("replacement"));
  expect(order.commandAffinity(reply("replacement"))).toBe("thread-b");
  expect(order.commandAffinity(reply("question-0"))).toBeUndefined();

  order.clearAffinities();
  expect(order.commandAffinity(outcome("operation-1"))).toBeUndefined();
  expect(order.commandAffinity(reply("replacement"))).toBeUndefined();
  expect(order.idle).toBe(true);
});

it("fences unclassified recovered outcomes globally and prunes completed event tails", async () => {
  const order = new CodexRuntimeEventOrder();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = order.enqueue({ type: "notification", notification: {
    kind: "decoded_notification", generation: 1, sequence: 1, method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "turn", itemId: "item", delta: "held" },
  } }, async () => await held);
  let recoveredSent = false;
  const recovered = order.enqueue({ type: "outcome", outcome: { status: "completed", operationId: "recovered", method: "thread/name/set", receipt: { generation: 1, inboundSequence: 2, result: {} } } }, async () => { recoveredSent = true; });
  let laterSent = false;
  const later = order.enqueue({ type: "server_request", request: question("later") }, async () => { laterSent = true; });
  await Promise.resolve();
  expect(recoveredSent).toBe(false);
  expect(laterSent).toBe(false);
  expect(order.idle).toBe(false);
  release();
  await Promise.all([first, recovered, later]);
  expect(recoveredSent).toBe(true);
  expect(laterSent).toBe(true);
  expect(order.idle).toBe(true);
});
