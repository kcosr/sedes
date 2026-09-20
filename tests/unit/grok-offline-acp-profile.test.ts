import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironmentOwnedProcessIdentity,
  type EnvironmentChannelScope,
} from "../../src/server/execution/environment-channel.js";
import {
  FrameWriteError,
  createOwnedProcessAssurance,
  revokeFramedTransportAssurance,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type InboundTextFrame,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  GROK_EXTENSION_CANDIDATES,
  GROK_REVIEWED_PROBE_CANDIDATES,
  grokCandidateRouteKey,
} from "../../scripts/grok-probes/grok-extension-candidates.js";
import {
  GROK_O2B_EXTENSION_METHODS,
  GROK_O2B_REVIEWED_SCENARIOS,
  GROK_REVIEWED_PROBE_DESCRIPTOR_KEYS,
  createGrokInitializeOnlyProbe,
  createGrokOfflineLifecycleProbe,
  type GrokInitializeOnlyProbe,
  type GrokOfflineLifecycleProbe,
  type GrokProbeCapture,
} from "../../scripts/grok-probes/grok-probe-profile.js";

const scope: EnvironmentChannelScope = Object.freeze({
  tenantId: "tenant-grok-probe",
  principalId: "principal-grok-probe",
  backendInstanceId: "backend-grok-probe",
  executionEnvironmentId: "environment-grok-probe",
});
const activeProbes: Array<GrokInitializeOnlyProbe | GrokOfflineLifecycleProbe> =
  [];
const acceptedO2aReview = Object.freeze({
  status: "accepted" as const,
  evidenceId: "fake-o2a-review-evidence",
});

afterEach(async () => {
  await Promise.allSettled(
    activeProbes.splice(0).map(async (probe) => await probe.close()),
  );
});

