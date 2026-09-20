import { z } from "zod";

const claudeBindingDetailSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
  })
  .strict();

export type ClaudeBindingDetail = z.infer<typeof claudeBindingDetailSchema>;

export function parseClaudeBindingDetail(value: string): ClaudeBindingDetail {
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error("claude_binding_detail_oversized");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new Error("claude_binding_detail_invalid", { cause: error });
  }
  return claudeBindingDetailSchema.parse(decoded);
}

export function serializeClaudeBindingDetail(
  input: ClaudeBindingDetail,
): string {
  const serialized = JSON.stringify(claudeBindingDetailSchema.parse(input));
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new Error("claude_binding_detail_oversized");
  }
  return serialized;
}
