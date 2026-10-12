import { z } from "zod";
/** Model-visible content on completed tool replies; separate from JSON output. */
export type AgentToolModelContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: "image/png" };

export const AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_BASE64_CHARACTERS = 4 * Math.ceil(AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES / 3);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const pngDataSchema = z.string().min(12).max(MAXIMUM_BASE64_CHARACTERS).refine((value) => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    bytes.toString("base64") === value;
}, "A bounded base64-encoded PNG is required.");

export const agentToolModelContentSchema: z.ZodType<AgentToolModelContent> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(65_536) }),
  z.strictObject({ type: z.literal("image"), data: pngDataSchema, mimeType: z.literal("image/png") }),
]);

export const agentToolModelContentsSchema = z.array(agentToolModelContentSchema).min(1).max(8).readonly();
