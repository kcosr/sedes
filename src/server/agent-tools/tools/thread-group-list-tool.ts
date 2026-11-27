import { Type } from "typebox";
import type {
  ThreadGroupDirectoryPage,
  ThreadGroupRepository,
} from "../../db/repositories/thread-group-repository.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { environmentAuthorityContinuationDigest } from "../environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import {
  cursorSchema,
  pageSizeSchema,
  sharedAdapters,
  threadGroupSummaryToolSchema,
} from "./management-tool-schemas.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["thread_group.list"];

export type ThreadGroupDirectoryReader = Pick<ThreadGroupRepository, "listDirectoryPage">;

interface ThreadGroupListInput {
  readonly query?: string;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export function createThreadGroupListToolDefinition(
  repository: ThreadGroupDirectoryReader,
): AgentToolDefinition<ThreadGroupListInput, ThreadGroupDirectoryPage> {
  return {
    ...manifest,
    inputSchema: normalizeCanonicalAgentToolSchema(Type.Object({
      query: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Case-insensitive Group name substring, normalized like a Group name.",
      })),
      pageSize: Type.Optional(pageSizeSchema),
      cursor: Type.Optional(cursorSchema),
    }, { $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT, additionalProperties: false, maxProperties: 3 })),
    outputSchema: normalizeCanonicalAgentToolSchema(Type.Object({
      items: Type.Array(threadGroupSummaryToolSchema, { maxItems: 100 }),
      nextCursor: Type.Optional(cursorSchema),
    }, { $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT, additionalProperties: false, maxProperties: 2 })),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 128 * 1_024,
      concurrencyClass: "thread_group_list_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "pi_rpc", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_group_list",
        label: "List Sedes thread Groups",
        promptSnippet: "Find a thread Group by name, including empty Groups.",
      },
      mcp: { name: "sedes_thread_group_list" },
      http: { invocation: "inline" },
      cli: { command: manifest.id },
    },
    async execute(input, context) {
      return repository.listDirectoryPage(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          ...input,
          pageSize: input.pageSize ?? 50,
          authorityDigest: environmentAuthorityContinuationDigest(context.environmentAuthority, manifest),
        },
      );
    },
  };
}
