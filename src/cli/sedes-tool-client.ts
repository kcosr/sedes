import { z } from "zod";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
  SedesToolInvocationResult,
} from "../server/agent-tools/contracts/agent-tool-contracts.js";
import type { CreateAgentToolInvocationRequest } from "../server/agent-tools/http/agent-tool-http-contracts.js";

export const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export interface SedesToolClient {
  listTools(signal?: AbortSignal): Promise<{
    readonly tools: readonly AgentToolCatalogSummary[];
  }>;
  describeTools(
    toolIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ readonly tools: readonly AgentToolDescription[] }>;
  invoke(
    request: CreateAgentToolInvocationRequest,
    signal?: AbortSignal,
  ): Promise<SedesToolInvocationResult<unknown>>;
}

export type SedesAgentToolCallerCredential =
  | Readonly<{ readonly kind: "thread_source"; readonly value: string }>
  | Readonly<{ readonly kind: "principal_client"; readonly value: string }>;

export class SedesToolApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SedesToolApiError";
  }
}

export function normalizeSedesAgentToolSourceCapability(
  value: string | undefined,
): string {
  const parsed = z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .safeParse(value);
  if (!parsed.success) {
    throw new SedesToolApiError(
      "invalid_environment",
      "SEDES_AGENT_TOOL_SOURCE_CAPABILITY must be a valid opaque capability.",
      false,
    );
  }
  return parsed.data;
}

export function normalizeSedesAgentToolClientToken(
  value: string | undefined,
): string {
  const parsed = z
    .string()
    .min(88)
    .max(97)
    .regex(
      /^hatc1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[1-9][0-9]{0,9}_[A-Za-z0-9_-]{43}$/u,
    )
    .safeParse(value);
  if (!parsed.success || Number(parsed.data.split("_")[2]) > 0xffff_ffff) {
    throw new SedesToolApiError(
      "invalid_environment",
      "SEDES_AGENT_TOOL_CLIENT_TOKEN must be a valid principal tool client token.",
      false,
    );
  }
  return parsed.data;
}
