export const MAX_AGENT_TOOL_INHERITED_PATH_BYTES = 16_384;
export const MAX_AGENT_TOOL_EXECUTABLE_DIRECTORY_BYTES = 4_096;
export const MAX_AGENT_TOOL_PATH_BYTES =
  MAX_AGENT_TOOL_EXECUTABLE_DIRECTORY_BYTES + 1 + MAX_AGENT_TOOL_INHERITED_PATH_BYTES;

export function boundedAgentToolPath(value: string, maximumBytes: number): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, "utf8") <= maximumBytes;
}
