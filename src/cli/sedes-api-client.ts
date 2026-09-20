import { z } from "zod";
import { authenticationTokenSchema } from "../shared/authentication.js";
import {
  automationPrecheckTestResultSchema,
  pageResultSchema,
  threadAutomationDefinitionSchema,
  threadAutomationRunSchema,
  threadAutomationSchedulePreviewSchema,
} from "../shared/protocol/automation-presentation.js";
import {
  apiErrorSchema,
  createThreadResultSchema,
  type CreateThreadRequest,
} from "../shared/protocol/api.js";
import {
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
} from "../shared/protocol/application.js";
import { normalizedThreadSnapshotSchema } from "../shared/protocol/conversation.js";
import type { AutomationCliDefinition } from "./automation-input.js";

const idResponseSchema = z.strictObject({ id: z.uuid() });
const deletedResponseSchema = z.strictObject({ deleted: z.literal(true) });

export class SedesCliApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SedesCliApiError";
  }
}

export function normalizeSedesUrl(
  rawUrl: string,
  allowRemote: boolean,
): string {
  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "The Sedes URL must be an HTTP(S) origin without credentials, a path, query, or fragment.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (!loopback && !allowRemote) {
    throw new Error("Non-loopback Sedes URLs require --allow-remote.");
  }
  return url.origin;
}

export class SedesCliApiClient {
  #csrfToken = "";
  readonly #credential: string | undefined;
  readonly baseUrl: string;

  constructor(baseUrl: string, credential?: string) {
    this.baseUrl = normalizeSedesUrl(baseUrl, true);
    if (credential !== undefined && !authenticationTokenSchema.safeParse(credential).success) {
      throw new Error("SEDES_AUTH_TOKEN must be a paired device credential.");
    }
    this.#credential = credential;
  }

  async session(refresh = false) {
    if (refresh) this.#csrfToken = "";
    const result = await this.#request(
      "/api/application/session",
      {},
      normalizedApplicationSessionSchema,
    );
    this.#csrfToken = result.csrfToken;
    return result;
  }

  snapshot() {
    return this.#request(
      "/api/application/snapshot",
      {},
      normalizedApplicationSnapshotSchema,
    );
  }

  async createThread(input: CreateThreadRequest): Promise<string> {
    const result = await this.#mutation(
      "/api/threads",
      createThreadResultSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return result.threadId;
  }

  getThread(threadId: string) {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}?activityDetail=full`,
      {},
      normalizedThreadSnapshotSchema,
    );
  }

  getAutomation(threadId: string) {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      {},
      threadAutomationDefinitionSchema,
    );
  }

  createAutomation(threadId: string, definition: AutomationCliDefinition) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      threadAutomationDefinitionSchema,
      {
        method: "POST",
        body: JSON.stringify({
          ...definitionFields(definition),
          mutationId: crypto.randomUUID(),
        }),
      },
    );
  }

  updateAutomation(
    threadId: string,
    definition: AutomationCliDefinition,
    expectedRevision: number,
  ) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      threadAutomationDefinitionSchema,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...definitionFields(definition),
          expectedRevision,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
  }

  setAutomationState(
    threadId: string,
    action: "enable" | "pause",
    expectedRevision: number,
  ) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/state`,
      threadAutomationDefinitionSchema,
      {
        method: "PATCH",
        body: JSON.stringify({
          action,
          expectedRevision,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
  }

  previewAutomation(
    threadId: string,
    definition: AutomationCliDefinition,
    count: number,
  ) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/preview`,
      threadAutomationSchedulePreviewSchema,
      {
        method: "POST",
        body: JSON.stringify({ schedule: definition.schedule, count }),
      },
    );
  }

  testPrecheck(threadId: string, definition: AutomationCliDefinition) {
    if (!definition.precheck) {
      throw new Error("The input does not define a pre-check.");
    }
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/precheck/test`,
      automationPrecheckTestResultSchema,
      {
        method: "POST",
        body: JSON.stringify({
          prompt: definition.prompt,
          precheck: definition.precheck,
        }),
      },
    );
  }

  runNow(threadId: string) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/run-now`,
      threadAutomationRunSchema,
      {
        method: "POST",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      },
    );
  }

  listRuns(threadId: string, pageSize = 50) {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/automation/runs?pageSize=${pageSize}`,
      {},
      pageResultSchema(threadAutomationRunSchema),
    );
  }

  deleteAutomation(threadId: string, expectedRevision: number) {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      deletedResponseSchema,
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedRevision,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
  }

  async #mutation<T>(path: string, schema: z.ZodType<T>, init: RequestInit) {
    if (!this.#csrfToken) await this.session();
    try {
      return await this.#request(path, this.#mutationInit(init), schema);
    } catch (error) {
      if (
        error instanceof SedesCliApiError &&
        error.status === 403 &&
        error.code === "csrf_token_invalid"
      ) {
        await this.session(true);
        return this.#request(path, this.#mutationInit(init), schema);
      }
      throw error;
    }
  }

  #mutationInit(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": this.#csrfToken,
        ...init.headers,
      },
    };
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new Error("Refusing to send credentials outside the configured Sedes origin.");
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: { Accept: "application/json", ...init.headers,
        ...(this.#credential ? { Authorization: `Bearer ${this.#credential}` } : {}),
      },
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      if (response.status === 401) {
        throw new SedesCliApiError(401, "authentication_required",
          "Pair a device credential with this server and set SEDES_AUTH_TOKEN. The existing credential may have expired or been revoked.", false);
      }
      const parsed = apiErrorSchema.safeParse(body);
      if (parsed.success) {
        throw new SedesCliApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable,
        );
      }
      throw new SedesCliApiError(
        response.status,
        "invalid_response",
        `Sedes returned HTTP ${response.status}.`,
        false,
      );
    }
    return schema.parse(body);
  }
}

function definitionFields(definition: AutomationCliDefinition) {
  return {
    prompt: definition.prompt,
    runMode: definition.runMode,
    schedule: definition.schedule,
    misfirePolicy: definition.misfirePolicy,
    precheck: definition.precheck,
  };
}
