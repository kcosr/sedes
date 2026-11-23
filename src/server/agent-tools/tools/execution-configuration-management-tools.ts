import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { nativeAgentToolName } from "../contracts/agent-tool-contracts.js";
import { executionConfigurationSchemas } from "../execution/execution-configuration-contracts.js";
import type { ExecutionConfigurationTools } from "../execution/execution-configuration-tools.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { sharedAdapters } from "./management-tool-schemas.js";

/** Resource commands share Settings validation and durable configuration receipts. */
export function createExecutionConfigurationToolDefinitions(
  service: ExecutionConfigurationTools,
): readonly AgentToolDefinition[] {
  return (Object.keys(executionConfigurationSchemas) as Array<keyof typeof executionConfigurationSchemas>).map(id => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[id];
    const schema = executionConfigurationSchemas[id];
    const mutation = manifest.effects.application !== "read";
    return {
      ...manifest,
      inputSchema: schema.input,
      outputSchema: schema.output,
      requiredCapabilities: [],
      execution: {
        form: "inline",
        adapterWaitCeilingMilliseconds: sharedAdapters,
        supportsCancellation: true,
        idempotency: mutation ? "required" : "not_applicable",
        progress: "none",
        // Keep the invocation envelope within ordinary HTTP's 256 KiB cap.
        maximumInputBytes: 252 * 1_024,
        maximumOutputBytes: 512 * 1_024,
        concurrencyClass: mutation ? "execution_configuration_write" : "execution_configuration_read",
        // A host-queued save can commit after the invocation loses its reply.
        uncertainExternalOutcome: mutation,
      },
      exposure: { adapters: ["pi_sdk", "pi_rpc", "mcp", "http", "cli"] },
      adapters: {
        pi: { name: nativeAgentToolName(id), label: manifest.catalog.label },
        mcp: { name: nativeAgentToolName(id) },
        http: { invocation: "inline" },
        cli: { command: id },
      },
      execute: (input, context) => service.execute(context, id, input),
    } satisfies AgentToolDefinition;
  });
}
