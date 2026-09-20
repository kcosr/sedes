import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironmentOwnedProcessIdentity,
  type EnvironmentChannelScope,
} from "../../src/server/execution/environment-channel.js";
import {
  AcpBinding,
  ACP_AGENT_NOTIFICATIONS,
  ACP_CLIENT_NOTIFICATIONS,
  ACP_CLIENT_REQUESTS,
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  defineAcpInlineReverseNotificationHandler,
  defineAcpReverseNotificationHandler,
  defineAcpReverseRequestHandler,
  type AcpRequestDescriptor,
  type AcpValueValidator,
} from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import { AcpRemoteError } from "../../src/server/provider-protocol/bindings/acp-v1/errors.js";
import {
  FrameWriteError,
  createOwnedProcessAssurance,
  revokeFramedTransportAssurance,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type InboundTextFrame,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";

const scope: EnvironmentChannelScope = Object.freeze({
  tenantId: "tenant-acp-conformance",
  principalId: "principal-acp-conformance",
  backendInstanceId: "backend-acp-conformance",
  executionEnvironmentId: "environment-acp-conformance",
});
const activeBindings: AcpBinding[] = [];
const decodeTestValue = <T>(value: unknown): T => value as T;

afterEach(async () => {
  await Promise.allSettled(
    activeBindings.splice(0).map(async (binding) => await binding.close()),
  );
});

describe("ACP V1 binding conformance boundaries", () => {
  it("requires exact active-profile descriptors and handlers for the opt-in", async () => {
    const descriptor = notificationDescriptor("probe/preinit-config", false);
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: () => undefined,
    });
    for (const options of [
      { profiles: ["probe-v1"], extensions: [descriptor] },
      { extensions: [descriptor], reverseHandlers: [registration] },
      {
        profiles: ["probe-v1"],
        extensions: [descriptor],
        reverseHandlers: [registration],
        duplicateDescriptor: true,
      },
    ]) {
      const transport = new ConformanceTransport();
      expect(
        () =>
          new AcpBinding({
            transport,
            expectedScope: scope,
            expectedConnectionGeneration: 1,
            ...options,
            preInitializeNotificationBuffer: {
              descriptors:
                "duplicateDescriptor" in options
                  ? [descriptor, descriptor]
                  : [descriptor],
              maximumCount: 1,
              maximumAggregateFrameBytes: 4_096,
            },
          }),
      ).toThrow("acp_preinitialize_notification_buffer_invalid");
      await transport.close("test_complete");
    }
  });

  it("keeps pre-initialize notification handling strict by default", async () => {
    const descriptor = notificationDescriptor("probe/preinit-default", false);
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "early"));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_not_available",
    });
    await expect(pending).rejects.toMatchObject({
      code: "acp_binding_closed",
    });
    expect(authorityCalls).toBe(0);
  });

  it("buffers only the exact opted-in route", async () => {
    const opted = notificationDescriptor("probe/preinit-opted", false);
    const notOpted = notificationDescriptor("probe/preinit-not-opted", false);
    let optedAuthorityCalls = 0;
    let notOptedAuthorityCalls = 0;
    const optedRegistration = defineAcpReverseNotificationHandler({
      descriptor: opted,
      authorize: () => {
        optedAuthorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const notOptedRegistration = defineAcpReverseNotificationHandler({
      descriptor: notOpted,
      authorize: () => {
        notOptedAuthorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [opted, notOpted],
      reverseHandlers: [optedRegistration, notOptedRegistration],
      preInitializeNotificationBuffer: {
        descriptors: [opted],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(notOpted.method, "denied"));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_not_available",
    });
    await expect(pending).rejects.toMatchObject({ code: "acp_binding_closed" });
    expect(optedAuthorityCalls).toBe(0);
    expect(notOptedAuthorityCalls).toBe(0);
  });

  it.each(["notification-first", "response-first"] as const)(
    "admits an opted-in notification exactly once for a %s initialize batch",
    async (order) => {
      const descriptor = notificationDescriptor(
        `probe/preinit-${order}`,
        false,
      );
      const handled: string[] = [];
      let authorityCalls = 0;
      const registration = defineAcpReverseNotificationHandler({
        descriptor,
        authorize: (params) => {
          authorityCalls += 1;
          return params.sessionId === "early";
        },
        handle: (params) => {
          handled.push(params.sessionId);
        },
      });
      const transport = new ConformanceTransport();
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [descriptor],
        reverseHandlers: [registration],
        preInitializeNotificationBuffer: {
          descriptors: [descriptor],
          maximumCount: 2,
          maximumAggregateFrameBytes: 4_096,
        },
      });
      const pending = binding.initialize({ protocolVersion: 1 });
      await waitFor(() => transport.writes.length === 1);
      const response = {
        jsonrpc: "2.0",
        id: transport.parsedWrite(0).id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      };
      const early = notification(descriptor.method, "early");
      for (const frame of order === "notification-first"
        ? [early, response]
        : [response, early]) {
        transport.emit(frame);
      }

      await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
      expect(authorityCalls).toBe(1);
      expect(handled).toEqual(["early"]);
      expect(binding.diagnostics()).toMatchObject({
        initialized: true,
        closed: false,
        preInitializeBufferedNotifications: 0,
        preInitializeBufferedNotificationBytes: 0,
      });
    },
  );

  it("buffers without pre-initialize authority and drains in arrival order", async () => {
    const descriptor = notificationDescriptor("probe/preinit-order", false);
    const authorized: string[] = [];
    const handled: string[] = [];
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: (params) => {
        authorized.push(params.sessionId);
        return true;
      },
      handle: (params) => {
        handled.push(params.sessionId);
      },
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 3,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "first"));
    transport.emit(notification(descriptor.method, "second"));
    await waitFor(
      () => binding.diagnostics().preInitializeBufferedNotifications === 2,
    );
    expect(authorized).toEqual([]);
    expect(handled).toEqual([]);
    expect(
      binding.diagnostics().preInitializeBufferedNotificationBytes,
    ).toBeGreaterThan(0);

    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await pending;
    expect(authorized).toEqual(["first", "second"]);
    expect(handled).toEqual(["first", "second"]);
  });

  it("validates an opted-in buffered notification exactly once", async () => {
    let validationCalls = 0;
    const validator: AcpValueValidator<{ sessionId: string }> = (value) => {
      validationCalls += 1;
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        typeof (value as { sessionId?: unknown }).sessionId === "string"
      );
    };
    const descriptor = defineAcpExtensionNotification({
      method: "probe/preinit-validate-once",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: validator,
      notificationOrderingKey: (params: { sessionId: string }) =>
        params.sessionId,
    });
    const handled: string[] = [];
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: (params) => {
        handled.push(params.sessionId);
      },
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "once"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });

    await pending;
    expect(validationCalls).toBe(1);
    expect(handled).toEqual(["once"]);
  });

  it("fails closed and clears buffered state when startup ordering throws", async () => {
    const validator: AcpValueValidator<{ sessionId: string }> = (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { sessionId?: unknown }).sessionId === "string";
    const descriptor = defineAcpExtensionNotification({
      method: "probe/preinit-ordering-failure",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: validator,
      notificationOrderingKey: () => {
        throw new Error("private-preinit-ordering-marker");
      },
    });
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 2,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "first"));
    transport.emit(notification(descriptor.method, "second"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_ordering_key_invalid",
    });
    await expect(pending).rejects.toMatchObject({ code: "acp_binding_closed" });
    expect(authorityCalls).toBe(0);
    expect(binding.diagnostics()).toMatchObject({
      preInitializeBufferedNotifications: 0,
      preInitializeBufferedNotificationBytes: 0,
    });
    expect(JSON.stringify(binding.diagnostics())).not.toContain(
      "private-preinit-ordering-marker",
    );
  });

  it("applies negotiated capability denial before buffered authority", async () => {
    let validationCalls = 0;
    let authorityCalls = 0;
    const descriptor = defineAcpExtensionNotification({
      method: "probe/preinit-capability-denied",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: (value): value is { sessionId: string } => {
        validationCalls += 1;
        return (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          Object.keys(value).length === 1 &&
          typeof (value as { sessionId?: unknown }).sessionId === "string"
        );
      },
      reverseCapability: () => false,
    });
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "denied"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_invalid",
    });
    await expect(pending).rejects.toMatchObject({ code: "acp_binding_closed" });
    expect(validationCalls).toBe(1);
    expect(authorityCalls).toBe(0);
  });

  it("does not block response consumption behind the pre-initialize drain", async () => {
    const descriptor = notificationDescriptor("probe/preinit-drain", false);
    const echo = echoDescriptor();
    const handled: string[] = [];
    let binding!: AcpBinding;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: async (params) => {
        if (params.sessionId === "early") {
          await expect(
            binding.request(echo, { value: "from-handler" }),
          ).resolves.toEqual({ value: "handler-response" });
        }
        handled.push(params.sessionId);
      },
    });
    const transport = new ConformanceTransport();
    binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor, echo],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "early"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await waitFor(() => transport.writes.length === 2);
    transport.emit(notification(descriptor.method, "later"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "handler-response" },
    });

    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
    await waitFor(() => handled.length === 2);
    expect(handled).toEqual(["early", "later"]);
    expect(binding.diagnostics()).toMatchObject({
      initialized: true,
      closed: false,
    });
  });

  it("charges post-initialize traffic to queue bounds while startup drain is blocked", async () => {
    const descriptor = notificationDescriptor(
      "probe/preinit-blocked-flood",
      false,
    );
    const authorized: string[] = [];
    let releaseEarly!: () => void;
    const earlyGate = new Promise<void>((resolve) => {
      releaseEarly = resolve;
    });
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: (params) => {
        authorized.push(params.sessionId);
        return true;
      },
      handle: async (params, context) => {
        if (params.sessionId === "early") {
          await Promise.race([earlyGate, untilAborted(context.signal)]);
        }
      },
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
      limits: {
        maximumNotificationHandlers: 2,
        reverseRequestDeadlineMilliseconds: 1_000,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "early"));
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await waitFor(() => authorized.length === 1);
    transport.emit(notification(descriptor.method, "queued-1"));
    transport.emit(notification(descriptor.method, "overflow"));
    await waitFor(() => binding.diagnostics().pendingNotifications === 2);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingNotifications: 2,
      protocolFailures: 0,
    });
    expect(authorized).toEqual(["early"]);
    releaseEarly();
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
    await waitFor(() => authorized.length === 3);
    expect(new Set(authorized)).toEqual(
      new Set(["early", "queued-1", "overflow"]),
    );
    await waitFor(() => binding.diagnostics().pendingNotifications === 0);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      protocolFailures: 0,
    });
  });

  it("fences malformed active pre-initialize notification params", async () => {
    const descriptor = notificationDescriptor("probe/preinit-denial", false);
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit({
      jsonrpc: "2.0",
      method: descriptor.method,
      params: { sessionId: 7 },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_invalid",
    });
    await expect(pending).rejects.toMatchObject({
      code: "acp_binding_closed",
    });
    expect(authorityCalls).toBe(0);
    expect(binding.diagnostics()).toMatchObject({
      preInitializeBufferedNotifications: 0,
      preInitializeBufferedNotificationBytes: 0,
    });
  });

  it("bounded-ignores unknown notifications before, during, and after initialize", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport);
    const unknown = {
      jsonrpc: "2.0",
      method: "probe/private-unknown-method",
      params: { privateMarker: "private-unknown-params" },
    };
    transport.emit(unknown);
    await waitFor(() => binding.diagnostics().ignoredNotifications === 1);

    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(unknown);
    await waitFor(() => binding.diagnostics().ignoredNotifications === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await pending;
    transport.emit(unknown);
    await waitFor(() => binding.diagnostics().ignoredNotifications === 3);

    const diagnostics = binding.diagnostics();
    expect(diagnostics).toMatchObject({
      initialized: true,
      closed: false,
      ignoredNotifications: 3,
      ignoredNotificationBytes:
        3 * Buffer.byteLength(JSON.stringify(unknown), "utf8"),
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private-unknown-method|private-unknown-params|privateMarker/u,
    );
  });

  it("bounded-ignores notifications without an active handler or profile", async () => {
    let validatorCalls = 0;
    const inactiveValidator: AcpValueValidator<{ sessionId: string }> = () => {
      validatorCalls += 1;
      return false;
    };
    const noHandler = defineAcpExtensionNotification({
      method: "probe/no-handler",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: inactiveValidator,
    });
    const inactiveProfile = defineAcpExtensionNotification({
      method: "probe/inactive-profile",
      direction: "agent_to_client",
      operation: "control",
      requiredProfile: "probe-v1",
      decodeParams: decodeTestValue,
      validateParams: inactiveValidator,
    });
    let authorityCalls = 0;
    const inactiveRegistration = defineAcpReverseNotificationHandler({
      descriptor: inactiveProfile,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      extensions: [noHandler, inactiveProfile],
      reverseHandlers: [inactiveRegistration],
    });
    await initialize(binding, transport);
    transport.emit(notification(noHandler.method, "ignored-no-handler"));
    transport.emit(
      notification(inactiveProfile.method, "ignored-inactive-profile"),
    );
    await waitFor(() => binding.diagnostics().ignoredNotifications === 2);

    expect(authorityCalls).toBe(0);
    expect(validatorCalls).toBe(0);
    expect(binding.diagnostics()).toMatchObject({
      initialized: true,
      closed: false,
      ignoredNotifications: 2,
      deniedReverseRequests: 0,
      protocolFailures: 0,
    });
  });

  it("route-filters a bounded unowned notification before semantic decoding", async () => {
    const descriptor = notificationDescriptor("probe/owned-resource", true);
    let authorityCalls = 0;
    let handlerCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      disposition: (params) =>
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params) &&
        (params as { readonly sessionId?: unknown }).sessionId === "owned"
          ? "dispatch"
          : "ignore",
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => {
        handlerCalls += 1;
      },
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initialize(binding, transport);

    for (let index = 0; index < 100; index += 1) {
      transport.emit({
        jsonrpc: "2.0",
        method: descriptor.method,
        params: { sessionId: `child-${index}`, unconsumed: { marker: index } },
      });
    }
    transport.emit(notification(descriptor.method, "owned"));
    await waitFor(() => handlerCalls === 1);

    expect(authorityCalls).toBe(1);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingNotifications: 0,
      notificationOrderingKeys: 0,
      protocolFailures: 0,
    });
  });

  it("keeps inline depended-on bursts and responses live beside admitted asynchronous work", async () => {
    const descriptor = notificationDescriptor("probe/inline-burst", true);
    const asynchronousDescriptor = notificationDescriptor(
      "probe/asynchronous-blocker",
      true,
    );
    const echo = echoDescriptor();
    const handled: string[] = [];
    const registration = defineAcpInlineReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: ({ sessionId }) => handled.push(sessionId),
    });
    let asynchronousStarted = false;
    let releaseAsynchronous!: () => void;
    const asynchronousGate = new Promise<void>((resolve) => {
      releaseAsynchronous = resolve;
    });
    const asynchronousRegistration = defineAcpReverseNotificationHandler({
      descriptor: asynchronousDescriptor,
      authorize: () => true,
      handle: async () => {
        asynchronousStarted = true;
        await asynchronousGate;
      },
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor, asynchronousDescriptor, echo],
      reverseHandlers: [registration, asynchronousRegistration],
      limits: {
        maximumNotificationHandlers: 1,
        maximumNotificationsPerOrderingKey: 1,
      },
    });
    await initialize(binding, transport);

    transport.emit(
      notification(asynchronousDescriptor.method, "asynchronous-owned"),
    );
    await waitFor(() => asynchronousStarted);
    const response = binding.request(echo, { value: "after-inline-burst" });
    await waitFor(() => transport.writes.length === 2);

    for (let index = 0; index < 100; index += 1) {
      transport.emit(notification(descriptor.method, `owned-${index}`));
    }
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "response-after-inline-burst" },
    });
    await waitFor(() => handled.length === 100);
    await expect(response).resolves.toEqual({
      value: "response-after-inline-burst",
    });

    expect(handled.at(0)).toBe("owned-0");
    expect(handled.at(-1)).toBe("owned-99");
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      activeNotifications: 1,
      pendingNotifications: 1,
      notificationOrderingKeys: 1,
      protocolFailures: 0,
    });
    releaseAsynchronous();
    await waitFor(() => binding.diagnostics().pendingNotifications === 0);
  });

  it("bounded-ignores a wrong-direction method encoded as a notification", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport);
    await initialize(binding, transport);
    transport.emit({
      jsonrpc: "2.0",
      method: ACP_AGENT_NOTIFICATIONS.cancelSession.method,
      params: { privateMarker: "wrong-direction" },
    });
    await waitFor(() => binding.diagnostics().ignoredNotifications === 1);

    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      ignoredNotifications: 1,
      protocolFailures: 0,
    });
  });

  it("keeps valid ignored-notification volume diagnostic-only", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport);
    for (let sequence = 0; sequence < 257; sequence += 1) {
      transport.emit({
        jsonrpc: "2.0",
        method: "probe/ignored-overflow",
        params: { privateMarker: sequence },
      });
    }
    transport.emit({
      jsonrpc: "2.0",
      method: "probe/ignored-overflow",
      params: { padding: "x".repeat(4 * 1024 * 1024) },
    });

    await waitFor(() => binding.diagnostics().ignoredNotifications === 258);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      ignoredNotifications: 258,
      protocolFailures: 0,
    });
    expect(binding.diagnostics().ignoredNotificationBytes).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    expect(JSON.stringify(binding.diagnostics())).not.toContain("xxxx");
  });

  it("still validates and fences malformed active notifications", async () => {
    const descriptor = notificationDescriptor("probe/active-malformed", false);
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
    });
    await initialize(binding, transport);
    transport.emit({
      jsonrpc: "2.0",
      method: descriptor.method,
      params: { sessionId: 7 },
    });

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_invalid",
    });
    expect(authorityCalls).toBe(0);
    expect(binding.diagnostics().ignoredNotifications).toBe(0);
  });

  it("denies rather than buffers a pre-initialize reverse request", async () => {
    const descriptor = notificationDescriptor("probe/preinit-reverse", false);
    const notificationRegistration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: () => undefined,
    });
    let requestAuthorityCalls = 0;
    const requestRegistration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => {
        requestAuthorityCalls += 1;
        return true;
      },
      handle: () => ({ outcome: { outcome: "cancelled" as const } }),
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [notificationRegistration, requestRegistration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(permissionRequest(404));
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 404,
      error: { code: -32601, message: "Method not available" },
    });
    expect(requestAuthorityCalls).toBe(0);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(0).id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    await pending;
  });

  it("fences bounded pre-initialize notification count and bytes", async () => {
    for (const limit of ["count", "bytes"] as const) {
      const descriptor = notificationDescriptor(
        `probe/preinit-overflow-${limit}`,
        false,
      );
      let authorityCalls = 0;
      const registration = defineAcpReverseNotificationHandler({
        descriptor,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => undefined,
      });
      const transport = new ConformanceTransport();
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [descriptor],
        reverseHandlers: [registration],
        preInitializeNotificationBuffer: {
          descriptors: [descriptor],
          maximumCount: limit === "count" ? 1 : 2,
          maximumAggregateFrameBytes: limit === "bytes" ? 1 : 4_096,
        },
      });
      const pending = binding.initialize({ protocolVersion: 1 });
      await waitFor(() => transport.writes.length === 1);
      transport.emit(notification(descriptor.method, "first"));
      if (limit === "count") {
        transport.emit(notification(descriptor.method, "second"));
      }
      await expect(binding.closed).resolves.toMatchObject({
        reason: "acp_preinitialize_notification_buffer_overloaded",
      });
      await expect(pending).rejects.toMatchObject({
        code: "acp_binding_closed",
      });
      expect(authorityCalls).toBe(0);
    }
  });

  it("discards buffered notifications when initialize fails or closes", async () => {
    for (const outcome of ["error", "close"] as const) {
      const descriptor = notificationDescriptor(
        `probe/preinit-discard-${outcome}`,
        false,
      );
      let authorityCalls = 0;
      const registration = defineAcpReverseNotificationHandler({
        descriptor,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => undefined,
      });
      const transport = new ConformanceTransport();
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [descriptor],
        reverseHandlers: [registration],
        preInitializeNotificationBuffer: {
          descriptors: [descriptor],
          maximumCount: 1,
          maximumAggregateFrameBytes: 4_096,
        },
      });
      const pending = binding.initialize({ protocolVersion: 1 });
      await waitFor(() => transport.writes.length === 1);
      transport.emit(notification(descriptor.method, "discard"));
      await waitFor(
        () => binding.diagnostics().preInitializeBufferedNotifications === 1,
      );
      if (outcome === "error") {
        transport.emit({
          jsonrpc: "2.0",
          id: transport.parsedWrite(0).id,
          error: { code: -32_603, message: "initialize failed" },
        });
        await expect(pending).rejects.toBeInstanceOf(AcpRemoteError);
        await expect(binding.closed).resolves.toMatchObject({
          reason: "acp_initialize_failed_with_buffered_notifications",
        });
      } else {
        await binding.close("test_close");
        await expect(pending).rejects.toMatchObject({
          code: "acp_binding_closed",
        });
      }
      expect(authorityCalls).toBe(0);
      expect(binding.diagnostics()).toMatchObject({
        initialized: false,
        preInitializeBufferedNotifications: 0,
        preInitializeBufferedNotificationBytes: 0,
      });
    }
  });

  it("preserves the primary timeout reason while fencing buffered initialize state", async () => {
    const descriptor = notificationDescriptor("probe/preinit-timeout", false);
    let authorityCalls = 0;
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => undefined,
    });
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      preInitializeNotificationBuffer: {
        descriptors: [descriptor],
        maximumCount: 1,
        maximumAggregateFrameBytes: 4_096,
      },
      limits: { requestDeadlineMilliseconds: 10 },
    });
    const pending = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    transport.emit(notification(descriptor.method, "timeout"));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_deadline",
    });
    await expect(pending).rejects.toMatchObject({
      code: "acp_binding_request_deadline",
    });
    expect(authorityCalls).toBe(0);
  });

  it("fences a reverse deadline without waiting on a blocked response send", async () => {
    const transport = new ConformanceTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: async () => await new Promise<never>(() => undefined),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: { reverseRequestDeadlineMilliseconds: 5 },
    });
    await initialize(binding, transport);
    transport.failClose = true;
    transport.blockNextSend();

    transport.emit(permissionRequest(1));
    await expect(binding.closed).resolves.toEqual({
      reason: "acp_reverse_request_deadline",
      transportCleanup: "failed",
      continuations: "unsettled",
    });
    expect(transport.writes).toHaveLength(1);
    expect(binding.diagnostics()).toMatchObject({
      activeReverseRequests: 1,
      pendingRequests: 0,
      handlerFailures: 1,
    });
  });

  it("uses one reverse deadline across handler work and response delivery", async () => {
    const transport = new ConformanceTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: { reverseRequestDeadlineMilliseconds: 80 },
    });
    await initialize(binding, transport);
    transport.blockNextSend();
    const startedAt = Date.now();
    transport.emit(permissionRequest(88));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_request_deadline",
      delivery: "sent_outcome_unknown",
    });
    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(transport.writes).toHaveLength(2);
  });

  it("keeps the admission deadline primary when a reverse error frame blocks", async () => {
    const transport = new ConformanceTransport();
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        throw new Error("private-reverse-error");
      },
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: { reverseRequestDeadlineMilliseconds: 60 },
    });
    await initialize(binding, transport);
    transport.blockNextSend();
    transport.emit(permissionRequest(89));

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_request_deadline",
      delivery: "sent_outcome_unknown",
    });
    expect(transport.writes).toHaveLength(2);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 89,
      error: { code: -32603, message: "Request failed" },
    });
  });

  it("enforces reverse and notification deadlines after synchronous work blocks timers", async () => {
    const reverseTransport = new ConformanceTransport();
    const reverseRegistration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => true,
      handle: () => {
        busyLoop(20);
        return { outcome: { outcome: "cancelled" as const } };
      },
    });
    const reverseBinding = trackedBinding(reverseTransport, {
      reverseHandlers: [reverseRegistration],
      limits: { reverseRequestDeadlineMilliseconds: 5 },
    });
    await initialize(reverseBinding, reverseTransport);
    reverseTransport.emit(permissionRequest(90));
    await expect(reverseBinding.closed).resolves.toMatchObject({
      reason: "acp_reverse_request_deadline",
    });
    expect(reverseTransport.writes).toHaveLength(1);

    const notificationTransport = new ConformanceTransport();
    const descriptor = notificationDescriptor("probe/sync-deadline", true);
    const notificationRegistration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: () => {
        busyLoop(20);
        throw new Error("private-sync-notification");
      },
    });
    const notificationBinding = trackedBinding(notificationTransport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [notificationRegistration],
      limits: { reverseRequestDeadlineMilliseconds: 5 },
    });
    await initialize(notificationBinding, notificationTransport);
    notificationTransport.emit(notification("probe/sync-deadline", "s"));
    await expect(notificationBinding.closed).resolves.toMatchObject({
      reason: "acp_notification_deadline",
    });
    expect(JSON.stringify(notificationBinding.diagnostics())).not.toContain(
      "private-sync-notification",
    );
  });

  it("enforces the outbound deadline after a synchronous response validator", async () => {
    const transport = new ConformanceTransport();
    const base = echoDescriptor();
    const descriptor = defineAcpExtensionRequest({
      method: "probe/sync-response",
      direction: "client_to_agent",
      operation: "read",
      requiredProfile: "probe-v1",
      decodeRequest: decodeTestValue,
      decodeResponse: decodeTestValue,
      validateRequest: base.validateRequest,
      validateResponse: (value: unknown) => {
        busyLoop(20);
        return base.validateResponse(value);
      },
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initialize(binding, transport);
    const request = binding.request(
      descriptor,
      { value: "request" },
      { deadlineMilliseconds: 5 },
    );
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "response" },
    });

    await expect(request).rejects.toMatchObject({
      code: "acp_binding_request_deadline",
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_deadline",
      delivery: "sent_outcome_unknown",
    });
  });

  it("validates local deadline options before consuming the finite request ID budget", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      limits: { maximumOutboundRequestsPerGeneration: 1 },
    });

    await expect(
      binding.initialize({ protocolVersion: 1 }, { deadlineMilliseconds: 0 }),
    ).rejects.toMatchObject({ code: "acp_binding_protocol_violation" });
    expect(transport.writes).toHaveLength(0);

    const initializeRequest = binding.initialize({ protocolVersion: 1 });
    await waitFor(() => transport.writes.length === 1);
    expect(transport.parsedWrite(0).id).toBe("sedes-acp-1");
    transport.emit({
      jsonrpc: "2.0",
      id: "sedes-acp-1",
      result: { protocolVersion: 1 },
    });
    await expect(initializeRequest).resolves.toMatchObject({
      protocolVersion: 1,
    });
  });

  it("bounds an outbound write by the request deadline even when send ignores close", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      limits: { requestDeadlineMilliseconds: 10 },
    });
    await initialize(binding, transport);
    const release = transport.blockNextSend();

    const request = binding.request(
      descriptor,
      { value: "bounded-write" },
      { deadlineMilliseconds: 5 },
    );
    await expect(request).rejects.toMatchObject({
      code: "acp_binding_request_deadline",
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_request_deadline",
      delivery: "sent_outcome_unknown",
    });
    expect(binding.diagnostics().pendingRequests).toBe(0);
    expect(transport.writes).toHaveLength(2);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(binding.diagnostics()).toMatchObject({
      closed: true,
      pendingRequests: 0,
    });
  });

  it("bounds a public notification write even when send ignores close", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      limits: { requestDeadlineMilliseconds: 5 },
    });
    await initialize(binding, transport);
    const release = transport.blockNextSend();

    await expect(
      binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, {
        sessionId: "session",
      }),
    ).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_notification_delivery_unknown",
    });
    expect(transport.writes).toHaveLength(2);
    release();
  });

  it("keeps abort-ignoring reverse work inside the concurrency bound", async () => {
    const transport = new ConformanceTransport();
    let authorityCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: async () => await new Promise<never>(() => undefined),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: {
        maximumReverseRequests: 1,
        reverseRequestDeadlineMilliseconds: 25,
      },
    });
    await initialize(binding, transport);
    transport.emit(permissionRequest(1));
    await waitFor(() => binding.diagnostics().activeReverseRequests === 1);
    transport.emit({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 1 },
    });
    transport.emit(permissionRequest(2));

    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      id: 2,
      error: { code: -32000, message: "Server overloaded" },
    });
    expect(authorityCalls).toBe(1);
    expect(binding.diagnostics()).toMatchObject({
      activeReverseRequests: 1,
      deniedReverseRequests: 1,
      pendingRequests: 0,
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_request_deadline",
      continuations: "unsettled",
    });
  });

  it("keeps a reverse capacity slot through response delivery", async () => {
    const transport = new ConformanceTransport();
    let authorityCalls = 0;
    const registration = defineAcpReverseRequestHandler({
      descriptor: ACP_CLIENT_REQUESTS.requestPermission,
      authorize: () => {
        authorityCalls += 1;
        return true;
      },
      handle: () => ({ outcome: { outcome: "cancelled" as const } }),
    });
    const binding = trackedBinding(transport, {
      reverseHandlers: [registration],
      limits: {
        maximumReverseRequests: 1,
        reverseRequestDeadlineMilliseconds: 25,
      },
    });
    await initialize(binding, transport);
    const release = transport.blockNextSend();
    transport.emit(permissionRequest(3));
    await waitFor(() => transport.writes.length === 2);
    expect(binding.diagnostics().activeReverseRequests).toBe(1);
    transport.emit(permissionRequest(4));

    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      id: 4,
      error: { code: -32000, message: "Server overloaded" },
    });
    expect(authorityCalls).toBe(1);
    expect(binding.diagnostics().closeReason).toBeUndefined();
    release();
    await waitFor(() => binding.diagnostics().activeReverseRequests === 0);
  });

  it("bounds reverse terminal error delivery before handler dispatch", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      limits: {
        maximumReverseRequests: 1,
        reverseRequestDeadlineMilliseconds: 50,
      },
    });
    await initialize(binding, transport);
    const release = transport.blockNextSend();
    transport.emit({
      jsonrpc: "2.0",
      id: 5,
      method: "probe/unknown-reverse",
      params: {},
    });
    await waitFor(() => transport.writes.length === 2);
    expect(binding.diagnostics().activeReverseRequests).toBe(1);
    transport.emit({
      jsonrpc: "2.0",
      id: 6,
      method: "probe/other-unknown-reverse",
      params: {},
    });

    await waitFor(() => transport.writes.length === 3);
    expect(transport.parsedWrite(2)).toMatchObject({
      id: 6,
      error: { code: -32000, message: "Server overloaded" },
    });
    expect(binding.diagnostics().closeReason).toBeUndefined();
    release();
    await waitFor(() => binding.diagnostics().activeReverseRequests === 0);
  });

  it("fences duplicate reverse IDs without starting replay error writes", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      limits: { reverseRequestDeadlineMilliseconds: 50 },
    });
    await initialize(binding, transport);
    const release = transport.blockNextSend();
    const replay = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "probe/unknown-reverse",
      params: {},
    };
    transport.emit(replay);
    await waitFor(() => transport.writes.length === 2);
    transport.emit(replay);
    transport.emit(replay);
    transport.emit(replay);

    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_reverse_id_duplicate",
    });
    expect(transport.writes).toHaveLength(2);
    release();
  });

  it("tracks a blocked cancellation write through bounded close", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      limits: {
        requestDeadlineMilliseconds: 100,
        reverseRequestDeadlineMilliseconds: 5,
      },
    });
    await initialize(binding, transport);
    const cancellation = new AbortController();
    const request = binding.request(
      descriptor,
      { value: "cancel" },
      { cancellationSignal: cancellation.signal },
    );
    const requestOutcome = request.catch((error: unknown) => error);
    await waitFor(() => transport.writes.length === 2);
    const release = transport.blockNextSend();
    cancellation.abort();
    await waitFor(() => transport.writes.length === 3);

    void binding.close("test_close");
    await expect(binding.closed).resolves.toMatchObject({
      reason: "test_close",
      continuations: "unsettled",
    });
    await expect(requestOutcome).resolves.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    expect(
      transport.writes.filter(
        (wire) => JSON.parse(wire).method === "$/cancel_request",
      ),
    ).toHaveLength(1);
    release();
  });

  it("rejects a correlated response admitted after assurance revocation", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initialize(binding, transport);
    const request = binding.request(descriptor, { value: "stale" });
    await waitFor(() => transport.writes.length === 2);
    revokeFramedTransportAssurance(transport.assurance);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "stale" },
    });

    await expect(request).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(binding.closed).resolves.toMatchObject({
      reason: "acp_transport_assurance_stale",
    });
  });

  it("backpressures global and per-key notification bursts without closing", async () => {
    const global = await blockedNotificationBinding({
      maximumNotificationHandlers: 1,
      maximumNotificationsPerOrderingKey: 4,
      keyed: false,
    });
    global.transport.emit(notification("probe/global", "a"));
    global.transport.emit(notification("probe/global", "b"));
    await waitFor(() => global.handled.length === 1);
    expect(global.binding.diagnostics()).toMatchObject({
      closed: false,
      pendingNotifications: 1,
      protocolFailures: 0,
    });
    global.releaseNext();
    await waitFor(() => global.handled.length === 2);
    global.releaseNext();
    await waitFor(
      () => global.binding.diagnostics().pendingNotifications === 0,
    );
    expect(global.handled).toEqual(["a", "b"]);
    expect(global.binding.diagnostics().closed).toBe(false);

    const keyed = await blockedNotificationBinding({
      maximumNotificationHandlers: 4,
      maximumNotificationsPerOrderingKey: 1,
      keyed: true,
    });
    keyed.transport.emit(notification("probe/keyed", "same"));
    keyed.transport.emit(notification("probe/keyed", "same"));
    await waitFor(() => keyed.handled.length === 1);
    expect(keyed.binding.diagnostics()).toMatchObject({
      closed: false,
      pendingNotifications: 1,
      notificationOrderingKeys: 1,
      protocolFailures: 0,
    });
    keyed.releaseNext();
    await waitFor(() => keyed.handled.length === 2);
    keyed.releaseNext();
    await waitFor(() => keyed.binding.diagnostics().pendingNotifications === 0);
    expect(keyed.binding.diagnostics()).toMatchObject({
      closed: false,
      notificationOrderingKeys: 0,
      protocolFailures: 0,
    });
  });

  it("releases notification admission waiters when the binding closes", async () => {
    const blocked = await blockedNotificationBinding({
      maximumNotificationHandlers: 1,
      maximumNotificationsPerOrderingKey: 1,
      keyed: true,
    });
    blocked.transport.emit(notification("probe/keyed", "same"));
    blocked.transport.emit(notification("probe/keyed", "same"));
    await waitFor(() => blocked.handled.length === 1);

    await expect(blocked.binding.close("test_close")).resolves.toBeUndefined();
    await expect(blocked.binding.closed).resolves.toMatchObject({
      reason: "test_close",
    });
    expect(blocked.handled).toEqual(["same"]);
  });

  it("bounds an abort-ignoring notification handler", async () => {
    const descriptor = notificationDescriptor("probe/deadline", true);
    const transport = new ConformanceTransport();
    const registration = defineAcpReverseNotificationHandler({
      descriptor,
      authorize: () => true,
      handle: async () => await new Promise<never>(() => undefined),
    });
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
      reverseHandlers: [registration],
      limits: { reverseRequestDeadlineMilliseconds: 5 },
    });
    await initialize(binding, transport);

    transport.emit(notification("probe/deadline", "session"));
    await expect(binding.closed).resolves.toEqual({
      reason: "acp_notification_deadline",
      continuations: "unsettled",
    });
    expect(binding.diagnostics()).toMatchObject({
      activeNotifications: 0,
      pendingNotifications: 0,
      handlerFailures: 1,
    });
  });

  it("redacts remote JSON-RPC message and data from the public error", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initialize(binding, transport);
    const request = binding.request(descriptor, { value: "input" });
    await waitFor(() => transport.writes.length === 2);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      error: {
        code: -32_001,
        message: "remote-private-message",
        data: { secret: "remote-private-data" },
      },
    });

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpRemoteError);
    expect(error).toMatchObject({
      code: "acp_binding_remote_error",
      remoteCode: -32_001,
      message: "acp_binding_remote_error",
    });
    expect(JSON.stringify(error)).not.toContain("remote-private");
    expect(JSON.stringify(binding.diagnostics())).not.toContain(
      "remote-private",
    );
  });

  it("denies unadvertised write-FS and every terminal request before authority", async () => {
    const descriptors = [
      ACP_CLIENT_REQUESTS.writeTextFile,
      ACP_CLIENT_REQUESTS.createTerminal,
      ACP_CLIENT_REQUESTS.terminalOutput,
      ACP_CLIENT_REQUESTS.releaseTerminal,
      ACP_CLIENT_REQUESTS.waitForTerminalExit,
      ACP_CLIENT_REQUESTS.killTerminal,
    ] as const;
    let authorityCalls = 0;
    const registrations = descriptors.map((descriptor) =>
      defineAcpReverseRequestHandler({
        descriptor: descriptor as AcpRequestDescriptor<unknown, unknown>,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => {
          throw new Error("unadvertised_handler_reached");
        },
      }),
    );
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport, {
      reverseHandlers: registrations,
    });
    await initialize(binding, transport, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const requests = [
      {
        method: "fs/write_text_file",
        params: { sessionId: "s", path: "/tmp/x", content: "x" },
      },
      {
        method: "terminal/create",
        params: { sessionId: "s", command: "true" },
      },
      {
        method: "terminal/output",
        params: { sessionId: "s", terminalId: "t" },
      },
      {
        method: "terminal/release",
        params: { sessionId: "s", terminalId: "t" },
      },
      {
        method: "terminal/wait_for_exit",
        params: { sessionId: "s", terminalId: "t" },
      },
      { method: "terminal/kill", params: { sessionId: "s", terminalId: "t" } },
    ];
    for (const [index, request] of requests.entries()) {
      transport.emit({ jsonrpc: "2.0", id: index + 10, ...request });
      await waitFor(() => transport.writes.length === index + 2);
      expect(transport.parsedWrite(index + 1)).toMatchObject({
        id: index + 10,
        error: { code: -32601, message: "Method not available" },
      });
    }
    expect(authorityCalls).toBe(0);
    expect(binding.diagnostics().deniedReverseRequests).toBe(requests.length);
  });

  it.each([
    {
      name: "plan_update",
      update: {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: "p", entries: [] },
      },
    },
    {
      name: "plan_removed",
      update: { sessionUpdate: "plan_removed", planId: "p" },
    },
  ])(
    "denies unadvertised $name before notification authority",
    async ({ update }) => {
      const transport = new ConformanceTransport();
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
      await initialize(binding, transport, {});
      transport.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s", update },
      });
      await binding.closed;
      expect(authorityCalls).toBe(0);
      expect(binding.diagnostics().protocolFailures).toBe(1);
    },
  );

  it("denies permission requests when no permission handler is registered", async () => {
    const transport = new ConformanceTransport();
    const binding = trackedBinding(transport);
    await initialize(binding, transport);
    transport.emit(permissionRequest(27));
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1)).toMatchObject({
      id: 27,
      error: { code: -32601, message: "Method not available" },
    });
    expect(binding.diagnostics().deniedReverseRequests).toBe(1);
  });

  it("rejects oversized frames and every semantic aggregate bound", async () => {
    const oversizedTransport = new ConformanceTransport();
    const oversized = trackedBinding(oversizedTransport, {
      limits: { maximumFrameBytes: 8 },
    });
    oversizedTransport.emitText("123456789");
    await expect(oversized.closed).resolves.toMatchObject({
      reason: "acp_frame_oversized",
    });

    const cases: Array<{
      semantic: Record<string, number>;
      params: unknown;
    }> = [
      {
        semantic: { maximumDepth: 4 },
        params: { value: { a: { b: { c: { d: true } } } } },
      },
      {
        semantic: { maximumStringBytes: 32 },
        params: { value: "x".repeat(33) },
      },
      {
        semantic: { maximumArrayItems: 1 },
        params: { value: [1, 2] },
      },
      {
        semantic: { maximumTotalNodes: 8 },
        params: { value: [1, 2, 3, 4, 5, 6, 7, 8] },
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const transport = new ConformanceTransport();
      const descriptor = permissiveReverseDescriptor(`probe/bounds-${index}`);
      let authorityCalls = 0;
      const registration = defineAcpReverseRequestHandler({
        descriptor,
        authorize: () => {
          authorityCalls += 1;
          return true;
        },
        handle: () => ({}),
      });
      const binding = trackedBinding(transport, {
        profiles: ["probe-v1"],
        extensions: [descriptor],
        reverseHandlers: [registration],
        limits: { semantic: entry.semantic },
      });
      await initialize(binding, transport);
      transport.emit({
        jsonrpc: "2.0",
        id: index + 100,
        method: descriptor.method,
        params: entry.params,
      });
      await expect(binding.closed).resolves.toMatchObject({
        reason: "acp_envelope_invalid",
      });
      expect(binding.diagnostics()).toMatchObject({
        invalidEnvelopeRootType: "object",
        invalidEnvelopeShape: "jv_id_ms_po_ra_ea_k4",
        invalidEnvelopeUnknownKeys: 0,
        invalidEnvelopeMethod: descriptor.method,
        invalidEnvelopeBounds: "invalid",
      });
      expect(authorityCalls).toBe(0);
    }
  });

  it("closes on frame EOF, iterator failure, carrier closure, and rejects after close", async () => {
    const eofTransport = new ConformanceTransport();
    const eofBinding = trackedBinding(eofTransport);
    eofTransport.endFrames();
    await expect(eofBinding.closed).resolves.toEqual({
      reason: "transport_frames_ended",
    });

    const failedTransport = new ConformanceTransport();
    const failedBinding = trackedBinding(failedTransport);
    failedTransport.failFrames();
    await expect(failedBinding.closed).resolves.toEqual({
      reason: "transport_frames_failed",
    });

    const carrierTransport = new ConformanceTransport();
    const carrierBinding = trackedBinding(carrierTransport);
    carrierTransport.resolveCarrierClosed("peer_closed");
    await expect(carrierBinding.closed).resolves.toEqual({
      reason: "transport_closed",
    });

    await expect(
      carrierBinding.initialize({ protocolVersion: 1 }),
    ).rejects.toMatchObject({ code: "acp_binding_closed" });

    const rejectedTransport = new ConformanceTransport();
    const rejectedBinding = trackedBinding(rejectedTransport);
    rejectedTransport.rejectCarrierClosed();
    await expect(rejectedBinding.closed).resolves.toEqual({
      reason: "transport_close_failed",
    });
  });

  it("fences unknown response IDs and denies wrong-direction methods", async () => {
    const unknownTransport = new ConformanceTransport();
    const unknownBinding = trackedBinding(unknownTransport);
    await initialize(unknownBinding, unknownTransport);
    unknownTransport.emit({ jsonrpc: "2.0", id: "unknown", result: {} });
    await expect(unknownBinding.closed).resolves.toMatchObject({
      reason: "acp_response_id_unknown",
    });

    const wrongDirectionTransport = new ConformanceTransport();
    const wrongDirectionBinding = trackedBinding(wrongDirectionTransport);
    await initialize(wrongDirectionBinding, wrongDirectionTransport);
    wrongDirectionTransport.emit({
      jsonrpc: "2.0",
      id: 91,
      method: "session/new",
      params: { cwd: "/repo", mcpServers: [] },
    });
    await waitFor(() => wrongDirectionTransport.writes.length === 2);
    expect(wrongDirectionTransport.parsedWrite(1)).toMatchObject({
      id: 91,
      error: { code: -32601, message: "Method not available" },
    });
    expect(wrongDirectionBinding.diagnostics().deniedReverseRequests).toBe(1);
  });

  it("emits exactly one cooperative cancellation across a post-send abort race", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initialize(binding, transport);
    const releaseSend = transport.blockNextSend();
    const controller = new AbortController();
    const request = binding.request(
      descriptor,
      { value: "race" },
      { cancellationSignal: controller.signal },
    );
    await waitFor(() => transport.writes.length === 2);
    controller.abort();
    controller.abort();
    releaseSend();
    await waitFor(
      () =>
        transport.writes.filter(
          (wire) => JSON.parse(wire).method === "$/cancel_request",
        ).length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      transport.writes.filter(
        (wire) => JSON.parse(wire).method === "$/cancel_request",
      ),
    ).toHaveLength(1);
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      result: { value: "race" },
    });
    await expect(request).resolves.toEqual({ value: "race" });
  });

  it("abandons exactly once across a post-send cancellation race and ignores the late response", async () => {
    const transport = new ConformanceTransport();
    const descriptor = echoDescriptor();
    const binding = trackedBinding(transport, {
      profiles: ["probe-v1"],
      extensions: [descriptor],
    });
    await initialize(binding, transport);
    const releaseSend = transport.blockNextSend();
    const controller = new AbortController();
    let abandonedSettlements = 0;
    const request = binding.request(
      descriptor,
      { value: "abandon-race" },
      {
        cancellationSignal: controller.signal,
        abandonOnCancellation: true,
        onAbandonedSettlement: () => {
          abandonedSettlements += 1;
        },
      },
    );
    await waitFor(() => transport.writes.length === 2);
    const requestId = transport.parsedWrite(1).id;
    controller.abort();
    controller.abort();
    releaseSend();

    await expect(request).rejects.toMatchObject({
      code: "acp_binding_request_cancelled",
      delivery: "sent_outcome_unknown",
    });
    await waitFor(
      () =>
        transport.writes.filter(
          (wire) => JSON.parse(wire).method === "$/cancel_request",
        ).length === 1,
    );
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      pendingRequests: 0,
    });

    transport.emit({
      jsonrpc: "2.0",
      id: requestId,
      result: { value: "late" },
    });
    await waitFor(() => binding.diagnostics().rejectedLateResponses === 1);
    expect(binding.diagnostics()).toMatchObject({
      closed: false,
      protocolFailures: 0,
    });
    expect(abandonedSettlements).toBe(1);
  });
});

