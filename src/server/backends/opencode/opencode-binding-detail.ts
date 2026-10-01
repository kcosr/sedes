import { z } from "zod";
import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";

const identifier = z.string().min(1).max(1_024).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
export const openCodeBindingDetailSchema = z.strictObject({
  version: z.literal(1),
  sessionId: identifier,
  tenantId: identifier,
  principalId: identifier,
  backendInstanceId: identifier,
  connectionProfileId: identifier,
  executionEnvironmentId: identifier,
  canonicalWorkspacePath: z.string().max(4_096).refine(normalizedAbsolutePath),
  nativeNamespaceKey: identifier,
});
export type OpenCodeBindingDetail = z.infer<typeof openCodeBindingDetailSchema>;

export function serializeOpenCodeBindingDetail(value: OpenCodeBindingDetail): string {
  const result = JSON.stringify(openCodeBindingDetailSchema.parse(value));
  if (Buffer.byteLength(result) > 16_384) throw new Error("opencode_binding_detail_too_large");
  return result;
}

export function parseOpenCodeBindingDetail(value: string): Readonly<OpenCodeBindingDetail> {
  if (!value || Buffer.byteLength(value) > 16_384) throw new Error("opencode_binding_detail_invalid");
  return Object.freeze(openCodeBindingDetailSchema.parse(JSON.parse(value)));
}
