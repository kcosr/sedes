import {
  AGENT_METHODS,
  agent,
  type AnyMessage,
  type ClientCapabilities,
  type Stream,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironmentOwnedProcessIdentity,
  type EnvironmentChannelScope,
} from "../../src/server/execution/environment-channel.js";
import {
  AcpBinding,
  ACP_AGENT_NOTIFICATIONS,
  ACP_AGENT_REQUESTS,
  ACP_CLIENT_NOTIFICATIONS,
  ACP_CLIENT_REQUESTS,
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  defineAcpReverseNotificationHandler,
  defineAcpReverseRequestHandler,
  SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES,
  type AcpRequestDescriptor,
  type AcpValueValidator,
} from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import {
  FrameWriteError,
  createOwnedProcessAssurance,
  revokeFramedTransportAssurance,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type InboundTextFrame,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";

const scope: EnvironmentChannelScope = Object.freeze({
  tenantId: "tenant-acp-test",
  principalId: "principal-acp-test",
  backendInstanceId: "backend-acp-test",
  executionEnvironmentId: "environment-acp-test",
});
const activeBindings: AcpBinding[] = [];
const decodeTestValue = <T>(value: unknown): T => value as T;

afterEach(async () => {
  await Promise.allSettled(
    activeBindings.splice(0).map(async (binding) => await binding.close()),
  );
});

describe("ACP V1 Sedes peer", () => {
  it("returns only a recursively frozen projection of additive initialize traffic", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      envelopeAddition: "discard",
      result: {
        protocolVersion: 1,
        resultAddition: "discard",
        agentCapabilities: {
          loadSession: true,
          nestedAddition: "discard",
          promptCapabilities: { image: true, throughRefAddition: "discard" },
        },
      },
    });

    const response = await pending;
    expect(response).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
      },
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.agentCapabilities)).toBe(true);
    expect(
      Object.isFrozen(response.agentCapabilities?.promptCapabilities),
    ).toBe(true);
    expect(Object.getPrototypeOf(response)).toBeNull();
    expect(Object.getPrototypeOf(response.agentCapabilities)).toBeNull();
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("binds only the exact assured scope and generation", async () => {
    const transport = new FakeAcpTransport();
    expect(
      () =>
        new AcpBinding({
          transport,
          expectedScope: { ...scope, principalId: "other-principal" },
          expectedConnectionGeneration: 1,
        }),
    ).toThrow("acp_binding_transport_assurance_invalid");
    expect(
      () =>
        new AcpBinding({
          transport,
          expectedScope: scope,
          expectedConnectionGeneration: 2,
        }),
    ).toThrow("acp_binding_transport_assurance_invalid");
    await transport.close("test_complete");
  });

  it("admits no outbound request or notification after assurance revocation", async () => {
    const echo = syntheticEchoDescriptor();
    const requestTransport = new FakeAcpTransport();
    const requestBinding = trackedBinding(requestTransport, {
      profiles: ["probe-v1"],
      extensions: [echo],
    });
    await initializeRaw(requestBinding, requestTransport);
    revokeFramedTransportAssurance(requestTransport.assurance);
    await expect(
      requestBinding.request(echo, { value: "never-written" }),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    expect(requestTransport.writes).toHaveLength(1);
    await requestBinding.closed;

    const notificationTransport = new FakeAcpTransport();
    const notificationBinding = trackedBinding(notificationTransport);
    await initializeRaw(notificationBinding, notificationTransport);
    revokeFramedTransportAssurance(notificationTransport.assurance);
    await expect(
      notificationBinding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, {
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    expect(notificationTransport.writes).toHaveLength(1);
    await notificationBinding.closed;
  });

  it("interoperates with the official SDK object Stream at the fixture edge", async () => {
    const transport = new FakeAcpTransport();
    const sdkInput = objectStreamInput();
    transport.onSend = async (text) => {
      sdkInput.receive(JSON.parse(text) as AnyMessage);
    };
    const stream: Stream = {
      readable: sdkInput.readable,
      writable: new WritableStream<AnyMessage>({
        write(message) {
          transport.emit(message);
        },
      }),
    };
    const sdkAgent = agent({ name: "sedes-acp-official-fixture" })
      .onRequest(AGENT_METHODS.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: {},
        agentInfo: { name: "fixture-agent", version: "1" },
      }))
      .onRequest(AGENT_METHODS.session_new, ({ params }) => ({
        sessionId: `official:${params.cwd}`,
      }));
    const sdkConnection = sdkAgent.connect(stream);
    const binding = trackedBinding(transport);

    await expect(
      binding.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    ).resolves.toMatchObject({ protocolVersion: 1 });
    await expect(
      binding.request(ACP_AGENT_REQUESTS.newSession, {
        cwd: "/fixture",
        mcpServers: [],
      }),
    ).resolves.toEqual({ sessionId: "official:/fixture" });

    sdkConnection.close();
  });

  it("correlates reordered responses through a synthetic second profile", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
    });
    await initializeRaw(binding, transport);

    const first = binding.request(echo, { value: "first" });
    const second = binding.request(echo, { value: "second" });
    await waitFor(() => transport.writes.length === 3);
    const firstWire = transport.parsedWrite(1);
    const secondWire = transport.parsedWrite(2);
    transport.emit({
      jsonrpc: "2.0",
      id: secondWire.id,
      result: { value: "second-result" },
    });
    transport.emit({
      jsonrpc: "2.0",
      id: firstWire.id,
      result: { value: "first-result" },
    });

    await expect(first).resolves.toEqual({ value: "first-result" });
    await expect(second).resolves.toEqual({ value: "second-result" });
  });

  it("snapshots exact outbound and reverse wire values before validation", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const reverseRegistration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => {
        const response = {
          outcome: { outcome: "cancelled" as const },
        };
        Object.defineProperty(response, "toJSON", {
          value: () => ({ privateWireMarker: "reverse-secret" }),
        });
        return response;
      },
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [reverseRegistration],
    });
    await initializeRaw(binding, transport);

    let getterReads = 0;
    const statefulRequest = {} as { value: string };
    Object.defineProperty(statefulRequest, "value", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? "canonical" : "request-secret";
      },
    });
    await expect(binding.request(echo, statefulRequest)).rejects.toMatchObject({
      code: "acp_binding_protocol_violation",
    });
    expect(getterReads).toBe(0);
    expect(transport.writes).toHaveLength(1);

    const notification = { sessionId: "session-1" };
    Object.defineProperty(notification, "toJSON", {
      value: () => ({ privateWireMarker: "notification-secret" }),
    });
    await binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, notification);
    expect(transport.parsedWrite(1)).toMatchObject({
      params: { sessionId: "session-1" },
    });

    transport.emit(permissionRequest(17));
    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      id: 17,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(transport.writes.join("\n")).not.toMatch(
      /request-secret|notification-secret|reverse-secret|privateWireMarker/u,
    );
  });

  it("projects additive reverse-request fields before authority and preserves immutable open metadata", async () => {
    let observed: Record<string, unknown> | undefined;
    let mutationSucceeded = false;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: (params) => {
        observed = params as unknown as Record<string, unknown>;
        try {
          (params as unknown as Record<string, unknown>).injected = true;
          mutationSucceeded = true;
        } catch {
          mutationSucceeded = false;
        }
        return true;
      },
      handle: () => ({ outcome: { outcome: "cancelled" as const } }),
    });
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    const request = permissionRequest(41);
    request.envelopeAddition = "discard";
    const params = request.params as Record<string, unknown>;
    params.topAddition = "discard";
    params._meta = { vendor: { retained: true } };
    const option = (params.options as Record<string, unknown>[])[0];
    if (option) option.nestedAddition = "discard";
    transport.emit(request);
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 41,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(observed).toEqual({
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      _meta: { vendor: { retained: true } },
    });
    expect(mutationSucceeded).toBe(false);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.getPrototypeOf(observed)).toBeNull();
    expect(
      Object.isFrozen(
        (observed?.options as readonly unknown[] | undefined)?.[0],
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        (observed?._meta as Record<string, unknown> | undefined)?.vendor,
      ),
    ).toBe(true);
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("canonicalizes extension decoder output before predicates and handlers", async () => {
    type ProjectedRequest = {
      value: string;
      nested: readonly { ok: true }[];
    };
    type ProjectedResponse = { ok: true };
    let getterReads = 0;
    let toJsonCalls = 0;
    let predicateCalls = 0;
    let predicateValue: ProjectedRequest | undefined;
    let authorityValue: ProjectedRequest | undefined;
    let handlerValue: ProjectedRequest | undefined;
    const descriptor = defineAcpExtensionRequest<
      ProjectedRequest,
      ProjectedResponse
    >({
      method: "probe/projected-extension",
      direction: "agent_to_client",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: (value) => {
        const raw = value as { attack?: unknown; value?: unknown };
        if (raw.attack === "accessor") {
          const projected = {} as ProjectedRequest;
          Object.defineProperty(projected, "value", {
            enumerable: true,
            get: () => {
              getterReads += 1;
              return "unsafe";
            },
          });
          return projected;
        }
        if (raw.attack === "toJSON") {
          return {
            value: "unsafe",
            nested: [],
            toJSON: () => {
              toJsonCalls += 1;
              return { value: "substituted", nested: [] };
            },
          } as ProjectedRequest;
        }
        if (raw.attack === "prototype") {
          return new (class {
            value = "unsafe";
            nested = [];
          })() as ProjectedRequest;
        }
        return {
          value: typeof raw.value === "string" ? raw.value : "",
          nested: [{ ok: true }],
        };
      },
      decodeResponse: () => ({ ok: true }),
      validateRequest: (value): value is ProjectedRequest =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { value?: unknown }).value === "string" &&
        Array.isArray((value as { nested?: unknown }).nested),
      validateResponse: (value): value is ProjectedResponse =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { ok?: unknown }).ok === true,
      reverseCapability: (_capabilities, request) => {
        predicateCalls += 1;
        predicateValue = request;
        return true;
      },
    });
    const registration = defineAcpReverseRequestHandler({
      descriptor,
      authorize: (request) => {
        authorityValue = request;
        return true;
      },
      handle: (request) => {
        handlerValue = request;
        return { ok: true };
      },
    });
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);

    for (const [index, attack] of [
      "accessor",
      "toJSON",
      "prototype",
    ].entries()) {
      transport.emit({
        jsonrpc: "2.0",
        id: 50 + index,
        method: descriptor.method,
        params: { attack },
      });
      await waitFor(() => transport.writes.length === index + 2);
      expect(transport.parsedWrite(index + 1)).toMatchObject({
        id: 50 + index,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(getterReads).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(predicateCalls).toBe(0);

    transport.emit({
      jsonrpc: "2.0",
      id: 60,
      method: descriptor.method,
      params: { value: "safe", additive: "discarded-by-decoder" },
    });
    await waitFor(() => transport.writes.length === 5);
    expect(transport.parsedWrite(4)).toMatchObject({
      id: 60,
      result: { ok: true },
    });
    expect(predicateCalls).toBe(1);
    expect(predicateValue).toBe(authorityValue);
    expect(authorityValue).toBe(handlerValue);
    expect(handlerValue).toEqual({ value: "safe", nested: [{ ok: true }] });
    expect(Object.getPrototypeOf(handlerValue)).toBeNull();
    expect(Object.isFrozen(handlerValue)).toBe(true);
    expect(Object.isFrozen(handlerValue?.nested)).toBe(true);
    expect(Object.getPrototypeOf(handlerValue?.nested[0])).toBeNull();
    expect(Object.isFrozen(handlerValue?.nested[0])).toBe(true);
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("keeps capability snapshots prototype-free so pollution cannot advertise authority", async () => {
    let authorityCalls = 0;
    let observedCapabilities: Readonly<ClientCapabilities> | undefined;
    const registrations = [
      ACP_CLIENT_REQUESTS.createTerminal,
      ACP_CLIENT_REQUESTS.readTextFile,
    ].map((descriptor) =>
      defineAcpReverseRequestHandler({
        descriptor: descriptor as AcpRequestDescriptor<unknown, unknown>,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => {
          throw new Error("polluted_capability_reached_authority");
        },
      }),
    );
    const observer = defineAcpExtensionRequest<
      Record<string, never>,
      Record<string, never>
    >({
      method: "probe/capability-prototype",
      direction: "agent_to_client",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: () => Object.create(null) as Record<string, never>,
      decodeResponse: () => Object.create(null) as Record<string, never>,
      validateRequest: (value): value is Record<string, never> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
      validateResponse: (value): value is Record<string, never> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
      reverseCapability: (capabilities) => {
        observedCapabilities = capabilities;
        return false;
      },
    });
    const observerRegistration = defineAcpReverseRequestHandler({
      descriptor: observer,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => ({}),
    });
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [observer],
      reverseHandlers: [...registrations, observerRegistration],
    });

    Object.defineProperties(Object.prototype, {
      terminal: { configurable: true, value: true },
      readTextFile: { configurable: true, value: true },
    });
    try {
      await initializeRaw(binding, transport, { fs: {} });
      for (const request of [
        {
          id: 70,
          method: "terminal/create",
          params: { sessionId: "session", command: "true" },
        },
        {
          id: 71,
          method: "fs/read_text_file",
          params: { sessionId: "session", path: "/tmp/file" },
        },
        { id: 72, method: observer.method, params: {} },
      ]) {
        transport.emit({ jsonrpc: "2.0", ...request });
      }
      await waitFor(() => transport.writes.length === 4);
    } finally {
      delete (Object.prototype as Record<string, unknown>).terminal;
      delete (Object.prototype as Record<string, unknown>).readTextFile;
    }

    for (const index of [1, 2, 3]) {
      expect(transport.parsedWrite(index)).toMatchObject({
        error: { code: -32601, message: "Method not available" },
      });
    }
    expect(authorityCalls).toBe(0);
    expect(Object.getPrototypeOf(observedCapabilities)).toBeNull();
    expect(Object.getPrototypeOf(observedCapabilities?.fs)).toBeNull();
    expect(Object.isFrozen(observedCapabilities)).toBe(true);
    expect(Object.isFrozen(observedCapabilities?.fs)).toBe(true);
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("requires structured params while preserving falsy JSON results", async () => {
    const acceptsAnything: AcpValueValidator<unknown> = () => true;
    const outboundScalar = defineAcpExtensionRequest({
      method: "probe/outbound-scalar",
      direction: "client_to_agent",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: acceptsAnything,
      validateResponse: acceptsAnything,
    });
    const notificationScalar = defineAcpExtensionNotification({
      method: "probe/notification-scalar",
      direction: "client_to_agent",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: acceptsAnything,
    });
    const reverseFalsy = defineAcpExtensionRequest<
      Record<string, never>,
      false
    >({
      method: "probe/reverse-falsy",
      direction: "agent_to_client",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0,
      validateResponse: (value) => value === false,
    });
    const registration = defineAcpReverseRequestHandler({
      descriptor: reverseFalsy,
      authorize: () => true,
      handle: () => false as const,
    });
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [outboundScalar, notificationScalar, reverseFalsy],
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);

    await expect(binding.request(outboundScalar, 1)).rejects.toMatchObject({
      code: "acp_binding_protocol_violation",
    });
    await expect(
      binding.notify(notificationScalar, null),
    ).rejects.toMatchObject({
      code: "acp_binding_protocol_violation",
    });
    transport.emit({
      jsonrpc: "2.0",
      id: 18,
      method: "probe/reverse-falsy",
      params: {},
    });
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toEqual({
      jsonrpc: "2.0",
      id: 18,
      result: false,
    });

    const inboundTransport = new FakeAcpTransport();
    let inboundAuthorityCalls = 0;
    const inboundBinding = trackedBinding(inboundTransport, {
      profiles: ["probe-v1"],
      extensions: [reverseFalsy],
      reverseHandlers: [
        defineAcpReverseRequestHandler({
          descriptor: reverseFalsy,
          authorize: () => {
            inboundAuthorityCalls += 1;
            return true;
          },
          handle: () => false as const,
        }),
      ],
    });
    await initializeRaw(inboundBinding, inboundTransport);
    inboundTransport.emit({
      jsonrpc: "2.0",
      id: 19,
      method: "probe/reverse-falsy",
      params: null,
    });
    await expect(inboundBinding.closed).resolves.toMatchObject({
      reason: "acp_envelope_invalid",
    });
    expect(inboundAuthorityCalls).toBe(0);
  });

  it("bounds pending work and keeps request cancellation cooperative", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      limits: { maximumPendingRequests: 1 },
    });
    await initializeRaw(binding, transport);
    const cancellation = new AbortController();
    const active = binding.request(
      echo,
      { value: "active" },
      { cancellationSignal: cancellation.signal },
    );
    await waitFor(() => transport.writes.length === 2);
    await expect(
      binding.request(echo, { value: "over-capacity" }),
    ).rejects.toMatchObject({ code: "acp_binding_overloaded" });
    cancellation.abort();
    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      method: "$/cancel_request",
      params: { requestId: transport.parsedWrite(1).id },
    });
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "completed-after-cancel" },
    });
    await expect(active).resolves.toEqual({
      value: "completed-after-cancel",
    });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      binding.request(
        echo,
        { value: "never-sent" },
        { cancellationSignal: preAborted.signal },
      ),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    expect(transport.writes).toHaveLength(3);
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "preserves %s delivery evidence for cancellation writes",
    async (delivery) => {
      const transport = new FakeAcpTransport();
      const echo = syntheticEchoDescriptor();
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [echo],
      });
      await initializeRaw(binding, transport);
      const cancellation = new AbortController();
      const request = binding.request(
        echo,
        { value: "cancel-delivery" },
        { cancellationSignal: cancellation.signal },
      );
      await waitFor(() => transport.writes.length === 2);
      transport.failNextSend = delivery;
      cancellation.abort();

      await expect(binding.closed).resolves.toMatchObject({
        reason: "acp_cancel_delivery_failed",
        delivery,
      });
      await expect(request).rejects.toMatchObject({
        delivery: "sent_outcome_unknown",
      });
      expect(
        transport.writes.filter(
          (wire) => JSON.parse(wire).method === "$/cancel_request",
        ),
      ).toHaveLength(delivery === "sent_outcome_unknown" ? 1 : 0);
    },
  );

  it("fences before outbound request IDs can be exhausted", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      limits: { maximumOutboundRequestsPerGeneration: 1 },
    });
    await initializeRaw(binding, transport);

    await expect(
      binding.request(echo, { value: "never-sent" }),
    ).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(transport.writes).toHaveLength(1);
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_id_exhausted",
    });
  });

  it("rejects aggregate wire bytes and oversized metadata keys before sending", async () => {
    const transport = new FakeAcpTransport();
    const valueValidator: AcpValueValidator<{ payload: unknown }> = (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, "payload");
    const descriptor = defineAcpExtensionRequest({
      method: "probe/aggregate-bound",
      direction: "client_to_agent",
      operation: "mutation",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: valueValidator,
      validateResponse: valueValidator,
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      limits: { maximumFrameBytes: 256 },
    });
    await initializeRaw(binding, transport);

    await expect(
      binding.request(descriptor, {
        payload: Array.from({ length: 16 }, () => "x".repeat(32)),
      }),
    ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
    await expect(
      binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, {
        sessionId: "session-1",
        _meta: { ["k".repeat(300)]: true },
      }),
    ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
    expect(transport.writes).toHaveLength(1);
    expect(binding.diagnostics().pendingRequests).toBe(0);
  });

  it("admits a standard ACP image data string above the former generic string bound", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    await initializeRaw(
      binding,
      transport,
      {},
      {
        promptCapabilities: { image: true },
      },
    );
    const data = "A".repeat(300 * 1_024);
    const pending = binding.request(ACP_AGENT_REQUESTS.prompt, {
      sessionId: "session-image",
      prompt: [{ type: "image", mimeType: "image/png", data }],
      _meta: { promptId: "prompt-image" },
    });
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "session-image",
        prompt: [{ type: "image", mimeType: "image/png", data }],
        _meta: { promptId: "prompt-image" },
      },
    });
    const request = transport.parsedWrite(1);
    transport.emit({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("quarantines a generation on a hard request deadline", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      limits: { requestDeadlineMilliseconds: 20 },
    });
    await initializeRaw(binding, transport);

    await expect(
      binding.request(echo, { value: "deadline" }, { deadlineMilliseconds: 5 }),
    ).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_deadline",
      delivery: "sent_outcome_unknown",
    });
  });

  it("keeps a completion-synchronous request pending without a response deadline", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      limits: { requestDeadlineMilliseconds: 20 },
    });
    await initializeRaw(binding, transport);

    const pending = binding.requestWithSettlement(
      echo,
      { value: "long-running" },
      {
        deadlineMilliseconds: null,
        notificationCutover: { kind: "all" },
      },
    );
    await waitFor(() => transport.writes.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingRequests: 1,
    });

    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "long-running" },
    });
    const settlement = await pending;
    expect(settlement).toMatchObject({
      kind: "success",
      response: { value: "long-running" },
    });
    await expect(
      settlement.commitNotificationCutover(() => "committed"),
    ).resolves.toBe("committed");
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("still bounds the outbound write for a request without a response deadline", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      limits: { requestDeadlineMilliseconds: 20 },
    });
    await initializeRaw(binding, transport);
    transport.onSend = async (_text, options) => {
      await new Promise<void>((_resolve, reject) => {
        const signal = options?.signal;
        const fail = () =>
          reject(
            new FrameWriteError(
              "fake_acp_write_cancelled",
              "sent_outcome_unknown",
            ),
          );
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    };

    await expect(
      binding.request(
        echo,
        { value: "stalled-write" },
        {
          deadlineMilliseconds: null,
        },
      ),
    ).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_delivery_unknown",
    });
  });

  it("rejects duplicate responses and contextual outbound mismatches", async () => {
    const transport = new FakeAcpTransport();
    const validator: AcpValueValidator<{ value: string }> = (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { value?: unknown }).value === "string";
    const descriptor = defineAcpExtensionRequest({
      method: "probe/contextual",
      direction: "client_to_agent",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: validator,
      validateResponse: validator,
      validateResponseForRequest: (response, request) =>
        response.value === request.value,
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initializeRaw(binding, transport);
    const request = binding.request(descriptor, { value: "expected" });
    await waitFor(() => transport.writes.length === 2);
    const id = transport.parsedWrite(1).id;
    transport.emit({
      jsonrpc: "2.0",
      id,
      result: { value: "mismatched" },
    });
    await expect(request).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await binding.closed;

    const duplicateTransport = new FakeAcpTransport();
    const duplicateBinding = trackedBinding(duplicateTransport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initializeRaw(duplicateBinding, duplicateTransport);
    const accepted = duplicateBinding.request(descriptor, { value: "same" });
    await waitFor(() => duplicateTransport.writes.length === 2);
    const duplicateId = duplicateTransport.parsedWrite(1).id;
    const response = {
      jsonrpc: "2.0",
      id: duplicateId,
      result: { value: "same" },
    };
    duplicateTransport.emit(response);
    await expect(accepted).resolves.toEqual({ value: "same" });
    duplicateTransport.emit(response);
    await expect(duplicateBinding.closed).resolves.toMatchObject({
      reason: "acp_response_duplicate",
    });
  });

  it.each(["response-validator", "cross-validator"] as const)(
    "rejects and fences when an extension %s throws",
    async (failurePoint) => {
      const transport = new FakeAcpTransport();
      const validator: AcpValueValidator<{ value: string }> = (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        typeof (value as { value?: unknown }).value === "string";
      const descriptor = defineAcpExtensionRequest({
        method: `probe/throwing-${failurePoint}`,
        direction: "client_to_agent",
        operation: "read",
        requiredProfile: "probe-v1",
        decodeRequest: decodeTestValue,
        decodeResponse: decodeTestValue,
        validateRequest: validator,
        validateResponse:
          failurePoint === "response-validator"
            ? () => {
                throw new Error("private-response-validator-marker");
              }
            : validator,
        validateResponseForRequest:
          failurePoint === "cross-validator"
            ? () => {
                throw new Error("private-cross-validator-marker");
              }
            : undefined,
      });
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [descriptor],
      });
      await initializeRaw(binding, transport);
      const request = binding.request(descriptor, { value: "request" });
      await waitFor(() => transport.writes.length === 2);
      transport.emit({
        jsonrpc: "2.0",
        id: transport.parsedWrite(1).id,
        result: { value: "response" },
      });

      await expect(request).rejects.toMatchObject({
        delivery: "sent_outcome_unknown",
      });
      await binding.closed;
      expect(JSON.stringify(binding.diagnostics())).not.toContain("private-");
    },
  );

  it("does not let mutating extension validators alter outbound wire data", async () => {
    const transport = new FakeAcpTransport();
    const mutatingValidator: AcpValueValidator<{ value: string }> = (value) => {
      (value as { value: string }).value = "private-mutated-marker";
      return true;
    };
    const descriptor = defineAcpExtensionRequest({
      method: "probe/mutating-validator",
      direction: "client_to_agent",
      operation: "mutation",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: mutatingValidator,
      validateResponse: () => true,
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initializeRaw(binding, transport);

    await expect(
      binding.request(descriptor, { value: "original" }),
    ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes.join("\n")).not.toContain("private-mutated-marker");
  });

  it("reserves disabled standard routes without banning distinct overloads", async () => {
    const validator: AcpValueValidator<Record<string, never>> = (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0;
    expect(() =>
      defineAcpExtensionRequest({
        method: "rpc.private",
        direction: "client_to_agent",
        operation: "read",
        requiredProfile: "probe-v1",
        decodeRequest: decodeTestValue,
        decodeResponse: decodeTestValue,
        validateRequest: validator,
        validateResponse: validator,
      }),
    ).toThrow("acp_descriptor_invalid");
    const reserved = defineAcpExtensionRequest({
      method: "mcp/message",
      direction: "client_to_agent",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: validator,
      validateResponse: validator,
    });
    const transport = new FakeAcpTransport();
    expect(
      () =>
        new AcpBinding({
          transport,
          expectedScope: scope,
          expectedConnectionGeneration: 1,
          profiles: ["probe-v1"],
          extensions: [reserved],
        }),
    ).toThrow("acp_extension_standard_route_reserved");
    await transport.close("test_complete");

    const overload = defineAcpExtensionRequest({
      method: "probe/overload",
      direction: "client_to_agent",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: validator,
      validateResponse: validator,
    });
    const reverseOverload = defineAcpExtensionRequest({
      method: "probe/overload",
      direction: "agent_to_client",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: validator,
      validateResponse: validator,
    });
    const overloadTransport = new FakeAcpTransport();
    const binding = trackedBinding(overloadTransport, {
      profiles: ["probe-v1"],
      extensions: [overload, reverseOverload],
    });
    await initializeRaw(binding, overloadTransport);
  });

  it("denies a known but unadvertised reverse request before authority", async () => {
    const transport = new FakeAcpTransport();
    let authorityCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.readTextFile,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => ({ content: "secret" }),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport, {
      fs: { readTextFile: false, writeTextFile: false },
    });

    transport.emit({
      jsonrpc: "2.0",
      id: 17,
      method: "fs/read_text_file",
      params: { sessionId: "session-1", path: "/tmp/input" },
    });
    await waitFor(() => transport.writes.length === 2);

    expect(authorityCalls).toBe(0);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 17,
      error: { code: -32601, message: "Method not available" },
    });
  });

  it("uses the immutable advertised capability snapshot for reverse authority", async () => {
    const transport = new FakeAcpTransport();
    let authorityCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.readTextFile,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => ({ content: "not-reached" }),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    const clientCapabilities = {
      fs: { readTextFile: false, writeTextFile: false },
    };
    const initialize = binding.initialize({
      protocolVersion: 1,
      clientCapabilities,
    });
    await waitFor(() => transport.writes.length === 1);
    clientCapabilities.fs.readTextFile = true;
    const id = transport.parsedWrite(0).id;
    transport.emit({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } });
    await initialize;
    transport.emit({
      jsonrpc: "2.0",
      id: 18,
      method: "fs/read_text_file",
      params: { sessionId: "session-1", path: "/tmp/input" },
    });
    await waitFor(() => transport.writes.length === 2);

    expect(authorityCalls).toBe(0);
    expect(transport.parsedWrite(0)).toMatchObject({
      params: {
        clientCapabilities: { fs: { readTextFile: false } },
      },
    });
  });

  it.each([
    {
      name: "read filesystem without a handler",
      capabilities: { fs: { readTextFile: true } },
    },
    {
      name: "write filesystem without a handler",
      capabilities: { fs: { writeTextFile: true } },
    },
    {
      name: "terminal without all five handlers",
      capabilities: { terminal: true },
    },
    {
      name: "plan updates without a session-update handler",
      capabilities: { plan: {} },
    },
    { name: "reserved elicitation", capabilities: { elicitation: {} } },
    { name: "reserved NES", capabilities: { nes: {} } },
  ])(
    "rejects untruthful client capability advertisement: $name",
    async ({ capabilities }) => {
      const transport = new FakeAcpTransport();
      const binding = trackedBinding(transport);

      await expect(
        binding.initialize({
          protocolVersion: 1,
          clientCapabilities: capabilities as ClientCapabilities,
        }),
      ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
      expect(transport.writes).toHaveLength(0);
      expect(binding.diagnostics()).toMatchObject({
        initialized: false,
        pendingRequests: 0,
      });
    },
  );

  it("enforces immutable boolean-config negotiation before send and on ingress", async () => {
    const deniedTransport = new FakeAcpTransport();
    const deniedBinding = trackedBinding(deniedTransport);
    await initializeRaw(deniedBinding, deniedTransport);
    await expect(
      deniedBinding.request(ACP_AGENT_REQUESTS.setSessionConfigOption, {
        sessionId: "session",
        configId: "enabled",
        type: "boolean",
        value: true,
      }),
    ).rejects.toMatchObject({ code: "acp_binding_capability_denied" });
    expect(deniedTransport.writes).toHaveLength(1);

    const supportedTransport = new FakeAcpTransport();
    const supportedBinding = trackedBinding(supportedTransport);
    const advertised = {
      session: { configOptions: { boolean: {} as object | null } },
    };
    const initialize = supportedBinding.initialize({
      protocolVersion: 1,
      clientCapabilities: advertised,
    });
    await waitFor(() => supportedTransport.writes.length === 1);
    advertised.session.configOptions.boolean = null;
    supportedTransport.emit({
      jsonrpc: "2.0",
      id: supportedTransport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await initialize;
    const request = supportedBinding.request(
      ACP_AGENT_REQUESTS.setSessionConfigOption,
      {
        sessionId: "session",
        configId: "enabled",
        type: "boolean",
        value: true,
      },
    );
    await waitFor(() => supportedTransport.writes.length === 2);
    supportedTransport.emit({
      jsonrpc: "2.0",
      id: supportedTransport.parsedWrite(1).id,
      result: {
        configOptions: [
          {
            id: "enabled",
            name: "Enabled",
            type: "boolean",
            currentValue: true,
          },
        ],
      },
    });
    await expect(request).resolves.toMatchObject({
      configOptions: [{ id: "enabled", currentValue: true }],
    });

    const responseTransport = new FakeAcpTransport();
    const responseBinding = trackedBinding(responseTransport);
    await initializeRaw(responseBinding, responseTransport);
    const newSession = responseBinding.request(ACP_AGENT_REQUESTS.newSession, {
      cwd: "/workspace",
      mcpServers: [],
    });
    await waitFor(() => responseTransport.writes.length === 2);
    responseTransport.emit({
      jsonrpc: "2.0",
      id: responseTransport.parsedWrite(1).id,
      result: {
        sessionId: "session-new",
        configOptions: [
          {
            id: "enabled",
            name: "Enabled",
            type: "boolean",
            currentValue: false,
          },
        ],
      },
    });
    await expect(newSession).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(responseBinding.closed).resolves.toMatchObject({
      reason: "acp_response_invalid",
    });
  });

  it("rejects unadvertised boolean config updates before authority", async () => {
    const transport = new FakeAcpTransport();
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "enabled",
              name: "Enabled",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_invalid",
    });
    expect(authorityCalls).toBe(0);
  });

  it("correlates listed additional directories with immutable agent capability negotiation", async () => {
    const deniedTransport = new FakeAcpTransport();
    const deniedBinding = trackedBinding(deniedTransport);
    await initializeRaw(
      deniedBinding,
      deniedTransport,
      {},
      {
        sessionCapabilities: { list: {} },
      },
    );
    const denied = deniedBinding.request(ACP_AGENT_REQUESTS.listSessions, {});
    await waitFor(() => deniedTransport.writes.length === 2);
    deniedTransport.emit({
      jsonrpc: "2.0",
      id: deniedTransport.parsedWrite(1).id,
      result: {
        sessions: [
          {
            sessionId: "session",
            cwd: "/workspace",
            additionalDirectories: ["/extra"],
          },
        ],
      },
    });
    await expect(denied).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(deniedBinding.closed).resolves.toMatchObject({
      reason: "acp_response_invalid",
    });

    const allowedTransport = new FakeAcpTransport();
    const allowedBinding = trackedBinding(allowedTransport);
    await initializeRaw(
      allowedBinding,
      allowedTransport,
      {},
      {
        sessionCapabilities: { list: {}, additionalDirectories: {} },
      },
    );
    const allowed = allowedBinding.request(ACP_AGENT_REQUESTS.listSessions, {});
    await waitFor(() => allowedTransport.writes.length === 2);
    allowedTransport.emit({
      jsonrpc: "2.0",
      id: allowedTransport.parsedWrite(1).id,
      result: {
        sessions: [
          {
            sessionId: "session",
            cwd: "/workspace",
            additionalDirectories: ["/extra"],
          },
        ],
      },
    });
    await expect(allowed).resolves.toMatchObject({
      sessions: [{ additionalDirectories: ["/extra"] }],
    });
  });

  it("enforces negotiated outbound capabilities and one-shot initialization", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    await initializeRaw(binding, transport);

    await expect(
      binding.request(ACP_AGENT_REQUESTS.loadSession, {
        sessionId: "session-1",
        cwd: "/tmp",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: "acp_binding_capability_denied" });
    await expect(
      binding.request(ACP_AGENT_REQUESTS.initialize, { protocolVersion: 1 }),
    ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
    expect(transport.writes).toHaveLength(1);
  });

  it("binds authenticate to an exactly advertised auth method", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const initialize = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "browser", name: "Browser" }],
      },
    });
    await initialize;

    await expect(
      binding.request(ACP_AGENT_REQUESTS.authenticate, {
        methodId: "not-advertised",
      }),
    ).rejects.toMatchObject({ code: "acp_binding_capability_denied" });
    const authenticated = binding.request(ACP_AGENT_REQUESTS.authenticate, {
      methodId: "browser",
    });
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: {},
    });
    await expect(authenticated).resolves.toEqual({});
  });

  it("rejects auth methods whose client-side capability was not advertised", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const initialize = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "terminal", name: "Terminal", type: "terminal" }],
      },
    });

    await expect(initialize).rejects.toMatchObject({
      code: "acp_binding_protocol_violation",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_auth_method_not_advertised",
    });
  });

  it("rejects a permission response that was not one of the offered options", async () => {
    const transport = new FakeAcpTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => ({
        outcome: { outcome: "selected" as const, optionId: "not-offered" },
      }),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit(permissionRequest(19));
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 19,
      error: { code: -32603, message: "Request failed" },
    });
  });

  it("rejects ambiguous permission options and reverse allocation hints before authority", async () => {
    const transport = new FakeAcpTransport();
    let authorityCalls = 0;
    const permissionRegistration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => ({ outcome: { outcome: "cancelled" as const } }),
    });
    const terminalRegistrations = [
      ACP_CLIENT_REQUESTS.createTerminal,
      ACP_CLIENT_REQUESTS.terminalOutput,
      ACP_CLIENT_REQUESTS.releaseTerminal,
      ACP_CLIENT_REQUESTS.waitForTerminalExit,
      ACP_CLIENT_REQUESTS.killTerminal,
    ].map((descriptor) =>
      defineAcpReverseRequestHandler({
        descriptor: descriptor as AcpRequestDescriptor<unknown, unknown>,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => {
          throw new Error("invalid_terminal_request_reached");
        },
      }),
    );
    const binding = trackedBinding(transport, {
      reverseHandlers: [permissionRegistration, ...terminalRegistrations],
    });
    await initializeRaw(binding, transport, { terminal: true });
    transport.emit({
      jsonrpc: "2.0",
      id: 20,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [
          { optionId: "same", name: "Allow", kind: "allow_once" },
          { optionId: "same", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: 21,
      method: "terminal/create",
      params: {
        sessionId: "session-1",
        command: "true",
        outputByteLimit: SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES + 1,
      },
    });
    await waitFor(() => transport.writes.length === 3);

    expect(authorityCalls).toBe(0);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 20,
      error: { code: -32602, message: "Invalid params" },
    });
    expect(transport.parsedWrite(2)).toMatchObject({
      id: 21,
      error: { code: -32602, message: "Invalid params" },
    });
  });

  it("processes protocol cancellation while reverse work is active", async () => {
    const transport = new FakeAcpTransport();
    let handleCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: (request) => request.sessionId === "session-1",
      handle: async (_request, context) => {
        handleCalls += 1;
        await aborted(context.signal);
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);

    transport.emit(permissionRequest(31));
    await waitFor(() => handleCalls === 1);
    transport.emit({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 31 },
    });
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 31,
      error: { code: -32800, message: "Request cancelled" },
    });
    await waitFor(() => binding.diagnostics().activeReverseRequests === 0);
    expect(binding.diagnostics().handlerFailures).toBe(0);
  });

  it("rejects reverse overload request-locally without acquiring authority", async () => {
    const transport = new FakeAcpTransport();
    const authorityRequestIds: Array<string | number | undefined> = [];
    const handledRequestIds: Array<string | number | undefined> = [];
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: (_request, context) => {
        authorityRequestIds.push(context.requestId);
        return true;
      },
      handle: async (_request, context) => {
        handledRequestIds.push(context.requestId);
        await aborted(context.signal);
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: { maximumReverseRequests: 1 },
    });
    await initializeRaw(binding, transport);

    transport.emit(permissionRequest(35));
    await waitFor(() => handledRequestIds.length === 1);
    transport.emit(permissionRequest(36));
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 36,
      error: { code: -32000, message: "Server overloaded" },
    });
    expect(authorityRequestIds).toEqual([35]);
    expect(handledRequestIds).toEqual([35]);
    expect(binding.diagnostics()).toMatchObject({
      activeReverseRequests: 1,
      deniedReverseRequests: 1,
      pendingRequests: 0,
    });
    expect(binding.diagnostics().closeReason).toBeUndefined();

    transport.emit({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 35 },
    });
    await waitFor(() => binding.diagnostics().activeReverseRequests === 0);
  });

  it("rejects duplicate completed reverse IDs within the retained window", async () => {
    const transport = new FakeAcpTransport();
    let handleCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => {
        handleCalls += 1;
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit(permissionRequest(41));
    await waitFor(() => transport.writes.length === 2);
    transport.emit(permissionRequest(41));
    await binding.closed;

    expect(handleCalls).toBe(1);
    expect(transport.writes.join("\n")).not.toContain("private-handler-marker");
  });

  it("keeps reverse replay protection in a rolling retained window", async () => {
    const transport = new FakeAcpTransport();
    const handledIds: Array<string | number | undefined> = [];
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: (_request, context) => {
        handledIds.push(context.requestId);
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: { maximumTombstones: 1 },
    });
    await initializeRaw(binding, transport);
    transport.emit(permissionRequest(61));
    await waitFor(() => handledIds.length === 1);
    transport.emit(permissionRequest(62));
    await waitFor(() => handledIds.length === 2);
    transport.emit(permissionRequest(61));
    await waitFor(() => handledIds.length === 3);
    transport.emit(permissionRequest(61));
    await binding.closed;

    expect(handledIds).toEqual([61, 62, 61]);
    expect(binding.diagnostics()).toMatchObject({
      closeReason: "acp_reverse_id_duplicate",
    });
  });

  it("stays healthy across more sequential reverse requests than the retained ID window", async () => {
    const transport = new FakeAcpTransport();
    let handleCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => {
        handleCalls += 1;
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);

    for (let id = 1; id <= 300; id += 1) {
      transport.emit(permissionRequest(id));
      await waitFor(() => transport.writes.length === id + 1);
    }

    expect(handleCalls).toBe(300);
    expect(binding.diagnostics()).toMatchObject({
      activeReverseRequests: 0,
      protocolFailures: 0,
    });
    expect(binding.diagnostics().closeReason).toBeUndefined();
    transport.emit(permissionRequest(300));
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_id_duplicate",
    });
    expect(handleCalls).toBe(300);
  });

  it("tombstones rejected reverse IDs before later authority can be acquired", async () => {
    const transport = new FakeAcpTransport();
    let authorityCalls = 0;
    let handleCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => {
        handleCalls += 1;
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: { sessionId: "session-1" },
    });
    await waitFor(() => transport.writes.length === 2);
    transport.emit(permissionRequest(42));
    await binding.closed;

    expect(authorityCalls).toBe(0);
    expect(handleCalls).toBe(0);
  });

  it("redacts reverse handler failures from wire errors and diagnostics", async () => {
    const transport = new FakeAcpTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => {
        throw new Error("private-handler-marker");
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit(permissionRequest(51));
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 51,
      error: { code: -32603, message: "Request failed" },
    });
    expect(JSON.stringify(binding.diagnostics())).not.toContain(
      "private-handler-marker",
    );
    expect(transport.writes.join("\n")).not.toContain("private-handler-marker");
  });

  it("never follows an uncertain reverse success write with an error response", async () => {
    const transport = new FakeAcpTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => ({ outcome: { outcome: "cancelled" as const } }),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.failNextSend = "sent_outcome_unknown";
    transport.emit(permissionRequest(52));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_response_delivery_unknown",
    });
    expect(transport.writes).toHaveLength(2);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 52,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(
      transport.writes.slice(1).some((wire) => wire.includes('"error"')),
    ).toBe(false);
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "preserves %s delivery evidence when a reverse error response cannot be delivered",
    async (delivery) => {
      const transport = new FakeAcpTransport();
      const registration = defineAcpReverseRequestHandler({
        descriptor: ACP_CLIENT_REQUESTS.requestPermission,
        authorize: () => true,
        handle: () => {
          throw new Error("private-reverse-error-marker");
        },
      });
      const binding = trackedBinding(transport, {
        reverseHandlers: [registration],
      });
      await initializeRaw(binding, transport);
      transport.failNextSend = delivery;
      transport.emit(permissionRequest(53));

      await expect(binding.closed).resolves.toMatchObject({
        reason: "acp_error_response_delivery_failed",
        delivery,
      });
      expect(transport.writes).toHaveLength(
        delivery === "sent_outcome_unknown" ? 2 : 1,
      );
      expect(JSON.stringify(binding.diagnostics())).not.toContain(
        "private-reverse-error-marker",
      );
    },
  );

  it("classifies descriptor ordering failures without leaking them", async () => {
    const transport = new FakeAcpTransport();
    const validator: AcpValueValidator<{ sessionId: string }> = (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { sessionId?: unknown }).sessionId === "string";
    const descriptor = defineAcpExtensionNotification({
      method: "probe/update",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: validator,
      notificationOrderingKey: () => {
        throw new Error("private-ordering-marker");
      },
    });
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: () => undefined,
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit({
      jsonrpc: "2.0",
      method: "probe/update",
      params: { sessionId: "session" },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_ordering_key_invalid",
    });
    expect(JSON.stringify(binding.diagnostics())).not.toContain(
      "private-ordering-marker",
    );
  });

  it("keeps a connection healthy beyond 256 ignored notifications", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    await initializeRaw(binding, transport);

    for (let sequence = 0; sequence < 300; sequence += 1) {
      transport.emit(unknownNotification(`ignored-${sequence}`));
    }
    await waitFor(() => binding.diagnostics().ignoredNotifications === 300);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      ignoredNotifications: 300,
      protocolFailures: 0,
    });
  });

  it("keeps a connection healthy beyond 4 MiB of cumulative ignored notifications", async () => {
    const transport = new FakeAcpTransport();
    const notification = {
      jsonrpc: "2.0",
      method: "probe/unknown-notification",
      params: { padding: "x".repeat(1024 * 1024) },
    };
    const frameBytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    const binding = trackedBinding(transport);
    await initializeRaw(binding, transport);

    for (let sequence = 0; sequence < 5; sequence += 1) {
      transport.emit(notification);
    }
    await waitFor(() => binding.diagnostics().ignoredNotifications === 5);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      ignoredNotifications: 5,
      ignoredNotificationBytes: frameBytes * 5,
      protocolFailures: 0,
    });
    expect(binding.diagnostics().ignoredNotificationBytes).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    expect(JSON.stringify(binding.diagnostics())).not.toContain("xxxx");
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "preserves %s delivery classification",
    async (delivery) => {
      const transport = new FakeAcpTransport();
      transport.failNextSend = delivery;
      const binding = trackedBinding(transport);

      const result = binding.initialize({ protocolVersion: 1 });
      await expect(result).rejects.toMatchObject({ delivery });
      if (delivery === "sent_outcome_unknown") {
        await expect(binding.closed).resolves.toMatchObject({
          reason: "acp_request_delivery_unknown",
        });
      }
    },
  );

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "preserves %s delivery classification for public notifications",
    async (delivery) => {
      const transport = new FakeAcpTransport();
      const binding = trackedBinding(transport);
      await initializeRaw(binding, transport);
      transport.failNextSend = delivery;

      await expect(
        binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, {
          sessionId: "session-1",
        }),
      ).rejects.toMatchObject({ delivery });
      if (delivery === "sent_outcome_unknown") {
        await expect(binding.closed).resolves.toMatchObject({
          reason: "acp_notification_delivery_unknown",
        });
      } else {
        expect(binding.diagnostics().closed).toBe(false);
      }
    },
  );

  it("fences malformed envelopes, batches, null IDs, and invalid results", async () => {
    for (const malformed of [
      "not-json",
      JSON.stringify([]),
      JSON.stringify({ jsonrpc: "2.0", id: null, result: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 1.5, result: {} }),
    ]) {
      const transport = new FakeAcpTransport();
      const binding = trackedBinding(transport);
      transport.emitText(malformed);
      await expect(binding.closed).resolves.toMatchObject({
        reason: expect.stringMatching(/acp_|transport_/u),
      });
    }

    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const initialize = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    const id = transport.parsedWrite(0).id;
    transport.emit({ jsonrpc: "2.0", id, result: { protocolVersion: "one" } });
    await expect(initialize).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await binding.closed;
  });

  it("fences initialization when the agent selects an unadvertised position encoding", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const initialize = binding.initialize({
      protocolVersion: 1,
      clientCapabilities: { positionEncodings: ["utf-8"] },
    });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { positionEncoding: "utf-32" },
      },
    });

    await expect(initialize).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_response_invalid",
    });
    expect(binding.diagnostics().initialized).toBe(false);
  });

  it("classifies an otherwise valid incompatible protocol version", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    const initialize = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 2, agentCapabilities: {} },
    });

    await expect(initialize).rejects.toMatchObject({
      code: "acp_binding_protocol_violation",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_protocol_version_mismatch",
    });
  });

  it("fences a set-config success that contradicts the requested value", async () => {
    const transport = new FakeAcpTransport();
    const binding = trackedBinding(transport);
    await initializeRaw(binding, transport);
    const request = binding.request(ACP_AGENT_REQUESTS.setSessionConfigOption, {
      sessionId: "session",
      configId: "model",
      value: "a",
    });
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "b",
            options: [
              { value: "a", name: "A" },
              { value: "b", name: "B" },
            ],
          },
        ],
      },
    });

    await expect(request).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_response_invalid",
    });
  });

  it.each([
    {
      name: "denied",
      authorize: () => false,
      reason: "acp_notification_authority_denied",
    },
    {
      name: "throws",
      authorize: () => {
        throw new Error("private-notification-authority-marker");
      },
      reason: "acp_notification_handler_failed",
    },
  ])(
    "fences a $name ordered notification before later authority",
    async ({ authorize, reason }) => {
      const transport = new FakeAcpTransport();
      let authorityCalls = 0;
      const registration = defineAcpReverseNotificationHandler({
        descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
        authorize: () => {
          authorityCalls += 1;
          return authorize();
        },
        handle: () => {
          throw new Error("notification_dispatch_must_not_run");
        },
      });
      const binding = trackedBinding(transport, {
        reverseHandlers: [registration],
      });
      await initializeRaw(binding, transport);
      transport.emit(sessionUpdate("session-denied", "first"));
      transport.emit(sessionUpdate("session-denied", "second"));

      await expect(binding.closed).resolves.toMatchObject({ reason });
      expect(authorityCalls).toBe(1);
      expect(binding.diagnostics()).toMatchObject({
        deniedReverseRequests:
          reason === "acp_notification_authority_denied" ? 1 : 0,
        handlerFailures: reason === "acp_notification_handler_failed" ? 1 : 0,
      });
      expect(transport.writes).toHaveLength(1);
      expect(JSON.stringify(binding.diagnostics())).not.toContain(
        "private-notification-authority-marker",
      );
    },
  );

  it("keeps same-session notifications ordered while sessions progress independently", async () => {
    const transport = new FakeAcpTransport();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registration = defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => true,
      handle: async (notification) => {
        const text = notification.update;
        if (
          text.sessionUpdate === "agent_message_chunk" &&
          text.content.type === "text"
        ) {
          if (text.content.text === "a1") await firstBlocked;
          events.push(`${notification.sessionId}:${text.content.text}`);
        }
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit(sessionUpdate("session-a", "a1"));
    transport.emit(sessionUpdate("session-a", "a2"));
    transport.emit(sessionUpdate("session-b", "b1"));
    await waitFor(() => events.includes("session-b:b1"));
    expect(events).not.toContain("session-a:a2");
    releaseFirst();
    await waitFor(() => events.length === 3);
    expect(events).toEqual(["session-b:b1", "session-a:a1", "session-a:a2"]);
  });

  it.each([
    {
      name: "global",
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 2,
      },
      firstSessionId: "session-global-a",
      secondSessionId: "session-global-b",
    },
    {
      name: "same-ordering-key",
      limits: {
        maximumNotificationHandlers: 2,
        maximumNotificationsPerOrderingKey: 1,
      },
      firstSessionId: "session-key",
      secondSessionId: "session-key",
    },
  ])(
    "awaits $name notification watermark capacity without fencing",
    async ({ limits, firstSessionId, secondSessionId }) => {
      const transport = new FakeAcpTransport();
      const lane = blockingSessionUpdateLane();
      const binding = trackedBinding(transport, {
        reverseHandlers: [lane.registration],
        limits,
      });
      await initializeRaw(binding, transport);

      transport.emit(sessionUpdate(firstSessionId, "first"));
      await waitFor(() => lane.started.includes("first"));
      transport.emit(sessionUpdate(secondSessionId, "second"));
      await passEventLoopTurn();
      expect(lane.started).toEqual(["first"]);
      expect(binding.diagnostics()).toMatchObject({
        closed: false,
        activeNotifications: 1,
        pendingNotifications: 1,
      });

      lane.release("first");
      await waitFor(() => lane.started.includes("second"));
      expect(binding.diagnostics().closed).toBe(false);
      lane.release("second");
      await waitFor(() => binding.diagnostics().pendingNotifications === 0);
      expect(binding.diagnostics()).toMatchObject({
        closed: false,
        activeNotifications: 0,
        pendingNotifications: 0,
      });
    },
  );

  it("preserves inbound response order behind asynchronous notification backpressure", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const lane = blockingSessionUpdateLane();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [lane.registration],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initializeRaw(binding, transport);
    const response = binding.request(echo, { value: "response-control" });
    const responseState = observePromise(response);
    await waitFor(() => transport.writes.length === 2);

    transport.emit(sessionUpdate("session-control", "first"));
    await waitFor(() => lane.started.includes("first"));
    transport.emit(sessionUpdate("session-control", "second"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "response-observed" },
    });
    await passEventLoopTurn();
    expect(responseState.settled).toBe(false);
    expect(binding.diagnostics().closed).toBe(false);

    lane.release("first");
    await waitFor(() => lane.started.includes("second"));
    await expect(response).resolves.toEqual({ value: "response-observed" });
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      activeNotifications: 1,
      pendingNotifications: 1,
    });
    lane.release("second");
  });

  it("keeps locally initiated request cancellation serviceable while notification admission waits", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const lane = blockingSessionUpdateLane();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [lane.registration],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initializeRaw(binding, transport);
    const cancellation = new AbortController();
    const request = binding.request(
      echo,
      { value: "cancel-control" },
      { cancellationSignal: cancellation.signal },
    );
    await waitFor(() => transport.writes.length === 2);

    transport.emit(sessionUpdate("session-control", "first"));
    await waitFor(() => lane.started.includes("first"));
    transport.emit(sessionUpdate("session-control", "second"));
    cancellation.abort();
    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      method: "$/cancel_request",
      params: { requestId: transport.parsedWrite(1).id },
    });
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      activeNotifications: 1,
      pendingNotifications: 1,
    });

    lane.release("first");
    await waitFor(() => lane.started.includes("second"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "completed-after-cancel" },
    });
    await expect(request).resolves.toEqual({ value: "completed-after-cancel" });
    lane.release("second");
  });

  it("preserves protocol cancellation order behind asynchronous notification backpressure", async () => {
    const transport = new FakeAcpTransport();
    const lane = blockingSessionUpdateLane();
    let reverseSignal: AbortSignal | undefined;
    const binding = trackedBinding(transport, {
      reverseHandlers: [
        lane.registration,
        defineAcpReverseRequestHandler({
          descriptor: ACP_CLIENT_REQUESTS.requestPermission,
          authorize: () => true,
          handle: async (_request, context) => {
            reverseSignal = context.signal;
            await aborted(context.signal);
            return { outcome: { outcome: "cancelled" as const } };
          },
        }),
      ],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initializeRaw(binding, transport);
    transport.emit(permissionRequest(71));
    await waitFor(() => reverseSignal !== undefined);

    transport.emit(sessionUpdate("session-control", "first"));
    await waitFor(() => lane.started.includes("first"));
    transport.emit(sessionUpdate("session-control", "second"));
    transport.emit({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 71 },
    });
    await passEventLoopTurn();
    expect(reverseSignal?.aborted).toBe(false);
    expect(transport.writes).toHaveLength(1);

    lane.release("first");
    await waitFor(() => reverseSignal?.aborted === true);
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toEqual({
      jsonrpc: "2.0",
      id: 71,
      error: { code: -32800, message: "Request cancelled" },
    });
    expect(binding.diagnostics().closed).toBe(false);
    lane.release("second");
  });

  it("preserves reverse-request order behind asynchronous notification backpressure", async () => {
    const transport = new FakeAcpTransport();
    const lane = blockingSessionUpdateLane();
    let authorityCalls = 0;
    const binding = trackedBinding(transport, {
      reverseHandlers: [
        lane.registration,
        defineAcpReverseRequestHandler({
          descriptor: ACP_CLIENT_REQUESTS.requestPermission,
          authorize: () => {
            authorityCalls += 1;
            return true;
          },
          handle: () => ({ outcome: { outcome: "cancelled" as const } }),
        }),
      ],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initializeRaw(binding, transport);

    transport.emit(sessionUpdate("session-control", "first"));
    await waitFor(() => lane.started.includes("first"));
    transport.emit(sessionUpdate("session-control", "second"));
    transport.emit(permissionRequest(72));
    await passEventLoopTurn();
    expect(authorityCalls).toBe(0);
    expect(transport.writes).toHaveLength(1);

    lane.release("first");
    await waitFor(() => authorityCalls === 1);
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toEqual({
      jsonrpc: "2.0",
      id: 72,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(binding.diagnostics().closed).toBe(false);
    lane.release("second");
  });

  it("settles at an exact inbound response watermark and drains only pre-response keyed work", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const events: string[] = [];
    const releases = new Map<string, () => void>();
    const registration = defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => true,
      handle: async (notification) => {
        const update = notification.update;
        if (
          update.sessionUpdate !== "agent_message_chunk" ||
          update.content.type !== "text"
        ) {
          return;
        }
        const key = `${notification.sessionId}:${update.content.text}`;
        events.push(`start:${key}`);
        await new Promise<void>((resolve) => releases.set(key, resolve));
        events.push(`end:${key}`);
      },
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    const pending = binding.requestWithSettlement(
      echo,
      { value: "request" },
      { notificationCutover: { kind: "all" } },
    );
    await waitFor(() => transport.writes.length === 2);
    const request = transport.parsedWrite(1);

    transport.emit(sessionUpdate("session-a", "separate"));
    await waitFor(() => events.includes("start:session-a:separate"));
    // Synchronous queueing represents multiple already-framed messages from
    // one carrier read: both precede the response watermark.
    transport.emit(sessionUpdate("session-a", "same-read"));
    transport.emit(sessionUpdate("session-b", "other-key"));
    transport.emit({
      jsonrpc: "2.0",
      id: request.id,
      result: { value: "response" },
    });
    const settlement = await pending;
    expect(settlement).toMatchObject({
      kind: "success",
      response: { value: "response" },
      inboundSequence: expect.any(Number),
    });
    expect(Object.keys(settlement).sort()).toEqual([
      "commitNotificationCutover",
      "inboundSequence",
      "kind",
      "response",
    ]);
    expect(JSON.stringify(settlement)).not.toContain("same-read");

    transport.emit(sessionUpdate("session-a", "after-response"));
    let committed = false;
    const commit = settlement.commitNotificationCutover(() => {
      committed = true;
    });
    releases.get("session-a:separate")?.();
    await waitFor(() => events.includes("start:session-a:same-read"));
    expect(committed).toBe(false);
    releases.get("session-a:same-read")?.();
    expect(events).not.toContain("start:session-a:after-response");
    await waitFor(() => events.includes("start:session-b:other-key"));
    expect(committed).toBe(false);
    releases.get("session-b:other-key")?.();
    await commit;
    expect(committed).toBe(true);
    await waitFor(() => events.includes("start:session-a:after-response"));
    releases.get("session-a:after-response")?.();
  });

  it("returns drainable remote-error settlements and rejects drains after handler failure", async () => {
    const echo = syntheticEchoDescriptor();
    const remoteTransport = new FakeAcpTransport();
    let releaseRemote!: () => void;
    const remoteBinding = trackedBinding(remoteTransport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [
        defineAcpReverseNotificationHandler({
          descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          authorize: () => true,
          handle: async () =>
            await new Promise<void>((resolve) => {
              releaseRemote = resolve;
            }),
        }),
      ],
    });
    await initializeRaw(remoteBinding, remoteTransport);
    const remotePending = remoteBinding.requestWithSettlement(
      echo,
      { value: "remote" },
      {
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: "session-error",
        },
      },
    );
    await waitFor(() => remoteTransport.writes.length === 2);
    remoteTransport.emit(sessionUpdate("session-error", "before-error"));
    remoteTransport.emit({
      jsonrpc: "2.0",
      id: remoteTransport.parsedWrite(1).id,
      error: { code: -32_001, message: "private" },
    });
    const remote = await remotePending;
    expect(remote).toMatchObject({
      kind: "remote_error",
      error: { remoteCode: -32_001 },
    });
    let remoteCommitted = false;
    const remoteCommit = remote.commitNotificationCutover(() => {
      remoteCommitted = true;
    });
    await Promise.resolve();
    expect(remoteCommitted).toBe(false);
    releaseRemote();
    await remoteCommit;

    const failureTransport = new FakeAcpTransport();
    const failureBinding = trackedBinding(failureTransport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [
        defineAcpReverseNotificationHandler({
          descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          authorize: () => true,
          handle: () => {
            throw new Error("private-handler-failure");
          },
        }),
      ],
    });
    await initializeRaw(failureBinding, failureTransport);
    const failurePending = failureBinding.requestWithSettlement(
      echo,
      { value: "failure" },
      {
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: "session-failure",
        },
      },
    );
    await waitFor(() => failureTransport.writes.length === 2);
    failureTransport.emit(sessionUpdate("session-failure", "before-response"));
    failureTransport.emit({
      jsonrpc: "2.0",
      id: failureTransport.parsedWrite(1).id,
      result: { value: "response" },
    });
    const failure = await failurePending;
    await expect(
      failure.commitNotificationCutover(() => undefined),
    ).rejects.toThrow("acp_binding_closed");
    await expect(failureBinding.closed).resolves.toMatchObject({
      reason: "acp_notification_handler_failed",
    });
  });

  it("rejects overlapping cutovers and releases an abandoned gate on close", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    let handled = 0;
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
      reverseHandlers: [
        defineAcpReverseNotificationHandler({
          descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          authorize: () => true,
          handle: () => {
            handled += 1;
          },
        }),
      ],
    });
    await initializeRaw(binding, transport);
    await expect(
      binding.requestWithSettlement(echo, { value: "missing-options" }),
    ).rejects.toThrow("acp_binding_protocol_violation");
    const pending = binding.requestWithSettlement(
      echo,
      { value: "first" },
      {
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: "session-cutover",
        },
      },
    );
    await waitFor(() => transport.writes.length === 2);
    await expect(
      binding.requestWithSettlement(
        echo,
        { value: "overlap" },
        {
          notificationCutover: {
            kind: "ordering_key",
            orderingKey: "session-cutover",
          },
        },
      ),
    ).rejects.toThrow("acp_binding_overloaded");
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "settled" },
    });
    await pending;
    transport.emit(sessionUpdate("session-cutover", "blocked-after-response"));
    await binding.close("explicit_close");
    await expect(binding.closed).resolves.toMatchObject({
      reason: "explicit_close",
    });
    expect(handled).toBe(0);
  });

  it("abandons a cancelled settlement request and releases its keyed cutover", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
    });
    await initializeRaw(binding, transport);
    const cancellation = new AbortController();
    let abandonedSettlements = 0;
    const first = binding.requestWithSettlement(
      echo,
      { value: "abandon" },
      {
        cancellationSignal: cancellation.signal,
        abandonOnCancellation: true,
        onAbandonedSettlement: () => {
          abandonedSettlements += 1;
        },
        deadlineMilliseconds: null,
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: "session-abandon",
        },
      },
    );
    await waitFor(() => transport.writes.length === 2);
    const abandonedId = transport.parsedWrite(1).id;

    cancellation.abort();
    await expect(first).rejects.toMatchObject({
      code: "acp_binding_request_cancelled",
      delivery: "sent_outcome_unknown",
    });
    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      method: "$/cancel_request",
      params: { requestId: abandonedId },
    });
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingRequests: 0,
    });

    const second = binding.requestWithSettlement(
      echo,
      { value: "replacement" },
      {
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: "session-abandon",
        },
      },
    );
    await waitFor(() => transport.writes.length === 4);
    const replacementId = transport.parsedWrite(3).id;
    expect(transport.parsedWrite(2)).toMatchObject({
      method: "$/cancel_request",
      params: { requestId: abandonedId },
    });
    expect(transport.parsedWrite(3)).toMatchObject({
      id: replacementId,
      method: echo.method,
    });
    transport.emit({
      jsonrpc: "2.0",
      id: abandonedId,
      result: { value: "late-abandoned-response" },
    });
    await waitFor(() => binding.diagnostics().rejectedLateResponses === 1);
    expect(binding.diagnostics().closed).toBe(false);
    expect(abandonedSettlements).toBe(1);

    transport.emit({
      jsonrpc: "2.0",
      id: replacementId,
      result: { value: "replacement" },
    });
    const settlement = await second;
    expect(settlement).toMatchObject({
      kind: "success",
      response: { value: "replacement" },
    });
    await settlement.commitNotificationCutover(() => undefined);
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("reports not-sent when an abandonable request is cancelled before send", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
    });
    await initializeRaw(binding, transport);
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      binding.request(
        echo,
        { value: "never-sent" },
        {
          cancellationSignal: cancellation.signal,
          abandonOnCancellation: true,
        },
      ),
    ).rejects.toMatchObject({
      code: "acp_binding_request_cancelled",
      delivery: "not_sent",
    });
    expect(transport.writes).toHaveLength(1);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingRequests: 0,
    });
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "keeps abandon cancellation delivery failure %s carrier-fatal",
    async (delivery) => {
      const transport = new FakeAcpTransport();
      const echo = syntheticEchoDescriptor();
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [echo],
      });
      await initializeRaw(binding, transport);
      const cancellation = new AbortController();
      const request = binding.request(
        echo,
        { value: "cancel-delivery" },
        {
          cancellationSignal: cancellation.signal,
          abandonOnCancellation: true,
        },
      );
      await waitFor(() => transport.writes.length === 2);
      transport.failNextSend = delivery;

      cancellation.abort();
      await expect(request).rejects.toMatchObject({
        code: "acp_binding_closed",
        delivery: "sent_outcome_unknown",
      });
      await expect(binding.closed).resolves.toMatchObject({
        reason: "acp_cancel_delivery_failed",
        delivery,
      });
    },
  );

  it("rejects asynchronous cutover callbacks and releases the gate", async () => {
    const transport = new FakeAcpTransport();
    const echo = syntheticEchoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [echo],
    });
    await initializeRaw(binding, transport);
    const pending = binding.requestWithSettlement(
      echo,
      { value: "async-commit" },
      { notificationCutover: { kind: "all" } },
    );
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "settled" },
    });
    const settlement = await pending;
    await expect(
      settlement.commitNotificationCutover((() =>
        Promise.resolve()) as unknown as () => void),
    ).rejects.toThrow("acp_binding_protocol_violation");
    expect(binding.diagnostics().closed).toBe(false);
  });

  it("never starts queued session authority after the generation closes", async () => {
    const transport = new FakeAcpTransport();
    const handled: string[] = [];
    const registration = defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => true,
      handle: async (notification, context) => {
        const update = notification.update;
        if (
          update.sessionUpdate !== "agent_message_chunk" ||
          update.content.type !== "text"
        ) {
          return;
        }
        handled.push(update.content.text);
        if (update.content.text === "first") await aborted(context.signal);
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
    });
    await initializeRaw(binding, transport);
    transport.emit(sessionUpdate("session-close", "first"));
    transport.emit(sessionUpdate("session-close", "second"));
    await waitFor(() => handled.length === 1);

    await binding.close();

    expect(handled).toEqual(["first"]);
    expect(binding.diagnostics()).toMatchObject({
      activeNotifications: 0,
      pendingNotifications: 0,
      notificationOrderingKeys: 0,
    });
  });
});

