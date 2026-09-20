import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import { ZodError, z } from "zod";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import {
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
  SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
  agentToolTransportLimits,
  agentToolCatalogResponseSchema,
  agentToolDescriptionsResponseSchema,
  agentToolInvocationResultSchema,
  createAgentToolInvocationRequestSchema,
  createAgentToolDescriptionsRequestSchema,
} from "./agent-tool-http-contracts.js";
import type {
  AgentToolSourceContextResolver,
  PolicyCheckedAgentToolHttpService,
} from "./agent-tool-http-service.js";
import type { PrincipalAgentToolClientService } from "../application/principal-agent-tool-client-service.js";
import type { HttpRequestOperationGate } from "../../runtime/application-shutdown.js";

const sourceCapabilitySchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

export interface AgentToolRouterDependencies {
  readonly sources: AgentToolSourceContextResolver;
  readonly tools: PolicyCheckedAgentToolHttpService;
  readonly clients: Pick<
    PrincipalAgentToolClientService,
    | "catalogSummaries"
    | "describeMany"
    | "invoke"
    | "options"
    | "list"
    | "get"
    | "createForManagement"
    | "replaceForManagement"
    | "rotateForManagement"
    | "revokeForManagement"
  >;
}

function rawHeaderValues(request: Request, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

type AgentToolHttpAuthority =
  | {
      readonly kind: "thread_agent";
      readonly source: Awaited<ReturnType<AgentToolSourceContextResolver["resolve"]>>;
    }
  | { readonly kind: "principal_client"; readonly credential: string };

async function resolveAuthority(
  dependencies: AgentToolRouterDependencies,
  request: Request,
  signal: AbortSignal,
): Promise<AgentToolHttpAuthority> {
  const sourceValues = rawHeaderValues(
    request,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
  );
  const clientValues = rawHeaderValues(
    request,
    SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
  );
  if (
    sourceValues.length > 1 ||
    clientValues.length > 1 ||
    sourceValues.length + clientValues.length !== 1
  ) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      `Exactly one agent-tool caller credential is required.`,
    );
  }
  if (sourceValues.length === 1) {
    const parsed = sourceCapabilitySchema.safeParse(sourceValues[0]);
    if (!parsed.success) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        `${SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER} is invalid.`,
      );
    }
    return {
      kind: "thread_agent",
      source: await dependencies.sources.resolve(request, parsed.data, signal),
    };
  }
  const credential = clientValues[0]!;
  if (credential.length > 256 || credential.includes(",")) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      `${SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER} is invalid.`,
    );
  }
  return { kind: "principal_client", credential };
}

function assertNoQuery(request: Request): void {
  if (request.originalUrl.includes("?")) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "Query parameters are not accepted by this route.",
    );
  }
}

function assertBodyless(request: Request): void {
  const transferEncoding = rawHeaderValues(request, "transfer-encoding");
  const contentLength = rawHeaderValues(request, "content-length");
  if (
    transferEncoding.length !== 0 ||
    contentLength.length > 1 ||
    (contentLength.length === 1 && contentLength[0] !== "0")
  ) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "This agent-tool request does not accept a body.",
    );
  }
}

function requestAbortScope(request: Request, response: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("agent_tool_http_request_closed"));
    }
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    close() {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    },
  };
}

function statusFor(error: CanonicalAgentToolRequestError): number {
  switch (error.code) {
    case "invalid_input":
      return 400;
    case "unauthenticated":
      return 401;
    case "permission_denied":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "cancelled":
    case "uncertain_outcome":
      return 409;
    case "rate_limited":
      return 429;
    case "unavailable":
    case "timed_out":
      return 503;
    case "internal_error":
      return 500;
  }
}

function sendError(response: Response, error: CanonicalAgentToolRequestError) {
  response.setHeader("Cache-Control", "no-store");
  response.status(statusFor(error)).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

function validatedResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  let parsed: T;
  try {
    parsed = schema.parse(value);
  } catch (cause) {
    throw new CanonicalAgentToolRequestError(
      "internal_error",
      "The agent-tool service returned an invalid response.",
      false,
      { cause },
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") >
    agentToolTransportLimits.maximumResponseBytes
  ) {
    throw new CanonicalAgentToolRequestError(
      "internal_error",
      "The agent-tool response exceeded the transport limit.",
    );
  }
  return parsed;
}

function handler(
  work: (request: Request, response: Response) => Promise<void>,
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      await work(request, response);
    } catch (error) {
      if (error instanceof CanonicalAgentToolRequestError) {
        sendError(response, error);
        return;
      }
      if (error instanceof ZodError) {
        sendError(
          response,
          new CanonicalAgentToolRequestError(
            "invalid_input",
            "The request did not match the expected contract.",
          ),
        );
        return;
      }
      next(error);
    }
  };
}

export function createAgentToolRouter(
  dependencies: AgentToolRouterDependencies,
  requestOperations?: HttpRequestOperationGate,
) {
  const router = express.Router();
  const own = (routeHandler: RequestHandler): RequestHandler =>
    requestOperations
      ? (request, response, next) =>
          requestOperations.run(() => routeHandler(request, response, next))
      : routeHandler;

  router.get(
    "/api/agent-tools",
    own(
      handler(async (request, response) => {
        assertNoQuery(request);
        assertBodyless(request);
        const abort = requestAbortScope(request, response);
        try {
          const authority = await resolveAuthority(
            dependencies,
            request,
            abort.signal,
          );
          response.setHeader("Cache-Control", "no-store");
          response.json(
            validatedResponse(agentToolCatalogResponseSchema, {
              tools:
                authority.kind === "thread_agent"
                  ? await dependencies.tools.catalog(authority.source)
                  : dependencies.clients.catalogSummaries(authority.credential),
            }),
          );
        } finally {
          abort.close();
        }
      }),
    ),
  );

  router.post(
    "/api/agent-tool-descriptions",
    own(
      handler(async (request, response) => {
        assertNoQuery(request);
        const body = createAgentToolDescriptionsRequestSchema.parse(
          request.body,
        );
        const abort = requestAbortScope(request, response);
        try {
          const authority = await resolveAuthority(
            dependencies,
            request,
            abort.signal,
          );
          response.setHeader("Cache-Control", "no-store");
          response.json(
            validatedResponse(agentToolDescriptionsResponseSchema, {
              tools:
                authority.kind === "thread_agent"
                  ? await dependencies.tools.describeMany(
                      authority.source,
                      body.toolIds,
                    )
                  : dependencies.clients.describeMany(
                      authority.credential,
                      body.toolIds,
                    ),
            }),
          );
        } finally {
          abort.close();
        }
      }),
    ),
  );

  router.post(
    "/api/agent-tool-invocations",
    own(
      handler(async (request, response) => {
        assertNoQuery(request);
        const body = createAgentToolInvocationRequestSchema.parse(request.body);
        const abort = requestAbortScope(request, response);
        try {
          const authority = await resolveAuthority(
            dependencies,
            request,
            abort.signal,
          );
          response.setHeader("Cache-Control", "no-store");
          response.json(
            validatedResponse(
              agentToolInvocationResultSchema,
              authority.kind === "thread_agent"
                ? await dependencies.tools.invoke(
                    authority.source,
                    body,
                    abort.signal,
                  )
                : await dependencies.clients.invoke(
                    authority.credential,
                    body,
                    abort.signal,
                  ),
            ),
          );
        } finally {
          abort.close();
        }
      }),
    ),
  );

  return router;
}
