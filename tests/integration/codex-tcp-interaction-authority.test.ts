import { describe, expect, it, vi } from "vitest";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import { CodexInteractionBridge } from "../../src/server/backends/codex/codex-interaction-bridge.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import { CodexRpcClient } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import type {
  ProviderTransportScope,
  FramedMessageTransport,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { TcpWebSocketTransportFactory } from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  RawTcpWebSocketServer,
  type RawWebSocketConnection,
  type RawWebSocketFrame,
} from "../support/raw-uds-websocket-server.js";

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-interaction",
  principalId: "principal-interaction",
  backendInstanceId: "codex-tcp-interaction",
  executionEnvironmentId: "local-interaction",
});
const TOKEN_VARIABLE = "SEDES_CODEX_INTERACTION_TOKEN";
const CAPABILITY_TOKEN = "interaction-capability-token-12345";

describe.sequential("authenticated TCP interaction authority", () => {
  it("keeps concurrent observation passive and reconnects one generation-qualified Sedes controller", async () => {
    /*
     * Boundary: the exact-release live suite proves authenticated Codex TCP
     * transport, multi-client notification observation, process replacement,
     * and thread continuity. A disposable read-only model stream cannot
     * deterministically induce approval and requestUserInput callbacks, so
     * this real authenticated listener supplies only those native server
     * request frames. The production environment channel, WebSocket carrier,
     * RPC client, generation router, and interaction bridge remain in path.
     */
    const peer = new RawTcpWebSocketServer({
      handshakeResponder: (request) =>
        header(request, "authorization") === `Bearer ${CAPABILITY_TOKEN}` &&
        header(request, "origin") === undefined
          ? "accept"
          : { statusCode: 401 },
    });
    await peer.listen();
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
      environment: { [TOKEN_VARIABLE]: CAPABILITY_TOKEN },
    });
    const factory = new TcpWebSocketTransportFactory({
      scope,
      channels,
      url: peer.url,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
      limits: { handshakeTimeoutMilliseconds: 500 },
    });
    const router = new CodexServerRequestRouter();
    const events: InteractionEvent[] = [];
    const bridge = new CodexInteractionBridge({
      router,
      nativeThreadId: "thread-authoritative",
      ownsRoute: (route) =>
        route.nativeThreadId === "thread-authoritative" &&
        route.nativeTurnId === "turn-authoritative" &&
        route.nativeItemId?.startsWith("item-") === true,
      emit: (event) => events.push(event),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      responseConfirmationTimeoutMilliseconds: 1_000,
    });
    const passiveEvents: InteractionEvent[] = [];
    const passiveBridge = new CodexInteractionBridge({
      router,
      nativeThreadId: "thread-authoritative",
      ownsRoute: () => true,
      emit: (event) => passiveEvents.push(event),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    });
    let controllerTransport1: FramedMessageTransport | undefined;
    let controllerTransport2: FramedMessageTransport | undefined;
    let observerTransport: FramedMessageTransport | undefined;
    let controller1: CodexRpcClient | undefined;
    let controller2: CodexRpcClient | undefined;

    try {
      router.activateGeneration(1);
      bridge.activate(1);
      expect(() => passiveBridge.activate(1)).toThrow(
        "codex_server_request_thread_already_owned",
      );

      controllerTransport1 = await factory.open(
        scope,
        1,
        new AbortController().signal,
      );
      observerTransport = await factory.open(
        scope,
        1,
        new AbortController().signal,
      );
      const controllerConnection1 = peer.connections[0];
      const observerConnection = peer.connections[1];
      if (!controllerConnection1 || !observerConnection) {
        throw new Error("codex_tcp_multi_client_fixture_missing");
      }
      const observerFrames = observerTransport.frames[Symbol.asyncIterator]();
      controller1 = new CodexRpcClient({
        transport: controllerTransport1,
        expectedScope: scope,
        generation: 1,
        handlers: router.handlersForGeneration(1),
        limits: { serverRequestTimeoutMilliseconds: 2_000 },
      });
      controller1.start();

      const approvalRequest = serverRequest(
        "approval-generation-1",
        "item/commandExecution/requestApproval",
        {
          kind: "command",
          threadId: "thread-authoritative",
          turnId: "turn-authoritative",
          itemId: "item-command",
          startedAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
          environmentId: null,
          command: "npm test",
          cwd: "/workspace",
        },
      );
      const observedApproval = observerFrames.next();
      await Promise.all([
        controllerConnection1.sendText(approvalRequest),
        observerConnection.sendText(approvalRequest),
      ]);
      await expect(observedApproval).resolves.toMatchObject({
        done: false,
        value: { text: approvalRequest },
      });
      await vi.waitFor(() => expect(opened(events)).toHaveLength(1));

      // Observation of the same request on a second authenticated client
      // cannot open a second normalized interaction.
      expect(opened(events)).toHaveLength(1);
      const approvalInteraction = opened(events)[0];
      if (!approvalInteraction || approvalInteraction.kind !== "decision") {
        throw new Error("codex_tcp_approval_interaction_missing");
      }
      expect(() =>
        passiveBridge.respond({
          applicationOperationId: "passive-approval-attempt",
          interactionId: approvalInteraction.backendInteractionId,
          kind: "decision",
          selectedActionId: "accept",
        }),
      ).toThrow("codex_interaction_not_pending");

      const approvalConfirmation = bridge.respond({
        applicationOperationId: "authoritative-approval",
        interactionId: approvalInteraction.backendInteractionId,
        kind: "decision",
        selectedActionId: "accept",
      });
      await expectResponse(controllerConnection1, "approval-generation-1", {
        decision: "accept",
      });
      bridge.observeProviderResolved(1, "approval-generation-1");
      await expect(approvalConfirmation).resolves.toBeUndefined();

      const interruptedInputRequest = serverRequest(
        "input-generation-1",
        "item/tool/requestUserInput",
        userInputParams("item-input-before-reconnect"),
      );
      const observedInterruptedInput = observerFrames.next();
      await controllerConnection1.sendText(interruptedInputRequest);
      await observerConnection.sendText(interruptedInputRequest);
      await expect(observedInterruptedInput).resolves.toMatchObject({
        done: false,
        value: { text: interruptedInputRequest },
      });
      await vi.waitFor(() => expect(opened(events)).toHaveLength(2));
      const interruptedInteraction = opened(events)[1];
      if (!interruptedInteraction) {
        throw new Error("codex_tcp_interrupted_interaction_missing");
      }
      expect(() =>
        passiveBridge.respond({
          applicationOperationId: "passive-input-attempt",
          interactionId: interruptedInteraction.backendInteractionId,
          kind: "questionnaire",
          answers: [
            {
              questionId: "environment",
              answer: { kind: "text", value: "observer answer" },
            },
          ],
        }),
      ).toThrow("codex_interaction_not_pending");

      // Losing the external client aborts the old request without inventing
      // a provider response. A later UI reply is rejected, not replayed.
      await controller1.close("fixture_controller_reconnect");
      await vi.waitFor(() => expect(bridge.pendingCount()).toBe(0));
      expect(() =>
        bridge.respond({
          applicationOperationId: "late-generation-1-input",
          interactionId: interruptedInteraction.backendInteractionId,
          kind: "questionnaire",
          answers: [
            {
              questionId: "environment",
              answer: { kind: "text", value: "late answer" },
            },
          ],
        }),
      ).toThrow("codex_interaction_not_pending");
      expect(textEnvelopes(controllerConnection1)).not.toContainEqual(
        expect.objectContaining({ id: "input-generation-1" }),
      );
      expect(peer.listening).toBe(true);
      expect(observerTransport.assurance.connectionGeneration).toBe(1);

      router.activateGeneration(2);
      bridge.activate(2);
      expect(() => passiveBridge.activate(2)).toThrow(
        "codex_server_request_thread_already_owned",
      );
      controllerTransport2 = await factory.open(
        scope,
        2,
        new AbortController().signal,
      );
      const controllerConnection2 = peer.connections[2];
      if (!controllerConnection2) {
        throw new Error("codex_tcp_reconnected_controller_missing");
      }
      controller2 = new CodexRpcClient({
        transport: controllerTransport2,
        expectedScope: scope,
        generation: 2,
        handlers: router.handlersForGeneration(2),
        limits: { serverRequestTimeoutMilliseconds: 2_000 },
      });
      controller2.start();

      // The provider still owns the unresolved callback and re-delivers the
      // exact native request after reconnect. Generation two creates a new
      // normalized interaction; the stale generation-one UI identity stays
      // invalid and is never replayed automatically.
      const reconnectedInputRequest = interruptedInputRequest;
      const observedReconnectedInput = observerFrames.next();
      await Promise.all([
        controllerConnection2.sendText(reconnectedInputRequest),
        observerConnection.sendText(reconnectedInputRequest),
      ]);
      await expect(observedReconnectedInput).resolves.toMatchObject({
        done: false,
        value: { text: reconnectedInputRequest },
      });
      await vi.waitFor(() => expect(opened(events)).toHaveLength(3));
      const reconnectedInteraction = opened(events)[2];
      if (
        !reconnectedInteraction ||
        reconnectedInteraction.kind !== "questionnaire"
      ) {
        throw new Error("codex_tcp_reconnected_interaction_missing");
      }
      expect(reconnectedInteraction.backendInteractionId).not.toBe(
        interruptedInteraction.backendInteractionId,
      );
      expect(() =>
        passiveBridge.respond({
          applicationOperationId: "passive-reconnected-input-attempt",
          interactionId: reconnectedInteraction.backendInteractionId,
          kind: "questionnaire",
          answers: [
            {
              questionId: "environment",
              answer: { kind: "text", value: "observer answer" },
            },
          ],
        }),
      ).toThrow("codex_interaction_not_pending");
      const inputConfirmation = bridge.respond({
        applicationOperationId: "authoritative-input-generation-2",
        interactionId: reconnectedInteraction.backendInteractionId,
        kind: "questionnaire",
        answers: [
          {
            questionId: "environment",
            answer: { kind: "text", value: "staging" },
          },
        ],
      });
      await expectResponse(controllerConnection2, "input-generation-1", {
        answers: { environment: { answers: ["user_note: staging"] } },
      });
      bridge.observeProviderResolved(2, "input-generation-1");
      await expect(inputConfirmation).resolves.toBeUndefined();

      // Once settled, the same native request ID is a protocol violation.
      // The client fails closed while both the observer and server survive.
      await controllerConnection2.sendText(reconnectedInputRequest);
      await expect(controller2.closed).resolves.toMatchObject({
        generation: 2,
        reason: "codex_rpc_duplicate_server_request",
      });

      expect(passiveEvents).toEqual([]);
      expect(opened(events)).toHaveLength(3);
      expect(resolved(events)).toHaveLength(3);
      expect(textEnvelopes(observerConnection)).toEqual([]);
      expect(peer.listening).toBe(true);
      expect(peer.requests).toHaveLength(3);
      for (const request of peer.requests) {
        expect(header(request, "authorization")).toBe(
          `Bearer ${CAPABILITY_TOKEN}`,
        );
        expect(header(request, "origin")).toBeUndefined();
      }
    } finally {
      bridge.close();
      passiveBridge.close();
      await Promise.allSettled([
        controller1?.close("fixture_cleanup") ?? Promise.resolve(),
        controller2?.close("fixture_cleanup") ?? Promise.resolve(),
        observerTransport?.close("fixture_cleanup") ?? Promise.resolve(),
        controllerTransport1?.close("fixture_cleanup") ?? Promise.resolve(),
        controllerTransport2?.close("fixture_cleanup") ?? Promise.resolve(),
      ]);
      channels.close();
      await peer.close();
    }
  }, 15_000);
});