describe("Grok offline ACP probe profile", () => {
  it("keeps the complete source ledger separate from the exact reviewed descriptor set", async () => {
    const expected = GROK_REVIEWED_PROBE_CANDIDATES.map(
      grokCandidateRouteKey,
    ).sort();
    expect(GROK_REVIEWED_PROBE_DESCRIPTOR_KEYS).toEqual(expected);
    expect(new Set(GROK_REVIEWED_PROBE_DESCRIPTOR_KEYS).size).toBe(
      expected.length,
    );
    expect(
      GROK_REVIEWED_PROBE_DESCRIPTOR_KEYS.every((key) => !key.includes("*")),
    ).toBe(true);
    expect(
      GROK_REVIEWED_PROBE_CANDIDATES.every(
        (candidate) =>
          candidate.literal === undefined ||
          (candidate.literal.startsWith("x.ai/") &&
            !candidate.literal.startsWith("_x.ai/")),
      ),
    ).toBe(true);
    expect(
      GROK_EXTENSION_CANDIDATES.some(
        (candidate) =>
          candidate.key === "x.ai/skills/*" &&
          candidate.probeDisposition === "inventory_only",
      ),
    ).toBe(true);

    const generated = JSON.parse(
      await readFile(
        new URL(
          "../../protocol/grok-acp/1.0.4/source-route-candidates.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      revisions: Array<{ role: string; routes: Array<{ route: string }> }>;
    };
    const current = generated.revisions.find(
      (revision) => revision.role === "current-source-evidence",
    );
    const extractedRoutes = new Set(
      current?.routes.map((entry) => entry.route),
    );
    for (const candidate of GROK_EXTENSION_CANDIDATES) {
      if (candidate.literal) {
        expect(extractedRoutes.has(candidate.literal), candidate.literal).toBe(
          true,
        );
      } else {
        const prefix = candidate.key.slice(0, -1);
        expect(
          [...extractedRoutes].some((route) => route.startsWith(prefix)),
          candidate.key,
        ).toBe(true);
      }
    }
    expect(
      GROK_O2B_REVIEWED_SCENARIOS.map((scenario) => scenario.method).sort(),
    ).toEqual([...GROK_O2B_EXTENSION_METHODS]);
    expect(
      GROK_EXTENSION_CANDIDATES.find(
        (candidate) => candidate.literal === "_x.ai/mcp/servers_updated",
      ),
    ).toMatchObject({
      direction: "agent_to_client",
      kind: "notification",
      evidenceClass: "source_candidate",
      probeDisposition: "inventory_only",
    });
  });

  it("keeps O2b disabled until exact O2a review evidence is accepted", () => {
    const transport = new FakeProbeTransport();
    expect(() =>
      createGrokOfflineLifecycleProbe({
        transport,
        expectedScope: scope,
        expectedConnectionGeneration: 1,
      }),
    ).toThrow("grok_o2b_pending_o2a_review");
    void transport.close("test_complete");
  });

  it("runs O2a through AcpBinding and advertises no filesystem or terminal authority", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = trackedInitializeProbe(transport, captures);
    transport.onSend = async (text) => {
      const wire = JSON.parse(text) as Record<string, unknown>;
      if (wire.method === "initialize") {
        transport.emit({
          jsonrpc: "2.0",
          id: wire.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { list: {}, resume: {}, close: {} },
            },
            agentInfo: { name: "fake-grok", version: "1.0.4" },
          },
        });
      }
    };

    await expect(probe.initialize()).resolves.toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "fake-grok" },
    });
    expect(transport.parsedWrite(0)).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    });
    expect(
      captures.map(({ method, direction, outcome }) => ({
        method,
        direction,
        outcome,
      })),
    ).toEqual([
      {
        method: "initialize",
        direction: "client_to_agent",
        outcome: "attempted",
      },
      {
        method: "initialize",
        direction: "client_to_agent",
        outcome: "response_admitted_by_probe_bounds",
      },
    ]);
    expect(() => probe.assertQuiescentClean()).not.toThrow();
  });

  it("gives O2a no notification handlers while generically ignoring one bounded notification", async () => {
    const extensionTransport = new FakeProbeTransport();
    const extensionCaptures: GrokProbeCapture[] = [];
    const extensionProbe = trackedInitializeProbe(
      extensionTransport,
      extensionCaptures,
    );
    await initialize(extensionProbe, extensionTransport);
    extensionTransport.emit({
      jsonrpc: "2.0",
      method: "x.ai/session_notification",
      params: { sessionId: "must-not-be-observed" },
    });
    await waitFor(
      () => extensionProbe.diagnostics().binding.ignoredNotifications === 1,
    );
    expect(extensionProbe.diagnostics().binding).toMatchObject({
      initialized: true,
      closed: false,
      activeNotifications: 0,
      pendingNotifications: 0,
      ignoredNotifications: 1,
      deniedReverseRequests: 0,
      handlerFailures: 0,
      protocolFailures: 0,
    });
    expect(
      extensionProbe.diagnostics().binding.ignoredNotificationBytes,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(extensionCaptures)).not.toContain(
      "must-not-be-observed",
    );
    expect(() => extensionProbe.assertQuiescentClean()).not.toThrow();

    const standardTransport = new FakeProbeTransport();
    const standardProbe = trackedInitializeProbe(standardTransport, []);
    await initialize(standardProbe, standardTransport);
    standardTransport.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-a",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "no" },
        },
      },
    });
    await waitFor(
      () => standardProbe.diagnostics().binding.ignoredNotifications === 1,
    );
    expect(standardProbe.diagnostics().binding).toMatchObject({
      closed: false,
      activeNotifications: 0,
      ignoredNotifications: 1,
      deniedReverseRequests: 0,
      protocolFailures: 0,
    });
    expect(() => standardProbe.assertQuiescentClean()).not.toThrow();
  });

  it("ignores one pre-response notification without capturing its route or payload", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = trackedInitializeProbe(transport, captures);
    const pendingInitialize = probe.initialize();
    await waitFor(() => transport.writes.length === 1);
    transport.emitBatch([
      {
        jsonrpc: "2.0",
        method: "_x.ai/private-startup-notification",
        params: { private: "pre-response-private-payload" },
      },
      {
        jsonrpc: "2.0",
        id: transport.parsedWrite(0).id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      },
    ]);

    await expect(pendingInitialize).resolves.toMatchObject({
      protocolVersion: 1,
    });
    expect(probe.diagnostics().binding).toMatchObject({
      initialized: true,
      closed: false,
      ignoredNotifications: 1,
      activeNotifications: 0,
      pendingNotifications: 0,
      deniedReverseRequests: 0,
      handlerFailures: 0,
      protocolFailures: 0,
    });
    expect(JSON.stringify(captures)).not.toContain("private-startup");
    expect(JSON.stringify(captures)).not.toContain("pre-response-private");
    expect(() => probe.assertQuiescentClean()).not.toThrow();
  });

  it("keeps O2a clean across multiple ignored notifications", async () => {
    const transport = new FakeProbeTransport();
    const probe = trackedInitializeProbe(transport, []);
    await initialize(probe, transport);
    for (const sequence of [1, 2]) {
      transport.emit({
        jsonrpc: "2.0",
        method: `_x.ai/private-notification-${sequence}`,
        params: {},
      });
    }
    await waitFor(() => probe.diagnostics().binding.ignoredNotifications === 2);

    expect(probe.diagnostics().binding).toMatchObject({
      ignoredNotifications: 2,
      closed: false,
      protocolFailures: 0,
    });
    expect(() => probe.assertQuiescentClean()).not.toThrow();
  });

  it("keeps O2a clean after a large ignored notification", async () => {
    const transport = new FakeProbeTransport();
    const probe = trackedInitializeProbe(transport, []);
    await initialize(probe, transport);
    transport.emit({
      jsonrpc: "2.0",
      method: "_x.ai/private-oversized-notification",
      params: { padding: "private-padding".repeat(6_000) },
    });
    await waitFor(() => probe.diagnostics().binding.ignoredNotifications === 1);

    expect(probe.diagnostics().binding).toMatchObject({
      ignoredNotifications: 1,
      closed: false,
      protocolFailures: 0,
    });
    expect(
      probe.diagnostics().binding.ignoredNotificationBytes,
    ).toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(probe.diagnostics())).not.toContain(
      "private-padding",
    );
    expect(() => probe.assertQuiescentClean()).not.toThrow();
  });

  it("propagates an absolute tranche abort through O2a initialize before write", async () => {
    const transport = new FakeProbeTransport();
    const probe = trackedInitializeProbe(transport, []);
    const controller = new AbortController();
    controller.abort(new Error("absolute_tranche_deadline"));

    await expect(
      probe.initialize({ signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "acp_binding_request_cancelled",
      delivery: "not_sent",
    });
    expect(transport.writes).toHaveLength(0);
  });

  it("rejects unknown, wrong-direction, and unadvertised FS/terminal reverse traffic before authority", async () => {
    const transport = new FakeProbeTransport();
    const probe = trackedInitializeProbe(transport, []);
    await initialize(probe, transport);

    for (const [id, method, params] of [
      [31, "_x.ai/source_only_unknown", {}],
      [32, "_x.ai/models/list", {}],
      [33, "fs/read_text_file", { sessionId: "session-a", path: "/secret" }],
      [
        34,
        "terminal/create",
        { sessionId: "session-a", command: "id", outputByteLimit: 10 },
      ],
    ] as const) {
      transport.emit({ jsonrpc: "2.0", id, method, params });
    }
    await waitFor(() => transport.writes.length === 5);

    for (let index = 1; index < 5; index += 1) {
      expect(transport.parsedWrite(index)).toMatchObject({
        error: { code: -32601, message: "Method not available" },
      });
    }
    expect(probe.diagnostics()).toMatchObject({
      binding: { deniedReverseRequests: 4, closed: false },
      deniedExtensionReverseRequests: 0,
    });
    expect(() => probe.assertQuiescentClean()).toThrow(
      "grok_o2a_initialize_not_quiescent_clean",
    );
  });

  it("counts denied extension authority without dispatching it", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = createGrokOfflineLifecycleProbe({
      transport,
      expectedScope: scope,
      expectedConnectionGeneration: 1,
      capture: { capture: (event) => captures.push(event) },
      o2aReviewEvidence: acceptedO2aReview,
    });
    activeProbes.push(probe);
    await initialize(probe, transport);
    transport.emit({
      jsonrpc: "2.0",
      id: 41,
      method: "_x.ai/mcp/sdk_call",
      params: { sessionId: "session-a", private: "not-captured" },
    });
    await waitFor(() => transport.writes.length === 2);

    expect(transport.parsedWrite(1)).toMatchObject({
      id: 41,
      error: { code: -32601, message: "Method not available" },
    });
    expect(probe.diagnostics().deniedExtensionReverseRequests).toBe(1);
    expect(JSON.stringify(captures)).not.toContain("not-captured");
  });

  it("bounds observed notifications without retaining their payloads", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = createGrokOfflineLifecycleProbe({
      transport,
      expectedScope: scope,
      expectedConnectionGeneration: 1,
      capture: { capture: (event) => captures.push(event) },
      maximumCaptures: 3,
      o2aReviewEvidence: acceptedO2aReview,
    });
    activeProbes.push(probe);
    await initialize(probe, transport);
    for (const sessionId of ["one", "two", "three"]) {
      transport.emit({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: { sessionId, secret: `secret-${sessionId}` },
      });
    }
    await waitFor(() => {
      const diagnostics = probe.diagnostics();
      return diagnostics.captured + diagnostics.droppedCaptures === 5;
    });

    expect(probe.diagnostics()).toMatchObject({
      captured: 3,
      droppedCaptures: 2,
    });
    expect(JSON.stringify(captures)).not.toContain("secret-");
  });

  it("routes two session-scoped O2b reads by exact method while retaining no params", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = createGrokOfflineLifecycleProbe({
      transport,
      expectedScope: scope,
      expectedConnectionGeneration: 1,
      capture: { capture: (event) => captures.push(event) },
      o2aReviewEvidence: acceptedO2aReview,
    });
    activeProbes.push(probe);
    await initialize(probe, transport);

    const first = probe.request({
      scenarioId: "session_info",
      sessionId: "session-secret-a",
    });
    const second = probe.request({
      scenarioId: "session_info",
      sessionId: "session-secret-b",
    });
    await waitFor(() => transport.writes.length === 3);
    const firstWire = transport.parsedWrite(1);
    const secondWire = transport.parsedWrite(2);
    expect(firstWire.method).toBe("_x.ai/session/info");
    expect(secondWire.method).toBe("_x.ai/session/info");
    transport.emit({
      jsonrpc: "2.0",
      id: secondWire.id,
      result: { resident: true },
    });
    transport.emit({
      jsonrpc: "2.0",
      id: firstWire.id,
      result: { resident: false },
    });

    await expect(first).resolves.toEqual({ resident: false });
    await expect(second).resolves.toEqual({ resident: true });
    expect(GROK_O2B_EXTENSION_METHODS).toContain("x.ai/session/info");
    expect(JSON.stringify(captures)).not.toContain("session-secret");
  });

  it("closes safely on malformed and oversized traffic", async () => {
    const malformedTransport = new FakeProbeTransport();
    const malformedProbe = trackedInitializeProbe(malformedTransport, []);
    await initialize(malformedProbe, malformedTransport);
    malformedTransport.emitText("{not-json secret-error-text");
    await waitFor(() => malformedProbe.diagnostics().binding.closed);
    expect(malformedProbe.diagnostics().binding.closeReason).toBe(
      "acp_json_invalid",
    );
    expect(JSON.stringify(malformedProbe.diagnostics())).not.toContain(
      "secret-error-text",
    );

    const oversizedTransport = new FakeProbeTransport();
    const oversizedProbe = createGrokInitializeOnlyProbe({
      transport: oversizedTransport,
      expectedScope: scope,
      expectedConnectionGeneration: 1,
      limits: { maximumFrameBytes: 512 },
    });
    activeProbes.push(oversizedProbe);
    await initialize(oversizedProbe, oversizedTransport);
    oversizedTransport.emit({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: { padding: "x".repeat(1_000) },
    });
    await waitFor(() => oversizedProbe.diagnostics().binding.closed);
    expect(oversizedProbe.diagnostics().binding.closeReason).toBe(
      "acp_frame_oversized",
    );
  });

  it("never exposes a remote extension error message or data", async () => {
    const transport = new FakeProbeTransport();
    const captures: GrokProbeCapture[] = [];
    const probe = createGrokOfflineLifecycleProbe({
      transport,
      expectedScope: scope,
      expectedConnectionGeneration: 1,
      capture: { capture: (event) => captures.push(event) },
      o2aReviewEvidence: acceptedO2aReview,
    });
    activeProbes.push(probe);
    await initialize(probe, transport);
    const request = probe.request({ scenarioId: "models_list" });
    await waitFor(() => transport.writes.length === 2);
    expect(transport.parsedWrite(1).method).toBe("_x.ai/models/list");
    transport.emit({
      jsonrpc: "2.0",
      id: transport.parsedWrite(1).id,
      error: {
        code: -32044,
        message: "provider secret error message",
        data: { token: "provider-secret-token" },
      },
    });

    await expect(request).rejects.toMatchObject({
      code: "acp_binding_remote_error",
      remoteCode: -32044,
    });
    const serialized = JSON.stringify({
      captures,
      diagnostics: probe.diagnostics(),
    });
    expect(serialized).not.toContain("provider secret");
  });
});

