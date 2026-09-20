import { describe, expect, it, vi } from "vitest";
import {
  createProviderPulseGateway,
  parseProviderPulseUrl,
  PROVIDER_PULSE_RESPONSE_MAX_BYTES,
  ProviderPulseGatewayError,
} from "./gateway.js";

const observedAt = "2026-08-16T19:00:00.000Z";

function pulseStatus(accounts: readonly unknown[] = []) {
  return {
    version: 1,
    generatedAt: observedAt,
    health: "healthy",
    accounts,
    usageBaseline: { health: "healthy", metrics: [] },
  };
}

function account(index: number, provider = "claude") {
  return {
    id: `account-${index}`,
    label: `Account ${index}`,
    provider,
    usage: { health: "healthy", inFlight: false },
  };
}

function gatewayReturning(response: Response) {
  return createProviderPulseGateway(
    "http://127.0.0.1:4317",
    vi.fn(async () => response) as unknown as typeof fetch,
  );
}

async function expectUnavailable(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({
    status: 503,
    code: "provider_pulse_unavailable",
    retryable: true,
  });
}

describe("parseProviderPulseUrl", () => {
  it("defaults to the local Pulse process", () => {
    expect(parseProviderPulseUrl(undefined)).toBe("http://127.0.0.1:4317");
  });

  it("accepts loopback http origins", () => {
    expect(parseProviderPulseUrl("http://localhost:4317")).toBe(
      "http://localhost:4317",
    );
  });
});

