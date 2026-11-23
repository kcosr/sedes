export const AGENT_TOOL_MAXIMUM_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export const AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS = 16;
export const AGENT_TOOL_MAXIMUM_DESCRIPTION_REQUEST_BYTES = 4 * 1_024;
/** The 88-tool catalog measures 36,560 UTF-8 bytes, with finite growth headroom. */
export const AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES = 40 * 1_024;

/**
 * Reserved for invocationId, state, output property names, JSON punctuation,
 * and future bounded envelope metadata around a canonical tool output.
 */
export const AGENT_TOOL_INVOCATION_ENVELOPE_HEADROOM_BYTES = 4 * 1_024;

export const AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES =
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES -
  AGENT_TOOL_INVOCATION_ENVELOPE_HEADROOM_BYTES;