function trackedInitializeProbe(
  transport: FakeProbeTransport,
  captures: GrokProbeCapture[],
): GrokInitializeOnlyProbe {
  const probe = createGrokInitializeOnlyProbe({
    transport,
    expectedScope: scope,
    expectedConnectionGeneration: 1,
    capture: { capture: (event) => captures.push(event) },
  });
  activeProbes.push(probe);
  return probe;
}

async function initialize(
  probe: GrokInitializeOnlyProbe | GrokOfflineLifecycleProbe,
  transport: FakeProbeTransport,
): Promise<void> {
  const pending = probe.initialize();
  await waitFor(() => transport.writes.length === 1);
  transport.emit({
    jsonrpc: "2.0",
    id: transport.parsedWrite(0).id,
    result: { protocolVersion: 1, agentCapabilities: {} },
  });
  await pending;
}

class AsyncFrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #frames: InboundTextFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<InboundTextFrame>) => void> =
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

class FakeProbeTransport implements FramedMessageTransport {
  readonly maximumFrameBytes = 128 * 1_024 * 1_024;
  readonly assurance = createOwnedProcessAssurance(
    scope,
    1,
    createEnvironmentOwnedProcessIdentity({
      kind: "owned_process",
      scope,
      channelId: `grok-probe-${Math.random()}`,
      executable: { kind: "executable", canonicalPath: "/usr/bin/fake-grok" },
      providerProcessIdentity: {
        type: "local_process_group",
        processId: 59_001,
        processGroupId: 59_001,
      },
    }),
    "grok_probe_test",
  );
  readonly #queue = new AsyncFrameQueue();
  readonly frames = this.#queue;
  readonly writes: string[] = [];
  readonly closed: Promise<FramedTransportClosure>;
  onSend: ((text: string) => Promise<void>) | undefined;
  #resolveClosed!: (closure: FramedTransportClosure) => void;
  #closed = false;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async send(text: string): Promise<{ readonly disposition: "sent" }> {
    if (this.#closed) throw new FrameWriteError("fake_grok_closed", "not_sent");
    this.writes.push(text);
    await this.onSend?.(text);
    return { disposition: "sent" };
  }

  parsedWrite(index: number): Record<string, unknown> {
    return JSON.parse(this.writes[index] ?? "null") as Record<string, unknown>;
  }

  emit(value: unknown): void {
    this.emitText(JSON.stringify(value));
  }

  emitBatch(values: readonly unknown[]): void {
    for (const value of values) this.emit(value);
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("grok_probe_test_timeout");
}