async function blockedNotificationBinding(input: {
  maximumNotificationHandlers: number;
  maximumNotificationsPerOrderingKey: number;
  keyed: boolean;
}): Promise<{
  binding: AcpBinding;
  transport: ConformanceTransport;
  handled: string[];
  releaseNext(): void;
}> {
  const method = input.keyed ? "probe/keyed" : "probe/global";
  const descriptor = notificationDescriptor(method, input.keyed);
  const handled: string[] = [];
  const releases: Array<() => void> = [];
  const registration = defineAcpReverseNotificationHandler({
    descriptor,
    authorize: () => true,
    handle: async (params, context) => {
      handled.push(params.sessionId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      await Promise.race([gate, untilAborted(context.signal)]);
    },
  });
  const transport = new ConformanceTransport();
  const binding = trackedBinding(transport, {
    profiles: ["probe-v1"],
    extensions: [descriptor],
    reverseHandlers: [registration],
    limits: {
      maximumNotificationHandlers: input.maximumNotificationHandlers,
      maximumNotificationsPerOrderingKey:
        input.maximumNotificationsPerOrderingKey,
      reverseRequestDeadlineMilliseconds: 1_000,
    },
  });
  await initialize(binding, transport);
  return {
    binding,
    transport,
    handled,
    releaseNext: () => releases.shift()?.(),
  };
}

function trackedBinding(
  transport: ConformanceTransport,
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

async function initialize(
  binding: AcpBinding,
  transport: ConformanceTransport,
  clientCapabilities: Record<string, unknown> = {},
): Promise<void> {
  const pending = binding.initialize({
    protocolVersion: 1,
    clientCapabilities,
  });
  await waitFor(() => transport.writes.length === 1);
  transport.emit({
    jsonrpc: "2.0",
    id: transport.parsedWrite(0).id,
    result: { protocolVersion: 1, agentCapabilities: {} },
  });
  await pending;
}

function permissionRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: "session",
      toolCall: { toolCallId: "tool" },
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    },
  };
}

