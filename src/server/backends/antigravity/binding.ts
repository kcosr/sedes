import { z } from "zod";

const identifier = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const bindingSchema = z.strictObject({
  version: z.literal(1), sessionId: z.uuid(), tenantId: identifier, principalId: identifier,
  backendInstanceId: identifier, connectionProfileId: identifier, executionEnvironmentId: identifier,
  canonicalWorkspacePath: z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),
  nativeNamespaceKey: identifier,
});
export type AntigravityBinding = z.infer<typeof bindingSchema>;
export function parseAntigravityBinding(encoded: string): AntigravityBinding {
  if (Buffer.byteLength(encoded) > 16_384) throw new Error("antigravity_binding_too_large");
  return Object.freeze(bindingSchema.parse(JSON.parse(encoded)));
}
export function serializeAntigravityBinding(input: AntigravityBinding): string {
  const encoded = JSON.stringify(bindingSchema.parse(input));
  parseAntigravityBinding(encoded);
  return encoded;
}