function trackedBinding(
  transport: FakeAcpTransport,
  options: Omit<
    ConstructorParameters<typeof AcpBinding>[0],
    "transport" | "expectedScope" | "expectedConnectionGeneration"
  > = {},
): AcpBinding {
  const binding = new AcpBinding({
    transport,
    expectedScope: scope,
    expectedConnectionGeneration: 1,
    ...options,
  });
  activeBindings.push(binding);
  return binding;
}

async function initializeRaw(
  binding: AcpBinding,
  transport: FakeAcpTransport,
  clientCapabilities: Record<string, unknown> = {},
  agentCapabilities: Record<string, unknown> = {},
): Promise<void> {
  const pending = binding.initialize({
    protocolVersion: 1,
    clientCapabilities,
  });
  await waitFor(() => transport.writes.length === 1);
  const request = transport.parsedWrite(0);
  transport.emit({
    jsonrpc: "2.0",
    id: request.id,
    result: { protocolVersion: 1, agentCapabilities },
  });
  await pending;
}

function syntheticEchoDescriptor(): AcpRequestDescriptor<
  { value: string },
  { value: string }
> {
  const validator: AcpValueValidator<{ value: string }> = (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { value?: unknown }).value === "string";
  return defineAcpExtensionRequest<{ value: string }, { value: string }>({
    method: "probe/echo",
    direction: "client_to_agent",
    operation: "read",
    requiredProfile: "probe-v1",
    decodeRequest: decodeTestValue,
    decodeResponse: decodeTestValue,
    validateRequest: validator,
    validateResponse: validator,
  });
}

function permissionRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  };
}

function unknownNotification(label: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "probe/unknown-notification",
    params: { label },
  };
}

function sessionUpdate(
  sessionId: string,
  text: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

function blockingSessionUpdateLane(): {
  readonly registration: ReturnType<typeof defineAcpReverseNotificationHandler>;
  readonly started: string[];
  release(text: string): void;
} {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  return {
    registration: defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => true,
      handle: async (notification) => {
        const update = notification.update;
        if (
          update.sessionUpdate !== "agent_message_chunk" ||
          update.content.type !== "text"
        ) {
          return;
        }
        const text = update.content.text;
        started.push(text);
        await new Promise<void>((resolve) => releases.set(text, resolve));
      },
    }),
    started,
    release: (text) => {
      const release = releases.get(text);
      if (!release)
        throw new Error(`acp_test_notification_not_started:${text}`);
      releases.delete(text);
      release();
    },
  };
}

function observePromise(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function passEventLoopTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function objectStreamInput(): {
  readonly readable: ReadableStream<AnyMessage>;
  receive(message: AnyMessage): void;
} {
  let controller!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({
    start(value) {
      controller = value;
    },
  });
  return { readable, receive: (message) => controller.enqueue(message) };
}

class AsyncFrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #frames: InboundTextFrame[] = [];
  readonly #waiters: Array<(value: IteratorResult<InboundTextFrame>) => void> =
    [];
  #ended = false;

  push(frame: InboundTextFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: frame });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundTextFrame> {
    return {
      next: async () => {
        const frame = this.#frames.shift();
        if (frame) return { done: false, value: frame };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeAcpTransport implements FramedMessageTransport {
  readonly maximumFrameBytes = 128 * 1_024 * 1_024;
  readonly assurance = createOwnedProcessAssurance(
    scope,
    1,
    createEnvironmentOwnedProcessIdentity({
      kind: "owned_process",
      scope,
      channelId: `acp-test-${Math.random()}`,
      executable: { kind: "executable", canonicalPath: "/usr/bin/acp-test" },
      providerProcessIdentity: {
        type: "local_process_group",
        processId: 55_001,
        processGroupId: 55_001,
      },
    }),
    "acp_test",
  );
  readonly #queue = new AsyncFrameQueue();
  readonly frames = this.#queue;
  readonly writes: string[] = [];
  readonly closed: Promise<FramedTransportClosure>;
  failNextSend: "not_sent" | "sent_outcome_unknown" | undefined;
  onSend:
    | ((
        text: string,
        options?: { readonly signal?: AbortSignal },
      ) => Promise<void>)
    | undefined;
  #resolveClosed!: (closure: FramedTransportClosure) => void;
  #closed = false;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }> {
    const failure = this.failNextSend;
    this.failNextSend = undefined;
    if (failure) {
      if (failure === "sent_outcome_unknown") this.writes.push(text);
      throw new FrameWriteError("fake_acp_write_failed", failure);
    }
    if (this.#closed) throw new FrameWriteError("fake_acp_closed", "not_sent");
    this.writes.push(text);
    await this.onSend?.(text, options);
    return { disposition: "sent" };
  }

  parsedWrite(index: number): Record<string, unknown> {
    return JSON.parse(this.writes[index] ?? "null") as Record<string, unknown>;
  }

  emit(value: unknown): void {
    this.emitText(JSON.stringify(value));
  }

  emitText(text: string): void {
    this.#queue.push({ text, byteLength: Buffer.byteLength(text, "utf8") });
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.end();
    revokeFramedTransportAssurance(this.assurance);
    this.#resolveClosed({ reason });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("acp_test_wait_timeout");
}
