import {
  configurationLifecycleImpactSchema, configurationLifecycleResultSchema,
} from "../../../shared/protocol/configuration-admin.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { administrationSchema, executionRuntimeSchema } from "../execution/execution-configuration-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema,
  type CanonicalObjectSchema,
} from "../schema/canonical-json-schema.js";
import {
  runtimeAgentActions, runtimeImpactInputSchema, runtimeLifecycleInputSchema, runtimeOperationInputSchema,
  type RuntimeManagementOperation, type RuntimeManagementResult, type RuntimeManagementService,
} from "./runtime-agent-tool-service.js";

function root(schema: CanonicalObjectSchema) {
  return normalizeCanonicalAgentToolSchema({ $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT, ...schema });
}
const impactInput = root(administrationSchema(runtimeImpactInputSchema) as CanonicalObjectSchema);
const lifecycleInput = root(administrationSchema(runtimeLifecycleInputSchema) as CanonicalObjectSchema);
const operationInput = root(administrationSchema(runtimeOperationInputSchema) as CanonicalObjectSchema);
const impactOutput = root(administrationSchema(configurationLifecycleImpactSchema) as CanonicalObjectSchema);
const lifecycleResult = administrationSchema(configurationLifecycleResultSchema) as CanonicalObjectSchema;
const lifecycleOutput = root({ ...lifecycleResult, properties: { ...lifecycleResult.properties, runtime: executionRuntimeSchema } });
const operations: readonly RuntimeManagementOperation[] = ["runtime.impact", ...runtimeAgentActions.map(action => `runtime.${action}` as const), "runtime.operation.get"];

export function createRuntimeManagementToolDefinitions(service: RuntimeManagementService): AgentToolDefinition<unknown, RuntimeManagementResult>[] {
  return operations.map(operation => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[operation];
    const name = `sedes_${operation.replaceAll(".", "_")}`;
    return {
      ...manifest,
      inputSchema: operation === "runtime.impact" ? impactInput : operation === "runtime.operation.get" ? operationInput : lifecycleInput,
      outputSchema: operation === "runtime.impact" ? impactOutput : lifecycleOutput,
      requiredCapabilities: [],
      execution: {
        form: "inline", adapterWaitCeilingMilliseconds: { pi_sdk: 30_000, pi_rpc: 30_000, mcp: 30_000, http: 30_000, cli: 30_000 },
        supportsCancellation: false, idempotency: operation === "runtime.impact" || operation === "runtime.operation.get" ? "not_applicable" : "required",
        progress: "none", maximumInputBytes: 4_096, maximumOutputBytes: 512 * 1_024,
        concurrencyClass: "execution_runtime_management", uncertainExternalOutcome: true,
      },
      exposure: { adapters: ["pi_sdk", "pi_rpc", "mcp", "http", "cli"] },
      adapters: { pi: { name, label: manifest.catalog.label, promptSnippet: manifest.description },
        mcp: { name }, http: { invocation: "inline" }, cli: { command: operation } },
      execute: (input, context) => service.execute(context, operation, input),
    };
  });
}