function busyLoop(milliseconds: number): void {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Deliberately occupy the event loop to prove wall-clock deadline checks.
  }
}

function notification(
  method: string,
  sessionId: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params: { sessionId } };
}

function notificationDescriptor(method: string, keyed: boolean) {
  const validator: AcpValueValidator<{ sessionId: string }> = (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { sessionId?: unknown }).sessionId === "string";
  return defineAcpExtensionNotification({
    method,
    direction: "agent_to_client",
    operation: "control",
    requiredProfile: "probe-v1",
    decodeParams: decodeTestValue,
    validateParams: validator,
    ...(keyed
      ? {
          notificationOrderingKey: (params: { sessionId: string }) =>
            params.sessionId,
        }
      : {}),
  });
}

function echoDescriptor(): AcpRequestDescriptor<
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
    method: "probe/echo-conformance",
    direction: "client_to_agent",
    operation: "read",
    requiredProfile: "probe-v1",
    decodeRequest: decodeTestValue,
    decodeResponse: decodeTestValue,
    validateRequest: validator,
    validateResponse: validator,
  });
}

function permissiveReverseDescriptor(
  method: string,
): AcpRequestDescriptor<unknown, unknown> {
  const validator: AcpValueValidator<unknown> = () => true;
  return defineAcpExtensionRequest({
    method,
    direction: "agent_to_client",
    operation: "read",
    requiredProfile: "probe-v1",
    decodeRequest: decodeTestValue,
    decodeResponse: decodeTestValue,
    validateRequest: validator,
    validateResponse: validator,
  });
}

class AsyncFrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #frames: InboundTextFrame[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<InboundTextFrame>): void;
    reject(error: Error): void;
  }> = [];
  #ended = false;
  #failure: Error | undefined;

  push(frame: InboundTextFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(): void {
    this.#failure = new Error("private_iterator_failure");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#failure);
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundTextFrame> {
    return {
      next: async () => {
        const frame = this.#frames.shift();
        if (frame) return { done: false, value: frame };
        if (this.#failure) throw this.#failure;
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

class ConformanceTransport implements FramedMessageTransport {
  readonly maximumFrameBytes = 128 * 1_024 * 1_024;
  readonly assurance = createOwnedProcessAssurance(
    scope,
    1,
    createEnvironmentOwnedProcessIdentity({
      kind: "owned_process",
      scope,
      channelId: `acp-conformance-${Math.random()}`,
      executable: {
        kind: "executable",
        canonicalPath: "/usr/bin/acp-conformance",
      },
      providerProcessIdentity: {
        type: "local_process_group",
        processId: 56_001,
        processGroupId: 56_001,
      },
    }),
    "acp_conformance",
  );
  readonly #queue = new AsyncFrameQueue();
  readonly frames = this.#queue;
  readonly writes: string[] = [];
  readonly closed: Promise<FramedTransportClosure>;
  #resolveClosed!: (closure: FramedTransportClosure) => void;
  #rejectClosed!: (error: Error) => void;
  #closed = false;
  #sendGate: Promise<void> | undefined;
  #releaseSend: (() => void) | undefined;
  failClose = false;

  constructor() {
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
  }

  async send(text: string): Promise<{ readonly disposition: "sent" }> {
    if (this.#closed) throw new FrameWriteError("fake_closed", "not_sent");
    this.writes.push(text);
    const gate = this.#sendGate;
    this.#sendGate = undefined;
    if (gate) await gate;
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

  endFrames(): void {
    this.#queue.end();
  }

  failFrames(): void {
    this.#queue.fail();
  }

  resolveCarrierClosed(reason: string): void {
    this.#queue.end();
    this.#resolveClosed({ reason });
  }

  rejectCarrierClosed(): void {
    this.#queue.end();
    this.#rejectClosed(new Error("private_carrier_close_failure"));
  }

  blockNextSend(): () => void {
    this.#sendGate = new Promise((resolve) => {
      this.#releaseSend = resolve;
    });
    return () => this.#releaseSend?.();
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.end();
    revokeFramedTransportAssurance(this.assurance);
    if (this.failClose) throw new Error("private_transport_cleanup_failure");
    this.#resolveClosed({ reason });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("acp_conformance_wait_timeout");
}

async function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
