import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { WebSearchProviderError } from "../../web-search/web-search-provider.js";
import type { WebSearchService } from "../../web-search/web-search-service.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["research.web_search"];
const MAXIMUM_ANSWER_CHARACTERS = 65_536;

export interface WebSearchToolInput {
  readonly query: string;
  readonly continue?: boolean;
}

export interface WebSearchToolOutput {
  readonly text: string;
  readonly continued: boolean;
  readonly continuationFallback: boolean;
}

export interface WebSearchExecutor {
  search: WebSearchService["search"];
}

export function createWebSearchToolDefinition(
  service: WebSearchExecutor,
): AgentToolDefinition<WebSearchToolInput, WebSearchToolOutput> {
  return {
    ...manifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          query: Type.String({
            minLength: 1,
            maxLength: 8_000,
            description:
              "A complete natural-language research question or request, not a bare keyword list.",
          }),
          continue: Type.Optional(
            Type.Boolean({
              description:
                "True only for a direct follow-up that relies on the most recent successful search by this same Sedes caller. Omit for a new or unrelated question. If that exact session is unavailable, Sedes safely starts a fresh search.",
            }),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          text: Type.String({ minLength: 1, maxLength: 65_536 }),
          continued: Type.Boolean({
            description:
              "Whether this answer actually resumed the prior provider search session.",
          }),
          continuationFallback: Type.Boolean({
            description:
              "Whether continuation was requested but Sedes had to start a fresh search because no exact usable mapping remained.",
          }),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 3,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: {
        pi_sdk: 105_000,
        mcp: 105_000,
        http: 105_000,
        cli: 105_000,
      },
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 16 * 1024,
      maximumOutputBytes: 256 * 1024,
      concurrencyClass: "web_search_model_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_research_web_search",
        label: "Search the web",
        promptSnippet:
          "Search the public web, fetch relevant pages, and search public X when useful.",
        promptGuidelines: [
          "Use continue only for a direct follow-up to the most recent successful search in this Sedes thread.",
          "Start a new search for a different or unrelated question.",
        ],
      },
      mcp: { name: "sedes_research_web_search" },
      http: { invocation: "inline" },
      cli: { command: manifest.id },
    },
    async execute(input, context) {
      const query = input.query.trim();
      if (!query) {
        throw new CanonicalAgentToolRequestError(
          "invalid_input",
          "The web search query must not be blank.",
        );
      }
      try {
        const result = await service.search({
          subject: {
            tenantId: context.tenantId,
            principalId: context.principalId,
            kind:
              context.subject.kind === "thread_agent"
                ? "thread"
                : "principal_client",
            id:
              context.subject.kind === "thread_agent"
                ? context.subject.sourceThreadId
                : context.subject.clientId,
          },
          query,
          continue: input.continue === true,
          signal: context.abortSignal,
        });
        if (result.text.length > MAXIMUM_ANSWER_CHARACTERS) {
          throw new CanonicalAgentToolRequestError(
            "internal_error",
            "The web search answer exceeds the Sedes character limit.",
          );
        }
        return result;
      } catch (error) {
        if (error instanceof CanonicalAgentToolRequestError) throw error;
        if (error instanceof WebSearchProviderError) {
          switch (error.code) {
            case "cancelled":
              throw new CanonicalAgentToolRequestError(
                "cancelled",
                error.message,
              );
            case "timed_out":
              throw new CanonicalAgentToolRequestError(
                "timed_out",
                error.message,
                error.retryable,
              );
            case "unavailable":
              throw new CanonicalAgentToolRequestError(
                "unavailable",
                error.message,
                error.retryable,
              );
            case "session_unavailable":
            case "failed":
              throw new CanonicalAgentToolRequestError(
                "internal_error",
                error.message,
                error.retryable,
              );
          }
        }
        throw new CanonicalAgentToolRequestError(
          "internal_error",
          "Web search failed unexpectedly.",
          true,
          { cause: error },
        );
      }
    },
  };
}
