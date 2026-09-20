import { z } from "zod";
import {
  providerPulseAccountIdSchema,
  providerPulseBaselineSchema,
  providerPulseCheckAllResultSchema,
  providerPulseOperationReceiptSchema,
  providerPulseStatusSchema,
  type ProviderPulseStatus,
} from "../../shared/protocol/provider-pulse.js";
import type { BackendBrand } from "../../shared/protocol/conversation.js";

export const DEFAULT_PROVIDER_PULSE_URL = "http://127.0.0.1:4317";
const STATUS_TIMEOUT_MS = 3_000;
const ACTION_TIMEOUT_MS = 8_000;
export const PROVIDER_PULSE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const boundedString = (maximum: number) => z.string().max(maximum);
const pulseRecordSchema = z.record(z.string().max(256), z.unknown());
const pulseResetCreditSchema = z
  .object({
    status: boundedString(64),
    expiresAt: boundedString(64).optional(),
  })
  .passthrough();
const pulseResetCreditsSchema = z
  .object({
    availableCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    credits: z.array(pulseResetCreditSchema).max(256).optional(),
  })
  .passthrough();

const pulseErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(500),
  }),
});

const pulseAccountSchema = z
  .object({
    id: boundedString(128),
    label: boundedString(256).optional(),
    provider: boundedString(64),
    usage: z
      .object({
        health: boundedString(32).optional(),
        inFlight: z.boolean().optional(),
        operationId: boundedString(128).optional(),
        lastAttemptAt: boundedString(64).optional(),
        lastSuccessAt: boundedString(64).optional(),
        snapshot: z
          .object({
            observedAt: boundedString(64),
            windows: z.array(pulseRecordSchema).max(32).optional(),
            balances: z.array(pulseRecordSchema).max(32).optional(),
            resetCredits: pulseResetCreditsSchema.optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const pulseStatusSchema = z
  .object({
    version: z.literal(1),
    generatedAt: boundedString(64),
    health: boundedString(32),
    accounts: z.array(pulseAccountSchema).max(100).optional(),
    usageBaseline: z
      .object({
        health: z.enum(["unknown", "healthy", "unhealthy"]).optional(),
        updatedAt: boundedString(64).optional().nullable(),
        metrics: z.array(pulseRecordSchema).max(256).optional(),
      })
      .optional(),
  })
  .passthrough();

export class ProviderPulseGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderPulseGatewayError";
  }
}

export interface ProviderPulseGateway {
  readonly enabled: boolean;
  readStatus(): Promise<ProviderPulseStatus>;
  checkAccount(accountId: string): Promise<unknown>;
  checkAll(): Promise<unknown>;
  snapshot(): Promise<unknown>;
}

export function parseProviderPulseUrl(
  value: string | undefined,
): string | null {
  if (value === undefined) return DEFAULT_PROVIDER_PULSE_URL;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "off" || trimmed === "0") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "SEDES_PROVIDER_PULSE_URL must be a loopback http:// URL or off.",
    );
  }
  if (parsed.protocol !== "http:") {
    throw new Error("SEDES_PROVIDER_PULSE_URL must use http.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "SEDES_PROVIDER_PULSE_URL must not include credentials or query.",
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("SEDES_PROVIDER_PULSE_URL must not include a path.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "[::1]" &&
    host !== "::1"
  ) {
    throw new Error("SEDES_PROVIDER_PULSE_URL must bind to loopback.");
  }
  if (!parsed.port) {
    throw new Error(
      "SEDES_PROVIDER_PULSE_URL must include an explicit port.",
    );
  }
  return parsed.origin;
}

export function createProviderPulseGateway(
  configuredUrl: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): ProviderPulseGateway {
  const url =
    configuredUrl === undefined ? DEFAULT_PROVIDER_PULSE_URL : configuredUrl;
  if (url === null) {
    return {
      enabled: false,
      readStatus: async () => {
        throw disabledError();
      },
      checkAccount: async () => {
        throw disabledError();
      },
      checkAll: async () => {
        throw disabledError();
      },
      snapshot: async () => {
        throw disabledError();
      },
    };
  }
  const origin = new URL(url);
  const authority = origin.host;
  const request = async (
    method: "GET" | "POST",
    pathname: string,
    timeoutMs: number,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Host: authority,
    };
    if (method === "POST") {
      headers.Origin = origin.origin;
      headers["X-Provider-Pulse-Action"] = "1";
    }
    let response: Response;
    try {
      response = await fetchImpl(new URL(pathname, origin).href, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      throw new ProviderPulseGatewayError(
        503,
        "provider_pulse_unavailable",
        error instanceof Error && error.name === "TimeoutError"
          ? "Provider Pulse did not respond in time."
          : "Provider Pulse is unavailable.",
        true,
      );
    }
    let body: unknown;
    try {
      body = await readBoundedJsonResponse(response);
    } catch {
      throw unavailableResponseError();
    }
    if (!response.ok) {
      const parsed = pulseErrorSchema.safeParse(body);
      throw new ProviderPulseGatewayError(
        response.status === 404 ? 404 : response.status === 409 ? 409 : 503,
        response.status === 404
          ? "not_found"
          : response.status === 409
            ? "conflict"
            : "provider_pulse_unavailable",
        parsed.success
          ? parsed.data.error.message
          : "Provider Pulse rejected the request.",
        response.status >= 500,
      );
    }
    return body;
  };

  return {
    enabled: true,
    async readStatus() {
      const body = await request("GET", "/api/status", STATUS_TIMEOUT_MS);
      return decodeProviderPulseResponse(() => projectStatus(body));
    },
    async checkAccount(accountId) {
      const id = providerPulseAccountIdSchema.parse(accountId);
      const body = await request(
        "POST",
        `/api/accounts/${encodeURIComponent(id)}/check`,
        ACTION_TIMEOUT_MS,
      );
      return decodeProviderPulseResponse(() =>
        providerPulseOperationReceiptSchema.parse(body),
      );
    },
    async checkAll() {
      const body = await request("POST", "/api/check-all", ACTION_TIMEOUT_MS);
      return decodeProviderPulseResponse(() =>
        providerPulseCheckAllResultSchema.parse(body),
      );
    },
    async snapshot() {
      const body = await request(
        "POST",
        "/api/usage-baseline/snapshot",
        ACTION_TIMEOUT_MS,
      );
      return decodeProviderPulseResponse(() =>
        z.strictObject({ usageBaseline: providerPulseBaselineSchema }).parse({
          usageBaseline: projectBaseline(
            z
              .object({
                usageBaseline: z.unknown().optional(),
              })
              .passthrough()
              .parse(body).usageBaseline,
          ),
        }),
      );
    },
  };
}

function disabledError(): ProviderPulseGatewayError {
  return new ProviderPulseGatewayError(
    503,
    "provider_pulse_unavailable",
    "Provider Pulse is not configured.",
    false,
  );
}

function unavailableResponseError(): ProviderPulseGatewayError {
  return new ProviderPulseGatewayError(
    503,
    "provider_pulse_unavailable",
    "Provider Pulse returned an invalid response.",
    true,
  );
}

function decodeProviderPulseResponse<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error: unknown) {
    if (error instanceof ProviderPulseGatewayError) throw error;
    throw unavailableResponseError();
  }
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new Error("provider_pulse_invalid_content_length");
    }
    const bytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > PROVIDER_PULSE_RESPONSE_MAX_BYTES
    ) {
      throw new Error("provider_pulse_response_too_large");
    }
  }
  if (!response.body) {
    throw new Error("provider_pulse_response_body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > PROVIDER_PULSE_RESPONSE_MAX_BYTES) {
        await reader.cancel("provider_pulse_response_too_large");
        throw new Error("provider_pulse_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function projectStatus(value: unknown): ProviderPulseStatus {
  const parsed = pulseStatusSchema.parse(value);
  return providerPulseStatusSchema.parse({
    version: 1,
    generatedAt: parsed.generatedAt,
    health: normalizeHealth(parsed.health),
    accounts: (parsed.accounts ?? []).flatMap((account) => {
      const id = providerPulseAccountIdSchema.safeParse(account.id);
      if (!id.success) return [];
      const usage = account.usage ?? {};
      return [
        {
          id: id.data,
          label: account.label?.trim() || `${account.provider} account`,
          provider: account.provider,
          ...providerBrand(account.provider),
          usage: {
            health: normalizeHealth(usage.health ?? "unknown"),
            inFlight: usage.inFlight === true,
            ...(usage.operationId ? { operationId: usage.operationId } : {}),
            ...(usage.lastAttemptAt
              ? { lastAttemptAt: usage.lastAttemptAt }
              : {}),
            ...(usage.lastSuccessAt
              ? { lastSuccessAt: usage.lastSuccessAt }
              : {}),
            ...(usage.snapshot
              ? {
                  snapshot: {
                    observedAt: usage.snapshot.observedAt,
                    windows: (usage.snapshot.windows ?? []).flatMap((window) =>
                      projectWindow(window),
                    ),
                    balances: (usage.snapshot.balances ?? []).flatMap(
                      (balance) => projectBalance(balance),
                    ),
                    ...(usage.snapshot.resetCredits === undefined
                      ? {}
                      : {
                          resetCredits: projectResetCredits(
                            usage.snapshot.resetCredits,
                          ),
                        }),
                  },
                }
              : {}),
          },
        },
      ];
    }),
    usageBaseline: projectBaseline(parsed.usageBaseline),
  });
}

function projectBaseline(value: unknown) {
  const parsed = z
    .object({
      health: z.enum(["unknown", "healthy", "unhealthy"]).optional(),
      updatedAt: z.string().optional().nullable(),
      metrics: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough()
    .safeParse(value);
  if (!parsed.success) {
    return { health: "unknown" as const, metrics: [] };
  }
  return providerPulseBaselineSchema.parse({
    health: parsed.data.health ?? "unknown",
    ...(parsed.data.updatedAt ? { updatedAt: parsed.data.updatedAt } : {}),
    metrics: (parsed.data.metrics ?? []).flatMap((metric) => {
      const accountId = providerPulseAccountIdSchema.safeParse(
        metric.accountId,
      );
      const remaining = Number(metric.remainingPercent);
      if (
        !accountId.success ||
        (metric.metricKind !== "window" && metric.metricKind !== "balance") ||
        typeof metric.metricId !== "string" ||
        !Number.isFinite(remaining) ||
        typeof metric.capturedAt !== "string"
      ) {
        return [];
      }
      return [
        {
          accountId: accountId.data,
          metricKind: metric.metricKind,
          metricId: metric.metricId,
          remainingPercent: Math.max(0, Math.min(100, remaining)),
          ...(typeof metric.resetAt === "string"
            ? { resetAt: metric.resetAt }
            : {}),
          capturedAt: metric.capturedAt,
        },
      ];
    }),
  });
}

function projectWindow(value: Record<string, unknown>) {
  if (typeof value.id !== "string" || value.id.length === 0) return [];
  const remaining =
    typeof value.remainingPercent === "number"
      ? value.remainingPercent
      : typeof value.usedPercent === "number"
        ? 100 - value.usedPercent
        : undefined;
  return [
    {
      id: value.id,
      label:
        typeof value.label === "string" && value.label.trim()
          ? value.label
          : value.id,
      ...(typeof value.usedPercent === "number"
        ? { usedPercent: value.usedPercent }
        : {}),
      ...(remaining === undefined ? {} : { remainingPercent: remaining }),
      ...(typeof value.durationMinutes === "number"
        ? { durationMinutes: value.durationMinutes }
        : {}),
      ...(typeof value.resetsAt === "string"
        ? { resetsAt: value.resetsAt }
        : {}),
      ...(typeof value.reached === "boolean" ? { reached: value.reached } : {}),
    },
  ];
}

function projectBalance(value: Record<string, unknown>) {
  if (typeof value.id !== "string" || value.id.length === 0) return [];
  return [
    {
      id: value.id,
      label:
        typeof value.label === "string" && value.label.trim()
          ? value.label
          : value.id,
      ...(typeof value.remainingPercent === "number"
        ? { remainingPercent: value.remainingPercent }
        : {}),
      ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
      ...(typeof value.currency === "string"
        ? { currency: value.currency }
        : {}),
      ...(typeof value.unit === "string" ? { unit: value.unit } : {}),
      ...(typeof value.unlimited === "boolean"
        ? { unlimited: value.unlimited }
        : {}),
      ...(typeof value.limit === "string" ? { limit: value.limit } : {}),
      ...(typeof value.used === "string" ? { used: value.used } : {}),
      ...(typeof value.resetsAt === "string"
        ? { resetsAt: value.resetsAt }
        : {}),
    },
  ];
}

function projectResetCredits(
  value: z.infer<typeof pulseResetCreditsSchema>,
) {
  if (value.availableCount === 0) return { availableCount: 0 };
  const nextExpiresAt = (value.credits ?? [])
    .flatMap((credit) => {
      if (credit.status !== "available" || credit.expiresAt === undefined) {
        return [];
      }
      const parsed = z.iso.datetime().safeParse(credit.expiresAt);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return {
    availableCount: value.availableCount,
    ...(nextExpiresAt === undefined ? {} : { nextExpiresAt }),
  };
}

function providerBrand(provider: string): { readonly brand?: BackendBrand } {
  switch (provider) {
    case "pi":
    case "codex":
    case "claude":
    case "grok":
      return { brand: provider };
    default:
      return {};
  }
}

function normalizeHealth(value: string): ProviderPulseStatus["health"] {
  if (
    value === "unknown" ||
    value === "running" ||
    value === "healthy" ||
    value === "stale" ||
    value === "unhealthy" ||
    value === "disabled"
  ) {
    return value;
  }
  return "unknown";
}
