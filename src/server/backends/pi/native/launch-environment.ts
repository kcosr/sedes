import { z } from "zod";

const value = z.string().max(16_384).refine(text => !text.includes("\0")).nullable().optional();
/** Only authenticated main-side tool authority may supply these variables. */
export const piNativeAgentToolEnvironmentSchema = z.strictObject({
  SEDES_AGENT_TOOL_ENDPOINT: value,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY: value,
  SEDES_AGENT_TOOL_CLIENT_TOKEN: value,
  SEDES_AGENT_TOOL_CLI_MODE: z.enum(["individual", "progressive"]).nullable().optional(),
  PATH: z.string().max(131_072).refine(text => !text.includes("\0")).nullable().optional(),
});
