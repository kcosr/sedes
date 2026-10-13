import { AGENT_TOOL_CLI_PROTOCOL_VERSION } from "./index.js";

/** One authority for the transport version granted, advertised and inspected. */
export const AGENT_TOOL_CLI_CAPABILITY = Object.freeze({
  capabilityId: "agent_tools_cli" as const,
  majorVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
});