describe("createProviderPulseGateway", () => {
  it("projects Pulse status without identity fields", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            generatedAt: "2026-08-16T19:00:00.000Z",
            health: "healthy",
            accounts: [
              {
                id: "claude-work",
                label: "Claude · work",
                provider: "claude",
                usage: {
                  health: "healthy",
                  inFlight: false,
                  lastSuccessAt: "2026-08-16T19:00:00.000Z",
                  identity: {
                    observed: { email: "hidden@example.com" },
                  },
                  snapshot: {
                    observedAt: "2026-08-16T19:00:00.000Z",
                    windows: [
                      {
                        id: "weekly",
                        label: "Current week (all models)",
                        remainingPercent: 41,
                        durationMinutes: 10_080,
                        resetsAt: "2026-08-17T08:59:59.670Z",
                      },
                    ],
                    balances: [],
                    resetCredits: {
                      availableCount: 2,
                      credits: [
                        {
                          id: "native-credit-must-not-leak",
                          resetType: "codexRateLimits",
                          status: "available",
                          grantedAt: "2026-08-16T18:00:00.000Z",
                          expiresAt: "2026-08-30T18:00:00.000Z",
                          title: "Provider-only title",
                          description: "Provider-only description",
                        },
                        {
                          id: "later-credit-must-not-leak",
                          resetType: "codexRateLimits",
                          status: "available",
                          grantedAt: "2026-08-16T18:00:00.000Z",
                          expiresAt: "2026-09-01T18:00:00.000Z",
                        },
                        {
                          id: "redeemed-credit-must-not-leak",
                          resetType: "codexRateLimits",
                          status: "redeemed",
                          grantedAt: "2026-08-16T18:00:00.000Z",
                          expiresAt: "2026-08-20T18:00:00.000Z",
                        },
                      ],
                    },
                  },
                },
              },
            ],
            usageBaseline: {
              health: "healthy",
              updatedAt: "2026-08-16T19:00:00.000Z",
              metrics: [
                {
                  accountId: "claude-work",
                  metricKind: "window",
                  metricId: "weekly",
                  remainingPercent: 41,
                  capturedAt: "2026-08-16T19:00:00.000Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const gateway = createProviderPulseGateway(
      "http://127.0.0.1:4317",
      fetchImpl as unknown as typeof fetch,
    );
    const status = await gateway.readStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]?.label).toBe("Claude · work");
    expect(status.accounts[0]?.brand).toBe("claude");
    expect(status.accounts[0]?.usage.snapshot?.resetCredits).toEqual({
      availableCount: 2,
      nextExpiresAt: "2026-08-30T18:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("hidden@example.com");
    expect(JSON.stringify(status)).not.toContain("identity");
    expect(JSON.stringify(status)).not.toContain("native-credit-must-not-leak");
    expect(JSON.stringify(status)).not.toContain("Provider-only title");
    expect(JSON.stringify(status)).not.toContain("Provider-only description");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Host: "127.0.0.1:4317",
        }),
      }),
    );
  });

  it("preserves bounded balance fields and omits a brand for unknown providers", async () => {
    const gateway = gatewayReturning(
      Response.json(
        pulseStatus([
          {
            ...account(1, "fireworks"),
            usage: {
              health: "healthy",
              inFlight: false,
              snapshot: {
                observedAt,
                windows: [],
                balances: [
                  {
                    id: "monthly-spend",
                    label: "Monthly spend",
                    amount: 12.5,
                    currency: "USD",
                    unit: "credits",
                    unlimited: false,
                    limit: "100",
                    used: "12.5",
                    remainingPercent: 87.5,
                    resetsAt: observedAt,
                  },
                ],
              },
            },
          },
        ]),
      ),
    );

    const status = await gateway.readStatus();
    expect(status.accounts[0]).not.toHaveProperty("brand");
    expect(status.accounts[0]?.usage.snapshot?.balances[0]).toEqual({
      id: "monthly-spend",
      label: "Monthly spend",
      amount: 12.5,
      currency: "USD",
      unit: "credits",
      unlimited: false,
      limit: "100",
      used: "12.5",
      remainingPercent: 87.5,
      resetsAt: observedAt,
    });
  });

  it("accepts the reviewed Provider Pulse maximum account range", async () => {
    const accounts = Array.from({ length: 65 }, (_, index) => account(index));
    const status = await gatewayReturning(
      Response.json(pulseStatus(accounts)),
    ).readStatus();
    expect(status.accounts).toHaveLength(65);
  });

  it("rejects an invalid reset-credit count", async () => {
    await expectUnavailable(
      gatewayReturning(
        Response.json(
          pulseStatus([
            {
              ...account(1, "codex"),
              usage: {
                health: "healthy",
                inFlight: false,
                snapshot: {
                  observedAt,
                  windows: [],
                  balances: [],
                  resetCredits: { availableCount: -1 },
                },
              },
            },
          ]),
        ),
      ).readStatus(),
    );
  });

  it("maps malformed JSON to a safe unavailable error", async () => {
    await expectUnavailable(
      gatewayReturning(
        new Response("{", {
          headers: { "content-type": "application/json" },
        }),
      ).readStatus(),
    );
  });

  it("maps a truncated response stream to a safe unavailable error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":1,'));
        controller.error(new Error("connection_reset"));
      },
    });
    await expectUnavailable(
      gatewayReturning(
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
      ).readStatus(),
    );
  });

  it("rejects an oversized declared response before reading it", async () => {
    await expectUnavailable(
      gatewayReturning(
        new Response("{}", {
          headers: {
            "content-length": String(PROVIDER_PULSE_RESPONSE_MAX_BYTES + 1),
            "content-type": "application/json",
          },
        }),
      ).readStatus(),
    );
  });

  it("enforces the absolute response cap when content length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(PROVIDER_PULSE_RESPONSE_MAX_BYTES + 1),
        );
        controller.close();
      },
    });
    await expectUnavailable(
      gatewayReturning(
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
      ).readStatus(),
    );
  });

  it("maps a structurally invalid status to a safe unavailable error", async () => {
    await expectUnavailable(
      gatewayReturning(Response.json({ version: 1 })).readStatus(),
    );
  });

  it("maps an invalid provider timestamp to a safe unavailable error", async () => {
    const value = {
      ...pulseStatus([account(1)]),
      usageBaseline: {
        health: "healthy",
        metrics: [
          {
            accountId: "account-1",
            metricKind: "window",
            metricId: "weekly",
            remainingPercent: 50,
            capturedAt: "not-a-timestamp",
          },
        ],
      },
    };
    await expectUnavailable(
      gatewayReturning(Response.json(value)).readStatus(),
    );
  });

  it("sends Pulse action headers on checks", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            operationId: "op-1",
            accepted: true,
            targetId: "claude-work",
            kind: "usage-check",
            coalesced: false,
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );
    const gateway = createProviderPulseGateway(
      "http://127.0.0.1:4317",
      fetchImpl as unknown as typeof fetch,
    );
    await gateway.checkAccount("claude-work");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/accounts/claude-work/check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Origin: "http://127.0.0.1:4317",
          "X-Provider-Pulse-Action": "1",
        }),
      }),
    );
  });

  it("maps a disabled gateway to an unavailable error", async () => {
    const gateway = createProviderPulseGateway(null);
    await expect(gateway.readStatus()).rejects.toBeInstanceOf(
      ProviderPulseGatewayError,
    );
  });
});