function serverRequest(
  id: string,
  method:
    "item/commandExecution/requestApproval" | "item/tool/requestUserInput",
  params: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({ method, id, params });
}

function userInputParams(itemId: string): Readonly<Record<string, unknown>> {
  return {
    threadId: "thread-authoritative",
    turnId: "turn-authoritative",
    itemId,
    questions: [
      {
        id: "environment",
        header: "Environment",
        question: "Which environment?",
        isOther: false,
        isSecret: false,
        options: null,
      },
    ],
    isBlocking: true,
  };
}

function opened(events: readonly InteractionEvent[]) {
  return events.flatMap((event) =>
    event.type === "interaction_opened" ? [event.interaction] : [],
  );
}

function resolved(events: readonly InteractionEvent[]) {
  return events.filter((event) => event.type === "interaction_resolved");
}

function isTextFrame(frame: RawWebSocketFrame): boolean {
  return frame.opcode === 0x1;
}

function textEnvelopes(
  connection: RawWebSocketConnection,
): ReadonlyArray<Record<string, unknown>> {
  return connection.frames
    .filter(isTextFrame)
    .map(
      (frame) =>
        JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>,
    );
}

async function expectResponse(
  connection: RawWebSocketConnection,
  id: string,
  result: unknown,
): Promise<void> {
  const response = await connection.waitForFrame((frame) => {
    if (!isTextFrame(frame)) return false;
    try {
      return (
        (
          JSON.parse(frame.payload.toString("utf8")) as {
            readonly id?: unknown;
          }
        ).id === id
      );
    } catch {
      return false;
    }
  });
  expect(JSON.parse(response.payload.toString("utf8"))).toEqual({ id, result });
}

function header(request: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of request.split("\r\n").slice(1)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return undefined;
}
